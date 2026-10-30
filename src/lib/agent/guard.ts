import { and, desc, eq, gte } from "drizzle-orm";
import { snapshotOf, type Db } from "../db";
import { agentChecks, obligations, paymentAttempts, settlements, vendors } from "../db/schema";
import { getBusiness } from "../queries";
import { newId, now } from "../domain/ids";
import { SUPPORTED_CURRENCIES } from "../domain/money";
import { effectiveAutonomy } from "../domain/types";
import { ingestObligation, previewPolicy } from "../engine/orchestrator";
import { formatMoney } from "../format";
import { evaluatePayment, verdictOf, type Verdict } from "../check/evaluate";
import type { AgentKey } from "./keys";
import { guideFor } from "./rules";

/**
 * The agent guard: what outside agents may ask Checkrail, and nothing more.
 *
 *  - check_payment judges a payment on an in-memory copy of the books (snapshotOf). It cannot change the books and
 *    cannot pay: the only write it makes is one row in agent_checks saying who asked what and what was answered.
 *  - request_payment puts a request in the inbox exactly as a clerk would. Policy and the business's autonomy setting
 *    decide what happens next; an agent can never approve, release or send. What it attaches counts as its own say-so,
 *    unless the owner gave its key the attest scope (a system of record), when it counts like any integration's records.
 *  - payment_status, lookup_payee and explain_rule only read.
 *
 * Everything an agent sends is data. Messages coming back are trimmed and stripped of internal ids, because they can
 * carry text a supplier wrote and the calling agent will read them.
 */

export class AgentInputError extends Error {}

const EVIDENCE_KINDS = ["contract", "booking", "job_sheet", "invoice", "message", "photo", "receipt", "purchase_order"] as const;
const PROBE_WINDOW_MS = 15 * 60_000;
const PROBE_DISTINCT_AMOUNTS = 3;

export interface PaymentArgs {
  payee: string;
  amount: string | number;
  currency: string;
  reference?: string | null;
  description?: string | null;
  evidence?: Array<{ kind: string; label: string; amount?: string | number | null; reference?: string | null; excerpt?: string | null }>;
}

// ---------- Input ----------

function text(v: unknown, name: string, max: number, required = false): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new AgentInputError(`${name} is required`);
    return null;
  }
  if (typeof v !== "string") throw new AgentInputError(`${name} must be a string`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (t.length > max) throw new AgentInputError(`${name} must be at most ${max} characters`);
  return t;
}

/** "960", "960.50", 960, "2,500,000" or "2500000" to hundredths. Nothing looser: an agent states amounts exactly. */
export function amountToMinor(v: unknown, name = "amount"): number {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(2) : "") : typeof v === "string" ? v.trim() : "";
  const m = s.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new AgentInputError(`${name} must be a positive number such as "960.00" (no currency symbol)`);
  const minor = Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new AgentInputError(`${name} must be more than zero`);
  return minor;
}

export function validatePaymentArgs(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new AgentInputError("Arguments must be an object");
  const a = raw as Record<string, unknown>;
  const payee = text(a.payee, "payee", 80, true)!;
  const currency = (text(a.currency, "currency", 3, true) ?? "").toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new AgentInputError(`currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}`);
  const amountMinor = amountToMinor(a.amount);
  const reference = text(a.reference, "reference", 80);
  const description = text(a.description, "description", 2000);
  const evRaw = a.evidence ?? [];
  if (!Array.isArray(evRaw) || evRaw.length > 10) throw new AgentInputError("evidence must be a list of at most 10 records");
  const evidence = evRaw.map((e, i) => {
    if (!e || typeof e !== "object") throw new AgentInputError(`evidence[${i}] must be an object`);
    const r = e as Record<string, unknown>;
    const kind = text(r.kind, `evidence[${i}].kind`, 20, true)!;
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) throw new AgentInputError(`evidence[${i}].kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
    return {
      kind,
      label: text(r.label, `evidence[${i}].label`, 200, true)!,
      amountMinor: r.amount == null || r.amount === "" ? null : amountToMinor(r.amount, `evidence[${i}].amount`),
      currency,
      reference: text(r.reference, `evidence[${i}].reference`, 80),
      excerpt: text(r.excerpt, `evidence[${i}].excerpt`, 2000),
    };
  });
  return { payee, amountMinor, currency, reference, description, evidence };
}

/** What an agent attaches is its own say-so ("operator"), unless the owner made it a system of record ("attest"). */
export function evidenceSourceOf(agent: AgentKey): "system" | "operator" {
  return agent.scopes.includes("attest") ? "system" : "operator";
}

// ---------- Output ----------

/** What goes back to an agent: no internal ids, no runaway length, one line each. */
export function clean(message: string): string {
  return message
    .replace(/obligation obl_[a-z0-9]+/gi, "an earlier payment")
    .replace(/\bobl_[a-z0-9]+/gi, "an earlier payment")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function nextSteps(verdict: Verdict, failed: Array<{ rule: string }>): string[] {
  if (verdict === "pay") return ["Clear by this business's rules. Use request_payment to have Checkrail send it, or continue with the payment step your business set up for you."];
  const steps = [...new Set(failed.map((f) => guideFor(f.rule).clear))];
  if (verdict === "block") steps.push("Do not pay this through any other tool. Tell the person who asked what the message says.");
  else steps.push("If a person should decide, use request_payment: it goes to their inbox and nothing is sent without them.");
  return steps.slice(0, 6);
}

function businessOf(db: Db) {
  const biz = getBusiness(db);
  if (!biz) throw new AgentInputError("No business is set up in this Checkrail");
  return biz;
}

function paypalTxnIn(messages: string[]): string | null {
  for (const m of messages) {
    const hit = m.match(/PayPal transaction ([A-Z0-9]{8,24})/);
    if (hit) return hit[1];
  }
  return null;
}

function log(db: Db, row: Omit<typeof agentChecks.$inferInsert, "id" | "createdAt">): string {
  const id = newId("agc");
  db.insert(agentChecks).values({ ...row, id, createdAt: now() }).run();
  return id;
}

// ---------- check_payment ----------

export interface CheckAnswer {
  check_id: string;
  verdict: Verdict;
  summary: string;
  payee: string | null;
  amount: string;
  reference: string | null;
  blocks: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
  next_steps: string[];
  paypal_transaction_id: string | null;
  autonomy: string;
  checked_at: string;
  note: string;
}

export async function checkPayment(db: Db, agent: AgentKey, raw: unknown): Promise<CheckAnswer> {
  const a = validatePaymentArgs(raw);
  const biz = businessOf(db);
  const copy = snapshotOf(db);
  const r = await evaluatePayment(copy, { businessId: biz.id, payee: a.payee, amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, description: a.description, evidence: a.evidence, evidenceSource: evidenceSourceOf(agent), actor: `mcp:${agent.name}` });
  let verdict = r.verdict;
  const blocks = r.blocks.map((b) => ({ rule: b.rule, message: clean(b.message) }));
  const warnings = r.warnings.map((w) => ({ rule: w.rule, message: clean(w.message) }));

  // An agent trying amount after amount for one payee is looking for the line. It does not get a "pay" that way.
  const payeeKey = a.payee.toLowerCase();
  const recent = db.select({ amountMinor: agentChecks.amountMinor }).from(agentChecks)
    .where(and(eq(agentChecks.agent, agent.name), eq(agentChecks.payeeKey, payeeKey), eq(agentChecks.tool, "check_payment"), gte(agentChecks.createdAt, new Date(Date.now() - PROBE_WINDOW_MS).toISOString())))
    .all();
  const distinct = new Set([...recent.map((x) => x.amountMinor), a.amountMinor]).size;
  if (distinct >= PROBE_DISTINCT_AMOUNTS && verdict !== "block") {
    verdict = "hold";
    warnings.unshift({ rule: "agent_probing", message: `This agent has checked ${distinct} different amounts for ${a.payee} in 15 minutes; a person confirms this one` });
  }

  const summary = clean(
    verdict === "block" ? `Do not pay: ${blocks[0]?.message ?? "a rule blocks it"}.`
    : verdict === "pay" ? "Clear to pay: every rule passed within the limits this business set."
    : `A person must look first: ${warnings[0]?.message ?? "it needs approval"}.`,
  ).replace(/\.\.$/, ".");
  const amount = formatMoney(a.amountMinor, a.currency, { code: true });
  const checkId = log(db, { businessId: biz.id, agent: agent.name, tool: "check_payment", verdict, payee: a.payee, payeeKey, amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, summary, rulesJson: JSON.stringify([...blocks, ...warnings].map((x) => x.rule)), obligationId: null, idempotencyKey: null });
  return {
    check_id: checkId,
    verdict,
    summary,
    payee: r.vendor?.name ?? null,
    amount,
    reference: r.reference,
    blocks,
    warnings,
    next_steps: nextSteps(verdict, [...blocks, ...warnings]),
    paypal_transaction_id: paypalTxnIn([...r.blocks, ...r.warnings].map((x) => x.message)),
    autonomy: effectiveAutonomy(JSON.parse(biz.policyJson)),
    checked_at: now(),
    note: "Judged against a copy of the books. Nothing was paid, saved or sent.",
  };
}

// ---------- request_payment and payment_status ----------

export type RequestStatus = "blocked" | "waiting_for_evidence" | "waiting_for_approval" | "scheduled" | "approved" | "sending" | "paid" | "returned" | "cancelled" | "failed" | "disputed";

export interface StatusAnswer {
  request_id: string;
  status: RequestStatus;
  summary: string;
  payee: string | null;
  amount: string | null;
  reference: string | null;
  reasons: string[];
  releases_at: string | null;
  paid: { rail: string; provider_id: string | null; settled_at: string } | null;
  review_path: string;
}

/** "at 18:12 UTC, in 10 minutes": readable by a person and an agent alike. releases_at keeps the exact time. */
export function whenRelease(iso: string, at = Date.now()): string {
  const d = new Date(iso);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  const mins = Math.max(0, Math.round((d.getTime() - at) / 60_000));
  return `at ${hhmm}, ${mins === 0 ? "within a minute" : `in ${mins} minute${mins === 1 ? "" : "s"}`},`;
}

function describe(db: Db, id: string): StatusAnswer {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get();
  if (!ob) throw new AgentInputError("No such request");
  const vendor = ob.vendorId ? db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, ob.vendorId)).get() ?? null : null;
  const amount = ob.amountMinor && ob.currency ? formatMoney(ob.amountMinor, ob.currency, { code: true }) : null;
  const settled = db.select().from(settlements).where(eq(settlements.obligationId, id)).orderBy(desc(settlements.settledAt)).get();
  const attempt = db.select({ externalId: paymentAttempts.externalId }).from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).orderBy(desc(paymentAttempts.createdAt)).get();
  const policy = ["blocked", "needs_evidence", "awaiting_approval", "approved"].includes(ob.state) ? previewPolicy(db, id) : null;
  const reasons = (policy?.rules ?? []).filter((r) => !r.passed && r.severity !== "info").map((r) => clean(r.message)).slice(0, 6);
  const scheduled = ob.state === "approved" && ob.releaseAt && !ob.autopilotCancelledAt;
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
  const summary =
    status === "blocked" ? `Blocked: ${reasons[0] ?? "a rule blocks it"}.`
    : status === "waiting_for_evidence" ? "Waiting for supporting evidence before anyone can approve it."
    : status === "waiting_for_approval" ? `Waiting for a person to approve${reasons[0] ? `: ${reasons[0]}` : ""}.`
    : status === "scheduled" ? `Autopilot sends it ${whenRelease(ob.releaseAt!)} unless a person cancels before then.`
    : status === "approved" ? "Approved by the rules; a person sends it."
    : status === "sending" ? "Sent to the payment rail; waiting for it to confirm."
    : status === "paid" ? `Paid${settled ? ` over ${settled.rail}` : ""}.`
    : status === "returned" ? "The payment came back; a person decides what happens next."
    : `Status: ${status}.`;
  return {
    request_id: id,
    status,
    summary: clean(summary).replace(/\.\.$/, "."),
    payee: vendor?.name ?? null,
    amount,
    reference: ob.sourceRef,
    reasons,
    releases_at: scheduled ? ob.releaseAt : null,
    paid: settled ? { rail: settled.rail, provider_id: settled.externalId ?? attempt?.externalId ?? null, settled_at: settled.settledAt } : null,
    review_path: `/obligations/${id}`,
  };
}

export async function requestPayment(db: Db, agent: AgentKey, raw: unknown): Promise<StatusAnswer & { replayed: boolean }> {
  if (!agent.scopes.includes("request")) throw new AgentInputError("This agent key may check payments but not request them");
  const a = validatePaymentArgs(raw);
  const idem = text((raw as Record<string, unknown>).idempotency_key, "idempotency_key", 80, true)!;
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(idem)) throw new AgentInputError("idempotency_key must be 8 to 80 letters, digits, dots, colons, dashes or underscores");
  const biz = businessOf(db);

  // Claim the key first: a retry, or two calls racing, gets the one request this key stands for.
  const existing = db.select().from(agentChecks).where(and(eq(agentChecks.agent, agent.name), eq(agentChecks.idempotencyKey, idem))).get();
  if (existing) {
    if (existing.payeeKey !== a.payee.toLowerCase() || existing.amountMinor !== a.amountMinor || existing.currency !== a.currency) throw new AgentInputError("idempotency_key was already used for a different payment");
    if (!existing.obligationId) throw new AgentInputError("That request is still being created; ask payment_status again in a moment");
    return { ...describe(db, existing.obligationId), replayed: true };
  }
  let claim: string;
  try {
    claim = log(db, { businessId: biz.id, agent: agent.name, tool: "request_payment", verdict: "hold", payee: a.payee, payeeKey: a.payee.toLowerCase(), amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, summary: "Creating the request", rulesJson: null, obligationId: null, idempotencyKey: idem });
  } catch {
    throw new AgentInputError("That request is still being created; ask payment_status again in a moment");
  }

  const description = a.description ? ` ${a.description}` : "";
  const id = await ingestObligation(db, {
    businessId: biz.id,
    sourceType: "operator_instruction",
    sourceRef: a.reference,
    rawInput: `Pay ${a.payee} ${formatMoney(a.amountMinor, a.currency, { code: true })}${a.reference ? ` for ${a.reference}` : ""}.${description} (Requested by agent ${agent.name}.)`,
    evidence: a.evidence,
    evidenceSource: evidenceSourceOf(agent),
    actor: `mcp:${agent.name}`,
  });
  const answer = describe(db, id);
  const verdict = answer.status === "blocked" ? "block" : answer.status === "scheduled" || answer.status === "approved" ? "pay" : "hold";
  db.update(agentChecks).set({ obligationId: id, verdict, summary: answer.summary, rulesJson: JSON.stringify(answer.reasons) }).where(eq(agentChecks.id, claim)).run();
  return { ...answer, replayed: false };
}

export function paymentStatus(db: Db, agent: AgentKey, raw: unknown): StatusAnswer {
  const id = text((raw as Record<string, unknown> | null)?.request_id, "request_id", 64, true)!;
  // An agent sees only the requests it made.
  const mine = db.select({ id: agentChecks.id }).from(agentChecks).where(and(eq(agentChecks.agent, agent.name), eq(agentChecks.obligationId, id))).get();
  if (!mine) throw new AgentInputError("No request with that id was made by this agent");
  return describe(db, id);
}

// ---------- lookup_payee and explain_rule ----------

export function lookupPayee(db: Db, raw: unknown) {
  const name = text((raw as Record<string, unknown> | null)?.name, "name", 80, true)!;
  const biz = businessOf(db);
  const all = db.select().from(vendors).where(eq(vendors.businessId, biz.id)).all();
  const want = name.toLowerCase();
  const v = all.find((x) => x.name.toLowerCase() === want || (x.email ?? "").toLowerCase() === want || (x.paypalEmail ?? "").toLowerCase() === want);
  if (!v) {
    const close = all.filter((x) => x.name.toLowerCase().includes(want) || want.includes(x.name.toLowerCase())).map((x) => x.name).slice(0, 5);
    return { known: false, name: null, suggestions: close, note: "Checkrail does not pay a payee it does not know. A person adds and verifies new suppliers." };
  }
  const paidBefore = db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.vendorId, v.id), eq(obligations.state, "settled"))).get();
  return {
    known: true,
    name: v.name,
    role: v.role,
    country: v.country,
    status: v.status,
    payout_details_verified: Boolean(v.verifiedAt),
    can_be_paid_by: [v.paypalEmail ? "paypal" : null, v.stellarAccount ? "stellar" : null, v.bankLabel ? "bank" : null].filter(Boolean),
    paid_before: Boolean(paidBefore),
    note: "Payout details are never shared with agents.",
  };
}

export function explainRule(raw: unknown) {
  const rule = text((raw as Record<string, unknown> | null)?.rule, "rule", 40, true)!;
  const g = rule === "agent_probing"
    ? { checks: "The same agent has not checked several different amounts for one payee in a short time.", clear: "Stop trying amounts. Ask the person who wants this paid for the right figure and its record." }
    : guideFor(rule);
  return { rule, ...g };
}

export const agentVerdictOf = verdictOf;
