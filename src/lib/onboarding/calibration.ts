import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { onboardingMarks, onboardingResults, onboardingSuggestions } from "../db/schema";
import { newId, now } from "../domain/ids";
import { audit } from "../domain/stateMachine";
import type { Permission } from "../auth/roles";
import { formatMoney } from "../format";
import { setRate } from "../engine/rates";
import { requirePermission, type Actor } from "../engine/users";
import { MARKS, isFlagged, loadCalls, vendorIndex, type Call, type Mark } from "./calls";

/**
 * Calibration: the owner marks each flagged call "Right catch" or "Was fine", and the marks point to changes that
 * would have avoided the false holds ("add a rate card for X", "connect a booking feed", "verify supplier Y").
 *
 * Marks never change a rule. Suggestions are worked out from the marks and the re-check results by fixed rules (no
 * model), and stay proposed until a person applies or dismisses one; both write an audit row. Applying a rate card
 * suggestion adds the rate card through the same function (and permission check) as the vendor page. Every other kind
 * records the decision and points to the screen where the change is made, with that screen's own checks: a supplier
 * is never verified, and no setting is changed, from here.
 */

export type SuggestionKind = "rate_card" | "booking_feed" | "verify_supplier" | "retainer";
export type SuggestionStatus = "proposed" | "applied" | "dismissed";

/** Who may apply or dismiss each kind: the same people who may make that change on its own screen. */
export const SUGGESTION_PERMISSION: Record<SuggestionKind, Permission> = {
  rate_card: "verify_vendor",
  verify_supplier: "verify_vendor",
  retainer: "verify_vendor",
  booking_feed: "settings",
};

export const SUGGESTION_KIND_LABEL: Record<SuggestionKind, string> = {
  rate_card: "Add a rate card",
  booking_feed: "Connect a booking feed",
  verify_supplier: "Verify a supplier",
  retainer: "Record a monthly retainer",
};

/** Rules that fire when nothing shows the job behind a payment. Fine payments held by these point to a booking feed. */
export const EVIDENCE_RULES = new Set(["evidence_present", "needs_evidence", "job_sheet", "ai_missing", "evidence_provenance", "evidence_names_vendor"]);
/** Rules about the size of the amount. Fine payments held by these point to a rate card for that supplier. */
export const AMOUNT_RULES = new Set(["amount_matches_evidence", "expected_amount", "amount_sane", "stated_unit_rate"]);
/** Rules about who is being paid. */
export const SUPPLIER_RULES = new Set(["recipient_verified", "vendor_known", "vendor_active", "payout_shared", "request_names_vendor"]);
/** Fine payments held for missing evidence before a booking feed is suggested. */
export const BOOKING_FEED_MIN_FINE = 3;
/** A "paid twice" call marked fine whose earlier payment is at least this many days back reads as a monthly retainer. */
export const RETAINER_MIN_GAP_DAYS = 25;

export interface MarkResult {
  callId: string;
  mark: Mark;
  /** Suggestions proposed after this mark (all of them, not only new ones). */
  proposed: SuggestionView[];
}

/** Mark one flagged call. Marking again replaces the earlier mark. Re-works the proposed suggestions; changes no rule. */
export function markCall(db: Db, businessId: string, actor: Actor, callId: unknown, mark: unknown, note?: unknown): MarkResult {
  requirePermission(actor, "approve", "mark the re-check's calls");
  if (typeof callId !== "string") throw new Error("No such call");
  if (!(MARKS as readonly unknown[]).includes(mark)) throw new Error('Mark must be "right_catch" or "was_fine"');
  if (note != null && (typeof note !== "string" || note.length > 500)) throw new Error("A note is text of 500 characters at most");
  const r = db.select().from(onboardingResults).where(and(eq(onboardingResults.id, callId), eq(onboardingResults.businessId, businessId))).get();
  if (!r) throw new Error("No such call");
  if (!isFlagged({ category: r.category as Call["category"] })) throw new Error("Only a payment the re-check stopped or held can be marked");
  const values = { mark: mark as Mark, note: typeof note === "string" && note.trim() ? note.trim() : null, markedBy: actor.id, markedAt: now() };
  const existing = db.select().from(onboardingMarks).where(eq(onboardingMarks.resultId, callId)).get();
  if (existing) db.update(onboardingMarks).set(values).where(eq(onboardingMarks.id, existing.id)).run();
  else db.insert(onboardingMarks).values({ id: newId("obk"), businessId, resultId: callId, ...values }).run();
  generateSuggestions(db, businessId);
  return { callId, mark: mark as Mark, proposed: listSuggestions(db, businessId).filter((s) => s.status === "proposed") };
}

interface Candidate {
  kind: SuggestionKind;
  target: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the marks point to, worked out afresh from every call and mark. Deterministic: same marks, same suggestions. */
export function candidateSuggestions(db: Db, businessId: string, calls: Call[] = loadCalls(db, businessId)): Candidate[] {
  const vendorsByKey = vendorIndex(db, businessId);
  const flagged = calls.filter(isFlagged);
  const fine = flagged.filter((c) => c.mark === "was_fine");
  const out: Candidate[] = [];

  // A booking feed: fine payments held only because nothing showed the job.
  const noEvidence = fine.filter((c) => c.rules.some((r) => EVIDENCE_RULES.has(r)));
  if (noEvidence.length >= BOOKING_FEED_MIN_FINE) {
    out.push({
      kind: "booking_feed",
      target: "business",
      title: "Connect a booking feed",
      detail: `${plural(noEvidence.length, "payment")} you marked fine ${noEvidence.length === 1 ? "was" : "were"} held because nothing showed the trip behind ${noEvidence.length === 1 ? "it" : "them"}. With trips coming in from your booking system, each payment arrives with its job.`,
      payload: { resultIds: noEvidence.map((c) => c.id), count: noEvidence.length },
    });
  }

  // Per supplier, in name order so the list reads the same every time.
  const byPayee = new Map<string, Call[]>();
  for (const c of calls) byPayee.set(c.payeeKey, [...(byPayee.get(c.payeeKey) ?? []), c]);
  for (const key of [...byPayee.keys()].sort()) {
    const all = byPayee.get(key)!;
    const name = all[all.length - 1].payee;
    const v = vendorsByKey.get(key) ?? null;
    const mine = flagged.filter((c) => c.payeeKey === key);
    const myFine = mine.filter((c) => c.mark === "was_fine");

    // Not on the supplier list, or not verified, and the owner has looked at a call about them.
    const marked = mine.filter((c) => c.mark);
    if (marked.length && (!v || !v.verified || !v.active)) {
      out.push({
        kind: "verify_supplier",
        target: v?.id ?? `payee:${key}`,
        title: `Verify supplier ${v?.name ?? name}`,
        detail: !v
          ? `${name} was paid in your history but is not on your supplier list. Add them and have a second person confirm their payout details before Checkrail pays them.`
          : !v.active
            ? `${v.name} is blocked on your supplier list but appears in your payments. Check whether they should be paid.`
            : `${v.name}'s payout details are not verified. A second person confirms them before Checkrail pays them without asking.`,
        payload: { vendorId: v?.id ?? null, payee: name, resultIds: marked.map((c) => c.id), count: marked.length, screen: v ? `/vendors/${v.id}` : "/vendors" },
      });
    }

    // A rate card: fine payments held over their amount, for a supplier with no rate card on file.
    const amountFine = myFine.filter((c) => c.category === "overcharge" || c.rules.some((r) => AMOUNT_RULES.has(r)));
    if (amountFine.length && v && !v.hasRateCard) {
      const currency = amountFine[0].currency;
      const paid = all.filter((c) => c.currency === currency).map((c) => c.amountMinor);
      const rateMinor = median(paid);
      const validFrom = all.map((c) => c.date).sort()[0];
      out.push({
        kind: "rate_card",
        target: v.id,
        title: `Add a rate card for ${v.name}`,
        detail: `${plural(amountFine.length, "payment")} to ${v.name} you marked fine ${amountFine.length === 1 ? "was" : "were"} held over the amount, because nothing says what they charge. Their usual payment in your history is ${formatMoney(rateMinor, currency, { code: true })}; check the unit and rate before applying.`,
        payload: { vendorId: v.id, vendorName: v.name, resultIds: amountFine.map((c) => c.id), count: amountFine.length, proposed: { unit: "trip", rateMinor, currency, validFrom }, screen: `/vendors/${v.id}` },
      });
    }

    // A monthly retainer: the same amount a month apart, marked fine, reads as a fixed fee, not a repeat.
    const retainer = myFine.filter((c) => {
      if (c.category !== "duplicate" || c.duplicateOfRow == null) return false;
      const first = all.find((o) => o.importId === c.importId && o.row === c.duplicateOfRow);
      return first ? (Date.parse(c.date) - Date.parse(first.date)) / 86_400_000 >= RETAINER_MIN_GAP_DAYS : false;
    });
    if (retainer.length && v) {
      const amountMinor = retainer[0].amountMinor;
      out.push({
        kind: "retainer",
        target: v.id,
        title: `Record ${v.name}'s monthly retainer`,
        detail: `${v.name} is paid ${formatMoney(amountMinor, retainer[0].currency, { code: true })} about once a month and you marked the repeat fine. Recording it as a retainer stops the same fee each month reading as a payment made twice.`,
        payload: { vendorId: v.id, amountMinor, currency: retainer[0].currency, resultIds: retainer.map((c) => c.id), count: retainer.length, screen: `/vendors/${v.id}` },
      });
    }
  }
  return out;
}

/**
 * Bring the stored suggestions in line with the marks: new ones are proposed, proposed ones get their basis updated,
 * and proposed ones the marks no longer support are withdrawn. Applied and dismissed ones are kept as they are.
 */
export function generateSuggestions(db: Db, businessId: string): void {
  const want = candidateSuggestions(db, businessId);
  const have = db.select().from(onboardingSuggestions).where(eq(onboardingSuggestions.businessId, businessId)).all();
  const key = (k: string, t: string) => `${k}|${t}`;
  const wanted = new Set(want.map((c) => key(c.kind, c.target)));
  const ts = now();
  for (const c of want) {
    const prev = have.find((h) => key(h.kind, h.target) === key(c.kind, c.target));
    if (!prev) db.insert(onboardingSuggestions).values({ id: newId("obs"), businessId, kind: c.kind, target: c.target, title: c.title, detail: c.detail, payloadJson: JSON.stringify(c.payload), status: "proposed", createdAt: ts }).run();
    else if (prev.status === "proposed") db.update(onboardingSuggestions).set({ title: c.title, detail: c.detail, payloadJson: JSON.stringify(c.payload) }).where(eq(onboardingSuggestions.id, prev.id)).run();
  }
  for (const h of have) if (h.status === "proposed" && !wanted.has(key(h.kind, h.target))) db.delete(onboardingSuggestions).where(eq(onboardingSuggestions.id, h.id)).run();
}

/** A suggestion as the pages show it. JSON-safe. */
export interface SuggestionView {
  id: string;
  kind: SuggestionKind;
  kindLabel: string;
  target: string;
  title: string;
  detail: string;
  status: SuggestionStatus;
  /** For a rate card: the values a person checks before applying. */
  proposed: { unit: string; rateMinor: number; currency: string; validFrom: string } | null;
  /** How many marked calls it rests on. */
  basisCount: number;
  /** Where the change itself is made, when it is not made here. */
  screen: string | null;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

function viewOf(s: typeof onboardingSuggestions.$inferSelect): SuggestionView {
  const p = JSON.parse(s.payloadJson) as { proposed?: SuggestionView["proposed"]; count?: number; screen?: string };
  return {
    id: s.id,
    kind: s.kind as SuggestionKind,
    kindLabel: SUGGESTION_KIND_LABEL[s.kind as SuggestionKind] ?? s.kind,
    target: s.target,
    title: s.title,
    detail: s.detail,
    status: s.status as SuggestionStatus,
    proposed: p.proposed ?? null,
    basisCount: p.count ?? 0,
    screen: p.screen ?? (s.kind === "booking_feed" ? "/settings" : null),
    createdAt: s.createdAt,
    decidedBy: s.decidedBy,
    decidedAt: s.decidedAt,
    decisionNote: s.decisionNote,
  };
}

const STATUS_ORDER: Record<SuggestionStatus, number> = { proposed: 0, applied: 1, dismissed: 2 };

/** Proposed first, then applied, then dismissed; oldest first within each. */
export function listSuggestions(db: Db, businessId: string): SuggestionView[] {
  return db
    .select()
    .from(onboardingSuggestions)
    .where(eq(onboardingSuggestions.businessId, businessId))
    .all()
    .map(viewOf)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.createdAt.localeCompare(b.createdAt) || a.title.localeCompare(b.title));
}

function openSuggestion(db: Db, businessId: string, id: unknown) {
  if (typeof id !== "string") throw new Error("No such suggestion");
  const s = db.select().from(onboardingSuggestions).where(and(eq(onboardingSuggestions.id, id), eq(onboardingSuggestions.businessId, businessId))).get();
  if (!s) throw new Error("No such suggestion");
  if (s.status !== "proposed") throw new Error(`This suggestion was already ${s.status}`);
  return s;
}

export interface ApplyInput {
  /** Rate card suggestions: the values the person checked. Missing ones take the proposed values. */
  rate?: { unit?: unknown; rateMinor?: unknown; currency?: unknown; validFrom?: unknown; validTo?: unknown; note?: unknown };
  note?: unknown;
}

export interface ApplyResult {
  suggestion: SuggestionView;
  /** True when applying changed something in the books (a rate card was added); false when it only recorded the decision. */
  changed: boolean;
  message: string;
}

/**
 * Apply a proposed suggestion: a person's explicit decision, checked against the permission for that change. A rate
 * card goes through setRate (its own permission check and audit row). Every other kind records the decision only.
 */
export function applySuggestion(db: Db, businessId: string, actor: Actor, id: unknown, input: ApplyInput = {}): ApplyResult {
  const s = openSuggestion(db, businessId, id);
  const kind = s.kind as SuggestionKind;
  requirePermission(actor, SUGGESTION_PERMISSION[kind], "apply this suggestion");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  const payload = JSON.parse(s.payloadJson) as { vendorId?: string; vendorName?: string; payee?: string; proposed?: { unit: string; rateMinor: number; currency: string; validFrom: string } };
  let changed = false;
  let rateCardId: string | null = null;
  let message: string;
  if (kind === "rate_card") {
    if (!payload.vendorId || !payload.proposed) throw new Error("This suggestion has no supplier to add a rate card for");
    const r = input.rate ?? {};
    rateCardId = setRate(db, businessId, actor, payload.vendorId, {
      unit: r.unit ?? payload.proposed.unit,
      rateMinor: r.rateMinor ?? payload.proposed.rateMinor,
      currency: r.currency ?? payload.proposed.currency,
      validFrom: r.validFrom ?? payload.proposed.validFrom,
      validTo: r.validTo,
      note: r.note ?? "Added from an onboarding suggestion",
    });
    changed = true;
    message = `Rate card added for ${payload.vendorName ?? "the supplier"}.`;
  } else if (kind === "booking_feed") {
    message = "Noted. Connect your booking system from Settings; nothing else was changed.";
  } else if (kind === "verify_supplier") {
    message = `Noted. Verify ${payload.vendorName ?? payload.payee ?? "the supplier"} on the supplier page; a second person confirms payout details there. Nothing was changed here.`;
  } else {
    message = "Noted. Set the retainer on the supplier page; nothing was changed here.";
  }
  const ts = now();
  db.update(onboardingSuggestions).set({ status: "applied", decidedBy: actor.id, decidedAt: ts, decisionNote: note }).where(eq(onboardingSuggestions.id, s.id)).run();
  audit(db, { obligationId: null, actor: actor.id, action: "onboarding.suggestion_applied", detail: { suggestionId: s.id, kind, target: s.target, title: s.title, changed, rateCardId, note } });
  return { suggestion: viewOf(db.select().from(onboardingSuggestions).where(eq(onboardingSuggestions.id, s.id)).get()!), changed, message };
}

/** Dismiss a proposed suggestion. It stays dismissed; the marks do not propose it again. */
export function dismissSuggestion(db: Db, businessId: string, actor: Actor, id: unknown, note?: unknown): SuggestionView {
  const s = openSuggestion(db, businessId, id);
  requirePermission(actor, SUGGESTION_PERMISSION[s.kind as SuggestionKind], "dismiss this suggestion");
  const n = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  db.update(onboardingSuggestions).set({ status: "dismissed", decidedBy: actor.id, decidedAt: now(), decisionNote: n }).where(eq(onboardingSuggestions.id, s.id)).run();
  audit(db, { obligationId: null, actor: actor.id, action: "onboarding.suggestion_dismissed", detail: { suggestionId: s.id, kind: s.kind, target: s.target, title: s.title, note: n } });
  return viewOf(db.select().from(onboardingSuggestions).where(eq(onboardingSuggestions.id, s.id)).get()!);
}
