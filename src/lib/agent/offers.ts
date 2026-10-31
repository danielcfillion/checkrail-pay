import { and, desc, eq, or } from "drizzle-orm";
import type { Db } from "../db";
import { agentOffers, obligations, vendors } from "../db/schema";
import { newId, now } from "../domain/ids";
import { ZERO_DECIMAL_CURRENCIES } from "../domain/money";
import { formatMoney } from "../format";

/**
 * Counter-offers to a supplier's own agent.
 *
 * When a supplier key's check or request is blocked only because it asks for more than the evidence or the rate card
 * supports, Checkrail answers with what it would put in front of a person instead: the supported amount, the record it
 * comes from, and an expiry. The supplier's agent accepts (a new request at that amount, through the normal ingest, still
 * subject to every rule and to approval) or disputes (a person reads its reason and records, labelled as its say-so).
 * Nothing here pays, approves or changes payout details.
 */

export const OFFER_TTL_MS = 48 * 3600_000;
const AMOUNT_RULES = new Set(["amount_matches_evidence", "expected_amount"]);
const MONEY = "([A-Z]{3}) ([\\d,]+(?:\\.\\d+)?)";
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

export interface OfferBasis {
  offerMinor: number;
  rule: string;
  /** The record the figure comes from: "Rate card and departure HG-4D-0927", "Trip sheet HG-4D-0927", "Bill INV-7". */
  record: string;
  /** How the figure is made up, when the rule says: "4 vehicle-days x USD 200.00". */
  detail: string | null;
}

/**
 * The amount the evidence or rate card supports, read from policy's own block messages (the same sentences the request
 * page reads for its "Correct to" action). Null unless every block is an amount block and each one names a lower figure
 * in the request's currency: an offer that would still be blocked for something else is no offer.
 */
export function counterOfferFrom(blocks: Array<{ rule: string; message: string }>, askedMinor: number, currency: string): OfferBasis | null {
  if (blocks.length === 0 || blocks.some((b) => !AMOUNT_RULES.has(b.rule))) return null;
  const found: OfferBasis[] = [];
  for (const b of blocks) {
    let m = b.message.match(new RegExp(`^Rate card and departure (\\S+) say ${MONEY} \\((.+?)\\); this asks for ${MONEY}`));
    if (m && m[2] === currency) {
      found.push({ offerMinor: toMinor(m[3]), rule: b.rule, record: `Rate card and departure ${m[1]}`, detail: m[4] });
      continue;
    }
    m = b.message.match(new RegExp(`^Requested ${MONEY} but only ${MONEY} is still open on (\\S+)`));
    if (m && m[3] === currency) {
      found.push({ offerMinor: toMinor(m[4]), rule: b.rule, record: `Bill ${m[5]}`, detail: "what is still open on it" });
      continue;
    }
    m = b.message.match(new RegExp(`^Requested ${MONEY} but (.+?) says ${MONEY}`));
    if (m && m[4] === currency) {
      found.push({ offerMinor: toMinor(m[5]), rule: b.rule, record: m[3], detail: null });
      continue;
    }
    return null;
  }
  const best = found.sort((x, y) => x.offerMinor - y.offerMinor)[0];
  if (!best || best.offerMinor <= 0 || best.offerMinor >= askedMinor) return null;
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && best.offerMinor % 100 !== 0) return null;
  return best;
}

export const majorString = (minor: number, currency: string) => (ZERO_DECIMAL_CURRENCIES.has(currency) ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2));

export type OfferRow = typeof agentOffers.$inferSelect;
export type OfferStatus = "open" | "accepted" | "disputed" | "expired";

export const offerStatus = (o: Pick<OfferRow, "status" | "expiresAt">, at = now()): OfferStatus => (o.status === "open" && at >= o.expiresAt ? "expired" : (o.status as OfferStatus));

/** What the supplier's agent reads: the offer and its basis, nothing about the business beyond it. */
export function offerForAgent(o: OfferRow) {
  return {
    offer_id: o.id,
    offer_amount: majorString(o.offerMinor, o.currency),
    currency: o.currency,
    asked_amount: majorString(o.askedMinor, o.currency),
    basis: { rule: o.basisRule, record: o.basis.split(" | ")[0], detail: o.basis.split(" | ")[1] ?? null },
    expires_at: o.expiresAt,
    status: offerStatus(o),
    how_to_answer: "accept_offer(offer_id) puts a request at the offered amount in the business's inbox; it still goes through its rules and approval. dispute_offer(offer_id, reason, evidence) sends your reason and records to a person.",
  };
}
export type CounterOffer = ReturnType<typeof offerForAgent>;

export function recordOffer(db: Db, o: { businessId: string; agent: string; vendorId: string; checkId: string; obligationId: string | null; askedMinor: number; currency: string; reference: string | null; basis: OfferBasis; request: unknown }): OfferRow {
  const row: OfferRow = {
    id: newId("ofr"),
    businessId: o.businessId,
    agent: o.agent,
    vendorId: o.vendorId,
    checkId: o.checkId,
    obligationId: o.obligationId,
    askedMinor: o.askedMinor,
    offerMinor: o.basis.offerMinor,
    currency: o.currency,
    reference: o.reference,
    basisRule: o.basis.rule,
    basis: o.basis.detail ? `${o.basis.record} | ${o.basis.detail}` : o.basis.record,
    requestJson: JSON.stringify(o.request),
    status: "open",
    expiresAt: new Date(Date.now() + OFFER_TTL_MS).toISOString(),
    createdAt: now(),
    decidedAt: null,
    resultObligationId: null,
    disputeReason: null,
    disputeEvidenceJson: null,
  };
  db.insert(agentOffers).values(row).run();
  return row;
}

/** The offer a supplier key may act on: its own, for its own supplier. Anything else reads as not found. */
export function offerOf(db: Db, id: string, agent: string, vendorId: string): OfferRow | null {
  return db.select().from(agentOffers).where(and(eq(agentOffers.id, id), eq(agentOffers.agent, agent), eq(agentOffers.vendorId, vendorId))).get() ?? null;
}

export function offerOnObligation(db: Db, obligationId: string): OfferRow | null {
  return db.select().from(agentOffers).where(eq(agentOffers.obligationId, obligationId)).orderBy(desc(agentOffers.createdAt)).get() ?? null;
}

// ---------- What people see ----------

export interface OfferView {
  id: string;
  agent: string;
  vendorName: string;
  askedMinor: number;
  offerMinor: number;
  currency: string;
  reference: string | null;
  basis: string;
  status: OfferStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  obligationId: string | null;
  resultObligationId: string | null;
  resultState: string | null;
  disputeReason: string | null;
  disputeEvidence: Array<{ kind: string; label: string; amount?: string | null; excerpt?: string | null }>;
}

function view(db: Db, o: OfferRow): OfferView {
  const vendorName = db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, o.vendorId)).get()?.name ?? "A supplier";
  const resultState = o.resultObligationId ? db.select({ s: obligations.state }).from(obligations).where(eq(obligations.id, o.resultObligationId)).get()?.s ?? null : null;
  return {
    id: o.id,
    agent: o.agent,
    vendorName,
    askedMinor: o.askedMinor,
    offerMinor: o.offerMinor,
    currency: o.currency,
    reference: o.reference,
    basis: o.basis.replace(" | ", ": ").replace(/^(Rate card|Trip sheet|Bill|Invoice|Job sheet|Booking)\b/, (w) => `the ${w.toLowerCase()}`),
    status: offerStatus(o),
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    decidedAt: o.decidedAt,
    obligationId: o.obligationId,
    resultObligationId: o.resultObligationId,
    resultState,
    disputeReason: o.disputeReason,
    disputeEvidence: o.disputeEvidenceJson ? (JSON.parse(o.disputeEvidenceJson) as OfferView["disputeEvidence"]) : [],
  };
}

export function listOffers(db: Db, businessId: string, limit = 20): OfferView[] {
  return db.select().from(agentOffers).where(eq(agentOffers.businessId, businessId)).orderBy(desc(agentOffers.createdAt)).limit(limit).all().map((o) => view(db, o));
}

/** Offers about one request: made on it, or the request accepting or disputing one put in the inbox. */
export function offersForRequest(db: Db, obligationId: string): OfferView[] {
  return db.select().from(agentOffers).where(or(eq(agentOffers.obligationId, obligationId), eq(agentOffers.resultObligationId, obligationId))).orderBy(desc(agentOffers.createdAt)).all().map((o) => view(db, o));
}

/** "USD 960.00 asked, USD 800.00 offered": one line for people. */
export const offerLine = (o: Pick<OfferView, "askedMinor" | "offerMinor" | "currency">) => `${formatMoney(o.askedMinor, o.currency, { code: true })} asked, ${formatMoney(o.offerMinor, o.currency, { code: true })} offered`;
