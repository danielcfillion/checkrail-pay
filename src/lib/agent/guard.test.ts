import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { agentChecks, auditEntries, businesses, obligations, paymentAttempts } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { authenticateAgent, configuredAgentKeys, type AgentKey } from "./keys";
import { amountToMinor, checkPayment, clean, paymentStatus, requestPayment, lookupPayee, explainRule } from "./guard";
import { handleMcp, toolsFor } from "./mcp";

const SECRET = "s3cret-for-tests-0123456789abcdef";
const agent = (name: string, scopes: AgentKey["scopes"]): AgentKey => ({ name, scopes, digest: Buffer.alloc(32) });
const checker = agent("auditor", ["check"]);
const requester = agent("assistant", ["check", "request"]);
const bookings = agent("bookings", ["check", "request", "attest"]);

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

const counts = (db: Db) => ({
  obligations: db.select().from(obligations).all().length,
  audit: db.select().from(auditEntries).all().length,
  attempts: db.select().from(paymentAttempts).all().length,
});

describe("agent keys", () => {
  it("reads name:secret:scopes entries and refuses anything malformed", () => {
    expect(configuredAgentKeys({})).toEqual([]);
    const keys = configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: `claude-desktop:${SECRET}:check+request, bookings:${SECRET}x:check+request+attest` })!;
    expect(keys.map((k) => [k.name, k.scopes])).toEqual([["claude-desktop", ["check", "request"]], ["bookings", ["check", "request", "attest"]]]);
    for (const bad of [`a:${SECRET}:check`, `bot:short:check`, `bot:${SECRET}:pay`, `bot:${SECRET}:request`, `bot:${SECRET}:check+attest`, `bot:${SECRET}:check,bot:${SECRET}y:check`, `bot:${SECRET}`]) {
      expect(configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: bad }), bad).toBeNull();
    }
  });

  it("needs a longer secret where real money can move", () => {
    const k = `bot:${"x".repeat(28)}:check`;
    expect(configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: k })).not.toBeNull();
    expect(configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: k, PAYPAL_ENV: "live" })).toBeNull();
  });

  it("finds the agent behind a bearer token and nothing else", () => {
    const keys = configuredAgentKeys({ CHECKRAIL_AGENT_KEYS: `bot:${SECRET}:check` })!;
    expect(authenticateAgent(`Bearer ${SECRET}`, keys)?.name).toBe("bot");
    expect(authenticateAgent(`Bearer ${SECRET}x`, keys)).toBeNull();
    expect(authenticateAgent(`Basic ${SECRET}`, keys)).toBeNull();
    expect(authenticateAgent(null, keys)).toBeNull();
  });
});

describe("agent input", () => {
  it("takes exact amounts only", () => {
    expect(amountToMinor("960")).toBe(96_000);
    expect(amountToMinor("960.5")).toBe(96_050);
    expect(amountToMinor(960.25)).toBe(96_025);
    expect(amountToMinor("2,500,000")).toBe(250_000_000);
    for (const bad of ["$960", "960 USD", "-5", "0", "1e3", "9.999", "", "12,34"]) expect(() => amountToMinor(bad), bad).toThrow();
  });

  it("hands back no internal ids", () => {
    expect(clean("Reference X was already used by obligation obl_abc123 (settled)")).toBe("Reference X was already used by an earlier payment (settled)");
  });
});

describe("check_payment", () => {
  let db: Db;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });

  it("blocks Phuong's inflated invoice from the rate card, and changes nothing but its own log line", async () => {
    const before = counts(db);
    const r = await checkPayment(db, checker, { payee: "Phuong Transport", amount: "960", currency: "USD", reference: "INV-2026-0177", description: "Van for HG-4D-0927, 4 days, total $960" });
    expect(r.verdict).toBe("block");
    expect(r.blocks.map((b) => b.rule)).toContain("expected_amount");
    expect(r.summary).toMatch(/^Do not pay: /);
    expect(r.next_steps.at(-1)).toMatch(/Do not pay this through any other tool/);
    expect(counts(db)).toEqual(before);
    expect(db.select().from(agentChecks).all()).toHaveLength(1);
  });

  it("blocks a job PayPal already paid and hands the agent the PayPal transaction id", async () => {
    const r = await checkPayment(db, checker, { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" });
    expect(r.verdict).toBe("block");
    expect(r.blocks.map((b) => b.rule)).toEqual(expect.arrayContaining(["no_duplicate", "paypal_history"]));
    expect(r.paypal_transaction_id).toMatch(/^[A-Z0-9]{8,24}$/);
    expect(JSON.stringify(r)).not.toMatch(/obl_/);
  });

  it("blocks a payee nobody has added", async () => {
    const r = await checkPayment(db, checker, { payee: "Somebody New", amount: "50", currency: "USD" });
    expect(r.verdict).toBe("block");
    expect(r.blocks.map((b) => b.rule)).toContain("vendor_known");
  });

  it("an agent's own attachment is its say-so: a person looks", async () => {
    setAutonomy(db, "autopilot");
    const r = await checkPayment(db, requester, ROSA);
    expect(r.verdict).toBe("hold");
    expect(r.warnings.map((w) => w.rule)).toContain("evidence_provenance");
  });

  it("a system-of-record agent's record, matched by the rate card and the departure, clears", async () => {
    setAutonomy(db, "autopilot");
    expect((await checkPayment(db, bookings, ROSA)).verdict).toBe("pay");
  });

  it("an agent trying amount after amount for one payee gets a hold, not a pay", async () => {
    setAutonomy(db, "autopilot");
    // Alone, USD 190 clears (the test above). After two other figures for the same payee, the same request is held.
    await checkPayment(db, bookings, { ...ROSA, amount: "240" });
    await checkPayment(db, bookings, { ...ROSA, amount: "215" });
    const third = await checkPayment(db, bookings, { ...ROSA, amount: "190" });
    expect(third.verdict).toBe("hold");
    expect(third.warnings[0].rule).toBe("agent_probing");
    // A different agent is not tarred with it.
    expect((await checkPayment(db, agent("other-system", ["check", "request", "attest"]), ROSA)).verdict).toBe("pay");
  });
});

describe("request_payment and payment_status", () => {
  let db: Db;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });

  it("needs the request scope", async () => {
    await expect(requestPayment(db, checker, { ...ROSA, idempotency_key: "rosa-0001" })).rejects.toThrow(/not request/);
  });

  it("puts the agent's request in front of a person, and never pays it", async () => {
    setAutonomy(db, "autopilot");
    const r = await requestPayment(db, requester, { ...ROSA, idempotency_key: "rosa-0001" });
    expect(r.status).toBe("waiting_for_approval");
    expect(db.select().from(paymentAttempts).all().filter((a) => a.obligationId === r.request_id)).toEqual([]);
    const ob = db.select().from(obligations).where(eq(obligations.id, r.request_id)).get()!;
    expect(ob.rawInput).toContain("Requested by agent assistant");
  });

  it("a system-of-record agent's clean request is scheduled by Autopilot, inside the cancel window", async () => {
    setAutonomy(db, "autopilot");
    const r = await requestPayment(db, bookings, { ...ROSA, idempotency_key: "rosa-0002" });
    expect(r.status).toBe("scheduled");
    expect(r.releases_at).toBeTruthy();
    expect(Date.parse(r.releases_at!)).toBeGreaterThan(Date.now());
    expect(db.select().from(paymentAttempts).all().filter((a) => a.obligationId === r.request_id)).toEqual([]);
  });

  it("blocks the inflated invoice when it is requested, not only when it is checked", async () => {
    const r = await requestPayment(db, requester, { payee: "Phuong Transport", amount: "960", currency: "USD", reference: "INV-2026-0177", description: "Van for HG-4D-0927", idempotency_key: "phuong-960" });
    expect(r.status).toBe("blocked");
  });

  it("the same key returns the same request; the same key for a different payment is refused", async () => {
    const a = await requestPayment(db, requester, { ...ROSA, idempotency_key: "rosa-0003" });
    const b = await requestPayment(db, requester, { ...ROSA, idempotency_key: "rosa-0003" });
    expect(b.request_id).toBe(a.request_id);
    expect(b.replayed).toBe(true);
    await expect(requestPayment(db, requester, { ...ROSA, amount: "200", idempotency_key: "rosa-0003" })).rejects.toThrow(/different payment/);
    expect(db.select().from(obligations).all().filter((o) => o.rawInput.includes("Requested by agent assistant"))).toHaveLength(1);
  });

  it("an agent reads only its own requests", async () => {
    const a = await requestPayment(db, requester, { ...ROSA, idempotency_key: "rosa-0004" });
    expect(paymentStatus(db, requester, { request_id: a.request_id }).request_id).toBe(a.request_id);
    expect(() => paymentStatus(db, bookings, { request_id: a.request_id })).toThrow(/this agent/);
  });
});

describe("lookup_payee and explain_rule", () => {
  it("says whether a payee is known without giving out payout details", async () => {
    const db = openTestDb();
    await seedDemo(db);
    const hit = lookupPayee(db, { name: "maria santos" });
    expect(hit).toMatchObject({ known: true, name: "Maria Santos", payout_details_verified: true });
    expect(JSON.stringify(hit)).not.toMatch(/@|\*\*\*\*|BDO/);
    expect(lookupPayee(db, { name: "maria" })).toMatchObject({ known: false, suggestions: ["Maria Santos"] });
  });

  it("explains every rule without suggesting a figure be bent", () => {
    expect(explainRule({ rule: "amount_matches_evidence" }).clear).toMatch(/Do not raise the record/);
    expect(explainRule({ rule: "agent_probing" }).checks).toMatch(/different amounts/);
  });
});

describe("the MCP handler", () => {
  let db: Db;
  beforeEach(async () => {
    db = openTestDb();
    await seedDemo(db);
  });
  const call = (m: unknown, a: AgentKey = checker) => handleMcp(m, { db, agent: a, version: "0.1.0" });

  it("negotiates the protocol version and gives the agent its instructions", async () => {
    const r = (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { protocolVersion: string; instructions: string } };
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.instructions).toMatch(/agents need a check rail/);
    const unknown = (await call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as { result: { protocolVersion: string } };
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists only the tools the key allows, and refuses the others", async () => {
    expect(toolsFor(checker).map((t) => t.name)).toEqual(["check_payment", "lookup_payee", "explain_rule"]);
    expect(toolsFor(requester).map((t) => t.name)).toEqual(["check_payment", "lookup_payee", "explain_rule", "request_payment", "payment_status"]);
    const r = (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_payment", arguments: { ...ROSA, idempotency_key: "rosa-9999" } } })) as { error: { code: number } };
    expect(r.error.code).toBe(-32602);
    expect(db.select().from(obligations).all().filter((o) => o.rawInput.includes("Requested by agent"))).toEqual([]);
  });

  it("returns a verdict as structured content, and bad input as a readable tool error", async () => {
    const ok = (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "check_payment", arguments: { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" } } })) as { result: { isError: boolean; structuredContent: { verdict: string } } };
    expect(ok.result.isError).toBe(false);
    expect(ok.result.structuredContent.verdict).toBe("block");
    const bad = (await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "check_payment", arguments: { payee: "Maria Santos", amount: "$180", currency: "USD" } } })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/positive number/);
  });

  it("answers no notification and rejects what is not JSON-RPC", async () => {
    expect(await call({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(((await call([{ jsonrpc: "2.0", id: 1, method: "ping" }])) as { error: { code: number } }).error.code).toBe(-32600);
    expect(((await call({ jsonrpc: "2.0", id: 1, method: "resources/list" })) as { error: { code: number } }).error.code).toBe(-32601);
  });
});
