import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { approvals, auditEntries, businesses, evidence as evidenceTable, obligations, paymentAttempts, settlements, vendors, accountingSyncs } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { amendObligation, approveObligation, confirmSettlement, executeObligation, ingestObligation, processObligation, retryAmbiguousExecution, retryFailed, resolveManually, runPolicy } from "./orchestrator";
import { IllegalTransition, transition } from "../domain/stateMachine";
import { DEFAULT_POLICY, type ExecutionRequest, type ExecutionResult, type PaymentRail, type Rail, type SettlementStatus } from "../domain/types";
import { hashPayoutDetails } from "../domain/ids";
import { config } from "../config";
import { getRails, resetRails, setRailsForTest } from "../rails";
import { MockStellarRail } from "../rails/mock";
import { quotePayPal, quoteStellar } from "../rails/quoteModel";

/**
 * Money-path safety tests: double-pay, ambiguous outcomes, input validation,
 * approval integrity and settlement bookkeeping. Rails are scripted so each test
 * decides exactly what the provider "said".
 */

type Step = (req: ExecutionRequest) => ExecutionResult | Promise<ExecutionResult>;

class ScriptedRail implements PaymentRail {
  readonly mode: "sandbox" | "testnet";
  readonly requests: ExecutionRequest[] = [];
  status: SettlementStatus = { status: "pending", externalStatus: "PENDING", raw: null };
  constructor(readonly rail: Rail, public script: Step[]) {
    this.mode = rail === "paypal" ? "sandbox" : "testnet";
  }
  async quote(i: { vendor: Parameters<typeof quotePayPal>[0]; amountMinor: number; currency: string; businessCountry: string }) {
    return this.rail === "paypal" ? quotePayPal(i.vendor, i.amountMinor, i.currency, i.businessCountry) : quoteStellar(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }
  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    this.requests.push(req);
    const step = this.script.shift();
    if (!step) throw new Error("ScriptedRail: no more scripted results");
    return step(req);
  }
  async getStatus(): Promise<SettlementStatus> {
    return this.status;
  }
}

const base = { feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: null };
const submitted = (id: string): Step => () => ({ ...base, status: "submitted", externalId: id, externalStatus: "PENDING" });
const unknown = (msg = "timeout"): Step => () => ({ ...base, status: "unknown", externalId: null, externalStatus: null, errorMessage: msg });
const failed = (msg = "rejected"): Step => () => ({ ...base, status: "failed", externalId: null, externalStatus: null, errorMessage: msg });

let db: Db;
let story: Awaited<ReturnType<typeof seedDemo>>["story"];

const get = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const attemptsOf = (id: string) => db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).all();
const actionsOf = (id: string) => db.select().from(auditEntries).where(eq(auditEntries.obligationId, id)).all().map((a) => a.action);

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: false }));
});
afterEach(() => resetRails());

function installRails(paypal: ScriptedRail, stellar: PaymentRail = new MockStellarRail()) {
  setRailsForTest({ paypal, stellar });
}

describe("C1: ambiguous outcomes never lead to a second payment", () => {
  it("a timeout leaves the obligation in execution_pending with an unknown attempt", async () => {
    const pp = new ScriptedRail("paypal", [unknown("timeout")]);
    installRails(pp);
    const r = await executeObligation(db, story.paypal, { actor: "user:daniel" });
    expect(r.status).toBe("unknown");
    expect(get(story.paypal).state).toBe("execution_pending");
    expect(attemptsOf(story.paypal).map((a) => a.status)).toEqual(["unknown"]);
    expect(actionsOf(story.paypal)).toContain("execution.unknown");
  });

  it("a thrown exception from the rail is an unknown outcome, not a failure", async () => {
    const pp = new ScriptedRail("paypal", [() => { throw new Error("socket hang up"); }]);
    installRails(pp);
    const r = await executeObligation(db, story.paypal, { actor: "user:daniel" });
    expect(r.status).toBe("unknown");
    expect(get(story.paypal).state).toBe("execution_pending");
    expect(attemptsOf(story.paypal)[0].errorMessage).toMatch(/socket hang up/);
  });

  it("cannot be executed again, even if the state is forced back to approved", async () => {
    const pp = new ScriptedRail("paypal", [unknown(), submitted("B-2")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    await expect(executeObligation(db, story.paypal, { actor: "user:daniel" })).rejects.toThrow(/must be approved/);
    db.update(obligations).set({ state: "approved" }).where(eq(obligations.id, story.paypal)).run();
    await expect(executeObligation(db, story.paypal, { actor: "user:daniel" })).rejects.toThrow(/not definitively failed/);
    expect(pp.requests).toHaveLength(1);
  });

  it("reconciliation replays the same request under the same idempotency key", async () => {
    const pp = new ScriptedRail("paypal", [unknown(), submitted("BATCH-1")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    const r = await retryAmbiguousExecution(db, story.paypal, { actor: "user:daniel" });
    expect(r.status).toBe("submitted");
    expect(pp.requests).toHaveLength(2);
    expect(pp.requests[1].idempotencyKey).toBe(pp.requests[0].idempotencyKey);
    expect(pp.requests[1].memo).toBe(pp.requests[0].memo);
    expect(attemptsOf(story.paypal)).toHaveLength(1);
    expect(get(story.paypal).state).toBe("sent");
  });

  it("a replay that the rail rejects does not become a failure: the first submission is still unconfirmed", async () => {
    const pp = new ScriptedRail("paypal", [unknown(), failed("sender_batch_id already exists")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    const r = await retryAmbiguousExecution(db, story.paypal, { actor: "user:daniel" });
    expect(r.status).toBe("unknown");
    expect(get(story.paypal).state).toBe("execution_pending");
    expect(attemptsOf(story.paypal)[0].status).toBe("unknown");
    // And still nothing can mint a second key.
    await expect(executeObligation(db, story.paypal, { actor: "user:daniel" })).rejects.toThrow();
    expect(attemptsOf(story.paypal)).toHaveLength(1);
  });

  it("reconciliation asks the rail about the key before replaying, and settles from what it finds", async () => {
    const pp = new ScriptedRail("paypal", [unknown()]);
    (pp as PaymentRail).findByIdempotencyKey = async () => ({ batchId: "BATCH-FOUND", batchStatus: "SUCCESS" });
    pp.status = { status: "confirmed", externalStatus: "SUCCESS/SUCCESS", raw: null };
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    const r = await retryAmbiguousExecution(db, story.paypal, { actor: "user:daniel" });
    expect(r.status).toBe("confirmed");
    expect(pp.requests).toHaveLength(1); // no replay was needed
    expect(attemptsOf(story.paypal)[0].externalId).toBe("BATCH-FOUND");
    expect(get(story.paypal).state).toBe("settled");
  });

  it("retryFailed moves a failed payment back to approved, re-pins the destination, and refuses if details changed", async () => {
    const pp = new ScriptedRail("paypal", [failed("INSUFFICIENT_FUNDS"), submitted("BATCH-2")]);
    installRails(pp);
    expect((await executeObligation(db, story.paypal, { actor: "user:daniel" })).status).toBe("failed");
    retryFailed(db, story.paypal, "user:daniel");
    expect(get(story.paypal).state).toBe("approved");
    expect(actionsOf(story.paypal)).toContain("execution.retry_requested");
    expect((await executeObligation(db, story.paypal, { actor: "user:daniel" })).status).toBe("submitted");
    expect(attemptsOf(story.paypal)).toHaveLength(2);
  });

  it("a person can resolve a stuck payment from the dashboard: found records the id, nothing moved allows a retry", async () => {
    installRails(new ScriptedRail("paypal", [unknown()]));
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    await expect(resolveManually(db, story.paypal, "agent:autopilot", { kind: "nothing_moved" })).rejects.toThrow(/person/);
    expect(await resolveManually(db, story.paypal, "user:daniel", { kind: "nothing_moved", note: "no batch in dashboard" })).toBe("failed");
    expect(attemptsOf(story.paypal)[0].status).toBe("failed");
    expect(actionsOf(story.paypal)).toContain("execution.resolved_by_hand");
    retryFailed(db, story.paypal, "user:daniel");
    expect(get(story.paypal).state).toBe("approved");
  });

  it("a stuck payment found in the dashboard is recorded as sent under that id, without calling the rail to pay", async () => {
    const pp = new ScriptedRail("paypal", [unknown()]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    await resolveManually(db, story.paypal, "user:daniel", { kind: "found", externalId: "PB-DASH-123" });
    expect(pp.requests).toHaveLength(1);
    expect(attemptsOf(story.paypal)[0].externalId).toBe("PB-DASH-123");
    expect(["sent", "settled"]).toContain(get(story.paypal).state);
  });

  it("an approval does not cover a warning that appears after it: a second payee billing the same reference sends it back", async () => {
    // Ana's USD 750 needs a person (above the auto threshold). Daniel approves it with no warnings on screen.
    approveObligation(db, story.stellar, "user:daniel");
    expect(get(story.stellar).state).toBe("approved");
    // Then Bayan bills the same job reference.
    await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice from Bayan Island Boats for JOB-PAL3D-0927, USD 300.",
      sourceRef: "JOB-PAL3D-0927",
      evidence: [{ kind: "invoice", label: "Invoice JOB-PAL3D-0927", amountMinor: 30_000, currency: "USD", reference: "JOB-PAL3D-0927", excerpt: "Bayan Island Boats, charter, USD 300" }],
      actor: "system:email-ingest",
    });
    await expect(executeObligation(db, story.stellar, { actor: "user:daniel" })).rejects.toThrow(/refused/i);
    expect(get(story.stellar).state).toBe("awaiting_approval");
    expect(get(story.stellar).policyReasonsJson).toMatch(/New since approval/);
    expect(actionsOf(story.stellar)).toContain("approval.superseded");
    // The same person can look again and approve over the new warning.
    approveObligation(db, story.stellar, "user:daniel", "Bayan's charter is a separate cost on the same trip");
    expect(get(story.stellar).state).toBe("approved");
  });

  it("'I found it' refuses an id that belongs to another payment, or that the rail says is not this attempt's", async () => {
    const pp = new ScriptedRail("paypal", [unknown()]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    // Another payment already owns this id.
    db.insert(paymentAttempts).values({ id: "pay_other", obligationId: story.blockedDuplicate, rail: "paypal", idempotencyKey: "z".repeat(32), status: "submitted", mode: "sandbox", externalId: "PB-OTHER-1", createdAt: "x", updatedAt: "x" }).run();
    await expect(resolveManually(db, story.paypal, "user:daniel", { kind: "found", externalId: "PB-OTHER-1" })).rejects.toThrow(/another payment/);
    (pp as PaymentRail).externalIdMatchesKey = async () => false;
    await expect(resolveManually(db, story.paypal, "user:daniel", { kind: "found", externalId: "PB-WRONG-9" })).rejects.toThrow(/not created by this attempt/);
    (pp as PaymentRail).externalIdMatchesKey = async () => null;
    await expect(resolveManually(db, story.paypal, "user:daniel", { kind: "found", externalId: "PB-MAYBE-9" })).rejects.toThrow(/Could not confirm/);
    expect(get(story.paypal).state).toBe("execution_pending");
  });

  it("retryFailed refuses when the vendor's payout details changed after approval", async () => {
    installRails(new ScriptedRail("paypal", [failed("INSUFFICIENT_FUNDS")]));
    expect((await executeObligation(db, story.paypal, { actor: "user:daniel" })).status).toBe("failed");
    const ob = get(story.paypal);
    db.update(vendors).set({ paypalEmail: "someone-else@example.com" }).where(eq(vendors.id, ob.vendorId!)).run();
    expect(() => retryFailed(db, story.paypal, "user:daniel")).toThrow(/payout details/);
    expect(get(story.paypal).state).toBe("failed");
  });

  it("only a definitive failure allows a retry, and the retry gets a fresh key", async () => {
    const pp = new ScriptedRail("paypal", [failed("INSUFFICIENT_FUNDS"), submitted("BATCH-2")]);
    installRails(pp);
    expect((await executeObligation(db, story.paypal, { actor: "user:daniel" })).status).toBe("failed");
    expect(get(story.paypal).state).toBe("failed");
    transition(db, story.paypal, "approved", "user:daniel", "retry");
    expect((await executeObligation(db, story.paypal, { actor: "user:daniel" })).status).toBe("submitted");
    expect(new Set(pp.requests.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(attemptsOf(story.paypal)).toHaveLength(2);
  });

  it("stores the provider id before submit, and an unknown Stellar payment settles from that id", async () => {
    approveObligation(db, story.stellar, "user:daniel");
    const st = new ScriptedRail("stellar", [
      (req) => {
        req.beforeSubmit?.({ externalId: "HASH-PRE" });
        return { ...base, status: "unknown", externalId: null, externalStatus: null, errorMessage: "horizon timeout" };
      },
    ]);
    installRails(new ScriptedRail("paypal", []), st);
    const r = await executeObligation(db, story.stellar, { actor: "user:daniel" });
    expect(r.status).toBe("unknown");
    const attempt = attemptsOf(story.stellar)[0];
    expect(attempt.externalId).toBe("HASH-PRE");
    expect(get(story.stellar).state).toBe("execution_pending");

    st.status = { status: "confirmed", externalStatus: "success", raw: null };
    expect(await confirmSettlement(db, story.stellar, "poll")).toBe("settled");
    const s = db.select().from(settlements).where(eq(settlements.obligationId, story.stellar)).get()!;
    // Live Stellar records what was sent, not the modelled PHP delivery.
    expect(s.receivedCurrency).toBe("PYUSD");
    expect(s.receivedMinor).toBe(75_000);
    expect(s.note).toMatch(/modelled/);
    expect(db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, story.stellar)).all()).toHaveLength(1);
  });
});

describe("H1: one execution at a time", () => {
  it("rejects same-state transitions", () => {
    expect(get(story.paypal).state).toBe("approved");
    expect(() => transition(db, story.paypal, "approved", "t", "noop")).toThrow(IllegalTransition);
  });

  it("two concurrent executes produce exactly one rail call", async () => {
    const pp = new ScriptedRail("paypal", [async () => { await new Promise((r) => setTimeout(r, 10)); return submitted("B-1")({} as ExecutionRequest); }, submitted("B-2")]);
    installRails(pp);
    const results = await Promise.allSettled([executeObligation(db, story.paypal, { actor: "a" }), executeObligation(db, story.paypal, { actor: "b" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(pp.requests).toHaveLength(1);
    expect(attemptsOf(story.paypal)).toHaveLength(1);
  });

  it("passes the business country and a memo built only from safe characters", async () => {
    const pp = new ScriptedRail("paypal", [submitted("B-1")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    expect(pp.requests[0].businessCountry).toBe("US");
    expect(pp.requests[0].memo).toMatch(/^[A-Za-z0-9._/#:\- ]{1,28}$/);
  });
});

describe("C2: amend patches are validated at runtime", () => {
  const amend = (patch: unknown) => amendObligation(db, story.blockedMismatch, "user:daniel", patch as never);

  it("rejects unknown keys so the patch cannot write other columns", async () => {
    await expect(amend({ state: "approved" })).rejects.toThrow(/may not change: state/);
    await expect(amend({ amountMinor: 80_000, policyDecision: "auto_execute" })).rejects.toThrow(/policyDecision/);
    await expect(amend({ aiFlagsJson: "[]" })).rejects.toThrow(/aiFlagsJson/);
    expect(get(story.blockedMismatch).state).toBe("blocked");
  });

  it("rejects bad values", async () => {
    for (const bad of [0.5, -5, 0, 1e12, Number.NaN, "800"]) await expect(amend({ amountMinor: bad })).rejects.toThrow(/amountMinor/);
    await expect(amend({ currency: "EUR" })).rejects.toThrow(/currency/);
    await expect(amend({ sourceRef: "A B" })).rejects.toThrow(/sourceRef/);
    await expect(amend({ sourceRef: "X".repeat(65) })).rejects.toThrow(/sourceRef/);
    await expect(amend({ sourceRef: "INV-1\nINJECT" })).rejects.toThrow(/sourceRef/);
    await expect(amend({})).rejects.toThrow(/empty/);
    await expect(amend(null)).rejects.toThrow(/object/);
    expect(get(story.blockedMismatch).amountMinor).toBe(96_000);
  });

  it("rejects a vendor from another business and an unknown vendor", async () => {
    db.insert(businesses).values({ id: "biz_other", name: "Other", baseCurrency: "USD", country: "US", policyJson: JSON.stringify(DEFAULT_POLICY), createdAt: new Date().toISOString() }).run();
    db.insert(vendors).values({ id: "ven_other", businessId: "biz_other", name: "Other Vendor", role: "supplier", country: "US", detailsHash: "x", createdAt: new Date().toISOString() }).run();
    await expect(amend({ vendorId: "ven_other" })).rejects.toThrow(/not a vendor of this business/);
    await expect(amend({ vendorId: "nope" })).rejects.toThrow(/not a vendor/);
  });

  it("accepts a valid correction", async () => {
    await amend({ amountMinor: 80_000, sourceRef: "inv-2026-0152" });
    const ob = get(story.blockedMismatch);
    expect(ob.amountMinor).toBe(80_000);
    expect(ob.sourceRef).toBe("INV-2026-0152");
  });
});

describe("H3: approvals are people, and the ingester cannot approve", () => {
  async function bigInvoice(actor: string) {
    return ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-JM-9001 Jake Morrison: annual content retainer, total USD 6,000.",
      evidence: [{ kind: "invoice", label: "Invoice INV-JM-9001", amountMinor: 600_000, currency: "USD", reference: "INV-JM-9001", excerpt: "Annual retainer USD 6,000.00" }],
      actor,
    });
  }

  it("one person approving twice does not satisfy dual approval", async () => {
    const id = await bigInvoice("system:email-ingest");
    expect(get(id).state).toBe("awaiting_approval");
    approveObligation(db, id, "user:rianne");
    expect(get(id).state).toBe("awaiting_approval");
    expect(() => approveObligation(db, id, "user:rianne")).toThrow(/already approved/);
    expect(get(id).state).toBe("awaiting_approval");
    approveObligation(db, id, "user:daniel");
    expect(get(id).state).toBe("approved");
  });

  it("policy counts distinct people even if duplicate approval rows exist", async () => {
    const id = await bigInvoice("system:email-ingest");
    approveObligation(db, id, "user:rianne");
    db.insert(approvals).values({ id: "apr_dup", obligationId: id, actor: "user:rianne", decision: "approved", note: null, createdAt: new Date().toISOString() }).run();
    expect(runPolicy(db, id).decision).toBe("require_approval");
  });

  it("separation of duties is enforced when the policy asks for it", async () => {
    db.update(businesses).set({ policyJson: JSON.stringify({ ...DEFAULT_POLICY, requireSeparateApprover: true }) }).where(eq(businesses.id, DEMO_BUSINESS_ID)).run();
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-JM-9002 Jake Morrison: edit package, total USD 400.",
      evidence: [{ kind: "invoice", label: "Invoice INV-JM-9002", amountMinor: 40_000, currency: "USD", reference: "INV-JM-9002", excerpt: "USD 400.00" }],
      actor: "user:daniel",
    });
    expect(get(id).state).toBe("awaiting_approval");
    expect(() => approveObligation(db, id, "user:daniel")).toThrow(/cannot approve/);
    approveObligation(db, id, "user:rianne");
    expect(get(id).state).toBe("approved");
  });

  it("with the policy field unset, the single-operator demo can still approve its own request (mock mode)", async () => {
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-JM-9003 Jake Morrison: edit package, total USD 400.",
      evidence: [{ kind: "invoice", label: "Invoice INV-JM-9003", amountMinor: 40_000, currency: "USD", reference: "INV-JM-9003", excerpt: "USD 400.00" }],
      actor: "user:daniel",
    });
    approveObligation(db, id, "user:daniel");
    expect(get(id).state).toBe("approved");
  });
});

describe("H6: the payout destination is pinned at approval", () => {
  it("refuses and blocks if the PayPal email changed after approval", async () => {
    const pp = new ScriptedRail("paypal", []);
    installRails(pp);
    db.update(vendors).set({ paypalEmail: "attacker@example.com" }).where(eq(vendors.id, "ven_maria")).run();
    await expect(executeObligation(db, story.paypal, { actor: "user:daniel" })).rejects.toThrow(/payout details/);
    expect(get(story.paypal).state).toBe("blocked");
    expect(pp.requests).toHaveLength(0);
    expect(attemptsOf(story.paypal)).toHaveLength(0);
  });

  it("still refuses when the edit also rewrote the stored details hash (approval-time hash differs)", async () => {
    const pp = new ScriptedRail("paypal", []);
    installRails(pp);
    const v = db.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!;
    db.update(vendors).set({ paypalEmail: "attacker@example.com", detailsHash: hashPayoutDetails(["attacker@example.com", v.stellarAccount, v.bankLabel]) }).where(eq(vendors.id, "ven_maria")).run();
    await expect(executeObligation(db, story.paypal, { actor: "user:daniel" })).rejects.toThrow(/changed after this obligation was approved/);
    expect(pp.requests).toHaveLength(0);
  });

  it("supersedes approvals when it blocks, so the new destination needs fresh approval", async () => {
    approveObligation(db, story.stellar, "user:daniel");
    const v = db.select().from(vendors).where(eq(vendors.id, "ven_ana")).get()!;
    db.update(vendors).set({ stellarAccount: "GBJAKE4Y2ZQ6QLPB3HQ5N3TBKX5TNFBN2V4ZL2RLJMK6UJCDEMONSTR", detailsHash: hashPayoutDetails([v.paypalEmail, "GBJAKE4Y2ZQ6QLPB3HQ5N3TBKX5TNFBN2V4ZL2RLJMK6UJCDEMONSTR", v.bankLabel]) }).where(eq(vendors.id, "ven_ana")).run();
    await expect(executeObligation(db, story.stellar, { actor: "user:daniel" })).rejects.toThrow(/refused/);
    const rows = db.select().from(approvals).where(eq(approvals.obligationId, story.stellar)).all();
    expect(rows.every((a) => a.decision === "superseded")).toBe(true);
  });
});

describe("M1: a refusal moves the obligation to the state policy asked for", () => {
  it("evidence removed after approval sends it to needs_evidence instead of throwing IllegalTransition", async () => {
    const pp = new ScriptedRail("paypal", []);
    installRails(pp);
    db.delete(evidenceTable).where(eq(evidenceTable.obligationId, story.paypal)).run();
    await expect(executeObligation(db, story.paypal, { actor: "user:daniel" })).rejects.toThrow(/refused by policy/);
    expect(get(story.paypal).state).toBe("needs_evidence");
    expect(pp.requests).toHaveLength(0);
  });
});

describe("M9: re-interpretation invalidates approvals", () => {
  it("supersedes approvals when reprocessing changes the amount", async () => {
    approveObligation(db, story.stellar, "user:daniel");
    expect(get(story.stellar).state).toBe("approved");
    const raw = get(story.stellar).rawInput.replace("USD 750", "USD 9,999");
    db.update(obligations).set({ rawInput: raw }).where(eq(obligations.id, story.stellar)).run();
    await processObligation(db, story.stellar);
    const rows = db.select().from(approvals).where(eq(approvals.obligationId, story.stellar)).all();
    expect(rows.every((a) => a.decision === "superseded")).toBe(true);
    expect(get(story.stellar).state).not.toBe("approved");
    expect(actionsOf(story.stellar)).toContain("approvals.superseded");
  });
});

describe("H7: velocity cap and untrusted evidence", () => {
  const small = (ref: string, source?: "operator") =>
    ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: `Invoice ${ref} from Kalaw Trekking Collective: porters for trip KAL-2D-${ref.replace(/\D/g, "").padStart(4, "0")}, total USD 250.`,
      evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: 25_000, currency: "USD", reference: ref, excerpt: "Kalaw Trekking Collective, porters, USD 250.00" }],
      evidenceSource: source,
      actor: "system:email-ingest",
    });

  it("forces approval once a vendor's rolling 24h total passes the cap", async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push(await small(`INV-K-${n}`));
    expect(ids.slice(0, 4).map((id) => get(id).state)).toEqual(["approved", "approved", "approved", "approved"]);
    expect(get(ids[4]).state).toBe("awaiting_approval");
    expect(get(ids[4]).policyReasonsJson).toMatch(/daily cap/);
  });

  it("raises a warning for operator-supplied evidence and not for system evidence", async () => {
    const sys = await small("INV-K-10");
    expect(get(sys).state).toBe("approved");
    const op = await small("INV-K-11", "operator");
    expect(get(op).state).toBe("awaiting_approval");
    expect(get(op).policyReasonsJson).toMatch(/Evidence supplied by operator, not system/);
  });
});

describe("H8: unclaimed or held PayPal payouts are exceptions, never failures", () => {
  it("keeps the obligation sent, audits once, and does not allow a retry", async () => {
    const pp = new ScriptedRail("paypal", [submitted("BATCH-U")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    pp.status = { status: "exception", message: "Payout is UNCLAIMED", externalStatus: "SUCCESS/UNCLAIMED", raw: null };
    expect(await confirmSettlement(db, story.paypal, "poll")).toBe("sent");
    expect(await confirmSettlement(db, story.paypal, "poll")).toBe("sent");
    expect(actionsOf(story.paypal).filter((a) => a === "settlement.exception")).toHaveLength(1);
    expect(get(story.paypal).state).toBe("sent");
    expect(db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).all()).toHaveLength(0);
  });

  it("marks the attempt failed when PayPal later returns the money, which makes a retry safe", async () => {
    const pp = new ScriptedRail("paypal", [submitted("BATCH-R"), submitted("BATCH-R2")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    pp.status = { status: "failed", externalStatus: "SUCCESS/RETURNED", raw: null };
    expect(await confirmSettlement(db, story.paypal, "poll")).toBe("failed");
    expect(attemptsOf(story.paypal)[0].status).toBe("failed");
    transition(db, story.paypal, "approved", "user:daniel", "retry");
    expect((await executeObligation(db, story.paypal, { actor: "user:daniel" })).status).toBe("submitted");
  });

  it("live PayPal settlements are labelled as modelled", async () => {
    const pp = new ScriptedRail("paypal", [submitted("BATCH-S")]);
    installRails(pp);
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    pp.status = { status: "confirmed", externalStatus: "SUCCESS/SUCCESS", raw: null };
    await confirmSettlement(db, story.paypal, "poll");
    const s = db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).get()!;
    expect(s.note).toMatch(/modelled/);
  });
});

describe("C4: live mode never falls back to a mock", () => {
  it("throws when credentials are missing", () => {
    const rails = config.rails as { mode: string };
    const prev = rails.mode;
    rails.mode = "live";
    resetRails();
    try {
      expect(() => getRails()).toThrow(/PayPalRail requires/);
    } finally {
      rails.mode = prev;
      resetRails();
    }
  });
});

describe("L1: audit sequence", () => {
  it("cannot contain a duplicate seq", () => {
    const first = db.select().from(auditEntries).all()[0];
    expect(() => db.insert(auditEntries).values({ ...first, id: "aud_dup" }).run()).toThrow();
  });

  it("every transition writes exactly one audit row inside the same transaction", () => {
    const before = db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, story.blockedDuplicate))).all().length;
    transition(db, story.blockedDuplicate, "cancelled", "user:daniel", "test.cancel");
    const after = db.select().from(auditEntries).where(and(eq(auditEntries.obligationId, story.blockedDuplicate))).all().length;
    expect(after).toBe(before + 1);
  });
});

describe("demo seed never touches a live rail (C5)", () => {
  it("pays its history through the mock rails even when a throwing live rail is installed", async () => {
    const { setRailsForTest, resetRails } = await import("../rails");
    // Quotes are read-only and may come from a live rail; moving money must not.
    const { MockPayPalRail } = await import("../rails/mock");
    const quoteOnly = new MockPayPalRail();
    const boom: PaymentRail = { rail: "paypal", mode: "sandbox", quote: (i) => quoteOnly.quote(i), execute: async () => { throw new Error("live execute called"); }, getStatus: async () => { throw new Error("live status called"); } };
    const stellarQuote = new MockStellarRail();
    setRailsForTest({ paypal: boom, stellar: { ...boom, rail: "stellar", quote: (i) => stellarQuote.quote(i) } });
    try {
      const db = openTestDb();
      await seedDemo(db, { history: true });
      const settled = db.select().from(obligations).where(eq(obligations.state, "settled")).all();
      expect(settled.length).toBeGreaterThanOrEqual(9);
      const attempts = db.select().from(paymentAttempts).all();
      expect(attempts.every((a) => a.mode === "mock")).toBe(true);
    } finally {
      resetRails();
    }
  });
});
