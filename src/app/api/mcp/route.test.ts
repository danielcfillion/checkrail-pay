import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// An in-memory database for the route's getDb() singleton. Must be set before config loads.
vi.hoisted(() => {
  process.env.DATABASE_PATH = ":memory:";
});

import { POST, GET } from "./route";
import { getDb } from "@/lib/db";
import { agentChecks } from "@/lib/db/schema";
import { DEMO_INBOX_AGENT, DEMO_SUPPLIER_AGENT } from "@/lib/agent/futuresSeed";

// The demo seed writes a few questions from its own demo agents; these tests count only the ones they ask.
const asked = () => getDb().select().from(agentChecks).all().filter((c) => c.agent !== DEMO_INBOX_AGENT && c.agent !== DEMO_SUPPLIER_AGENT);
import { seedDemo } from "@/lib/demo/seed";

const KEY = "route-test-secret-0123456789abcdef";
const URL_ = "http://checkrail.test/api/mcp";
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(URL_, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }));
const auth = { authorization: `Bearer ${KEY}` };

beforeEach(async () => {
  await seedDemo(getDb());
  vi.stubEnv("CHECKRAIL_AGENT_KEYS", `assistant:${KEY}:check+request`);
  vi.stubEnv("CHECKRAIL_AGENT_DEMO_OPEN", "");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/mcp", () => {
  it("answers an agent with a valid key", async () => {
    const r = await post(rpc("tools/list"), auth);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toContain("request_payment");
  });

  it("blocks the duplicate over HTTP and logs who asked", async () => {
    const r = await post(rpc("tools/call", { name: "check_payment", arguments: { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" } }), auth);
    const body = (await r.json()) as { result: { structuredContent: { verdict: string } } };
    expect(body.result.structuredContent.verdict).toBe("block");
    expect(asked().map((c) => [c.agent, c.verdict])).toEqual([["assistant", "block"]]);
  });

  it("refuses a missing or wrong key", async () => {
    expect((await post(rpc("tools/list"))).status).toBe(401);
    const wrong = await post(rpc("tools/list"), { authorization: `Bearer ${KEY}x` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("refuses everything when the key setting is malformed", async () => {
    vi.stubEnv("CHECKRAIL_AGENT_KEYS", "nonsense");
    expect((await post(rpc("tools/list"), auth)).status).toBe(503);
  });

  it("refuses a call from another site's page, and anything but JSON", async () => {
    expect((await post(rpc("tools/list"), { ...auth, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(rpc("tools/list"), { ...auth, origin: "http://checkrail.test" })).status).toBe(200);
    expect((await post(rpc("tools/list"), { ...auth, "content-type": "text/plain" })).status).toBe(415);
  });

  it("lets keyless callers in on the simulated demo only when the owner opened it", async () => {
    vi.stubEnv("CHECKRAIL_AGENT_DEMO_OPEN", "1");
    const r = await post(rpc("tools/call", { name: "lookup_payee", arguments: { name: "Rosa Villanueva" } }));
    expect(r.status).toBe(200);
    vi.stubEnv("PAYPAL_ENV", "live");
    expect((await post(rpc("tools/list"))).status).toBe(401);
  });

  it("acknowledges a notification without a body, and says no to GET", async () => {
    const n = await post(rpc("notifications/initialized", undefined, null), auth);
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    expect(GET().status).toBe(405);
  });

  it("AG-3: refuses an oversized body by its declared length, and stops reading a streamed one", async () => {
    const declared = await POST(new Request(URL_, { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024), ...auth } }));
    expect(declared.status).toBe(413);
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 50) c.close();
        else c.enqueue(chunk);
      },
    });
    const streamed = await POST(new Request(URL_, { method: "POST", body: stream, headers: { "content-type": "application/json", ...auth }, duplex: "half" } as RequestInit));
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(5);
  });

  it("gives each keyless demo caller a name of its own", async () => {
    vi.stubEnv("CHECKRAIL_AGENT_DEMO_OPEN", "1");
    const call = (ip: string) => post(rpc("tools/call", { name: "check_payment", arguments: { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" } }), { "x-forwarded-for": ip });
    await call("203.0.113.7");
    await call("198.51.100.9");
    const names = asked().map((c) => c.agent);
    expect(new Set(names).size).toBe(2);
    expect(names.every((n) => /^demo-[0-9a-f]{8}$/.test(n))).toBe(true);
  });

  it("AG2-7: a keyless demo caller may check, but not put a request in the books", async () => {
    vi.stubEnv("CHECKRAIL_AGENT_DEMO_OPEN", "1");
    const list = (await (await post(rpc("tools/list"), { "x-forwarded-for": "203.0.113.8" })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).not.toContain("request_payment");
    const r = (await (await post(rpc("tools/call", { name: "request_payment", arguments: { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "CEB-2D-1024", idempotency_key: "visitor-0001" } }), { "x-forwarded-for": "203.0.113.8" })).json()) as { error?: { code: number } };
    expect(r.error?.code).toBe(-32602);
  });

  it("AG-3: the middleware never runs on /api/mcp, so it never copies the body", async () => {
    const { config } = await import("@/middleware");
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test("/api/mcp")).toBe(false);
    expect(re.test("/agents")).toBe(true);
    expect(re.test("/api/mcpx")).toBe(true);
  });

  it("AG3-10: one agent has at most two calls in flight", async () => {
    const check = () => post(rpc("tools/call", { name: "check_payment", arguments: { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" } }), auth);
    const codes = (await Promise.all([check(), check(), check(), check()])).map((r) => r.status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses an oversized body and reports bad JSON", async () => {
    expect((await post("x".repeat(70_000), auth)).status).toBe(413);
    expect((await post("{not json", auth)).status).toBe(400);
  });
});
