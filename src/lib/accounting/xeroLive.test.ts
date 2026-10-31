import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { accountingSyncs, obligations, settlements, xeroConnections, xeroOauthStates, xeroRecords } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "../engine/orchestrator";
import { config } from "../config";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "../basicAuth";
import { decryptField } from "../crypto/dataKey";
import { beginXeroConnect, xeroAccessToken, DEFAULT_XERO_SCOPES } from "./xeroAuth";
import { resetXeroRateWindow } from "./xeroClient";
import { runXeroSync } from "./xeroSync";
import { xeroCardView } from "./xeroSettings";
import { xeroBillRows } from "./xeroBills";
import { handleXeroAccounts, handleXeroCallback, handleXeroConnect, handleXeroDisconnect, handleXeroMapping, handleXeroPush } from "./xeroRoutes";

/**
 * The live Xero connection against a fake Xero (a fetch stub): no network. It plays Xero's identity server (token
 * exchange, refresh rotation), the connections endpoint and the Accounting API (contacts, invoices, payments, bank
 * transactions, settings), and honours the Idempotency-Key header the way Xero does.
 */

// Each test seeds a fresh demo database; on a busy machine that can pass the 5 second default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const acc = config.accounting as unknown as { destination: string; xero: { clientId: string; clientSecret: string } };
const saved = { destination: acc.destination, clientId: acc.xero.clientId, clientSecret: acc.xero.clientSecret };

const TENANT = "tenant-ridgeline-demo";
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

type Call = { method: string; url: URL; headers: Headers; body: string };
type Injection = { when: (c: Call) => boolean; times: number; respond: (c: Call) => Response | "network" | "network_after" };

function fakeXero() {
  let n = 1;
  const state = {
    access: jwt({ authentication_event_id: "evt-1", n: 1 }),
    refresh: "rt-1",
    contacts: [{ ContactID: "c-maria", Name: "Maria Santos" }] as Array<{ ContactID: string; Name: string }>,
    invoices: [] as Array<Record<string, unknown>>,
    payments: [] as Array<Record<string, unknown>>,
    bankTx: [] as Array<Record<string, unknown>>,
    creditNotes: [] as Array<Record<string, unknown>>,
    deletedConnections: [] as string[],
    revokedAccess: new Set<string>(),
    idem: new Map<string, { status: number; body: unknown }>(),
    currencies: ["USD"],
  };
  const calls: Call[] = [];
  const injections: Injection[] = [];
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  async function handle(c: Call): Promise<Response> {
    const p = c.url.pathname;
    if (c.url.host === "identity.xero.com" && p === "/connect/token") {
      if (c.headers.get("authorization") !== `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`) return res(401, { error: "invalid_client" });
      const form = new URLSearchParams(c.body);
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code" || form.get("redirect_uri") !== "http://localhost:3000/api/xero/callback") return res(400, { error: "invalid_grant" });
        return res(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 1800, token_type: "Bearer", scope: DEFAULT_XERO_SCOPES });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== state.refresh) return res(400, { error: "invalid_grant" });
        n++;
        state.access = jwt({ authentication_event_id: "evt-1", n });
        state.refresh = `rt-${n}`;
        return res(200, { access_token: state.access, refresh_token: state.refresh, expires_in: 1800, token_type: "Bearer" });
      }
      return res(400, { error: "unsupported_grant_type" });
    }
    const bearer = c.headers.get("authorization")?.replace(/^Bearer /, "");
    if (bearer !== state.access || state.revokedAccess.has(bearer)) return res(401, { Title: "Unauthorized" });
    if (c.url.host === "api.xero.com" && p === "/connections") {
      return res(200, [
        { id: "conn-old", authEventId: "evt-0", tenantId: "tenant-other", tenantType: "ORGANISATION", tenantName: "Some Other Org" },
        { id: "conn-1", authEventId: "evt-1", tenantId: TENANT, tenantType: "ORGANISATION", tenantName: "Demo Company (Global)" },
      ]);
    }
    if (c.url.host === "api.xero.com" && p.startsWith("/connections/") && c.method === "DELETE") {
      state.deletedConnections.push(p.split("/").pop()!);
      return res(204, null);
    }
    if (c.headers.get("xero-tenant-id") !== TENANT) return res(403, { Title: "Forbidden" });
    const api = p.replace("/api.xro/2.0", "");
    const key = c.headers.get("idempotency-key");
    if (key && state.idem.has(key)) {
      const hit = state.idem.get(key)!;
      return res(hit.status, hit.body);
    }
    const answer = route(c.method, api, c);
    if (key && c.method !== "GET") state.idem.set(key, { status: answer.status, body: answer.body });
    return res(answer.status, answer.body);
  }

  function route(method: string, api: string, c: Call): { status: number; body: unknown } {
    const where = c.url.searchParams.get("where") ?? "";
    const quoted = (field: string) => where.match(new RegExp(`${field}=="((?:[^"\\\\]|\\\\.)*)"`))?.[1]?.replace(/\\"/g, '"') ?? null;
    if (method === "GET" && api === "/Accounts")
      return {
        status: 200,
        body: {
          Accounts: [
            { Code: "090", Name: "PayPal clearing", Type: "BANK", Status: "ACTIVE", CurrencyCode: "USD" },
            { Code: "091", Name: "Stellar treasury", Type: "BANK", Status: "ACTIVE", CurrencyCode: "USD" },
            { Code: "092", Name: "Business bank account", Type: "BANK", Status: "ACTIVE", CurrencyCode: "USD" },
            { Code: "404", Name: "Bank Fees", Type: "EXPENSE", Status: "ACTIVE" },
            { Code: "429", Name: "General Expenses", Type: "EXPENSE", Status: "ACTIVE" },
            { Code: "400", Name: "Advertising", Type: "OVERHEADS", Status: "ACTIVE" },
            { Code: "620", Name: "Prepayments", Type: "PREPAYMENT", Status: "ACTIVE" },
            { Code: "825", Name: "Tax withheld", Type: "CURRLIAB", Status: "ACTIVE" },
            { Code: "999", Name: "Old account", Type: "EXPENSE", Status: "ARCHIVED" },
          ],
        },
      };
    if (method === "GET" && api === "/TaxRates") return { status: 200, body: { TaxRates: [{ TaxType: "INPUT", Name: "Tax on Purchases", Status: "ACTIVE", CanApplyToExpenses: true }, { TaxType: "NONE", Name: "Tax Exempt", Status: "ACTIVE", CanApplyToExpenses: true }] } };
    if (method === "GET" && api === "/Currencies") return { status: 200, body: { Currencies: state.currencies.map((Code) => ({ Code })) } };
    if (method === "GET" && api === "/Organisation") return { status: 200, body: { Organisations: [{ BaseCurrency: "USD" }] } };
    if (method === "GET" && api === "/TrackingCategories") return { status: 200, body: { TrackingCategories: [{ Name: "Departure", Status: "ACTIVE", Options: [{ Name: "HG-4D-0921", Status: "ACTIVE" }] }] } };
    if (method === "GET" && api === "/Contacts") {
      const name = quoted("Name");
      return { status: 200, body: { Contacts: state.contacts.filter((x) => x.Name === name) } };
    }
    if (method === "PUT" && api === "/Contacts") {
      const body = JSON.parse(c.body) as { Contacts: Array<{ Name: string }> };
      const made = { ContactID: `c-${state.contacts.length + 1}`, Name: body.Contacts[0].Name };
      state.contacts.push(made);
      return { status: 200, body: { Contacts: [made] } };
    }
    if (method === "GET" && api === "/Invoices") {
      const num = quoted("InvoiceNumber");
      return { status: 200, body: { Invoices: state.invoices.filter((i) => i.InvoiceNumber === num) } };
    }
    if (method === "PUT" && api === "/Invoices") {
      const body = JSON.parse(c.body) as { Invoices: Array<Record<string, unknown>> };
      const inv: Record<string, unknown> = { ...body.Invoices[0], InvoiceID: `inv-${state.invoices.length + 1}`, Status: "AUTHORISED" };
      if (!state.currencies.includes(String(inv.CurrencyCode))) return { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: `The currency ${inv.CurrencyCode} is not subscribed to.` }] }] } };
      state.invoices.push(inv);
      return { status: 200, body: { Invoices: [inv] } };
    }
    if (method === "PUT" && api === "/CreditNotes") {
      const body = JSON.parse(c.body) as { CreditNotes: Array<Record<string, unknown>> };
      const cn = { ...body.CreditNotes[0], CreditNoteID: `cn-${state.creditNotes.length + 1}` };
      state.creditNotes.push(cn);
      return { status: 200, body: { CreditNotes: [cn] } };
    }
    if (method === "GET" && api === "/Payments") return { status: 200, body: { Payments: state.payments.filter((x) => x.Reference === quoted("Reference")) } };
    if (method === "PUT" && api === "/Payments") {
      const body = JSON.parse(c.body) as { Payments: Array<Record<string, unknown>> };
      const pay = { ...body.Payments[0], PaymentID: `pay-${state.payments.length + 1}`, Status: "AUTHORISED" };
      state.payments.push(pay);
      return { status: 200, body: { Payments: [pay] } };
    }
    if (method === "GET" && api === "/BankTransactions") return { status: 200, body: { BankTransactions: state.bankTx.filter((x) => x.Reference === quoted("Reference")) } };
    if (method === "PUT" && api === "/BankTransactions") {
      const body = JSON.parse(c.body) as { BankTransactions: Array<Record<string, unknown>> };
      const tx = { ...body.BankTransactions[0], BankTransactionID: `bt-${state.bankTx.length + 1}` };
      state.bankTx.push(tx);
      return { status: 200, body: { BankTransactions: [tx] } };
    }
    return { status: 404, body: { Message: `no route ${method} ${api}` } };
  }

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!/(^|\.)xero\.com$/.test(url.host)) throw new Error(`unexpected network call to ${url.host}`);
    const c: Call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
    calls.push(c);
    const inj = injections.find((i) => i.times > 0 && i.when(c));
    if (inj) {
      inj.times--;
      const r = inj.respond(c);
      if (r === "network") throw new TypeError("fetch failed");
      if (r === "network_after") {
        await handle(c); // Xero did it; the answer was lost on the way back.
        throw new TypeError("fetch failed");
      }
      return r;
    }
    return handle(c);
  });

  const api = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === `/api.xro/2.0${path}`);
  return { state, calls, injections, fetch, api, res };
}

let db: Db;
let xero: ReturnType<typeof fakeXero>;
let story: { paypal: string; stellar: string; blockedDuplicate: string };

const req = (method: string, path: string, who: { user?: string; role?: string; persona?: string } | null, body?: unknown, contentType = "application/json") => {
  const headers: Record<string, string> = {};
  if (who?.user) headers[ACTOR_HEADER] = who.user;
  if (who?.role) headers[ROLE_HEADER] = who.role;
  if (who?.persona) headers[PERSONA_HEADER] = who.persona;
  if (body !== undefined) headers["content-type"] = contentType;
  return new Request(`http://localhost:3000${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
};
const OWNER = { user: "daniel", role: "admin" };
const CLERK = { user: "lan", role: "clerk" };
const APPROVER = { user: "minh", role: "approver" };
const ACCOUNTANT = { user: "thu", role: "accountant" };

/** Connect the way a person does: Connect (state), then Xero's redirect back with the code. */
async function connect(): Promise<void> {
  const start = handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const back = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${state}`, OWNER), db);
  expect(back.headers.get("location")).toContain("xero=connected");
}

async function settle(id: string) {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
  if (ob.state === "awaiting_approval") approveObligation(db, id, "user:minh");
  await executeObligation(db, id, { actor: "user:minh" });
  await confirmSettlement(db, id);
}

const conn = () => db.select().from(xeroConnections).where(eq(xeroConnections.businessId, DEMO_BUSINESS_ID)).get();
const records = (kind?: string) => db.select().from(xeroRecords).all().filter((r) => !kind || r.kind === kind);

beforeEach(async () => {
  acc.destination = "xero";
  acc.xero.clientId = "test-client-id";
  acc.xero.clientSecret = "test-client-secret";
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  delete process.env.XERO_SCOPES;
  resetXeroRateWindow();
  xero = fakeXero();
  vi.stubGlobal("fetch", xero.fetch);
  db = openTestDb();
  ({ story } = (await seedDemo(db, { history: false })) as { story: typeof story });
});
afterEach(() => {
  vi.unstubAllGlobals();
  acc.destination = saved.destination;
  acc.xero.clientId = saved.clientId;
  acc.xero.clientSecret = saved.clientSecret;
});

describe("OAuth: connect and callback", () => {
  it("sends the owner to Xero with granular scopes, a state and the redirect URI, then stores the tokens encrypted", async () => {
    const start = handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db);
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://login.xero.com/identity/connect/authorize");
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("client_id")).toBe("test-client-id");
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/xero/callback");
    const scopes = to.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(expect.arrayContaining(["offline_access", "accounting.invoices", "accounting.payments", "accounting.banktransactions", "accounting.contacts", "accounting.settings.read"]));
    expect(scopes).not.toContain("accounting.transactions");
    const state = to.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(40);
    // Only a hash of the state is kept.
    expect(JSON.stringify(db.select().from(xeroOauthStates).all())).not.toContain(state);

    const back = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${state}`, OWNER), db);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("http://localhost:3000/settings?xero=connected#xero");
    const c = conn()!;
    // The organisation picked in this sign-in (its auth event), not the first one listed.
    expect(c).toMatchObject({ tenantId: TENANT, tenantName: "Demo Company (Global)", connectionId: "conn-1", status: "connected" });
    expect(c.accessTokenEnc).not.toContain(xero.state.access);
    expect(c.refreshTokenEnc).not.toContain("rt-1");
    expect(decryptField(c.refreshTokenEnc)).toBe("rt-1");
    // The chart was read straight away and the mapping filled with first guesses.
    expect(c).toMatchObject({ paypalAccountCode: "090", stellarAccountCode: "091", bankAccountCode: "092", feeAccountCode: "404", expenseAccountCode: "429", taxType: "NONE" });
    // The state is single use.
    const replay = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${state}`, OWNER), db);
    expect(replay.headers.get("location")).toContain("xero=invalid_state");
  });

  it("uses NEXT_PUBLIC_SITE_URL, else RENDER_EXTERNAL_URL, for the redirect URI", () => {
    process.env.RENDER_EXTERNAL_URL = "https://checkrail.onrender.com";
    const a = new URL(handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db).headers.get("location")!);
    expect(a.searchParams.get("redirect_uri")).toBe("https://checkrail.onrender.com/api/xero/callback");
    process.env.NEXT_PUBLIC_SITE_URL = "https://pay.example.com/";
    const b = new URL(handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db).headers.get("location")!);
    expect(b.searchParams.get("redirect_uri")).toBe("https://pay.example.com/api/xero/callback");
  });

  it("refuses a wrong state, an expired state and another login's state, without exchanging the code", async () => {
    const wrong = await handleXeroCallback(req("GET", "/api/xero/callback?code=good-code&state=not-a-state", OWNER), db);
    expect(wrong.headers.get("location")).toContain("xero=invalid_state");
    const missing = await handleXeroCallback(req("GET", "/api/xero/callback?code=good-code", OWNER), db);
    expect(missing.headers.get("location")).toContain("xero=invalid_state");

    const old = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "daniel", actor: "user:daniel", nowMs: Date.now() - 11 * 60_000 });
    const expired = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${old.state}`, OWNER), db);
    expect(expired.headers.get("location")).toContain("xero=expired");

    // Started by one owner login, finished by another owner login.
    const theirs = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "owner2", actor: "user:owner2" });
    const other = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${theirs.state}`, OWNER), db);
    expect(other.headers.get("location")).toContain("xero=invalid_state");

    expect(xero.calls.filter((c) => c.url.host === "identity.xero.com")).toHaveLength(0);
    expect(conn()).toBeUndefined();
  });

  it("binds the state to the real login behind a demo persona", async () => {
    const start = handleXeroConnect(req("GET", "/api/xero/connect", { user: "daniel", role: "admin", persona: "judge" }), db);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const asOther = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${state}`, OWNER), db);
    expect(asOther.headers.get("location")).toContain("xero=invalid_state");
  });

  it("says plainly when the owner did not allow access, and when the code is refused", async () => {
    const s1 = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "daniel", actor: "user:daniel" }).state;
    const denied = await handleXeroCallback(req("GET", `/api/xero/callback?error=access_denied&state=${s1}`, OWNER), db);
    expect(denied.headers.get("location")).toContain("xero=denied");
    const s2 = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "daniel", actor: "user:daniel" }).state;
    const bad = await handleXeroCallback(req("GET", `/api/xero/callback?code=stale-code&state=${s2}`, OWNER), db);
    expect(bad.headers.get("location")).toContain("xero=failed");
    expect(conn()).toBeUndefined();
  });

  it("without XERO_CLIENT_ID the card explains the set-up instead of offering a broken button", () => {
    acc.xero.clientId = "";
    const r = handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db);
    expect(r.headers.get("location")).toContain("xero=not_configured");
    const v = xeroCardView(db, DEMO_BUSINESS_ID);
    expect(v).toMatchObject({ configured: false, connected: false, redirectUri: "http://localhost:3000/api/xero/callback" });
  });
});

describe("Tokens: refresh rotation and 401", () => {
  it("refreshes before expiry and stores the rotated refresh token every time", async () => {
    await connect();
    db.update(xeroConnections).set({ accessExpiresAt: new Date(Date.now() + 60_000).toISOString() }).run();
    const t1 = await xeroAccessToken(db, DEMO_BUSINESS_ID);
    expect(decryptField(conn()!.refreshTokenEnc)).toBe("rt-2");
    expect(t1).toBe(xero.state.access);
    db.update(xeroConnections).set({ accessExpiresAt: new Date(Date.now() - 1000).toISOString() }).run();
    await xeroAccessToken(db, DEMO_BUSINESS_ID);
    const refreshes = xero.calls.filter((c) => c.url.host === "identity.xero.com" && new URLSearchParams(c.body).get("grant_type") === "refresh_token");
    expect(refreshes.map((c) => new URLSearchParams(c.body).get("refresh_token"))).toEqual(["rt-1", "rt-2"]);
    expect(decryptField(conn()!.refreshTokenEnc)).toBe("rt-3");
    // A token still fresh is used as it is.
    const before = xero.calls.length;
    await xeroAccessToken(db, DEMO_BUSINESS_ID);
    expect(xero.calls.length).toBe(before);
  });

  it("on a 401 refreshes once and repeats the call once", async () => {
    await connect();
    xero.state.revokedAccess.add(xero.state.access);
    const r = await handleXeroAccounts(req("POST", "/api/xero/accounts", OWNER, {}), db);
    expect(r.status).toBe(200);
    const accounts = xero.api("GET", "/Accounts");
    expect(accounts).toHaveLength(3); // at connect, the 401, the repeat
    expect(decryptField(conn()!.refreshTokenEnc)).toBe("rt-2");
  });

  it("a refresh token Xero no longer accepts asks for a new connection, plainly", async () => {
    await connect();
    xero.state.refresh = "rt-rotated-elsewhere";
    db.update(xeroConnections).set({ accessExpiresAt: new Date(Date.now() - 1000).toISOString() }).run();
    await settle(story.paypal);
    const r = await runXeroSync(db);
    expect(r.errors[0]).toMatch(/Connect to Xero again/);
    expect(conn()!.status).toBe("needs_reconnect");
    expect(xeroCardView(db, DEMO_BUSINESS_ID).needsReconnect).toBe(true);
  });
});

describe("Push: bills at approval, payment and fee at settlement", () => {
  it("finds or creates contacts, sends the bill, the payment and the fee, and never sends them twice", async () => {
    await connect();
    const before = xero.calls.length;
    await settle(story.paypal);
    // Nothing on the payment path called Xero.
    expect(xero.calls.length).toBe(before);
    const sync = db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, story.paypal)).get()!;
    expect(sync).toMatchObject({ destination: "xero", status: "pending" });

    const r1 = await runXeroSync(db);
    expect(r1.failed).toBe(0);
    // Maria Santos is already a contact in Xero: found, not created. The fee's contact (PayPal) is created once.
    expect(xero.state.contacts.map((c) => c.Name)).toEqual(["Maria Santos", "PayPal"]);
    const bill = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-HG4D-0921")!;
    expect(bill).toMatchObject({ Type: "ACCPAY", Contact: { ContactID: "c-maria" }, CurrencyCode: "USD", Status: "AUTHORISED" });
    const line = (bill.LineItems as Array<Record<string, unknown>>)[0];
    // 310 is not in this chart: the chosen expense account takes it. The tracking option exists, so it is tagged.
    expect(line).toMatchObject({ UnitAmount: 180, AccountCode: "429", TaxType: "NONE", Tracking: [{ Name: "Departure", Option: "HG-4D-0921" }] });
    // The other agreed request (JOB-HG4D-0914) is a bill too, without a tracking option Xero does not have.
    const other = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-HG4D-0914")!;
    expect((other.LineItems as Array<Record<string, unknown>>)[0].Tracking).toBeUndefined();

    const pay = xero.state.payments[0];
    expect(pay).toMatchObject({ Invoice: { InvoiceID: bill.InvoiceID }, Account: { Code: "090" }, Amount: 180 });
    const fee = xero.state.bankTx[0];
    expect(fee).toMatchObject({ Type: "SPEND", BankAccount: { Code: "090" }, CurrencyCode: "USD" });
    const feeLine = (fee.LineItems as Array<Record<string, unknown>>)[0];
    expect(feeLine.AccountCode).toBe("404");
    expect(Number(pay.Amount) + Number(feeLine.UnitAmount)).toBeCloseTo(Number(JSON.parse(sync.payloadJson!).netPaid), 2);

    // Writes carry an Idempotency-Key.
    for (const c of xero.calls.filter((c) => c.method === "PUT")) expect(c.headers.get("idempotency-key")).toMatch(/^checkrail-xr_[0-9a-f]+-\d+$/);
    // The record is synced with Xero's id; the bills are stamped so the file never carries them again.
    expect(db.select().from(accountingSyncs).where(eq(accountingSyncs.id, sync.id)).get()).toMatchObject({ status: "synced", externalRef: `xero:${pay.PaymentID}` });
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.map((r) => r["*InvoiceNumber"])).not.toContain("JOB-HG4D-0921");
    expect(records("bill").every((r) => r.status === "pushed" && r.xeroId)).toBe(true);

    // Twice: nothing new is created.
    const r2 = await runXeroSync(db);
    expect(r2.pushed).toBe(0);
    expect(xero.state.invoices).toHaveLength(2);
    expect(xero.state.payments).toHaveLength(1);
    expect(xero.state.bankTx).toHaveLength(1);
    expect(xero.api("PUT", "/Contacts")).toHaveLength(1);
    expect(xeroCardView(db, DEMO_BUSINESS_ID)).toMatchObject({ connected: true, tenantName: "Demo Company (Global)", pushed: 4 });
  });

  it("Stellar: the bill and the payment of the gross, with no separate fee spend; a new contact is created", async () => {
    await connect();
    await settle(story.stellar);
    await runXeroSync(db);
    const bill = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-PAL3D-0927")!;
    expect(xero.state.contacts.find((c) => c.Name === "Ana Reyes")).toBeTruthy();
    expect(xero.state.payments.find((p) => (p.Invoice as { InvoiceID: string }).InvoiceID === bill.InvoiceID)).toMatchObject({ Amount: 750, Account: { Code: "091" } });
    expect(xero.state.bankTx).toHaveLength(0);
    const contactsGet = xero.api("GET", "/Contacts").filter((c) => c.url.searchParams.get("where") === 'Name=="Ana Reyes"');
    expect(contactsGet).toHaveLength(1);
  });

  it("a payment whose answer was lost is looked up, not created again", async () => {
    await connect();
    await settle(story.paypal);
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Payments"), times: 1, respond: () => "network_after" });
    const r1 = await runXeroSync(db);
    expect(r1.failed).toBe(1);
    const pay = records("payment")[0];
    expect(pay).toMatchObject({ status: "failed", uncertain: true });
    expect(pay.error).toMatch(/Could not reach Xero/);
    expect(xero.state.payments).toHaveLength(1); // Xero did make it
    await runXeroSync(db, { force: true });
    expect(xero.state.payments).toHaveLength(1);
    expect(records("payment")[0]).toMatchObject({ status: "pushed", xeroId: xero.state.payments[0].PaymentID });
    expect(xero.api("GET", "/Payments")).toHaveLength(1);
  });

  it("a repeated request with the same Idempotency-Key gets Xero's first answer, not a second bill", async () => {
    await connect();
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => "network_after" });
    await runXeroSync(db);
    const failed = records("bill").find((r) => r.status === "failed")!;
    expect(failed.uncertain).toBe(true);
    // Make the lookup find nothing, so the create is repeated: the same key returns the cached answer.
    xero.injections.push({ when: (c) => c.method === "GET" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => xero.res(200, { Invoices: [] }) });
    await runXeroSync(db, { force: true });
    const puts = xero.api("PUT", "/Invoices");
    const keys = puts.map((c) => c.headers.get("idempotency-key"));
    expect(new Set(keys).size).toBeLessThan(keys.length);
    expect(xero.state.invoices.filter((i) => i.InvoiceNumber === failed.label.split(" ")[1].replace(",", ""))).toHaveLength(1);
  });

  it("a failure is kept on the record in plain words and never touches the payment", async () => {
    await connect();
    await settle(story.paypal);
    const ob = db.select().from(obligations).where(eq(obligations.id, story.paypal)).get()!;
    const st = db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).get()!;
    xero.injections.push({
      when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Payments"),
      times: 1,
      respond: () => xero.res(400, { ErrorNumber: 10, Type: "ValidationException", Elements: [{ ValidationErrors: [{ Message: "Payment amount exceeds the amount outstanding on this document" }] }] }),
    });
    const r = await runXeroSync(db);
    expect(r.failed).toBe(1);
    const pay = records("payment")[0];
    expect(pay).toMatchObject({ status: "failed", uncertain: false, attempts: 1, keySeq: 1 });
    expect(pay.error).toBe("Xero said: Payment amount exceeds the amount outstanding on this document");
    expect(Date.parse(pay.nextAttemptAt!)).toBeGreaterThan(Date.now());
    // The payment is exactly as it was. Only the bill's "in Xero" stamp moved: its bill did go.
    const after = db.select().from(obligations).where(eq(obligations.id, story.paypal)).get()!;
    expect({ ...after, xeroBillExportedAt: null }).toEqual({ ...ob, xeroBillExportedAt: null });
    expect(after.state).toBe("settled");
    expect(db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).get()).toEqual(st);
    expect(db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, story.paypal)).get()!.status).toBe("pending");
    expect(xeroCardView(db, DEMO_BUSINESS_ID).failures[0]).toMatchObject({ label: "Payment JOB-HG4D-0921, Maria Santos", error: pay.error });

    // The next tick waits; the button tries now, with a new key.
    const putsBefore = xero.api("PUT", "/Payments").length;
    await runXeroSync(db);
    expect(xero.api("PUT", "/Payments").length).toBe(putsBefore);
    const push = await handleXeroPush(req("POST", "/api/xero/push", ACCOUNTANT, {}), db);
    expect(push.status).toBe(200);
    expect(records("payment")[0]).toMatchObject({ status: "pushed", error: null });
    const keys = xero.api("PUT", "/Payments").map((c) => c.headers.get("idempotency-key"));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("a currency the organisation lacks is said plainly, without sending the bill", async () => {
    await connect();
    const vnd = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Hoa don HS-1034 tu Linh Family Homestay: tong cong 9.000.000 VND.", evidence: [{ kind: "invoice", label: "Invoice HS-1034", amountMinor: 900_000_000, currency: "VND", reference: "HS-1034", excerpt: "Linh Family Homestay, VND 9,000,000" }], actor: "user:lan" });
    approveObligation(db, vnd, "user:minh");
    await runXeroSync(db);
    const rec = records("bill").find((r) => r.label.includes("HS-1034"))!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("Your Xero organisation does not have VND turned on. Add it in Xero (Accounting, Advanced, Currencies), then press Push to Xero.");
    expect(xero.api("PUT", "/Invoices").some((c) => c.body.includes("HS-1034"))).toBe(false);
    // Turned on in Xero (and the chart read again): the button sends it.
    xero.state.currencies.push("VND");
    await handleXeroAccounts(req("POST", "/api/xero/accounts", OWNER, {}), db);
    await runXeroSync(db, { force: true });
    expect(xero.state.invoices.find((i) => i.InvoiceNumber === "HS-1034")).toMatchObject({ CurrencyCode: "VND" });
  });

  it("a 429 stops the pass, keeps Retry-After, and sends nothing until then", async () => {
    await connect();
    await settle(story.paypal);
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => xero.res(429, { Title: "Too many requests" }, { "Retry-After": "30", "X-Rate-Limit-Problem": "minute" }) });
    const t0 = Date.now();
    const r1 = await runXeroSync(db, { now: () => t0 });
    expect(r1).toMatchObject({ rateLimited: true, failed: 0 });
    expect(r1.errors[0]).toMatch(/slow down.*30 seconds/);
    expect(Date.parse(conn()!.blockedUntil!)).toBe(t0 + 30_000);
    expect(records("bill").every((r) => r.status === "pending")).toBe(true);
    const n = xero.calls.length;
    const r2 = await runXeroSync(db, { now: () => t0 + 10_000 });
    expect(r2.rateLimited).toBe(true);
    expect(xero.calls.length).toBe(n);
    const r3 = await runXeroSync(db, { now: () => t0 + 31_000 });
    expect(r3.rateLimited).toBe(false);
    expect(xero.state.payments).toHaveLength(1);
  });

  it("keeps under 60 calls a minute on its own", async () => {
    await connect();
    const t0 = Date.now();
    // Many bills waiting: one minute's budget, then a pause, not a 429.
    for (let i = 0; i < 70; i++) {
      const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: `Invoice INV-RL-${1000 + i} from Dao Mountain Lodge. Room block, USD ${100 + i}.`, evidence: [{ kind: "invoice", label: `Invoice INV-RL-${1000 + i}`, amountMinor: (100 + i) * 100, currency: "USD", reference: `INV-RL-${1000 + i}`, excerpt: "Dao Mountain Lodge" }], actor: "user:lan" });
      try {
        approveObligation(db, id, "user:daniel");
      } catch {
        // Some may be held by the rules; the rest are enough.
      }
    }
    resetXeroRateWindow();
    for (let k = 0; k < 4; k++) await runXeroSync(db, { now: () => t0 + k * 1000 });
    const apiAtConnect = 5;
    const inMinute = xero.calls.filter((c) => c.url.pathname.startsWith("/api.xro/2.0")).length - apiAtConnect;
    expect(inMinute).toBe(55);
    expect(records("bill").filter((r) => r.status === "pending").length).toBeGreaterThan(0);
    // A minute later it carries on.
    await runXeroSync(db, { now: () => t0 + 61_000 });
    expect(xero.calls.filter((c) => c.url.pathname.startsWith("/api.xro/2.0")).length - apiAtConnect).toBeGreaterThan(55);
  });

  it("does nothing while the destination is csv, and the bills file stays the fallback", async () => {
    await connect();
    acc.destination = "csv";
    const n = xero.calls.length;
    expect((await runXeroSync(db)).skipped).toBe("destination");
    expect(xero.calls.length).toBe(n);
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.length).toBeGreaterThan(0);
    const push = await handleXeroPush(req("POST", "/api/xero/push", OWNER, {}), db);
    expect(push.status).toBe(409);
  });
});

describe("Mapping and disconnect", () => {
  it("saves a mapping only with accounts of the right kind from this organisation", async () => {
    await connect();
    const bad = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { paypalAccountCode: "429" }), db);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe("PayPal: 429 General Expenses is the wrong kind of account (expense).");
    const missing = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "999" }), db);
    expect(((await missing.json()) as { message: string }).message).toMatch(/not in this Xero organisation's chart/);
    const ok = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "400", paypalAccountCode: "092", stellarAccountCode: "091", bankAccountCode: "092", feeAccountCode: "404", taxType: "INPUT" }), db);
    expect(ok.status).toBe(200);
    expect(conn()).toMatchObject({ expenseAccountCode: "400", paypalAccountCode: "092", taxType: "INPUT" });
  });

  it("disconnect removes the connection at Xero and wipes the tokens here", async () => {
    await connect();
    const r = await handleXeroDisconnect(req("DELETE", "/api/xero/connection", OWNER), db);
    expect(r.status).toBe(200);
    expect(xero.state.deletedConnections).toEqual(["conn-1"]);
    expect(conn()).toBeUndefined();
    expect((await runXeroSync(db)).skipped).toBe("not_connected");
    expect(xeroCardView(db, DEMO_BUSINESS_ID).connected).toBe(false);
  });

  it("disconnect wipes locally even when Xero cannot be reached", async () => {
    await connect();
    xero.injections.push({ when: (c) => c.method === "DELETE", times: 1, respond: () => "network" });
    const r = await handleXeroDisconnect(req("DELETE", "/api/xero/connection", OWNER), db);
    expect(((await r.json()) as { message: string }).message).toMatch(/Connected apps in Xero/);
    expect(conn()).toBeUndefined();
  });

  it("the card view carries no token or secret", async () => {
    await connect();
    await settle(story.paypal);
    await runXeroSync(db);
    const v = JSON.stringify(xeroCardView(db, DEMO_BUSINESS_ID));
    for (const secret of [xero.state.access, xero.state.refresh, "test-client-secret", "rt-1"]) expect(v).not.toContain(secret);
  });
});

describe("Permissions on every route", () => {
  const settingsRoutes = [
    ["connect", () => handleXeroConnect(req("GET", "/api/xero/connect", who), db)],
    ["callback", () => handleXeroCallback(req("GET", "/api/xero/callback?code=good-code&state=x", who), db)],
    ["disconnect", () => handleXeroDisconnect(req("DELETE", "/api/xero/connection", who), db)],
    ["accounts", () => handleXeroAccounts(req("POST", "/api/xero/accounts", who, {}), db)],
    ["mapping", () => handleXeroMapping(req("POST", "/api/xero/mapping", who, { taxType: "NONE" }), db)],
  ] as const;
  let who: { user: string; role: string } | null = null;

  it("only the owner connects, maps and disconnects", async () => {
    await connect();
    for (const role of [CLERK, APPROVER, ACCOUNTANT]) {
      who = role;
      for (const [name, call] of settingsRoutes) {
        const r = await call();
        expect(r.status, `${role.role} on ${name}`).toBe(403);
      }
    }
    who = null;
    for (const [name, call] of settingsRoutes) expect((await call()).status, `no login on ${name}`).toBe(401);
    // Nothing changed.
    expect(conn()!.status).toBe("connected");
    expect(xero.state.deletedConnections).toHaveLength(0);
  });

  it("Push to Xero is for roles that export (the accountant included), not for nobody", async () => {
    await connect();
    expect((await handleXeroPush(req("POST", "/api/xero/push", null, {}), db)).status).toBe(401);
    for (const role of [OWNER, APPROVER, CLERK, ACCOUNTANT]) expect((await handleXeroPush(req("POST", "/api/xero/push", role, {}), db)).status, role.role).toBe(200);
  });

  it("writes take JSON only, which a cross-site form cannot send", async () => {
    await connect();
    expect((await handleXeroPush(req("POST", "/api/xero/push", OWNER, "a=1", "application/x-www-form-urlencoded"), db)).status).toBe(415);
    expect((await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, "taxType=NONE", "application/x-www-form-urlencoded"), db)).status).toBe(415);
    expect((await handleXeroAccounts(req("POST", "/api/xero/accounts", OWNER, "", "text/plain"), db)).status).toBe(415);
  });
});
