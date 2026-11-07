import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// An in-memory database for the routes' getDb() singleton. Must be set before config loads.
vi.hoisted(() => {
  process.env.DATABASE_PATH = ":memory:";
});

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as departuresRoute from "./departures/route";
import * as requestsRoute from "./requests/route";
import * as requestRoute from "./requests/[id]/route";
import * as vendorsRoute from "./vendors/route";
import * as openapiRoute from "./openapi.json/route";
import { getDb } from "@/lib/db";
import { apiDepartureRefs, apiIdempotency, apiKeyUsage, apiRequests, auditEntries, evidence, obligations, paymentAttempts, settlements, vendors } from "@/lib/db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "@/lib/demo/seed";
import { setAutonomy } from "@/lib/engine/autopilot";
import { authenticateApiKey, configuredApiKeys } from "@/lib/api/keys";
import { resetApiThrottles } from "@/lib/api/http";
import { textPdf } from "@/lib/api/testPdf";
import { createBill, payBill } from "@/lib/engine/bills";
import { bills as billsTable } from "@/lib/db/schema";
import { approveObligation, executeObligation, linkWaitingToBill, previewPolicy } from "@/lib/engine/orchestrator";
import { checkPayment, paymentStatus, requestPayment } from "@/lib/agent/guard";
import type { AgentKey } from "@/lib/agent/keys";
import { resolveActor } from "@/lib/engine/users";
import { departures as departuresTable } from "@/lib/db/schema";
import { API_V1_PATH, middleware } from "@/middleware";

const S = (n: string) => `api-test-secret-${n}-0123456789abcdef`; // test-only placeholders
const KEYS = [
  `bookings:${S("b")}:departures:write`,
  `erp:${S("e")}:requests:write+requests:read+vendors:read`,
  `ledger:${S("l")}:requests:write+requests:attest+requests:read`,
  `lookup:${S("v")}:vendors:read`,
].join(",");
const BASE = "http://checkrail.test/api/v1";
const auth = (n: string) => ({ authorization: `Bearer ${S(n)}` });

type Json = Record<string, unknown> & { error?: { code: string; message: string; details?: Array<{ field: string; message: string }> } };

function req(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const hasBody = opts.body !== undefined;
  return new Request(`${BASE}${path}`, {
    method,
    body: hasBody ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...opts.headers },
  });
}
async function send(handler: (r: Request) => Promise<Response> | Response, r: Request) {
  const res = await handler(r);
  return { status: res.status, headers: res.headers, json: (await res.json()) as Json };
}
const postDepartures = (body: unknown, key = "b", headers: Record<string, string> = {}) => send(departuresRoute.POST, req("POST", "/departures", { body, headers: { ...auth(key), ...headers } }));
const getDepartures = (q = "", key = "b") => send(departuresRoute.GET, req("GET", `/departures${q}`, { headers: auth(key) }));
const postRequest = (body: unknown, idem: string | null = `idem-${Math.random().toString(36).slice(2)}`, key = "e", headers: Record<string, string> = {}) =>
  send(requestsRoute.POST, req("POST", "/requests", { body, headers: { ...auth(key), ...(idem ? { "idempotency-key": idem } : {}), ...headers } }));
const getRequest = async (id: string, key = "e") => {
  const res = await requestRoute.GET(req("GET", `/requests/${id}`, { headers: auth(key) }), { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Json };
};
const listRequests = (q = "", key = "e") => send(requestsRoute.GET, req("GET", `/requests${q}`, { headers: auth(key) }));
const searchVendors = (q = "", key = "v") => send(vendorsRoute.GET, req("GET", `/vendors${q}`, { headers: auth(key) }));

const dep = (externalId: string, code: string, services: unknown[], dates: [string, string] = ["2026-10-12", "2026-10-14"]) => ({ external_id: externalId, code, start_date: dates[0], end_date: dates[1], guests: 10, services });
const phuongVan = (q: number) => ({ vendor_id: "ven_phuong", unit: "vehicle_day", quantity: q });

beforeEach(async () => {
  const db = getDb();
  await seedDemo(db, { history: false });
  for (const t of [apiIdempotency, apiDepartureRefs, apiRequests, apiKeyUsage]) db.delete(t).run();
  resetApiThrottles();
  vi.stubEnv("CHECKRAIL_API_KEYS", KEYS);
  vi.stubEnv("CHECKRAIL_API_RATE_LIMIT", "");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
});
afterEach(() => vi.unstubAllEnvs());

describe("API keys", () => {
  it("reads name:secret:scopes entries, where scopes contain colons, and refuses anything malformed", () => {
    expect(configuredApiKeys({})).toEqual([]);
    expect(configuredApiKeys({ CHECKRAIL_API_KEYS: KEYS })!.map((k) => [k.name, k.scopes])).toEqual([
      ["bookings", ["departures:write"]],
      ["erp", ["requests:write", "requests:read", "vendors:read"]],
      ["ledger", ["requests:write", "requests:attest", "requests:read"]],
      ["lookup", ["vendors:read"]],
    ]);
    const s = S("x");
    for (const bad of [`b:${s}:vendors:read`, `bot:short:vendors:read`, `bot:${s}:vendors:write`, `bot:${s}:`, `bot:${s}`, `bot:${s}:requests:attest`, `bot:${s}:vendors:read+vendors:read`, `bot:${s}:vendors:read,bot:${s}y:vendors:read`, `one:${s}:vendors:read,two:${s}:vendors:read`, `Bot:${s}:vendors:read`]) {
      expect(configuredApiKeys({ CHECKRAIL_API_KEYS: bad }), bad).toBeNull();
    }
  });

  it("needs a longer secret where real money can move, and matches only the exact bearer token", () => {
    const k = `bot:${"x".repeat(28)}:vendors:read`;
    expect(configuredApiKeys({ CHECKRAIL_API_KEYS: k })).not.toBeNull();
    expect(configuredApiKeys({ CHECKRAIL_API_KEYS: k, PAYPAL_ENV: "live" })).toBeNull();
    const keys = configuredApiKeys({ CHECKRAIL_API_KEYS: KEYS })!;
    expect(authenticateApiKey(`Bearer ${S("e")}`, keys)?.name).toBe("erp");
    expect(authenticateApiKey(`Bearer ${S("e")}x`, keys)).toBeNull();
    expect(authenticateApiKey(`Basic ${S("e")}`, keys)).toBeNull();
    expect(authenticateApiKey(null, keys)).toBeNull();
  });
});

describe("authentication", () => {
  it("refuses a missing or wrong key with 401 in the one error shape", async () => {
    const none = await send(vendorsRoute.GET, req("GET", "/vendors"));
    expect(none.status).toBe(401);
    expect(none.json.error?.code).toBe("unauthorized");
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    const wrong = await send(vendorsRoute.GET, req("GET", "/vendors", { headers: { authorization: `Bearer ${S("v")}x` } }));
    expect(wrong.status).toBe(401);
    expect(Object.keys(wrong.json)).toEqual(["error"]);
    expect(Object.keys(wrong.json.error!).sort()).toEqual(["code", "message"]);
  });

  it("an agent key is not an API key", async () => {
    vi.stubEnv("CHECKRAIL_AGENT_KEYS", `assistant:${S("agent")}:check+request`);
    expect((await searchVendors("", "agent")).status).toBe(401);
  });

  it("refuses every call when the key list is malformed, without telling the caller why (review R1-9)", async () => {
    vi.stubEnv("CHECKRAIL_API_KEYS", `${KEYS},nonsense`);
    const r = await searchVendors();
    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe("unauthorized");
    expect(JSON.stringify(r.json)).not.toMatch(/malformed|CHECKRAIL_API_KEYS/);
    expect((await postDepartures({ departures: [dep("bk-1", "CB-3D-1012", [])] })).status).toBe(401);
    expect((await send(vendorsRoute.GET, req("GET", "/vendors"))).status).toBe(401);
  });

  it("refuses a key without the scope the call needs", async () => {
    const r = await searchVendors("", "b");
    expect(r.status).toBe(403);
    expect(r.json.error?.code).toBe("insufficient_scope");
    expect((await postDepartures({ departures: [dep("bk-1", "CB-3D-1012", [])] }, "e")).status).toBe(403);
    expect((await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD" }, "idem-scope-1", "b")).status).toBe(403);
    expect((await listRequests("", "v")).status).toBe(403);
  });

  it("refuses a call from another site's page, and anything but JSON", async () => {
    expect((await send(vendorsRoute.GET, req("GET", "/vendors", { headers: { ...auth("v"), origin: "https://evil.example" } }))).status).toBe(403);
    const plain = await send(departuresRoute.POST, new Request(`${BASE}/departures`, { method: "POST", body: "x", headers: { ...auth("b"), "content-type": "text/plain" } }));
    expect(plain.status).toBe(415);
  });

  it("limits each key per minute, and other keys are unaffected", async () => {
    vi.stubEnv("CHECKRAIL_API_RATE_LIMIT", "3");
    for (let n = 0; n < 3; n++) expect((await searchVendors()).status).toBe(200);
    const over = await searchVendors();
    expect(over.status).toBe(429);
    expect(over.json.error?.code).toBe("rate_limited");
    expect(over.headers.get("retry-after")).toBe("60");
    expect((await searchVendors("", "e")).status).toBe(200);
  });

  it("locks out wrong keys from an address, never a valid key behind the same address (review R1-4)", async () => {
    for (let n = 0; n < 21; n++) await searchVendors("", `wrong${n}`);
    // Every integration behind a shared edge address keeps working.
    expect((await searchVendors()).status).toBe(200);
    expect((await searchVendors("", "e")).status).toBe(200);
    // Guessing from that address does not.
    const r = await searchVendors("", "wrong21");
    expect(r.status).toBe(429);
    expect(r.json.error?.code).toBe("too_many_bad_keys");
  });

  it("records when each key was last used, never the secret", async () => {
    await searchVendors("?q=maria");
    await searchVendors();
    const rows = getDb().select().from(apiKeyUsage).all();
    expect(rows.map((r) => [r.keyName, r.calls, r.lastPath])).toEqual([["lookup", 2, "GET /api/v1/vendors"]]);
    expect(JSON.stringify(rows)).not.toContain(S("v"));
  });
});

describe("the middleware", () => {
  const EXEMPT = ["/api/v1/departures", "/api/v1/requests", "/api/v1/requests/obl_abc123", "/api/v1/vendors", "/api/v1/openapi.json"];
  // Paths with no route: Next renders the not-found page inside the app layout, which trusts the identity headers, so
  // the middleware must run on them and strip any forged ones.
  const NOT_EXEMPT = [
    "/settings", "/api/v1", "/api/v1/", "/api/v1/other", "/api/v1/requests/a/b", "/api/v1/vendorsx", "/api/v2/vendors",
    "/api/v1/vendors/x", "/api/v1/departures/x", "/api/v1/openapi.json/x", "/api/v1/vendors/", "/api/v1/departures/", "/api/v1/requests/",
    "/API/v1/vendors", "/api/V1/vendors", "/api/v1/Vendors", "/api/v1/REQUESTS/obl_abc123", "/api/v1/openapi.JSON",
  ];

  it("lets exactly the five /api/v1 routes through to their own bearer auth, and nothing else", () => {
    vi.stubEnv("CHECKRAIL_USERS", "judge:a-long-test-password:admin");
    const forged = { "x-checkrail-user": "daniel", "x-checkrail-role": "admin", "x-checkrail-persona": "daniel" };
    const run = (p: string) => middleware(new NextRequest(`http://checkrail.test${p}`, { headers: forged }));
    for (const p of EXEMPT) {
      expect(API_V1_PATH.test(p), p).toBe(true);
      const r = run(p);
      expect(r.headers.get("x-middleware-next"), p).toBe("1");
      // Even let through, a forged identity is stripped from the request the route sees.
      expect(r.headers.get("x-middleware-override-headers") ?? "", p).not.toMatch(/x-checkrail-role/);
    }
    for (const p of NOT_EXEMPT) {
      expect(API_V1_PATH.test(p), p).toBe(false);
      expect(run(p).status, p).toBe(401);
    }
  });

  it("is skipped by Next's own matcher for exactly the same paths", async () => {
    const { config } = await import("@/middleware");
    const mod = "next/dist/build/analysis/get-page-static-info.js";
    const { getMiddlewareMatchers } = (await import(/* @vite-ignore */ mod)) as { getMiddlewareMatchers(m: string[], c: object): Array<{ regexp: string }> };
    const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
    const runs = (p: string) => matchers.some((re) => re.test(p));
    for (const p of EXEMPT) expect(runs(p), p).toBe(false);
    for (const p of NOT_EXEMPT) expect(runs(p), p).toBe(true);
  });
});

describe("validation", () => {
  it("answers bad input with 422 and the field, in the one error shape", async () => {
    const r = await postDepartures({ departures: [{ external_id: "bk-1", code: "bad code!", start_date: "2026-02-30", end_date: "2026-10-01", guests: -1, services: [{ vendor: "Nobody", unit: "week", quantity: 0 }], colour: "red" }] });
    expect(r.status).toBe(422);
    expect(r.json.error?.code).toBe("validation_failed");
    expect(r.json.error?.details?.map((d) => d.field).sort()).toEqual(
      ["departures[0].code", "departures[0].colour", "departures[0].guests", "departures[0].services[0].quantity", "departures[0].services[0].unit", "departures[0].services[0].vendor", "departures[0].start_date"].sort(),
    );
    const money = await postRequest({ payee: "Maria Santos", amount: "$45", currency: "EUR" });
    expect(money.status).toBe(422);
    expect(money.json.error?.details?.[0]?.field).toMatch(/currency|amount/);
    expect((await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", reference: "has spaces in it" })).json.error?.details?.[0]?.field).toBe("reference");
    expect((await searchVendors("?limit=0")).status).toBe(422);
    expect((await getDepartures("?since=yesterday")).status).toBe(422);
  });

  it("refuses a body that is not JSON, or too large", async () => {
    const bad = await send(departuresRoute.POST, new Request(`${BASE}/departures`, { method: "POST", body: "{nope", headers: { ...auth("b"), "content-type": "application/json" } }));
    expect(bad.status).toBe(400);
    expect(bad.json.error?.code).toBe("invalid_json");
    const big = await send(departuresRoute.POST, new Request(`${BASE}/departures`, { method: "POST", body: "{}", headers: { ...auth("b"), "content-type": "application/json", "content-length": String(50 * 1024 * 1024) } }));
    expect(big.status).toBe(413);
    const doc = { name: "huge.txt", content_type: "text/plain", data: Buffer.alloc(2 * 1024 * 1024 + 10, 65).toString("base64") };
    const huge = await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", documents: [doc] });
    expect(huge.status).toBe(422);
    expect(huge.json.error?.details?.[0]?.field).toBe("documents[0].data");
  });
});

describe("idempotency", () => {
  const body = { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7001", description: "Invoice INV-MS-7001, one day guiding, USD 45.", evidence: [{ kind: "invoice", label: "Invoice INV-MS-7001", amount: "45", reference: "INV-MS-7001", excerpt: "Maria Santos, one day guiding, USD 45." }] };

  it("is required for a payment request", async () => {
    const r = await postRequest(body, null);
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe("idempotency_key_required");
    expect((await postRequest(body, "short")).json.error?.code).toBe("invalid_idempotency_key");
  });

  it("replays the stored answer for a retry, and creates one request", async () => {
    const before = getDb().select().from(obligations).all().length;
    const first = await postRequest(body, "erp-call-0001");
    expect(first.status).toBe(201);
    const again = await postRequest({ ...body, evidence: [{ ...body.evidence[0] }] }, "erp-call-0001");
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(again.json).toEqual(first.json);
    expect(getDb().select().from(obligations).all().length).toBe(before + 1);
  });

  it("refuses the same key with a different body", async () => {
    await postRequest(body, "erp-call-0002");
    const other = await postRequest({ ...body, amount: "450" }, "erp-call-0002");
    expect(other.status).toBe(422);
    expect(other.json.error?.code).toBe("idempotency_conflict");
  });

  it("leaves the key free after a refused call, and keys are per API key", async () => {
    expect((await postRequest({ ...body, currency: "EUR" }, "erp-call-0003")).status).toBe(422);
    expect((await postRequest(body, "erp-call-0003")).status).toBe(201);
    expect((await postRequest(body, "erp-call-0003", "l")).headers.get("idempotency-replayed")).toBeNull();
  });

  it("is honoured on the booking feed too", async () => {
    const b = { departures: [dep("bk-77", "CB-3D-1077", [phuongVan(2)])] };
    const first = await postDepartures(b, "b", { "idempotency-key": "feed-batch-0001" });
    const again = await postDepartures(b, "b", { "idempotency-key": "feed-batch-0001" });
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(again.json).toEqual(first.json);
    expect((await postDepartures({ departures: [dep("bk-78", "CB-3D-1078", [])] }, "b", { "idempotency-key": "feed-batch-0001" })).status).toBe(422);
  });
});

describe("the booking feed", () => {
  it("creates departures by external id, updates them when sent again, and reads them back", async () => {
    const r = await postDepartures({ departures: [dep("bokun-5501", "cb-3d-1012", [phuongVan(3), { vendor: "Linh Family Homestay", unit: "guest_night", quantity: 20 }])] });
    expect(r.status).toBe(200);
    expect(r.json.departures).toEqual([expect.objectContaining({ external_id: "bokun-5501", code: "CB-3D-1012", result: "created" })]);
    const again = await postDepartures({ departures: [{ ...dep("bokun-5501", "CB-3D-1012", [phuongVan(4)]), guests: 12 }] });
    expect(again.json.departures).toEqual([expect.objectContaining({ result: "updated" })]);
    const listed = (await getDepartures("?since=2026-10-01")).json.departures as Array<Record<string, unknown>>;
    const mine = listed.find((d) => d.external_id === "bokun-5501")!;
    expect(mine).toMatchObject({ code: "CB-3D-1012", guests: 12, source: "booking_system", services: [{ vendor_id: "ven_phuong", vendor: "Phuong Transport", unit: "vehicle_day", quantity: 4 }] });
    expect(listed.every((d) => (d.start_date as string) >= "2026-10-01")).toBe(true);
  });

  it("refuses a code another external id holds, and saves nothing from that call", async () => {
    const r = await postDepartures({ departures: [dep("bokun-1098", "CB-3D-1098", [phuongVan(4)])] });
    expect(r.json.departures).toEqual([expect.objectContaining({ result: "created" })]);
    const clash = await postDepartures({ departures: [dep("bokun-other", "CB-3D-1098", [phuongVan(40)]), dep("bokun-new", "CB-3D-1099", [])] });
    expect(clash.status).toBe(409);
    expect(clash.json.error?.code).toBe("departure_conflict");
    // All or nothing: the other departure in the batch was not saved either.
    expect(((await getDepartures()).json.departures as Array<{ code: string }>).some((d) => d.code === "CB-3D-1099")).toBe(false);
  });

  it("is audited as the integration", async () => {
    await postDepartures({ departures: [dep("bokun-5501", "CB-3D-1012", [phuongVan(3)])] });
    const row = getDb().select().from(auditEntries).where(eq(auditEntries.action, "departures.upserted")).get()!;
    expect(row.actor).toBe("api:bookings");
    expect(JSON.parse(row.detailJson!)).toMatchObject({ created: 1, updated: 0, codes: ["CB-3D-1012"] });
  });
});

describe("payment requests", () => {
  const phuong = (amount: string, ref: string) => ({
    payee: "Phuong Transport",
    amount,
    currency: "USD",
    reference: ref,
    description: `Van and driver for ${ref}, 3 vehicle-days.`,
    evidence: [{ kind: "invoice", label: `Invoice for ${ref}`, amount, reference: ref, excerpt: `Phuong Transport, ${ref}, 3 vehicle-days, USD ${amount}.` }],
  });

  it("are judged against the departure the feed sent, by the existing rate card rule", async () => {
    await postDepartures({ departures: [dep("bokun-1012", "CB-3D-1012", [phuongVan(3)]), dep("bokun-1013", "CB-3D-1013", [phuongVan(3)])] });
    const right = await postRequest(phuong("600", "CB-3D-1012"));
    expect(right.status).toBe(201);
    expect(right.json.rules_failed).not.toContain("expected_amount");
    const inflated = await postRequest(phuong("900", "CB-3D-1013"));
    expect(inflated.status).toBe(201);
    expect(inflated.json.verdict).toBe("block");
    expect(inflated.json.status).toBe("blocked");
    expect(inflated.json.rules_failed).toContain("expected_amount");
    expect(inflated.json.reasons).toContain("The amount does not match the rate card and departure on file.");
  });

  it("are checked again when the departure arrives after the request", async () => {
    const early = await postRequest(phuong("900", "CB-3D-1014"));
    expect(early.json.rules_failed).not.toContain("expected_amount");
    const r = await postDepartures({ departures: [dep("bokun-1014", "CB-3D-1014", [phuongVan(3)])] });
    expect(r.json.rechecked).toBeGreaterThanOrEqual(1);
    const now = await getRequest(early.json.id as string);
    expect(now.json.status).toBe("blocked");
    expect(now.json.rules_failed).toContain("expected_amount");
  });

  it("are recorded as coming from the integration, with its say-so unless it may attest", async () => {
    const db = getDb();
    const plain = await postRequest(phuong("600", "INV-PT-8001"));
    const created = db.select().from(auditEntries).where(eq(auditEntries.obligationId, plain.json.id as string)).all().find((a) => a.action === "obligation.created")!;
    expect(created.actor).toBe("api:erp");
    expect(db.select().from(evidence).where(eq(evidence.obligationId, plain.json.id as string)).all().map((e) => e.provenance)).toEqual(["operator"]);
    const attested = await postRequest(phuong("600", "INV-PT-8002"), undefined, "l");
    expect(db.select().from(evidence).where(eq(evidence.obligationId, attested.json.id as string)).all().map((e) => e.provenance)).toEqual(["system"]);
    const o = db.select().from(obligations).where(eq(obligations.id, attested.json.id as string)).get()!;
    expect([o.vendorId, o.amountMinor, o.currency, o.sourceRef]).toEqual(["ven_phuong", 60_000, "USD", "INV-PT-8002"]);
  });

  it("carry an attached document through the clerk's upload path", async () => {
    const text = "Invoice INV-MS-7100\nMaria Santos\nOne day guiding\nTotal USD 45.00";
    const r = await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7100", documents: [{ name: "invoice.txt", content_type: "text/plain", data: Buffer.from(text).toString("base64"), kind: "invoice" }] });
    expect(r.status).toBe(201);
    const rows = getDb().select().from(evidence).where(eq(evidence.obligationId, r.json.id as string)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].attachmentId).toBeTruthy();
    // A .txt is as easy to type as the form, so it never counts as an independent document.
    expect(rows[0].provenance).toBe("operator");
  });

  it("never expose payout details, contact details or another key's requests", async () => {
    const r = await postRequest({ payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914", description: "Pay Maria Santos USD 180 for JOB-HG4D-0914" });
    expect(r.status).toBe(201);
    const maria = getDb().select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!;
    const shown = JSON.stringify([r.json, (await getRequest(r.json.id as string)).json, (await listRequests("?reference=job-hg4d-0914")).json]);
    for (const secret of [maria.paypalEmail, maria.email, maria.stellarAccount, maria.bankLabel, maria.phone, maria.taxId].filter(Boolean) as string[]) expect(shown).not.toContain(secret);
    expect(shown).not.toMatch(/paypal_?email|bank_?label|stellar_?account|account_?holder/i);
    expect(((await listRequests("?reference=JOB-HG4D-0914")).json.requests as unknown[]).length).toBe(1);
    // The ledger key did not make it, so it does not exist for that key.
    const other = await getRequest(r.json.id as string, "l");
    expect(other.status).toBe(404);
    expect(other.json.error?.code).toBe("not_found");
    expect(((await listRequests("", "l")).json.requests as unknown[]).length).toBe(0);
  });
});

describe("review fixes, round 1", () => {
  const rosaDeposit = {
    payee: "Rosa Villanueva", amount: "100", currency: "USD", reference: "INV-ROSA-7777",
    description: "50% deposit USD 100 for Rosa Villanueva on invoice INV-ROSA-7777",
    evidence: [{ kind: "invoice", label: "Invoice INV-ROSA-7777", amount: "5000", reference: "INV-ROSA-7777", excerpt: "Rosa Villanueva. Guiding, November. Total USD 5,000.00. Deposit 50%." }],
  };
  const rosaJob = {
    payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-7777",
    description: "Rosa Villanueva, 2 days guiding at USD 95, INV-ROSA-7777.",
    evidence: [{ kind: "job_sheet", label: "Trip sheet INV-ROSA-7777", amount: "190", reference: "INV-ROSA-7777", excerpt: "Guide: Rosa Villanueva. 2 days at USD 95. Total USD 190.00." }],
  };

  it("R1-2 (AG-5 for the API): a non-attest key's own invoice sets no bill ceiling", async () => {
    const { bills } = await import("@/lib/db/schema");
    const before = getDb().select().from(bills).all().length;
    const r = await postRequest(rosaDeposit, "r1-2-deposit-01");
    expect(r.status).toBe(201);
    expect(getDb().select().from(bills).all().length).toBe(before);
    expect(r.json.status).not.toBe("scheduled");
  });

  it("R1-2: the same job twice from an attest key, after another key's deposit, is not scheduled twice", async () => {
    // With the demo's payment history, so Rosa is not a first-time payee and Autopilot may schedule her.
    await seedDemo(getDb());
    setAutonomy(getDb(), DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
    expect((await postRequest(rosaDeposit, "r1-2-deposit-02")).status).toBe(201);
    const first = await postRequest(rosaJob, "r1-2-job-0001", "l");
    const second = await postRequest(rosaJob, "r1-2-job-0002", "l");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.json.status).not.toBe("scheduled");
    expect(second.json.status).not.toBe("approved");
  });

  it("R1-3: reasons never name another supplier or how far their payment got", async () => {
    // Maria Santos was paid for JOB-HG4D-0914; Rosa is asked for the same reference.
    const r = await postRequest({ payee: "Rosa Villanueva", amount: "180", currency: "USD", reference: "JOB-HG4D-0914", description: "Guiding JOB-HG4D-0914" });
    expect(r.status).toBe(201);
    expect(r.json.rules_failed).toContain("reference_other_vendor");
    const read = (j: Json) => JSON.stringify([j.reasons, j.rules_failed]);
    expect(read(r.json)).not.toMatch(/Maria|Santos|\((?:settled|approved|blocked|awaiting_approval)\)/);
    expect(read(r.json)).toMatch(/another supplier/);
    // Read back after it left the waiting states, from the stored reasons.
    getDb().update(obligations).set({ state: "cancelled" }).where(eq(obligations.id, r.json.id as string)).run();
    const later = await getRequest(r.json.id as string);
    expect(later.json.status).toBe("cancelled");
    expect(read(later.json)).not.toMatch(/Maria|Santos|\((?:settled|approved|blocked|awaiting_approval)\)/);
  });

  it("R1-6a: a claim left without an answer (a crash mid-call) does not hold the key for days", async () => {
    getDb().insert(apiIdempotency).values({ id: "idm_stale", keyName: "erp", idemKey: "r1-6-crashed-01", method: "POST", path: "/api/v1/requests", bodySha256: "x", status: null, responseJson: null, createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }).run();
    const r = await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7201" }, "r1-6-crashed-01");
    expect(r.status).toBe(201);
    // A claim seconds old for the same body is still a call in flight.
    const body = { amount: "45", currency: "USD", payee: "Maria Santos", reference: "INV-MS-7202" }; // keys in sorted order, as hashed
    const hash = createHash("sha256").update(`POST /api/v1/requests\n${JSON.stringify(body)}`).digest("hex");
    getDb().insert(apiIdempotency).values({ id: "idm_fresh", keyName: "erp", idemKey: "r1-6-running-01", method: "POST", path: "/api/v1/requests", bodySha256: hash, status: null, responseJson: null, createdAt: new Date().toISOString() }).run();
    const running = await postRequest(body, "r1-6-running-01");
    expect(running.status).toBe(409);
    expect(running.json.error?.code).toBe("idempotency_in_progress");
  });

  it("R1-6b: a retry finds the request its key already made, even if the stored answer is gone", async () => {
    const body = { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7301" };
    const first = await postRequest(body, "r1-6-bound-0001");
    const count = getDb().select().from(obligations).all().length;
    getDb().delete(apiIdempotency).run();
    const retry = await postRequest(body, "r1-6-bound-0001");
    expect(retry.status).toBe(201);
    expect(retry.json.id).toBe(first.json.id);
    expect(getDb().select().from(obligations).all().length).toBe(count);
    getDb().delete(apiIdempotency).run();
    const other = await postRequest({ ...body, amount: "450" }, "r1-6-bound-0001");
    expect(other.status).toBe(422);
    expect(other.json.error?.code).toBe("idempotency_conflict");
  });
});

describe("review fixes, round 2", () => {
  it("M1: a non-attest key's own PDF sets no bill ceiling, so the same job is not scheduled twice", async () => {
    const { bills } = await import("@/lib/db/schema");
    await seedDemo(getDb());
    setAutonomy(getDb(), DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
    const pdf = textPdf(["Invoice INV-ROSA-7777", "Rosa Villanueva", "Guiding, November", "Total USD 5,000.00", "Deposit 50%"]);
    const deposit = await postRequest({
      payee: "Rosa Villanueva", amount: "100", currency: "USD", reference: "INV-ROSA-7777",
      description: "50% deposit USD 100 for Rosa Villanueva on invoice INV-ROSA-7777",
      documents: [{ name: "INV-ROSA-7777.pdf", content_type: "application/pdf", kind: "invoice", data: pdf.toString("base64") }],
    }, "m1-deposit-0001");
    expect(deposit.status).toBe(201);
    // The scenario is real: the PDF was read and its row counts as a document, not the key's typing.
    expect(getDb().select().from(evidence).where(eq(evidence.obligationId, deposit.json.id as string)).all().map((e) => [e.provenance, e.amountMinor])).toEqual([["document", 500_000]]);
    expect(getDb().select().from(bills).all().filter((b) => b.reference === "INV-ROSA-7777")).toEqual([]);
    const job = { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-7777", description: "Rosa Villanueva, 2 days guiding at USD 95, INV-ROSA-7777.", evidence: [{ kind: "job_sheet", label: "Trip sheet INV-ROSA-7777", amount: "190", reference: "INV-ROSA-7777", excerpt: "Guide: Rosa Villanueva. 2 days at USD 95. Total USD 190.00." }] };
    await postRequest(job, "m1-job-000001", "l");
    const second = await postRequest(job, "m1-job-000002", "l");
    expect(["scheduled", "approved"]).not.toContain(second.json.status);
  });

  it("S1: the feed cannot take over or change a departure an approver imported", async () => {
    // HG-4D-0927 comes from the demo's manifest (source csv).
    const before = (await getDepartures()).json.departures as Array<{ code: string; services: unknown[] }>;
    const r = await postDepartures({ departures: [dep("bokun-0927", "HG-4D-0927", [phuongVan(40)], ["2026-09-27", "2026-09-30"])] });
    expect(r.status).toBe(409);
    expect(r.json.error?.code).toBe("departure_conflict");
    expect(r.json.error?.message).toMatch(/HG-4D-0927.*approver/);
    const after = (await getDepartures()).json.departures as Array<{ code: string; services: unknown[] }>;
    expect(after.find((d) => d.code === "HG-4D-0927")).toEqual(before.find((d) => d.code === "HG-4D-0927"));
    // Nor one the feed made itself once an approver's import has replaced it.
    await postDepartures({ departures: [dep("bokun-1200", "CB-3D-1200", [phuongVan(3)])] });
    getDb().update(departuresTable).set({ source: "csv" }).where(eq(departuresTable.code, "CB-3D-1200")).run();
    expect((await postDepartures({ departures: [dep("bokun-1200", "CB-3D-1200", [phuongVan(30)])] })).status).toBe(409);
  });

  it("answers carry no internal review path", async () => {
    const r = await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7501" });
    expect(r.json).not.toHaveProperty("review_path");
    expect(JSON.stringify(r.json)).not.toMatch(/\/obligations\//);
  });
});

describe("review fixes, round 3", () => {
  const job = { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-7777", description: "Rosa Villanueva, 2 days guiding at USD 95, INV-ROSA-7777.", evidence: [{ kind: "job_sheet", label: "Trip sheet INV-ROSA-7777", amount: "190", reference: "INV-ROSA-7777", excerpt: "Guide: Rosa Villanueva. 2 days at USD 95. Total USD 190.00." }] };
  const personBill = (reference: string, totalMinor: number) =>
    createBill(getDb(), DEMO_BUSINESS_ID, resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk"), "ven_rosa", { kind: "invoice", reference, totalMinor, currency: "USD", billDate: null, dueDate: null, note: "Recorded by a person" });
  const autopilot = async () => {
    await seedDemo(getDb());
    setAutonomy(getDb(), DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
  };

  it("M1 control: without a bill, the same job twice is scheduled once and blocked once", async () => {
    await autopilot();
    expect((await postRequest(job, "r3-ctl-000001", "l")).json.status).toBe("scheduled");
    expect((await postRequest(job, "r3-ctl-000002", "l")).json.status).toBe("blocked");
  });

  // ---- Round 8: an outside request about a bill always waits for a person, and its sender is told the same either way.
  describe("round 8: outside requests about a bill", () => {
    const NEUTRAL = "A person reviews payments to this supplier.";
    const pay = (reference: string, amount = "100", currency = "USD", description = `Rosa Villanueva, guiding, ${currency} ${amount}, invoice ${reference}.`) => ({ payee: "Rosa Villanueva", amount, currency, reference, description, evidence: [{ kind: "job_sheet", label: `Trip sheet ${reference}`, amount, reference, excerpt: `Guide: Rosa Villanueva. Total ${currency} ${amount}.` }] });
    const ob = (id: unknown) => getDb().select().from(obligations).where(eq(obligations.id, id as string)).get()!;
    const inside = (id: unknown) => previewPolicy(getDb(), id as string);
    const insideRules = (id: unknown) => inside(id).rules.filter((r) => !r.passed).map((r) => r.ruleId);
    // What the sender sees, without the request's own id and times.
    const seen = (j: Json) => ({ status: j.status, state: j.state, verdict: j.verdict, reasons: j.reasons, rules_failed: j.rules_failed, rail: j.rail, releases_at: j.releases_at, settlement: j.settlement });
    const neutral = (j: Json) => expect(seen(j)).toEqual({ status: "waiting_for_approval", state: "awaiting_approval", verdict: "hold", reasons: [NEUTRAL], rules_failed: ["bill_review"], rail: null, releases_at: null, settlement: expect.objectContaining({ status: "not_sent" }) });
    const ackAll = (id: string) => inside(id).rules.filter((r) => r.severity === "warn" && !r.passed).map((r) => `${r.ruleId}|${r.key ?? r.message}`);

    it("control: an unbilled outside request under the limits still pays without a person", async () => {
      await autopilot();
      expect((await postRequest(pay("INV-ROSA-8001"), "r8-ctl-000001", "l")).json.status).toBe("scheduled");
    });

    it("a fitting request on a bill waits for a person, and a person's approval lets it pay", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("INV-ROSA-6001", "100"), "r8-fit-000001", "l");
      neutral(r.json);
      expect(ob(r.json.id).state).toBe("awaiting_approval");
      expect(ob(r.json.id).releaseAt).toBeNull();
      expect(inside(r.json.id).rules.find((x) => x.ruleId === "bill_review")?.message).toBe("Request on bill INV-ROSA-6001: USD 100.00 of USD 100.00 open. A person reviews payments to this supplier.");
      const id = r.json.id as string;
      approveObligation(getDb(), id, "user:minh", "Checked against the bill", ackAll(id));
      expect(ob(id).state).toBe("approved");
      await executeObligation(getDb(), id, { actor: "user:minh" });
      expect(["sent", "settled", "execution_pending"]).toContain(ob(id).state);
    });

    it("a person cannot approve one that is over what is open", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("INV-ROSA-6001", "150"), "r8-over-00001", "l");
      neutral(r.json);
      expect(ob(r.json.id).state).toBe("blocked");
      expect(insideRules(r.json.id)).toContain("bill_misfit");
      expect(() => approveObligation(getDb(), r.json.id as string, "user:minh", "ok", ackAll(r.json.id as string))).toThrow();
      expect(ob(r.json.id).state).toBe("blocked");
    });

    it("M2: probing with check_payment and REST gets the same answer for fitting and misfitting amounts", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const agentKey = { name: "bookings", scopes: ["check", "request", "attest"] as AgentKey["scopes"], digest: Buffer.alloc(32) };
      const answers: string[] = [];
      for (const amount of ["50", "100", "101", "150", "75", "99.99"]) {
        const c = await checkPayment(getDb(), agentKey, pay("INV-ROSA-6001", amount));
        answers.push(JSON.stringify({ verdict: c.verdict, summary: c.summary, blocks: c.blocks, warnings: c.warnings, next_steps: c.next_steps, paypal: c.paypal_transaction_id }));
        const r = await postRequest(pay("INV-ROSA-6001", amount), `r8-probe-${amount.replace(".", "")}-0`, "l");
        answers.push(JSON.stringify(seen(r.json)));
        answers.push(JSON.stringify(seen((await getRequest(r.json.id as string, "l")).json)));
      }
      const byKind = [0, 1, 2].map((k) => new Set(answers.filter((_, i) => i % 3 === k)));
      expect(byKind.map((s) => s.size)).toEqual([1, 1, 1]);
      expect(JSON.parse([...byKind[0]][0]).verdict).toBe("hold");
    });

    it("M2: the same for another currency, a credit note, a void bill and an ambiguous reference", async () => {
      await autopilot();
      const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
      personBill("INV-ROSA-6001", 10_000);
      createBill(getDb(), DEMO_BUSINESS_ID, lan, "ven_rosa", { kind: "credit_note", reference: "CN-ROSA-6002", totalMinor: 10_000, currency: "USD", billDate: null, dueDate: null, note: null });
      const v = personBill("INV-ROSA-6003", 10_000);
      getDb().update(billsTable).set({ status: "void" }).where(eq(billsTable.id, v)).run();
      personBill("INV-ROSA-6004", 10_000);
      personBill("INV_ROSA_06004", 20_000);
      for (const [ref, amount, cur, rule] of [["INV-ROSA-6001", "5000", "PHP", "bill_misfit"], ["CN-ROSA-6002", "50", "USD", "bill_misfit"], ["INV-ROSA-6003", "50", "USD", "bill_misfit"], ["INV-ROSA-6004", "50", "USD", "bill_ambiguous"]] as const) {
        const r = await postRequest(pay(ref, amount, cur), `r8-m2-${ref.replace(/[^A-Za-z0-9]/g, "")}`, "l");
        neutral(r.json);
        expect(ob(r.json.id).state, ref).toBe("blocked");
        expect(insideRules(r.json.id), ref).toContain(rule);
      }
    });

    it("M1: an ambiguous request is not linked by a later bill and is never released", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("INV_ROSA_6001", "50"), "r8-m1-0000001", "l");
      expect(ob(r.json.id).billId).not.toBeNull();
      const second = await postRequest(pay("INV-ROSA-06001-R", "50"), "r8-m1-0000002", "l");
      const later = personBill("INV-ROSA-6001-R", 10_000);
      await linkWaitingToBill(getDb(), later, "user:lan");
      neutral((await getRequest(second.json.id as string, "l")).json);
      expect(ob(second.json.id).releaseAt).toBeNull();
      expect(ob(second.json.id).state).not.toBe("approved");
      const { runAutopilot } = await import("@/lib/engine/autopilot");
      await runAutopilot(getDb());
      expect(getDb().select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, second.json.id as string)).all()).toHaveLength(0);
    });

    it("a request picked up by a bill recorded later waits for a person and loses its release", async () => {
      await autopilot();
      const r = await postRequest(pay("INV_ROSA_6005", "150"), "r8-later-00001", "l");
      expect(r.json.status).toBe("scheduled");
      const bill = personBill("INV-ROSA-6005", 10_000);
      expect(await linkWaitingToBill(getDb(), bill, "user:lan")).toBe(1);
      expect(ob(r.json.id).billId).toBe(bill);
      expect(ob(r.json.id).releaseAt).toBeNull();
      neutral((await getRequest(r.json.id as string, "l")).json);
    });

    it("misfit arithmetic counts only what a person approved or that moved, not other unapproved requests", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const first = await postRequest(pay("INV-ROSA-6001", "80"), "r8-crowd-00001", "l");
      expect(ob(first.json.id).state).toBe("awaiting_approval");
      const second = await postRequest(pay("INV-ROSA-6001", "90"), "r8-crowd-00002", "l");
      expect(insideRules(second.json.id)).not.toContain("bill_misfit");
      approveObligation(getDb(), first.json.id as string, "user:minh", "ok", ackAll(first.json.id as string));
      expect(insideRules(second.json.id)).toContain("bill_misfit");
    });

    it("an approval given before another part arrived does not count", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 50_000);
      const first = await postRequest(pay("INV-ROSA-6001", "100"), "r8-ack-000001", "l");
      const id = first.json.id as string;
      approveObligation(getDb(), id, "user:minh", "ok", ackAll(id));
      expect(inside(id).decision).toBe("auto_execute");
      await postRequest(pay("INV-ROSA-6001", "120"), "r8-ack-000002", "l");
      expect(inside(id).decision).toBe("require_approval");
    });

    it("the person sees which part this is and the other parts", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 50_000);
      await postRequest(pay("INV-ROSA-6001", "100"), "r8-part-00001", "l");
      const r = await postRequest(pay("INV-ROSA-6001", "110"), "r8-part-00002", "l");
      expect(inside(r.json.id).rules.find((x) => x.ruleId === "bill_part")?.message).toMatch(/^Part 2 of bill INV-ROSA-6001; other parts: USD 100\.00, awaiting approval /);
      expect(JSON.parse(ob(r.json.id).policyReasonsJson ?? "[]").join(" ")).toMatch(/Part 2 of bill INV-ROSA-6001/);
    });

    for (const spelling of ["INV_ROSA_6001", "INV.ROSA.6001", "INVROSA6001", "INV-ROSA-6001-R", "INV-ROSA-6001/2", "INV-ROSA-06001", "ADV-ROSA-6009"]) {
      it(`${spelling} is held on its bill`, async () => {
        await autopilot();
        const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
        const bill = spelling.startsWith("ADV") ? createBill(getDb(), DEMO_BUSINESS_ID, lan, "ven_rosa", { kind: "advance", reference: "ADV-ROSA-6009", totalMinor: 10_000, currency: "USD", billDate: null, dueDate: null, note: null }) : personBill("INV-ROSA-6001", 10_000);
        const r = await postRequest(pay(spelling, "150"), `r8-sp-${spelling.replace(/[^A-Za-z0-9]/g, "")}`, "l");
        neutral(r.json);
        expect(ob(r.json.id).billId).toBe(bill);
      });
    }

    for (const [billRef, spelling] of [["ROSA-NOV", "ROSA-NOV"], ["ROSA-NOV", "Rosa_Nov"], ["ROSA-NOV", "ROSANOV"], ["A1", "A1"], ["A1", "a-1"], ["INV-ROSA-6001", "INV-ROSA-6001-R/2"], ["INV-ROSA-6001", "INV-ROSA-6001/003"]]) {
      it(`R9: ${spelling} is held on the bill ${billRef}`, async () => {
        await autopilot();
        const bill = personBill(billRef, 10_000);
        const r = await postRequest(pay(spelling, "50"), `r9-sp-${spelling.replace(/[^A-Za-z0-9]/g, "")}-${billRef.length}`, "l");
        neutral(r.json);
        expect(ob(r.json.id).billId).toBe(bill);
      });
    }

    it("R9-S2: a /003 after a year is still not a part", async () => {
      await autopilot();
      personBill("RET-ROSA-2026", 10_000);
      const r = await postRequest(pay("RET-ROSA-2026/003", "50"), "r9-year-00003", "l");
      expect(ob(r.json.id).billId).toBeNull();
    });

    it("R9-M2/S1: once a person approves, both channels read approved with the neutral sentence, whatever else changes", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 20_000);
      const agentKey = { name: "bookings", scopes: ["check", "request", "attest"] as AgentKey["scopes"], digest: Buffer.alloc(32) };
      const sent = await requestPayment(getDb(), agentKey, { ...pay("INV-ROSA-6001", "100"), idempotency_key: "r9-mcp-0000001" });
      const id = sent.request_id;
      approveObligation(getDb(), id, "user:minh", "ok", ackAll(id));
      // Hold the release so it stays approved while the bill changes.
      getDb().update(obligations).set({ releaseAt: null }).where(eq(obligations.id, id)).run();
      const before = paymentStatus(getDb(), agentKey, { request_id: id });
      expect(before).toMatchObject({ status: "approved", reasons: [NEUTRAL] });
      // Another part arrives and the bill is then closed: inside, this one no longer fits.
      const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
      const billId = getDb().select().from(billsTable).all().find((b) => b.reference === "INV-ROSA-6001")!.id;
      await payBill(getDb(), DEMO_BUSINESS_ID, lan, billId, 5_000);
      getDb().update(billsTable).set({ status: "closed" }).where(eq(billsTable.id, billId)).run();
      expect(insideRules(id)).toContain("bill_misfit");
      const after = paymentStatus(getDb(), agentKey, { request_id: id });
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).not.toMatch(/USD (?:50|150|200)\.00|open/);
      // The REST view of an API key's approved bill request reads the same way.
      personBill("INV-ROSA-6002", 20_000);
      const r = await postRequest(pay("INV-ROSA-6002", "40"), "r9-rest-000001", "l");
      approveObligation(getDb(), r.json.id as string, "user:minh", "ok", ackAll(r.json.id as string));
      getDb().update(obligations).set({ releaseAt: null }).where(eq(obligations.id, r.json.id as string)).run();
      expect(seen((await getRequest(r.json.id as string, "l")).json)).toMatchObject({ status: "approved", verdict: "approved", reasons: [NEUTRAL], rules_failed: ["bill_review"] });
    });

    it("R9-S1: once final, only its own status, no reasons", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 20_000);
      const r = await postRequest(pay("INV-ROSA-6001", "100"), "r9-final-00001", "l");
      getDb().update(obligations).set({ state: "cancelled" }).where(eq(obligations.id, r.json.id as string)).run();
      expect(seen((await getRequest(r.json.id as string, "l")).json)).toMatchObject({ status: "cancelled", verdict: null, reasons: [], rules_failed: [] });
    });

    it("R9-N2: an outside agent or integration can never approve", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 20_000);
      const r = await postRequest(pay("INV-ROSA-6001", "100"), "r9-gate-00001", "l");
      for (const actor of ["api:ledger", "mcp:bookings"]) expect(() => approveObligation(getDb(), r.json.id as string, actor, "ok", ackAll(r.json.id as string))).toThrow(/cannot approve/);
      expect(ob(r.json.id).state).toBe("awaiting_approval");
    });

    it("S1: a /N after a year is a month, not a part: RET-ROSA-2026/10 and /11 do not match (and R10: it is held anyway)", async () => {
      await autopilot();
      personBill("RET-ROSA-2026/10", 10_000);
      const r = await postRequest(pay("RET-ROSA-2026/11", "100"), "r8-year-00001", "l");
      expect(ob(r.json.id).billId).toBeNull();
      neutral(r.json);
      const { billsMatching } = await import("@/lib/engine/bills");
      expect(billsMatching(getDb(), "ven_rosa", "RET-ROSA-2026/10").map((b) => b.reference)).toEqual(["RET-ROSA-2026/10"]);
    });

    it("N3: INV-ROSA-60030 is not the bill INV-ROSA-6003", async () => {
      await autopilot();
      personBill("INV-ROSA-6003", 10_000);
      const r = await postRequest(pay("INV-ROSA-60030", "100"), "r8-n3-0000001", "l");
      expect(ob(r.json.id).billId).toBeNull();
      // Not matched, but this supplier has a recent bill, so a person still looks.
      neutral(r.json);
    });

    // ---- Round 10: fail closed. Any bill of the supplier in the last 180 days holds every outside request for a person.
    for (const [billRef, spelling] of [
      ["ROSA-NOV", "ROSA-NOV/2"], ["A1", "A1/2"], ["INV-12", "INV-12/2"], ["INV-ROSA-6001", "INV-ROSA-6001-COPY/2"],
      ["INV-ROSA-6001", "INV-ROSA-6001-2"], ["INV-ROSA-6001", "INV-ROSA-6001.2"], ["INV-ROSA-6001", "INV-ROSA-6001_2"], ["INV-ROSA-6001", "INV-ROSA-6001#2"],
      ["INV-ROSA-6001", "INV-ROSA-6001:2"], ["INV-ROSA-6001", "INV-ROSA-6001/0002"], ["INV-ROSA-6001", "INV-ROSA-6001/2/1"], ["INV-ROSA-6001", "INV-ROSA-6001-P2"],
      ["INV-ROSA-6001", "INV-ROSA-6001-RE"],
    ]) {
      it(`R10-S1: ${spelling} next to bill ${billRef} is held for a person, not scheduled`, async () => {
        await autopilot();
        personBill(billRef, 10_000);
        const r = await postRequest(pay(spelling, "50"), `r10-sp-${spelling.replace(/[^A-Za-z0-9]/g, "")}-${billRef.length}`, "l");
        neutral(r.json);
        expect(ob(r.json.id).releaseAt).toBeNull();
        expect(insideRules(r.json.id).some((x) => x.startsWith("bill_"))).toBe(true);
        const { runAutopilot } = await import("@/lib/engine/autopilot");
        await runAutopilot(getDb());
        expect(getDb().select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, r.json.id as string)).all()).toHaveLength(0);
      });
    }

    for (const [billRef, spelling] of [["INV-ROSA-2050", "INV-ROSA-2050/2"], ["RET-ROSA-2026", "RET-ROSA-2026/11"]]) {
      it(`R10-S2: ${spelling} is not a part of ${billRef} (a year), but is held for a person anyway`, async () => {
        await autopilot();
        personBill(billRef, 10_000);
        const r = await postRequest(pay(spelling, "50"), `r10-yr-${spelling.replace(/[^A-Za-z0-9]/g, "")}`, "l");
        expect(ob(r.json.id).billId).toBeNull();
        neutral(r.json);
        expect(ob(r.json.id).state).toBe("awaiting_approval");
      });
    }

    it("R10: naming none of the recent bills, the person is told so, sees the bills and what is open, and may approve it as unbilled work", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("TRIP-ROSA-0042", "50"), "r10-none-00001", "l");
      neutral(r.json);
      const id = r.json.id as string;
      const rules = inside(id).rules;
      expect(rules.find((x) => x.ruleId === "bill_review")?.message).toMatch(/names none of this supplier's recent bills/);
      expect(rules.find((x) => x.ruleId === "bill_recent")?.message).toBe("This supplier's bills in the last 180 days: INV-ROSA-6001 (invoice, open, USD 100.00 open)");
      approveObligation(getDb(), id, "user:minh", "Unbilled work, checked", ackAll(id));
      expect(inside(id).decision).toBe("auto_execute");
      // A bill recorded after the approval is new to the approver: the approval no longer covers it.
      personBill("INV-ROSA-6002", 10_000);
      expect(inside(id).decision).toBe("require_approval");
    });

    it("R10: a match and no match read the same to the caller, on REST and MCP (no enumeration)", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const agentKey = { name: "bookings", scopes: ["check", "request", "attest"] as AgentKey["scopes"], digest: Buffer.alloc(32) };
      const answers: string[][] = [[], []];
      for (const ref of ["INV-ROSA-6001", "TRIP-ROSA-0043"]) {
        const c = await checkPayment(getDb(), agentKey, pay(ref, "50"));
        answers[0].push(JSON.stringify({ verdict: c.verdict, summary: c.summary, blocks: c.blocks, warnings: c.warnings, next_steps: c.next_steps }));
        const r = await postRequest(pay(ref, "50"), `r10-enum-${ref.replace(/[^A-Za-z0-9]/g, "")}`, "l");
        answers[1].push(JSON.stringify(seen(r.json)));
      }
      expect(new Set(answers[0]).size).toBe(1);
      expect(new Set(answers[1]).size).toBe(1);
      expect(answers[0][0]).toContain("A person reviews payments to this supplier.");
    });

    it("R10 control: a bill older than 180 days does not hold an unbilled request", async () => {
      await autopilot();
      const old = personBill("INV-ROSA-5001", 10_000);
      getDb().update(billsTable).set({ createdAt: new Date(Date.now() - 181 * 86_400_000).toISOString() }).where(eq(billsTable.id, old)).run();
      expect((await postRequest(pay("TRIP-ROSA-0044", "50"), "r10-old-00001", "l")).json.status).toBe("scheduled");
    });

    it("R10 demo seed: only Dao Mountain Lodge has a bill, so outside requests to the other suppliers keep the normal rules", async () => {
      await seedDemo(getDb());
      const billVendors = new Set(getDb().select().from(billsTable).all().map((b) => getDb().select().from(vendors).where(eq(vendors.id, b.vendorId)).get()?.name));
      expect([...billVendors]).toEqual(["Dao Mountain Lodge"]);
    });

    it("R10-M2: a reference amended onto a void bill puts the request on it, blocked; a person cannot approve", async () => {
      await autopilot();
      const v = personBill("INV-ROSA-6003", 10_000);
      getDb().update(billsTable).set({ status: "void" }).where(eq(billsTable.id, v)).run();
      const r = await postRequest(pay("TRIP-ROSA-0045", "50"), "r10-amd-00001", "l");
      const id = r.json.id as string;
      expect(ob(id).billId).toBeNull();
      const { amendObligation } = await import("@/lib/engine/orchestrator");
      await amendObligation(getDb(), id, "user:minh", { sourceRef: "INV-ROSA-6003" });
      expect(ob(id).billId).toBe(v);
      expect(ob(id).state).toBe("blocked");
      expect(insideRules(id)).toContain("bill_misfit");
      expect(() => approveObligation(getDb(), id, "user:minh", "ok", ackAll(id))).toThrow();
      neutral((await getRequest(id, "l")).json);
    });

    it("R10-M2: a payee amended to a supplier with a closed matching bill puts the request on it, blocked; a person cannot approve", async () => {
      await autopilot();
      const closed = personBill("INV-ROSA-6004", 10_000);
      getDb().update(billsTable).set({ status: "closed" }).where(eq(billsTable.id, closed)).run();
      const r = await postRequest(pay("INV-ROSA-6004", "50"), "r10-amd-00002", "l");
      const id = r.json.id as string;
      // As if the payee had not been resolved when it came in.
      getDb().update(obligations).set({ vendorId: null, billId: null, state: "blocked" }).where(eq(obligations.id, id)).run();
      const { amendObligation } = await import("@/lib/engine/orchestrator");
      await amendObligation(getDb(), id, "user:minh", { vendorId: "ven_rosa" });
      expect(ob(id).billId).toBe(closed);
      expect(ob(id).state).toBe("blocked");
      expect(insideRules(id)).toContain("bill_misfit");
      expect(() => approveObligation(getDb(), id, "user:minh", "ok", ackAll(id))).toThrow();
    });

    it("R10-M2: a re-check puts the request on the bill it names before policy", async () => {
      await autopilot();
      const r = await postRequest(pay("INV-ROSA-6006", "50"), "r10-rck-00001", "l");
      const id = r.json.id as string;
      // A bill written straight in, with no linking step, and voided.
      const v = personBill("INV-ROSA-6006", 10_000);
      getDb().update(billsTable).set({ status: "void" }).where(eq(billsTable.id, v)).run();
      getDb().update(obligations).set({ state: "awaiting_approval", releaseAt: null }).where(eq(obligations.id, id)).run();
      const { recheckObligation } = await import("@/lib/engine/orchestrator");
      await recheckObligation(getDb(), id, "user:minh");
      expect(ob(id).billId).toBe(v);
      expect(ob(id).state).toBe("blocked");
    });

    it("R10-N1: the folded key keeps separate numbers apart (INV-12-3 is not INV-123)", async () => {
      const { billKeys } = await import("@/lib/engine/bills");
      const folded = (r: string) => [...billKeys(r)].filter((k) => k.startsWith("="));
      expect(folded("INV-12-3")).not.toEqual(folded("INV-123"));
      expect(folded("ROSA-NOV")).toEqual(folded("rosa_nov"));
    });

    // ---- Last pass before merge.
    const payTo = (payee: string, reference: string, amount = "50") => ({ payee, amount, currency: "USD", reference, description: `${payee}, guiding, USD ${amount}, invoice ${reference}.`, evidence: [{ kind: "job_sheet", label: `Trip sheet ${reference}`, amount, reference, excerpt: `Guide: ${payee}. Total USD ${amount}.` }] });

    it("another supplier's bill: a request to Maria naming Rosa's bill is blocked, reads neutral, and stays blocked after Rosa's bill was paid", async () => {
      await autopilot();
      const bill = personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(payTo("Maria Santos", "INV-ROSA-6001"), "fin-sib-000001", "l");
      const id = r.json.id as string;
      expect(ob(id).vendorId).toBe("ven_maria");
      expect(ob(id).state).toBe("blocked");
      expect(inside(id).rules.find((x) => x.ruleId === "bill_other_supplier")?.message).toBe("Reference INV-ROSA-6001 names bill INV-ROSA-6001 of supplier Rosa Villanueva; a person checks who this pays");
      expect(() => approveObligation(getDb(), id, "user:minh", "ok", ackAll(id))).toThrow();
      neutral((await getRequest(id, "l")).json);
      // Rosa is paid on her bill; the same request to Maria is still blocked.
      const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
      const rosa = await payBill(getDb(), DEMO_BUSINESS_ID, lan, bill, 10_000);
      approveObligation(getDb(), rosa, "user:minh", "ok", inside(rosa).rules.filter((x) => x.severity === "warn" && !x.passed).map((x) => `${x.ruleId}|${x.key ?? x.message}`));
      await executeObligation(getDb(), rosa, { actor: "user:minh" });
      expect(["sent", "settled", "execution_pending"]).toContain(ob(rosa).state);
      const again = await postRequest(payTo("Maria Santos", "INV_ROSA_6001"), "fin-sib-000002", "l");
      expect(ob(again.json.id).state).toBe("blocked");
      expect(insideRules(again.json.id)).toContain("bill_other_supplier");
      neutral(again.json);
    });

    it("reference spread: after 10 different references for one supplier in 10 minutes, the key's next request waits for a person", async () => {
      await autopilot();
      for (let i = 0; i < 10; i++) {
        const r = await postRequest(pay(`TRIP-ROSA-${String(7100 + i)}`, "20"), `fin-spr-${String(i).padStart(6, "0")}`, "l");
        expect(insideRules(r.json.id), `request ${i + 1}`).not.toContain("reference_spread");
      }
      const next = await postRequest(pay("TRIP-ROSA-7199", "20"), "fin-spr-000099", "l");
      const id = next.json.id as string;
      expect(insideRules(id)).toContain("reference_spread");
      expect(ob(id).releaseAt).toBeNull();
      expect(next.json.status).not.toBe("scheduled");
      // Another key is not held by this one's spread.
      const other = await postRequest(pay("TRIP-ROSA-7299", "20"), "fin-spr-000100", "e");
      expect(insideRules(other.json.id)).not.toContain("reference_spread");
      // A person can approve it.
      approveObligation(getDb(), id, "user:minh", "Checked", ackAll(id));
      expect(inside(id).rules.find((x) => x.ruleId === "reference_spread")).toBeTruthy();
      expect(inside(id).decision).not.toBe("block");
    });

    it("reference spread: an MCP agent's check_payment holds past the limit", async () => {
      await autopilot();
      const agentKey = { name: "spreader", scopes: ["check"] as AgentKey["scopes"], digest: Buffer.alloc(32) };
      for (let i = 0; i < 10; i++) expect((await checkPayment(getDb(), agentKey, pay(`TRIP-ROSA-${7300 + i}`, "20"))).warnings.map((w) => w.rule)).not.toContain("reference_spread");
      const c = await checkPayment(getDb(), agentKey, pay("TRIP-ROSA-7399", "20"));
      expect(c.verdict).toBe("hold");
      expect(c.warnings.map((w) => w.rule)).toContain("reference_spread");
    });

    it("an outside request the rules approved before a bill held it reads pending and Waiting to be sent, not approved by a person", async () => {
      await autopilot();
      const agentKey = { name: "bookings", scopes: ["check", "request", "attest"] as AgentKey["scopes"], digest: Buffer.alloc(32) };
      const sent = await requestPayment(getDb(), agentKey, { ...pay("TRIP-ROSA-7401", "20"), idempotency_key: "fin-pend-00001" });
      const rest = await postRequest(pay("TRIP-ROSA-7402", "20"), "fin-pend-00002", "l");
      // The agent's request as the rules leave one they pre-approve: approved, scheduled, no person involved.
      for (const id of [sent.request_id, rest.json.id as string]) getDb().update(obligations).set({ state: "approved", releaseAt: new Date(Date.now() + 3_600_000).toISOString() }).where(eq(obligations.id, id)).run();
      personBill("INV-ROSA-6001", 10_000);
      expect(paymentStatus(getDb(), agentKey, { request_id: sent.request_id })).toMatchObject({ status: "approved", summary: "Waiting to be sent.", releases_at: null });
      expect(seen((await getRequest(rest.json.id as string, "l")).json)).toMatchObject({ status: "approved", verdict: "pending", reasons: [NEUTRAL], rail: null, releases_at: null });
    });

    it("rail stays null while a bill request is in flight", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("INV-ROSA-6001", "50"), "fin-rail-00001", "l");
      const id = r.json.id as string;
      approveObligation(getDb(), id, "user:minh", "ok", ackAll(id));
      await executeObligation(getDb(), id, { actor: "user:minh" });
      getDb().update(obligations).set({ state: "sent" }).where(eq(obligations.id, id)).run();
      expect(seen((await getRequest(id, "l")).json)).toMatchObject({ status: "sending", rail: null });
    });

    it("a bare bill_review acknowledgement no longer covers a bill warning", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("INV-ROSA-6001", "50"), "fin-bare-00001", "l");
      expect(() => approveObligation(getDb(), r.json.id as string, "user:minh", "ok", ["bill_review"])).toThrow(/Something changed/);
      expect(ob(r.json.id).state).toBe("awaiting_approval");
    });

    it("the ERP key, without attest, reads the same neutral answer and no other part's state", async () => {
      await autopilot();
      const bill = personBill("INV-ROSA-6001", 50_000);
      const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
      const theirs = await payBill(getDb(), DEMO_BUSINESS_ID, lan, bill, 19_000);
      approveObligation(getDb(), theirs, "user:minh", "ok", inside(theirs).rules.filter((r) => r.severity === "warn" && !r.passed).map((r) => `${r.ruleId}|${r.key ?? r.message}`));
      const mine = await postRequest(pay("INV-ROSA-6001", "190"), "r8-erp-000001");
      neutral(mine.json);
      const listed = JSON.stringify((await listRequests("?reference=INV-ROSA-6001")).json);
      // "settled_at" is a field name of this request's own settlement, not another part's state.
      expect(listed.match(/.{0,60}(?:approved|settled(?!_at)|scheduled|blocked).{0,30}/)?.[0]).toBeUndefined();
    });

    it("S2: a key without requests:read gets only the id, the status and its own key back", async () => {
      vi.stubEnv("CHECKRAIL_API_KEYS", `${KEYS},writer:${S("w")}:requests:write`);
      const r = await postRequest(pay("INV-ROSA-8002", "45"), "r8-s2-0000001", "w");
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ id: expect.any(String), status: expect.any(String), idempotency_key: "r8-s2-0000001" });
    });

    it("an integration is not told how far an earlier payment got", async () => {
      // Maria Santos was paid for JOB-HG4D-0914.
      const r = await postRequest({ payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" }, "r8-n1-0000001");
      expect(r.json.rules_failed).toContain("no_duplicate");
      expect((r.json.reasons as string[]).join(" ")).not.toMatch(/settled|approved|scheduled|\((?:sent|disputed)\)/i);
    });

    it("the list is capped at 25 and its rows carry no reasons", async () => {
      expect((await listRequests("?limit=26")).status).toBe(422);
      await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7601" }, "r8-list-00001");
      const rows = (await listRequests("?limit=25")).json.requests as Array<{ reasons: unknown[]; rules_failed: unknown[]; status: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.reasons.length === 0 && r.rules_failed.length === 0 && typeof r.status === "string")).toBe(true);
    });

    it("a departure can be changed only by the key that sent it, and conflicts quote no other external id", async () => {
      vi.stubEnv("CHECKRAIL_API_KEYS", `${KEYS},bokun2:${S("b2")}:departures:write`);
      expect((await postDepartures({ departures: [dep("bokun-6001", "CB-3D-6001", [phuongVan(3)])] })).status).toBe(200);
      const other = await postDepartures({ departures: [dep("bokun-6001", "CB-3D-6001", [phuongVan(30)])] }, "b2");
      expect(other.status).toBe(409);
      expect(other.json.error?.message).toMatch(/another API key/);
      const clash = await postDepartures({ departures: [dep("bokun-6002", "CB-3D-6001", [])] }, "b2");
      expect(clash.status).toBe(409);
      expect(clash.json.error?.message).not.toMatch(/bokun-6001/);
    });

    it("a key reads back only the departures it sent", async () => {
      vi.stubEnv("CHECKRAIL_API_KEYS", `${KEYS},bokun2:${S("b2")}:departures:write`);
      await postDepartures({ departures: [dep("bokun-7001", "CB-3D-7001", [])] });
      await postDepartures({ departures: [dep("other-7002", "CB-3D-7002", [])] }, "b2");
      const mine = ((await getDepartures()).json.departures as Array<{ code: string }>).map((d) => d.code);
      expect(mine).toEqual(["CB-3D-7001"]);
    });
  });

  it("nit: a retry whose stored answer is gone must match the description and evidence too", async () => {
    const first = await postRequest(job, "r3-nit-000001");
    expect(first.status).toBe(201);
    getDb().delete(apiIdempotency).run();
    const other = await postRequest({ ...job, description: "Something else entirely" }, "r3-nit-000001");
    expect(other.status).toBe(422);
    expect(other.json.error?.code).toBe("idempotency_conflict");
    expect((await postRequest({ ...job, evidence: [] }, "r3-nit-000001")).status).toBe(422);
    expect((await postRequest(job, "r3-nit-000001")).json.id).toBe(first.json.id);
  });
});

describe("supplier lookup", () => {
  it("finds suppliers by part of the name, accents and case aside, with verified yes or no and nothing more", async () => {
    getDb().update(vendors).set({ verifiedAt: null }).where(eq(vendors.id, "ven_rosa")).run();
    const r = await searchVendors("?q=MARIA");
    expect(r.json.vendors).toEqual([{ id: "ven_maria", name: "Maria Santos", role: "guide", country: "PH", status: "active", verified: true }]);
    expect(((await searchVendors("?q=villanueva")).json.vendors as Array<{ verified: boolean }>)[0].verified).toBe(false);
    expect(((await searchVendors("?q=Phương")).json.vendors as Array<{ id: string }>).map((v) => v.id)).toEqual(["ven_phuong"]);
    const all = (await searchVendors("?limit=100")).json.vendors as Array<Record<string, unknown>>;
    expect(all.length).toBe(getDb().select().from(vendors).all().length);
    expect(all.every((v) => Object.keys(v).sort().join() === "country,id,name,role,status,verified")).toBe(true);
  });
});

describe("what the API can never do", () => {
  it("move money or change payout details, whatever it is sent", async () => {
    const db = getDb();
    setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
    const payouts = () => db.select({ id: vendors.id, p: vendors.paypalEmail, s: vendors.stellarAccount, b: vendors.bankLabel, e: vendors.bankAccountEnc, h: vendors.detailsHash, v: vendors.verifiedAt }).from(vendors).all();
    const before = payouts();
    const attempts = db.select().from(paymentAttempts).all().length;
    const settled = db.select().from(settlements).all().length;

    await postDepartures({ departures: [dep("bokun-2001", "CB-3D-2001", [phuongVan(3)])] });
    const ok = await postRequest({ payee: "Phuong Transport", amount: "600", currency: "USD", reference: "CB-3D-2001", evidence: [{ kind: "job_sheet", label: "Trip sheet CB-3D-2001", amount: "600", reference: "CB-3D-2001", excerpt: "Phuong Transport, CB-3D-2001, 3 vehicle-days, USD 600." }] }, undefined, "l");
    expect(ok.status).toBe(201);
    // Whatever the rules say, the request is at most scheduled for Autopilot: nothing was sent by the call.
    expect(["paid", "sending"]).not.toContain(ok.json.status);
    expect((ok.json.settlement as { status: string }).status).toBe("not_sent");

    for (const hopeful of [{ approve: true }, { paypal_email: "attacker@example.net" }, { state: "approved" }, { release_at: "2026-01-01T00:00:00Z" }]) {
      const r = await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", ...hopeful });
      expect(r.status, JSON.stringify(hopeful)).toBe(422);
    }
    const vendorWrite = await postDepartures({ departures: [{ ...dep("bokun-2002", "CB-3D-2002", [{ ...phuongVan(1), paypal_email: "attacker@example.net" }]) }] });
    expect(vendorWrite.status).toBe(422);

    expect(db.select().from(paymentAttempts).all().length).toBe(attempts);
    expect(db.select().from(settlements).all().length).toBe(settled);
    expect(payouts()).toEqual(before);
    // No route offers a method that could change anything else.
    for (const mod of [departuresRoute, requestsRoute, requestRoute, vendorsRoute, openapiRoute] as Array<Record<string, unknown>>) {
      for (const m of ["PUT", "PATCH", "DELETE"]) expect(mod[m]).toBeUndefined();
    }
  });
});

describe("the API description", () => {
  it("is served as JSON without a key", async () => {
    const r = await openapiRoute.GET();
    expect(r.status).toBe(200);
    const spec = (await r.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toContain("/requests/{id}");
  });
});
