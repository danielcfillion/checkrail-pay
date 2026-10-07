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
  kind: "unknown_outcome" | "failed" | "refused" | "blocked" | "cancelled_release" | "slow_settlement";
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

  for (const e of entries) {
    if (!e.obligationId) continue;
    const detail = e.detailJson ? (JSON.parse(e.detailJson) as Record<string, unknown>) : {};
    if (e.action === "autopilot.refused") flag("refused", e.obligationId, e.createdAt, String(detail.reason ?? "Policy refused at the last moment. No money moved."));
    if (e.action === "autopilot.cancelled") flag("cancelled_release", e.obligationId, e.createdAt, `Scheduled release cancelled by ${e.actor.replace(/^user:/, "")}.`);
    if (e.action === "execution.failed" || e.action === "settlement.failed") {
      if (byId.get(e.obligationId)?.state === "failed") flag("failed", e.obligationId, e.createdAt, String(detail.error ?? detail.externalStatus ?? "The provider rejected the payment."));
    }
    if (e.toState === "blocked" && byId.get(e.obligationId)?.state === "blocked") flag("blocked", e.obligationId, e.createdAt, byId.get(e.obligationId)?.blockedReason ?? null);
  }

  const order: AttentionItem["kind"][] = ["unknown_outcome", "failed", "refused", "slow_settlement", "blocked", "cancelled_release"];
  attention.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.at.localeCompare(a.at));

  const waitingOnYou = obs
    .filter((o) => ["awaiting_approval", "needs_evidence"].includes(o.state) || (o.state === "approved" && !o.releaseAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((o) => item(o.id, o.updatedAt, o.state === "approved" ? "Approved, waiting for someone to send it" : o.state === "needs_evidence" ? "Needs evidence before it can be paid" : firstReason(o.policyReasonsJson))!)
    .filter(Boolean);

  const settingsChanges = entries
    .filter((e) => ["autonomy.changed", "autopilot.paused", "autopilot.resumed"].includes(e.action))
    .map((e) => ({ at: e.createdAt, actor: e.actor, action: e.action, detail: e.detailJson ? (JSON.parse(e.detailJson) as Record<string, unknown>) : null }));

  const inBase = (xs: CloseItem[]) => xs.filter((x) => x.currency === baseCurrency);
  const sum = (xs: CloseItem[]) => inBase(xs).reduce((a, x) => a + (x.amountMinor ?? 0), 0);
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
      feesMinor: [...paidByAgent, ...paidByPeople].reduce((a, x) => a + (x.feeMinor ?? 0), 0),
      stoppedMinor: sum(stopped),
      stoppedCount: stopped.length,
    },
    autopilot: autopilotStatus(db, businessId),
    baseCurrency,
    throughSeq,
  };
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
