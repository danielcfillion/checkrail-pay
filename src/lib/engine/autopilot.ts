import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db";
import { businesses, obligations, vendors } from "../db/schema";
import { DEFAULT_POLICY, effectiveAutonomy, type ApprovalPolicy } from "../domain/types";
import { audit } from "../domain/stateMachine";
import { now } from "../domain/ids";
import { confirmSettlement, executeObligation, mustGet, scheduleAutopilotRelease } from "./orchestrator";

/**
 * Autopilot runner.
 *
 * Autonomy only removes the approval step. A payment reaches this file only if policy already said
 * "auto_execute" (so no block, hold, warning, mismatch, duplicate or changed payout destination),
 * and executeObligation re-runs policy again before it touches a rail. Caps are enforced in policy.
 * What this file adds is time (a cancel window), a pause switch, and an audit trail naming the agent.
 */

export const AGENT_ACTOR = "agent:autopilot";

export function readPolicy(db: Db, businessId: string): ApprovalPolicy {
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!biz) throw new Error("Unknown business");
  return { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
}

function writePolicy(db: Db, businessId: string, policy: ApprovalPolicy): void {
  db.update(businesses).set({ policyJson: JSON.stringify(policy) }).where(eq(businesses.id, businessId)).run();
}

let running: Promise<TickResult> | null = null;

export interface TickResult {
  released: string[];
  refused: Array<{ id: string; reason: string }>;
  scheduled: string[];
  confirmed: string[];
}

/**
 * One pass: schedule anything newly eligible, release whatever's cancel window has ended, and poll
 * sent payments for settlement. Safe to call often and from more than one place: overlapping calls
 * share one run.
 */
export function runAutopilot(db: Db, opts: { businessId?: string } = {}): Promise<TickResult> {
  if (running) return running;
  running = tick(db, opts).finally(() => {
    running = null;
  });
  return running;
}

async function tick(db: Db, opts: { businessId?: string }): Promise<TickResult> {
  const result: TickResult = { released: [], refused: [], scheduled: [], confirmed: [] };
  const bizRows = db.select().from(businesses).all().filter((b) => !opts.businessId || b.id === opts.businessId);

  for (const biz of bizRows) {
    const policy = readPolicy(db, biz.id);
    const active = effectiveAutonomy(policy) === "autopilot";

    // Sweep: approved, clean, not yet scheduled (autopilot just switched on or resumed).
    if (active) {
      const waiting = db.select().from(obligations).where(and(eq(obligations.businessId, biz.id), eq(obligations.state, "approved"), eq(obligations.policyDecision, "auto_execute"))).all();
      for (const w of waiting) {
        if (!w.releaseAt && !w.autopilotCancelledAt) {
          scheduleAutopilotRelease(db, w.id);
          result.scheduled.push(w.id);
        }
      }
    }

    // Release: cancel window over.
    const due = db
      .select()
      .from(obligations)
      .where(and(eq(obligations.businessId, biz.id), eq(obligations.state, "approved"), isNotNull(obligations.releaseAt), lte(obligations.releaseAt, now())))
      .all();
    for (const o of due) {
      if (o.autopilotCancelledAt) continue;
      if (!active) {
        // Paused or switched down while the payment waited: it stays approved for a person to send.
        db.update(obligations).set({ releaseAt: null, updatedAt: now() }).where(eq(obligations.id, o.id)).run();
        audit(db, { obligationId: o.id, actor: AGENT_ACTOR, action: "autopilot.stood_down", detail: { reason: policy.autopilotPaused ? "paused" : "autonomy lowered" } });
        continue;
      }
      // Clear first: a failed attempt that is later retried must not fire again on its own.
      db.update(obligations).set({ releaseAt: null, updatedAt: now() }).where(eq(obligations.id, o.id)).run();
      try {
        audit(db, { obligationId: o.id, actor: AGENT_ACTOR, action: "autopilot.releasing", detail: { amountMinor: o.amountMinor, currency: o.currency } });
        await executeObligation(db, o.id, { actor: AGENT_ACTOR });
        result.released.push(o.id);
      } catch (e) {
        // Policy or the safety checks refused at the last moment (changed payout details, new duplicate, cap). No money moved.
        const reason = (e as Error).message;
        audit(db, { obligationId: o.id, actor: AGENT_ACTOR, action: "autopilot.refused", detail: { reason } });
        result.refused.push({ id: o.id, reason });
      }
    }

    // Settlement polling for anything in flight.
    const inFlight = db.select().from(obligations).where(and(eq(obligations.businessId, biz.id), eq(obligations.state, "sent"))).all();
    for (const o of inFlight) {
      try {
        const state = await confirmSettlement(db, o.id, "autopilot");
        if (state === "settled") result.confirmed.push(o.id);
      } catch {
        /* leave it for the next pass */
      }
    }
  }
  return result;
}

/** A person cancels a scheduled release. The payment stays approved and can still be sent by hand. */
export function cancelAutopilotRelease(db: Db, obligationId: string, actor: string): void {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "approved" || !ob.releaseAt) throw new Error("Nothing is scheduled for this payment, or it has already been sent");
  db.update(obligations).set({ releaseAt: null, autopilotCancelledAt: now(), updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor, action: "autopilot.cancelled", detail: { wasScheduledFor: ob.releaseAt } });
}

/** Pause or resume autopilot without losing its settings. Pausing also clears pending releases; they return to "approved, send by hand". */
export function setAutopilotPaused(db: Db, businessId: string, actor: string, paused: boolean): void {
  const policy = readPolicy(db, businessId);
  writePolicy(db, businessId, { ...policy, autopilotPaused: paused });
  audit(db, { obligationId: null, actor, action: paused ? "autopilot.paused" : "autopilot.resumed", detail: {} });
  if (paused) standDown(db, businessId, actor, "paused");
}

/** Clear every pending release for a business. The payments stay approved for a person to send. */
function standDown(db: Db, businessId: string, actor: string, reason: string): void {
  const scheduled = db.select().from(obligations).where(and(eq(obligations.businessId, businessId), eq(obligations.state, "approved"), isNotNull(obligations.releaseAt))).all();
  for (const o of scheduled) {
    db.update(obligations).set({ releaseAt: null, updatedAt: now() }).where(eq(obligations.id, o.id)).run();
    audit(db, { obligationId: o.id, actor, action: "autopilot.stood_down", detail: { reason } });
  }
}

export interface AutonomyChange {
  autonomy?: "review" | "assist" | "autopilot";
  autopilotPerPaymentCapMinor?: number;
  autopilotDailyCapMinor?: number;
  autopilotCancelWindowSeconds?: number;
}

/** Validate and apply autonomy settings. The caller (a server action) is responsible for requiring a signed-in person. */
export function setAutonomy(db: Db, businessId: string, actor: string, change: AutonomyChange): ApprovalPolicy {
  const policy = readPolicy(db, businessId);
  const next: ApprovalPolicy = { ...policy };
  if (change.autonomy !== undefined) {
    if (!["review", "assist", "autopilot"].includes(change.autonomy)) throw new Error("Unknown autonomy level");
    next.autonomy = change.autonomy;
  }
  const num = (v: unknown, name: string, max: number): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) throw new Error(`${name} must be a whole number between 0 and ${max}`);
    return v;
  };
  if (change.autopilotPerPaymentCapMinor !== undefined) next.autopilotPerPaymentCapMinor = num(change.autopilotPerPaymentCapMinor, "Per-payment cap", 100_000_000);
  if (change.autopilotDailyCapMinor !== undefined) next.autopilotDailyCapMinor = num(change.autopilotDailyCapMinor, "Daily cap", 1_000_000_000);
  if (change.autopilotCancelWindowSeconds !== undefined) next.autopilotCancelWindowSeconds = num(change.autopilotCancelWindowSeconds, "Cancel window", 86_400);
  writePolicy(db, businessId, next);
  if (effectiveAutonomy(next) !== "autopilot") standDown(db, businessId, actor, "autonomy lowered");
  audit(db, { obligationId: null, actor, action: "autonomy.changed", detail: { from: { autonomy: policy.autonomy, perPaymentCap: policy.autopilotPerPaymentCapMinor, dailyCap: policy.autopilotDailyCapMinor, windowSeconds: policy.autopilotCancelWindowSeconds }, to: { autonomy: next.autonomy, perPaymentCap: next.autopilotPerPaymentCapMinor, dailyCap: next.autopilotDailyCapMinor, windowSeconds: next.autopilotCancelWindowSeconds } } });
  return next;
}

export interface AutopilotStatus {
  level: "review" | "assist" | "autopilot";
  paused: boolean;
  perPaymentCapMinor: number;
  dailyCapMinor: number;
  cancelWindowSeconds: number;
  committed24hMinor: number;
  scheduled: Array<{ id: string; vendorName: string | null; amountMinor: number | null; currency: string | null; releaseAt: string }>;
}

export function autopilotStatus(db: Db, businessId: string): AutopilotStatus {
  const policy = readPolicy(db, businessId);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = db.select().from(obligations).where(eq(obligations.businessId, businessId)).orderBy(desc(obligations.updatedAt)).all();
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get()!;
  const committed = rows.filter((o) => o.currency === biz.baseCurrency && o.updatedAt >= since && (["execution_pending", "sent", "settled"].includes(o.state) || (o.state === "approved" && !!o.releaseAt))).reduce((sum, o) => sum + (o.amountMinor ?? 0), 0);
  const vendorNames = new Map(db.select().from(vendors).where(eq(vendors.businessId, businessId)).all().map((v) => [v.id, v.name]));
  return {
    level: policy.autonomy ?? "assist",
    paused: !!policy.autopilotPaused,
    perPaymentCapMinor: policy.autopilotPerPaymentCapMinor ?? 0,
    dailyCapMinor: policy.autopilotDailyCapMinor ?? 0,
    cancelWindowSeconds: policy.autopilotCancelWindowSeconds ?? 0,
    committed24hMinor: committed,
    scheduled: rows.filter((o) => o.state === "approved" && o.releaseAt).map((o) => ({ id: o.id, vendorName: o.vendorId ? vendorNames.get(o.vendorId) ?? null : null, amountMinor: o.amountMinor, currency: o.currency, releaseAt: o.releaseAt! })),
  };
}
