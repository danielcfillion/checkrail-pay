import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { evidence, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createRun, releaseRun, viewRun } from "./runs";
import { createBill, payBill } from "./bills";
import { createRemittanceLink, remittanceMessageFor, viewRemittance, type Remittance } from "./vendorLinks";
import { confirmSettlement, executeObligation } from "./orchestrator";
import { agedPayables } from "./books";
import { xeroBillRows } from "../accounting/xeroBills";
import { paidSummary } from "../queries";
import { attentionIds, getDailyClose, signOffDailyClose } from "./dailyClose";
import { markReturnedByHand } from "./books";
import { getObligationDetail, waitingIdsFor } from "../queries";
import { readingFor } from "../reading";
import { runLineStatement } from "../../components/check-statement";
import { resetRails } from "../rails";

/** Practitioner round seven (PR7-n): fixes to what round six left. */

let db: Db;
let story: { blockedMismatch: string; blockedDuplicate: string; paypal: string; stellar: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: true }));
});
afterEach(() => resetRails());

describe("PR7-1: the run confirmation says what will be paid, and a waiting item can be approved from the run", () => {
  /** Maria's invoice: only the vendor's own documents support it, so a person reads it first. */
  const ownDocs = () =>
    ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice INV-MS-7001 from Maria Santos for 2 days guiding, USD 90.", evidence: [{ kind: "invoice", label: "Invoice INV-MS-7001", amountMinor: 9_000, currency: "USD", reference: "INV-MS-7001", excerpt: "Maria Santos, 2 days guiding, USD 90." }], actor: "user:lan" });

  it("counts what a release will pay and what it will leave, the same as the release does", async () => {
    const own = await ownDocs();
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, story.stellar, own] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    // paypal is ready, stellar is waiting with nothing to read (a person approves it, release does), own is for its own page.
    expect(view.items.map((i) => [i.obligationId, i.plan, i.leftWhy])).toEqual(expect.arrayContaining([[story.paypal, "pay", null], [story.stellar, "pay", null], [own, "left", "warning"]]));
    expect(view.payNow).toMatchObject({ count: 2, approving: 1, left: 1, leftByReason: { warning: 1, limit: 0, second: 0, changed: 0, state: 0 } });
    expect(view.payNow.byCurrency).toEqual([{ currency: "USD", minor: expect.any(Number) }]);
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toMatchObject({ paid: view.payNow.count, skipped: view.payNow.left });
    expect(ob(own).state).toBe("awaiting_approval");
  });

  it("an approver approves the waiting item from the run with the warnings the page showed, and the plan then includes it", async () => {
    const own = await ownDocs();
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, own] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    const item = view.items.find((i) => i.obligationId === own)!;
    expect(item.canApprove).toBe(true);
    approveObligation(db, own, "user:minh", undefined, item.fingerprints);
    expect(ob(own).state).toBe("approved");
    const after = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    expect(after.payNow).toMatchObject({ count: 2, approving: 0, left: 0 });
    expect(await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId)).toMatchObject({ paid: 2, skipped: 0 });
  });

  it("refuses an approval when a warning appeared after the page was shown, and records nothing", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.stellar] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    const item = view.items[0];
    expect(item.warnings).toEqual([]);
    // After the page was rendered, the vendor uploads a document through their link: a warning a person must read.
    db.insert(evidence).values({ id: "evd_late", obligationId: story.stellar, kind: "receipt", label: "Invoice from the vendor", provenance: "vendor", createdAt: new Date().toISOString() }).run();
    expect(() => approveObligation(db, story.stellar, "user:minh", undefined, item.fingerprints)).toThrow(/Something changed since this page was checked: .*vendor uploaded a document/);
    expect(ob(story.stellar).state).toBe("awaiting_approval");
    // Shown again, with the new warning in the fingerprints, the same person's approval goes through.
    const again = (await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"))).items[0];
    expect(again.warnings.join(" ")).toMatch(/vendor uploaded a document/);
    approveObligation(db, story.stellar, "user:minh", undefined, again.fingerprints);
    expect(ob(story.stellar).state).toBe("approved");
  });

  it("shows an approve action only to someone who may approve that item", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.stellar] });
    expect((await viewRun(db, DEMO_BUSINESS_ID, runId, as("lan"))).items[0].canApprove).toBe(false);
    expect((await viewRun(db, DEMO_BUSINESS_ID, runId, as("thu"))).items[0].canApprove).toBe(false);
    expect((await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"))).items[0].canApprove).toBe(true);
    db.update(users).set({ approvalLimitMinor: 50_000 }).where(eq(users.id, "minh")).run();
    const over = (await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh")));
    expect(over.items[0]).toMatchObject({ canApprove: false, leftWhy: "limit" });
    expect(over.payNow).toMatchObject({ count: 0, left: 1 });
  });
});

describe("PR7-2: a bill nobody approved is not in the ageing or its total", () => {
  it("lists a clerk-recorded bill apart, with vendor and reference, until a payment on it is approved", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_kalaw", { kind: "invoice", reference: "INV-KAL-1030", totalMinor: 50_000, currency: "USD" });
    const before = agedPayables(db, DEMO_BUSINESS_ID);
    expect(before.rows.some((r) => r.reference === "INV-KAL-1030")).toBe(false);
    expect(before.recordedNotApproved.find((r) => r.reference === "INV-KAL-1030")).toMatchObject({ vendorName: "Kalaw Trekking Collective", amountMinor: 50_000, detail: "recorded, not approved" });
    expect(before.recordedNotApproved.some((r) => /^(bil|obl)_/.test(r.reference))).toBe(false);
    // The total is the ageing of the rows only: the recorded bill adds nothing to it.
    const total = (a: typeof before) => Object.values(a.totals).reduce((x, y) => x + y, 0);
    expect(total(before)).toBe(before.rows.reduce((x, r) => x + r.baseMinor, 0));
    // It is not in Xero either, so the two agree.
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: false }).rows.some((r) => r["*InvoiceNumber"] === "INV-KAL-1030")).toBe(false);
    // A payment is requested and approved: now Xero has it, and so does the ageing.
    const pay = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 50_000);
    expect(agedPayables(db, DEMO_BUSINESS_ID).rows.some((r) => r.reference === "INV-KAL-1030")).toBe(false);
    approveObligation(db, pay, "user:minh");
    const after = agedPayables(db, DEMO_BUSINESS_ID);
    expect(after.rows.find((r) => r.reference === "INV-KAL-1030")).toMatchObject({ kind: "bill", amountMinor: 50_000 });
    expect(after.recordedNotApproved.some((r) => r.reference === "INV-KAL-1030")).toBe(false);
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: false }).rows.some((r) => r["*InvoiceNumber"] === "INV-KAL-1030")).toBe(true);
  });
});

describe("PR7-3: the remittance says when a fee came out of the amount", () => {
  const base: Remittance = { businessName: "Ridgeline Expeditions LLC", vendorName: "Ana Reyes", reference: "JOB-PAL3D-0927", amount: "USD 750.00", received: "PHP 45,664.99", rail: "Stellar", date: "30 Oct 2026", providerRef: null, status: "paid", language: "en", withheld: null, shortPaid: null, history: null, feeDeducted: "USD 13.25" };

  it("states the deduction in English and in Vietnamese, with what the vendor receives", () => {
    expect(remittanceMessageFor([base], ["{link0}"])).toBe("Hi Ana Reyes, Ridgeline Expeditions LLC has paid USD 750.00 for JOB-PAL3D-0927 by Stellar on 30 Oct 2026. A USD 13.25 fee was deducted from the amount; you receive PHP 45,664.99. Details: {link0}");
    const vi = remittanceMessageFor([{ ...base, language: "vi", rail: "Stellar" }], ["{link0}"]);
    expect(vi).toMatch(/phí USD 13.25 đã được trừ vào số tiền; bạn nhận PHP 45,664.99\./);
  });

  it("names the reference when there are several payments, and says nothing when no fee was deducted", () => {
    const two = remittanceMessageFor([base, { ...base, reference: "JOB-PAL3D-0928", feeDeducted: null }], ["a", "b"]);
    expect(two).toMatch(/For JOB-PAL3D-0927, a USD 13.25 fee was deducted from the amount; you receive PHP 45,664.99\./);
    expect(two.match(/deducted/g)).toHaveLength(1);
    expect(remittanceMessageFor([{ ...base, feeDeducted: null }], ["a"])).not.toMatch(/deducted/);
  });

  it("a Stellar payment's advice carries the fee; a PayPal payment's, where the sender pays the fee on top, does not", async () => {
    for (const id of [story.stellar, story.paypal]) {
      if (ob(id).state === "awaiting_approval") approveObligation(db, id, "user:daniel");
      await executeObligation(db, id, { actor: "user:minh" });
      await confirmSettlement(db, id);
    }
    const advice = (id: string) => viewRemittance(db, createRemittanceLink(db, DEMO_BUSINESS_ID, as("lan"), id))!;
    expect(advice(story.stellar)).toMatchObject({ rail: "Stellar", amount: "USD 750.00", feeDeducted: "USD 13.25" });
    expect(advice(story.paypal)).toMatchObject({ rail: "PayPal", feeDeducted: null });
  });
});

describe("PR6-6 follow-up: the fee on a returned payout is left out only for PayPal", () => {
  const row = (rail: string, state: string) => ({ grossMinor: 42_500, feeMinor: 850, grossCurrency: "USD", state, rail });

  it("PayPal returns its fee with the payout; a bank file, Wise or Stellar fee was spent", () => {
    expect(paidSummary([row("paypal", "refunded")], "USD")).toEqual({ paidMinor: 0, feesMinor: 0, refundedMinor: 42_500 });
    for (const rail of ["bank_file", "wise", "stellar"]) expect(paidSummary([row(rail, "refunded")], "USD")).toEqual({ paidMinor: 0, feesMinor: 850, refundedMinor: 42_500 });
    expect(paidSummary([row("paypal", "settled"), row("bank_file", "refunded")], "USD")).toEqual({ paidMinor: 42_500, feesMinor: 1_700, refundedMinor: 42_500 });
  });
});

describe("PR7-6: the Daily close shows one line for one job and one line for one vendor's returns", () => {
  const close = () => getDailyClose(db, DEMO_BUSINESS_ID, "USD");
  const rosaSheet = () =>
    ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "job_completion", rawInput: "Trip closed. Lead guide Rosa Villanueva, USD 190 (JOB-CEB2D-1024). Release payment.", evidence: [{ kind: "job_sheet", label: "Trip sheet JOB-CEB2D-1024", amountMinor: 19_000, currency: "USD", reference: "JOB-CEB2D-1024", excerpt: "Rosa Villanueva, USD 190.00. Completed and signed off." }], actor: "system:booking-webhook" });

  it("folds two blocked copies of one job, and the original, into one line, and still counts both as held back", async () => {
    const original = await rosaSheet();
    const copy1 = await rosaSheet();
    const copy2 = await rosaSheet();
    expect([ob(original).state, ob(copy1).state, ob(copy2).state]).toEqual(["approved", "blocked", "blocked"]);
    const before = getDailyClose(db, DEMO_BUSINESS_ID, "USD");
    const lines = before.attention.filter((a) => a.kind === "blocked" && a.sourceRef === "JOB-CEB2D-1024");
    expect(lines).toHaveLength(1);
    expect(lines[0].ids?.sort()).toEqual([copy1, copy2].sort());
    expect(lines[0].note).toMatch(/^2 requests for this job are blocked\. /);
    expect(lines[0].amountMinor).toBe(19_000);
    // The two requests are both money held back: the totals are not folded.
    const seedBlocked = before.attention.filter((a) => a.kind === "blocked" && a.sourceRef !== "JOB-CEB2D-1024").length;
    expect(before.totals.stoppedCount).toBe(seedBlocked + 2);
  });

  it("names every request a folded line stands for, so a request waiting on someone can be tagged as also above (NEW-12)", async () => {
    const original = await rosaSheet();
    const copy1 = await rosaSheet();
    const copy2 = await rosaSheet();
    const above = attentionIds(close().attention);
    expect([copy1, copy2].every((id) => above.has(id))).toBe(true);
    expect(above.has(original)).toBe(false);
    // The blocked copies are also waiting on the clerk: the Daily close tags them rather than listing them twice unmarked.
    expect(waitingIdsFor(as("lan"), db).filter((id) => above.has(id))).toEqual(expect.arrayContaining([copy1, copy2]));
  });

  it("folds payouts that came back for one vendor into one line, and keeps another vendor's apart", async () => {
    const lan = as("lan");
    const bill = createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "invoice", reference: "INV-DML-7001", totalMinor: 85_000, currency: "USD" });
    const paid: string[] = [];
    for (const amount of [42_500, 42_500]) {
      const pay = await payBill(db, DEMO_BUSINESS_ID, lan, bill, amount);
      approveObligation(db, pay, "user:minh");
      await executeObligation(db, pay, { actor: "user:minh" });
      await confirmSettlement(db, pay);
      paid.push(pay);
    }
    await executeObligation(db, story.paypal, { actor: "user:minh" });
    await confirmSettlement(db, story.paypal);
    paid.forEach((id, n) => markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), id, `5TXDAO${n}ABCDEF`));
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), story.paypal, "5TXMARIA180ABC");
    const returned = close().attention.filter((a) => a.kind === "returned");
    expect(returned).toHaveLength(2);
    const dao = returned.find((a) => a.vendorName === "Dao Mountain Lodge")!;
    expect(dao.ids?.sort()).toEqual([...paid].sort());
    expect(dao.amountMinor).toBe(85_000);
    expect(dao.note).toMatch(/^2 payments came back to the business/);
    expect(returned.find((a) => a.vendorName === "Maria Santos")?.ids).toEqual([story.paypal]);
    // Sign-off records every request a folded line stands for.
    const c = close();
    signOffDailyClose(db, DEMO_BUSINESS_ID, "USD", "user:daniel", c.throughSeq);
  });
});

describe("NEW-10: a payment run line carries the reader concern the request page states", () => {
  it("takes the reading from the same place as the request page, so a recorded concern shows on the run line", () => {
    const d = getObligationDetail(story.paypal, db)!;
    const { reader } = readingFor(d, db);
    expect(reader).toMatchObject({ recorded: true });
    expect(reader!.concerns.length + reader!.missing.length).toBeGreaterThan(0);
    const line = runLineStatement({ rules: d.policyRules, reader })!;
    expect(line.chips[0]).toMatch(/reader concern/);
    expect(line.note).toMatch(/The rules did not see this run\./);
    // Ana's request, the one the design review found quiet on the run page, says the same.
    const ana = getObligationDetail(story.stellar, db)!;
    expect(runLineStatement({ rules: ana.policyRules, reader: readingFor(ana, db).reader })?.chips.join(" ")).toMatch(/reader concern|Low confidence/);
  });
});
