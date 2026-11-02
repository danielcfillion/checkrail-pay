import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db";
import { accountingSyncs, approvals, attachments, auditEntries, businesses, evidence as evidenceTable, obligations, paymentAttempts, routeQuotes, settlements, users, vendors, bills } from "../db/schema";
import { actorCan, approversFor, preparersOf, resolveActor, whoIs } from "./users";
import { toBaseMinor, toBaseOrZero } from "../fx";
import { decryptField, keyedDigest } from "../crypto/dataKey";
import { billBalance, billsMatching, closeIfDone, createBill, findBill } from "./bills";
import { expectedAmount, rateCardsForPolicy } from "./rates";
import { assertOpenPeriod } from "./books";
import { taxFormWarning, withholdingFor } from "./taxes";
import { currentLogin, humanOf } from "./requestContext";
import { isRole } from "../auth/roles";
import { fmt } from "../domain/policy";
import { DEFAULT_POLICY, effectiveAutonomy, fingerprintCovered, warningFingerprint, type AiInterpretation, type ApprovalPolicy, type EvidenceItem, type ExecutionResult, type ObligationState, type PolicyOutcome, type PolicyRuleResult, type Rail, type SettlementStatus, type SourceType, type VendorPayoutProfile, RAILS } from "../domain/types";
import { evaluatePolicy } from "../domain/policy";
import { chooseRoute } from "../domain/routing";
import { audit, transition } from "../domain/stateMachine";
import { bookingKeys, departureForms, hashPayoutDetails, idempotencyKey, isDateLike, isDepartureRef, jobKeys, newId, now, sourceRefKeys } from "../domain/ids";
import { SUPPORTED_CURRENCIES, isValidAmountMinor, isValidSourceRef, safeRefForMemo } from "../domain/money";
import { runObligationAgent } from "../ai/agent";
import { listPayPalTransactionsRaw } from "../ai/paypalTools";
import { matchPayPalHistory, type PayPalHistoryCheck } from "../domain/paypalHistory";
import { addDays, extractInvoiceDates, paymentPartOf } from "../ai/extractor";
import { localDateString, stateLabel } from "../format";
import { getRails } from "../rails";
import { buildAccountingRecord } from "../accounting/record";

/**
 * The orchestrator wires the pieces in a fixed order:
 *
 *   ingest -> interpret (AI) -> policy (deterministic) -> quote both rails -> route
 *        -> [human approval if required] -> execute -> confirm settlement -> accounting
 *
 * Every step appends to the audit log. No step can be skipped by a caller:
 * execute() re-runs policy before touching a rail.
 */

export interface IngestInput {
  businessId: string;
  sourceType: SourceType;
  sourceRef?: string | null;
  rawInput: string;
  evidence?: Array<Omit<EvidenceItem, "id"> & { attachmentId?: string | null }>;
  /** Who supplied the evidence. Defaults to "system" (an integration). Operator-supplied evidence is flagged by policy.
   *  A row that points at an uploaded attachment and matches what the reader extracted gets provenance "document" instead. */
  evidenceSource?: "system" | "operator";
  actor?: string;
  /** Internal: the bill this payment settles all or part of (see engine/bills.ts). Never taken from a form. */
  billId?: string | null;
  paymentKind?: "full" | "deposit" | "balance" | "part" | "advance" | null;
  /** Internal: the provenance each evidence row already had, when a payment is requested again. Never from a form. */
  evidenceProvenance?: string[];
  /**
   * Internal: the payee, amount, currency and reference a structured caller (an outside agent) sent as fields. They
   * are the request: the reader describes and flags it, but never replaces them, so a verdict covers exactly what was
   * sent (agent guard review AG2-1). `flags` are the caller's own concerns, each a hold. Never from a form.
   */
  stated?: StatedFields;
  /** Internal: who asked for the payment this one asks for again (repayRefunded). Never from a form. */
  originActor?: string;
}

export interface StatedFields {
  vendorId: string | null;
  amountMinor: number;
  currency: string;
  sourceRef: string | null;
  flags?: string[];
  /** The caller is a system of record (an agent key with attest). An untrusted caller's open request does not stop
   *  other requests for the job until a person approves it (agent guard review AG3-3). */
  trusted?: boolean;
}

const SOURCE_TYPES: readonly SourceType[] = ["invoice", "job_completion", "operator_instruction", "booking"];
const EVIDENCE_KINDS = ["contract", "booking", "job_sheet", "invoice", "message", "photo", "receipt", "purchase_order"];

/**
 * Validate an ingest request at the boundary. Server actions receive whatever the client sends, so every field is
 * checked: known source type, at most 20 evidence rows, bounded text, whole non-negative amounts, ISO currency codes.
 */
export function validateIngest(input: IngestInput): IngestInput {
  if (!SOURCE_TYPES.includes(input.sourceType)) throw new Error("Unknown source type");
  if (typeof input.rawInput !== "string" || input.rawInput.trim().length === 0) throw new Error("The request text is empty");
  if (input.rawInput.length > 20_000) throw new Error("The request text is longer than 20,000 characters; attach the document instead");
  const ev = input.evidence ?? [];
  if (!Array.isArray(ev) || ev.length > 20) throw new Error("At most 20 evidence records per request");
  const str = (v: unknown, name: string, max: number, required = false): string | null => {
    if (v == null || v === "") {
      if (required) throw new Error(`Evidence ${name} is required`);
      return null;
    }
    if (typeof v !== "string") throw new Error(`Evidence ${name} must be text`);
    if (v.length > max) throw new Error(`Evidence ${name} is longer than ${max} characters`);
    return v;
  };
  const evidence = ev.map((e) => {
    if (!e || typeof e !== "object") throw new Error("Invalid evidence record");
    const amountMinor = e.amountMinor == null ? null : e.amountMinor;
    if (amountMinor !== null && !(Number.isSafeInteger(amountMinor) && amountMinor >= 0)) throw new Error("Evidence amounts must be whole minor units, zero or more");
    const currency = e.currency == null || e.currency === "" ? null : String(e.currency).toUpperCase();
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error("Evidence currency must be a three-letter code");
    const kind = String(e.kind ?? "");
    if (!EVIDENCE_KINDS.includes(kind)) throw new Error(`Unknown evidence kind ${kind.slice(0, 20)}`);
    return {
      kind,
      label: str(e.label, "label", 200, true)!,
      amountMinor,
      currency,
      reference: str(e.reference, "reference", 80),
      excerpt: str(e.excerpt, "excerpt", 4000),
      provenance: e.provenance,
      attachmentId: e.attachmentId == null ? null : str(e.attachmentId, "attachment", 64),
    };
  });
  return { ...input, evidence };
}

export async function ingestObligation(db: Db, rawInput: IngestInput): Promise<string> {
  const input = validateIngest(rawInput);
  const id = newId("obl");
  const ts = now();
  // One document backs one payment. Re-using it would move it off the first obligation and erase the text that
  // obligation's duplicate check reads. Checked before anything is written, so a refusal leaves no half-made draft.
  for (const e of input.evidence ?? []) {
    if (!e.attachmentId) continue;
    const att = db.select({ name: attachments.name, obligationId: attachments.obligationId }).from(attachments).where(and(eq(attachments.id, e.attachmentId), eq(attachments.businessId, input.businessId))).get();
    if (att?.obligationId) throw new Error(`Document ${att.name} is already attached to another payment; upload it again if it really backs this one too`);
  }
  // The obligation, its evidence and the attachment links are written together or not at all: a bad row must not
  // leave an orphan draft holding an attachment that can then never be used again.
  db.transaction((tx) => {
    tx.insert(obligations)
      .values({
        id,
        businessId: input.businessId,
        vendorId: null,
        state: "drafted",
        sourceType: input.sourceType,
        sourceRef: input.sourceRef ?? null,
        rawInput: input.rawInput,
        billId: rawInput.billId && db.select({ id: bills.id }).from(bills).where(and(eq(bills.id, rawInput.billId), eq(bills.businessId, input.businessId))).get() ? rawInput.billId : null,
        paymentKind: rawInput.paymentKind ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    audit(tx as unknown as Db, { obligationId: id, actor: input.actor ?? "system", action: "obligation.created", toState: "drafted", detail: { sourceType: input.sourceType, ...(rawInput.originActor ? { originActor: rawInput.originActor } : {}) } });
    if (rawInput.stated) {
      const s = rawInput.stated;
      if (!isValidAmountMinor(s.amountMinor) || !SUPPORTED_CURRENCIES.includes(s.currency)) throw new Error("Stated amount or currency is invalid");
      const stated: StatedFields = { vendorId: s.vendorId ?? null, amountMinor: s.amountMinor, currency: s.currency, sourceRef: s.sourceRef ?? null, flags: (s.flags ?? []).map((f) => String(f).slice(0, 300)).slice(0, 5), trusted: s.trusted === true };
      audit(tx as unknown as Db, { obligationId: id, actor: input.actor ?? "system", action: "obligation.stated", detail: { ...stated } });
    }
    for (const [n, e] of (input.evidence ?? []).entries()) {
      const carried = rawInput.evidenceProvenance?.[n];
      let provenance: string = carried && ["system", "operator", "document", "vendor"].includes(carried) ? carried : input.evidenceSource ?? "system";
      let attachmentId: string | null = null;
      if (e.attachmentId) {
        const att = tx.select().from(attachments).where(and(eq(attachments.id, e.attachmentId), eq(attachments.businessId, input.businessId))).get();
        if (att) {
          // One document backs one payment. Re-using it would move it off the first obligation and erase the text its duplicate check reads.
          attachmentId = att.id;
          // "document" only when every field is what the reader extracted: figures, reference, label and excerpt. Policy reads the
          // label and excerpt to bind the payee, so an edited excerpt is the operator's claim, not the document's.
          const proposed = JSON.parse(att.proposedJson) as Array<{ amountMinor: number | null; currency: string | null; reference: string | null; label?: string; excerpt?: string | null }>;
          const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();
          const untouched = proposed.some((p) => p.amountMinor === e.amountMinor && (p.currency ?? null) === (e.currency ?? null) && (p.reference ?? null)?.toUpperCase() === (e.reference ?? null)?.toUpperCase() && same(p.label, e.label) && same(p.excerpt, e.excerpt));
          // A .txt file is as easy to type as the form itself, so it never counts as an independent document.
          provenance = untouched && att.mimeType !== "text/plain" ? "document" : "operator";
          tx.update(attachments).set({ obligationId: id }).where(eq(attachments.id, att.id)).run();
        }
      }
      tx.insert(evidenceTable).values({ id: newId("evd"), obligationId: id, kind: e.kind, label: e.label, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, excerpt: e.excerpt, provenance, attachmentId, createdAt: ts }).run();
    }
    if ((input.evidence ?? []).length > 0) {
      audit(tx as unknown as Db, { obligationId: id, actor: input.actor ?? "system", action: "evidence.attached", detail: { count: input.evidence!.length, labels: input.evidence!.map((e) => e.label) } });
    }
  });
  await processObligation(db, id);
  return id;
}

/** Run interpretation, policy, quoting and routing. Safe to re-run after a human edits evidence. */
export async function processObligation(db: Db, obligationId: string): Promise<void> {
  const ob = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const vendorRows = db.select().from(vendors).where(eq(vendors.businessId, ob.businessId)).all();
  const vendorProfiles = vendorRows.map(toProfile);
  const ev = listEvidence(db, obligationId);

  // 1. AI interpretation
  const docs = db.select({ name: attachments.name, reader: attachments.reader, text: attachments.extractedText }).from(attachments).where(eq(attachments.obligationId, obligationId)).all();
  const vendorHistory = (vendorId: string) =>
    db
      .select({ sourceRef: obligations.sourceRef, amountMinor: settlements.grossMinor, currency: settlements.grossCurrency, settledAt: settlements.settledAt, description: obligations.description })
      .from(settlements)
      .innerJoin(obligations, eq(obligations.id, settlements.obligationId))
      .where(and(eq(obligations.vendorId, vendorId), ne(obligations.id, obligationId)))
      .orderBy(desc(settlements.settledAt))
      .limit(12)
      .all()
      .map((r) => ({ ...r, description: (r.description ?? "").slice(0, 120) }));
  // Fields a person corrected stay corrected: a new record or a re-read never puts the agent's figure back.
  const amended = new Set(
    db.select({ detail: auditEntries.detailJson, actor: auditEntries.actor }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "obligation.amended"))).all()
      .filter((a) => a.actor.startsWith("user:"))
      .flatMap((a) => Object.keys((JSON.parse(a.detail ?? "{}") as { patch?: Record<string, unknown> }).patch ?? {})),
  );
  const run = await runObligationAgent({ rawInput: ob.rawInput, sourceType: ob.sourceType, vendors: vendorProfiles, evidence: ev, documents: docs, businessName: biz.name, baseCurrency: biz.baseCurrency, vendorHistory });
  const ai = { ...run.interpretation };
  // Fields a structured caller sent are the request; the reader's reading of them only describes it.
  const statedRow = db.select({ detail: auditEntries.detailJson }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "obligation.stated"))).orderBy(desc(auditEntries.seq)).get();
  const rulesReader = run.engine !== "claude";
  if (statedRow) applyStated(ai, JSON.parse(statedRow.detail ?? "{}") as StatedFields, vendorProfiles, ev, ob.rawInput, changedByPerson(db, obligationId), rulesReader);
  if (amended.has("amountMinor")) {
    ai.amountMinor = ob.amountMinor;
    // The rules reader's own sentence about the figure it read is moot once a person set it. A live reader's concerns
    // stay, however they are worded (agent guard review AG4-5).
    if (rulesReader) ai.flags = ai.flags.filter((f) => !/^Requested amount differs from /.test(f));
  }
  if (amended.has("currency")) ai.currency = ob.currency;
  if (amended.has("sourceRef")) {
    ai.sourceRef = ob.sourceRef;
    ai.flags = ai.flags.filter((f) => !/Reference .* does not (match|appear)/i.test(f));
  }
  if (amended.has("vendorId")) ai.vendorId = ob.vendorId;
  // Approvals were given for specific numbers. If re-interpretation changes who is paid, how much or what for, they no longer count.
  const approved = db.select().from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all();
  if (approved.length > 0 && (ob.vendorId !== (ai.vendorId ?? ob.vendorId) || ob.amountMinor !== ai.amountMinor || ob.currency !== ai.currency || ob.sourceRef !== (ai.sourceRef ?? ob.sourceRef))) {
    db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).run();
    audit(db, { obligationId, actor: "system", action: "approvals.superseded", detail: { reason: "re-interpretation changed vendor, amount, currency or reference", count: approved.length } });
  }
  // The invoice's own dates: read from everything on file, a person's setting wins, the vendor's terms fill the gap.
  const dates = invoiceDatesFor(db, ob, ai.vendorId ?? ob.vendorId, docs.map((d) => d.text), ev, ai.dueDate);
  db.update(obligations)
    .set({
      vendorId: ai.vendorId ?? ob.vendorId,
      description: ai.description,
      amountMinor: ai.amountMinor,
      currency: ai.currency,
      sourceRef: ai.sourceRef ?? ob.sourceRef,
      dueDate: dates.dueDate,
      invoiceDate: dates.invoiceDate,
      aiSummary: ai.summary,
      aiConfidence: ai.confidence,
      aiFlagsJson: JSON.stringify(ai.flags),
      aiMissingJson: JSON.stringify(ai.missing),
      updatedAt: now(),
    })
    .where(eq(obligations.id, obligationId))
    .run();
  audit(db, {
    obligationId,
    actor: run.engine === "claude" ? `ai:${run.model}` : "ai:rules",
    action: "ai.interpreted",
    detail: { vendorId: ai.vendorId, amountMinor: ai.amountMinor, currency: ai.currency, sourceRef: ai.sourceRef, confidence: ai.confidence, flags: ai.flags, missing: ai.missing, notes: ai.notes ?? [], engine: run.engine, model: run.model, toolCalls: run.toolCalls.map((t) => ({ name: t.name, input: JSON.stringify(t.input ?? {}).slice(0, 200), resultPreview: String(t.resultPreview ?? "").slice(0, 200) })) },
  });

  // 1b. A deposit or a balance belongs to a bill: the invoice total, with every part paid against it.
  const newBill = linkToBill(db, obligationId, ai, ev);
  // A bill recorded from a deposit picks up the outside requests already waiting that name it (API review R8-N2).
  if (newBill) {
    try {
      await linkWaitingToBill(db, newBill, "ai:bills");
    } catch (e) {
      console.error("[checkrail] linking waiting requests to a new bill failed", e);
    }
  }

  // 2. Policy, after checking PayPal's own history for this job
  await refreshPayPalHistory(db, obligationId);
  const outcome = runPolicy(db, obligationId);

  // 3. Quotes and route (only when the obligation is well-formed and has a vendor)
  const fresh = mustGet(db, obligationId);
  const vendor = fresh.vendorId ? vendorProfiles.find((v) => v.id === fresh.vendorId) ?? null : null;
  if (vendor && fresh.amountMinor && fresh.currency) {
    await quoteAndRoute(db, obligationId, vendor, payableMinor(fresh), fresh.currency, biz.country);
  }

  // 4. State
  const current = mustGet(db, obligationId).state as ObligationState;
  moveTo(db, obligationId, targetState(outcome, current), outcome);

  // 5. Autopilot: a clean payment inside the caps is scheduled for release after the cancel window.
  if (outcome.decision === "auto_execute" && mustGet(db, obligationId).state === "approved") {
    scheduleAutopilotRelease(db, obligationId);
  }
}

/** The fields a person changed to a different value (an amendment that sets the same value changes nothing). */
function changedByPerson(db: Db, obligationId: string): Set<string> {
  const out = new Set<string>();
  for (const a of db.select({ detail: auditEntries.detailJson, actor: auditEntries.actor }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "obligation.amended"))).all()) {
    if (!a.actor.startsWith("user:")) continue;
    const d = JSON.parse(a.detail ?? "{}") as { patch?: Record<string, unknown>; previous?: Record<string, unknown> };
    for (const [k, v] of Object.entries(d.patch ?? {})) if (v !== (d.previous ?? {})[k]) out.add(k);
  }
  return out;
}

/** Which fields an outside agent's own concern is about, by the sentence the guard writes for each. */
export const AGENT_FLAG_PREFIX = "The agent's request text disagrees with the fields it sent";
function agentFlagFields(f: string): string[] {
  if (!f.startsWith(AGENT_FLAG_PREFIX)) return [];
  if (/not the payee sent/.test(f)) return ["vendorId"];
  if (/not the reference /.test(f)) return ["sourceRef"];
  if (/\bstates\b.*\bsent\b/.test(f)) return ["amountMinor", "currency"];
  return ["vendorId", "amountMinor", "currency", "sourceRef"];
}

/**
 * Put the fields a structured caller sent in place of the reader's. The reader's own reading of the payee, amount and
 * reference was taken from text the caller wrote, so its concerns about those figures are replaced by checks on the
 * fields themselves; every other concern stays. Policy then judges exactly what was sent (agent guard review AG2-1).
 */
function applyStated(ai: AiInterpretation, s: StatedFields, vendorProfiles: VendorPayoutProfile[], ev: EvidenceItem[], rawInput: string, changed: Set<string>, rulesReader: boolean): void {
  const vendor = s.vendorId ? vendorProfiles.find((v) => v.id === s.vendorId) ?? null : null;
  const otherFigure = ai.amountMinor !== s.amountMinor || ai.currency !== s.currency;
  const differs = otherFigure || ai.vendorId !== (vendor?.id ?? null) || (ai.sourceRef ?? null) !== (s.sourceRef ?? null);
  if (differs) {
    const read = [ai.vendorName, ai.amountMinor && ai.currency ? fmt(ai.amountMinor, ai.currency) : null, ai.sourceRef].filter(Boolean).join(", ");
    ai.notes = [...(ai.notes ?? []), `The requester's own fields are used${read ? `; the reader took ${read} from the text` : ""}`];
  }
  ai.vendorId = vendor?.id ?? null;
  ai.vendorName = vendor?.name ?? null;
  ai.amountMinor = s.amountMinor;
  ai.currency = s.currency;
  ai.sourceRef = s.sourceRef ?? null;
  // Only the rules reader's own two sentences about the figures it read are dropped. A live reader's concerns, and
  // any other, stay a hold however they are worded (agent guard reviews AG3-2, AG4-5).
  if (rulesReader) ai.flags = ai.flags.filter((f) => !/^Requested amount differs from /.test(f) && !/^Reference \S+ does not appear on any attached record/.test(f));
  ai.missing = ai.missing.filter((m) => !/vendor name|amount and currency|invoice, job or booking reference/i.test(m));
  const refs = ev.map((e) => e.reference).filter((r): r is string => Boolean(r) && !/^AGR-/i.test(r!));
  const sentKeys = new Set(sourceRefKeys(s.sourceRef).filter((k) => k.startsWith("~")));
  if (s.sourceRef && refs.length > 0 && !refs.some((r) => r.toUpperCase() === s.sourceRef!.toUpperCase() || sourceRefKeys(r).some((k) => sentKeys.has(k)))) {
    ai.flags.push(`Reference ${s.sourceRef} does not appear on any attached record (found ${[...new Set(refs)].join(", ")})`);
  }
  // The caller's own concerns compare its fields with its words, one concern per field. A concern stays until a person
  // has actually changed the field it is about (AG3-5, AG4-6).
  ai.flags.push(...(s.flags ?? []).filter((f) => !agentFlagFields(f).some((k) => changed.has(k))));
  const totals = ev.filter((e) => e.currency === s.currency && e.amountMinor != null).map((e) => e.amountMinor!);
  if (otherFigure) ai.paymentPart = paymentPartOf(rawInput, s.amountMinor, s.currency, totals);
  if (differs) {
    ai.description = `${vendor?.name ?? "Unknown payee"}${s.sourceRef ? ` (${s.sourceRef})` : ""}: ${fmt(s.amountMinor, s.currency)} as requested`;
    ai.summary = `${vendor?.name ?? "A payee not on file"} is asked for ${fmt(s.amountMinor, s.currency)}${s.sourceRef ? ` for ${s.sourceRef}` : ""}. ${ai.flags.length === 0 ? "No concerns noted." : `${ai.flags.length} concern${ai.flags.length === 1 ? "" : "s"} noted.`}`;
  }
}

/**
 * The text policy reads to see whether the request names the payee. For a request with stated fields that is the
 * requester's own words, not the header Checkrail wrote from the fields, so an agent is held to the same test as an
 * integration sending the same text (agent guard review AG3-4). With no words, the fields are the request.
 */
const QUOTED = 'The request as the agent received it: "';
function policyRequestText(db: Db, ob: typeof obligations.$inferSelect): string {
  const stated = db.select({ id: auditEntries.id }).from(auditEntries).where(and(eq(auditEntries.obligationId, ob.id), eq(auditEntries.action, "obligation.stated"))).get();
  const at = ob.rawInput.indexOf(QUOTED);
  return stated && at >= 0 ? ob.rawInput.slice(at + QUOTED.length).replace(/"$/, "") : ob.rawInput;
}

function invoiceDatesFor(db: Db, ob: typeof obligations.$inferSelect, vendorId: string | null, docTexts: Array<string | null>, ev: EvidenceItem[], agentDue: string | null): { invoiceDate: string | null; dueDate: string | null } {
  const set = db.select({ detail: auditEntries.detailJson }).from(auditEntries).where(and(eq(auditEntries.obligationId, ob.id), eq(auditEntries.action, "obligation.dates_set"))).orderBy(desc(auditEntries.seq)).get();
  if (set) return { invoiceDate: ob.invoiceDate, dueDate: ob.dueDate };
  const text = [ob.rawInput, ...docTexts.map((t) => t?.slice(0, 8000)), ...ev.map((e) => e.excerpt)].filter(Boolean).join("\n");
  const today = localDateString();
  const read = extractInvoiceDates(text, today);
  const terms = vendorId ? db.select({ t: vendors.paymentTermsDays }).from(vendors).where(eq(vendors.id, vendorId)).get()?.t ?? null : null;
  const dueDate = read.dueDate ?? (agentDue && /^\d{4}-\d{2}-\d{2}$/.test(agentDue) ? agentDue : null) ?? (terms != null ? addDays(read.invoiceDate ?? localDateString(new Date(ob.createdAt)), terms) : null);
  return { invoiceDate: read.invoiceDate, dueDate };
}

/** A person sets the invoice and due dates (they do not change what is paid, so approvals stand). */
export function setObligationDates(db: Db, obligationId: string, actor: string, raw: { invoiceDate?: unknown; dueDate?: unknown }): { changedAfterExport: boolean } {
  const ob = mustGet(db, obligationId);
  if (["settled", "cancelled", "refunded"].includes(ob.state)) throw new Error("This payment is closed");
  const ok = (v: unknown) => v === null || v === "" || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)));
  if (!ok(raw.invoiceDate ?? null) || !ok(raw.dueDate ?? null)) throw new Error("Dates must be YYYY-MM-DD");
  const invoiceDate = (raw.invoiceDate as string | null) || null;
  const dueDate = (raw.dueDate as string | null) || null;
  if (invoiceDate && dueDate && dueDate < invoiceDate) throw new Error("The due date is before the invoice date");
  if (invoiceDate && invoiceDate > localDateString()) throw new Error("The invoice date is in the future; check the date on the invoice");
  // A closed month stays closed: neither the date being replaced nor the new one may fall in it.
  if (invoiceDate !== ob.invoiceDate) for (const d of [ob.invoiceDate, invoiceDate]) if (d) assertOpenPeriod(db, ob.businessId, d, "an invoice");
  db.update(obligations).set({ invoiceDate, dueDate, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  // Already in Xero with the old dates: the accountant changes it there too. Recorded so the Accounting page lists it.
  if (ob.xeroBillExportedAt && (invoiceDate !== ob.invoiceDate || dueDate !== ob.dueDate)) audit(db, { obligationId, actor, action: "accounting.changed_after_export", detail: { what: "dates", invoiceDate, dueDate, exportedAt: ob.xeroBillExportedAt } });
  if (ob.billId) db.update(bills).set({ billDate: invoiceDate ?? undefined, dueDate: dueDate ?? undefined }).where(eq(bills.id, ob.billId)).run();
  audit(db, { obligationId, actor, action: "obligation.dates_set", detail: { invoiceDate, dueDate, previous: { invoiceDate: ob.invoiceDate, dueDate: ob.dueDate } } });
  return { changedAfterExport: Boolean(ob.xeroBillExportedAt) };
}

/**
 * A payment that came back (an unclaimed or reversed payout) is owed again. This starts a new request for it, with the
 * same text and records, through every check again: the vendor's details, the duplicate check (a refunded payment
 * does not count as paid), approval. The refunded one stays as it is, for the books.
 */
function statedAgain(db: Db, ob: typeof obligations.$inferSelect): StatedFields | undefined {
  const row = db.select({ detail: auditEntries.detailJson }).from(auditEntries).where(and(eq(auditEntries.obligationId, ob.id), eq(auditEntries.action, "obligation.stated"))).orderBy(desc(auditEntries.seq)).get();
  if (!row || !ob.amountMinor || !ob.currency) return undefined;
  const s = JSON.parse(row.detail ?? "{}") as StatedFields;
  // A concern a person resolved by correcting its field does not come back with the repayment (AG4-9).
  const changed = changedByPerson(db, ob.id);
  return { vendorId: ob.vendorId, amountMinor: ob.amountMinor, currency: ob.currency, sourceRef: ob.sourceRef, flags: (s.flags ?? []).filter((f) => !agentFlagFields(f).some((k) => changed.has(k))), trusted: s.trusted === true };
}

export async function repayRefunded(db: Db, obligationId: string, actor: string): Promise<string> {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "refunded") throw new Error("Only a payment that came back can be paid again");
  if (ob.billId) throw new Error("This was part of a bill: pay what is open on the bill from the vendor's page");
  const again = db.select({ id: obligations.id }).from(auditEntries).innerJoin(obligations, eq(obligations.id, auditEntries.obligationId)).where(and(eq(auditEntries.action, "obligation.repays"), eq(auditEntries.detailJson, JSON.stringify({ refunded: obligationId })))).all().filter((r) => r.id);
  const live = again.map((r) => mustGet(db, r.id)).find((o) => !["cancelled", "failed", "refunded"].includes(o.state));
  if (live) throw new Error(`Already requested again (${live.id})`);
  const ev = listEvidence(db, obligationId);
  // Copied records keep exactly the weight they had: a machine-read document stays a document, a typed one stays typed.
  const id = await ingestObligation(db, {
    businessId: ob.businessId,
    sourceType: ob.sourceType as SourceType,
    sourceRef: ob.sourceRef,
    rawInput: ob.rawInput,
    evidence: ev.map(({ id: _id, provenance: _p, ...e }) => (void _id, void _p, e)),
    evidenceProvenance: ev.map((e) => e.provenance ?? "system"),
    actor,
    // A request whose fields were stated keeps them, as paid, with the caller's own concerns (AG3-7).
    stated: statedAgain(db, ob),
    // And its records keep the weight of whoever first sent them: a person paying again does not make an outside
    // caller's records the business's own when a bill total is decided (API review R3-S2).
    originActor: originOf(db, ob.id),
  });
  // The bill is already in Xero from the first time: the same invoice is not a second bill.
  if (ob.xeroBillExportedAt) db.update(obligations).set({ xeroBillExportedAt: ob.xeroBillExportedAt }).where(eq(obligations.id, id)).run();
  audit(db, { obligationId: id, actor, action: "obligation.repays", detail: { refunded: obligationId } });
  return id;
}

/**
 * Run the checks again without re-reading the request: for a payment that was blocked by something outside it (the
 * vendor's details were not verified yet, a rate card was missing) once that has been fixed.
 */
export async function recheckObligation(db: Db, obligationId: string, actor: string): Promise<ObligationState> {
  const ob = mustGet(db, obligationId);
  if (!["blocked", "needs_evidence", "awaiting_approval"].includes(ob.state)) throw new Error(`Nothing to check again in state ${ob.state}`);
  if (ob.state === "blocked") transition(db, obligationId, "verified", actor, "review.recheck", { reason: "checked again" });
  else audit(db, { obligationId, actor, action: "review.recheck", detail: {} });
  await refreshPayPalHistory(db, obligationId);
  const outcome = runPolicy(db, obligationId);
  const fresh = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, fresh.businessId)).get()!;
  const vendorRow = fresh.vendorId ? db.select().from(vendors).where(eq(vendors.id, fresh.vendorId)).get() : null;
  if (vendorRow && fresh.amountMinor && fresh.currency) await quoteAndRoute(db, obligationId, toProfile(vendorRow), payableMinor(fresh), fresh.currency, biz.country);
  moveTo(db, obligationId, targetState(outcome, fresh.state as ObligationState), outcome);
  return mustGet(db, obligationId).state as ObligationState;
}

/** After a vendor's details are verified or a rate is set: everything of theirs that is still waiting is checked again. */
export async function recheckVendorItems(db: Db, businessId: string, vendorId: string, actor: string): Promise<number> {
  const waiting = db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.businessId, businessId), eq(obligations.vendorId, vendorId), inArray(obligations.state, ["blocked", "needs_evidence", "awaiting_approval"]))).all();
  for (const w of waiting) await recheckObligation(db, w.id, actor);
  return waiting.length;
}

/** Quote every rail again and let the router choose, for a payment not yet sent. maxAgeMs 0 always refreshes. */
export async function refreshQuotesIfStale(db: Db, obligationId: string, maxAgeMs: number): Promise<boolean> {
  const ob = mustGet(db, obligationId);
  if (!["approved", "awaiting_approval", "blocked", "needs_evidence"].includes(ob.state) || !ob.vendorId || !ob.amountMinor || !ob.currency) return false;
  const newest = db.select({ at: routeQuotes.createdAt }).from(routeQuotes).where(eq(routeQuotes.obligationId, obligationId)).orderBy(desc(routeQuotes.createdAt)).get()?.at;
  if (maxAgeMs > 0 && newest && Date.now() - new Date(newest).getTime() < maxAgeMs) return false;
  const vendorRow = db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get();
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get();
  if (!vendorRow || !biz) return false;
  // The tax kept back is part of what is sent: work it out from the vendor's details as they are now.
  const w = withholdingFor({ ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) }, biz.country, vendorRow, ob.amountMinor, ob.currency);
  db.update(obligations).set({ withheldMinor: w?.withheldMinor ?? null, withholdingNote: w?.reason ?? null }).where(eq(obligations.id, obligationId)).run();
  await quoteAndRoute(db, obligationId, toProfile(vendorRow), payableMinor(mustGet(db, obligationId)), ob.currency, biz.country);
  return true;
}

/** Schedule an autopilot release for an approved obligation. No-op unless autopilot is in force, and never after a person cancelled it. */
export function scheduleAutopilotRelease(db: Db, obligationId: string): void {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "approved" || ob.releaseAt || ob.autopilotCancelledAt) return;
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const policy: ApprovalPolicy = { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
  if (effectiveAutonomy(policy) !== "autopilot") return;
  const windowSeconds = Math.max(0, policy.autopilotCancelWindowSeconds ?? 600);
  const releaseAt = new Date(Date.now() + windowSeconds * 1000).toISOString();
  db.update(obligations).set({ releaseAt, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor: "agent:autopilot", action: "autopilot.scheduled", detail: { releaseAt, windowSeconds } });
}

/**
 * Walk the state machine to the policy's target. Intake states pass through
 * `verified` on the way to approval so the audit trail shows the obligation was
 * checked before it was authorised.
 */
function moveTo(db: Db, obligationId: string, target: ObligationState, outcome: PolicyOutcome): void {
  const current = mustGet(db, obligationId).state as ObligationState;
  if (current === target) return;
  if ((target === "approved" || target === "awaiting_approval") && ["drafted", "needs_evidence", "blocked"].includes(current)) {
    transition(db, obligationId, "verified", "policy", "policy.verified", { rulesPassed: outcome.rules.filter((r) => r.passed).map((r) => r.ruleId) });
  }
  transition(db, obligationId, target, "policy", `policy.${outcome.decision}`, { reasons: outcome.reasons });
  if (target === "approved") {
    // Snapshot where the money is going at the moment it is authorised. Execution refuses if it changed.
    const ob = mustGet(db, obligationId);
    const v = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : null;
    db.update(obligations).set({ payoutHash: v ? payoutHashOf(v) : null }).where(eq(obligations.id, obligationId)).run();
  }
}

/** Hash of the fields that decide where a payment lands. Same parts as the seed uses for vendors.detailsHash. */
export function payoutHashOf(v: { paypalEmail: string | null; stellarAccount: string | null; bankLabel: string | null; bankAccountEnc?: string | null; bankCode?: string | null; bankAccountNumber?: string | null }): string {
  // A full account number joins the hash only when there is one, so details hashed before bank rails existed still match.
  // It joins as a keyed digest, never raw: the stored hash sits next to the masked label (last four digits), and a
  // plain hash of the number would let anyone with the database file find it by search without the data key.
  const account = v.bankAccountNumber ?? (v.bankAccountEnc ? decryptField(v.bankAccountEnc) : null);
  const bank = `${v.bankCode ?? ""}:${account}`;
  return hashPayoutDetails(account ? [v.paypalEmail, v.stellarAccount, v.bankLabel, keyedDigest("payout-hash", bank)] : [v.paypalEmail, v.stellarAccount, v.bankLabel]);
}

/** Names of other vendors in the same business paid to the same PayPal email, Stellar account or bank account. */
function sharedPayout(db: Db, v: typeof vendors.$inferSelect): string[] {
  const norm = (x: string | null) => (x ?? "").trim().toLowerCase();
  return db
    .select()
    .from(vendors)
    .where(and(eq(vendors.businessId, v.businessId), ne(vendors.id, v.id)))
    .all()
    .filter((o) => (norm(v.paypalEmail) && norm(o.paypalEmail) === norm(v.paypalEmail)) || (norm(v.stellarAccount) && norm(o.stellarAccount) === norm(v.stellarAccount)) || (norm(v.bankLabel) && norm(o.bankLabel) === norm(v.bankLabel) && norm(o.bankCountry) === norm(v.bankCountry)))
    .map((o) => o.name);
}

/** The job identifiers this request names: its reference, its text, its evidence and its documents. */
/**
 * Reference keys from records that name one job (an invoice, a job sheet, a receipt). A contract, booking or rate
 * sheet is shared by many payments to the vendor, so its reference names no single job (agent guard review AG4-2).
 */
/** Records that name one job. A booking or purchase order does: the same booking on two invoices is one job paid twice (AG5-1). */
const SINGLE_JOB_KINDS = ["invoice", "job_sheet", "receipt"];
/** A booking or purchase order usually names one job, but a deposit and its balance, or weekly invoices on a blanket
 *  order, honestly share one: a match through them alone holds the payment for a person instead of blocking it (AG6-5). */
const SHARED_JOB_KINDS = ["booking", "purchase_order"];
/**
 * Text that can name a job. A contract's own number is shared by every payment under it, so it is not read (AG5-2),
 * and a booking's or order's own number is matched as a shared record (AG6-5); the rest of each record is read, since
 * a charter for one departure names that departure (AG6-2).
 */
const jobTexts = (ev: Array<{ kind: string; reference: string | null; label: string; excerpt: string | null }>) =>
  ev.flatMap((e) => {
    // A booking's or order's own number is read as a shared record ("^" keys), not as a job id that blocks.
    if (!["contract", ...SHARED_JOB_KINDS].includes(e.kind)) return [e.reference, e.label, e.excerpt];
    // Only the reference as a whole token: booking "1185" must not cut "HG-4D-1185" down to "HG-4D-" (AG7-2).
    const own = e.reference ? new RegExp(`(?<![\\p{L}\\p{N}-])${e.reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}]|-\\p{N})`, "giu") : null;
    return [e.label, e.excerpt].map((t) => (t && own ? t.replace(own, " ") : t));
  });

/**
 * Reference keys from records: invoices, job sheets and receipts name one job ("~" keys, a match blocks); bookings and
 * purchase orders name one job or a few ("^" keys, a match holds). Only comparison forms, which need a digit, so a
 * placeholder ("N/A", "TBC", "ROSA") names nothing; and a date is not a job (AG6-3).
 */
function jobRecordRefKeys(ev: Array<{ kind: string; reference: string | null }>): string[] {
  const forms = (r: string | null) => (r && !isDateLike(r) ? sourceRefKeys(r).filter((k) => k.startsWith("~")) : []);
  return [
    ...ev.filter((e) => SINGLE_JOB_KINDS.includes(e.kind)).flatMap((e) => forms(e.reference)),
    // A booking or order named after a departure (a booking "HG-4D-1184", an order "PO-CEB2D-1307") names that
    // departure: its departure forms stay job keys (AG8-3).
    ...ev.filter((e) => SHARED_JOB_KINDS.includes(e.kind)).flatMap((e) => {
      const dep = isDepartureRef(e.reference) ? new Set(forms(e.reference)) : new Set(departureForms(e.reference).map((f) => `~${f}`));
      return forms(e.reference).map((k) => (dep.has(k) ? k : `^${k.slice(1)}`));
    }),
  ];
}

function ownJobKeys(db: Db, ob: typeof obligations.$inferSelect, ev: EvidenceItem[] = listEvidence(db, ob.id)): string[] {
  const docTexts = db.select({ text: attachments.extractedText }).from(attachments).where(eq(attachments.obligationId, ob.id)).all();
  const texts = [ob.sourceRef, ob.rawInput, ob.description, ...jobTexts(ev), ...docTexts.map((d) => d.text?.slice(0, 4000))];
  return [...new Set([...jobKeys(...texts), ...bookingKeys(...texts), ...sourceRefKeys(ob.sourceRef), ...jobRecordRefKeys(ev)])];
}

/**
 * Read PayPal's own transaction history and record whether it already paid this job to this payee. Deterministic and
 * model-independent: it runs before every policy decision that can lead to money moving (reading the request,
 * checking again, and the moment of payment), whatever the reader did. Read-only. A failure to read PayPal is
 * recorded as such and does not block: the local history check still runs.
 */
export async function refreshPayPalHistory(db: Db, obligationId: string): Promise<PayPalHistoryCheck | null> {
  const ob = mustGet(db, obligationId);
  const vendorRow = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : null;
  if (!vendorRow?.paypalEmail) {
    if (ob.paypalHistoryJson) db.update(obligations).set({ paypalHistoryJson: null }).where(eq(obligations.id, obligationId)).run();
    return null;
  }
  const keys = ownJobKeys(db, ob);
  keys.push(...sourceRefKeys(ob.sourceRef));
  // PayPal transactions this business has recorded as come back (refunded here) are not "already paid".
  const cameBack = db
    .select({ ref: settlements.statementRef })
    .from(settlements)
    .innerJoin(obligations, eq(obligations.id, settlements.obligationId))
    .where(and(eq(obligations.vendorId, vendorRow.id), eq(obligations.state, "refunded")))
    .all()
    .map((r) => r.ref)
    .filter((r): r is string => Boolean(r));
  const raw = await listPayPalTransactionsRaw(() => simulatedPayPalHistory(db, ob.businessId));
  const check: PayPalHistoryCheck = raw.ok
    ? { checkedAt: now(), ok: true, ...matchPayPalHistory(raw.body, keys, vendorRow.paypalEmail, cameBack) }
    : { checkedAt: now(), ok: false, error: raw.error, lines: 0, matches: [] };
  db.update(obligations).set({ paypalHistoryJson: JSON.stringify(check) }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor: "paypal:history", action: "paypal.history_checked", detail: { ok: check.ok, error: check.error, lines: check.lines, matches: check.matches.map((m) => m.transactionId) } });
  return check;
}

/**
 * On simulated rails, the PayPal history is what the simulated PayPal rail actually did: one money-out line per PayPal
 * payout this business settled in the last 31 days, and a reversal line for each one that came back. So the check
 * behaves as it would against a real account, and a payment the demo made earlier is "already paid" on PayPal too.
 */
function simulatedPayPalHistory(db: Db, businessId: string): string {
  const since = new Date(Date.now() - 31 * 86_400_000).toISOString();
  const rows = db
    .select({ s: settlements, ref: obligations.sourceRef, state: obligations.state, email: vendors.paypalEmail })
    .from(settlements)
    .innerJoin(obligations, eq(obligations.id, settlements.obligationId))
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), eq(settlements.rail, "paypal")))
    .all()
    .filter((r) => r.s.settledAt >= since);
  const details = rows.flatMap((r) => {
    const id = r.s.statementRef ?? r.s.externalId ?? r.s.id;
    const out = { transaction_info: { transaction_id: id, transaction_event_code: "T0001", transaction_amount: { currency_code: r.s.grossCurrency, value: (-r.s.grossMinor / 100).toFixed(2) }, transaction_note: r.ref ?? "", transaction_initiation_date: r.s.settledAt, transaction_status: "S" }, payer_info: { email_address: r.email ?? "" } };
    if (r.state !== "refunded") return [out];
    return [out, { transaction_info: { transaction_id: `${id}-R`, paypal_reference_id: id, transaction_event_code: "T1106", transaction_amount: { currency_code: r.s.grossCurrency, value: (r.s.grossMinor / 100).toFixed(2) }, transaction_note: "returned", transaction_initiation_date: r.s.settledAt, transaction_status: "S" }, payer_info: { email_address: r.email ?? "" } }];
  });
  return JSON.stringify({ transaction_details: details, total_items: details.length });
}

/**
 * Evaluate policy for an obligation without writing anything: no audit row, no change to the stored decision, no
 * superseded approvals. Pages that only look (a payment run, a list) use this; a GET must not change the record.
 */
/**
 * PayPal reports a returned, reversed or refunded payout as a failed attempt. Retrying it re-approves the same
 * obligation, so the "a payment to these details came back" rule would never see it (it looks at other obligations).
 * True when this obligation's own attempt came back after the details were last verified.
 */
function cameBackOnItsOwn(db: Db, obligationId: string, verifiedAt: string | null): boolean {
  return db
    .select({ status: paymentAttempts.status, externalStatus: paymentAttempts.externalStatus, errorMessage: paymentAttempts.errorMessage, updatedAt: paymentAttempts.updatedAt })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.obligationId, obligationId))
    .all()
    .some((a) => a.status === "failed" && /RETURNED|REVERSED|REFUNDED/i.test(`${a.externalStatus ?? ""} ${a.errorMessage ?? ""}`) && (!verifiedAt || a.updatedAt > verifiedAt));
}

export function previewPolicy(db: Db, obligationId: string): PolicyOutcome {
  return evaluateOutcome(db, obligationId).outcome;
}

/** Evaluate policy and record the result: the stored decision, tax kept back, superseded approvals and an audit row. */
export function runPolicy(db: Db, obligationId: string): PolicyOutcome {
  const { outcome, withholding } = evaluateOutcome(db, obligationId);
  db.update(obligations).set({ withheldMinor: withholding?.withheldMinor ?? null, withholdingNote: withholding?.reason ?? null }).where(eq(obligations.id, obligationId)).run();
  if (outcome.unacknowledged?.length) {
    // The approvals were given over a different set of warnings. They no longer count; a person looks again.
    db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).run();
    audit(db, { obligationId, actor: "policy", action: "approval.superseded", detail: { reason: "new warnings since approval", rules: outcome.unacknowledged } });
  }
  db.update(obligations)
    .set({ policyDecision: outcome.decision, policyReasonsJson: JSON.stringify(outcome.reasons), blockedReason: outcome.decision === "block" ? outcome.reasons[0] ?? null : null, updatedAt: now() })
    .where(eq(obligations.id, obligationId))
    .run();
  audit(db, { obligationId, actor: "policy", action: "policy.evaluated", detail: { decision: outcome.decision, rules: outcome.rules } });
  return outcome;
}

function evaluateOutcome(db: Db, obligationId: string): { outcome: PolicyOutcome; withholding: ReturnType<typeof withholdingFor> } {
  const ob = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const policy: ApprovalPolicy = { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
  const vendorRow = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : null;
  const vendor = vendorRow ? toProfile(vendorRow) : null;
  const prior = vendor
    ? db
        .select({ obligationId: obligations.id, sourceRef: obligations.sourceRef, amountMinor: obligations.amountMinor, currency: obligations.currency, billId: obligations.billId, state: obligations.state, updatedAt: obligations.updatedAt, createdAt: obligations.createdAt, rawInput: obligations.rawInput, description: obligations.description, payoutHash: obligations.payoutHash })
        .from(obligations)
        .where(and(eq(obligations.vendorId, vendor.id), ne(obligations.id, obligationId)))
        .all()
        .map((p) => {
          // Identity of the underlying job comes from everything that names it, including the document text:
          // a re-issued invoice under a new number still says "ref INV-TAM-0834" or "trip HG-4D-0831" in its lines.
          const ev = db.select({ kind: evidenceTable.kind, reference: evidenceTable.reference, label: evidenceTable.label, excerpt: evidenceTable.excerpt }).from(evidenceTable).where(eq(evidenceTable.obligationId, p.obligationId)).all();
          const texts = db.select({ text: attachments.extractedText }).from(attachments).where(eq(attachments.obligationId, p.obligationId)).all();
          const all = [p.sourceRef, p.rawInput, p.description, ...jobTexts(ev), ...texts.map((t) => t.text?.slice(0, 4000))];
          return { ...p, keys: [...new Set([...jobKeys(...all), ...bookingKeys(...all), ...sourceRefKeys(p.sourceRef), ...jobRecordRefKeys(ev)])] };
        })
    : [];
  // An outside agent's request that nobody has approved, sent without attest, is its say-so: it does not stop another
  // request for the same job until a person approves it (agent guard review AG3-3). Committed money always counts.
  const untrustedOpen = new Set(
    prior.length
      ? db.select({ id: auditEntries.obligationId, detail: auditEntries.detailJson }).from(auditEntries).where(and(eq(auditEntries.action, "obligation.stated"), inArray(auditEntries.obligationId, prior.map((p) => p.obligationId)))).all()
          .filter((r) => (JSON.parse(r.detail ?? "{}") as StatedFields).trusted !== true)
          .map((r) => r.id!)
          .filter((id) => ["drafted", "needs_evidence", "awaiting_approval", "verified", "blocked"].includes(prior.find((p) => p.obligationId === id)?.state ?? ""))
      : [],
  );
  const myEvidence = listEvidence(db, obligationId);
  // Exact references on this obligation (its own and its evidence's), checked against other payees' obligations.
  // Compared in every form a reference is compared in, so a respelled reference still shows on another vendor (AG4-8).
  const myRefs = new Set([ob.sourceRef, ...myEvidence.map((e) => e.reference)].filter((r): r is string => Boolean(r)).flatMap((r) => [r.toUpperCase(), ...sourceRefKeys(r).filter((k) => k.startsWith("~"))]));
  const untrustedOpenIds = new Set(
    db.select({ id: auditEntries.obligationId, detail: auditEntries.detailJson, state: obligations.state }).from(auditEntries).innerJoin(obligations, eq(obligations.id, auditEntries.obligationId))
      .where(and(eq(auditEntries.action, "obligation.stated"), eq(obligations.businessId, ob.businessId), inArray(obligations.state, ["drafted", "needs_evidence", "awaiting_approval", "verified", "blocked"])))
      .all()
      .filter((r) => (JSON.parse(r.detail ?? "{}") as StatedFields).trusted !== true)
      .map((r) => r.id!),
  );
  const otherVendorRefs = ob.vendorId && myRefs.size
    ? db
        .select({ obligationId: obligations.id, sourceRef: obligations.sourceRef, state: obligations.state, vendorName: vendors.name })
        .from(obligations)
        .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
        .where(and(eq(obligations.businessId, ob.businessId), ne(obligations.vendorId, ob.vendorId), ne(obligations.id, obligationId)))
        .all()
        // An outside agent's unapproved request without attest, or any request still drafted or waiting for evidence,
        // is nobody's payment yet: it does not hold another supplier's request (AG6-11).
        .filter((o) => !["drafted", "needs_evidence"].includes(o.state) && !untrustedOpenIds.has(o.obligationId))
        .filter((o) => o.state !== "cancelled" && o.state !== "failed" && o.sourceRef && (myRefs.has(o.sourceRef.toUpperCase()) || sourceRefKeys(o.sourceRef).some((k) => k.startsWith("~") && myRefs.has(k))))
        .map((o) => ({ obligationId: o.obligationId, vendorName: o.vendorName, reference: o.sourceRef!, state: o.state }))
    : [];
  const myJobKeys = ownJobKeys(db, ob, myEvidence);
  // Distinct people, not rows: one person approving twice is still one approval.
  const approvedRows = db.select({ actor: approvals.actor, ack: approvals.acknowledgedJson, login: approvals.login }).from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all();
  // Distinct people: a demo persona approving is its owner's login, not a second person.
  const approvalsCount = new Set(approvedRows.map((a) => humanOf(a.actor, a.login))).size;
  // Union of what the approvers saw. A row from before acknowledgements were recorded means "unknown": do not second-guess it.
  const acknowledgedWarnings = approvedRows.some((a) => a.ack == null) ? undefined : [...new Set(approvedRows.flatMap((a) => JSON.parse(a.ack!) as string[]))];
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // Every amount below is in the base currency at reference rates, so caps compare like with like.
  const inBase = (minor: number | null, currency: string | null) => toBaseOrZero(minor ?? 0, currency, biz.baseCurrency);
  const vendorRecentMinor = prior.filter((p) => ["approved", "execution_pending", "sent", "settled"].includes(p.state) && p.updatedAt >= since).reduce((sum, p) => sum + inBase(p.amountMinor, p.currency), 0);
  // Business-wide committed money in the last 24h (base currency), for the autopilot daily cap. Pre-approved payments only count once autopilot has scheduled them.
  const businessRecentMinor = db
    .select({ state: obligations.state, amountMinor: obligations.amountMinor, currency: obligations.currency, releaseAt: obligations.releaseAt, updatedAt: obligations.updatedAt })
    .from(obligations)
    .where(and(eq(obligations.businessId, ob.businessId), ne(obligations.id, obligationId)))
    .all()
    .filter((o) => o.updatedAt >= since && (["execution_pending", "sent", "settled"].includes(o.state) || (o.state === "approved" && !!o.releaseAt)))
    .reduce((sum, o) => sum + inBase(o.amountMinor, o.currency), 0);
  // Tax kept back from this payment, recomputed with every policy run so a corrected amount or a new form counts.
  const withholding = vendorRow && ob.amountMinor && ob.currency ? withholdingFor(policy, biz.country, vendorRow, ob.amountMinor, ob.currency) : null;
  const ai: AiInterpretation | null = ob.aiSummary
    ? { vendorName: null, vendorId: ob.vendorId, amountMinor: ob.amountMinor, currency: ob.currency, description: ob.description ?? "", sourceRef: ob.sourceRef, dueDate: ob.dueDate, summary: ob.aiSummary, confidence: ob.aiConfidence ?? 0, flags: JSON.parse(ob.aiFlagsJson ?? "[]"), missing: JSON.parse(ob.aiMissingJson ?? "[]") }
    : null;
  const outcome = evaluatePolicy(policy, {
    obligation: { id: ob.id, amountMinor: ob.amountMinor, currency: ob.currency, sourceRef: ob.sourceRef, vendorId: ob.vendorId, createdAt: ob.createdAt },
    vendor,
    evidence: myEvidence,
    ai,
    businessCountry: biz.country,
    baseCurrency: biz.baseCurrency,
    baseAmountMinor: ob.amountMinor != null && ob.currency ? toBaseMinor(ob.amountMinor, ob.currency, biz.baseCurrency) : null,
    priorSourceRefs: prior.filter((p) => !untrustedOpen.has(p.obligationId)).map((p) => ({ obligationId: p.obligationId, sourceRef: p.sourceRef, amountMinor: p.amountMinor, state: p.state as ObligationState, keys: p.keys, updatedAt: p.updatedAt, createdAt: p.createdAt, billId: p.billId })),
    bill: billInput(db, ob),
    paymentKind: ob.paymentKind,
    invoiceDate: ob.invoiceDate,
    today: localDateString(),
    // A payout to these same details came back since they were last verified: likely a dead address.
    paypalHistory: ob.paypalHistoryJson ? (JSON.parse(ob.paypalHistoryJson) as PayPalHistoryCheck) : null,
    returnedToSameDetails: vendorRow ? (prior.find((p) => p.state === "refunded" && p.payoutHash === vendorRow.detailsHash && (!vendorRow.verifiedAt || p.updatedAt > vendorRow.verifiedAt))?.obligationId ?? (cameBackOnItsOwn(db, obligationId, vendorRow.verifiedAt) ? obligationId : null)) : null,
    expectation: vendor && ob.currency ? expectedAmount(db, ob.businessId, vendor.id, myJobKeys, ob.currency) : null,
    vendorRates: vendor ? rateCardsForPolicy(db, vendor.id) : undefined,
    withholding,
    taxFormWarning: vendorRow ? taxFormWarning(biz.country, vendorRow) : null,
    jobKeys: myJobKeys,
    otherVendorRefs,
    acknowledgedWarnings,
    sharedPayoutWith: vendorRow ? sharedPayout(db, vendorRow) : [],
    requestText: policyRequestText(db, ob),
    vendorSettledMinors: prior.filter((p) => p.state === "settled" && p.amountMinor != null).map((p) => inBase(p.amountMinor, p.currency)),
    knownVendorNames: db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.businessId, ob.businessId)).all(),
    approvalsCount,
    vendorRecentMinor,
    businessRecentMinor,
  });
  return { outcome: withBillParts(db, ob, outcome, approvalsCount, acknowledgedWarnings), withholding };
}

/** The actor who first asked for this payment: the creator, or the creator of the payment it asks for again. */
function originOf(db: Db, obligationId: string): string {
  const row = db.select({ actor: auditEntries.actor, detail: auditEntries.detailJson }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "obligation.created"))).get();
  if (!row) return "";
  const origin = (JSON.parse(row.detail ?? "{}") as { originActor?: unknown }).originActor;
  return typeof origin === "string" ? origin : row.actor;
}

/** True when a person (a user: login) approved this request. */
function approvedByPerson(db: Db, id: string): boolean {
  return Boolean(db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.obligationId, id), eq(approvals.decision, "approved"), sql`substr(${approvals.actor}, 1, 5) = 'user:'`)).get());
}

/**
 * Whether an outside caller's request is about a bill: it is on one, or its reference matches one or more bills of its
 * supplier. Such a request always waits for a person, and what the caller is told never depends on the bill (API
 * review R8). Used by the API and agent views.
 */
export function outsideBillMatch(db: Db, obligationId: string): boolean {
  const ob = db.select({ billId: obligations.billId, vendorId: obligations.vendorId, sourceRef: obligations.sourceRef }).from(obligations).where(eq(obligations.id, obligationId)).get();
  if (!ob || !/^(mcp|api):/.test(originOf(db, obligationId))) return false;
  return Boolean(ob.billId) || Boolean(ob.vendorId && ob.sourceRef && billsMatching(db, ob.vendorId, ob.sourceRef).length);
}

/**
 * Parts of one bill (API reviews R4 to R8). Policy does not compare parts of one bill with each other as duplicates,
 * which is how a deposit and its balance both get paid. So, in plain words:
 *
 *  - Every part of a bill says which part it is and lists the other parts, so an approver always sees the bill.
 *  - A request from an outside agent (mcp:) or an integration (api:) whose reference matches any bill of its supplier
 *    (one or several, any kind, any state), or that is put on one later, is never paid without a person. There are no
 *    exceptions. Autopilot cannot schedule or release it, and an approval counts only if the approver saw the warning,
 *    which names the other parts. It runs wherever policy runs: on create, on every re-check, on retry and at release.
 *  - The person sees whether it fits: what is open after credits and the other parts a person approved, or that are
 *    in flight, paid or disputed. A request that does not fit (more than is open, another currency, a credit note, a
 *    closed or void bill) is blocked, so it cannot be approved; a person can record such a payment by hand. A
 *    reference that matches several bills is blocked until a person records which one it pays.
 *  - The outside caller is told the same either way (src/lib/api/requests.ts, src/lib/agent/guard.ts).
 *  - A person's part carries a note and otherwise goes as it always has.
 */
function withBillParts(db: Db, ob: typeof obligations.$inferSelect, outcome: PolicyOutcome, approvalsCount: number, acknowledged: string[] | undefined): PolicyOutcome {
  const outside = /^(mcp|api):/.test(originOf(db, ob.id));
  if (!ob.billId) {
    const matching = outside && ob.vendorId && ob.sourceRef ? billsMatching(db, ob.vendorId, ob.sourceRef) : [];
    if (!matching.length) return outcome;
    // Not on a bill but naming one or more: several are for a person to choose between; one (not yet linked, as
    // when a bill matches only after it was recorded) still waits for a person.
    const why = matching.length > 1
      ? `Reference ${ob.sourceRef} matches ${matching.length} bills of this supplier (${matching.map((b) => b.reference).join(", ")}); a person records which one this pays`
      : `Reference ${ob.sourceRef} matches bill ${matching[0].reference}; a person reviews payments against bills`;
    const rule: PolicyRuleResult = { ruleId: matching.length > 1 ? "bill_ambiguous" : "bill_review", passed: false, severity: matching.length > 1 ? "block" : "warn", message: why, key: matching.map((b) => b.id).sort().join(",") };
    return needsPerson(outcome, rule, approvalsCount, acknowledged, []);
  }
  const found = db.select().from(bills).where(eq(bills.id, ob.billId)).get();
  if (!found) return outcome;
  const bill = found;
  const others = db
    .select({ id: obligations.id, amountMinor: obligations.amountMinor, currency: obligations.currency, state: obligations.state, createdAt: obligations.createdAt, updatedAt: obligations.updatedAt })
    .from(obligations)
    .where(and(eq(obligations.billId, ob.billId), ne(obligations.id, ob.id)))
    .all()
    .filter((p) => p.state !== "cancelled" && p.state !== "refunded")
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
  const money = (p: { amountMinor: number | null; currency: string | null }) => (p.amountMinor != null ? fmt(p.amountMinor, p.currency ?? bill.currency) : "an amount");
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const position = others.filter((p) => p.createdAt < ob.createdAt || (p.createdAt === ob.createdAt && p.id < ob.id)).length + 1;
  const partLine = `Part ${position} of bill ${bill.reference}; other parts: ${others.length ? others.map((p) => `${money(p)}, ${p.state.replace(/_/g, " ")} ${day(p.updatedAt)}`).join("; ") : "none"}`;
  const partRule: PolicyRuleResult = { ruleId: "bill_part", passed: true, severity: "info", message: partLine };

  if (!outside) {
    // A person's part: the note, and otherwise as before.
    const rules = [...outcome.rules, partRule];
    const reasons = outcome.decision === "auto_execute" ? [...outcome.reasons] : [...outcome.reasons, partLine];
    if (!others.length) return { ...outcome, rules, reasons };
    const why = `Bill ${bill.reference} already has another part (${money(others[0])}). A person confirms this is a separate payment.`;
    rules.push({ ruleId: "bill_part_repeat", passed: false, severity: "info", message: why });
    return { ...outcome, rules, reasons: outcome.decision === "auto_execute" ? reasons : [...reasons, why] };
  }

  // What is open for an outside caller's request: the total less credits and the other parts a person approved, or
  // that are in flight, paid or disputed. Unapproved requests do not count, so one caller cannot crowd out another.
  // Known and left as is (review R9-N3): policy's own bill check (amount_matches_evidence in policy.ts) still counts
  // parts awaiting approval, so unapproved requests can make a fitting one show as blocked to the person until they
  // are cancelled. The outside caller's answer is the same either way.
  const counts = (p: (typeof others)[number]) => ["execution_pending", "sent", "settled", "disputed"].includes(p.state) || (p.state === "approved" && approvedByPerson(db, p.id));
  const committed = others.filter((p) => counts(p) && p.currency === bill.currency).reduce((sum, p) => sum + (p.amountMinor ?? 0), 0);
  const open = bill.totalMinor - billBalance(db, bill.id, ob.id).creditedMinor - committed;
  const misfit =
    bill.kind === "credit_note" ? `${bill.reference} is a credit note; it is set against invoices, not paid`
    : bill.status !== "open" ? `Bill ${bill.reference} is ${bill.status}; nothing more is paid on it without a person recording it`
    : bill.currency !== ob.currency ? `Bill ${bill.reference} is in ${bill.currency}, this payment is in ${ob.currency}`
    : (ob.amountMinor ?? 0) > open ? `Requested ${fmt(ob.amountMinor ?? 0, ob.currency ?? bill.currency)} but only ${fmt(Math.max(0, open), bill.currency)} is open on ${bill.reference} after credits and the parts a person approved`
    : null;
  // The fingerprint names the other parts, so an approval given before a new part arrived does not cover it.
  const key = `${bill.id}:${others.map((p) => p.id).sort().join(",")}`;
  const rule: PolicyRuleResult = misfit
    ? { ruleId: "bill_misfit", passed: false, severity: "block", message: misfit, key }
    : { ruleId: "bill_review", passed: false, severity: "warn", message: `Request on bill ${bill.reference}: ${fmt(ob.amountMinor ?? 0, bill.currency)} of ${fmt(Math.max(0, open), bill.currency)} open. A person reviews payments against bills.`, key };
  return needsPerson(outcome, rule, approvalsCount, acknowledged, [partRule]);
}

/** Add a rule that needs a person: a block blocks; a warning needs an approval that saw it. */
function needsPerson(outcome: PolicyOutcome, rule: PolicyRuleResult, approvalsCount: number, acknowledged: string[] | undefined, extra: PolicyRuleResult[]): PolicyOutcome {
  const rules = [...outcome.rules, ...extra, rule];
  const lines = [rule.message, ...extra.map((r) => r.message)];
  const rest = outcome.reasons.filter((r) => !lines.includes(r));
  if (rule.severity === "block") return { ...outcome, decision: "block", rules, reasons: [rule.message, ...rest, ...extra.map((r) => r.message)] };
  if (outcome.decision === "block" || outcome.decision === "hold") return { ...outcome, rules, reasons: [...rest, ...lines] };
  if (approvalsCount < 1) return { ...outcome, decision: "require_approval", rules, reasons: [...lines, ...(outcome.decision === "auto_execute" ? [] : rest)] };
  if (!acknowledged || !fingerprintCovered(new Set(acknowledged), warningFingerprint(rule))) {
    return { ...outcome, decision: "require_approval", rules, reasons: [`New since approval: ${rule.message}`, ...extra.map((r) => r.message)], unacknowledged: [...(outcome.unacknowledged ?? []), warningFingerprint(rule)] };
  }
  return { ...outcome, rules, reasons: outcome.decision === "auto_execute" ? outcome.reasons : [...rest, ...lines] };
}

/**
 * After a bill is recorded: outside callers' requests of that vendor that name it (compared as the duplicate check
 * compares references) and no other bill, are not paid yet and are on no bill, are put on it and checked again, in the
 * order they came in (API reviews R7-S4, R8-S2). A drafted or verified one goes through the normal processing step.
 * Nothing is approved or sent by this. Returns how many.
 */
export async function linkWaitingToBill(db: Db, billId: string, actor: string): Promise<number> {
  const bill = db.select().from(bills).where(eq(bills.id, billId)).get();
  if (!bill) return 0;
  const waiting = db.select().from(obligations).where(and(eq(obligations.vendorId, bill.vendorId), isNull(obligations.billId), inArray(obligations.state, ["drafted", "needs_evidence", "verified", "blocked", "awaiting_approval", "approved"]))).all()
    .filter((o) => /^(mcp|api):/.test(originOf(db, o.id)))
    // Only a request that names this bill and no other: one that matches several stays off all of them, for a person
    // to choose (R8).
    .filter((o) => {
      const m = billsMatching(db, bill.vendorId, o.sourceRef);
      return m.length === 1 && m[0].id === bill.id;
    })
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
  for (const o of waiting) {
    db.update(obligations).set({ billId, paymentKind: "part", updatedAt: now() }).where(eq(obligations.id, o.id)).run();
    audit(db, { obligationId: o.id, actor, action: "bill.linked", detail: { billId, kind: "part", after: "bill recorded" } });
    if (o.state === "approved") {
      const outcome = runPolicy(db, o.id);
      if (outcome.decision !== "auto_execute") {
        db.update(obligations).set({ releaseAt: null }).where(eq(obligations.id, o.id)).run();
        moveTo(db, o.id, targetState(outcome, "approved"), outcome);
      }
    } else if (["blocked", "needs_evidence", "awaiting_approval"].includes(o.state)) await recheckObligation(db, o.id, actor);
    else await processObligation(db, o.id);
  }
  return waiting.length;
}

/**
 * When the agent reads a deposit ("50% deposit USD 425 now, balance on arrival") against a known invoice total,
 * record the invoice as a bill and link this payment to it as the deposit; a later "pay the balance" links to the
 * same bill. The agent only files the record: policy then checks the payment against what is open on it.
 */
function linkToBill(db: Db, obligationId: string, ai: AiInterpretation, ev: EvidenceItem[]): string | null {
  const ob = mustGet(db, obligationId);
  if (ob.billId || !ob.vendorId || !ob.currency || !ob.amountMinor || !ob.sourceRef) return null;
  // Who asked for this payment in the first place: for one asked again after it came back, the original asker, so a
  // person's "pay again" carries an outside caller's records at their original weight (API review R3-S2).
  const outside = /^(mcp|api):/.test(originOf(db, obligationId));
  // Bills this vendor has under the same reference once compared like the duplicate check does: any kind, any state,
  // however the reference is spelt (API review R7-M1, S1).
  const matching = billsMatching(db, ob.vendorId, ob.sourceRef);
  // Any payment naming a bill this vendor already has is a payment against it, whatever the request calls itself. A
  // person's request is matched as it always was; an outside caller's by the compared reference, and only when exactly
  // one bill matches (several are blocked in withBillParts for a person to sort out).
  const existing = outside ? (matching.length === 1 ? matching[0] : null) : findBill(db, ob.vendorId, ob.sourceRef);
  let billId = existing && existing.status !== "void" ? existing.id : null;
  // A request from an outside agent (mcp:) or an integration (api:) that names a bill of this vendor stays on that bill,
  // whatever state the bill is in and whether or not it fits; it then always waits for a person, who sees whether it
  // fits (withBillParts). It is never checked as if no bill existed (API review R6-1). It is a deposit when the reader
  // says so and otherwise an ordinary part: it is never treated as the balance (API review R8).
  let outsideKind: string | null = null;
  if (existing && outside) {
    billId = existing.id;
    outsideKind = ai.paymentPart?.kind === "deposit" ? "deposit" : "part";
  }
  let created: string | null = null;
  // No new bill is recorded while one of this vendor already has the same reference, however spelt (R7-M1).
  if (!billId && !existing && matching.length === 0 && ai.paymentPart?.kind === "deposit") {
    // Which records may set a bill total is decided by where they came from (API review R3-S1). A supplier's own record
    // (a vendor link upload) never does, whoever asked. For a request from an outside agent or an integration, only the
    // business's own records (provenance "system", an attest key) do: its typing, its PDF and anything a person added
    // to it are not the business's record of the invoice (agent guard review AG-5, API reviews R1-2, R2-M1). For a
    // request from a person, what a person typed or uploaded still does.
    const mayTotal = (e: EvidenceItem) => e.provenance !== "vendor" && (!outside || e.provenance === "system");
    const evidenced = ev.find((e) => e.reference?.toUpperCase() === ob.sourceRef && e.currency === ob.currency && (e.amountMinor ?? 0) > ob.amountMinor! && mayTotal(e));
    // The bill's total becomes the ceiling for every later payment against it, so it comes from a record the business
    // holds (evidence naming this reference), never from the reader's number alone. A reader total that disagrees with
    // the record creates no bill; the deposit is then checked like any other payment.
    const total = evidenced?.amountMinor ?? null;
    if (!total || total <= ob.amountMinor) return null;
    if (ai.paymentPart.ofTotalMinor && ai.paymentPart.ofTotalMinor !== total) return null;
    billId = createBill(db, ob.businessId, "agent", ob.vendorId, { kind: "invoice", reference: ob.sourceRef, totalMinor: total, currency: ob.currency, billDate: ob.invoiceDate, dueDate: ob.dueDate, note: `Recorded from a deposit request (${obligationId})` });
    created = billId;
  }
  if (!billId) return null;
  const kind = outsideKind ?? ai.paymentPart?.kind ?? "part";
  db.update(obligations).set({ billId, paymentKind: kind, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor: "ai:bills", action: "bill.linked", detail: { billId, kind } });
  return created;
}

function billInput(db: Db, ob: typeof obligations.$inferSelect) {
  if (!ob.billId) return null;
  const b = db.select().from(bills).where(eq(bills.id, ob.billId)).get();
  if (!b) return null;
  const bal = billBalance(db, b.id, ob.id);
  return { id: b.id, vendorId: b.vendorId, reference: b.reference, kind: b.kind, status: b.status, totalMinor: b.totalMinor, currency: b.currency, coveredMinor: bal.paidMinor + bal.pendingMinor + bal.creditedMinor };
}

async function quoteAndRoute(db: Db, obligationId: string, vendor: VendorPayoutProfile, amountMinor: number, currency: string, businessCountry: string): Promise<void> {
  const rails = getRails();
  const quotes = await Promise.all(RAILS.map((r) => rails[r].quote({ vendor, amountMinor, currency, businessCountry })));
  db.delete(routeQuotes).where(eq(routeQuotes.obligationId, obligationId)).run();
  const ts = now();
  for (const q of quotes) {
    db.insert(routeQuotes)
      .values({ id: newId("rq"), obligationId, rail: q.rail, available: q.available, unavailableReason: q.unavailableReason ?? null, sendAmountMinor: q.sendAmountMinor, sendCurrency: q.sendCurrency, feeMinor: q.feeMinor, fxRate: q.fxRate, receiveAmountMinor: q.receiveAmountMinor, receiveCurrency: q.receiveCurrency, etaSeconds: q.etaSeconds, corridor: q.corridor, provider: q.provider, explanation: q.explanation, createdAt: ts })
      .run();
  }
  const decision = chooseRoute(vendor, businessCountry, quotes);
  db.update(obligations).set({ selectedRail: decision.rail, routeReason: decision.reason, updatedAt: ts }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor: "router", action: "route.selected", detail: { rail: decision.rail, reason: decision.reason, quotes: quotes.map((q) => ({ rail: q.rail, available: q.available, feeMinor: q.feeMinor, receiveAmountMinor: q.receiveAmountMinor, receiveCurrency: q.receiveCurrency, etaSeconds: q.etaSeconds })) } });
}

function targetState(outcome: PolicyOutcome, current: ObligationState): ObligationState {
  if (["execution_pending", "sent", "settled", "failed", "refunded", "disputed", "cancelled"].includes(current)) return current;
  switch (outcome.decision) {
    case "block":
      return "blocked";
    case "hold":
      return "needs_evidence";
    case "require_approval":
      return "awaiting_approval";
    case "auto_execute":
      return "approved";
  }
}

/**
 * Whether this person may approve this obligation, before any policy run: their role (or a delegation), their approval
 * limit, and separation of duties. Pages call it to explain a missing Approve button; approveObligation enforces it.
 */
export function approvalGate(db: Db, obligationId: string, actor: string): { refusal: string | null; selfApproval: boolean } {
  const ob = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const policy: ApprovalPolicy = { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
  // Limits are in the base currency; a foreign amount with no rate counts as above every limit but the owner's.
  const amount = ob.amountMinor != null && ob.currency ? (toBaseMinor(ob.amountMinor, ob.currency, biz.baseCurrency) ?? Number.MAX_SAFE_INTEGER) : 0;
  // An outside agent or an integration never approves anything, whatever path it reaches this by (API review R9-N2).
  if (/^(mcp|api):/.test(actor)) return { refusal: "An outside agent or integration cannot approve payments. A person does.", selfApproval: false };
  // A known person approving: they need the approve permission (their own or delegated) and a limit that covers it.
  if (actor.startsWith("user:")) {
    const row = db.select().from(users).where(and(eq(users.id, actor.slice(5)), eq(users.businessId, ob.businessId))).get();
    if (row && isRole(row.role)) {
      const who = resolveActor(db, ob.businessId, row.id, row.role);
      if (!actorCan(who, "approve")) return { refusal: `${whoIs(who)} cannot approve payments. An approver or the owner does.`, selfApproval: false };
      // Above the dual-approval amount the second signature is a check, not the authority: it may come from any
      // approver once someone whose limit covers the amount has approved. Two different people still sign.
      const secondSigner = policy.dualApprovalThresholdMinor > 0 && amount > policy.dualApprovalThresholdMinor && coveringApprovalBy(db, obligationId, ob.businessId, amount, humanOf(actor, currentLogin()));
      if (who.approvalLimitMinor !== null && amount > who.approvalLimitMinor && !secondSigner) {
        const higher = approversFor(db, ob.businessId, amount).filter((u) => u !== row.id);
        return { refusal: `${ob.currency && ob.currency !== biz.baseCurrency ? `${fmt(ob.amountMinor ?? 0, ob.currency)} (about ${fmt(amount, biz.baseCurrency)})` : fmt(amount, biz.baseCurrency)} is above ${who.displayName}'s approval limit of ${fmt(who.approvalLimitMinor, biz.baseCurrency)}; someone with a higher limit approves this one${higher.length ? ` (${higher.join(", ")} can)` : ""}${policy.dualApprovalThresholdMinor > 0 && amount > policy.dualApprovalThresholdMinor ? ", and then you can give the second approval" : ""}`, selfApproval: false };
      }
    }
  }
  // One approval per person: the page says so instead of offering a button that will refuse.
  const me = humanOf(actor, currentLogin());
  if (db.select({ actor: approvals.actor, login: approvals.login }).from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all().some((a) => a.actor === actor || humanOf(a.actor, a.login) === me))
    return { refusal: "You have already approved this; the next approval comes from a different person", selfApproval: false };
  // Separation of duties: whoever prepared the request (created it, or changed its amount, payee or reference)
  // cannot also approve it, when someone else can. A one-person business has nobody else to ask.
  const preparers = preparersOf(db, obligationId);
  const human = humanOf(actor, currentLogin());
  if (!preparers.includes(human)) return { refusal: null, selfApproval: false };
  const others = approversFor(db, ob.businessId, amount).filter((u) => !preparers.includes(u));
  const required = policy.requireSeparateApprover ?? others.length > 0;
  if (required) return { refusal: `You prepared this payment, so someone else approves it${others.length ? ` (${others.join(", ")} can)` : ""}`, selfApproval: false };
  return { refusal: null, selfApproval: true };
}

/** Whether a person other than `notHuman` has already approved this, within their own limit for `amount`. */
function coveringApprovalBy(db: Db, obligationId: string, businessId: string, amount: number, notHuman: string): boolean {
  const rows = db.select({ actor: approvals.actor, login: approvals.login }).from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all();
  return rows.some((a) => {
    if (humanOf(a.actor, a.login) === notHuman || !a.actor.startsWith("user:")) return false;
    const u = db.select().from(users).where(and(eq(users.id, a.actor.slice(5)), eq(users.businessId, businessId))).get();
    if (!u || !isRole(u.role)) return false;
    const p = resolveActor(db, businessId, u.id, u.role);
    return actorCan(p, "approve") && (p.approvalLimitMinor === null || p.approvalLimitMinor >= amount);
  });
}

export function approveObligation(db: Db, obligationId: string, actor: string, note?: string, shownFingerprints?: string[]): PolicyOutcome {
  const ob = mustGet(db, obligationId);
  if (!["awaiting_approval", "verified", "blocked"].includes(ob.state)) throw new Error(`Cannot approve a request that is ${stateWord(ob.state)}`);
  const gate = approvalGate(db, obligationId, actor);
  if (gate.refusal) throw new Error(gate.refusal);
  if (gate.selfApproval) audit(db, { obligationId, actor, action: "approval.self", detail: { reason: "no other approver can approve this amount" } });
  // One approval per person per version of the obligation.
  const human = humanOf(actor, currentLogin());
  const already = db.select({ actor: approvals.actor, login: approvals.login }).from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all().some((a) => a.actor === actor || humanOf(a.actor, a.login) === human);
  if (already) throw new Error("You have already approved this request; any further approval must come from a different person");
  // What the page showed: the last policy evaluation on record. Policy is then run fresh. If the fresh run has a
  // warning the page did not show (another payee billed this reference since the page was evaluated), the person
  // approved something they did not see: refuse, and the refreshed page shows the new warning.
  // The page sends the fingerprints it rendered; without them (tests, scripts) the last evaluation on record stands in.
  let shown: Set<string>;
  if (shownFingerprints) shown = new Set(shownFingerprints);
  else {
    const shownEntry = db.select({ detail: auditEntries.detailJson }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "policy.evaluated"))).orderBy(desc(auditEntries.seq)).get();
    shown = new Set(((shownEntry?.detail ? (JSON.parse(shownEntry.detail) as { rules?: PolicyRuleResult[] }).rules : []) ?? []).filter((r) => r.severity === "warn" && !r.passed).map(warningFingerprint));
  }
  const before = runPolicy(db, obligationId);
  const unseen = before.rules.filter((r) => r.severity === "warn" && !r.passed && !fingerprintCovered(shown, warningFingerprint(r)));
  if (unseen.length) {
    audit(db, { obligationId, actor, action: "approval.refused", detail: { reason: "warnings not shown when the person approved", unseen: unseen.map(warningFingerprint) } });
    throw new Error(`Something changed since this page was checked: ${unseen.map((r) => r.message).join("; ")}. Read it, then approve again.`);
  }
  // Approval does not bypass policy, so approving something that is blocked now records nothing but a misleading "approved
  // by": the page this came from is out of date (the amount, vendor or reference changed since it was shown). Refuse, move
  // the request to where policy puts it, and let the refreshed page say why.
  if (before.decision === "block") {
    moveTo(db, obligationId, targetState(before, ob.state as ObligationState), before);
    audit(db, { obligationId, actor, action: "approval.refused", detail: { reason: "blocked by policy at the moment of approval", reasons: before.reasons } });
    throw new Error(`This request changed since the page was loaded and is now blocked: ${before.reasons[0] ?? "see the request"}. No approval was recorded.`);
  }
  const acknowledged = before.rules.filter((r) => r.severity === "warn" && !r.passed).map(warningFingerprint);
  db.insert(approvals).values({ id: newId("apr"), obligationId, actor, decision: "approved", note: note ?? null, acknowledgedJson: JSON.stringify(acknowledged), login: currentLogin(), createdAt: now() }).run();
  audit(db, { obligationId, actor, action: "approval.granted", detail: { note: note ?? null, acknowledged } });
  // Approval does not bypass policy: a blocked obligation stays blocked until the input is fixed.
  const outcome = runPolicy(db, obligationId);
  moveTo(db, obligationId, targetState(outcome, ob.state as ObligationState), outcome);
  return outcome;
}

export function rejectObligation(db: Db, obligationId: string, actor: string, note?: string): void {
  // A bill already in the books for a closed month stays: reversing it is the accountant's entry, not a cancel here.
  const before = mustGet(db, obligationId);
  if (before.xeroBillExportedAt) assertOpenPeriod(db, before.businessId, before.createdAt, "a bill already sent to the books");
  // Transition first and in one transaction with the row: an illegal cancel leaves no stray rejection behind.
  db.transaction((tx) => {
    transition(tx as unknown as Db, obligationId, "cancelled", actor, "approval.rejected", { note: note ?? null });
    tx.insert(approvals).values({ id: newId("apr"), obligationId, actor, decision: "rejected", note: note ?? null, createdAt: now() }).run();
  });
  // An advance exists only as the money handed over. Cancelled before anything went out, it leaves no open advance behind.
  if (before.billId && before.paymentKind === "advance") {
    const b = db.select().from(bills).where(eq(bills.id, before.billId)).get();
    const bal = b ? billBalance(db, b.id) : null;
    if (b && b.status === "open" && bal && bal.paidMinor + bal.pendingMinor + bal.creditedMinor === 0) {
      db.update(bills).set({ status: "void" }).where(eq(bills.id, b.id)).run();
      audit(db, { obligationId, actor, action: "bill.voided", detail: { billId: b.id, reason: "advance cancelled before payment" } });
    }
  }
}

export interface AmendPatch {
  amountMinor?: number;
  currency?: string;
  sourceRef?: string;
  vendorId?: string;
}

/**
 * Validate an amend patch at runtime. Server actions receive whatever the client
 * sends, so the TypeScript type is not a defence: unknown keys are rejected rather
 * than ignored, because the patch is written straight to the obligation row.
 */
export function validateAmendPatch(db: Db, businessId: string, patch: unknown): AmendPatch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("Amendment must be an object");
  const allowed = ["amountMinor", "currency", "sourceRef", "vendorId"];
  const keys = Object.keys(patch);
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`Amendment may not change: ${extra.join(", ")}`);
  const p = patch as Record<string, unknown>;
  const out: AmendPatch = {};
  if (p.amountMinor !== undefined) {
    if (!isValidAmountMinor(p.amountMinor)) throw new Error("amountMinor must be a positive whole number of cents within the allowed range");
    out.amountMinor = p.amountMinor;
  }
  if (p.currency !== undefined) {
    if (typeof p.currency !== "string" || !SUPPORTED_CURRENCIES.includes(p.currency)) throw new Error(`currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
    out.currency = p.currency;
  }
  if (p.sourceRef !== undefined) {
    if (!isValidSourceRef(p.sourceRef)) throw new Error("sourceRef must be 1 to 64 characters: letters, digits and . _ / # : -");
    out.sourceRef = p.sourceRef.toUpperCase();
  }
  if (p.vendorId !== undefined) {
    if (typeof p.vendorId !== "string") throw new Error("vendorId must be a string");
    const v = db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, p.vendorId), eq(vendors.businessId, businessId))).get();
    if (!v) throw new Error("vendorId is not a vendor of this business");
    out.vendorId = p.vendorId;
  }
  if (Object.keys(out).length === 0) throw new Error("Amendment is empty");
  return out;
}

/** Correct an obligation's amount or reference after human review, then re-run the pipeline from policy. */
export async function amendObligation(db: Db, obligationId: string, actor: string, rawPatch: AmendPatch, note?: string): Promise<void> {
  const ob = mustGet(db, obligationId);
  if (!["blocked", "needs_evidence", "awaiting_approval", "approved", "verified", "drafted"].includes(ob.state)) throw new Error(`Cannot change a request that is ${stateWord(ob.state)}`);
  assertOpenPeriod(db, ob.businessId, ob.createdAt, "a payment");
  const patch = validateAmendPatch(db, ob.businessId, rawPatch);
  // Changing the payee of an obligation that already has one is not a correction, it is a different payment.
  if (patch.vendorId && ob.vendorId && patch.vendorId !== ob.vendorId) throw new Error("This payment already has a payee; cancel it and create a new request for the other vendor");
  // The human's values are now authoritative; drop agent flags about the field that was corrected.
  // Approvals given before the correction were for different numbers; they no longer count.
  db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).run();
  // A requester's own comparison of its fields with its words is about fields a person has now set (AG3-5).
  const changed = new Set<string>((["amountMinor", "currency", "sourceRef", "vendorId"] as const).filter((k) => patch[k] != null && patch[k] !== ob[k]));
  // Only the rules reader's own sentences are moot after a correction; a live reader's concerns stay (AG4-5).
  const byRules = db.select({ actor: auditEntries.actor }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "ai.interpreted"))).orderBy(desc(auditEntries.seq)).get()?.actor === "ai:rules";
  const flags = (JSON.parse(ob.aiFlagsJson ?? "[]") as string[]).filter((f) => !(byRules && changed.has("amountMinor") && /^Requested amount differs from /.test(f)) && !(byRules && changed.has("sourceRef") && /^Reference \S+ does not (match|appear)/.test(f)) && !agentFlagFields(f).some((k) => changed.has(k)));
  db.update(obligations).set({ ...patch, aiFlagsJson: JSON.stringify(flags), updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor, action: "obligation.amended", detail: { patch, note: note ?? null, previous: { amountMinor: ob.amountMinor, currency: ob.currency, sourceRef: ob.sourceRef, vendorId: ob.vendorId } } });
  if (ob.state === "blocked") transition(db, obligationId, "verified", actor, "review.resolved", { note: note ?? null });
  const outcome = runPolicy(db, obligationId);
  const fresh = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, fresh.businessId)).get()!;
  const vendorRow = fresh.vendorId ? db.select().from(vendors).where(eq(vendors.id, fresh.vendorId)).get() : null;
  if (vendorRow && fresh.amountMinor && fresh.currency) await quoteAndRoute(db, obligationId, toProfile(vendorRow), payableMinor(fresh), fresh.currency, biz.country);
  moveTo(db, obligationId, targetState(outcome, fresh.state as ObligationState), outcome);
}

export interface ExecuteOptions {
  actor: string;
  /** Override the router's choice (operator picked the other rail in the UI). Must be an available quote. */
  rail?: Rail;
}

/** Attempt statuses that mean money may have moved, or may still move. Only "failed" is safe to pay again after. */
const OPEN_ATTEMPT = ["pending", "unknown", "submitted", "confirmed"];

/**
 * Execute an approved obligation. Re-runs policy first: if anything changed
 * since approval (a duplicate appeared, details changed) it refuses.
 *
 * Double-pay protection, in layers:
 *  - The state check, the attempt insert and the move to execution_pending happen in one
 *    immediate transaction, and the move is a compare-and-swap, so two callers cannot both start.
 *  - If any earlier attempt is not definitively failed, this refuses: that payment must be
 *    reconciled (see retryAmbiguousExecution), never paid again under a new key.
 *  - An ambiguous rail outcome (timeout, 5xx, exception) leaves the obligation in
 *    execution_pending with an "unknown" attempt instead of failing it.
 */
export async function executeObligation(db: Db, obligationId: string, opts: ExecuteOptions): Promise<{ attemptId: string; status: string }> {
  let ob = mustGet(db, obligationId);
  if (ob.state !== "approved") throw new Error(`The request must be approved before it is paid (it is ${stateWord(ob.state)})`);

  // PayPal's own history is read again at the moment of payment: a payout made outside Checkrail since approval counts.
  await refreshPayPalHistory(db, obligationId);
  const outcome = runPolicy(db, obligationId);
  if (outcome.decision !== "auto_execute") {
    const target = targetState(outcome, "approved");
    transition(db, obligationId, target === "approved" ? "blocked" : target, "policy", "execution.refused", { reasons: outcome.reasons });
    throw new Error(`Execution refused by policy: ${outcome.reasons.join("; ")}`);
  }

  // Quotes from more than six hours ago (or before a rail was set up) are refreshed before the router's choice is used.
  // And always when the quote was for a different amount than will be sent (tax withheld since, a short pay), so the
  // fee and what the vendor receives are recorded for the amount that actually goes.
  const quoted = db.select({ send: routeQuotes.sendAmountMinor }).from(routeQuotes).where(and(eq(routeQuotes.obligationId, obligationId), eq(routeQuotes.rail, opts.rail ?? ob.selectedRail ?? ""))).get();
  if (quoted && quoted.send !== payableMinor(mustGet(db, obligationId))) await refreshQuotesIfStale(db, obligationId, 0);
  else if (!opts.rail) await refreshQuotesIfStale(db, obligationId, 6 * 3600_000);
  // Policy just recomputed the tax kept back: what is sent below is the obligation as it stands now.
  ob = mustGet(db, obligationId);
  const vendorRow = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : undefined;
  if (!vendorRow) throw new Error("The request has no vendor");
  refuseIfPayoutChanged(db, ob, vendorRow);

  const rail = opts.rail ?? (ob.selectedRail as Rail | null);
  if (!rail) throw new Error("No payment route is available for this request");
  if (!RAILS.includes(rail)) throw new Error(`Unknown rail ${String(rail)}`);
  const quote = db.select().from(routeQuotes).where(and(eq(routeQuotes.obligationId, obligationId), eq(routeQuotes.rail, rail))).get();
  if (!quote?.available) throw new Error(`${rail} is not an available route for this request`);

  const vendor = toProfile(vendorRow);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const adapter = getRails()[rail];
  // The recipient sees the memo. Use the reference only when an attached record carries it too, so text the agent or
  // a document made up cannot be sent to the payee; otherwise the obligation id. Memo is `ref + space + 8 key chars`, 28 max.
  const boundRef = ob.sourceRef && listEvidence(db, obligationId).some((e) => e.reference && e.reference.toUpperCase() === ob.sourceRef!.toUpperCase()) ? ob.sourceRef : null;
  const refPart = safeRefForMemo(boundRef ?? obligationId).slice(0, 19);

  // Start: state check + attempt row + CAS transition, atomically.
  const started = db.transaction(
    (tx) => {
      const cur = tx.select({ state: obligations.state, payoutHash: obligations.payoutHash }).from(obligations).where(eq(obligations.id, obligationId)).get();
      if (cur?.state !== "approved") throw new Error(`The request must be approved before it is paid (it is ${stateWord(cur?.state)})`);
      // Re-check the destination inside the lock: an edit between the check above and this point must not slip through.
      const vendorNow = tx.select().from(vendors).where(eq(vendors.id, vendorRow.id)).get();
      if (!vendorNow || !cur.payoutHash || payoutHashOf(vendorNow) !== cur.payoutHash) throw new Error("Execution refused: vendor payout details changed at the moment of release");
      const attempts = tx.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).all();
      const open = attempts.filter((a) => OPEN_ATTEMPT.includes(a.status));
      if (open.length > 0) {
        throw new Error(`This request already has a payment attempt that has not definitely failed (${open.map((a) => `${a.id}:${a.status}`).join(", ")}); reconcile it instead of paying again`);
      }
      // Every remaining attempt definitively failed (nothing moved), so a fresh key cannot double-pay.
      const key = idempotencyKey(obligationId, attempts.length + 1);
      const attemptId = newId("pay");
      const ts = now();
      const fullMemo = `${refPart} ${key.slice(0, 8)}`.slice(0, 28);
      tx.insert(paymentAttempts).values({ id: attemptId, obligationId, rail, idempotencyKey: key, status: "pending", mode: adapter.mode, requestJson: JSON.stringify({ amountMinor: payableMinor(ob), currency: ob.currency, memo: fullMemo, vendorId: vendor.id, withheldMinor: ob.withheldMinor ?? 0 }), createdAt: ts, updatedAt: ts }).run();
      if (opts.rail && opts.rail !== ob.selectedRail) {
        tx.update(obligations).set({ selectedRail: opts.rail, routeReason: `Operator override by ${opts.actor}`, updatedAt: ts }).where(eq(obligations.id, obligationId)).run();
        audit(tx as unknown as Db, { obligationId, actor: opts.actor, action: "route.overridden", detail: { from: ob.selectedRail, to: opts.rail } });
      }
      // Whoever starts this payment, any autopilot release scheduled for it is spent. A later retry must not inherit it.
      tx.update(obligations).set({ releaseAt: null }).where(eq(obligations.id, obligationId)).run();
      transition(tx as unknown as Db, obligationId, "execution_pending", opts.actor, "execution.started", { attemptId, rail, mode: adapter.mode, idempotencyKey: key });
      return { attemptId, key, memo: fullMemo };
    },
    { behavior: "immediate" }
  );

  const result = await callRail(db, adapter, started.attemptId, { obligationId, idempotencyKey: started.key, vendor, amountMinor: payableMinor(ob), currency: ob.currency!, memo: started.memo, businessCountry: biz.country, businessId: ob.businessId, ...bankAccountFor(rail, vendorRow) });
  return finishAttempt(db, obligationId, started.attemptId, rail, adapter.mode, result);
}

/** Refuse (and pull the obligation back to blocked) if the payout destination differs from what was verified and approved. */
function refuseIfPayoutChanged(db: Db, ob: typeof obligations.$inferSelect, vendorRow: typeof vendors.$inferSelect): void {
  const current = payoutHashOf(vendorRow);
  const reasons: string[] = [];
  if (current !== vendorRow.detailsHash) reasons.push("Vendor payout details were edited without re-verification");
  if (!ob.payoutHash) reasons.push("No payout destination was recorded when this request was approved; approve it again");
  else if (ob.payoutHash !== current) reasons.push("The vendor's payout details changed after this request was approved");
  if (reasons.length === 0) return;
  // Approvals were for a different destination; they no longer count.
  db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, ob.id), eq(approvals.decision, "approved"))).run();
  transition(db, ob.id, "blocked", "policy", "execution.refused", { reasons });
  throw new Error(`Execution refused: ${reasons.join("; ")}`);
}

const SECRET_KEY = /secret|token|authorization|password|private|api[-_]?key/i;
/** Defence in depth: never persist anything that looks like a credential, whatever a provider echoes back. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]));
}

/** What the rail sends: the amount owed less tax withheld for the tax office. */
export function payableMinor(ob: { amountMinor: number | null; withheldMinor?: number | null }): number {
  return (ob.amountMinor ?? 0) - (ob.withheldMinor ?? 0);
}

/** The full account number, decrypted only for a bank rail and only for this request. */
function bankAccountFor(rail: Rail, v: typeof vendors.$inferSelect): { bankAccountNumber?: string } {
  if ((rail !== "wise" && rail !== "bank_file") || !v.bankAccountEnc) return {};
  return { bankAccountNumber: decryptField(v.bankAccountEnc) };
}

/** Call the rail. A thrown exception is an unknown outcome, never a failure. */
async function callRail(db: Db, adapter: { execute(req: import("../domain/types").ExecutionRequest): Promise<ExecutionResult> }, attemptId: string, req: Omit<import("../domain/types").ExecutionRequest, "beforeSubmit">): Promise<ExecutionResult> {
  try {
    return await adapter.execute({
      ...req,
      beforeSubmit: (info) => {
        db.update(paymentAttempts).set({ externalId: info.externalId, externalStatus: "prepared", updatedAt: now() }).where(eq(paymentAttempts.id, attemptId)).run();
      },
    });
  } catch (e) {
    return { status: "unknown", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: null, errorMessage: `Rail threw before reporting an outcome: ${(e as Error).message}` };
  }
}

function finishAttempt(db: Db, obligationId: string, attemptId: string, rail: Rail, mode: string, result: ExecutionResult): { attemptId: string; status: string } {
  const prev = db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).get();
  db.update(paymentAttempts)
    .set({ status: result.status, externalId: result.externalId ?? prev?.externalId ?? null, externalStatus: result.externalStatus ?? prev?.externalStatus ?? null, responseJson: JSON.stringify(redact(result.raw ?? null)), errorMessage: result.errorMessage ?? null, updatedAt: now() })
    .where(eq(paymentAttempts.id, attemptId))
    .run();

  if (result.status === "failed") {
    transition(db, obligationId, "failed", `rail:${rail}`, "execution.failed", { attemptId, error: result.errorMessage });
    return { attemptId, status: "failed" };
  }
  if (result.status === "unknown") {
    // Stay in execution_pending. The obligation cannot be re-approved or re-executed until a human or
    // retryAmbiguousExecution() resolves this attempt.
    audit(db, { obligationId, actor: `rail:${rail}`, action: "execution.unknown", detail: { attemptId, error: result.errorMessage, externalId: result.externalId ?? prev?.externalId ?? null, mode } });
    return { attemptId, status: "unknown" };
  }
  transition(db, obligationId, "sent", `rail:${rail}`, "execution.submitted", { attemptId, externalId: result.externalId, externalStatus: result.externalStatus, explorerUrl: result.explorerUrl ?? null });
  if (result.status === "confirmed") {
    recordSettlement(db, obligationId, attemptId, rail, result.externalId!, result.feeMinor, result.receivedMinor, result.receivedCurrency, result.fxRate, result.explorerUrl ?? null, result.note ?? null);
  }
  return { attemptId, status: result.status };
}

/**
 * Resolve an attempt whose outcome was unknown (obligation is in execution_pending).
 * First asks the rail about any provider-side id already recorded (Stellar tx hash).
 * Otherwise replays the SAME request with the SAME idempotency key, which PayPal answers
 * with the original batch and the Stellar adapter answers by finding the earlier payment.
 * Never mints a new key. Refuses if the vendor's payout details changed in the meantime.
 */
export async function retryAmbiguousExecution(db: Db, obligationId: string, opts: { actor: string }): Promise<{ attemptId: string; status: string }> {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "execution_pending") throw new Error(`The request is not waiting for reconciliation (it is ${stateWord(ob.state)})`);
  const attempt = db.select().from(paymentAttempts).where(and(eq(paymentAttempts.obligationId, obligationId))).orderBy(desc(paymentAttempts.createdAt)).all().find((a) => a.status === "unknown" || a.status === "pending");
  if (!attempt) throw new Error("No unresolved payment attempt found");
  const rail = attempt.rail as Rail;
  const adapter = getRails()[rail];
  const vendorRow = db.select().from(vendors).where(eq(vendors.id, ob.vendorId!)).get();
  if (!vendorRow) throw new Error("The request has no vendor");
  if (!ob.payoutHash || ob.payoutHash !== payoutHashOf(vendorRow)) throw new Error("Vendor payout details changed since approval; resolve this attempt by hand in the provider dashboard");
  audit(db, { obligationId, actor: opts.actor, action: "execution.reconcile", detail: { attemptId: attempt.id, rail, key: attempt.idempotencyKey } });

  if (attempt.externalId) {
    const st = await adapter.getStatus(attempt.externalId);
    if (st.status === "confirmed") {
      db.update(paymentAttempts).set({ status: "submitted", externalStatus: st.externalStatus, updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
      transition(db, obligationId, "sent", `rail:${rail}`, "execution.resolved", { attemptId: attempt.id, externalId: attempt.externalId });
      settleFromRail(db, ob, attempt.id, rail, attempt.externalId, adapter.mode, st);
      return { attemptId: attempt.id, status: "confirmed" };
    }
  }
  // Ask the provider whether it already knows this key. PayPal answers with the original batch when it does.
  if (!attempt.externalId && adapter.findByIdempotencyKey) {
    const found = await adapter.findByIdempotencyKey(attempt.idempotencyKey);
    if (found) {
      db.update(paymentAttempts).set({ status: "submitted", externalId: found.batchId, externalStatus: found.batchStatus, updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
      transition(db, obligationId, "sent", `rail:${rail}`, "execution.resolved", { attemptId: attempt.id, externalId: found.batchId, how: "found by idempotency key" });
      const st = await adapter.getStatus(found.batchId);
      settleFromRail(db, ob, attempt.id, rail, found.batchId, adapter.mode, st);
      return { attemptId: attempt.id, status: st.status === "confirmed" ? "confirmed" : "submitted" };
    }
  }
  const req = JSON.parse(attempt.requestJson ?? "{}") as { memo?: string; amountMinor?: number };
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const result = await callRail(db, adapter, attempt.id, { obligationId, idempotencyKey: attempt.idempotencyKey, vendor: toProfile(vendorRow), amountMinor: req.amountMinor ?? payableMinor(ob), currency: ob.currency!, memo: req.memo ?? "", businessCountry: biz.country, businessId: ob.businessId, ...bankAccountFor(attempt.rail as Rail, vendorRow) });
  if (result.status === "failed" && adapter.mode !== "mock") {
    // A rejected replay proves nothing about the first submission. Only a provider lookup that finds no batch does,
    // and that happened above (or the rail has no lookup). Keep the attempt unknown and leave it for a person.
    const still: ExecutionResult = { ...result, status: "unknown", errorMessage: `Replay was rejected (${result.errorMessage ?? "no detail"}); the first submission is unconfirmed. Check the provider dashboard for key ${attempt.idempotencyKey.slice(0, 8)}.` };
    return finishAttempt(db, obligationId, attempt.id, rail, adapter.mode, still);
  }
  return finishAttempt(db, obligationId, attempt.id, rail, adapter.mode, result);
}

/**
 * Last resort for a payment stuck in execution_pending: a person has checked the provider dashboard.
 *  - found: they found the payout; record its id and poll it like any submitted payment.
 *  - nothing_moved: they confirmed no payout exists for this attempt; mark it failed so it can be retried.
 * Audited with the person's name and what they saw. Never mints a key or calls the rail to pay.
 */
export async function resolveManually(db: Db, obligationId: string, actor: string, resolution: { kind: "found"; externalId: string } | { kind: "nothing_moved"; note?: string }): Promise<ObligationState> {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "execution_pending") throw new Error(`Only a payment with an unclear outcome can be resolved by hand (state: ${ob.state})`);
  if (!actor.startsWith("user:")) throw new Error("Only a person can resolve a payment by hand");
  const attempt = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).orderBy(desc(paymentAttempts.createdAt)).all().find((a) => a.status === "unknown" || a.status === "pending");
  if (!attempt) throw new Error("No unresolved payment attempt found");
  if (resolution.kind === "found") {
    const id = resolution.externalId.trim();
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new Error("That does not look like a payout or transaction id");
    const taken = db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.externalId, id)).all().filter((a) => a.id !== attempt.id);
    if (taken.length) throw new Error("That id already belongs to another payment in Checkrail Pay; check you copied the right one");
    const adapter = getRails()[attempt.rail as Rail];
    if (adapter.externalIdMatchesKey) {
      const ok = await adapter.externalIdMatchesKey(id, attempt.idempotencyKey);
      if (ok === false) throw new Error(`That batch was not created by this attempt (its sender_batch_id is not ${attempt.idempotencyKey}); nothing was changed`);
      if (ok === null) throw new Error("Could not confirm that id with the provider just now; try again in a minute. Nothing was changed");
    }
    db.update(paymentAttempts).set({ status: "submitted", externalId: id, externalStatus: "found by hand", updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
    transition(db, obligationId, "sent", actor, "execution.resolved_by_hand", { attemptId: attempt.id, externalId: id });
    try {
      return await confirmSettlement(db, obligationId, "manual-resolution");
    } catch {
      return "sent";
    }
  }
  // "Nothing moved" is the one claim that frees the payment to be paid again under a new key, so where the rail can be
  // asked it is checked, not taken on a person's word alone: a payout the provider already knows means the money may
  // have moved, and the person records it as found instead. A rail that cannot be read right now blocks the claim too.
  // The strict lookup where a rail has one (PayPal's plain lookup reads an outage as "nothing found", which is right for a
  // replay, which the provider's own idempotency protects, and wrong here).
  const asked = getRails()[attempt.rail as Rail];
  const lookup = asked.findByIdempotencyKeyStrict ?? asked.findByIdempotencyKey;
  if (lookup) {
    let known: { batchId: string } | null;
    try {
      known = await lookup.call(asked, attempt.idempotencyKey);
    } catch {
      throw new Error("Could not ask the provider whether this payment exists just now; try again in a minute. Nothing was changed");
    }
    if (known) throw new Error(`The provider already has a payout for this attempt (${known.batchId}); record it as found instead of paying again. Nothing was changed`);
  }
  db.update(paymentAttempts).set({ status: "failed", errorMessage: `Confirmed by ${actor} that nothing moved${resolution.note ? `: ${resolution.note}` : ""}`, updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
  transition(db, obligationId, "failed", actor, "execution.resolved_by_hand", { attemptId: attempt.id, nothingMoved: true, note: resolution.note ?? null });
  return "failed";
}

/**
 * Give a definitively failed payment another go. The rail said nothing moved, so a fresh idempotency key is safe.
 * The obligation returns to approved with the payout destination re-pinned to what the vendor record says now; the
 * execute step then re-runs policy and the payout check before any rail is called.
 */
export function retryFailed(db: Db, obligationId: string, actor: string): void {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "failed") throw new Error(`Only a failed payment can be retried (state: ${ob.state})`);
  const open = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).all().filter((a) => OPEN_ATTEMPT.includes(a.status));
  if (open.length > 0) throw new Error("A payment attempt is still unresolved; reconcile it before retrying");
  const vendorRow = db.select().from(vendors).where(eq(vendors.id, ob.vendorId!)).get();
  if (!vendorRow) throw new Error("The request has no vendor");
  const current = payoutHashOf(vendorRow);
  if (current !== vendorRow.detailsHash) throw new Error("Vendor payout details were edited without re-verification; verify the vendor first");
  if (ob.payoutHash && ob.payoutHash !== current) throw new Error("Vendor payout details changed since approval; review and approve this payment again");
  db.update(obligations).set({ payoutHash: current, releaseAt: null, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  transition(db, obligationId, "approved", actor, "execution.retry_requested", { payoutHash: current });
  // A part of a bill is checked again at once (API review R5): another part may have arrived since it failed, and an
  // outside caller's part then waits for a person instead of sitting ready for Autopilot. Release checks again anyway.
  if (ob.billId) {
    const outcome = runPolicy(db, obligationId);
    if (outcome.decision !== "auto_execute") moveTo(db, obligationId, targetState(outcome, "approved"), outcome);
  }
}

/** Poll the rail for the latest attempt and settle or fail accordingly. Webhooks call the same function. */
export async function confirmSettlement(db: Db, obligationId: string, source = "poll"): Promise<ObligationState> {
  const ob = mustGet(db, obligationId);
  const attempt = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).orderBy(desc(paymentAttempts.createdAt)).get();
  // Normally the obligation is "sent". An unknown attempt that already has a provider id (Stellar hash) can also be resolved from execution_pending.
  const resolvingUnknown = ob.state === "execution_pending" && !!attempt && (attempt.status === "unknown" || attempt.status === "pending") && !!attempt.externalId;
  if (ob.state !== "sent" && !resolvingUnknown) return ob.state as ObligationState;
  if (!attempt?.externalId) return ob.state as ObligationState;
  const rail = attempt.rail as Rail;
  const adapter = getRails()[rail];
  const status = await adapter.getStatus(attempt.externalId);
  db.update(paymentAttempts).set({ externalStatus: status.externalStatus, updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
  // Audit a check only when it learned something: polling an unclaimed payout every 15 seconds for 30 days
  // otherwise writes thousands of identical rows.
  if (attempt.externalStatus !== status.externalStatus || source !== "autopilot") {
    audit(db, { obligationId, actor: `rail:${rail}`, action: `settlement.checked:${source}`, detail: { status: status.status, externalStatus: status.externalStatus } });
  }
  if (status.status === "confirmed") {
    if (resolvingUnknown) {
      db.update(paymentAttempts).set({ status: "submitted", updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
      transition(db, obligationId, "sent", `rail:${rail}`, "execution.resolved", { attemptId: attempt.id, externalId: attempt.externalId });
    }
    settleFromRail(db, ob, attempt.id, rail, attempt.externalId, adapter.mode, status);
    return "settled";
  }
  if (status.status === "failed") {
    // The provider says the money is not with the recipient (failed, returned, blocked): a retry is now safe.
    db.update(paymentAttempts).set({ status: "failed", errorMessage: status.externalStatus, updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
    transition(db, obligationId, "failed", `rail:${rail}`, "settlement.failed", { externalStatus: status.externalStatus });
    return "failed";
  }
  if (status.status === "exception") {
    // Needs a human, and the money may still land (an unclaimed PayPal payout can be claimed). Not a failure: never retry.
    if (attempt.externalStatus !== status.externalStatus) {
      audit(db, { obligationId, actor: `rail:${rail}`, action: "settlement.exception", detail: { externalStatus: status.externalStatus, message: status.message } });
    }
    return ob.state as ObligationState;
  }
  return ob.state as ObligationState;
}

/** Settlement figures for the poll/reconcile paths. Live Stellar records what was sent; everything else uses the route quote, labelled as modelled outside mock mode. */
function settleFromRail(db: Db, ob: typeof obligations.$inferSelect, attemptId: string, rail: Rail, externalId: string, mode: string, status: SettlementStatus): void {
  const q = db.select().from(routeQuotes).where(and(eq(routeQuotes.obligationId, ob.id), eq(routeQuotes.rail, rail))).get();
  if (mode !== "mock" && rail === "stellar") {
    recordSettlement(db, ob.id, attemptId, rail, externalId, 0, ob.amountMinor, "PYUSD", "1", status.explorerUrl ?? null, "PYUSD sent on Stellar. Any recipient-currency (PHP) delivery through the anchor is modelled, not executed. Network fee not recorded on this path.");
    return;
  }
  // Only live Stellar reports what arrived. Everywhere else the fee and received figures come from the quote.
  const note =
    mode === "mock"
      ? rail === "wise" || rail === "bank_file" ? "Simulated payment: the fee and received amount come from the modelled price list, not from Wise or the bank." : null
      : rail === "wise"
        ? "Wise (beta): the fee and received amount are the quoted figures; check them against the Wise transfer record before closing the month."
        : rail === "bank_file"
          ? "Bank file: the fee is the modelled bank charge; check it against the bank statement."
          : "Fee and recipient figures are modelled from the published fee schedule, not reported by the provider.";
  recordSettlement(db, ob.id, attemptId, rail, externalId, q?.feeMinor ?? 0, q?.receiveAmountMinor ?? null, q?.receiveCurrency ?? null, q?.fxRate ?? null, status.explorerUrl ?? null, note);
}

function recordSettlement(db: Db, obligationId: string, attemptId: string, rail: Rail, externalId: string, feeMinor: number, receivedMinor: number | null, receivedCurrency: string | null, fxRate: string | null, explorerUrl: string | null, note: string | null = null): void {
  // One transaction: the settlement row, the attempt status, the state change and the accounting
  // record all happen together or not at all.
  db.transaction(() => {
    const ob = mustGet(db, obligationId);
    const ts = now();
    const existing = db.select().from(settlements).where(eq(settlements.obligationId, obligationId)).get();
    if (!existing) {
      // What actually went to the vendor: the amount less any tax withheld, as the attempt asked the rail to send.
      const sent = (JSON.parse(db.select({ r: paymentAttempts.requestJson }).from(paymentAttempts).where(eq(paymentAttempts.id, attemptId)).get()?.r ?? "{}") as { amountMinor?: number }).amountMinor ?? payableMinor(ob);
      db.insert(settlements).values({ id: newId("stl"), obligationId, attemptId, rail, grossMinor: sent, grossCurrency: ob.currency!, feeMinor, receivedMinor, receivedCurrency, fxRate, externalId, explorerUrl, note, settledAt: ts }).run();
    }
    db.update(paymentAttempts).set({ status: "confirmed", updatedAt: ts }).where(eq(paymentAttempts.id, attemptId)).run();
    transition(db, obligationId, "settled", `rail:${rail}`, "settlement.confirmed", { externalId, feeMinor, receivedMinor, receivedCurrency, explorerUrl });
    queueAccounting(db, obligationId);
    if (ob.billId) closeIfDone(db, ob.billId);
  });
}

function queueAccounting(db: Db, obligationId: string): void {
  const record = buildAccountingRecord(db, obligationId);
  if (!record) {
    // The money has moved, so the settlement must stand. Make the gap loud instead of silent.
    audit(db, { obligationId, actor: "system", action: "accounting.missing", detail: { reason: "no accounting record could be built for a settled obligation" } });
    return;
  }
  const ts = now();
  db.insert(accountingSyncs).values({ id: newId("acc"), obligationId, destination: record.destination, status: "pending", payloadJson: JSON.stringify(record.payload), createdAt: ts, updatedAt: ts }).run();
  audit(db, { obligationId, actor: "system", action: "accounting.queued", detail: { destination: record.destination, reference: record.payload.reference } });
}

// ---- helpers ----

export function mustGet(db: Db, id: string) {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get();
  if (!ob) throw new Error(`Request ${id} not found`);
  return ob;
}

/** For the UI's write surface: the obligation must belong to the caller's business, or it does not exist for them. */
export function assertOwnObligation(db: Db, businessId: string, id: string): void {
  if (typeof id !== "string" || !db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.id, id), eq(obligations.businessId, businessId))).get()) throw new Error("Obligation not found");
}

/**
 * Dual control that nobody can satisfy: above the dual-approval amount two different people must approve, each
 * within their own limit. Null when the team can do it (or there is no dual threshold).
 */
export function dualControlGap(db: Db, businessId: string, amountBaseMinor?: number): string | null {
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!biz) return null;
  const policy: ApprovalPolicy = { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
  const t = policy.dualApprovalThresholdMinor;
  if (!t || t <= 0) return null;
  const amount = amountBaseMinor ?? t + 1;
  if (amount <= t) return null;
  // One person whose limit covers it, plus any second approver as the check.
  const covering = approversFor(db, businessId, amount);
  const anyApprover = approversFor(db, businessId, 0);
  const what = amountBaseMinor === undefined ? `a payment above ${fmt(t, biz.baseCurrency)}` : `${fmt(amount, biz.baseCurrency)}`;
  if (!covering.length) return `Nobody can approve ${what}: raise someone's approval limit in Settings, Team.`;
  if (anyApprover.length >= 2) return null;
  return `Two different people must approve ${what}, but only ${anyApprover.join(", ")} can approve payments. Add a second approver in the login settings.`;
}

export function listEvidence(db: Db, obligationId: string): EvidenceItem[] {
  return db
    .select()
    .from(evidenceTable)
    .where(and(eq(evidenceTable.obligationId, obligationId), isNull(evidenceTable.supersededBy)))
    .all()
    .map((e) => ({ id: e.id, kind: e.kind, label: e.label, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, excerpt: e.excerpt, provenance: e.provenance === "operator" ? ("operator" as const) : e.provenance === "document" ? ("document" as const) : e.provenance === "vendor" ? ("vendor" as const) : ("system" as const) }));
}

/**
 * Add a record to a payment that is still being prepared (missing evidence, or blocked), then read and check it
 * again. Used by the vendor's evidence link; the record is marked as the vendor's, which policy treats as a claim.
 */
export async function addEvidence(db: Db, obligationId: string, actor: string, item: Omit<EvidenceItem, "id">, attachmentId: string | null): Promise<void> {
  const ob = mustGet(db, obligationId);
  if (!["drafted", "needs_evidence", "blocked", "awaiting_approval"].includes(ob.state)) throw new Error("This payment is no longer waiting for evidence");
  const newEvidenceId = newId("evd");
  // A vendor's revised invoice or receipt replaces their earlier one; the business's own records are never replaced.
  const replaced = item.provenance === "vendor" && (item.kind === "invoice" || item.kind === "receipt")
    ? db
        .select({ id: evidenceTable.id, provenance: evidenceTable.provenance, reference: evidenceTable.reference })
        .from(evidenceTable)
        .where(and(eq(evidenceTable.obligationId, obligationId), eq(evidenceTable.kind, item.kind), isNull(evidenceTable.supersededBy)))
        .all()
        // A record that came in through an integration is replaced only by a revision of the same invoice number.
        .filter((e) => (e.provenance && e.provenance !== "system") || (!!item.reference && e.reference?.toUpperCase() === item.reference.toUpperCase()))
        .map((e) => e.id)
    : [];
  db.transaction((tx) => {
    if (replaced.length) tx.update(evidenceTable).set({ supersededBy: newEvidenceId }).where(inArray(evidenceTable.id, replaced)).run();
    tx.insert(evidenceTable).values({ id: newEvidenceId, obligationId, kind: item.kind, label: item.label.slice(0, 120), amountMinor: item.amountMinor, currency: item.currency, reference: item.reference, excerpt: item.excerpt?.slice(0, 600) ?? null, provenance: item.provenance ?? "operator", attachmentId, createdAt: now() }).run();
    if (attachmentId) tx.update(attachments).set({ obligationId }).where(eq(attachments.id, attachmentId)).run();
  });
  // Approvals given before the new record no longer cover what is now on file.
  db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).run();
  audit(db, { obligationId, actor, action: "evidence.added", detail: { kind: item.kind, label: item.label, provenance: item.provenance ?? "operator", attachmentId, replaces: replaced } });
  if (ob.state === "blocked") transition(db, obligationId, "verified", actor, "review.resolved", { note: "new evidence" });
  await processObligation(db, obligationId);
}

export function toProfile(v: typeof vendors.$inferSelect): VendorPayoutProfile {
  return { id: v.id, name: v.name, country: v.country, preferredRail: (v.preferredRail as Rail | null) ?? null, paypalEmail: v.paypalEmail, stellarAccount: v.stellarAccount, bankCountry: v.bankCountry, bankCurrency: v.bankCurrency, bankLabel: v.bankLabel, detailsHash: v.detailsHash, verifiedAt: v.verifiedAt, status: v.status, hasBankAccount: Boolean(v.bankAccountEnc), bankCode: v.bankCode, accountHolder: v.accountHolder, retainerMinor: v.retainerMinor };
}

/** A state as a person reads it inside a sentence ("awaiting approval", "paid"). */
function stateWord(state: string | null | undefined): string {
  return stateLabel(state).toLowerCase() || "in an unknown state";
}

