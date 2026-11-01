import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import type { Db } from "../db";
import { apiRequests, attachments, obligations, paymentAttempts, settlements, vendors } from "../db/schema";
import { newId, now } from "../domain/ids";
import { TRANSITIONS, type ObligationState, type SourceType } from "../domain/types";
import { transition } from "../domain/stateMachine";
import { normaliseName } from "../domain/vendorNames";
import { ZERO_DECIMAL_CURRENCIES } from "../domain/money";
import { ingestObligation, previewPolicy } from "../engine/orchestrator";
import { uploadDocument, ALLOWED_UPLOAD_TYPES } from "../engine/attachments";
import { formatMoney } from "../format";
import { AgentInputError, clean, validatePaymentArgs } from "../agent/guard";
import { hasScope, type ApiKey } from "./keys";
import { otherNames, reasonForIntegration } from "./redact";
import { ApiError, Problems, isObject, onlyFields } from "./http";

/**
 * Payment requests from a system of record (an ERP, an accounting tool, a dispatch system). A request goes through the
 * same ingest a clerk's request does (ingestObligation), with the payee, amount, currency and reference fixed as sent,
 * and is recorded as coming from the integration (audit actor api:<key name>). Policy and the business's autonomy
 * setting decide what happens next. Nothing here approves, releases or sends a payment, and nothing reads or changes a
 * supplier's payout details.
 *
 * What the key attaches is its own say-so (provenance "operator", as a clerk's typed record) unless the owner gave the
 * key requests:attest, when it counts as the business's own records (provenance "system"), as an agent key with attest
 * does. A document attached as a file is read the way a clerk's upload is.
 */

const SOURCE_TYPES = ["invoice", "job_completion", "booking"] as const;
const EVIDENCE_KINDS = ["contract", "booking", "job_sheet", "invoice", "message", "photo", "receipt", "purchase_order"] as const;
export const MAX_DOCUMENTS = 3;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
/** The largest request body: three documents at the cap, base64 encoded, plus the fields. */
export const REQUEST_BODY_LIMIT = Math.ceil((MAX_DOCUMENTS * MAX_DOCUMENT_BYTES * 4) / 3) + 256 * 1024;

const FIELDS = ["payee", "vendor_id", "amount", "currency", "reference", "description", "source_type", "evidence", "documents"] as const;

interface Doc { name: string; mimeType: string; bytes: Buffer; kind: string | null }

/** Who the request names: a vendor id, else the exact name or contact email, else the one supplier with the same name once accents are set aside. */
function payeeOf(db: Db, businessId: string, payee: string, vendorId: string | null) {
  const all = db.select({ id: vendors.id, name: vendors.name, email: vendors.email }).from(vendors).where(eq(vendors.businessId, businessId)).all();
  if (vendorId) return all.find((v) => v.id === vendorId) ?? null;
  const want = payee.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  const exact = all.find((v) => v.name.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim() === want || (v.email ?? "").toLowerCase() === want);
  if (exact) return exact;
  const folded = normaliseName(payee);
  const same = folded ? all.filter((v) => normaliseName(v.name) === folded) : [];
  return same.length === 1 ? same[0] : null;
}

export function validateRequest(db: Db, businessId: string, body: unknown) {
  if (!isObject(body)) throw new ApiError(422, "validation_failed", "The body must be a JSON object");
  const p = new Problems();
  onlyFields(p, body, FIELDS);
  let vendorId: string | null = null;
  const fields: Record<string, unknown> = { ...body };
  if (body.vendor_id !== undefined) {
    if (typeof body.vendor_id !== "string" || !body.vendor_id) p.add("vendor_id", "must be a supplier id from GET /api/v1/vendors");
    else {
      const v = db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.id, body.vendor_id), eq(vendors.businessId, businessId))).get();
      if (!v) p.add("vendor_id", "is not a supplier on file");
      else if (body.payee !== undefined && body.payee !== v.name) p.add("payee", "names a different supplier than vendor_id; send one of them");
      else {
        vendorId = v.id;
        fields.payee = v.name;
      }
    }
  }
  const sourceType = (body.source_type ?? "invoice") as string;
  if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) p.add("source_type", `must be one of ${SOURCE_TYPES.join(", ")}`);
  if (body.evidence !== undefined && Array.isArray(body.evidence)) body.evidence.forEach((e, i) => isObject(e) && onlyFields(p, e, ["kind", "label", "amount", "reference", "excerpt"], `evidence[${i}].`));

  const docs: Doc[] = [];
  const docsRaw = body.documents ?? [];
  if (!Array.isArray(docsRaw) || docsRaw.length > MAX_DOCUMENTS) p.add("documents", `must be a list of at most ${MAX_DOCUMENTS} documents`);
  else
    docsRaw.forEach((d, i) => {
      const at = `documents[${i}]`;
      if (!isObject(d)) return void p.add(at, "must be an object");
      onlyFields(p, d, ["name", "content_type", "data", "kind"], `${at}.`);
      const name = typeof d.name === "string" ? d.name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim() : "";
      if (!name || name.length > 120) p.add(`${at}.name`, "is required, at most 120 characters");
      const mimeType = typeof d.content_type === "string" ? d.content_type.toLowerCase().split(";")[0].trim() : "";
      if (!ALLOWED_UPLOAD_TYPES.has(mimeType)) p.add(`${at}.content_type`, `must be one of ${[...ALLOWED_UPLOAD_TYPES].join(", ")}`);
      const data = typeof d.data === "string" ? d.data.replace(/\s+/g, "") : "";
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return void p.add(`${at}.data`, "must be the file's bytes, base64 encoded");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > MAX_DOCUMENT_BYTES) return void p.add(`${at}.data`, `is over ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB`);
      const kind = d.kind === undefined ? null : String(d.kind);
      if (kind !== null && !(EVIDENCE_KINDS as readonly string[]).includes(kind)) p.add(`${at}.kind`, `must be one of ${EVIDENCE_KINDS.join(", ")}`);
      docs.push({ name, mimeType, bytes, kind });
    });

  let a: ReturnType<typeof validatePaymentArgs> | null = null;
  try {
    a = validatePaymentArgs(fields);
  } catch (e) {
    if (!(e instanceof AgentInputError)) throw e;
    const field = e.message.match(/^([a-z_]+(?:\[\d+\](?:\.[a-z_]+)?)?)\b/)?.[1] ?? "body";
    p.add(field, e.message.startsWith(field) ? e.message.slice(field.length).trim() : e.message);
  }
  p.throwIfAny();
  return { ...a!, vendorId, sourceType: sourceType as SourceType, documents: docs };
}

/**
 * One request at a time per business, in this process: two requests for the same job racing through ingest would each
 * miss the other. Policy runs again at release whatever happened here.
 */
const lanes = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = lanes.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  lanes.set(key, tail);
  try {
    return await run;
  } finally {
    if (lanes.get(key) === tail) lanes.delete(key);
  }
}

/** Take back a request that should not stay in the books: cancel its release and the request itself. */
function withdraw(db: Db, id: string, actor: string, reason: string): void {
  db.update(obligations).set({ releaseAt: null, autopilotCancelledAt: now() }).where(eq(obligations.id, id)).run();
  const state = db.select({ s: obligations.state }).from(obligations).where(eq(obligations.id, id)).get()?.s as ObligationState | undefined;
  if (state && TRANSITIONS[state].includes("cancelled")) transition(db, id, "cancelled", actor, "api.request_withdrawn", { reason });
}

/** A key's binding before its request exists. Never shown: listing and lookups use only real request ids. */
const PENDING = "pending:";

const amountText = (minor: number, currency: string) => (ZERO_DECIMAL_CURRENCIES.has(currency) ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2));

export async function createRequest(db: Db, businessId: string, key: ApiKey, idemKey: string, body: unknown) {
  const a = validateRequest(db, businessId, body);
  const actor = `api:${key.name}`;
  const attest = hasScope(key, "requests:attest");
  return oneAtATime(businessId, async () => {
    const payee = payeeOf(db, businessId, a.payee, a.vendorId);
    // A key already bound to a request gets that request back, whatever happened to the stored answer: a retry after
    // an error that came after the request was created must never create a second one (review R1-6b).
    let bound = db.select().from(apiRequests).where(and(eq(apiRequests.keyName, key.name), eq(apiRequests.idemKey, idemKey))).get();
    if (bound?.obligationId.startsWith(PENDING)) {
      // The key was bound and then the process stopped before the request id was written back (review R2-S2). The
      // request, if ingest got that far, carries the binding's id in its header.
      const made = db.select({ id: obligations.id }).from(obligations).where(like(obligations.rawInput, `[Integration request ${bound.id}]%`)).get();
      if (made) {
        db.update(apiRequests).set({ obligationId: made.id }).where(eq(apiRequests.id, bound.id)).run();
        bound = { ...bound, obligationId: made.id };
      } else {
        db.delete(apiRequests).where(eq(apiRequests.id, bound.id)).run();
        bound = undefined;
      }
    }
    if (bound) {
      const was = db.select().from(obligations).where(eq(obligations.id, bound.obligationId)).get();
      if (!was || (was.vendorId ?? null) !== (payee?.id ?? null) || was.amountMinor !== a.amountMinor || was.currency !== a.currency || (was.sourceRef ?? null) !== (a.reference ?? null)) {
        throw new ApiError(422, "idempotency_conflict", "This Idempotency-Key was already used with a different request. Use a new key for a new call.");
      }
      return describeRequest(db, bound.obligationId);
    }
    // Documents are stored and read like a clerk's upload; what they propose becomes the evidence row. If the request
    // is refused after that, the stored copies go too, so a refused call leaves nothing behind (review R1-7).
    const evidence: Array<{ kind: string; label: string; amountMinor: number | null; currency: string | null; reference: string | null; excerpt: string | null; attachmentId?: string | null }> = [...a.evidence];
    const stored: string[] = [];
    const discardUploads = () => {
      if (stored.length) db.delete(attachments).where(and(inArray(attachments.id, stored), isNull(attachments.obligationId))).run();
    };
    for (const d of a.documents) {
      let up: Awaited<ReturnType<typeof uploadDocument>>;
      try {
        up = await uploadDocument(db, { businessId, name: d.name, mimeType: d.mimeType, bytes: d.bytes, actor });
      } catch (e) {
        discardUploads();
        throw new ApiError(422, "document_refused", `${d.name}: ${e instanceof Error ? e.message : "could not be read"}`);
      }
      stored.push(up.attachmentId);
      const first = up.proposed[0];
      evidence.push(first ? { ...first, kind: d.kind ?? first.kind, attachmentId: up.attachmentId } : { kind: d.kind ?? "invoice", label: d.name, amountMinor: null, currency: null, reference: null, excerpt: null, attachmentId: up.attachmentId });
    }
    const claim = newId("apr");
    const head = `[Integration request ${claim}] Pay ${formatMoney(a.amountMinor, a.currency, { code: true })} to ${payee?.name ?? a.payee}${a.reference ? ` for ${a.reference}` : ""}.`;
    const rawInput = a.description ? `${head} The request as the system sent it: "${a.description.replace(/\s+/g, " ").replace(/"/g, "'")}"` : head;
    // The key is bound before ingest writes anything, so no crash can leave a request its key does not lead back to.
    // The binding points at the request once it exists; until then it is pending, and the request's header names it.
    db.insert(apiRequests).values({ id: claim, businessId, keyName: key.name, obligationId: `${PENDING}${claim}`, reference: a.reference, idemKey, createdAt: now() }).run();
    let id: string;
    try {
      id = await ingestObligation(db, {
        businessId,
        sourceType: a.sourceType,
        sourceRef: a.reference,
        rawInput,
        evidence,
        evidenceSource: attest ? "system" : "operator",
        actor,
        stated: { vendorId: payee?.id ?? null, amountMinor: a.amountMinor, currency: a.currency, sourceRef: a.reference, flags: [], trusted: attest },
      });
    } catch (e) {
      // Nothing half-made stays behind.
      const orphan = db.select({ id: obligations.id }).from(obligations).where(like(obligations.rawInput, `[Integration request ${claim}]%`)).get();
      if (orphan) withdraw(db, orphan.id, actor, "creating the request failed");
      discardUploads();
      db.delete(apiRequests).where(eq(apiRequests.id, claim)).run();
      throw new ApiError(422, "request_refused", `Checkrail could not create the request: ${clean(e instanceof Error ? e.message : "an error")}. Nothing was paid.`);
    }
    db.update(apiRequests).set({ obligationId: id }).where(eq(apiRequests.id, claim)).run();
    // The request in the books must be exactly what was sent.
    const ob = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    if ((ob.vendorId ?? null) !== (payee?.id ?? null) || ob.amountMinor !== a.amountMinor || ob.currency !== a.currency || (ob.sourceRef ?? null) !== (a.reference ?? null)) {
      withdraw(db, id, actor, "the request in the books is not the payee, amount and reference sent");
      throw new ApiError(500, "internal_error", "The request in the books did not match what was sent, so it was cancelled. Nothing was paid.");
    }
    return describeRequest(db, id);
  });
}

export type RequestStatus = "blocked" | "waiting_for_evidence" | "waiting_for_approval" | "scheduled" | "approved" | "sending" | "paid" | "returned" | "cancelled" | "failed" | "disputed";

/**
 * A request as an integration may read it: state, verdict, reasons, amounts, rail and settlement. Never payout
 * details: no PayPal email, bank account or wallet address, and reasons are passed through the same redaction the
 * agent guard uses (emails, account numbers and payout addresses removed).
 */
export function describeRequest(db: Db, id: string) {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get();
  if (!ob) throw new ApiError(404, "not_found", "No such request");
  const vendor = ob.vendorId ? db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.id, ob.vendorId)).get() ?? null : null;
  const keep = vendor?.name ?? null;
  const settled = db.select().from(settlements).where(eq(settlements.obligationId, id)).orderBy(desc(settlements.settledAt)).get();
  const attempt = db.select({ externalId: paymentAttempts.externalId, rail: paymentAttempts.rail, status: paymentAttempts.status }).from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).orderBy(desc(paymentAttempts.createdAt)).get();
  const waiting = ["blocked", "needs_evidence", "awaiting_approval", "approved"].includes(ob.state);
  const policy = waiting ? previewPolicy(db, id) : null;
  const failing = (policy?.rules ?? []).filter((r) => !r.passed && r.severity !== "info").sort((x, y) => Number(y.severity === "block") - Number(x.severity === "block"));
  const stored = JSON.parse(ob.policyReasonsJson ?? "[]") as string[];
  // The agent guard's rewrite: no other supplier's name, no word on how far their payment got (review R1-3).
  const others = otherNames(db, ob.businessId, [keep]);
  const ruleMessages = new Set(failing.map((r) => r.message));
  const reasons = [
    ...new Set(
      policy
        ? [...failing.map((r) => reasonForIntegration(r.ruleId, r.message, others, keep)), ...policy.reasons.filter((r) => !ruleMessages.has(r)).map((r) => reasonForIntegration(null, r, others, keep))]
        : stored.map((r) => reasonForIntegration(null, r, others, keep)),
    ),
  ].slice(0, 8);
  const scheduled = ob.state === "approved" && Boolean(ob.releaseAt) && !ob.autopilotCancelledAt;
  const status: RequestStatus =
    ob.state === "blocked" ? "blocked"
    : ob.state === "drafted" || ob.state === "needs_evidence" ? "waiting_for_evidence"
    : ob.state === "awaiting_approval" || ob.state === "verified" ? "waiting_for_approval"
    : scheduled ? "scheduled"
    : ob.state === "approved" ? "approved"
    : ob.state === "execution_pending" || ob.state === "sent" ? "sending"
    : ob.state === "settled" ? "paid"
    : ob.state === "refunded" ? "returned"
    : ob.state === "cancelled" ? "cancelled"
    : ob.state === "disputed" ? "disputed"
    : "failed";
  const decision = policy?.decision ?? ob.policyDecision ?? null;
  const verdict = decision === "auto_execute" ? "pay" : decision === "block" ? "block" : decision ? "hold" : null;
  const settlement =
    settled ? { status: ob.state === "refunded" ? "returned" : "settled", rail: settled.rail, provider_id: settled.externalId ?? attempt?.externalId ?? null, settled_at: settled.settledAt, sent: { value: amountText(settled.grossMinor, settled.grossCurrency), currency: settled.grossCurrency }, fee: { value: amountText(settled.feeMinor, settled.grossCurrency), currency: settled.grossCurrency }, received: settled.receivedMinor != null && settled.receivedCurrency ? { value: amountText(settled.receivedMinor, settled.receivedCurrency), currency: settled.receivedCurrency } : null }
    : attempt ? { status: status === "sending" ? "sending" : status === "returned" ? "returned" : attempt.status === "failed" ? "failed" : "sending", rail: attempt.rail, provider_id: attempt.externalId ?? null, settled_at: null, sent: null, fee: null, received: null }
    : { status: "not_sent", rail: null, provider_id: null, settled_at: null, sent: null, fee: null, received: null };
  return {
    id: ob.id,
    status,
    state: ob.state,
    verdict,
    reasons,
    rules_failed: failing.map((r) => r.ruleId),
    payee: vendor ? { id: vendor.id, name: vendor.name } : null,
    amount: ob.amountMinor != null && ob.currency ? { value: amountText(ob.amountMinor, ob.currency), currency: ob.currency, display: formatMoney(ob.amountMinor, ob.currency, { code: true }) } : null,
    withheld: ob.withheldMinor && ob.currency ? { value: amountText(ob.withheldMinor, ob.currency), currency: ob.currency } : null,
    reference: ob.sourceRef,
    rail: ob.selectedRail ?? null,
    releases_at: scheduled ? ob.releaseAt : null,
    settlement,
    created_at: ob.createdAt,
    updated_at: ob.updatedAt,
  };
}

/** A request this key made, or 404: a key never learns about requests it did not make. */
export function ownRequest(db: Db, key: ApiKey, id: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ApiError(404, "not_found", "No request with that id was made by this API key");
  const mine = db.select({ id: apiRequests.id }).from(apiRequests).where(and(eq(apiRequests.keyName, key.name), eq(apiRequests.obligationId, id))).get();
  if (!mine) throw new ApiError(404, "not_found", "No request with that id was made by this API key");
  return describeRequest(db, id);
}

export function listOwnRequests(db: Db, key: ApiKey, reference: string | null, limit: number) {
  if (reference !== null && (reference.length < 1 || reference.length > 64)) throw new ApiError(422, "validation_failed", "reference must be 1 to 64 characters", [{ field: "reference", message: "must be 1 to 64 characters" }]);
  const rows = db.select({ obligationId: apiRequests.obligationId, reference: apiRequests.reference }).from(apiRequests).where(eq(apiRequests.keyName, key.name)).orderBy(desc(apiRequests.createdAt)).all();
  const want = reference?.trim().toUpperCase() ?? null;
  return rows.filter((r) => !r.obligationId.startsWith(PENDING) && (want === null || (r.reference ?? "").toUpperCase() === want)).slice(0, limit).map((r) => describeRequest(db, r.obligationId));
}
