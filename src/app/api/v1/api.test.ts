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
import { applyCredit, createBill, payBill } from "@/lib/engine/bills";
import { bills as billsTable } from "@/lib/db/schema";
import { approveObligation, previewPolicy, recheckObligation, retryFailed } from "@/lib/engine/orchestrator";
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
  // the middleware must run on them and strip any forged ones (review R1-1).
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

  it("M1: a bill a person recorded does not let the same job through twice", async () => {
    await autopilot();
    personBill("INV-ROSA-7777", 500_000);
    expect((await postRequest(job, "r3-bill-00001", "l")).json.status).toBe("scheduled");
    const second = await postRequest(job, "r3-bill-00002", "l");
    // Round 4: held for a person, never scheduled by Autopilot.
    expect(second.json.status).toBe("waiting_for_approval");
    expect(second.json.rules_failed).toContain("bill_part_repeat");
    expect((second.json.reasons as string[])[0]).toBe("This bill already has another part; a person confirms this is a separate payment.");
  });

  it("M1: a second 'remaining balance' that is not what is open is an ordinary part, and held", async () => {
    await autopilot();
    personBill("INV-ROSA-7777", 500_000);
    const balance = { ...job, description: "Please pay the remaining balance USD 190 to Rosa Villanueva on invoice INV-ROSA-7777, 2 days guiding at USD 95." };
    const first = await postRequest(balance, "r3-bal2-00001", "l");
    const second = await postRequest(balance, "r3-bal2-00002", "l");
    const linked = getDb().select({ id: obligations.id, billId: obligations.billId, kind: obligations.paymentKind }).from(obligations).all().filter((o) => o.id === first.json.id || o.id === second.json.id);
    expect(linked.every((o) => o.billId && o.kind === "part")).toBe(true);
    expect(["scheduled", "approved"]).not.toContain(second.json.status);
    expect(second.json.rules_failed).toContain("bill_part_repeat");
  });

  it("M1: from a key without attest, it is held because the bill has another part", async () => {
    await autopilot();
    personBill("INV-ROSA-7777", 500_000);
    await postRequest(job, "r3-plain-0001");
    const second = await postRequest(job, "r3-plain-0002");
    expect(["scheduled", "approved"]).not.toContain(second.json.status);
    expect(second.json.rules_failed).toContain("bill_part_repeat");
    expect((second.json.reasons as string[]).join(" ")).toMatch(/already has another part/);
  });

  // The ledger key's own purchase order: a record of the business, so Autopilot may pay against it.
  const invoice8800 = [{ kind: "purchase_order", label: "Purchase order INV-ROSA-8800", amount: "380", reference: "INV-ROSA-8800", excerpt: "Rosa Villanueva. Guiding, 4 days. Total USD 380.00. 50% deposit, balance after the trip." }];
  const deposit8800 = { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-8800", description: "50% deposit USD 190 for Rosa Villanueva on invoice INV-ROSA-8800, total USD 380.", evidence: invoice8800 };
  const balance8800 = { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-8800", description: "Balance USD 190 for Rosa Villanueva after the deposit, invoice INV-ROSA-8800, total USD 380.", evidence: invoice8800 };

  it("R5: an outside balance while the deposit is only scheduled by Autopilot waits for a person", async () => {
    await autopilot();
    personBill("INV-ROSA-8800", 38_000);
    const deposit = await postRequest(deposit8800, "r3-dep-000001", "l");
    expect(deposit.json.status).toBe("scheduled");
    const balance = await postRequest(balance8800, "r3-bal-000001", "l");
    expect(balance.json.rules_failed).not.toContain("no_duplicate");
    expect(balance.json.status).toBe("waiting_for_approval");
    expect(balance.json.rules_failed).toContain("bill_part_repeat");
  });

  it("R5: an outside deposit, then an outside exact balance with the deposit already paid, goes through", async () => {
    await autopilot();
    personBill("INV-ROSA-8800", 38_000);
    const deposit = await postRequest(deposit8800, "r5-dep-000001", "l");
    getDb().update(obligations).set({ state: "settled", releaseAt: null }).where(eq(obligations.id, deposit.json.id as string)).run();
    const balance = await postRequest(balance8800, "r5-bal-000001", "l");
    expect(balance.json.rules_failed).not.toContain("bill_part_repeat");
    expect(balance.json.status).toBe("scheduled");
  });

  describe("round 6: an outside request naming a bill stays on it, and is blocked when it does not fit", () => {
    const pay = (amount: string, currency = "USD", reference = "INV-ROSA-6001") => ({ payee: "Rosa Villanueva", amount, currency, reference, description: `Rosa Villanueva, guiding, ${currency} ${amount}, invoice ${reference}.`, evidence: [{ kind: "job_sheet", label: `Trip sheet ${reference}`, amount, reference, excerpt: `Guide: Rosa Villanueva. Total ${currency} ${amount}.` }] });
    const billOf = (id: unknown) => getDb().select().from(obligations).where(eq(obligations.id, id as string)).get()!.billId;

    it("USD 150 on an empty USD 100 bill is blocked, still on the bill", async () => {
      await autopilot();
      const bill = personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("150"), "r6-over-00001", "l");
      expect(r.json.status).toBe("blocked");
      expect(r.json.rules_failed).toContain("bill_misfit");
      expect(billOf(r.json.id)).toBe(bill);
    });

    it("USD 100 on a USD 100 bill with USD 60 of credit is blocked", async () => {
      await autopilot();
      const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
      const bill = personBill("INV-ROSA-6001", 10_000);
      const credit = createBill(getDb(), DEMO_BUSINESS_ID, lan, "ven_rosa", { kind: "credit_note", reference: "CN-ROSA-6001", totalMinor: 6_000, currency: "USD", billDate: null, dueDate: null, note: null });
      applyCredit(getDb(), DEMO_BUSINESS_ID, lan, credit, bill, 6_000);
      const r = await postRequest(pay("100"), "r6-cred-00001", "l");
      expect(r.json.status).toBe("blocked");
      expect(billOf(r.json.id)).toBe(bill);
    });

    it("PHP 5,000 on a USD bill is blocked", async () => {
      await autopilot();
      const bill = personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest(pay("5000", "PHP"), "r6-cur-000001", "l");
      expect(r.json.status).toBe("blocked");
      expect(billOf(r.json.id)).toBe(bill);
    });

    it("a closed or void bill blocks it too", async () => {
      await autopilot();
      const bill = personBill("INV-ROSA-6001", 10_000);
      getDb().update(billsTable).set({ status: "void" }).where(eq(billsTable.id, bill)).run();
      const r = await postRequest(pay("50"), "r6-void-00001", "l");
      expect(r.json.status).toBe("blocked");
      expect(billOf(r.json.id)).toBe(bill);
    });

    it("an outside deposit over what is open does not crash into the bill, and no exception text reaches the key", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      const r = await postRequest({ ...pay("150"), description: "50% deposit USD 150 for Rosa Villanueva on invoice INV-ROSA-6001, total USD 300." }, "r6-dep-000001", "l");
      expect(r.status).toBe(201);
      expect(r.json.status).toBe("blocked");
      expect(JSON.stringify(r.json)).not.toMatch(/already has a|Error|exception/i);
    });

    it("a request that fits is unchanged", async () => {
      await autopilot();
      personBill("INV-ROSA-6001", 10_000);
      expect((await postRequest(pay("100"), "r6-fit-000001", "l")).json.status).toBe("scheduled");
    });

    it("the list is capped at 25 and its rows carry no reasons", async () => {
      expect((await listRequests("?limit=26")).status).toBe(422);
      await postRequest({ payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7601" }, "r6-list-00001");
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
  });

  describe("round 5: an outside part of a bill that has another part never pays without a person", () => {
    const part = (amount: string, description = `Rosa Villanueva, guiding, USD ${amount}, invoice INV-ROSA-7777.`) => ({ payee: "Rosa Villanueva", amount, currency: "USD", reference: "INV-ROSA-7777", description, evidence: [{ kind: "job_sheet", label: "Trip sheet INV-ROSA-7777", amount, reference: "INV-ROSA-7777", excerpt: `Guide: Rosa Villanueva. Total USD ${amount}.` }] });
    const state = (id: unknown) => getDb().select().from(obligations).where(eq(obligations.id, id as string)).get()!.state;

    it("190 then 191, naming only the bill's reference", async () => {
      await autopilot();
      personBill("INV-ROSA-7777", 500_000);
      expect((await postRequest(part("190"), "r5-a-0000001", "l")).json.status).toBe("scheduled");
      const second = await postRequest(part("191"), "r5-b-0000001", "l");
      expect(second.json.status).toBe("waiting_for_approval");
      expect(second.json.rules_failed).toContain("bill_part_repeat");
    });

    it("the decoy-shrink: 190 scheduled, a 190 decoy held, then a 'remaining balance' of 190 is held too", async () => {
      await autopilot();
      personBill("INV-ROSA-7777", 57_000);
      expect((await postRequest(part("190"), "r5-ds-000001", "l")).json.status).toBe("scheduled");
      expect((await postRequest(part("190"), "r5-ds-000002", "l")).json.status).toBe("waiting_for_approval");
      const balance = await postRequest(part("190", "Please pay the remaining balance USD 190 to Rosa Villanueva on invoice INV-ROSA-7777."), "r5-ds-000003", "l");
      expect(balance.json.status).toBe("waiting_for_approval");
      expect(balance.json.rules_failed).toContain("bill_part_repeat");
    });

    it("fail, re-send, then retry part 1: neither is left to pay without a person", async () => {
      await autopilot();
      personBill("INV-ROSA-7777", 500_000);
      const first = await postRequest(part("190"), "r5-fr-000001", "l");
      getDb().update(obligations).set({ state: "failed", releaseAt: null }).where(eq(obligations.id, first.json.id as string)).run();
      const resent = await postRequest(part("190"), "r5-fr-000002", "l");
      expect(resent.json.status).toBe("waiting_for_approval");
      retryFailed(getDb(), first.json.id as string, "user:minh");
      expect(state(first.json.id)).toBe("awaiting_approval");
      expect(previewPolicy(getDb(), first.json.id as string).decision).toBe("require_approval");
    });

    it("blocked, then checked again once fixed: held, not scheduled", async () => {
      await autopilot();
      personBill("INV-ROSA-7777", 500_000);
      expect((await postRequest(part("190"), "r5-bl-000001", "l")).json.status).toBe("scheduled");
      const verifiedAt = getDb().select().from(vendors).where(eq(vendors.id, "ven_rosa")).get()!.verifiedAt;
      getDb().update(vendors).set({ verifiedAt: null }).where(eq(vendors.id, "ven_rosa")).run();
      const second = await postRequest(part("191"), "r5-bl-000002", "l");
      expect(second.json.status).toBe("blocked");
      getDb().update(vendors).set({ verifiedAt }).where(eq(vendors.id, "ven_rosa")).run();
      await recheckObligation(getDb(), second.json.id as string, "user:minh");
      expect(state(second.json.id)).toBe("awaiting_approval");
    });

    it("an approval given before another part arrived does not count, and the scheduled part is not released", async () => {
      await autopilot();
      personBill("INV-ROSA-7777", 500_000);
      const first = await postRequest(part("190"), "r5-ap-000001");
      expect(first.json.status).toBe("waiting_for_approval");
      approveObligation(getDb(), first.json.id as string, "user:minh", "Checked the trip sheet", previewPolicy(getDb(), first.json.id as string).rules.filter((r) => r.severity === "warn" && !r.passed).map((r) => `${r.ruleId}|${r.key ?? r.message}`));
      await postRequest(part("250"), "r5-ap-000002");
      expect(previewPolicy(getDb(), first.json.id as string).decision).toBe("require_approval");
      expect(previewPolicy(getDb(), first.json.id as string).rules.some((r) => r.ruleId === "bill_part_repeat" && r.severity === "warn")).toBe(true);
    });

    it("M3: the ERP key never sees another part's state or date, in any line", async () => {
      await autopilot();
      const bill = personBill("INV-ROSA-7777", 500_000);
      const lan = resolveActor(getDb(), DEMO_BUSINESS_ID, "lan", "clerk");
      const theirs = await payBill(getDb(), DEMO_BUSINESS_ID, lan, bill, 19_000);
      approveObligation(getDb(), theirs, "user:minh", "ok", previewPolicy(getDb(), theirs).rules.filter((r) => r.severity === "warn" && !r.passed).map((r) => `${r.ruleId}|${r.key ?? r.message}`));
      const mine = await postRequest(part("190"), "r5-m3-000001");
      // Everything but this request's own state, status and settlement.
      const own = ({ state: _s, status: _t, settlement: _p, ...rest }: Json) => (void _s, void _t, void _p, rest);
      const listed = ((await listRequests("?reference=INV-ROSA-7777")).json.requests as Json[]).map(own);
      const read = JSON.stringify([own(mine.json), own((await getRequest(mine.json.id as string)).json), listed]);
      const leak = read.match(/.{0,60}(?:approved|settled|scheduled|awaiting|in flight|disputed|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\d{4}-\d{2}-\d{2}(?!T)).{0,20}/);
      expect(leak?.[0]).toBeUndefined();
      expect(mine.json.rules_failed).toContain("bill_part_repeat");
    });

    it("S2: a key without requests:read gets only the id, the status and its own key back", async () => {
      vi.stubEnv("CHECKRAIL_API_KEYS", `${KEYS},writer:${S("w")}:requests:write`);
      const r = await postRequest(part("190"), "r5-s2-000001", "w");
      expect(r.status).toBe(201);
      expect(r.json).toEqual({ id: expect.any(String), status: expect.any(String), idempotency_key: "r5-s2-000001" });
    });
  });

  describe("round 4: the same job on a bill from an attest key is never paid twice by Autopilot", () => {
    // The trip sheet names the job (departure CEB-2D-1101) in its own words, beyond the bill's reference.
    const sheet = (amount: string, excerpt: string) => ({ ...job, amount, evidence: [{ kind: "job_sheet", label: "Trip sheet INV-ROSA-7777", amount, reference: "INV-ROSA-7777", excerpt: `Departure CEB-2D-1101. ${excerpt}` }] });
    const twice = async (a: object, b: object) => {
      await autopilot();
      personBill("INV-ROSA-7777", 500_000);
      const first = await postRequest(a, "r4-first-00001", "l");
      const second = await postRequest(b, "r4-second-0001", "l");
      return { first, second };
    };

    it("a reworded excerpt", async () => {
      const { first, second } = await twice(sheet("190", "Guide: Rosa Villanueva. 2 days at USD 95. Total USD 190.00."), sheet("190", "Rosa V., guiding two days, USD 190 in total."));
      expect(first.json.status).toBe("scheduled");
      expect(second.json.status).toBe("waiting_for_approval");
      expect(second.json.rules_failed).toContain("bill_part_repeat");
    });

    it("an amended amount, 190 then 195, for the same trip sheet", async () => {
      const { second } = await twice(sheet("190", "Guide: Rosa Villanueva. 2 days at USD 95. Total USD 190.00."), { ...sheet("195", "Guide: Rosa Villanueva. 2 days at USD 95, plus USD 5 parking. Total USD 195.00."), description: "Rosa Villanueva, 2 days guiding, USD 195 with parking, INV-ROSA-7777." });
      expect(second.json.status).toBe("waiting_for_approval");
      expect(second.json.rules_failed).toContain("bill_part_repeat");
    });

    it("a repeat relabelled deposit, then balance", async () => {
      const { second } = await twice(
        { ...job, description: "50% deposit USD 190 for Rosa Villanueva on invoice INV-ROSA-7777, total USD 380." },
        { ...job, description: "Please pay the remaining balance USD 190 to Rosa Villanueva on invoice INV-ROSA-7777." },
      );
      expect(second.json.status).toBe("waiting_for_approval");
      expect(second.json.rules_failed).toContain("bill_part_repeat");
    });

    it("N1: an integration is not told how far an earlier payment got", async () => {
      // Maria Santos was paid for JOB-HG4D-0914.
      const r = await postRequest({ payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" }, "r4-n1-0000001");
      expect(r.json.rules_failed).toContain("no_duplicate");
      expect((r.json.reasons as string[]).join(" ")).not.toMatch(/settled|approved|scheduled|\((?:sent|disputed)\)/i);
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
