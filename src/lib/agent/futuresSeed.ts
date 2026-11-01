import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { agentChecks, agentMandates, agentOffers } from "../db/schema";
import { newId } from "../domain/ids";
import { issueMandate } from "./mandates";
import { validateProvenance } from "./provenance";
import { PHUONG_EMAIL, PHUONG_EMAIL_BANK_CHANGE, PHUONG_EMAIL_CHECK } from "./fixtures/phuongEmail";

/**
 * The demo for the agent features built ahead of the agents that will use them:
 *
 *  - a spending mandate for the demo agent (claude-desktop): drivers and guides, departures in the booking system only,
 *    USD 1,000 a payment, USD 3,000 in all, for 30 days;
 *  - an inbox agent that read Phuong's invoice email (fixtures/phuongEmail.ts) and asked Checkrail with provenance: the
 *    invoice is held because it came from an outside email, and the bank change hidden in the email is refused;
 *  - Phuong Transport's own agent asking for USD 960 and getting a counter-offer of USD 800 against the rate card and
 *    departure HG-4D-0927 (4 vehicle-days at USD 200). The seeded offer stays open for a year, so a copied demo database never shows it expired.
 *
 * The questions are written as the guard writes them (futures.test.ts checks they match what the guard answers today),
 * so a reseed costs no evaluation. Nothing here is a payment request: the inbox, the story and the probe hold for any
 * other agent are untouched.
 */

export const DEMO_MANDATE_AGENT = "claude-desktop";
export const DEMO_INBOX_AGENT = "inbox-assistant";
export const DEMO_SUPPLIER_AGENT = "phuong-agent";

export const DEMO_SUPPLIER_CHECK = {
  payee: "Phuong Transport",
  amount: "960",
  currency: "USD",
  reference: "INV-2026-0177",
  description: "Phuong Transport invoice INV-2026-0177: van and driver for departure HG-4D-0927, 4 days, total USD 960.",
  evidence: [{ kind: "invoice", label: "Invoice INV-2026-0177", amount: "960", reference: "INV-2026-0177", excerpt: "Phuong Transport. Van and driver, Ha Giang loop HG-4D-0927, 27 to 30 Sept. Total USD 960.00." }],
};

/** What the guard answers for each seeded question; the test runs the real guard and compares. */
export const SEEDED_ANSWERS = {
  email: { verdict: "hold", summary: `This instruction came from an outside email (${PHUONG_EMAIL.from}). A person confirms it.`, rules: ["agent_provenance", "agent_provenance", "evidence_present", "ai_missing"] },
  bankChange: {
    verdict: "block",
    summary: `Do not pay: this instruction gives payout details from an outside email (${PHUONG_EMAIL.from}). Checkrail never takes payout details from an agent: a supplier changes them only through the verified supplier flow, checked by a second person.`,
    rules: ["provenance_payout_change", "agent_provenance", "agent_provenance", "evidence_present", "ai_missing"],
  },
  supplier: { verdict: "block", summary: "Do not pay: Rate card and departure HG-4D-0927 say USD 800.00 (4 vehicle-days x USD 200.00); this asks for USD 960.00.", rules: ["expected_amount", "evidence_provenance"] },
} as const;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** The seeded offer stays open for the life of a demo database, however long ago it was seeded or copied (review AF-9). */
export const DEMO_OFFER_TTL_MS = 365 * 86_400_000;

export function seedAgentFutures(db: Db, businessId: string): void {
  // Only this business's demo rows go, and no question is left pointing at a mandate that no longer exists (AF-9).
  const old = db.select({ id: agentMandates.id }).from(agentMandates).where(eq(agentMandates.businessId, businessId)).all().map((m) => m.id);
  if (old.length) db.delete(agentChecks).where(and(eq(agentChecks.businessId, businessId), inArray(agentChecks.mandateId, old))).run();
  db.delete(agentOffers).where(eq(agentOffers.businessId, businessId)).run();
  db.delete(agentMandates).where(eq(agentMandates.businessId, businessId)).run();
  db.delete(agentChecks).where(and(eq(agentChecks.businessId, businessId), inArray(agentChecks.agent, [DEMO_INBOX_AGENT, DEMO_SUPPLIER_AGENT]))).run();

  try {
    issueMandate(db, businessId, "user:daniel", {
      agent: DEMO_MANDATE_AGENT,
      roles: ["driver", "guide"],
      perPayment: "1000",
      total: "3000",
      currency: "USD",
      purpose: "departures",
      note: "Ha Giang and Cebu departures this season",
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
  } catch (e) {
    // A production server without CHECKRAIL_DATA_KEY issues no mandates (AF-3); the rest of the demo still seeds.
    console.warn("[checkrail] demo mandate not issued:", (e as Error).message);
  }

  const key = (ref: string) => `ven:ven_phuong|USD|${ref.toLowerCase()}`;
  const row = (agent: string, at: string, a: { amount: string; reference: string; payee: string }, answer: { verdict: string; summary: string; rules: readonly string[] }, provenance: unknown) => ({
    id: newId("agc"),
    businessId,
    agent,
    tool: "check_payment",
    verdict: answer.verdict,
    payee: a.payee,
    payeeKey: key(a.reference),
    amountMinor: Math.round(Number(a.amount) * 100),
    currency: "USD",
    reference: a.reference,
    summary: answer.summary,
    rulesJson: JSON.stringify(answer.rules),
    obligationId: null,
    idempotencyKey: null,
    createdAt: at,
    // Stored as the guard stores it: checked, every fact a list.
    provenanceJson: provenance ? JSON.stringify(validateProvenance(provenance)) : null,
    mandateId: null,
  });
  const email = row(DEMO_INBOX_AGENT, ago(6), PHUONG_EMAIL_CHECK, SEEDED_ANSWERS.email, PHUONG_EMAIL_CHECK.provenance);
  const bank = row(DEMO_INBOX_AGENT, ago(5), PHUONG_EMAIL_BANK_CHANGE, SEEDED_ANSWERS.bankChange, PHUONG_EMAIL_BANK_CHANGE.provenance);
  const supplier = row(DEMO_SUPPLIER_AGENT, ago(3), DEMO_SUPPLIER_CHECK, SEEDED_ANSWERS.supplier, null);
  db.insert(agentChecks).values([email, bank, supplier]).run();

  const at = ago(3);
  db.insert(agentOffers)
    .values({
      id: newId("ofr"),
      businessId,
      agent: DEMO_SUPPLIER_AGENT,
      vendorId: "ven_phuong",
      checkId: supplier.id,
      obligationId: null,
      askedMinor: 96_000,
      offerMinor: 80_000,
      currency: "USD",
      reference: DEMO_SUPPLIER_CHECK.reference,
      basisRule: "expected_amount",
      basis: "Rate card and departure HG-4D-0927 | 4 vehicle-days x USD 200.00",
      requestJson: JSON.stringify({ payee: DEMO_SUPPLIER_CHECK.payee, reference: DEMO_SUPPLIER_CHECK.reference, description: DEMO_SUPPLIER_CHECK.description, evidence: DEMO_SUPPLIER_CHECK.evidence.map((e) => ({ kind: e.kind, label: e.label, amountMinor: Math.round(Number(e.amount) * 100), currency: "USD", reference: e.reference, excerpt: e.excerpt })) }),
      status: "open",
      expiresAt: new Date(Date.parse(at) + DEMO_OFFER_TTL_MS).toISOString(),
      createdAt: at,
      decidedAt: null,
      resultObligationId: null,
      disputeReason: null,
      disputeEvidenceJson: null,
    })
    .run();
}
