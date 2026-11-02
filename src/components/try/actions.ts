"use server";

import fs from "node:fs";
import path from "node:path";
import { amendAction, approveAction, executeAction, ingestAction, rejectAction, uploadEvidenceAction } from "@/app/actions";
import { getObligationDetail } from "@/lib/queries";
import { warningFingerprint, type PolicyRuleResult, type Rail } from "@/lib/domain/types";
import { decide, type PrimaryAction } from "@/components/decision-model";
import { copyKey, tryBudgets, tryRefusal, TRY_LIMIT_PER_COPY } from "./guard";
import { parseAmountMinor, sampleById } from "./samples";

/**
 * Try it yourself, on the server. Every step goes through the server action a clerk's own page calls (New request's
 * uploadEvidenceAction and ingestAction, the request page's amendAction, rejectAction and executeAction), so sign-in,
 * role permissions, separation of duties and every policy rule apply exactly as they do there. What this file adds
 * is only a gate in front of them: refused unless this is the visitor's own sandbox copy on simulated rails with the
 * rule-based reader (guard.ts), and a cap on how many documents and requests one copy may create.
 */

export type TryResult<T = undefined> = { ok: true; message: string; data?: T } | { ok: false; message: string };

export type TryEvidence = { attachmentId: string; label: string; reader: string; rows: Array<{ kind: string; label: string; amountMinor: number | null; currency: string | null; reference: string | null; excerpt: string | null }> };

export type TryRule = { ruleId: string; passed: boolean; severity: string; message: string };

export type TryStatus = {
  id: string;
  state: string;
  vendorName: string | null;
  amountMinor: number | null;
  currency: string | null;
  sourceRef: string | null;
  title: string;
  evidence: string;
  tone: string;
  /** The card's one action, as the request page would offer it. */
  action: PrimaryAction | null;
  rules: TryRule[];
  /** Fingerprints of the warnings shown, as the request page sends them when approving. */
  shownWarnings: string[];
  rail: string | null;
  settled: { rail: string; grossMinor: number; grossCurrency: string; settledAt: string } | null;
  books: { status: string; destination: string } | null;
};

function gate(): string | null {
  return tryRefusal();
}

/** Step 2: attach the sample's document, through the same upload New request uses. */
export async function tryAttachAction(sampleId: string): Promise<TryResult<TryEvidence>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  const sample = sampleById(sampleId);
  if (!sample) return { ok: false, message: "No such sample." };
  const key = copyKey();
  if (!key || !tryBudgets().documents.take(key)) return { ok: false, message: `This copy of the demo has attached ${TRY_LIMIT_PER_COPY} documents, the most it may. Start over for a fresh copy.` };
  const bytes = fs.readFileSync(path.join(process.cwd(), "public", "demo-documents", sample.document.file));
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], sample.document.file, { type: "application/pdf" }));
  const r = await uploadEvidenceAction(form);
  if (!r.ok || !r.upload) return { ok: false, message: r.message };
  return { ok: true, message: r.message, data: { attachmentId: r.upload.attachmentId, label: sample.document.label, reader: r.upload.reader, rows: r.upload.proposed } };
}

/** Step 3: create the request from the judge's text and the attached evidence, as New request does. */
export async function trySubmitAction(input: { text: string; evidence: TryEvidence | null }): Promise<TryResult<TryStatus>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  const text = String(input?.text ?? "").trim();
  if (!text) return { ok: false, message: "Write the request first." };
  if (text.length > 2000) return { ok: false, message: "Keep the request under 2,000 characters." };
  const key = copyKey();
  if (!key || !tryBudgets().requests.take(key)) return { ok: false, message: `This copy of the demo has made ${TRY_LIMIT_PER_COPY} requests, the most Try it yourself allows. Start over for a fresh copy.` };
  const ev = input.evidence;
  const r = await ingestAction({
    sourceType: "invoice",
    rawInput: text,
    evidence: ev ? ev.rows.map((row) => ({ ...row, attachmentId: ev.attachmentId })) : [],
  });
  if (!r.ok || !r.id) return { ok: false, message: r.message };
  const status = statusOf(r.id);
  return status ? { ok: true, message: r.message, data: status } : { ok: false, message: "The request was created but could not be read back." };
}

/** Step 4: correct the amount (the request page's Correct to). */
export async function tryCorrectAction(id: string, amount: string): Promise<TryResult<TryStatus>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  const minor = parseAmountMinor(String(amount ?? ""));
  if (minor === null || minor <= 0) return { ok: false, message: "Enter an amount, for example 800." };
  const r = await amendAction(String(id), { amountMinor: minor }, `Corrected to ${(minor / 100).toFixed(2)} in Try it yourself`);
  return withStatus(id, r);
}

/** Step 4: approve, with the warnings the panel showed, as the request page sends them. Separation of duties applies. */
export async function tryApproveAction(id: string, shownWarnings: string[]): Promise<TryResult<TryStatus>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  return withStatus(id, await approveAction(String(id), undefined, Array.isArray(shownWarnings) ? shownWarnings.map(String) : []));
}

/** Step 4: cancel the request (the request page's Cancel request). Moves no money. */
export async function tryRejectAction(id: string): Promise<TryResult<TryStatus>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  return withStatus(id, await rejectAction(String(id), "Cancelled in Try it yourself"));
}

/** Step 5: pay on the selected rail (simulated: the gate refuses live rails). */
export async function tryPayAction(id: string, rail?: string): Promise<TryResult<TryStatus>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  return withStatus(id, await executeAction(String(id), rail === "paypal" || rail === "stellar" ? (rail as Rail) : undefined));
}

/** Where the request is now, for the panels. */
export async function tryStatusAction(id: string): Promise<TryResult<TryStatus>> {
  const refused = gate();
  if (refused) return { ok: false, message: refused };
  const s = statusOf(String(id));
  return s ? { ok: true, message: "", data: s } : { ok: false, message: "That request is not in this copy of the demo." };
}

function withStatus(id: string, r: { ok: boolean; message: string }): TryResult<TryStatus> {
  const s = statusOf(String(id));
  if (!r.ok) return { ok: false, message: r.message };
  return s ? { ok: true, message: r.message, data: s } : { ok: false, message: "That request is not in this copy of the demo." };
}

function statusOf(id: string): TryStatus | null {
  const d = getObligationDetail(id);
  if (!d) return null;
  const o = d.obligation;
  const rules = d.policyRules.map((r) => ({ ruleId: r.ruleId, passed: r.passed, severity: r.severity, message: r.message }));
  const decision = decide({
    state: o.state,
    vendorName: o.vendorName,
    amountMinor: o.amountMinor,
    currency: o.currency,
    blockedReason: o.blockedReason,
    policyReasons: d.policyReasons,
    rules,
    selectedRail: o.selectedRail,
    availableRails: d.quotes.filter((q) => q.available).map((q) => q.rail),
    hasAccounting: Boolean(d.accounting),
    settlement: d.settlement ? { rail: d.settlement.rail, grossMinor: d.settlement.grossMinor, grossCurrency: d.settlement.grossCurrency, receivedMinor: d.settlement.receivedMinor, receivedCurrency: d.settlement.receivedCurrency, settledAt: d.settlement.settledAt } : null,
    releaseAt: o.releaseAt,
  });
  return {
    id: o.id,
    state: o.state,
    vendorName: o.vendorName,
    amountMinor: o.amountMinor,
    currency: o.currency,
    sourceRef: o.sourceRef,
    title: decision.title,
    evidence: decision.evidence,
    tone: decision.tone,
    action: decision.action,
    rules,
    shownWarnings: d.policyRules.filter((r) => r.severity === "warn" && !r.passed).map((r) => warningFingerprint(r as PolicyRuleResult)),
    rail: o.selectedRail,
    settled: d.settlement ? { rail: d.settlement.rail, grossMinor: d.settlement.grossMinor, grossCurrency: d.settlement.grossCurrency, settledAt: d.settlement.settledAt } : null,
    books: d.accounting ? { status: d.accounting.status, destination: d.accounting.destination } : null,
  };
}
