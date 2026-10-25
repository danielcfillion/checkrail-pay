import { fmt } from "../domain/policy";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, paymentRunItems, paymentRuns, users, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import type { Rail } from "../domain/types";
import { getRails } from "../rails";
import { localDateString } from "../format";
import { actorCan, requirePermission, whoIs, type Actor } from "./users";
import { approvalGate, approveObligation, executeObligation } from "./orchestrator";
import { can, isRole } from "../auth/roles";

/**
 * Payment runs: the clerk gathers what is due into one list, the approver reviews the total and the funding, and
 * releases it once. Releasing approves the items still waiting (within the releaser's limit, never their own
 * requests) and pays every approved item through the normal execute path, one by one, each under its own
 * idempotency key. Nothing about a single payment's checks is skipped because it is in a run.
 */

const ELIGIBLE = ["approved", "awaiting_approval"] as const;
const OPEN_RUN = ["draft", "releasing"];
const MAX_ITEMS = 200;

export type RunItemStatus = "queued" | "paid" | "skipped" | "failed" | "unclear";

/** Obligations that could go into a new run: approved or awaiting approval, and not already in an open run. */
export function runCandidates(db: Db, businessId: string) {
  const inRun = new Set(
    db
      .select({ id: paymentRunItems.obligationId })
      .from(paymentRunItems)
      .innerJoin(paymentRuns, eq(paymentRuns.id, paymentRunItems.runId))
      .where(and(eq(paymentRuns.businessId, businessId), inArray(paymentRuns.status, OPEN_RUN)))
      .all()
      .map((r) => r.id),
  );
  return db
    .select({ id: obligations.id, state: obligations.state, amountMinor: obligations.amountMinor, currency: obligations.currency, dueDate: obligations.dueDate, sourceRef: obligations.sourceRef, selectedRail: obligations.selectedRail, releaseAt: obligations.releaseAt, vendorName: vendors.name })
    .from(obligations)
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), inArray(obligations.state, [...ELIGIBLE])))
    .all()
    .filter((o) => !inRun.has(o.id) && o.amountMinor !== null && o.currency)
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

export function createRun(db: Db, businessId: string, by: Actor, input: { name?: string; obligationIds: unknown }): string {
  requirePermission(by, "build_run", "build payment runs");
  const ids = Array.isArray(input.obligationIds) ? [...new Set(input.obligationIds.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length) throw new Error("Choose at least one payment for the run");
  if (ids.length > MAX_ITEMS) throw new Error(`A run holds at most ${MAX_ITEMS} payments`);
  const name = (typeof input.name === "string" && input.name.trim() ? input.name.trim() : `Run ${localDateString()}`).slice(0, 60);
  const candidates = new Map(runCandidates(db, businessId).map((c) => [c.id, c]));
  const missing = ids.filter((id) => !candidates.has(id));
  if (missing.length) throw new Error(`${missing.length} of these cannot go in a run (not approved or waiting for approval, or already in another run)`);
  const runId = newId("run");
  const ts = now();
  db.transaction((tx) => {
    tx.insert(paymentRuns).values({ id: runId, businessId, name, status: "draft", createdBy: by.id, createdAt: ts }).run();
    for (const id of ids) {
      const c = candidates.get(id)!;
      tx.insert(paymentRunItems).values({ id: newId("rni"), runId, obligationId: id, amountMinor: c.amountMinor!, currency: c.currency!, rail: c.selectedRail, status: "queued", createdAt: ts }).run();
    }
  });
  audit(db, { obligationId: null, actor: by.id, action: "run.created", detail: { runId, name, items: ids.length } });
  return runId;
}

export function removeRunItem(db: Db, businessId: string, by: Actor, runId: string, itemId: string): void {
  requirePermission(by, "build_run", "change payment runs");
  const run = mustRun(db, businessId, runId);
  if (run.status !== "draft") throw new Error("Only a draft run can change");
  const res = db.delete(paymentRunItems).where(and(eq(paymentRunItems.id, itemId), eq(paymentRunItems.runId, runId))).run();
  if (res.changes !== 1) throw new Error("No such item in this run");
  audit(db, { obligationId: null, actor: by.id, action: "run.item_removed", detail: { runId, itemId } });
}

export function cancelRun(db: Db, businessId: string, by: Actor, runId: string): void {
  if (!actorCan(by, "build_run") && !actorCan(by, "release_run")) requirePermission(by, "build_run", "cancel payment runs");
  const res = db.update(paymentRuns).set({ status: "cancelled", cancelledBy: by.id }).where(and(eq(paymentRuns.id, runId), eq(paymentRuns.businessId, businessId), eq(paymentRuns.status, "draft"))).run();
  if (res.changes !== 1) throw new Error("Only a draft run can be cancelled");
  audit(db, { obligationId: null, actor: by.id, action: "run.cancelled", detail: { runId } });
}

export interface RunView {
  run: typeof paymentRuns.$inferSelect;
  items: Array<typeof paymentRunItems.$inferSelect & { state: string | null; vendorName: string | null; sourceRef: string | null; dueDate: string | null; changed: boolean; approvalNote: string | null }>;
  totals: Array<{ currency: string; rail: string; totalMinor: number; count: number; balance: { availableMinor: number; source: string } | null; short: boolean }>;
  /** Why this viewer cannot release the run, when they cannot. */
  releaseRefusal: string | null;
}

/** The run as the releaser sees it: each item's current state, totals per rail and currency, and what is in the account. */
export async function viewRun(db: Db, businessId: string, runId: string, viewer: Actor | null): Promise<RunView> {
  const run = mustRun(db, businessId, runId);
  const rows = db.select().from(paymentRunItems).where(eq(paymentRunItems.runId, runId)).all();
  const obs = rows.length ? db.select({ id: obligations.id, state: obligations.state, amountMinor: obligations.amountMinor, currency: obligations.currency, sourceRef: obligations.sourceRef, dueDate: obligations.dueDate, vendorName: vendors.name }).from(obligations).leftJoin(vendors, eq(vendors.id, obligations.vendorId)).where(inArray(obligations.id, rows.map((r) => r.obligationId))).all() : [];
  const byId = new Map(obs.map((o) => [o.id, o]));
  const items = rows.map((r) => {
    const o = byId.get(r.obligationId);
    const changed = !!o && (o.amountMinor !== r.amountMinor || o.currency !== r.currency);
    const approvalNote = viewer && actorCan(viewer, "release_run") && o?.state === "awaiting_approval" ? approvalGate(db, r.obligationId, viewer.id).refusal : null;
    return { ...r, state: o?.state ?? null, vendorName: o?.vendorName ?? null, sourceRef: o?.sourceRef ?? null, dueDate: o?.dueDate ?? null, changed, approvalNote };
  });
  const groups = new Map<string, { currency: string; rail: string; totalMinor: number; count: number }>();
  for (const it of items) {
    if (run.status === "draft" ? !["approved", "awaiting_approval"].includes(it.state ?? "") : it.status !== "paid") continue;
    const key = `${it.rail ?? "unrouted"}|${it.currency}`;
    const g = groups.get(key) ?? { currency: it.currency, rail: it.rail ?? "unrouted", totalMinor: 0, count: 0 };
    g.totalMinor += it.amountMinor;
    g.count += 1;
    groups.set(key, g);
  }
  const rails = getRails();
  const totals = await Promise.all(
    [...groups.values()].map(async (g) => {
      const adapter = g.rail === "paypal" || g.rail === "stellar" ? rails[g.rail as Rail] : null;
      const b = run.status === "draft" && adapter?.balance ? await adapter.balance(g.currency).catch(() => null) : null;
      return { ...g, balance: b ? { availableMinor: b.availableMinor, source: b.source } : null, short: !!b && b.availableMinor < g.totalMinor };
    }),
  );
  return { run, items, totals, releaseRefusal: viewer ? releaseBarrier(db, businessId, viewer, run) : null };
}

function releaseBarrier(db: Db, businessId: string, by: Actor, run: typeof paymentRuns.$inferSelect): string | null {
  if (!actorCan(by, "release_run")) return `${whoIs(by)} cannot release payment runs. An approver or the owner does.`;
  if (run.createdBy === by.id) {
    const others = db
      .select()
      .from(users)
      .where(and(eq(users.businessId, businessId), eq(users.active, true)))
      .all()
      .filter((u) => isRole(u.role) && can(u.role, "release_run") && `user:${u.id}` !== by.id)
      .map((u) => u.id);
    if (others.length) return `You built this run, so someone else releases it (${others.join(", ")} can).`;
  }
  return null;
}

/**
 * Release a draft run. Refuses before paying anything when a rail's balance is known and short. Then, item by item:
 * approve what is waiting (if this person may), pay what is approved, and record what happened to each one.
 */
export async function releaseRun(db: Db, businessId: string, by: Actor, runId: string): Promise<{ paid: number; skipped: number; failed: number; unclear: number }> {
  requirePermission(by, "release_run", "release payment runs");
  const run = mustRun(db, businessId, runId);
  // A release that stopped part way (a crash, a restart) is finished by the same person: only queued items are left.
  const resuming = run.status === "releasing" && run.releasedBy === by.id;
  if (run.status !== "draft" && !resuming) throw new Error(`This run is ${run.status}${run.status === "releasing" ? ` by ${run.releasedBy?.replace(/^user:/, "")}` : ""}`);
  const barrier = releaseBarrier(db, businessId, by, run);
  if (barrier) throw new Error(barrier);
  const view = await viewRun(db, businessId, runId, by);
  if (!resuming) {
    const short = view.totals.filter((t) => t.short);
    if (short.length) throw new Error(`Not enough money: ${short.map((t) => `${t.rail} needs ${fmt(t.totalMinor, t.currency)}, has ${fmt(t.balance!.availableMinor, t.currency)}`).join("; ")}. Top up or remove payments, then release.`);
    // Claim the run, so two people pressing Release cannot both pay it.
    const claimed = db.update(paymentRuns).set({ status: "releasing", releasedBy: by.id }).where(and(eq(paymentRuns.id, runId), eq(paymentRuns.status, "draft"))).run();
    if (claimed.changes !== 1) throw new Error("Someone else is releasing this run");
    audit(db, { obligationId: null, actor: by.id, action: "run.release_started", detail: { runId, items: view.items.length } });
  }

  const counts = { paid: 0, skipped: 0, failed: 0, unclear: 0 };
  const finish = (itemId: string, status: RunItemStatus, message: string | null) => {
    db.update(paymentRunItems).set({ status, message, finishedAt: now() }).where(eq(paymentRunItems.id, itemId)).run();
    if (status !== "queued") counts[status] += 1;
  };
  for (const it of view.items) {
    if (it.status !== "queued") continue;
    try {
      const ob = db.select().from(obligations).where(eq(obligations.id, it.obligationId)).get();
      if (!ob) {
        finish(it.id, "skipped", "No longer exists");
        continue;
      }
      if (ob.amountMinor !== it.amountMinor || ob.currency !== it.currency) {
        finish(it.id, "skipped", "Amount changed after it was added to the run; review it on its own page");
        continue;
      }
      if (ob.state === "awaiting_approval") {
        const gate = approvalGate(db, ob.id, by.id);
        if (gate.refusal) {
          finish(it.id, "skipped", gate.refusal);
          continue;
        }
        approveObligation(db, ob.id, by.id, `Approved in payment run ${run.name}`);
      }
      const now_ = db.select({ state: obligations.state }).from(obligations).where(eq(obligations.id, ob.id)).get()!.state;
      if (now_ === "awaiting_approval") {
        finish(it.id, "skipped", "Needs another person's approval too (above the dual-approval amount)");
        continue;
      }
      if (now_ !== "approved") {
        finish(it.id, "skipped", now_ === "sent" || now_ === "settled" ? "Already paid" : `Not payable now (${now_.replace(/_/g, " ")})`);
        continue;
      }
      await executeObligation(db, ob.id, { actor: by.id, rail: (it.rail as Rail | null) ?? undefined });
      const after = db.select({ state: obligations.state }).from(obligations).where(eq(obligations.id, ob.id)).get()!.state;
      if (after === "sent" || after === "settled") finish(it.id, "paid", null);
      else if (after === "execution_pending") finish(it.id, "unclear", "The rail did not give a clear answer; reconcile it on its page before anything else");
      else finish(it.id, "failed", `Ended ${after.replace(/_/g, " ")}`);
    } catch (e) {
      finish(it.id, "failed", (e as Error).message.slice(0, 300));
    }
  }
  db.update(paymentRuns).set({ status: "released", releasedAt: now() }).where(eq(paymentRuns.id, runId)).run();
  audit(db, { obligationId: null, actor: by.id, action: "run.released", detail: { runId, ...counts } });
  return counts;
}

export function listRuns(db: Db, businessId: string) {
  const runs = db.select().from(paymentRuns).where(eq(paymentRuns.businessId, businessId)).all().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs.map((r) => {
    const items = db.select().from(paymentRunItems).where(eq(paymentRunItems.runId, r.id)).all();
    const total = new Map<string, number>();
    for (const i of items) total.set(i.currency, (total.get(i.currency) ?? 0) + i.amountMinor);
    return { ...r, count: items.length, paid: items.filter((i) => i.status === "paid").length, totals: [...total.entries()].map(([currency, minor]) => ({ currency, minor })) };
  });
}

function mustRun(db: Db, businessId: string, runId: string) {
  const r = db.select().from(paymentRuns).where(and(eq(paymentRuns.id, runId), eq(paymentRuns.businessId, businessId))).get();
  if (!r) throw new Error("No such run");
  return r;
}
