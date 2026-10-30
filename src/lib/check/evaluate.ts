import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, vendors } from "../db/schema";
import { ingestObligation, previewPolicy } from "../engine/orchestrator";
import { formatMoney } from "../format";
import type { PolicyDecision, PolicyRuleResult } from "../domain/types";

/**
 * Judge one payment the way Checkrail would, without paying it.
 *
 * The caller passes the database to judge it in, and that database is written to: a draft request, its evidence and
 * audit rows. So callers pass a throwaway copy, never the live books: `snapshotOf(getDb())` for a live check against
 * real history (the agent guard), or an empty in-memory database (the historical re-check). Nothing here calls
 * executeObligation, approves, or touches a rail's execute; the verdict comes from previewPolicy, which only reads.
 */

export interface PaymentToCheck {
  businessId: string;
  /** Who is to be paid, as the request names them. */
  payee: string;
  amountMinor: number;
  currency: string;
  /** Invoice, job or booking reference, when there is one. Duplicates are matched on it. */
  reference?: string | null;
  /** The request or bank note in the requester's words. Job identifiers in it are matched too. */
  description?: string | null;
  evidence?: Array<{ kind: string; label: string; amountMinor?: number | null; currency?: string | null; reference?: string | null; excerpt?: string | null }>;
  /** Evidence from the business's own systems ("system") or typed by whoever asks ("operator"). Operator evidence is weighed less. */
  evidenceSource?: "system" | "operator";
  actor?: string;
}

export type Verdict = "pay" | "hold" | "block";

export interface CheckResult {
  verdict: Verdict;
  decision: PolicyDecision;
  /** One sentence a person or an agent can act on. */
  summary: string;
  vendor: { id: string; name: string } | null;
  amountMinor: number | null;
  currency: string | null;
  reference: string | null;
  blocks: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
  /** The draft's id inside the database it was judged in. Meaningless outside a throwaway copy. */
  draftId: string;
}

const toItem = (r: PolicyRuleResult) => ({ rule: r.ruleId, message: r.message });

export function verdictOf(decision: PolicyDecision): Verdict {
  if (decision === "block") return "block";
  if (decision === "auto_execute") return "pay";
  return "hold";
}

export function requestText(p: Pick<PaymentToCheck, "payee" | "amountMinor" | "currency" | "reference" | "description">): string {
  const amount = formatMoney(p.amountMinor, p.currency, { code: true });
  const head = `Pay ${p.payee} ${amount}${p.reference ? ` for ${p.reference}` : ""}.`;
  const note = (p.description ?? "").trim();
  return note ? `${head} ${note}` : head;
}

export async function evaluatePayment(db: Db, p: PaymentToCheck): Promise<CheckResult> {
  if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) throw new Error("Amount must be a positive whole number of minor units");
  const draftId = await ingestObligation(db, {
    businessId: p.businessId,
    sourceType: "operator_instruction",
    sourceRef: p.reference ?? null,
    rawInput: requestText(p),
    evidence: (p.evidence ?? []).map((e) => ({ kind: e.kind, label: e.label, amountMinor: e.amountMinor ?? null, currency: e.currency ?? null, reference: e.reference ?? null, excerpt: e.excerpt ?? null })),
    evidenceSource: p.evidenceSource ?? "system",
    actor: p.actor ?? "check",
  });
  const outcome = previewPolicy(db, draftId);
  const ob = db.select().from(obligations).where(eq(obligations.id, draftId)).get()!;
  const vendor = ob.vendorId ? db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.id, ob.vendorId)).get() ?? null : null;
  const blocks = outcome.rules.filter((r) => !r.passed && r.severity === "block").map(toItem);
  const warnings = outcome.rules.filter((r) => !r.passed && r.severity === "warn").map(toItem);
  const verdict = verdictOf(outcome.decision);
  const summary =
    verdict === "block" ? `Do not pay: ${blocks[0]?.message ?? outcome.reasons[0] ?? "a rule blocks it"}.`
    : verdict === "pay" ? "Clear to pay: every rule passed within the limits this business set."
    : `A person must look first: ${warnings[0]?.message ?? outcome.reasons[0] ?? "it needs approval"}.`;
  return { verdict, decision: outcome.decision, summary: summary.replace(/\.\.$/, "."), vendor, amountMinor: ob.amountMinor, currency: ob.currency, reference: ob.sourceRef, blocks, warnings, draftId };
}
