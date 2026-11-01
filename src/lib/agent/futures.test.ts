import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { StrKey } from "@stellar/stellar-sdk";
import { generateKeyPairSync, sign } from "node:crypto";
import { openTestDb as openRawTestDb, type Db } from "../db";
import { agentChecks, agentMandates, agentOffers, bills as billsTable, businesses, evidence, obligations, paymentAttempts, vendorChanges, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation, previewPolicy, rejectObligation } from "../engine/orchestrator";
import { createBill } from "../engine/bills";
import { configuredAgentKeys, type AgentKey } from "./keys";
import { checkPayment, paymentStatus, requestPayment } from "./guard";
import { handleMcp, toolsFor } from "./mcp";
import { assessProvenance, isProvenanceHold, provenanceLines, validateProvenance } from "./provenance";
import { DEV_KEY_LABEL, issueMandate, mandatePublicKey, mandateStatus, publicKeyFromRaw, revokeMandate, verifyMandateToken, type MandatePayload } from "./mandates";
import { counterOfferFrom } from "./offers";
import { acceptOffer, disputeOffer } from "./negotiation";
import { PHUONG_EMAIL, PHUONG_EMAIL_BANK_CHANGE, PHUONG_EMAIL_CHECK } from "./fixtures/phuongEmail";
import { DEMO_INBOX_AGENT, DEMO_MANDATE_AGENT, DEMO_SUPPLIER_AGENT, DEMO_SUPPLIER_CHECK, SEEDED_ANSWERS, seedAgentFutures } from "./futuresSeed";

// Every test opens its own in-memory database; close them after each test (native memory, see guard.test.ts).
const opened: Db[] = [];
function openTestDb(): Db {
  const db = openRawTestDb();
  opened.push(db);
  return db;
}
afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      (db as unknown as { $client: { close(): void } }).$client.close();
    } catch {
      // already closed
    }
  }
});

const key = (name: string, scopes: AgentKey["scopes"], vendorId?: string): AgentKey => ({ name, scopes, digest: Buffer.alloc(32), ...(vendorId ? { vendorId } : {}) });
const inbox = key("inbox-bot", ["check", "request"]);
const bookings = key("bookings", ["check", "request", "attest"]);
const desk = key("desk", ["check", "request"]);
const phuongAgent = key("phuong-bot", ["check", "request", "supplier"], "ven_phuong");
const mariaAgent = key("maria-bot", ["check", "request", "supplier"], "ven_maria");

const ROSA = {
  payee: "Rosa Villanueva",
  amount: "190",
  currency: "USD",
  reference: "CEB-2D-1024",
  description: "Trip sheet attached for Rosa Villanueva, please pay.",
  evidence: [{ kind: "job_sheet", label: "Trip completion sheet CEB-2D-1024", amount: "190", reference: "CEB-2D-1024", excerpt: "Departure CEB-2D-1024, Cebu day trips. Guide: Rosa Villanueva. Days: 2 at USD 95. Total USD 190.00." }],
};

function setAutonomy(db: Db, autonomy: "review" | "assist" | "autopilot") {
  const biz = db.select().from(businesses).where(eq(businesses.id, DEMO_BUSINESS_ID)).get()!;
  db.update(businesses).set({ policyJson: JSON.stringify({ ...JSON.parse(biz.policyJson), autonomy }) }).where(eq(businesses.id, DEMO_BUSINESS_ID)).run();
}
const outsideRequests = (db: Db) => db.select().from(obligations).all().filter((o) => o.rawInput.includes("[Outside agent request"));
const rowsOf = (db: Db, agent: string) => db.select().from(agentChecks).where(eq(agentChecks.agent, agent)).all();

// ---------- 1. Instruction provenance ----------

describe("instruction provenance", () => {
  let db: Db;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });

  it("validates sources and keeps senders to an address or a domain", () => {
    expect(validateProvenance(undefined)).toBeNull();
    const p = validateProvenance({ instruction: { kind: "web", sender: "https://www.Phuong-Transport.vn/pay?x=1" }, facts: { amount: [{ kind: "system_of_record", label: "Booking system" }, { kind: "email_external", sender: "mailto:billing@phuong-transport.vn" }] } })!;
    expect(p.instruction).toEqual({ kind: "web", label: null, sender: "phuong-transport.vn" });
    expect(p.facts.amount!.map((s) => s.kind)).toEqual(["system_of_record", "email_external"]);
    for (const bad of [{}, { instruction: { kind: "fax" } }, { instruction: { kind: "web", sender: "pay me now please" } }, { instruction: { kind: "owner_chat" }, facts: { bank: { kind: "web" } } }, { instruction: { kind: "owner_chat" }, facts: { amount: [] } }, "email"]) {
      expect(() => validateProvenance(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("without provenance nothing changes, and the answer says provenance is supported", async () => {
    const a = await checkPayment(db, desk, { payee: "Phuong Transport", amount: "960", currency: "USD", reference: "INV-2026-0177", description: "Van for HG-4D-0927, 4 days, total $960" });
    expect(a.verdict).toBe("block");
    expect(a.blocks.map((b) => b.rule)).toEqual(["expected_amount"]);
    expect(a.provenance_hint).toMatch(/provenance/);
    expect(rowsOf(db, "desk")[0].provenanceJson).toBeNull();
    const r = await requestPayment(db, desk, { ...ROSA, idempotency_key: "rosa-noprov-1" });
    expect(r.provenance_hint).toMatch(/provenance/);
    expect(r.status).toBe("waiting_for_approval");
  });

  it("the email with hidden text: the invoice is held because it came from an outside email", async () => {
    const r = await checkPayment(db, inbox, PHUONG_EMAIL_CHECK);
    expect(r.verdict).toBe("hold");
    expect(r.summary).toBe(`This instruction came from an outside email (${PHUONG_EMAIL.from}). A person confirms it.`);
    expect(r.warnings[0]).toEqual({ rule: "agent_provenance", message: r.summary });
    expect(r.warnings[1].message).toBe(`The payee and amount came only from an outside email (${PHUONG_EMAIL.from}). A person confirms them.`);
    expect(r.provenance_hint).toBeUndefined();
    const row = rowsOf(db, "inbox-bot")[0];
    expect(JSON.parse(row.provenanceJson!).instruction.sender).toBe(PHUONG_EMAIL.from);
    // One line per source: the facts that came from the same email share its line.
    expect(provenanceLines(row.provenanceJson).map((l) => [l.what, l.kindLabel, l.detail])).toEqual([["Instruction", "Outside email", `Invoice email, ${PHUONG_EMAIL.from}`], ["Payee, amount and reference", "Outside email", PHUONG_EMAIL.from]]);
    // As a request it waits for evidence, and says why a person must also look.
    const req = await requestPayment(db, inbox, { ...PHUONG_EMAIL_CHECK, idempotency_key: "phuong-email-hold" });
    expect(req.summary).toBe(`Waiting for supporting evidence before anyone can approve it. This instruction came from an outside email (${PHUONG_EMAIL.from}). A person confirms it.`);
  });

  it("the bank change the email hides is refused outright: blocked on a check, nothing created on a request", async () => {
    const c = await checkPayment(db, inbox, PHUONG_EMAIL_BANK_CHANGE);
    expect(c.verdict).toBe("block");
    expect(c.blocks[0].rule).toBe("provenance_payout_change");
    expect(c.summary).toMatch(/^Do not pay: this instruction gives payout details from an outside email \(billing@phuong-transport\.vn\)\. Checkrail never takes payout details from an agent/);
    await expect(requestPayment(db, inbox, { ...PHUONG_EMAIL_BANK_CHANGE, idempotency_key: "phuong-email-0177" })).rejects.toThrow(/Refused, and nothing was created: this instruction gives payout details/);
    expect(outsideRequests(db)).toHaveLength(0);
    const refused = rowsOf(db, "inbox-bot").find((x) => x.tool === "request_payment")!;
    expect(refused.verdict).toBe("refused");
    expect(JSON.parse(refused.provenanceJson!).facts.payout_details[0].kind).toBe("email_external");
  });

  it("payout details from any source but the supplier portal are refused, even the owner's chat; the portal passes", async () => {
    for (const kind of ["owner_chat", "system_of_record", "email_internal", "document", "web", "unknown"]) {
      expect(assessProvenance(validateProvenance({ instruction: { kind: "owner_chat" }, facts: { payout_details: { kind } } })).refusal, kind).toMatch(/never takes payout details/);
    }
    // AF-2: a portal claim is the agent's word too: held, never accepted.
    const portal = assessProvenance(validateProvenance({ instruction: { kind: "owner_chat" }, facts: { payout_details: { kind: "vendor_portal" } } }));
    expect(portal.refusal).toBeNull();
    expect(portal.holds).toEqual(["The agent says payout details came from the supplier portal. Checkrail never takes payout details from an agent and pays only the details on file. A person confirms it."]);
  });

  it("a request from an outside email goes to the inbox held for a person, with the reason on the request", async () => {
    setAutonomy(db, "autopilot");
    const r = await requestPayment(db, bookings, { ...ROSA, idempotency_key: "rosa-email-1", provenance: { instruction: { kind: "email_external", sender: "rosa.v@gmail.com" } } });
    expect(r.status).toBe("waiting_for_approval");
    expect(r.summary).toBe("Waiting for a person to approve: This instruction came from an outside email (rosa.v@gmail.com). A person confirms it.");
    expect(r.releases_at).toBeNull();
    const ob = db.select().from(obligations).where(eq(obligations.id, r.request_id)).get()!;
    expect(JSON.parse(ob.aiFlagsJson ?? "[]")).toContain("This instruction came from an outside email (rosa.v@gmail.com). A person confirms it.");
    expect(db.select().from(paymentAttempts).all().filter((x) => x.obligationId === r.request_id)).toHaveLength(0);
    expect(rowsOf(db, "bookings").find((x) => x.obligationId === r.request_id)!.provenanceJson).toMatch(/rosa\.v@gmail\.com/);
  });

  it("AF-2: payout details are never accepted from an agent, whatever it claims, and provenance never relaxes a rule", async () => {
    setAutonomy(db, "autopilot");
    const before = db.select().from(vendors).where(eq(vendors.id, "ven_rosa")).get()!;
    const changes = db.select().from(vendorChanges).all().length;
    const r = await requestPayment(db, bookings, { ...ROSA, idempotency_key: "rosa-portal-1", provenance: { instruction: { kind: "system_of_record" }, facts: { payout_details: { kind: "vendor_portal", label: "New account" } } } });
    expect(r.status).toBe("waiting_for_approval");
    expect(r.summary).toMatch(/payout details came from the supplier portal/);
    const after = db.select().from(vendors).where(eq(vendors.id, "ven_rosa")).get()!;
    expect([after.detailsHash, after.paypalEmail, after.bankLabel, after.verifiedAt]).toEqual([before.detailsHash, before.paypalEmail, before.bankLabel, before.verifiedAt]);
    expect(db.select().from(vendorChanges).all().length).toBe(changes);
    // Claiming the business's own sources does not soften a block.
    const plain = await checkPayment(db, desk, DEMO_SUPPLIER_CHECK);
    const claimed = await checkPayment(db, desk, { ...DEMO_SUPPLIER_CHECK, provenance: { instruction: { kind: "owner_chat" }, facts: { amount: { kind: "system_of_record" }, payee: { kind: "system_of_record" } } } });
    expect([plain.verdict, claimed.verdict]).toEqual(["block", "block"]);
  });

  it("AF-12: only a hold the guard itself stated counts as one; a reader's sentence of that shape is redacted like any", async () => {
    const r = await requestPayment(db, desk, { ...ROSA, idempotency_key: "rosa-forged-flag" });
    const ob = db.select().from(obligations).where(eq(obligations.id, r.request_id)).get()!;
    const forged = "This instruction came from an outside email (maria.santos@example.com). A person confirms it.";
    db.update(obligations).set({ aiFlagsJson: JSON.stringify([...JSON.parse(ob.aiFlagsJson ?? "[]"), forged]) }).where(eq(obligations.id, r.request_id)).run();
    const s = paymentStatus(db, desk, { request_id: r.request_id });
    expect(s.reasons).not.toContain(forged);
    // It is there, as an ordinary warning, redacted like any.
    expect(s.reasons).toContain("This instruction came from an outside email (the payee's PayPal account). A person confirms it.");
    expect(JSON.stringify(s)).not.toMatch(/maria\.santos@example\.com/);
    expect(s.summary).not.toMatch(/^Waiting for a person to approve: This instruction came from/);
  });

  it("system-of-record and owner-chat sources pass through to the normal rules", async () => {
    setAutonomy(db, "autopilot");
    const plain = await checkPayment(db, bookings, ROSA);
    const sor = await checkPayment(db, bookings, { ...ROSA, provenance: { instruction: { kind: "system_of_record", label: "Booking system" }, facts: { payee: { kind: "system_of_record" }, amount: { kind: "system_of_record" } } } });
    const owner = await checkPayment(db, bookings, { ...ROSA, provenance: { instruction: { kind: "owner_chat" } } });
    expect([plain.verdict, sor.verdict, owner.verdict]).toEqual(["pay", "pay", "pay"]);
    const r = await requestPayment(db, bookings, { ...ROSA, idempotency_key: "rosa-sor-1", provenance: { instruction: { kind: "system_of_record", label: "Booking system" } } });
    expect(r.status).toBe("scheduled");
  });

  it("mixed sources: a fact the business's own records also back is not held; one only from outside is", async () => {
    setAutonomy(db, "autopilot");
    const mixed = await checkPayment(db, bookings, { ...ROSA, provenance: { instruction: { kind: "owner_chat" }, facts: { amount: [{ kind: "system_of_record" }, { kind: "email_external", sender: "rosa.v@gmail.com" }], payee: [{ kind: "web", sender: "rosa-tours.ph" }, { kind: "system_of_record" }] } } });
    expect(mixed.verdict).toBe("pay");
    const payeeOnly = await checkPayment(db, bookings, { ...ROSA, provenance: { instruction: { kind: "owner_chat" }, facts: { payee: { kind: "web", sender: "rosa-tours.ph" }, amount: { kind: "system_of_record" } } } });
    expect(payeeOnly.verdict).toBe("hold");
    expect(payeeOnly.summary).toBe("The payee came only from a web page (rosa-tours.ph). A person confirms it.");
    const unknown = assessProvenance(validateProvenance({ instruction: { kind: "unknown" } }));
    expect(unknown.holds).toEqual(["This instruction came from a source the agent could not name. A person confirms it."]);
    expect(unknown.holds.every(isProvenanceHold)).toBe(true);
  });

  it("a held provenance concern stays a hold through the MCP handler too, over the same tool", async () => {
    const r = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_payment", arguments: PHUONG_EMAIL_CHECK } }, { db, agent: inbox, version: "test" })) as { result: { structuredContent: { verdict: string; summary: string } } };
    expect(r.result.structuredContent.verdict).toBe("hold");
    const bad = (await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_payment", arguments: { ...PHUONG_EMAIL_CHECK, provenance: { instruction: { kind: "carrier_pigeon" } } } } }, { db, agent: inbox, version: "test" })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/kind must be one of/);
  });
});

// ---------- 2. Signed spending mandates ----------

describe("signed spending mandates", () => {
  let db: Db;
  const issue = (over: Record<string, unknown> = {}) =>
    issueMandate(db, DEMO_BUSINESS_ID, "user:daniel", { agent: "desk", roles: ["guide"], perPayment: "200", total: "500", currency: "USD", purpose: "departures", validUntil: new Date(Date.now() + 86_400_000).toISOString(), ...over }).token;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });

  it("is an Ed25519 signature anyone with the public key can verify, and the key is a Stellar account key", () => {
    const token = issue();
    const pk = mandatePublicKey();
    expect(pk.stellar).toBe(StrKey.encodeEd25519PublicKey(pk.raw));
    const v = verifyMandateToken(token, publicKeyFromRaw(Buffer.from(pk.base64url, "base64url")));
    expect(v.ok && v.payload.agent).toBe("desk");
    expect(v.ok && v.payload.per_payment_minor).toBe(20_000);
  });

  it("a request inside the mandate goes on to the normal rules: the agent's own say-so still waits for a person", async () => {
    setAutonomy(db, "autopilot");
    const mandate = issue();
    const r = await requestPayment(db, desk, { ...ROSA, idempotency_key: "rosa-mandate-1", mandate });
    expect(r.status).toBe("waiting_for_approval");
    expect(r.mandate?.remaining).toBe("USD 310.00");
    expect(rowsOf(db, "desk").find((x) => x.obligationId === r.request_id)!.mandateId).toMatch(/^mdt_/);
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate }).remaining).toBe("310.00");
  });

  it("refuses a forged, re-signed, expired, not yet valid, revoked or someone else's mandate, and creates nothing", async () => {
    const good = issue();
    const [p, body, sig] = good.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as MandatePayload;
    const raised = `${p}.${Buffer.from(JSON.stringify({ ...payload, total_minor: 9_999_900 })).toString("base64url")}.${sig}`;
    const other = generateKeyPairSync("ed25519").privateKey;
    const foreignBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const foreign = `crm1.${foreignBody}.${sign(null, Buffer.from(`crm1.${foreignBody}`), other).toString("base64url")}`;
    const expired = issue({ validFrom: new Date(Date.now() - 3 * 86_400_000).toISOString(), validUntil: new Date(Date.now() - 86_400_000).toISOString() });
    const later = issue({ validFrom: new Date(Date.now() + 86_400_000).toISOString(), validUntil: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    const revoked = issue();
    revokeMandate(db, DEMO_BUSINESS_ID, db.select().from(agentMandates).all().find((m) => m.token === revoked)!.id, "user:daniel");
    const theirs = issue({ agent: "bookings" });
    const cases: Array<[string, string, RegExp]> = [
      ["garbage", "not-a-mandate", /not a Checkrail mandate/],
      ["raised total", raised, /signature does not verify/],
      ["another signer", foreign, /signature does not verify/],
      ["expired", expired, /expired on/],
      ["not yet valid", later, /valid only from/],
      ["revoked", revoked, /revoked by the owner/],
      ["another agent", theirs, /issued to another agent/],
    ];
    for (const [i, [name, mandate, why]] of cases.entries()) {
      await expect(requestPayment(db, desk, { ...ROSA, idempotency_key: `rosa-bad-${i}`, mandate }), name).rejects.toThrow(why);
    }
    expect(outsideRequests(db)).toHaveLength(0);
    expect(rowsOf(db, "desk").every((x) => x.verdict === "refused")).toBe(true);
    expect(() => mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: theirs })).toThrow(/another agent/);
    expect(() => mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: raised })).toThrow(/signature/);
  });

  it("refuses a payee, currency, amount or purpose outside the mandate", async () => {
    const m = issue();
    await expect(requestPayment(db, desk, { payee: "Phuong Transport", amount: "150", currency: "USD", reference: "INV-2026-0177", description: "Van for HG-4D-0927", idempotency_key: "ph-scope-1", mandate: m })).rejects.toThrow(/does not cover this payee/);
    await expect(requestPayment(db, desk, { ...ROSA, currency: "PHP", amount: "9500", evidence: [], idempotency_key: "rosa-scope-2", mandate: m })).rejects.toThrow(/payments in USD, not PHP/);
    await expect(requestPayment(db, desk, { ...ROSA, amount: "250", evidence: [], idempotency_key: "rosa-scope-3", mandate: m })).rejects.toThrow(/at most USD 200.00 per payment/);
    await expect(requestPayment(db, desk, { payee: "Rosa Villanueva", amount: "95", currency: "USD", reference: "INV-ROSA-0942", description: "Rosa Villanueva, guiding", idempotency_key: "rosa-scope-4", mandate: m })).rejects.toThrow(/departures in the booking system only/);
    // Maria guides, but not on the Cebu departure: the purpose wants a departure this supplier serves.
    await expect(requestPayment(db, desk, { payee: "Maria Santos", amount: "90", currency: "USD", reference: "CEB-2D-1024", description: "Maria Santos for CEB-2D-1024", idempotency_key: "maria-scope-5", mandate: m })).rejects.toThrow(/departures in the booking system only/);
    expect(outsideRequests(db)).toHaveLength(0);
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: m }).used).toBe("0.00");
  });

  it("budget: earlier requests count, cancelled ones do not, and concurrent requests cannot overspend", async () => {
    const m = issue({ purpose: null, roles: ["guide", "driver"], perPayment: "300", total: "500" });
    const ask = (i: number, amount: string) => requestPayment(db, desk, { payee: "Kalaw Trekking Collective", amount, currency: "USD", reference: `JOB-KAL-${1000 + i}`, description: `Pay Kalaw Trekking Collective USD ${amount} for porters, JOB-KAL-${1000 + i}`, idempotency_key: `kalaw-budget-${i}`, mandate: m });
    // Three at once, USD 250 each, against USD 500: two fit, one is refused, never three.
    const results = await Promise.allSettled([ask(1, "250"), ask(2, "250"), ask(3, "250")]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    const refusal = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(refusal.reason)).toMatch(/the mandate has USD 0.00 left of USD 500.00; this asks for USD 250.00/);
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: m }).remaining).toBe("0.00");
    // A cancelled request gives its share back; a retry of a request already made does not count twice.
    const first = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof requestPayment>>>).value;
    rejectObligation(db, first.request_id, "user:daniel", "not this one");
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: m }).remaining).toBe("250.00");
    const replay = await ask(1, "250");
    expect(replay.replayed).toBe(true);
    expect(replay.mandate?.remaining).toBe("USD 250.00");
    expect((await ask(4, "250")).replayed).toBe(false);
    await expect(ask(5, "10")).rejects.toThrow(/USD 0.00 left/);
  });

  it("AF-5: blocked, failed and returned requests use none of the budget", async () => {
    const m = issue({ perPayment: "300", total: "500" });
    const blocked = await requestPayment(db, desk, { ...ROSA, amount: "250", evidence: [], description: "Pay Rosa Villanueva USD 250 for CEB-2D-1024.", idempotency_key: "rosa-over-250", mandate: m });
    expect(blocked.status).toBe("blocked");
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: m }).used).toBe("0.00");
    const ok = await requestPayment(db, desk, { ...ROSA, idempotency_key: "rosa-ok-190", mandate: m });
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: m }).used).toBe("190.00");
    for (const state of ["failed", "refunded"] as const) {
      db.update(obligations).set({ state }).where(eq(obligations.id, ok.request_id)).run();
      expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: m }).used, state).toBe("0.00");
    }
  });

  it("AF-11: the departures purpose binds the reference, not a departure named in the description", async () => {
    const m = issue();
    await expect(requestPayment(db, desk, { payee: "Rosa Villanueva", amount: "95", currency: "USD", reference: "INV-ROSA-0942", description: "Rosa Villanueva, one day of CEB-2D-1024", idempotency_key: "rosa-desc-dep", mandate: m })).rejects.toThrow(/reference is not a departure on file/);
    expect((await requestPayment(db, desk, { ...ROSA, idempotency_key: "rosa-ref-dep", mandate: m })).status).toBe("waiting_for_approval");
  });

  it("AF-3: a development key says so everywhere, and production refuses to issue without a real key", () => {
    vi.stubEnv("CHECKRAIL_DATA_KEY", "");
    const token = issue();
    const v = verifyMandateToken(token);
    expect(v.ok && v.payload.signing_key).toBe(DEV_KEY_LABEL);
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: token }).signer_public_key.trust).toBe(DEV_KEY_LABEL);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => issue()).toThrow(/Mandates cannot be issued on this server: CHECKRAIL_DATA_KEY is not set/);
    vi.stubEnv("CHECKRAIL_DATA_KEY", Buffer.alloc(32, 7).toString("base64"));
    const real = issue();
    const r = verifyMandateToken(real);
    expect(r.ok && r.payload.signing_key).toBeUndefined();
    expect(mandateStatus(db, desk, DEMO_BUSINESS_ID, { mandate: real }).signer_public_key.trust).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("the mandate is a tool for the agent it was issued to, and the owner's list shows what is left", async () => {
    expect(toolsFor(desk).map((t) => t.name)).toContain("mandate_status");
    expect(toolsFor(key("auditor", ["check"])).map((t) => t.name)).not.toContain("mandate_status");
    const r = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mandate_status", arguments: { mandate: issue() } } }, { db, agent: desk, version: "test" })) as { result: { structuredContent: { status: string; remaining: string; signer_public_key: { stellar: string } } } };
    expect(r.result.structuredContent).toMatchObject({ status: "active", remaining: "500.00" });
    expect(r.result.structuredContent.signer_public_key.stellar).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("issuing checks what the owner typed", () => {
    expect(() => issue({ agent: "Desk Bot" })).toThrow(/agent key/);
    expect(() => issue({ roles: [], payees: [] })).toThrow(/at least one supplier/);
    expect(() => issue({ perPayment: "600" })).toThrow(/cannot be more than the total/);
    expect(() => issue({ currency: "EUR" })).toThrow(/Currency/);
    expect(() => issue({ payees: ["ven_nobody"] })).toThrow(/not on file/);
    expect(() => issue({ validUntil: new Date(Date.now() + 400 * 86_400_000).toISOString() })).toThrow(/a year at most/);
  });
});

// ---------- 3. Negotiation with a supplier's agent ----------

describe("negotiation with a supplier's agent", () => {
  let db: Db;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });
  const offerRows = () => db.select().from(agentOffers).all().filter((o) => o.agent !== DEMO_SUPPLIER_AGENT);

  it("reads supplier keys tied to one supplier", () => {
    const keys = configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: `phuong-agent:${"s".repeat(32)}:supplier=ven_phuong` })!;
    expect(keys[0]).toMatchObject({ name: "phuong-agent", scopes: ["check", "request", "supplier"], vendorId: "ven_phuong" });
    expect(configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: `phuong-agent:${"s".repeat(32)}:supplier=` })).toBeNull();
    expect(configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: `phuong-agent:${"s".repeat(32)}:check+supplier=ven_phuong` })).toBeNull();
  });

  it("AF-1: no offer based on a record the supplier's agent attached, however it is labelled", async () => {
    // The reviewer's case: USD 2,000 asked, the agent's own invoice "Rate card 2026 tariff" says USD 1,900.
    const ask = { payee: "Phuong Transport", amount: "2000", currency: "USD", reference: "INV-2026-0501", description: "Phuong Transport invoice INV-2026-0501, van hire, total USD 2,000.", evidence: [{ kind: "invoice", label: "Rate card 2026 tariff", amount: "1900", reference: "INV-2026-0501", excerpt: "Tariff USD 1,900." }] };
    const c = await checkPayment(db, phuongAgent, ask);
    expect(c.verdict).toBe("block");
    expect(c.blocks.map((b) => b.rule)).toContain("amount_matches_evidence");
    expect(c.counter_offer).toBeUndefined();
    const r = await requestPayment(db, phuongAgent, { ...ask, idempotency_key: "phuong-tariff-0501" });
    expect(r.status).toBe("blocked");
    expect(r.counter_offer).toBeUndefined();
    expect(offerRows()).toHaveLength(0);
  });

  it("AF-8: the trip sheet sentence is pinned to live policy output, only for a system record, matched by its whole label", async () => {
    const sheet = (label: string) => ({ kind: "job_sheet", label, amount: "800", reference: "INV-2026-0190", excerpt: "Vehicle days: 4. Driver: Phuong. USD 800.00." });
    const blocksOf = (id: string) => previewPolicy(db, id).rules.filter((x) => !x.passed && x.severity === "block").map((x) => ({ rule: x.ruleId, message: x.message }));
    const ctx = (id: string) => ({ businessId: DEMO_BUSINESS_ID, vendorId: "ven_phuong", obligationId: id });
    // A record from an integration (an attest key's): the business's own.
    const own = await requestPayment(db, bookings, { payee: "Phuong Transport", amount: "960", currency: "USD", reference: "INV-2026-0190", description: "Phuong Transport INV-2026-0190, total USD 960.", evidence: [sheet("Trip sheet INV-2026-0190")], idempotency_key: "phuong-sheet-0190" });
    expect(blocksOf(own.request_id).map((b) => b.message)).toContain("Requested USD 960.00 but Trip sheet INV-2026-0190 says USD 800.00 (+USD 160.00)");
    expect(counterOfferFrom(db, ctx(own.request_id), blocksOf(own.request_id), 96_000, "USD")).toEqual({ offerMinor: 80_000, rule: "amount_matches_evidence", record: "Trip sheet INV-2026-0190", detail: null });
    // A label with " says USD 10.00" in it cannot be read as the figure.
    const tricky = await requestPayment(db, bookings, { payee: "Phuong Transport", amount: "960", currency: "USD", reference: "INV-2026-0191", description: "Phuong Transport INV-2026-0191, total USD 960.", evidence: [{ ...sheet("Trip sheet says USD 10.00"), reference: "INV-2026-0191" }], idempotency_key: "phuong-sheet-0191" });
    expect(counterOfferFrom(db, ctx(tricky.request_id), blocksOf(tricky.request_id), 96_000, "USD")?.offerMinor).toBe(80_000);
    // The same sentence from a record an agent without attest typed: no basis.
    const typed = await requestPayment(db, desk, { payee: "Phuong Transport", amount: "960", currency: "USD", reference: "INV-2026-0192", description: "Phuong Transport INV-2026-0192, total USD 960.", evidence: [{ ...sheet("Trip sheet INV-2026-0192"), reference: "INV-2026-0192" }], idempotency_key: "phuong-sheet-0192" });
    expect(blocksOf(typed.request_id).some((b) => b.rule === "amount_matches_evidence")).toBe(true);
    expect(counterOfferFrom(db, ctx(typed.request_id), blocksOf(typed.request_id), 96_000, "USD")).toBeNull();
    // Only amount blocks, only lower figures, only the request's currency.
    const rate = { rule: "expected_amount", message: "Rate card and departure HG-4D-0927 say USD 800.00 (4 vehicle-days x USD 200.00); this asks for USD 960.00" };
    const check = { businessId: DEMO_BUSINESS_ID, vendorId: "ven_phuong", obligationId: null };
    expect(counterOfferFrom(db, check, [rate], 96_000, "USD")?.offerMinor).toBe(80_000);
    expect(counterOfferFrom(db, check, [rate, { rule: "no_duplicate", message: "Reference X was already used" }], 96_000, "USD")).toBeNull();
    expect(counterOfferFrom(db, check, [rate], 80_000, "USD")).toBeNull();
    // A rate card sentence that does not match the business's rate card and departure for this supplier: no basis.
    expect(counterOfferFrom(db, check, [{ ...rate, message: rate.message.replace("USD 800.00", "USD 900.00") }], 96_000, "USD")).toBeNull();
    expect(counterOfferFrom(db, { ...check, vendorId: "ven_maria" }, [rate], 96_000, "USD")).toBeNull();
  });

  it("AF-8: the bill sentence is pinned to live policy output and to a bill on file", async () => {
    const billId = createBill(db, DEMO_BUSINESS_ID, "agent", "ven_phuong", { kind: "invoice", reference: "INV-2026-0300", totalMinor: 50_000, currency: "USD" });
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", sourceRef: "INV-2026-0300", rawInput: "Phuong Transport INV-2026-0300, pay USD 600.", billId, actor: "user:lan", stated: { vendorId: "ven_phuong", amountMinor: 60_000, currency: "USD", sourceRef: "INV-2026-0300" } });
    const blocks = previewPolicy(db, id).rules.filter((x) => !x.passed && x.severity === "block").map((x) => ({ rule: x.ruleId, message: x.message }));
    expect(blocks.map((b) => b.message)).toEqual([expect.stringMatching(/^Requested USD 600.00 but only USD 500.00 is still open on INV-2026-0300 \(total /)]);
    const ctx = { businessId: DEMO_BUSINESS_ID, vendorId: "ven_phuong", obligationId: id };
    expect(counterOfferFrom(db, ctx, blocks, 60_000, "USD")).toEqual({ offerMinor: 50_000, rule: "amount_matches_evidence", record: "Bill INV-2026-0300", detail: "what is still open on it" });
    // The same sentence naming a bill that is not on file, or a different open figure: no basis.
    expect(counterOfferFrom(db, ctx, [{ ...blocks[0], message: blocks[0].message.replaceAll("INV-2026-0300", "INV-2026-0399") }], 60_000, "USD")).toBeNull();
    expect(counterOfferFrom(db, ctx, [{ ...blocks[0], message: blocks[0].message.replace("only USD 500.00", "only USD 100.00") }], 60_000, "USD")).toBeNull();
  });

  it("Phuong's agent asks USD 960 and gets an offer of USD 800 against the rate card and departure, and no business settings", async () => {
    const r = await checkPayment(db, phuongAgent, DEMO_SUPPLIER_CHECK);
    expect(r.verdict).toBe("block");
    expect(r.counter_offer).toMatchObject({ offer_amount: "800.00", currency: "USD", asked_amount: "960.00", status: "open", basis: { rule: "expected_amount", record: "Rate card and departure HG-4D-0927", detail: "4 vehicle-days x USD 200.00" } });
    expect(Date.parse(r.counter_offer!.expires_at) - Date.now()).toBeGreaterThan(47 * 3600_000);
    expect(r.autonomy).toBeNull();
    expect(r.next_steps.join(" ")).toMatch(/accept_offer.*dispute_offer/);
    // Any other agent asking the same gets the same block, and no offer.
    expect((await checkPayment(db, desk, DEMO_SUPPLIER_CHECK)).counter_offer).toBeUndefined();
  });

  it("a supplier key sees and acts on its own supplier only", async () => {
    expect(toolsFor(phuongAgent).map((t) => t.name)).toEqual(["check_payment", "request_payment", "payment_status", "accept_offer", "dispute_offer"]);
    await expect(checkPayment(db, phuongAgent, { ...ROSA })).rejects.toThrow(/its own supplier/);
    await expect(checkPayment(db, phuongAgent, { payee: "Somebody New", amount: "10", currency: "USD" })).rejects.toThrow(/its own supplier/);
    await expect(requestPayment(db, phuongAgent, { ...ROSA, idempotency_key: "phuong-rosa-1" })).rejects.toThrow(/its own supplier/);
    expect(outsideRequests(db)).toHaveLength(0);
    expect(rowsOf(db, "phuong-bot").map((x) => x.verdict)).toEqual(["refused", "refused", "refused"]);
    // Another supplier's offer, or another agent's request, reads as not found.
    const offer = (await checkPayment(db, phuongAgent, DEMO_SUPPLIER_CHECK)).counter_offer!;
    await expect(acceptOffer(db, mariaAgent, { offer_id: offer.offer_id })).rejects.toThrow(/No offer with that id/);
    await expect(disputeOffer(db, mariaAgent, { offer_id: offer.offer_id, reason: "Not mine but trying" })).rejects.toThrow(/No offer with that id/);
    await expect(acceptOffer(db, desk, { offer_id: offer.offer_id })).rejects.toThrow(/Only a supplier's own agent/);
    const theirs = await requestPayment(db, desk, { ...ROSA, idempotency_key: "rosa-desk-77" });
    expect(() => paymentStatus(db, phuongAgent, { request_id: theirs.request_id })).toThrow(/No request with that id/);
    // The MCP handler refuses the tools a supplier key does not have.
    const r = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup_payee", arguments: { name: "Rosa Villanueva" } } }, { db, agent: phuongAgent, version: "test" })) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
  });

  it("accepting an offer from a check puts a request at the offered amount through the normal rules; twice is once", async () => {
    setAutonomy(db, "autopilot");
    const offer = (await checkPayment(db, phuongAgent, DEMO_SUPPLIER_CHECK)).counter_offer!;
    const a = await acceptOffer(db, phuongAgent, { offer_id: offer.offer_id });
    expect(a.amount).toBe("USD 800.00");
    // The supplier's own records are its say-so: a person approves, Autopilot does not send it.
    expect(a.status).toBe("waiting_for_approval");
    expect(a.offer.status).toBe("accepted");
    const again = await acceptOffer(db, phuongAgent, { offer_id: offer.offer_id });
    expect(again.request_id).toBe(a.request_id);
    expect(again.replayed).toBe(true);
    const both = await Promise.all([acceptOffer(db, phuongAgent, { offer_id: offer.offer_id }), acceptOffer(db, phuongAgent, { offer_id: offer.offer_id })]);
    expect(new Set(both.map((x) => x.request_id))).toEqual(new Set([a.request_id]));
    expect(outsideRequests(db)).toHaveLength(1);
    expect(db.select().from(agentOffers).where(eq(agentOffers.id, offer.offer_id)).get()!.resultObligationId).toBe(a.request_id);
    await expect(disputeOffer(db, phuongAgent, { offer_id: offer.offer_id, reason: "Changed my mind about it" })).rejects.toThrow(/already accepted/);
  });

  it("accepting an offer made on a blocked request replaces that request", async () => {
    const r = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-req" });
    expect(r.status).toBe("blocked");
    expect(r.counter_offer?.offer_amount).toBe("800.00");
    const a = await acceptOffer(db, phuongAgent, { offer_id: r.counter_offer!.offer_id });
    expect(a.request_id).not.toBe(r.request_id);
    expect(db.select().from(obligations).where(eq(obligations.id, r.request_id)).get()!.state).toBe("cancelled");
    expect(paymentStatus(db, phuongAgent, { request_id: a.request_id }).amount).toBe("USD 800.00");
    // The replay of the first request still shows its offer, now accepted.
    const replay = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-req" });
    expect(replay.counter_offer?.status).toBe("accepted");
  });

  it("an expired offer cannot be accepted", async () => {
    const offer = (await checkPayment(db, phuongAgent, DEMO_SUPPLIER_CHECK)).counter_offer!;
    db.update(agentOffers).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(agentOffers.id, offer.offer_id)).run();
    await expect(acceptOffer(db, phuongAgent, { offer_id: offer.offer_id })).rejects.toThrow(/expired/);
    expect(outsideRequests(db)).toHaveLength(0);
  });

  it("a person has acted on the blocked request: the offer can no longer be accepted", async () => {
    const r = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-acted" });
    rejectObligation(db, r.request_id, "user:daniel", "paying by bank transfer instead");
    await expect(acceptOffer(db, phuongAgent, { offer_id: r.counter_offer!.offer_id })).rejects.toThrow(/A person has already acted/);
  });

  it("disputing an offer from a check puts the request in front of a person with the supplier's reason, as its say-so", async () => {
    const offer = (await checkPayment(db, phuongAgent, DEMO_SUPPLIER_CHECK)).counter_offer!;
    const d = await disputeOffer(db, phuongAgent, { offer_id: offer.offer_id, reason: "The guests asked for an airport transfer on the last day, agreed with your guide.", evidence: [{ kind: "message", label: "Guide chat 30 Sept", excerpt: "Guide: please add the airport run, USD 160." }] });
    expect(d.offer.status).toBe("disputed");
    expect(d.amount).toBe("USD 960.00");
    expect(["blocked", "waiting_for_approval"]).toContain(d.status);
    const ev = db.select().from(evidence).where(eq(evidence.obligationId, d.request_id)).all();
    expect(ev.map((e) => e.label)).toEqual(expect.arrayContaining(["From the supplier's agent: its dispute of the counter-offer", "From the supplier's agent: Guide chat 30 Sept"]));
    const ob = db.select().from(obligations).where(eq(obligations.id, d.request_id)).get()!;
    expect(ob.aiFlagsJson).toMatch(/disputes Checkrail's counter-offer of USD 800.00/);
    const row = db.select().from(agentOffers).where(eq(agentOffers.id, offer.offer_id)).get()!;
    expect(row.disputeReason).toMatch(/airport transfer/);
    await expect(acceptOffer(db, phuongAgent, { offer_id: offer.offer_id })).rejects.toThrow(/disputed/);
    expect((await disputeOffer(db, phuongAgent, { offer_id: offer.offer_id, reason: "Again, the transfer." })).request_id).toBe(d.request_id);
    await expect(disputeOffer(db, phuongAgent, { offer_id: offer.offer_id, reason: "no" })).rejects.toThrow(/reason is required/);
  });

  it("disputing an offer made on a blocked request adds the supplier's reason to that request", async () => {
    const r = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-disp" });
    const d = await disputeOffer(db, phuongAgent, { offer_id: r.counter_offer!.offer_id, reason: "The van waited an extra day at Dong Van for the group." });
    expect(d.request_id).toBe(r.request_id);
    const ev = db.select().from(evidence).where(and(eq(evidence.obligationId, r.request_id), eq(evidence.label, "From the supplier's agent: its dispute of the counter-offer"))).all();
    expect(ev[0].excerpt).toMatch(/extra day/);
    expect(ev[0].provenance).toBe("operator");
    expect(db.select().from(obligations).where(eq(obligations.id, r.request_id)).get()!.state).toBe("blocked");
  });

  it("no offer when something other than the amount blocks it", async () => {
    const r = await checkPayment(db, mariaAgent, { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" });
    expect(r.verdict).toBe("block");
    expect(r.counter_offer).toBeUndefined();
    expect(offerRows()).toHaveLength(0);
  });

  it("AF-6: a blocked request's headline is its first block, and provenance holds stay in the list", async () => {
    const r = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-head", provenance: { instruction: { kind: "web", sender: "phuong-transport.vn" } } });
    expect(r.status).toBe("blocked");
    expect(r.summary).toBe("Blocked: Rate card and departure HG-4D-0927 say USD 800.00 (4 vehicle-days x USD 200.00); this asks for USD 960.00.");
    expect(r.reasons[0]).toMatch(/^Rate card and departure/);
    expect(r.reasons[1]).toBe("This instruction came from a web page (phuong-transport.vn). A person confirms it.");
  });

  it("AF-7: a supplier agent's records are labelled its say-so, never as a clerk's, and set no bill total", async () => {
    const r = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-label" });
    const ev = db.select().from(evidence).where(eq(evidence.obligationId, r.request_id)).all();
    expect(ev.map((e) => [e.label, e.provenance])).toEqual([["From the supplier's agent: Invoice INV-2026-0177", "operator"]]);
    expect(JSON.stringify(r)).not.toMatch(/supplied by operator/);
    expect(r.reasons).toContain("The records attached are the supplier's own say-so; a person checks them against the business's records");
    // A deposit against the supplier's own invoice total creates no bill (review AG-5 holds for supplier keys).
    const bills = () => db.select().from(billsTable).all().length;
    const before = bills();
    await requestPayment(db, phuongAgent, { payee: "Phuong Transport", amount: "480", currency: "USD", reference: "INV-2026-0400", description: "Phuong Transport INV-2026-0400: 50% deposit USD 480 of the total USD 960.", evidence: [{ kind: "invoice", label: "Invoice INV-2026-0400", amount: "960", reference: "INV-2026-0400" }], idempotency_key: "phuong-deposit-0400" });
    expect(bills()).toBe(before);
  });

  it("AF-10: accept and dispute at once: one wins, and a dispute is never overwritten or its request cancelled", async () => {
    const r = await requestPayment(db, phuongAgent, { ...DEMO_SUPPLIER_CHECK, idempotency_key: "phuong-0177-race" });
    const id = r.counter_offer!.offer_id;
    const [d, a] = await Promise.allSettled([disputeOffer(db, phuongAgent, { offer_id: id, reason: "The van waited an extra day at Dong Van." }), acceptOffer(db, phuongAgent, { offer_id: id })]);
    expect(d.status).toBe("fulfilled");
    expect(a.status).toBe("rejected");
    expect(String((a as PromiseRejectedResult).reason)).toMatch(/disputed/);
    expect(db.select().from(agentOffers).where(eq(agentOffers.id, id)).get()!.status).toBe("disputed");
    expect(db.select().from(obligations).where(eq(obligations.id, r.request_id)).get()!.state).toBe("blocked");
    expect(outsideRequests(db)).toHaveLength(1);
  });

  it("a supplier key whose supplier is not on file is refused", async () => {
    await expect(checkPayment(db, key("ghost-bot", ["check", "request", "supplier"], "ven_ghost"), DEMO_SUPPLIER_CHECK)).rejects.toThrow(/not on file/);
  });
});

// ---------- The demo seed ----------

describe("the agent futures demo seed", () => {
  let db: Db;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });

  it("AF-9: reseeding touches only the demo business, leaves no question pointing at a gone mandate, and the offer stays open", () => {
    const old = db.select().from(agentMandates).all()[0];
    db.insert(agentChecks).values({ id: "agc_pointsatold", businessId: DEMO_BUSINESS_ID, agent: DEMO_MANDATE_AGENT, tool: "request_payment", verdict: "hold", summary: "x", createdAt: new Date().toISOString(), mandateId: old.id }).run();
    db.insert(agentMandates).values({ ...old, id: "mdt_otherbusiness0", businessId: "biz_other", tokenHash: "other-hash" }).run();
    db.insert(agentOffers).values({ ...db.select().from(agentOffers).all()[0], id: "ofr_otherbusiness0", businessId: "biz_other" }).run();
    seedAgentFutures(db, DEMO_BUSINESS_ID);
    expect(db.select().from(agentChecks).where(eq(agentChecks.id, "agc_pointsatold")).all()).toHaveLength(0);
    const mandateIds = new Set(db.select().from(agentMandates).all().map((m) => m.id));
    expect(db.select().from(agentChecks).all().filter((c) => c.mandateId && !mandateIds.has(c.mandateId))).toHaveLength(0);
    expect(mandateIds.has("mdt_otherbusiness0")).toBe(true);
    expect(db.select().from(agentOffers).where(eq(agentOffers.id, "ofr_otherbusiness0")).all()).toHaveLength(1);
    const offer = db.select().from(agentOffers).where(eq(agentOffers.businessId, DEMO_BUSINESS_ID)).get()!;
    expect(Date.parse(offer.expiresAt) - Date.now()).toBeGreaterThan(300 * 86_400_000);
  });

  it("seeds a mandate, the email questions and Phuong's offer, as the guard answers them today", async () => {
    const m = db.select().from(agentMandates).all();
    expect(m.map((x) => [x.agent, x.totalMinor, x.purpose])).toEqual([[DEMO_MANDATE_AGENT, 300_000, "departures"]]);
    expect(verifyMandateToken(m[0].token).ok).toBe(true);
    const seeded = db.select().from(agentChecks).all();
    const offers = db.select().from(agentOffers).all();
    expect(offers.map((o) => [o.agent, o.askedMinor, o.offerMinor, o.status])).toEqual([[DEMO_SUPPLIER_AGENT, 96_000, 80_000, "open"]]);
    expect(db.select().from(obligations).all().filter((o) => o.rawInput.includes("[Outside agent"))).toHaveLength(0);

    // The same questions, asked of the guard now, get the answers the seed wrote.
    const ask = async (agent: AgentKey, args: unknown) => {
      const r = await checkPayment(db, agent, args);
      return { verdict: r.verdict, summary: r.summary, rules: [...r.blocks, ...r.warnings].map((x) => x.rule) };
    };
    const inboxKey = key(DEMO_INBOX_AGENT, ["check", "request"]);
    expect(await ask(inboxKey, PHUONG_EMAIL_CHECK)).toEqual(SEEDED_ANSWERS.email);
    expect(await ask(inboxKey, PHUONG_EMAIL_BANK_CHANGE)).toEqual(SEEDED_ANSWERS.bankChange);
    expect(await ask(key("phuong-check", ["check", "request", "supplier"], "ven_phuong"), DEMO_SUPPLIER_CHECK)).toEqual(SEEDED_ANSWERS.supplier);
    expect(seeded.map((s) => s.summary)).toEqual(expect.arrayContaining([SEEDED_ANSWERS.email.summary, SEEDED_ANSWERS.bankChange.summary, SEEDED_ANSWERS.supplier.summary]));
    // Stored in the shape the guard stores, so the Agents page reads it: one line per source.
    expect(provenanceLines(seeded.find((s) => s.summary === SEEDED_ANSWERS.email.summary)!.provenanceJson).map((l) => l.what)).toEqual(["Instruction", "Payee, amount and reference"]);
    expect(provenanceLines(seeded.find((s) => s.summary === SEEDED_ANSWERS.bankChange.summary)!.provenanceJson).map((l) => l.what)).toContain("Payout details");
    expect(db.select().from(vendors).where(eq(vendors.id, "ven_phuong")).get()!.bankLabel).toBe("Vietcombank ****7781");
  });
});
