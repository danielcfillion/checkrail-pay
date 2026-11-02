import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, paymentAttempts, settlements } from "../db/schema";
import { AGENT_FLAG_PREFIX, approvedByPerson, outsideBillMatch, previewPolicy } from "../engine/orchestrator";
import { BILL_NEUTRAL, apiReasons } from "./redact";

/**
 * What an outside caller (an API key or an outside agent) may read about a request it made: one builder for both
 * channels, so the REST API and the MCP agent tools cannot drift apart.
 *
 * Reasons are fixed sentences per rule code (redact.ts), never the messages a person reads. A request held because of
 * bills (on one, naming one, or to a supplier with a bill in the last 180 days) reads the same whatever the bills'
 * balance, state or other parts, and whether a bill matched at all:
 *  - while it waits (blocked, waiting for evidence or for a person): waiting_for_approval, verdict hold;
 *  - once a person approved it, until it is paid, refused or cancelled: its approved or scheduled status, verdict
 *    approved;
 *  - in both, rules_failed [bill_review] and the one neutral sentence;
 *  - once it is in flight or final: its own status only, with no reasons and no rules.
 * Known and left as is: an approved request whose fit changes before release (another part, a credit,
 * the bill closed) goes back to waiting, so the caller sees approved and then waiting_for_approval. That says only that
 * something changed, not what, and whether it is finally paid depends on the bill anyway.
 */

export type RequestStatus = "blocked" | "waiting_for_evidence" | "waiting_for_approval" | "scheduled" | "approved" | "sending" | "paid" | "returned" | "cancelled" | "failed" | "disputed";
export type Verdict = "pay" | "hold" | "block" | "approved" | "pending" | null;

export interface OutsideView {
  ob: typeof obligations.$inferSelect;
  status: RequestStatus;
  state: string;
  verdict: Verdict;
  reasons: string[];
  rulesFailed: string[];
  releasesAt: string | null;
  rail: string | null;
  showWithheld: boolean;
  aboutBill: boolean;
  settled: typeof settlements.$inferSelect | undefined;
  attempt: { externalId: string | null; rail: string; status: string } | undefined;
}

const WAITING = ["blocked", "drafted", "needs_evidence", "awaiting_approval", "verified"];

/** `withReasons: false` (lists) skips re-running the checks: status and the stored verdict only. Null when there is no such request. */
export function outsideView(db: Db, id: string, opts: { withReasons?: boolean } = {}): OutsideView | null {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get();
  if (!ob) return null;
  const settled = db.select().from(settlements).where(eq(settlements.obligationId, id)).orderBy(desc(settlements.settledAt)).get();
  const attempt = db.select({ externalId: paymentAttempts.externalId, rail: paymentAttempts.rail, status: paymentAttempts.status }).from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).orderBy(desc(paymentAttempts.createdAt)).get();
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
  const base = { ob, settled, attempt, releasesAt: scheduled ? ob.releaseAt : null };

  if (outsideBillMatch(db, id)) {
    if (WAITING.includes(ob.state)) return { ...base, status: "waiting_for_approval", state: "awaiting_approval", verdict: "hold", reasons: [BILL_NEUTRAL], rulesFailed: ["bill_review"], releasesAt: null, rail: null, showWithheld: false, aboutBill: true };
    // "approved" only when a person approved it. One the rules approved before a bill held it reads pending, with no
    // release time, and the rail stays hidden until the request is final.
    if (ob.state === "approved") {
      const byPerson = approvedByPerson(db, id);
      return { ...base, status: byPerson ? status : "approved", state: ob.state, verdict: byPerson ? "approved" : "pending", reasons: [BILL_NEUTRAL], rulesFailed: ["bill_review"], releasesAt: byPerson ? base.releasesAt : null, rail: null, showWithheld: false, aboutBill: true };
    }
    const final = ["settled", "refunded", "cancelled", "failed", "disputed"].includes(ob.state);
    return { ...base, status, state: ob.state, verdict: null, reasons: [], rulesFailed: [], rail: final ? settled?.rail ?? attempt?.rail ?? null : null, showWithheld: true, aboutBill: true };
  }

  const preview = ["blocked", "needs_evidence", "awaiting_approval", "approved"].includes(ob.state) && opts.withReasons !== false ? previewPolicy(db, id) : null;
  // The caller's own text disagreeing with its fields is its own rule code, as check_payment reports it.
  const checks = preview && { ...preview, rules: preview.rules.map((r) => (r.ruleId === "ai_flag" && r.message.startsWith(AGENT_FLAG_PREFIX) ? { ...r, ruleId: "agent_mismatch" } : r)) };
  const failing = (checks?.rules ?? []).filter((r) => !r.passed && r.severity !== "info").sort((x, y) => Number(y.severity === "block") - Number(x.severity === "block"));
  const decision = checks?.decision ?? ob.policyDecision ?? null;
  return {
    ...base,
    status,
    state: ob.state,
    verdict: decision === "auto_execute" ? "pay" : decision === "block" ? "block" : decision ? "hold" : null,
    reasons: checks ? apiReasons(checks.rules, checks.decision) : [],
    rulesFailed: failing.map((r) => r.ruleId),
    rail: ob.selectedRail ?? null,
    showWithheld: true,
    aboutBill: false,
  };
}
