import { isRealMoney } from "../config";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { accountingSyncs, approvals, auditEntries, businesses, evidence, events, obligations, paymentAttempts, routeQuotes, settlements, vendors, attachments, vendorChanges, vendorInvites, users } from "../db/schema";
import { DEFAULT_POLICY } from "../domain/types";
import { seedDemoTeam } from "../engine/users";
import { hashPayoutDetails, newId } from "../domain/ids";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "../engine/orchestrator";
import { withMockRails } from "../rails";

/**
 * Demo data: Ridgeline Expeditions, a US tour operator running small-group
 * trips in Southeast Asia and paying a distributed roster of guides, drivers,
 * homestays and creators. The story is three live obligations plus a month of
 * history so the dashboard reads like a business, not a fixture.
 */

export const DEMO_BUSINESS_ID = "biz_ridgeline";

/** In live mode, point the Stellar demo recipient at a real funded testnet account (see scripts/stellar-setup.ts). */
/** Live PayPal test: set DEMO_PAYPAL_RECIPIENT to a sandbox Personal account email so Maria's payout lands somewhere real. */
const MARIA_PAYPAL = process.env.DEMO_PAYPAL_RECIPIENT || "maria.santos@example.com";
/** Rosa is the autopilot shot in the video (PayPal only, under the cap), so in a live take her payout must land somewhere real too. */
// A second sandbox account: two vendors paid to one account is itself a warning (payout_shared), which would hold the shot.
const ROSA_PAYPAL = process.env.DEMO_PAYPAL_RECIPIENT_ROSA || "rosa.v@example.com";
const STELLAR_DEMO_RECIPIENT = process.env.DEMO_STELLAR_RECIPIENT ?? "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYM9F3H6VCC4DEMONSTRATION";

export const DEMO_VENDORS = [
  { id: "ven_maria", name: "Maria Santos", role: "guide", country: "PH", email: "maria.santos@example.com", preferredRail: null, paypalEmail: MARIA_PAYPAL, stellarAccount: "GBMARIA6S4NTOSPH7WALLET2LOBSTR3DEMO5ACCOUNT8CHECKRAILP9DEMO", bankCountry: "PH", bankCurrency: "PHP", bankLabel: "BDO ****4417", notes: "Lead guide, Palawan and Ha Giang departures. Prefers to be paid the day a trip ends." },
  { id: "ven_ana", name: "Ana Reyes", role: "guide", country: "PH", email: "ana.reyes@example.com", preferredRail: "stellar", paypalEmail: "ana.reyes@example.com", stellarAccount: STELLAR_DEMO_RECIPIENT, bankCountry: "PH", bankCurrency: "PHP", bankLabel: "UnionBank ****0923", notes: "Asked for the faster rail after a PayPal withdrawal took five days in August." },
  { id: "ven_phuong", name: "Phuong Transport", role: "driver", country: "VN", email: "phuong.transport@example.com", preferredRail: null, paypalEmail: "phuong.transport@example.com", stellarAccount: null, bankCountry: "VN", bankCurrency: "VND", bankLabel: "Vietcombank ****7781", notes: "16-seat van and driver for Ha Giang loop. Contract rate USD 200/day." },
  { id: "ven_linh", name: "Linh Family Homestay", role: "homestay", country: "VN", email: "linh.homestay@example.com", preferredRail: null, paypalEmail: "linh.homestay@example.com", stellarAccount: null, bankCountry: "VN", bankCurrency: "VND", bankLabel: "BIDV ****2206", notes: "Du Gia village. USD 18 per guest per night including dinner." },
  { id: "ven_jake", name: "Jake Morrison", role: "creator", country: "US", email: "jake@example.com", preferredRail: null, paypalEmail: "jake@example.com", stellarAccount: "GBJAKE4Y2ZQ6QLPB3HQ5N3TBKX5TNFBN2V4ZL2RLJMK6UJCDEMONSTR", bankCountry: "US", bankCurrency: "USD", bankLabel: "Chase ****1180", notes: "Video content for departures. Invoices monthly." },
  { id: "ven_kalaw", name: "Kalaw Trekking Collective", role: "guide", country: "PH", email: "kalaw@example.com", preferredRail: null, paypalEmail: "kalaw@example.com", stellarAccount: null, bankCountry: "PH", bankCurrency: "PHP", bankLabel: "BPI ****3350", notes: "Porter and guide collective, three to six people per trip." },
  { id: "ven_dao", name: "Dao Mountain Lodge", role: "hotel", country: "VN", email: "dao.lodge@example.com", preferredRail: null, paypalEmail: "dao.lodge@example.com", stellarAccount: null, bankCountry: "VN", bankCurrency: "VND", bankLabel: "Techcombank ****5519", notes: "Cao Bang. Invoices per departure." },
  { id: "ven_rosa", name: "Rosa Villanueva", role: "guide", country: "PH", email: "rosa.v@example.com", preferredRail: null, paypalEmail: ROSA_PAYPAL, stellarAccount: null, bankCountry: "PH", bankCurrency: "PHP", bankLabel: "BPI ****2210", notes: "Cebu and Bohol day trips. Paid per departure." },
  { id: "ven_bayan", name: "Bayan Island Boats", role: "driver", country: "PH", email: "bayan.boats@example.com", preferredRail: null, paypalEmail: "bayan.boats@example.com", stellarAccount: null, bankCountry: "PH", bankCurrency: "PHP", bankLabel: "Landbank ****7704", notes: "Bangka charters, El Nido. Invoices monthly." },
  { id: "ven_tam", name: "Tam Motorbike Rental", role: "driver", country: "VN", email: "tam.rental@example.com", preferredRail: null, paypalEmail: "tam.rental@example.com", stellarAccount: null, bankCountry: "VN", bankCurrency: "VND", bankLabel: "Techcombank ****3391", notes: "Ha Giang bike fleet. Weekly rental invoices." },
] as const;

/**
 * The demo seed deletes every table. Refuse wherever that could destroy real records: real-money configuration
 * (PayPal live, Stellar public), or a database holding a business other than the demo one.
 */
export function assertSafeToReset(db: Db): void {
  if (isRealMoney()) throw new Error("Refusing to reset: PAYPAL_ENV=live or STELLAR_NETWORK=public is set. The demo seed deletes every table; use a separate demo database.");
  const other = db.select({ id: businesses.id }).from(businesses).all().filter((b) => b.id !== DEMO_BUSINESS_ID);
  if (other.length) throw new Error(`Refusing to reset: this database holds a business other than the demo (${other[0].id}). The demo seed deletes every table.`);
}

export function resetDemo(db: Db): void {
  assertSafeToReset(db);
  for (const t of [auditEntries, events, accountingSyncs, settlements, paymentAttempts, routeQuotes, approvals, evidence, attachments, obligations, vendorChanges, vendorInvites, vendors, users, businesses]) {
    db.delete(t).run();
  }
}

export async function seedDemo(db: Db, opts: { history?: boolean; extras?: boolean } = {}): Promise<{ story: { blockedMismatch: string; blockedDuplicate: string; paypal: string; stellar: string } }> {
  const { history = true, extras = false } = opts;
  resetDemo(db);
  const ts = new Date().toISOString();
  db.insert(businesses).values({ id: DEMO_BUSINESS_ID, name: "Ridgeline Expeditions LLC", baseCurrency: "USD", country: "US", policyJson: JSON.stringify(DEFAULT_POLICY), createdAt: ts }).run();
  seedDemoTeam(db, DEMO_BUSINESS_ID);
  for (const v of DEMO_VENDORS) {
    db.insert(vendors)
      .values({ ...v, businessId: DEMO_BUSINESS_ID, detailsHash: hashPayoutDetails([v.paypalEmail, v.stellarAccount, v.bankLabel]), verifiedAt: "2026-08-14T09:00:00.000Z", createdAt: ts })
      .run();
  }

  if (history) await seedHistory(db);
  if (extras) await seedExtras(db);

  // ---- The story ----

  // C. Amount mismatch: contract says 4 days x USD 200 = 800, request says 960, with urgency pressure.
  const blockedMismatch = await ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "operator_instruction",
    rawInput: "Hey can you pay Phuong Transport INV-2026-0152 today? Van for the Ha Giang 4-day loop (Sept 27 to 30), total $960. He needs it urgently for fuel on the next trip.",
    evidence: [
      { kind: "contract", label: "Transport agreement 2026 (Phuong)", amountMinor: 20_000, currency: "USD", reference: "AGR-PHUONG-2026", excerpt: "Rate: USD 200.00 per vehicle-day, driver and fuel included. Overnight surcharge: none. Tolls reimbursed at cost with receipts." },
      { kind: "job_sheet", label: "Trip sheet HG-4D-0927", amountMinor: 80_000, currency: "USD", reference: "INV-2026-0152", excerpt: "Departure HG-4D-0927. Vehicle days: 4 (27, 28, 29, 30 Sept). Guests: 9. Driver: Phuong. Tolls: none logged. Computed transport cost: 4 x 200 = USD 800.00." },
    ],
    actor: "user:daniel",
  });

  // C2. Duplicate reference: this job sheet was already paid on Sept 16.
  const blockedDuplicate = await ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "invoice",
    rawInput: "Invoice from Maria Santos. Guide fee for JOB-HG4D-0914, 4 days, USD 180. Payment to PayPal please.",
    evidence: [{ kind: "job_sheet", label: "Trip sheet HG-4D-0914", amountMinor: 18_000, currency: "USD", reference: "JOB-HG4D-0914", excerpt: "Departure HG-4D-0914, lead guide Maria Santos, 4 days at USD 45/day = USD 180.00. Completed 14 Sept." }],
    actor: "user:daniel",
  });

  // A. Clean domestic-corridor-like case (US business -> PH guide) under threshold: auto-approved, effective cost is a tie with Stellar, and ties go to PayPal.
  const paypal = await ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "job_completion",
    rawInput: "Trip HG-4D-0921 closed. Lead guide Maria Santos, 4 days, USD 180 (JOB-HG4D-0921). Guest feedback 4.9. Release payment.",
    evidence: [{ kind: "job_sheet", label: "Trip sheet HG-4D-0921", amountMinor: 18_000, currency: "USD", reference: "JOB-HG4D-0921", excerpt: "Departure HG-4D-0921, lead guide Maria Santos, 4 days at USD 45/day = USD 180.00. Completed 24 Sept, signed off by ops." }],
    actor: "system:booking-webhook",
  });

  // B. Cross-border above threshold: needs approval; vendor prefers Stellar, and it is cheaper per dollar spent at this size.
  const stellar = await ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "job_completion",
    rawInput: "Trip PAL-3D-0927 closed. Guide Ana Reyes, 3-day Palawan private, USD 750 (JOB-PAL3D-0927). Client extended one day; rate confirmed with ops. Release payment.",
    evidence: [
      { kind: "job_sheet", label: "Trip sheet PAL-3D-0927", amountMinor: 75_000, currency: "USD", reference: "JOB-PAL3D-0927", excerpt: "Departure PAL-3D-0927, guide Ana Reyes, private party of 2, 3 days at USD 250/day = USD 750.00. Completed 29 Sept." },
      { kind: "message", label: "Ops chat 29 Sept", amountMinor: null, currency: null, reference: null, excerpt: "Ops: Confirming Ana's private rate is 250/day for the Lee extension, approved by Daniel on 25 Sept." },
    ],
    actor: "system:booking-webhook",
  });

  return { story: { blockedMismatch, blockedDuplicate, paypal, stellar } };
}

/**
 * A month of settled history so totals, vendor pages and the ledger have texture.
 * Always paid through the mock rails: with RAIL_MODE=live this used to send nine real sandbox
 * payouts (and, with an empty sandbox balance, left nine failed attempts and no history at all).
 */
async function seedHistory(db: Db): Promise<void> {
  await withMockRails(() => seedHistoryRows(db));
}

async function seedHistoryRows(db: Db): Promise<void> {
  const items: Array<{ vendor: string; ref: string; amount: number; text: string; days: number; sourceType: "job_completion" | "invoice" }> = [
    { vendor: "Maria Santos", ref: "JOB-HG4D-0914", amount: 18_000, text: "Trip HG-4D-0914 closed. Lead guide Maria Santos, 4 days, USD 180 (JOB-HG4D-0914). Release payment.", days: 17, sourceType: "job_completion" },
    { vendor: "Phuong Transport", ref: "INV-2026-0138", amount: 60_000, text: "Invoice INV-2026-0138 from Phuong Transport: van hire 3 days at USD 200, total USD 600.", days: 12, sourceType: "invoice" },
    { vendor: "Linh Family Homestay", ref: "INV-2026-0140", amount: 32_400, text: "Invoice INV-2026-0140 Linh Family Homestay: 9 guests x 2 nights x USD 18 = USD 324.", days: 11, sourceType: "invoice" },
    { vendor: "Kalaw Trekking Collective", ref: "JOB-KAL2D-0915", amount: 42_000, text: "Trip KAL-2D-0915 closed. Kalaw Trekking Collective, 4 porters 2 days, USD 420 (JOB-KAL2D-0915).", days: 15, sourceType: "job_completion" },
    { vendor: "Jake Morrison", ref: "INV-JM-0092", amount: 45_000, text: "Invoice INV-JM-0092 Jake Morrison: departure recap video, USD 450.", days: 9, sourceType: "invoice" },
    { vendor: "Ana Reyes", ref: "JOB-PAL2D-0912", amount: 50_000, text: "Trip PAL-2D-0912 closed. Guide Ana Reyes, 2-day Palawan private, USD 500 (JOB-PAL2D-0912).", days: 19, sourceType: "job_completion" },
    { vendor: "Dao Mountain Lodge", ref: "INV-DML-0919", amount: 68_000, text: "Invoice INV-DML-0919 Dao Mountain Lodge: 8 rooms, 2 nights, USD 680.", days: 8, sourceType: "invoice" },
    { vendor: "Maria Santos", ref: "JOB-HG3D-0907", amount: 13_500, text: "Trip HG-3D-0907 closed. Lead guide Maria Santos, 3 days, USD 135 (JOB-HG3D-0907).", days: 24, sourceType: "job_completion" },
    { vendor: "Kalaw Trekking Collective", ref: "JOB-KAL3D-0901", amount: 63_000, text: "Trip KAL-3D-0901 closed. Kalaw Trekking Collective, 6 porters 3 days, USD 630 (JOB-KAL3D-0901).", days: 29, sourceType: "job_completion" },
    // Older history: 30 to 90 days back, so the chart, vendor pages and medians have texture.
    { vendor: "Maria Santos", ref: "JOB-HG4D-0831", amount: 18_000, text: "Trip HG-4D-0831 closed. Lead guide Maria Santos, 4 days, USD 180 (JOB-HG4D-0831).", days: 34, sourceType: "job_completion" },
    { vendor: "Rosa Villanueva", ref: "JOB-CEB1D-0830", amount: 9_500, text: "Trip CEB-1D-0830 closed. Guide Rosa Villanueva, Cebu day trip, USD 95 (JOB-CEB1D-0830).", days: 36, sourceType: "job_completion" },
    { vendor: "Tam Motorbike Rental", ref: "INV-TAM-0834", amount: 36_000, text: "Invoice INV-TAM-0834 Tam Motorbike Rental: 6 bikes x 4 days x USD 15 = USD 360.", days: 38, sourceType: "invoice" },
    { vendor: "Phuong Transport", ref: "INV-2026-0129", amount: 100_000, text: "Invoice INV-2026-0129 from Phuong Transport: van hire 5 days at USD 200, total USD 1,000.", days: 41, sourceType: "invoice" },
    { vendor: "Bayan Island Boats", ref: "INV-BAYAN-0826", amount: 52_000, text: "Invoice INV-BAYAN-0826 Bayan Island Boats: 4 bangka charters, USD 130 each, USD 520.", days: 43, sourceType: "invoice" },
    { vendor: "Ana Reyes", ref: "JOB-PAL3D-0822", amount: 75_000, text: "Trip PAL-3D-0822 closed. Guide Ana Reyes, 3-day Palawan private, USD 750 (JOB-PAL3D-0822).", days: 46, sourceType: "job_completion" },
    { vendor: "Linh Family Homestay", ref: "INV-2026-0121", amount: 28_800, text: "Invoice INV-2026-0121 Linh Family Homestay: 8 guests x 2 nights x USD 18 = USD 288.", days: 48, sourceType: "invoice" },
    { vendor: "Maria Santos", ref: "JOB-HG3D-0815", amount: 13_500, text: "Trip HG-3D-0815 closed. Lead guide Maria Santos, 3 days, USD 135 (JOB-HG3D-0815).", days: 51, sourceType: "job_completion" },
    { vendor: "Kalaw Trekking Collective", ref: "JOB-KAL2D-0812", amount: 42_000, text: "Trip KAL-2D-0812 closed. Kalaw Trekking Collective, 4 porters 2 days, USD 420 (JOB-KAL2D-0812).", days: 53, sourceType: "job_completion" },
    { vendor: "Rosa Villanueva", ref: "JOB-BOH1D-0810", amount: 11_000, text: "Trip BOH-1D-0810 closed. Guide Rosa Villanueva, Bohol day trip, USD 110 (JOB-BOH1D-0810).", days: 56, sourceType: "job_completion" },
    { vendor: "Jake Morrison", ref: "INV-JM-0088", amount: 45_000, text: "Invoice INV-JM-0088 Jake Morrison: August content package, USD 450.", days: 58, sourceType: "invoice" },
    { vendor: "Tam Motorbike Rental", ref: "INV-TAM-0806", amount: 30_000, text: "Invoice INV-TAM-0806 Tam Motorbike Rental: 5 bikes x 4 days x USD 15 = USD 300.", days: 61, sourceType: "invoice" },
    { vendor: "Dao Mountain Lodge", ref: "INV-DML-0803", amount: 51_000, text: "Invoice INV-DML-0803 Dao Mountain Lodge: 6 rooms, 2 nights, USD 510.", days: 63, sourceType: "invoice" },
    { vendor: "Maria Santos", ref: "JOB-HG4D-0728", amount: 18_000, text: "Trip HG-4D-0728 closed. Lead guide Maria Santos, 4 days, USD 180 (JOB-HG4D-0728).", days: 66, sourceType: "job_completion" },
    { vendor: "Bayan Island Boats", ref: "INV-BAYAN-0726", amount: 39_000, text: "Invoice INV-BAYAN-0726 Bayan Island Boats: 3 bangka charters, USD 130 each, USD 390.", days: 69, sourceType: "invoice" },
    { vendor: "Phuong Transport", ref: "INV-2026-0117", amount: 80_000, text: "Invoice INV-2026-0117 from Phuong Transport: van hire 4 days at USD 200, total USD 800.", days: 71, sourceType: "invoice" },
    { vendor: "Ana Reyes", ref: "JOB-PAL2D-0718", amount: 50_000, text: "Trip PAL-2D-0718 closed. Guide Ana Reyes, 2-day Palawan private, USD 500 (JOB-PAL2D-0718).", days: 74, sourceType: "job_completion" },
    { vendor: "Rosa Villanueva", ref: "JOB-CEB1D-0715", amount: 9_500, text: "Trip CEB-1D-0715 closed. Guide Rosa Villanueva, Cebu day trip, USD 95 (JOB-CEB1D-0715).", days: 77, sourceType: "job_completion" },
    { vendor: "Linh Family Homestay", ref: "INV-2026-0112", amount: 36_000, text: "Invoice INV-2026-0112 Linh Family Homestay: 10 guests x 2 nights x USD 18 = USD 360.", days: 79, sourceType: "invoice" },
    { vendor: "Kalaw Trekking Collective", ref: "JOB-KAL3D-0708", amount: 63_000, text: "Trip KAL-3D-0708 closed. Kalaw Trekking Collective, 6 porters 3 days, USD 630 (JOB-KAL3D-0708).", days: 82, sourceType: "job_completion" },
    { vendor: "Maria Santos", ref: "JOB-HG3D-0704", amount: 13_500, text: "Trip HG-3D-0704 closed. Lead guide Maria Santos, 3 days, USD 135 (JOB-HG3D-0704).", days: 86, sourceType: "job_completion" },
    { vendor: "Tam Motorbike Rental", ref: "INV-TAM-0701", amount: 24_000, text: "Invoice INV-TAM-0701 Tam Motorbike Rental: 4 bikes x 4 days x USD 15 = USD 240.", days: 89, sourceType: "invoice" },
  ];
  for (const it of items) {
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: it.sourceType,
      rawInput: it.text,
      evidence: [{ kind: it.sourceType === "invoice" ? "invoice" : "job_sheet", label: `${it.sourceType === "invoice" ? "Invoice" : "Trip sheet"} ${it.ref}`, amountMinor: it.amount, currency: "USD", reference: it.ref, excerpt: `${it.vendor}: ${it.ref}, USD ${(it.amount / 100).toFixed(2)}. Signed off by ops.` }],
      actor: "system:booking-webhook",
    });
    const ob = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    if (ob.state === "awaiting_approval") approveObligation(db, id, "user:rianne", "Reviewed against trip sheet");
    const after = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    if (after.state === "approved") {
      await executeObligation(db, id, { actor: "user:rianne" });
      await confirmSettlement(db, id, "seed");
    }
    backdate(db, id, it.days);
  }

}

/**
 * Two extra open obligations (one waiting on evidence, one awaiting approval).
 * Off by default so the dashboard matches the four-obligation story; pass
 * { extras: true } to see the inbox with more texture.
 */
async function seedExtras(db: Db): Promise<void> {
  await ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "operator_instruction",
    rawInput: "Dao Mountain Lodge says we owe them for the Oct 1 departure, around USD 1,240, they will send the invoice tomorrow.",
    evidence: [],
    actor: "user:daniel",
  });
  await ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "invoice",
    rawInput: "Invoice INV-JM-0093 from Jake Morrison: September content package (3 edits, 1 reel), USD 450, net 7.",
    evidence: [{ kind: "invoice", label: "Invoice INV-JM-0093", amountMinor: 45_000, currency: "USD", reference: "INV-JM-0093", excerpt: "September content package: 3 departure edits, 1 short reel. USD 450.00. Net 7." }],
    actor: "system:email-ingest",
  });
}

/** Shift an obligation and its children back in time so history looks like history. */
function backdate(db: Db, obligationId: string, days: number): void {
  const shift = (iso: string) => new Date(new Date(iso).getTime() - days * 86_400_000).toISOString();
  const ob = db.select().from(obligations).where(eq(obligations.id, obligationId)).get()!;
  db.update(obligations).set({ createdAt: shift(ob.createdAt), updatedAt: shift(ob.updatedAt) }).where(eq(obligations.id, obligationId)).run();
  for (const s of db.select().from(settlements).where(eq(settlements.obligationId, obligationId)).all()) {
    db.update(settlements).set({ settledAt: shift(s.settledAt) }).where(eq(settlements.id, s.id)).run();
  }
  for (const a of db.select().from(auditEntries).where(eq(auditEntries.obligationId, obligationId)).all()) {
    db.update(auditEntries).set({ createdAt: shift(a.createdAt) }).where(eq(auditEntries.id, a.id)).run();
  }
  for (const p of db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, obligationId)).all()) {
    db.update(paymentAttempts).set({ createdAt: shift(p.createdAt), updatedAt: shift(p.updatedAt) }).where(eq(paymentAttempts.id, p.id)).run();
  }
  for (const a of db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, obligationId)).all()) {
    // The record was built before the shift: move its bill and payment dates with everything else, so the export
    // agrees with the ledger, and mark it exported the day after it was queued.
    const payload = a.payloadJson ? (JSON.parse(a.payloadJson) as Record<string, unknown>) : null;
    if (payload) {
      for (const k of ["billDate", "paymentDate"]) if (typeof payload[k] === "string") payload[k] = shift(`${payload[k]}T12:00:00.000Z`).slice(0, 10);
    }
    const exportedOn = new Date(new Date(shift(a.createdAt)).getTime() + 86_400_000).toISOString().slice(0, 10);
    db.update(accountingSyncs)
      .set({ createdAt: shift(a.createdAt), updatedAt: shift(a.updatedAt), status: "exported", externalRef: `csv:${exportedOn}`, payloadJson: payload ? JSON.stringify(payload) : a.payloadJson })
      .where(eq(accountingSyncs.id, a.id))
      .run();
  }
}

export { newId };
