import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db";
import { accountingSyncs, approvals, businesses, evidence as evidenceTable, obligations, paymentAttempts, routeQuotes, settlements, vendors } from "../db/schema";
import type { AiInterpretation, ApprovalPolicy, EvidenceItem, ObligationState, PolicyOutcome, Rail, SourceType, VendorPayoutProfile } from "../domain/types";
import { evaluatePolicy } from "../domain/policy";
import { chooseRoute } from "../domain/routing";
import { audit, transition } from "../domain/stateMachine";
import { idempotencyKey, newId, now } from "../domain/ids";
import { runObligationAgent } from "../ai/agent";
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
  evidence?: Array<Omit<EvidenceItem, "id">>;
  actor?: string;
}

export async function ingestObligation(db: Db, input: IngestInput): Promise<string> {
  const id = newId("obl");
  const ts = now();
  db.insert(obligations)
    .values({
      id,
      businessId: input.businessId,
      vendorId: null,
      state: "drafted",
      sourceType: input.sourceType,
      sourceRef: input.sourceRef ?? null,
      rawInput: input.rawInput,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  audit(db, { obligationId: id, actor: input.actor ?? "system", action: "obligation.created", toState: "drafted", detail: { sourceType: input.sourceType } });
  for (const e of input.evidence ?? []) {
    db.insert(evidenceTable).values({ id: newId("evd"), obligationId: id, kind: e.kind, label: e.label, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, excerpt: e.excerpt, createdAt: ts }).run();
  }
  if ((input.evidence ?? []).length > 0) {
    audit(db, { obligationId: id, actor: input.actor ?? "system", action: "evidence.attached", detail: { count: input.evidence!.length, labels: input.evidence!.map((e) => e.label) } });
  }
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
  const run = await runObligationAgent({ rawInput: ob.rawInput, sourceType: ob.sourceType, vendors: vendorProfiles, evidence: ev, businessName: biz.name, baseCurrency: biz.baseCurrency });
  const ai = run.interpretation;
  db.update(obligations)
    .set({
      vendorId: ai.vendorId ?? ob.vendorId,
      description: ai.description,
      amountMinor: ai.amountMinor,
      currency: ai.currency,
      sourceRef: ai.sourceRef ?? ob.sourceRef,
      dueDate: ai.dueDate,
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
    detail: { vendorId: ai.vendorId, amountMinor: ai.amountMinor, currency: ai.currency, sourceRef: ai.sourceRef, confidence: ai.confidence, flags: ai.flags, missing: ai.missing, toolCalls: run.toolCalls.map((t) => t.name) },
  });

  // 2. Policy
  const outcome = runPolicy(db, obligationId);

  // 3. Quotes and route (only when the obligation is well-formed and has a vendor)
  const fresh = mustGet(db, obligationId);
  const vendor = fresh.vendorId ? vendorProfiles.find((v) => v.id === fresh.vendorId) ?? null : null;
  if (vendor && fresh.amountMinor && fresh.currency) {
    await quoteAndRoute(db, obligationId, vendor, fresh.amountMinor, fresh.currency, biz.country);
  }

  // 4. State
  const current = mustGet(db, obligationId).state as ObligationState;
  moveTo(db, obligationId, targetState(outcome, current), outcome);
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
}

export function runPolicy(db: Db, obligationId: string): PolicyOutcome {
  const ob = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const policy = JSON.parse(biz.policyJson) as ApprovalPolicy;
  const vendorRow = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : null;
  const vendor = vendorRow ? toProfile(vendorRow) : null;
  const prior = vendor
    ? db
        .select({ obligationId: obligations.id, sourceRef: obligations.sourceRef, amountMinor: obligations.amountMinor, state: obligations.state })
        .from(obligations)
        .where(and(eq(obligations.vendorId, vendor.id), ne(obligations.id, obligationId)))
        .all()
    : [];
  const approvalsCount = db.select().from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all().length;
  const ai: AiInterpretation | null = ob.aiSummary
    ? { vendorName: null, vendorId: ob.vendorId, amountMinor: ob.amountMinor, currency: ob.currency, description: ob.description ?? "", sourceRef: ob.sourceRef, dueDate: ob.dueDate, summary: ob.aiSummary, confidence: ob.aiConfidence ?? 0, flags: JSON.parse(ob.aiFlagsJson ?? "[]"), missing: JSON.parse(ob.aiMissingJson ?? "[]") }
    : null;
  const outcome = evaluatePolicy(policy, {
    obligation: { id: ob.id, amountMinor: ob.amountMinor, currency: ob.currency, sourceRef: ob.sourceRef, vendorId: ob.vendorId },
    vendor,
    evidence: listEvidence(db, obligationId),
    ai,
    businessCountry: biz.country,
    baseCurrency: biz.baseCurrency,
    priorSourceRefs: prior.map((p) => ({ ...p, state: p.state as ObligationState })),
    approvalsCount,
  });
  db.update(obligations)
    .set({ policyDecision: outcome.decision, policyReasonsJson: JSON.stringify(outcome.reasons), blockedReason: outcome.decision === "block" ? outcome.reasons[0] ?? null : null, updatedAt: now() })
    .where(eq(obligations.id, obligationId))
    .run();
  audit(db, { obligationId, actor: "policy", action: "policy.evaluated", detail: { decision: outcome.decision, rules: outcome.rules } });
  return outcome;
}

async function quoteAndRoute(db: Db, obligationId: string, vendor: VendorPayoutProfile, amountMinor: number, currency: string, businessCountry: string): Promise<void> {
  const rails = getRails();
  const quotes = await Promise.all((["paypal", "stellar"] as Rail[]).map((r) => rails[r].quote({ vendor, amountMinor, currency, businessCountry })));
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

export function approveObligation(db: Db, obligationId: string, actor: string, note?: string): PolicyOutcome {
  const ob = mustGet(db, obligationId);
  if (!["awaiting_approval", "verified", "blocked"].includes(ob.state)) throw new Error(`Cannot approve an obligation in state ${ob.state}`);
  db.insert(approvals).values({ id: newId("apr"), obligationId, actor, decision: "approved", note: note ?? null, createdAt: now() }).run();
  audit(db, { obligationId, actor, action: "approval.granted", detail: { note: note ?? null } });
  // Approval does not bypass policy: a blocked obligation stays blocked until the input is fixed.
  const outcome = runPolicy(db, obligationId);
  moveTo(db, obligationId, targetState(outcome, ob.state as ObligationState), outcome);
  return outcome;
}

export function rejectObligation(db: Db, obligationId: string, actor: string, note?: string): void {
  db.insert(approvals).values({ id: newId("apr"), obligationId, actor, decision: "rejected", note: note ?? null, createdAt: now() }).run();
  transition(db, obligationId, "cancelled", actor, "approval.rejected", { note: note ?? null });
}

/** Correct an obligation's amount or reference after human review, then re-run the pipeline from policy. */
export async function amendObligation(db: Db, obligationId: string, actor: string, patch: { amountMinor?: number; currency?: string; sourceRef?: string; vendorId?: string }, note?: string): Promise<void> {
  const ob = mustGet(db, obligationId);
  if (!["blocked", "needs_evidence", "awaiting_approval", "verified", "drafted"].includes(ob.state)) throw new Error(`Cannot amend an obligation in state ${ob.state}`);
  // The human's values are now authoritative; drop agent flags about the field that was corrected.
  // Approvals given before the correction were for different numbers; they no longer count.
  db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).run();
  const flags = (JSON.parse(ob.aiFlagsJson ?? "[]") as string[]).filter((f) => !(patch.amountMinor != null && /amount differs/i.test(f)) && !(patch.sourceRef && /Reference .* does not match/i.test(f)));
  db.update(obligations).set({ ...patch, aiFlagsJson: JSON.stringify(flags), updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  audit(db, { obligationId, actor, action: "obligation.amended", detail: { patch, note: note ?? null, previous: { amountMinor: ob.amountMinor, currency: ob.currency, sourceRef: ob.sourceRef, vendorId: ob.vendorId } } });
  if (ob.state === "blocked") transition(db, obligationId, "verified", actor, "review.resolved", { note: note ?? null });
  const outcome = runPolicy(db, obligationId);
  const fresh = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, fresh.businessId)).get()!;
  const vendorRow = fresh.vendorId ? db.select().from(vendors).where(eq(vendors.id, fresh.vendorId)).get() : null;
  if (vendorRow && fresh.amountMinor && fresh.currency) await quoteAndRoute(db, obligationId, toProfile(vendorRow), fresh.amountMinor, fresh.currency, biz.country);
  moveTo(db, obligationId, targetState(outcome, fresh.state as ObligationState), outcome);
}

export interface ExecuteOptions {
  actor: string;
  /** Override the router's choice (operator picked the other rail in the UI). Must be an available quote. */
  rail?: Rail;
}

/**
 * Execute an approved obligation. Re-runs policy first: if anything changed
 * since approval (a duplicate appeared, details changed) it refuses.
 */
export async function executeObligation(db: Db, obligationId: string, opts: ExecuteOptions): Promise<{ attemptId: string; status: string }> {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "approved") throw new Error(`Obligation must be approved before execution (state: ${ob.state})`);

  const outcome = runPolicy(db, obligationId);
  if (outcome.decision !== "auto_execute") {
    const target = targetState(outcome, "approved");
    transition(db, obligationId, target === "approved" ? "blocked" : target, "policy", "execution.refused", { reasons: outcome.reasons });
    throw new Error(`Execution refused by policy: ${outcome.reasons.join("; ")}`);
  }

  const rail = opts.rail ?? (ob.selectedRail as Rail | null);
  if (!rail) throw new Error("No route available for this obligation");
  const quote = db.select().from(routeQuotes).where(and(eq(routeQuotes.obligationId, obligationId), eq(routeQuotes.rail, rail))).get();
  if (!quote?.available) throw new Error(`${rail} is not an available route for this obligation`);
  if (opts.rail && opts.rail !== ob.selectedRail) {
    db.update(obligations).set({ selectedRail: opts.rail, routeReason: `Operator override by ${opts.actor}`, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
    audit(db, { obligationId, actor: opts.actor, action: "route.overridden", detail: { from: ob.selectedRail, to: opts.rail } });
  }

  const vendorRow = db.select().from(vendors).where(eq(vendors.id, ob.vendorId!)).get()!;
  const vendor = toProfile(vendorRow);
  const attemptNo = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).all().length + 1;
  const key = idempotencyKey(obligationId, attemptNo);
  const attemptId = newId("pay");
  const rails = getRails();
  const adapter = rails[rail];
  const memo = `${ob.sourceRef ?? obligationId} ${key.slice(0, 8)}`.slice(0, 28);
  const ts = now();

  db.insert(paymentAttempts).values({ id: attemptId, obligationId, rail, idempotencyKey: key, status: "pending", mode: adapter.mode, requestJson: JSON.stringify({ amountMinor: ob.amountMinor, currency: ob.currency, memo, vendorId: vendor.id }), createdAt: ts, updatedAt: ts }).run();
  transition(db, obligationId, "execution_pending", opts.actor, "execution.started", { attemptId, rail, mode: adapter.mode, idempotencyKey: key });

  const result = await adapter.execute({ obligationId, idempotencyKey: key, vendor, amountMinor: ob.amountMinor!, currency: ob.currency!, memo });
  db.update(paymentAttempts)
    .set({ status: result.status === "failed" ? "failed" : result.status, externalId: result.externalId, externalStatus: result.externalStatus, responseJson: JSON.stringify(result.raw ?? null), errorMessage: result.errorMessage ?? null, updatedAt: now() })
    .where(eq(paymentAttempts.id, attemptId))
    .run();

  if (result.status === "failed") {
    transition(db, obligationId, "failed", `rail:${rail}`, "execution.failed", { attemptId, error: result.errorMessage });
    return { attemptId, status: "failed" };
  }
  transition(db, obligationId, "sent", `rail:${rail}`, "execution.submitted", { attemptId, externalId: result.externalId, externalStatus: result.externalStatus, explorerUrl: result.explorerUrl ?? null });
  if (result.status === "confirmed") {
    recordSettlement(db, obligationId, attemptId, rail, result.externalId!, result.feeMinor, result.receivedMinor, result.receivedCurrency, result.fxRate, result.explorerUrl ?? null);
  }
  return { attemptId, status: result.status };
}

/** Poll the rail for the latest attempt and settle or fail accordingly. Webhooks call the same function. */
export async function confirmSettlement(db: Db, obligationId: string, source = "poll"): Promise<ObligationState> {
  const ob = mustGet(db, obligationId);
  if (ob.state !== "sent") return ob.state as ObligationState;
  const attempt = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).orderBy(desc(paymentAttempts.createdAt)).get();
  if (!attempt?.externalId) return ob.state as ObligationState;
  const rail = attempt.rail as Rail;
  const status = await getRails()[rail].getStatus(attempt.externalId);
  db.update(paymentAttempts).set({ externalStatus: status.externalStatus, updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
  audit(db, { obligationId, actor: `rail:${rail}`, action: `settlement.checked:${source}`, detail: { status: status.status, externalStatus: status.externalStatus } });
  if (status.status === "confirmed") {
    const q = db.select().from(routeQuotes).where(and(eq(routeQuotes.obligationId, obligationId), eq(routeQuotes.rail, rail))).get();
    recordSettlement(db, obligationId, attempt.id, rail, attempt.externalId, q?.feeMinor ?? 0, q?.receiveAmountMinor ?? null, q?.receiveCurrency ?? null, q?.fxRate ?? null, status.explorerUrl ?? null);
    return "settled";
  }
  if (status.status === "failed") {
    transition(db, obligationId, "failed", `rail:${rail}`, "settlement.failed", { externalStatus: status.externalStatus });
    return "failed";
  }
  return "sent";
}

function recordSettlement(db: Db, obligationId: string, attemptId: string, rail: Rail, externalId: string, feeMinor: number, receivedMinor: number | null, receivedCurrency: string | null, fxRate: string | null, explorerUrl: string | null): void {
  const ob = mustGet(db, obligationId);
  const ts = now();
  const existing = db.select().from(settlements).where(eq(settlements.obligationId, obligationId)).get();
  if (!existing) {
    db.insert(settlements).values({ id: newId("stl"), obligationId, attemptId, rail, grossMinor: ob.amountMinor!, grossCurrency: ob.currency!, feeMinor, receivedMinor, receivedCurrency, fxRate, externalId, explorerUrl, settledAt: ts }).run();
  }
  db.update(paymentAttempts).set({ status: "confirmed", updatedAt: ts }).where(eq(paymentAttempts.id, attemptId)).run();
  transition(db, obligationId, "settled", `rail:${rail}`, "settlement.confirmed", { externalId, feeMinor, receivedMinor, receivedCurrency, explorerUrl });
  queueAccounting(db, obligationId);
}

function queueAccounting(db: Db, obligationId: string): void {
  const record = buildAccountingRecord(db, obligationId);
  if (!record) return;
  const ts = now();
  db.insert(accountingSyncs).values({ id: newId("acc"), obligationId, destination: record.destination, status: "pending", payloadJson: JSON.stringify(record.payload), createdAt: ts, updatedAt: ts }).run();
  audit(db, { obligationId, actor: "system", action: "accounting.queued", detail: { destination: record.destination, reference: record.payload.reference } });
}

// ---- helpers ----

export function mustGet(db: Db, id: string) {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get();
  if (!ob) throw new Error(`Obligation ${id} not found`);
  return ob;
}

export function listEvidence(db: Db, obligationId: string): EvidenceItem[] {
  return db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.obligationId, obligationId))
    .all()
    .map((e) => ({ id: e.id, kind: e.kind, label: e.label, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, excerpt: e.excerpt }));
}

export function toProfile(v: typeof vendors.$inferSelect): VendorPayoutProfile {
  return { id: v.id, name: v.name, country: v.country, preferredRail: (v.preferredRail as Rail | null) ?? null, paypalEmail: v.paypalEmail, stellarAccount: v.stellarAccount, bankCountry: v.bankCountry, bankCurrency: v.bankCurrency, bankLabel: v.bankLabel, detailsHash: v.detailsHash, verifiedAt: v.verifiedAt };
}
