import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { agentOffers, obligations, vendors } from "../db/schema";
import { now } from "../domain/ids";
import { TRANSITIONS, type ObligationState } from "../domain/types";
import { transition } from "../domain/stateMachine";
import { addEvidence } from "../engine/orchestrator";
import { formatMoney } from "../format";
import { AgentInputError } from "./errors";
import { isSupplierKey, type AgentKey } from "./keys";
import { majorString, offerForAgent, offerOf, offerStatus, type OfferRow } from "./offers";
import { describeRequest, submitRequest, validatePaymentArgs, type RequestAnswer } from "./guard";

/**
 * accept_offer and dispute_offer: a supplier's own agent answering a counter-offer (see offers.ts).
 *
 *  - accept_offer puts a new request at the offered amount through the same ingest as any request (submitRequest), so
 *    every rule and the approval step still apply. If the offer answered a blocked request, that request is cancelled
 *    once the new one exists, so one job never has two live requests. Accepting twice returns the same request.
 *  - dispute_offer records the supplier's reason and records and puts the request in front of a person: on the blocked
 *    request it answered (its records added as the supplier's, which policy weighs as a claim) or, for an offer from a
 *    check, as a new request at the amount first asked. Either way a person decides; the supplier's words are its say-so.
 *
 * A supplier key acts only on its own offers, for its own supplier. Nothing here approves, sends or changes payout details.
 */

type StoredRequest = { payee: string; reference: string | null; description: string | null; evidence: Array<{ kind: string; label: string; amountMinor: number | null; reference: string | null; excerpt: string | null }> };

const DISPUTE_FLAG = (offer: OfferRow) =>
  `The supplier's agent disputes Checkrail's counter-offer of ${formatMoney(offer.offerMinor, offer.currency, { code: true })}. Its reason and records are attached as its own say-so; a person decides.`;

function supplierOnly(agent: AgentKey): asserts agent is AgentKey & { vendorId: string } {
  if (!isSupplierKey(agent)) throw new AgentInputError("Only a supplier's own agent can answer a counter-offer");
}

function findOffer(db: Db, agent: AgentKey & { vendorId: string }, raw: unknown): OfferRow {
  const id = (raw as Record<string, unknown> | null)?.offer_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_]{4,64}$/.test(id)) throw new AgentInputError("offer_id is required: the id from counter_offer");
  const o = offerOf(db, id, agent.name, agent.vendorId);
  if (!o) throw new AgentInputError("No offer with that id was made to this agent");
  return o;
}

/** The original request's records, as an agent would send them again. */
function evidenceArgs(req: StoredRequest, currency: string) {
  return (req.evidence ?? []).map((e) => ({ kind: e.kind, label: e.label, amount: e.amountMinor != null ? majorString(e.amountMinor, currency) : undefined, reference: e.reference ?? undefined, excerpt: e.excerpt ?? undefined }));
}

export async function acceptOffer(db: Db, agent: AgentKey, raw: unknown): Promise<RequestAnswer & { offer: ReturnType<typeof offerForAgent> }> {
  supplierOnly(agent);
  const o = findOffer(db, agent, raw);
  const st = offerStatus(o);
  if (st === "disputed") throw new AgentInputError("This offer was disputed; a person is deciding. It cannot be accepted now.");
  if (st === "expired") throw new AgentInputError(`This offer expired at ${o.expiresAt}. Check the payment again for a current answer.`);
  // A person has already acted on the request the offer answered: what happens next is theirs.
  if (st === "open" && o.obligationId) {
    const state = db.select({ s: obligations.state }).from(obligations).where(eq(obligations.id, o.obligationId)).get()?.s;
    if (state !== "blocked") throw new AgentInputError("A person has already acted on the request this offer answered. Use payment_status on it.");
  }
  const req = JSON.parse(o.requestJson) as StoredRequest;
  const vendor = db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, o.vendorId)).get();
  const amount = majorString(o.offerMinor, o.currency);
  const basis = o.basis.replace(" | ", ": ");
  // Checkrail writes this request's words: the offer, its basis and the payee on file. The supplier's earlier figure is
  // not repeated, so the text agrees with the amount sent.
  const args = {
    payee: vendor?.name ?? req.payee,
    amount,
    currency: o.currency,
    reference: o.reference ?? undefined,
    description: `Pay ${vendor?.name ?? req.payee} ${o.currency} ${amount}${o.reference ? ` for ${o.reference}` : ""}: the supplier's agent accepted Checkrail's counter-offer, based on ${basis}.`,
    evidence: evidenceArgs(req, o.currency),
    idempotency_key: `offer-accept-${o.id}`,
  };
  validatePaymentArgs(args);
  // Accepting twice (or two accepts at once) gets the one request: the idempotency key is the offer's own.
  const answer = await submitRequest(db, agent, args, { skipProbe: true });
  if (o.status === "open") {
    db.update(agentOffers).set({ status: "accepted", decidedAt: now(), resultObligationId: answer.request_id }).where(eq(agentOffers.id, o.id)).run();
    if (o.obligationId) withdrawSuperseded(db, o.obligationId, agent.name);
  }
  const after = db.select().from(agentOffers).where(eq(agentOffers.id, o.id)).get()!;
  return { ...answer, offer: offerForAgent(after) };
}

/** The blocked request an accepted offer replaces: cancelled, so one job never has two live requests. */
function withdrawSuperseded(db: Db, obligationId: string, agentName: string): void {
  const state = db.select({ s: obligations.state }).from(obligations).where(eq(obligations.id, obligationId)).get()?.s as ObligationState | undefined;
  if (state === "blocked" && TRANSITIONS[state].includes("cancelled")) transition(db, obligationId, "cancelled", `mcp:${agentName}`, "agent.offer_accepted", { reason: "replaced by the request at Checkrail's counter-offer, which the supplier's agent accepted" });
}

export async function disputeOffer(db: Db, agent: AgentKey, raw: unknown): Promise<RequestAnswer & { offer: ReturnType<typeof offerForAgent> }> {
  supplierOnly(agent);
  const o = findOffer(db, agent, raw);
  const r = raw as Record<string, unknown>;
  const reason = typeof r.reason === "string" ? r.reason.replace(/[\u0000-\u001f\u007f\u200B-\u200D\u2060\uFEFF]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (reason.length < 5) throw new AgentInputError("reason is required: why the supplier disagrees, in a sentence or two");
  if (reason.length > 600) throw new AgentInputError("reason must be at most 600 characters");
  const st = offerStatus(o);
  if (st === "accepted") throw new AgentInputError("This offer was already accepted. Use payment_status on its request.");
  if (st === "disputed") {
    if (!o.resultObligationId) throw new AgentInputError("This offer was already disputed.");
    return { ...describeRequest(db, o.resultObligationId), replayed: true, offer: offerForAgent(o) };
  }
  // A dispute can come after the offer lapsed: the supplier still gets to be heard. Its records, checked like any.
  const req = JSON.parse(o.requestJson) as StoredRequest;
  const probe = validatePaymentArgs({ payee: req.payee, amount: majorString(o.askedMinor, o.currency), currency: o.currency, evidence: r.evidence ?? [] });
  if (probe.evidence.length > 4) throw new AgentInputError("evidence must be a list of at most 4 records for a dispute");
  const extra = probe.evidence.map((e) => ({ ...e, label: `From the supplier's agent: ${e.label}`.slice(0, 200) }));
  const statement = { kind: "message", label: "The supplier's agent disputes the counter-offer (its own say-so)", amountMinor: o.askedMinor, currency: o.currency, reference: o.reference, excerpt: reason };

  let resultId: string;
  let answer: RequestAnswer;
  const state = o.obligationId ? (db.select({ s: obligations.state }).from(obligations).where(eq(obligations.id, o.obligationId)).get()?.s ?? null) : null;
  if (o.obligationId && state && ["drafted", "needs_evidence", "blocked", "awaiting_approval"].includes(state)) {
    // The request the offer answered is still open: the dispute and its records go on it, marked as the supplier's.
    for (const e of [statement, ...extra]) await addEvidence(db, o.obligationId, `mcp:${agent.name}`, { kind: e.kind, label: e.label, amountMinor: e.amountMinor ?? null, currency: e.currency ?? o.currency, reference: e.reference ?? null, excerpt: e.excerpt ?? null, provenance: "vendor" }, null);
    resultId = o.obligationId;
    answer = { ...describeRequest(db, resultId), replayed: false };
  } else if (o.obligationId) {
    throw new AgentInputError("A person has already acted on the request this offer answered. Use payment_status on it.");
  } else {
    // The offer came from a check: the request goes to the inbox at the amount first asked, held for a person.
    const vendor = db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, o.vendorId)).get();
    answer = await submitRequest(
      db,
      agent,
      {
        payee: vendor?.name ?? req.payee,
        amount: majorString(o.askedMinor, o.currency),
        currency: o.currency,
        reference: o.reference ?? undefined,
        description: req.description ?? undefined,
        evidence: [...evidenceArgs(req, o.currency), ...[statement, ...extra].map((e) => ({ kind: e.kind, label: e.label, amount: e.amountMinor != null ? majorString(e.amountMinor, o.currency) : undefined, reference: e.reference ?? undefined, excerpt: e.excerpt ?? undefined }))].slice(0, 10),
        idempotency_key: `offer-dispute-${o.id}`,
      },
      { skipProbe: true, flags: [DISPUTE_FLAG(o)] },
    );
    resultId = answer.request_id;
  }
  db.update(agentOffers).set({ status: "disputed", decidedAt: now(), resultObligationId: resultId, disputeReason: reason, disputeEvidenceJson: JSON.stringify(extra.map((e) => ({ kind: e.kind, label: e.label, amount: e.amountMinor != null ? formatMoney(e.amountMinor, o.currency, { code: true }) : null, excerpt: e.excerpt }))) }).where(eq(agentOffers.id, o.id)).run();
  const after = db.select().from(agentOffers).where(eq(agentOffers.id, o.id)).get()!;
  return { ...answer, offer: offerForAgent(after) };
}
