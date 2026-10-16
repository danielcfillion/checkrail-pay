import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db";
import { accountingSyncs, approvals, attachments, auditEntries, businesses, evidence as evidenceTable, obligations, paymentAttempts, routeQuotes, settlements, vendors } from "../db/schema";
import { DEFAULT_POLICY, effectiveAutonomy, type AiInterpretation, type ApprovalPolicy, type EvidenceItem, type ExecutionResult, type ObligationState, type PolicyOutcome, type Rail, type SettlementStatus, type SourceType, type VendorPayoutProfile } from "../domain/types";
import { evaluatePolicy } from "../domain/policy";
import { chooseRoute } from "../domain/routing";
import { audit, transition } from "../domain/stateMachine";
import { hashPayoutDetails, idempotencyKey, jobKeys, newId, now } from "../domain/ids";
import { SUPPORTED_CURRENCIES, isValidAmountMinor, isValidSourceRef, safeRefForMemo } from "../domain/money";
import { isLiveRails } from "../config";
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
  evidence?: Array<Omit<EvidenceItem, "id"> & { attachmentId?: string | null }>;
  /** Who supplied the evidence. Defaults to "system" (an integration). Operator-supplied evidence is flagged by policy.
   *  A row that points at an uploaded attachment and matches what the reader extracted gets provenance "document" instead. */
  evidenceSource?: "system" | "operator";
  actor?: string;
}

export async function ingestObligation(db: Db, input: IngestInput): Promise<string> {
  const id = newId("obl");
  const ts = now();
  // One document backs one payment. Re-using it would move it off the first obligation and erase the text that
  // obligation's duplicate check reads. Checked before anything is written, so a refusal leaves no half-made draft.
  for (const e of input.evidence ?? []) {
    if (!e.attachmentId) continue;
    const att = db.select({ name: attachments.name, obligationId: attachments.obligationId }).from(attachments).where(and(eq(attachments.id, e.attachmentId), eq(attachments.businessId, input.businessId))).get();
    if (att?.obligationId) throw new Error(`Document ${att.name} is already attached to another payment; upload it again if it really backs this one too`);
  }
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
    let provenance: string = input.evidenceSource ?? "system";
    let attachmentId: string | null = null;
    if (e.attachmentId) {
      const att = db.select().from(attachments).where(and(eq(attachments.id, e.attachmentId), eq(attachments.businessId, input.businessId))).get();
      if (att) {
        // One document backs one payment. Re-using it would move it off the first obligation and erase the text its duplicate check reads.
        attachmentId = att.id;
        // "document" only when every field is what the reader extracted: figures, reference, label and excerpt. Policy reads the
        // label and excerpt to bind the payee, so an edited excerpt is the operator's claim, not the document's.
        const proposed = JSON.parse(att.proposedJson) as Array<{ amountMinor: number | null; currency: string | null; reference: string | null; label?: string; excerpt?: string | null }>;
        const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").replace(/\s+/g, " ").trim() === (b ?? "").replace(/\s+/g, " ").trim();
        const untouched = proposed.some((p) => p.amountMinor === e.amountMinor && (p.currency ?? null) === (e.currency ?? null) && (p.reference ?? null)?.toUpperCase() === (e.reference ?? null)?.toUpperCase() && same(p.label, e.label) && same(p.excerpt, e.excerpt));
        provenance = untouched ? "document" : "operator";
        db.update(attachments).set({ obligationId: id }).where(eq(attachments.id, att.id)).run();
      }
    }
    db.insert(evidenceTable).values({ id: newId("evd"), obligationId: id, kind: e.kind, label: e.label, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, excerpt: e.excerpt, provenance, attachmentId, createdAt: ts }).run();
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
  const run = await runObligationAgent({ rawInput: ob.rawInput, sourceType: ob.sourceType, vendors: vendorProfiles, evidence: ev, documents: docs, businessName: biz.name, baseCurrency: biz.baseCurrency, vendorHistory });
  const ai = run.interpretation;
  // Approvals were given for specific numbers. If re-interpretation changes who is paid, how much or what for, they no longer count.
  const approved = db.select().from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all();
  if (approved.length > 0 && (ob.vendorId !== (ai.vendorId ?? ob.vendorId) || ob.amountMinor !== ai.amountMinor || ob.currency !== ai.currency || ob.sourceRef !== (ai.sourceRef ?? ob.sourceRef))) {
    db.update(approvals).set({ decision: "superseded" }).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).run();
    audit(db, { obligationId, actor: "system", action: "approvals.superseded", detail: { reason: "re-interpretation changed vendor, amount, currency or reference", count: approved.length } });
  }
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
    detail: { vendorId: ai.vendorId, amountMinor: ai.amountMinor, currency: ai.currency, sourceRef: ai.sourceRef, confidence: ai.confidence, flags: ai.flags, missing: ai.missing, notes: ai.notes ?? [], engine: run.engine, model: run.model, toolCalls: run.toolCalls.map((t) => ({ name: t.name, input: JSON.stringify(t.input ?? {}).slice(0, 200), resultPreview: String(t.resultPreview ?? "").slice(0, 200) })) },
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

  // 5. Autopilot: a clean payment inside the caps is scheduled for release after the cancel window.
  if (outcome.decision === "auto_execute" && mustGet(db, obligationId).state === "approved") {
    scheduleAutopilotRelease(db, obligationId);
  }
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
function payoutHashOf(v: { paypalEmail: string | null; stellarAccount: string | null; bankLabel: string | null }): string {
  return hashPayoutDetails([v.paypalEmail, v.stellarAccount, v.bankLabel]);
}

export function runPolicy(db: Db, obligationId: string): PolicyOutcome {
  const ob = mustGet(db, obligationId);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const policy: ApprovalPolicy = { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
  const vendorRow = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : null;
  const vendor = vendorRow ? toProfile(vendorRow) : null;
  const prior = vendor
    ? db
        .select({ obligationId: obligations.id, sourceRef: obligations.sourceRef, amountMinor: obligations.amountMinor, state: obligations.state, updatedAt: obligations.updatedAt, rawInput: obligations.rawInput, description: obligations.description })
        .from(obligations)
        .where(and(eq(obligations.vendorId, vendor.id), ne(obligations.id, obligationId)))
        .all()
        .map((p) => {
          // Identity of the underlying job comes from everything that names it, including the document text:
          // a re-issued invoice under a new number still says "ref INV-TAM-0834" or "trip HG-4D-0831" in its lines.
          const ev = db.select({ reference: evidenceTable.reference, label: evidenceTable.label, excerpt: evidenceTable.excerpt }).from(evidenceTable).where(eq(evidenceTable.obligationId, p.obligationId)).all();
          const texts = db.select({ text: attachments.extractedText }).from(attachments).where(eq(attachments.obligationId, p.obligationId)).all();
          return { ...p, keys: jobKeys(p.sourceRef, p.rawInput, p.description, ...ev.flatMap((e) => [e.reference, e.label, e.excerpt]), ...texts.map((t) => t.text?.slice(0, 4000))) };
        })
    : [];
  const myEvidence = listEvidence(db, obligationId);
  // Exact references on this obligation (its own and its evidence's), checked against other payees' obligations.
  const myRefs = new Set([ob.sourceRef, ...myEvidence.map((e) => e.reference)].filter((r): r is string => Boolean(r)).map((r) => r.toUpperCase()));
  const otherVendorRefs = ob.vendorId && myRefs.size
    ? db
        .select({ obligationId: obligations.id, sourceRef: obligations.sourceRef, state: obligations.state, vendorName: vendors.name })
        .from(obligations)
        .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
        .where(and(eq(obligations.businessId, ob.businessId), ne(obligations.vendorId, ob.vendorId), ne(obligations.id, obligationId)))
        .all()
        .filter((o) => o.state !== "cancelled" && o.state !== "failed" && o.sourceRef && myRefs.has(o.sourceRef.toUpperCase()))
        .map((o) => ({ obligationId: o.obligationId, vendorName: o.vendorName, reference: o.sourceRef!, state: o.state }))
    : [];
  const myDocTexts = db.select({ text: attachments.extractedText }).from(attachments).where(eq(attachments.obligationId, obligationId)).all();
  const myJobKeys = jobKeys(ob.sourceRef, ob.rawInput, ob.description, ...myEvidence.flatMap((e) => [e.reference, e.label, e.excerpt]), ...myDocTexts.map((d) => d.text?.slice(0, 4000)));
  // Distinct people, not rows: one person approving twice is still one approval.
  const approvalsCount = new Set(db.select({ actor: approvals.actor }).from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"))).all().map((a) => a.actor)).size;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const vendorRecentMinor = prior.filter((p) => ["approved", "execution_pending", "sent", "settled"].includes(p.state) && p.updatedAt >= since).reduce((sum, p) => sum + (p.amountMinor ?? 0), 0);
  // Business-wide committed money in the last 24h (base currency), for the autopilot daily cap. Pre-approved payments only count once autopilot has scheduled them.
  const businessRecentMinor = db
    .select({ state: obligations.state, amountMinor: obligations.amountMinor, currency: obligations.currency, releaseAt: obligations.releaseAt, updatedAt: obligations.updatedAt })
    .from(obligations)
    .where(and(eq(obligations.businessId, ob.businessId), ne(obligations.id, obligationId)))
    .all()
    .filter((o) => o.currency === biz.baseCurrency && o.updatedAt >= since && (["execution_pending", "sent", "settled"].includes(o.state) || (o.state === "approved" && !!o.releaseAt)))
    .reduce((sum, o) => sum + (o.amountMinor ?? 0), 0);
  const ai: AiInterpretation | null = ob.aiSummary
    ? { vendorName: null, vendorId: ob.vendorId, amountMinor: ob.amountMinor, currency: ob.currency, description: ob.description ?? "", sourceRef: ob.sourceRef, dueDate: ob.dueDate, summary: ob.aiSummary, confidence: ob.aiConfidence ?? 0, flags: JSON.parse(ob.aiFlagsJson ?? "[]"), missing: JSON.parse(ob.aiMissingJson ?? "[]") }
    : null;
  const outcome = evaluatePolicy(policy, {
    obligation: { id: ob.id, amountMinor: ob.amountMinor, currency: ob.currency, sourceRef: ob.sourceRef, vendorId: ob.vendorId },
    vendor,
    evidence: myEvidence,
    ai,
    businessCountry: biz.country,
    baseCurrency: biz.baseCurrency,
    priorSourceRefs: prior.map((p) => ({ obligationId: p.obligationId, sourceRef: p.sourceRef, amountMinor: p.amountMinor, state: p.state as ObligationState, keys: p.keys, updatedAt: p.updatedAt })),
    jobKeys: myJobKeys,
    otherVendorRefs,
    approvalsCount,
    vendorRecentMinor,
    businessRecentMinor,
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
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const policy: ApprovalPolicy = { ...DEFAULT_POLICY, ...(JSON.parse(biz.policyJson) as Partial<ApprovalPolicy>) };
  // Separation of duties: whoever ingested the request cannot also approve it.
  if (policy.requireSeparateApprover ?? isLiveRails()) {
    const created = db.select({ actor: auditEntries.actor }).from(auditEntries).where(and(eq(auditEntries.obligationId, obligationId), eq(auditEntries.action, "obligation.created"))).get();
    if (created && created.actor === actor) throw new Error("The person who ingested an obligation cannot approve it; ask a second person");
  }
  // One approval per person per version of the obligation.
  const already = db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.obligationId, obligationId), eq(approvals.decision, "approved"), eq(approvals.actor, actor))).get();
  if (already) throw new Error("You have already approved this obligation; any further approval must come from a different person");
  db.insert(approvals).values({ id: newId("apr"), obligationId, actor, decision: "approved", note: note ?? null, createdAt: now() }).run();
  audit(db, { obligationId, actor, action: "approval.granted", detail: { note: note ?? null } });
  // Approval does not bypass policy: a blocked obligation stays blocked until the input is fixed.
  const outcome = runPolicy(db, obligationId);
  moveTo(db, obligationId, targetState(outcome, ob.state as ObligationState), outcome);
  return outcome;
}

export function rejectObligation(db: Db, obligationId: string, actor: string, note?: string): void {
  // Transition first and in one transaction with the row: an illegal cancel leaves no stray rejection behind.
  db.transaction((tx) => {
    transition(tx as unknown as Db, obligationId, "cancelled", actor, "approval.rejected", { note: note ?? null });
    tx.insert(approvals).values({ id: newId("apr"), obligationId, actor, decision: "rejected", note: note ?? null, createdAt: now() }).run();
  });
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
  if (!["blocked", "needs_evidence", "awaiting_approval", "verified", "drafted"].includes(ob.state)) throw new Error(`Cannot amend an obligation in state ${ob.state}`);
  const patch = validateAmendPatch(db, ob.businessId, rawPatch);
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
  const ob = mustGet(db, obligationId);
  if (ob.state !== "approved") throw new Error(`Obligation must be approved before execution (state: ${ob.state})`);

  const outcome = runPolicy(db, obligationId);
  if (outcome.decision !== "auto_execute") {
    const target = targetState(outcome, "approved");
    transition(db, obligationId, target === "approved" ? "blocked" : target, "policy", "execution.refused", { reasons: outcome.reasons });
    throw new Error(`Execution refused by policy: ${outcome.reasons.join("; ")}`);
  }

  const vendorRow = ob.vendorId ? db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get() : undefined;
  if (!vendorRow) throw new Error("Obligation has no vendor");
  refuseIfPayoutChanged(db, ob, vendorRow);

  const rail = opts.rail ?? (ob.selectedRail as Rail | null);
  if (!rail) throw new Error("No route available for this obligation");
  if (rail !== "paypal" && rail !== "stellar") throw new Error(`Unknown rail ${String(rail)}`);
  const quote = db.select().from(routeQuotes).where(and(eq(routeQuotes.obligationId, obligationId), eq(routeQuotes.rail, rail))).get();
  if (!quote?.available) throw new Error(`${rail} is not an available route for this obligation`);

  const vendor = toProfile(vendorRow);
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const adapter = getRails()[rail];
  const refPart = safeRefForMemo(ob.sourceRef ?? obligationId).slice(0, 19); // memo is `ref + space + 8 key chars`, 28 max

  // Start: state check + attempt row + CAS transition, atomically.
  const started = db.transaction(
    (tx) => {
      const cur = tx.select({ state: obligations.state, payoutHash: obligations.payoutHash }).from(obligations).where(eq(obligations.id, obligationId)).get();
      if (cur?.state !== "approved") throw new Error(`Obligation must be approved before execution (state: ${cur?.state})`);
      // Re-check the destination inside the lock: an edit between the check above and this point must not slip through.
      const vendorNow = tx.select().from(vendors).where(eq(vendors.id, vendorRow.id)).get();
      if (!vendorNow || !cur.payoutHash || payoutHashOf(vendorNow) !== cur.payoutHash) throw new Error("Execution refused: vendor payout details changed at the moment of release");
      const attempts = tx.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).all();
      const open = attempts.filter((a) => OPEN_ATTEMPT.includes(a.status));
      if (open.length > 0) {
        throw new Error(`Obligation already has a payment attempt that is not definitively failed (${open.map((a) => `${a.id}:${a.status}`).join(", ")}); reconcile it instead of paying again`);
      }
      // Every remaining attempt definitively failed (nothing moved), so a fresh key cannot double-pay.
      const key = idempotencyKey(obligationId, attempts.length + 1);
      const attemptId = newId("pay");
      const ts = now();
      const fullMemo = `${refPart} ${key.slice(0, 8)}`.slice(0, 28);
      tx.insert(paymentAttempts).values({ id: attemptId, obligationId, rail, idempotencyKey: key, status: "pending", mode: adapter.mode, requestJson: JSON.stringify({ amountMinor: ob.amountMinor, currency: ob.currency, memo: fullMemo, vendorId: vendor.id }), createdAt: ts, updatedAt: ts }).run();
      if (opts.rail && opts.rail !== ob.selectedRail) {
        tx.update(obligations).set({ selectedRail: opts.rail, routeReason: `Operator override by ${opts.actor}`, updatedAt: ts }).where(eq(obligations.id, obligationId)).run();
        audit(tx as unknown as Db, { obligationId, actor: opts.actor, action: "route.overridden", detail: { from: ob.selectedRail, to: opts.rail } });
      }
      transition(tx as unknown as Db, obligationId, "execution_pending", opts.actor, "execution.started", { attemptId, rail, mode: adapter.mode, idempotencyKey: key });
      return { attemptId, key, memo: fullMemo };
    },
    { behavior: "immediate" }
  );

  const result = await callRail(db, adapter, started.attemptId, { obligationId, idempotencyKey: started.key, vendor, amountMinor: ob.amountMinor!, currency: ob.currency!, memo: started.memo, businessCountry: biz.country });
  return finishAttempt(db, obligationId, started.attemptId, rail, adapter.mode, result);
}

/** Refuse (and pull the obligation back to blocked) if the payout destination differs from what was verified and approved. */
function refuseIfPayoutChanged(db: Db, ob: typeof obligations.$inferSelect, vendorRow: typeof vendors.$inferSelect): void {
  const current = payoutHashOf(vendorRow);
  const reasons: string[] = [];
  if (current !== vendorRow.detailsHash) reasons.push("Vendor payout details were edited without re-verification");
  if (!ob.payoutHash) reasons.push("No payout destination was recorded when this obligation was approved; approve it again");
  else if (ob.payoutHash !== current) reasons.push("Vendor payout details changed after this obligation was approved");
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
  if (ob.state !== "execution_pending") throw new Error(`Obligation is not awaiting reconciliation (state: ${ob.state})`);
  const attempt = db.select().from(paymentAttempts).where(and(eq(paymentAttempts.obligationId, obligationId))).orderBy(desc(paymentAttempts.createdAt)).all().find((a) => a.status === "unknown" || a.status === "pending");
  if (!attempt) throw new Error("No unresolved payment attempt found");
  const rail = attempt.rail as Rail;
  const adapter = getRails()[rail];
  const vendorRow = db.select().from(vendors).where(eq(vendors.id, ob.vendorId!)).get();
  if (!vendorRow) throw new Error("Obligation has no vendor");
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
  const req = JSON.parse(attempt.requestJson ?? "{}") as { memo?: string };
  const biz = db.select().from(businesses).where(eq(businesses.id, ob.businessId)).get()!;
  const result = await callRail(db, adapter, attempt.id, { obligationId, idempotencyKey: attempt.idempotencyKey, vendor: toProfile(vendorRow), amountMinor: ob.amountMinor!, currency: ob.currency!, memo: req.memo ?? "", businessCountry: biz.country });
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
    db.update(paymentAttempts).set({ status: "submitted", externalId: id, externalStatus: "found by hand", updatedAt: now() }).where(eq(paymentAttempts.id, attempt.id)).run();
    transition(db, obligationId, "sent", actor, "execution.resolved_by_hand", { attemptId: attempt.id, externalId: id });
    try {
      return await confirmSettlement(db, obligationId, "manual-resolution");
    } catch {
      return "sent";
    }
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
  if (!vendorRow) throw new Error("Obligation has no vendor");
  const current = payoutHashOf(vendorRow);
  if (current !== vendorRow.detailsHash) throw new Error("Vendor payout details were edited without re-verification; verify the vendor first");
  if (ob.payoutHash && ob.payoutHash !== current) throw new Error("Vendor payout details changed since approval; review and approve this payment again");
  db.update(obligations).set({ payoutHash: current, updatedAt: now() }).where(eq(obligations.id, obligationId)).run();
  transition(db, obligationId, "approved", actor, "execution.retry_requested", { payoutHash: current });
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
  audit(db, { obligationId, actor: `rail:${rail}`, action: `settlement.checked:${source}`, detail: { status: status.status, externalStatus: status.externalStatus } });
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
  const note = mode === "mock" ? null : "Fee and recipient figures are modelled from the published fee schedule, not reported by the provider.";
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
      db.insert(settlements).values({ id: newId("stl"), obligationId, attemptId, rail, grossMinor: ob.amountMinor!, grossCurrency: ob.currency!, feeMinor, receivedMinor, receivedCurrency, fxRate, externalId, explorerUrl, note, settledAt: ts }).run();
    }
    db.update(paymentAttempts).set({ status: "confirmed", updatedAt: ts }).where(eq(paymentAttempts.id, attemptId)).run();
    transition(db, obligationId, "settled", `rail:${rail}`, "settlement.confirmed", { externalId, feeMinor, receivedMinor, receivedCurrency, explorerUrl });
    queueAccounting(db, obligationId);
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
  if (!ob) throw new Error(`Obligation ${id} not found`);
  return ob;
}

export function listEvidence(db: Db, obligationId: string): EvidenceItem[] {
  return db
    .select()
    .from(evidenceTable)
    .where(eq(evidenceTable.obligationId, obligationId))
    .all()
    .map((e) => ({ id: e.id, kind: e.kind, label: e.label, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, excerpt: e.excerpt, provenance: e.provenance === "operator" ? ("operator" as const) : e.provenance === "document" ? ("document" as const) : ("system" as const) }));
}

export function toProfile(v: typeof vendors.$inferSelect): VendorPayoutProfile {
  return { id: v.id, name: v.name, country: v.country, preferredRail: (v.preferredRail as Rail | null) ?? null, paypalEmail: v.paypalEmail, stellarAccount: v.stellarAccount, bankCountry: v.bankCountry, bankCurrency: v.bankCurrency, bankLabel: v.bankLabel, detailsHash: v.detailsHash, verifiedAt: v.verifiedAt };
}
