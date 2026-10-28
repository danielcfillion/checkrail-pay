import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "./db";
import { accountingSyncs, approvals, attachments, auditEntries, businesses, evidence, obligations, paymentAttempts, routeQuotes, settlements, vendors } from "./db/schema";
import type { ObligationState, Rail } from "./domain/types";
import { railModes } from "./rails";
import { config, isLiveAi } from "./config";
import { startOfLocalDay } from "./format";
import { actorCan, type Actor } from "./engine/users";
import { toBaseOrZero } from "./fx";
import { approvalGate } from "./engine/orchestrator";

/**
 * Read models for the operator dashboard. Plain functions over the DB, no
 * business logic. Every screen in the app is built from these.
 */

export type ObligationRow = typeof obligations.$inferSelect & { vendorName: string | null; vendorRole: string | null; vendorCountry: string | null };

export function getBusiness(db: Db = getDb()) {
  return db.select().from(businesses).limit(1).get() ?? null;
}

export function listObligations(opts: { states?: ObligationState[]; vendorId?: string; limit?: number } = {}, db: Db = getDb()): ObligationRow[] {
  const conds = [];
  if (opts.states?.length) conds.push(inArray(obligations.state, opts.states));
  if (opts.vendorId) conds.push(eq(obligations.vendorId, opts.vendorId));
  const rows = db
    .select({ o: obligations, vendorName: vendors.name, vendorRole: vendors.role, vendorCountry: vendors.country })
    .from(obligations)
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(obligations.updatedAt))
    .limit(opts.limit ?? 200)
    .all();
  return rows.map((r) => ({ ...r.o, vendorName: r.vendorName, vendorRole: r.vendorRole, vendorCountry: r.vendorCountry }));
}

export function getObligationDetail(id: string, db: Db = getDb()) {
  const row = db.select({ o: obligations, vendorName: vendors.name, vendorRole: vendors.role, vendorCountry: vendors.country }).from(obligations).leftJoin(vendors, eq(vendors.id, obligations.vendorId)).where(eq(obligations.id, id)).get();
  if (!row) return null;
  const vendor = row.o.vendorId ? db.select().from(vendors).where(eq(vendors.id, row.o.vendorId)).get() ?? null : null;
  return {
    obligation: { ...row.o, vendorName: row.vendorName, vendorRole: row.vendorRole, vendorCountry: row.vendorCountry } as ObligationRow,
    vendor,
    evidence: db.select().from(evidence).where(eq(evidence.obligationId, id)).all(),
    attachments: db.select({ id: attachments.id, name: attachments.name, mimeType: attachments.mimeType, sizeBytes: attachments.sizeBytes, reader: attachments.reader, sha256: attachments.sha256 }).from(attachments).where(eq(attachments.obligationId, id)).all(),
    quotes: db.select().from(routeQuotes).where(eq(routeQuotes.obligationId, id)).all(),
    approvals: db.select().from(approvals).where(eq(approvals.obligationId, id)).orderBy(approvals.createdAt).all(),
    attempts: db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).orderBy(paymentAttempts.createdAt).all(),
    settlement: db.select().from(settlements).where(eq(settlements.obligationId, id)).get() ?? null,
    accounting: db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, id)).get() ?? null,
    audit: db.select().from(auditEntries).where(eq(auditEntries.obligationId, id)).orderBy(auditEntries.seq).all(),
    aiFlags: JSON.parse(row.o.aiFlagsJson ?? "[]") as string[],
    aiMissing: JSON.parse(row.o.aiMissingJson ?? "[]") as string[],
    policyReasons: JSON.parse(row.o.policyReasonsJson ?? "[]") as string[],
    policyRules: latestPolicyRules(id, db),
    agentRun: latestAgentRun(id, db),
    payoutException: row.o.state === "sent" ? latestPayoutException(id, db) : null,
  };
}

export type AgentRunView = { engine: "claude" | "rules"; model: string | null; notes: string[]; toolCalls: Array<{ name: string; input: string; resultPreview: string }> };

function latestAgentRun(id: string, db: Db): AgentRunView | null {
  const e = db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, id), eq(auditEntries.action, "ai.interpreted"))).orderBy(desc(auditEntries.seq)).get();
  if (!e?.detailJson) return null;
  const d = JSON.parse(e.detailJson) as { engine?: string; model?: string | null; notes?: unknown[]; toolCalls?: unknown[] };
  const calls = (d.toolCalls ?? []).map((t) => (typeof t === "string" ? { name: t, input: "", resultPreview: "" } : (t as { name: string; input: string; resultPreview: string })));
  const engine = d.engine === "claude" || e.actor.startsWith("ai:") && e.actor !== "ai:rules" ? "claude" : "rules";
  return { engine, model: d.model ?? null, notes: (d.notes ?? []).map(String), toolCalls: calls };
}

/** The provider's last word on a sent payment when it needs a person (for example an unclaimed PayPal payout). */
function latestPayoutException(id: string, db: Db): { externalStatus: string | null; message: string; at: string } | null {
  const e = db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, id), eq(auditEntries.action, "settlement.exception"))).orderBy(desc(auditEntries.seq)).get();
  if (!e?.detailJson) return null;
  const d = JSON.parse(e.detailJson) as { externalStatus?: string | null; message?: string };
  return { externalStatus: d.externalStatus ?? null, message: d.message ?? "The provider needs a person to look at this payout.", at: e.createdAt };
}

function latestPolicyRules(id: string, db: Db) {
  const e = db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, id), eq(auditEntries.action, "policy.evaluated"))).orderBy(desc(auditEntries.seq)).get();
  if (!e?.detailJson) return [] as Array<{ ruleId: string; passed: boolean; severity: string; message: string }>;
  return (JSON.parse(e.detailJson) as { rules: Array<{ ruleId: string; passed: boolean; severity: string; message: string }> }).rules ?? [];
}

export function listVendors(db: Db = getDb()) {
  const vs = db.select().from(vendors).orderBy(vendors.name).all();
  return vs.map((v) => {
    const obs = db.select({ state: obligations.state, amountMinor: obligations.amountMinor }).from(obligations).where(eq(obligations.vendorId, v.id)).all();
    const st = db.select({ gross: settlements.grossMinor, currency: settlements.grossCurrency, rail: settlements.rail, settledAt: settlements.settledAt }).from(settlements).innerJoin(obligations, eq(obligations.id, settlements.obligationId)).where(eq(obligations.vendorId, v.id)).orderBy(desc(settlements.settledAt)).all();
    return {
      ...v,
      obligationCount: obs.length,
      openCount: obs.filter((o) => !["settled", "cancelled", "refunded"].includes(o.state)).length,
      paidMinor: st.reduce((a, s) => a + toBaseOrZero(s.gross, s.currency, getBusiness(db)?.baseCurrency ?? "USD"), 0),
      lastPaidAt: st[0]?.settledAt ?? null,
      railsUsed: Array.from(new Set(st.map((s) => s.rail))) as Rail[],
    };
  });
}

export function getVendorDetail(id: string, db: Db = getDb()) {
  const v = db.select().from(vendors).where(eq(vendors.id, id)).get();
  if (!v) return null;
  return { vendor: v, obligations: listObligations({ vendorId: id }, db) };
}

export function listSettlements(db: Db = getDb()) {
  return db
    .select({ s: settlements, o: obligations, vendorName: vendors.name, vendorCountry: vendors.country })
    .from(settlements)
    .innerJoin(obligations, eq(obligations.id, settlements.obligationId))
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .orderBy(desc(settlements.settledAt))
    .all()
    .map((r) => ({ ...r.s, obligation: r.o, vendorName: r.vendorName, vendorCountry: r.vendorCountry }));
}

/** grossMinor and feeMinor are in the base currency (for totals and the chart); paid* are what actually went out. */
export type PaymentPoint = { id: string; vendorName: string | null; sourceRef: string | null; rail: string; grossMinor: number; feeMinor: number; currency: string; paidMinor: number; paidFeeMinor: number; paidCurrency: string; settledAt: string; by: "agent" | "person" | "unknown" };

/** Settled payments in the last `days`, each tagged with who started it. Feeds the overview chart. */
export function listPaymentPoints(days = 120, db: Db = getDb()): PaymentPoint[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const base = getBusiness(db)?.baseCurrency ?? "USD";
  const starters = new Map<string, string>();
  for (const e of db.select({ obligationId: auditEntries.obligationId, actor: auditEntries.actor }).from(auditEntries).where(eq(auditEntries.toState, "execution_pending")).orderBy(auditEntries.seq).all()) {
    if (e.obligationId) starters.set(e.obligationId, e.actor);
  }
  return listSettlements(db)
    .filter((s) => s.settledAt >= since)
    .map((s) => {
      const actor = starters.get(s.obligationId) ?? "";
      return { id: s.obligationId, vendorName: s.vendorName, sourceRef: s.obligation.sourceRef, rail: s.rail, grossMinor: toBaseOrZero(s.grossMinor, s.grossCurrency, base), feeMinor: toBaseOrZero(s.feeMinor, s.grossCurrency, base), currency: base, paidMinor: s.grossMinor, paidFeeMinor: s.feeMinor, paidCurrency: s.grossCurrency, settledAt: s.settledAt, by: actor.startsWith("agent:") ? "agent" : actor.startsWith("user:") ? "person" : "unknown" };
    });
}

export function listAccountingSyncs(db: Db = getDb()) {
  return db
    .select({ a: accountingSyncs, o: obligations, vendorName: vendors.name })
    .from(accountingSyncs)
    .innerJoin(obligations, eq(obligations.id, accountingSyncs.obligationId))
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .orderBy(desc(accountingSyncs.createdAt))
    .all()
    .map((r) => ({ ...r.a, obligation: r.o, vendorName: r.vendorName, payload: JSON.parse(r.a.payloadJson ?? "{}") as Record<string, string | null> }));
}

export function listAudit(limit = 100, db: Db = getDb(), beforeSeq?: number) {
  return db
    .select({ a: auditEntries, sourceRef: obligations.sourceRef, vendorName: vendors.name })
    .from(auditEntries)
    .leftJoin(obligations, eq(obligations.id, auditEntries.obligationId))
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(beforeSeq ? lt(auditEntries.seq, beforeSeq) : undefined)
    .orderBy(desc(auditEntries.seq))
    .limit(limit)
    .all()
    .map((r) => ({ ...r.a, sourceRef: r.sourceRef, vendorName: r.vendorName, detail: r.a.detailJson ? (JSON.parse(r.a.detailJson) as Record<string, unknown>) : null }));
}

export function getOverview(db: Db = getDb()) {
  const all = listObligations({ limit: 1000 }, db);
  const openStates: ObligationState[] = ["drafted", "needs_evidence", "verified", "awaiting_approval", "approved", "execution_pending", "sent"];
  // Every total is in the base currency at reference rates.
  const base = getBusiness(db)?.baseCurrency ?? "USD";
  const sum = (rows: ObligationRow[]) => rows.reduce((a, r) => a + toBaseOrZero(r.amountMinor ?? 0, r.currency, base), 0);
  const gross = (s: { grossMinor: number; grossCurrency: string }) => toBaseOrZero(s.grossMinor, s.grossCurrency, base);
  const fee = (s: { feeMinor: number; grossCurrency: string }) => toBaseOrZero(s.feeMinor, s.grossCurrency, base);
  const now = Date.now();
  const thirtyDays = now - 30 * 86_400_000;
  const settled = listSettlements(db);
  const settledRecent = settled.filter((s) => new Date(s.settledAt).getTime() >= thirtyDays);
  const startOfToday = startOfLocalDay();
  const settledToday = settled.filter((s) => new Date(s.settledAt).getTime() >= startOfToday.getTime());
  const blocked = all.filter((r) => r.state === "blocked");
  const byRail = (rail: Rail) => settledRecent.filter((s) => s.rail === rail);
  const feesByRail = (rail: Rail) => byRail(rail).reduce((a, s) => a + fee(s), 0);
  const grossByRail = (rail: Rail) => byRail(rail).reduce((a, s) => a + gross(s), 0);

  // 8-week weekly volume series for a sparkline
  const weeks: Array<{ label: string; paypal: number; stellar: number }> = [];
  for (let i = 7; i >= 0; i--) {
    const start = now - (i + 1) * 7 * 86_400_000;
    const end = now - i * 7 * 86_400_000;
    const inWeek = settled.filter((s) => {
      const t = new Date(s.settledAt).getTime();
      return t >= start && t < end;
    });
    weeks.push({ label: new Date(end).toISOString().slice(5, 10), paypal: inWeek.filter((s) => s.rail === "paypal").reduce((a, s) => a + gross(s), 0), stellar: inWeek.filter((s) => s.rail === "stellar").reduce((a, s) => a + gross(s), 0) });
  }

  return {
    business: getBusiness(db),
    counts: {
      open: all.filter((r) => openStates.includes(r.state as ObligationState)).length,
      needsAction: all.filter((r) => ["needs_evidence", "awaiting_approval", "approved", "blocked", "failed"].includes(r.state) && !scheduled(r)).length,
      awaitingApproval: all.filter((r) => r.state === "awaiting_approval").length,
      blocked: blocked.length,
      readyToPay: all.filter((r) => r.state === "approved" && !scheduled(r)).length,
      scheduled: all.filter(scheduled).length,
      inFlight: all.filter((r) => ["execution_pending", "sent"].includes(r.state)).length,
      settled30d: settledRecent.length,
    },
    money: {
      outstandingMinor: sum(all.filter((r) => openStates.includes(r.state as ObligationState))),
      dueSoonMinor: sum(all.filter((r) => openStates.includes(r.state as ObligationState) && r.dueDate && new Date(r.dueDate).getTime() <= now + 7 * 86_400_000)),
      paid30dMinor: settledRecent.reduce((a, s) => a + gross(s), 0),
      paidTodayMinor: settledToday.reduce((a, s) => a + gross(s), 0),
      paidTodayCount: settledToday.length,
      fees30dMinor: settledRecent.reduce((a, s) => a + fee(s), 0),
      blockedMinor: sum(blocked),
      preventedMinor: preventedTotal(db).minor,
      preventedOpenMinor: blocked.reduce((a, r) => a + toBaseOrZero(mismatchDelta(r), r.currency, base), 0),
      byRail: { paypal: { grossMinor: grossByRail("paypal"), feeMinor: feesByRail("paypal"), count: byRail("paypal").length }, stellar: { grossMinor: grossByRail("stellar"), feeMinor: feesByRail("stellar"), count: byRail("stellar").length } },
    },
    weeks,
    needsAction: all.filter((r) => ["blocked", "awaiting_approval", "needs_evidence", "failed", "approved"].includes(r.state) && !scheduled(r)).sort((a, b) => rank(a.state) - rank(b.state)),
    recent: listAudit(12, db),
    system: { railModes: railModes(), ai: isLiveAi() ? `claude (${config.ai.model})` : "rule-based (mock)", accounting: config.accounting.destination },
  };
}

/** Approved and scheduled by autopilot: the agent will send it, so it does not need a person. */
function scheduled(r: ObligationRow): boolean {
  return r.state === "approved" && !!r.releaseAt;
}

/** For a blocked mismatch, how much the block saved: requested minus evidenced amount, if positive. */
function mismatchDelta(r: ObligationRow): number {
  return savedBy(r.blockedReason ?? "", r.amountMinor ?? 0);
}

/** What one block kept from going out wrong: the overpaid part of a mismatch, or the whole amount of a duplicate. */
function savedBy(reason: string, amountMinor: number): number {
  const m = reason.match(/Requested [A-Z]{3} ([\d,]+(?:\.\d{2})?) but .* says [A-Z]{3} ([\d,]+(?:\.\d{2})?)/);
  if (m) {
    const req = Math.round(Number(m[1].replace(/,/g, "")) * 100);
    const ev = Math.round(Number(m[2].replace(/,/g, "")) * 100);
    return Math.max(0, req - ev);
  }
  if (/already used|Same job as/.test(reason)) return amountMinor;
  // The rate card caught an inflated invoice: "... say VND 3,600,000 (...); this asks for VND 4,500,000".
  const rc = reason.match(/^Rate card .* say [A-Z]{3} ([\d,]+(?:\.\d{2})?) .*this asks for [A-Z]{3} ([\d,]+(?:\.\d{2})?)/);
  if (rc) return Math.max(0, Math.round(Number(rc[2].replace(/,/g, "")) * 100) - Math.round(Number(rc[1].replace(/,/g, "")) * 100));
  return 0;
}

/**
 * Errors prevented, cumulative: every payment policy ever blocked as an overpayment or a duplicate, counted once,
 * at what it would have overpaid at the time of the block. Resolving a block (correcting it, cancelling the
 * duplicate) does not take it back out of the total; it still did not go out wrong.
 */
export function preventedTotal(db: Db = getDb()): { minor: number; count: number } {
  const base = getBusiness(db)?.baseCurrency ?? "USD";
  const rows = db
    .select({ obligationId: auditEntries.obligationId, detail: auditEntries.detailJson, amountMinor: obligations.amountMinor, currency: obligations.currency })
    .from(auditEntries)
    .innerJoin(obligations, eq(obligations.id, auditEntries.obligationId))
    .where(eq(auditEntries.toState, "blocked"))
    .orderBy(auditEntries.seq)
    .all();
  const best = new Map<string, number>();
  for (const r of rows) {
    if (!r.obligationId) continue;
    const reasons = (r.detail ? ((JSON.parse(r.detail) as { reasons?: string[] }).reasons ?? []) : []) as string[];
    const saved = toBaseOrZero(Math.max(0, ...reasons.map((x) => savedBy(x, r.amountMinor ?? 0))), r.currency, base);
    if (saved > (best.get(r.obligationId) ?? 0)) best.set(r.obligationId, saved);
  }
  let minor = 0;
  for (const v of best.values()) minor += v;
  return { minor, count: [...best.values()].filter((v) => v > 0).length };
}

function rank(state: string): number {
  return ["blocked", "failed", "awaiting_approval", "approved", "needs_evidence"].indexOf(state);
}

/** Rail, agent and accounting modes, for the sidebar footer. Same shape as getOverview().system. */
export function getSystemModes() {
  return { railModes: railModes(), ai: isLiveAi() ? `claude (${config.ai.model})` : "rule-based (mock)", accounting: config.accounting.destination };
}

/** Obligations by source reference, newest first, for the presenter page. */
export function findObligationsBySourceRef(refs: string[], db: Db = getDb()): ObligationRow[] {
  if (!refs.length) return [];
  return db
    .select({ o: obligations, vendorName: vendors.name, vendorRole: vendors.role, vendorCountry: vendors.country })
    .from(obligations)
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(inArray(obligations.sourceRef, refs))
    .orderBy(desc(obligations.createdAt))
    .all()
    .map((r) => ({ ...r.o, vendorName: r.vendorName, vendorRole: r.vendorRole, vendorCountry: r.vendorCountry }));
}

export function obligationCountsByState(db: Db = getDb()): Record<string, number> {
  const rows = db.select({ state: obligations.state, n: sql<number>`count(*)` }).from(obligations).groupBy(obligations.state).all();
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

/**
 * The obligations waiting on this person's next step, by what their role lets them do: approvers see payments within
 * their limit that they did not prepare or already approve; people who send see approved payments; clerks see blocked,
 * evidence-missing and failed ones to fix.
 */
export function waitingIdsFor(actor: Actor, db: Db = getDb()): string[] {
  const ids = new Set<string>();
  const open = db.select().from(obligations).where(inArray(obligations.state, ["awaiting_approval", "approved", "blocked", "needs_evidence", "failed"])).all();
  const mayApprove = actorCan(actor, "approve");
  for (const o of open) {
    if (o.state === "awaiting_approval" && mayApprove) {
      const mine = db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.obligationId, o.id), eq(approvals.decision, "approved"), eq(approvals.actor, actor.id))).get();
      if (mine || approvalGate(db, o.id, actor.id).refusal) continue;
      ids.add(o.id);
    } else if ((o.state === "approved" || o.state === "failed") && actorCan(actor, "pay")) {
      ids.add(o.id);
    } else if ((o.state === "blocked" || o.state === "needs_evidence") && actorCan(actor, "amend")) {
      ids.add(o.id);
    }
  }
  return [...ids];
}

export function waitingFor(actor: Actor, db: Db = getDb()): number {
  return waitingIdsFor(actor, db).length;
}
