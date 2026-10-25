import { railLabel } from "../format";
import { toBaseOrZero } from "../fx";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { auditEntries, obligations, paymentAttempts, settlements, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { AGENT_ACTOR, autopilotStatus, type AutopilotStatus } from "./autopilot";

/**
 * Daily close: one scan of everything that happened since a person last signed off.
 * Read-only apart from the sign-off itself, which is an audit entry and nothing else.
 * Unusual items come first so a two-minute read catches what matters.
 */

export const CLOSE_ACTION = "daily_close.reviewed";

export interface CloseItem {
  id: string;
  vendorName: string | null;
  sourceRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  state: string;
  rail: string | null;
  at: string;
  /** Plain-language reason this item is in the list. */
  note: string | null;
  feeMinor?: number | null;
}

export interface AttentionItem extends CloseItem {
  kind: "returned" | "unknown_outcome" | "payout_exception" | "failed" | "refused" | "blocked" | "cancelled_release" | "slow_settlement" | "approved_over_warning" | "unusual_amount" | "new_vendor";
}

export interface DailyClose {
  since: string;
  /** True when the window starts at the last sign-off, false when it is the default look-back. */
  sinceIsSignOff: boolean;
  lastSignOff: { at: string; actor: string } | null;
  attention: AttentionItem[];
  paidByAgent: CloseItem[];
  paidByPeople: CloseItem[];
  inFlight: CloseItem[];
  scheduled: AutopilotStatus["scheduled"];
  waitingOnYou: CloseItem[];
  settingsChanges: Array<{ at: string; actor: string; action: string; detail: Record<string, unknown> | null }>;
  totals: { agentMinor: number; agentCount: number; peopleMinor: number; peopleCount: number; feesMinor: number; stoppedMinor: number; stoppedCount: number };
  autopilot: AutopilotStatus;
  baseCurrency: string;
  /** Highest audit seq included. Stored with the sign-off so it is clear what was reviewed. */
  throughSeq: number;
}

const SLOW_SETTLEMENT_MS = 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const bankRail = (r: string | null | undefined) => r === "wise" || r === "bank_file";

export function getDailyClose(db: Db, businessId: string, baseCurrency: string): DailyClose {
  const last = db.select().from(auditEntries).where(eq(auditEntries.action, CLOSE_ACTION)).orderBy(desc(auditEntries.seq)).limit(1).get();
  const since = last?.createdAt ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const entries = db
    .select()
    .from(auditEntries)
    .where(last ? gt(auditEntries.seq, last.seq) : gt(auditEntries.createdAt, since))
    .orderBy(auditEntries.seq)
    .all();
  const throughSeq = db.select({ seq: auditEntries.seq }).from(auditEntries).orderBy(desc(auditEntries.seq)).limit(1).get()?.seq ?? 0;

  const obs = db.select().from(obligations).where(eq(obligations.businessId, businessId)).all();
  const byId = new Map(obs.map((o) => [o.id, o]));
  const vendorNames = new Map(db.select().from(vendors).where(eq(vendors.businessId, businessId)).all().map((v) => [v.id, v.name]));
  const fees = new Map(db.select({ obligationId: settlements.obligationId, feeMinor: settlements.feeMinor }).from(settlements).all().map((s) => [s.obligationId, s.feeMinor]));

  const item = (id: string, at: string, note: string | null): CloseItem | null => {
    const o = byId.get(id);
    if (!o) return null;
    return { id, vendorName: o.vendorId ? vendorNames.get(o.vendorId) ?? null : null, sourceRef: o.sourceRef, amountMinor: o.amountMinor, currency: o.currency, state: o.state, rail: o.selectedRail, at, note, feeMinor: fees.get(id) ?? null };
  };

  // Who started each payment in the window: the entry that moved it to execution_pending carries the actor.
  const started = new Map<string, { actor: string; at: string }>();
  for (const e of entries) if (e.obligationId && e.toState === "execution_pending") started.set(e.obligationId, { actor: e.actor, at: e.createdAt });

  const paidByAgent: CloseItem[] = [];
  const paidByPeople: CloseItem[] = [];
  const inFlight: CloseItem[] = [];
  const attention: AttentionItem[] = [];
  const seen = new Set<string>();
  const flag = (kind: AttentionItem["kind"], id: string, at: string, note: string | null) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    const it = item(id, at, note);
    if (it) {
      seen.add(key);
      attention.push({ ...it, kind });
    }
  };

  for (const [id, s] of started) {
    const o = byId.get(id);
    if (!o) continue;
    const byAgent = s.actor === AGENT_ACTOR;
    if (o.state === "settled" || o.state === "sent") {
      const it = item(id, s.at, byAgent ? "Sent by autopilot" : `Sent by ${s.actor.replace(/^user:/, "")}`)!;
      (byAgent ? paidByAgent : paidByPeople).push(it);
      if (o.state === "sent") {
        inFlight.push(it);
        if (Date.now() - new Date(s.at).getTime() > SLOW_SETTLEMENT_MS) flag("slow_settlement", id, s.at, "Sent over an hour ago and the provider has not confirmed it yet.");
      }
    }
  }

  // Ambiguous outcomes are the most serious thing on the page: money may have moved.
  const unknown = db.select().from(paymentAttempts).where(inArray(paymentAttempts.status, ["unknown", "pending"])).all();
  for (const a of unknown) {
    const o = byId.get(a.obligationId);
    if (o && o.state === "execution_pending") flag("unknown_outcome", o.id, a.updatedAt, a.errorMessage ?? "The provider did not give a clear answer. Do not pay again until this is reconciled.");
  }

  // A sent payment the provider says needs a person (unclaimed, on hold). Shown every day until it resolves, not only on the day it happened.
  for (const o of obs.filter((x) => x.state === "sent")) {
    const ex = db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.obligationId, o.id), eq(auditEntries.action, "settlement.exception")))
      .orderBy(desc(auditEntries.seq))
      .limit(1)
      .get();
    if (ex) {
      const d = ex.detailJson ? (JSON.parse(ex.detailJson) as { message?: string }) : {};
      flag("payout_exception", o.id, ex.createdAt, d.message ?? "The provider needs a person to look at this payout.");
    }
  }

  for (const e of entries) {
    if (!e.obligationId) continue;
    const detail = e.detailJson ? (JSON.parse(e.detailJson) as Record<string, unknown>) : {};
    if (e.action === "settlement.returned") flag("returned", e.obligationId, e.createdAt, `Came back to the business (${String(detail.type ?? "returned")}): the vendor is owed again. Check their details, then pay it again from the payment page.`);
    if (e.action === "autopilot.refused") flag("refused", e.obligationId, e.createdAt, String(detail.reason ?? "Policy refused at the last moment. No money moved."));
    if (e.action === "autopilot.cancelled") flag("cancelled_release", e.obligationId, e.createdAt, `Scheduled release cancelled by ${e.actor.replace(/^user:/, "")}.`);
    if (e.action === "execution.failed" || e.action === "settlement.failed") {
      if (byId.get(e.obligationId)?.state === "failed") flag("failed", e.obligationId, e.createdAt, String(detail.error ?? detail.externalStatus ?? "The provider rejected the payment."));
    }
    if (e.toState === "blocked" && byId.get(e.obligationId)?.state === "blocked") flag("blocked", e.obligationId, e.createdAt, byId.get(e.obligationId)?.blockedReason ?? null);
  }

  // Payments that went out but deserve a second look: a first payment to a vendor, an amount far above
  // that vendor's usual, or a payment a person approved over the policy's warnings.
  const settledHistory = db
    .select({ obligationId: settlements.obligationId, grossMinor: settlements.grossMinor, settledAt: settlements.settledAt, rail: settlements.rail })
    .from(settlements)
    .all();
  const settledById = new Map(settledHistory.map((h) => [h.obligationId, h]));
  // One line per vendor for things that are about the vendor, not the payment: a first payment, a missing tax form.
  const newVendorSeen = new Set<string>();
  const taxWarnedSeen = new Set<string>();
  for (const [id, s] of started) {
    const o = byId.get(id);
    if (!o || !o.vendorId || !["sent", "settled"].includes(o.state)) continue;
    const earlier = obs
      .filter((x) => x.vendorId === o.vendorId && x.id !== id && x.currency === o.currency && settledById.has(x.id) && settledById.get(x.id)!.settledAt < s.at)
      .map((x) => x.amountMinor ?? 0)
      .filter((a) => a > 0)
      .sort((a, b) => a - b);
    const name = o.vendorId ? vendorNames.get(o.vendorId) ?? "this vendor" : "this vendor";
    // Any earlier payment, in any currency or rail: Linh paid in USD before is not new because this one is in VND.
    const before = obs.filter((x) => x.vendorId === o.vendorId && x.id !== id && settledById.has(x.id) && settledById.get(x.id)!.settledAt < s.at);
    const rail = settledById.get(id)?.rail ?? o.selectedRail;
    const median = earlier.length >= 2 ? earlier[Math.floor(earlier.length / 2)] : 0;
    if (before.length === 0 && newVendorSeen.has(o.vendorId)) {
      // Already flagged for this vendor in this close.
    } else if (before.length === 0) {
      newVendorSeen.add(o.vendorId);
      flag("new_vendor", id, s.at, `First payment ever to ${name}. Check the payout details were confirmed with them directly.`);
    } else if (median > 0 && o.amountMinor && o.amountMinor >= median * 2) {
      const times = (o.amountMinor / median).toFixed(1);
      flag("unusual_amount", id, s.at, `${times} times ${name}'s usual payment (median of ${earlier.length} earlier payments).`);
    } else if (bankRail(rail) && !before.some((x) => bankRail(settledById.get(x.id)!.rail))) {
      // PayPal or Stellar before, a bank account now: a new destination for this vendor's money.
      const was = [...new Set(before.map((x) => railLabel(settledById.get(x.id)!.rail)))].join(", ");
      flag("new_vendor", id, s.at, `First payment to ${name}'s bank account (earlier ones went by ${was}). Check the account was confirmed with them directly.`);
    }
    const taxOnly = (w: string) => /W-8BEN|W-9|tax form/i.test(w);
    let warned = latestWarnings(db, id);
    if (taxWarnedSeen.has(o.vendorId)) warned = warned.filter((w) => !taxOnly(w));
    if (warned.some(taxOnly)) taxWarnedSeen.add(o.vendorId);
    if (warned.length && !s.actor.startsWith("agent:")) {
      flag("approved_over_warning", id, s.at, `Approved over ${warned.length} warning${warned.length === 1 ? "" : "s"}: ${warned.slice(0, 2).join("; ")}${warned.length > 2 ? "; ..." : ""}`);
    }
  }

  const order: AttentionItem["kind"][] = ["returned", "unknown_outcome", "payout_exception", "failed", "refused", "slow_settlement", "blocked", "approved_over_warning", "unusual_amount", "new_vendor", "cancelled_release"];
  attention.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.at.localeCompare(a.at));

  const waitingOnYou = obs
    .filter((o) => ["awaiting_approval", "needs_evidence"].includes(o.state) || (o.state === "approved" && !o.releaseAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((o) => item(o.id, o.updatedAt, o.state === "approved" ? "Approved, waiting for someone to send it" : o.state === "needs_evidence" ? "Needs evidence before it can be paid" : firstReason(o.policyReasonsJson))!)
    .filter(Boolean);

  const settingsChanges = entries
    .filter((e) => ["autonomy.changed", "autopilot.paused", "autopilot.resumed"].includes(e.action))
    .map((e) => ({ at: e.createdAt, actor: e.actor, action: e.action, detail: e.detailJson ? (JSON.parse(e.detailJson) as Record<string, unknown>) : null }));

  // Totals in the base currency at reference rates.
  const sum = (xs: CloseItem[]) => xs.reduce((a, x) => a + toBaseOrZero(x.amountMinor ?? 0, x.currency, baseCurrency), 0);
  const stopped = attention.filter((a) => a.kind === "blocked" || a.kind === "refused");

  return {
    since,
    sinceIsSignOff: !!last,
    lastSignOff: last ? { at: last.createdAt, actor: last.actor } : null,
    attention,
    paidByAgent,
    paidByPeople,
    inFlight,
    scheduled: autopilotStatus(db, businessId).scheduled,
    waitingOnYou,
    settingsChanges,
    totals: {
      agentMinor: sum(paidByAgent),
      agentCount: paidByAgent.length,
      peopleMinor: sum(paidByPeople),
      peopleCount: paidByPeople.length,
      feesMinor: [...paidByAgent, ...paidByPeople].reduce((a, x) => a + toBaseOrZero(x.feeMinor ?? 0, x.currency, baseCurrency), 0),
      stoppedMinor: sum(stopped),
      stoppedCount: stopped.length,
    },
    autopilot: autopilotStatus(db, businessId),
    baseCurrency,
    throughSeq,
  };
}

/** Warning-level rules that did not pass in the policy evaluation just before the payment started. */
function latestWarnings(db: Db, obligationId: string): string[] {
  const e = db
    .select()
    .from(auditEntries)
    .where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "policy.evaluated")))
    .orderBy(desc(auditEntries.seq))
    .limit(1)
    .get();
  if (!e?.detailJson) return [];
  const d = JSON.parse(e.detailJson) as { rules?: Array<{ passed: boolean; severity: string; message: string }> };
  return (d.rules ?? []).filter((r) => !r.passed && r.severity === "warn").map((r) => r.message);
}

function firstReason(json: string | null): string | null {
  try {
    const r = JSON.parse(json ?? "[]") as string[];
    return r[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Record that a person read the close. Changes no payment. The entry stores what they were shown,
 * so "reviewed" can later be checked against what was actually on the page.
 */
export function signOffDailyClose(db: Db, businessId: string, baseCurrency: string, actor: string, expectedThroughSeq?: number): { at: string } {
  if (!actor.startsWith("user:")) throw new Error("Only a person can sign off the daily close");
  const close = getDailyClose(db, businessId, baseCurrency);
  // If something happened after the page was rendered, the person has not seen it. Make them look again.
  if (expectedThroughSeq !== undefined && close.throughSeq !== expectedThroughSeq) throw new Error("Something changed since this page loaded. Review the update, then sign off.");
  audit(db, {
    obligationId: null,
    actor,
    action: CLOSE_ACTION,
    detail: {
      since: close.since,
      throughSeq: close.throughSeq,
      attention: close.attention.map((a) => ({ id: a.id, kind: a.kind })),
      paidByAgent: close.paidByAgent.map((p) => p.id),
      paidByPeople: close.paidByPeople.map((p) => p.id),
      totals: close.totals,
    },
  });
  const entry = db.select().from(auditEntries).where(and(eq(auditEntries.action, CLOSE_ACTION))).orderBy(desc(auditEntries.seq)).limit(1).get()!;
  return { at: entry.createdAt };
}

export function listSignOffs(db: Db, limit = 7): Array<{ at: string; actor: string; totals: DailyClose["totals"] | null; attentionCount: number }> {
  return db
    .select()
    .from(auditEntries)
    .where(eq(auditEntries.action, CLOSE_ACTION))
    .orderBy(desc(auditEntries.seq))
    .limit(limit)
    .all()
    .map((e) => {
      const d = e.detailJson ? (JSON.parse(e.detailJson) as { totals?: DailyClose["totals"]; attention?: unknown[] }) : {};
      return { at: e.createdAt, actor: e.actor, totals: d.totals ?? null, attentionCount: d.attention?.length ?? 0 };
    });
}
