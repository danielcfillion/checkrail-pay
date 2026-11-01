import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { accountingSyncs, bills, obligations, settlements, users, vendors, xeroConnections, xeroOauthStates, xeroRecords } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "../engine/orchestrator";
import { applyCredit, createBill, payBill } from "../engine/bills";
import { markReturnedByHand } from "../engine/books";
import { amendObligation, rejectObligation } from "../engine/orchestrator";
import { resolveActor } from "../engine/users";
import type { Role } from "../auth/roles";
import { config } from "../config";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "../basicAuth";
import { decryptField, encryptField } from "../crypto/dataKey";
import { allRecordsCsv, exportPendingCsv } from "./record";
import { beginXeroConnect, refreshXeroToken, xeroAccessToken, DEFAULT_XERO_SCOPES } from "./xeroAuth";
import { takeXeroCallSlot } from "./xeroClient";
import { runXeroSync } from "./xeroSync";
import { xeroCardView } from "./xeroSettings";
import { xeroBillRows } from "./xeroBills";
import { handleXeroAccounts, handleXeroCallback, handleXeroConnect, handleXeroDisconnect, handleXeroMapping, handleXeroPush } from "./xeroRoutes";

/**
 * The live Xero connection against a fake Xero (a fetch stub): no network. It plays Xero's identity server (token
 * exchange, refresh rotation, revocation), the connections endpoint and the Accounting API (contacts, invoices,
 * payments, bank transactions, settings), and honours the Idempotency-Key header the way Xero does, including the
 * key expiring after six minutes.
 */

// Each test seeds a fresh demo database; on a busy machine that can pass the 5 second default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const acc = config.accounting as unknown as { destination: string; xero: { clientId: string; clientSecret: string } };
const saved = { destination: acc.destination, clientId: acc.xero.clientId, clientSecret: acc.xero.clientSecret };

const TENANT = "tenant-ridgeline-demo";
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

type Call = { method: string; url: URL; headers: Headers; body: string; signal: AbortSignal | null };
type Injection = { when: (c: Call) => boolean; times: number; respond: (c: Call) => Response | "network" | "network_after" | "hang_after" | "ok_unreadable" };

function fakeXero() {
  let n = 1;
  const state = {
    access: jwt({ authentication_event_id: "evt-1", n: 1 }),
    refresh: "rt-1",
    contacts: [{ ContactID: "c-maria", Name: "Maria Santos", ContactStatus: "ACTIVE" }, { ContactID: "c-ana-old", Name: "Ana Reyes", ContactStatus: "ARCHIVED" }] as Array<{ ContactID: string; Name: string; ContactStatus?: string }>,
    invoices: [] as Array<Record<string, unknown>>,
    payments: [] as Array<Record<string, unknown>>,
    bankTx: [] as Array<Record<string, unknown>>,
    creditNotes: [] as Array<Record<string, unknown>>,
    deletedConnections: [] as string[],
    revokedTokens: [] as string[],
    revokedAccess: new Set<string>(),
    idem: new Map<string, { status: number; body: unknown }>(),
    currencies: ["USD"],
    accountsDown: false,
    /** Payments Xero will not delete (reconciled). */
    reconciled: new Set<string>(),
  };
  const due = (inv: Record<string, unknown>) => {
    const total = (inv.LineItems as Array<{ UnitAmount: number; Quantity?: number }>).reduce((sum, l) => sum + Math.round(l.UnitAmount * 100) * (l.Quantity ?? 1), 0);
    const paid = state.payments.filter((x) => (x.Invoice as { InvoiceID: string }).InvoiceID === inv.InvoiceID && x.Status !== "DELETED").reduce((sum, x) => sum + Math.round(Number(x.Amount) * 100), 0);
    const credited = ((inv.Allocations as Array<{ Amount: number }> | undefined) ?? []).reduce((sum, a) => sum + Math.round(a.Amount * 100), 0);
    return { total, paid, credited, due: total - paid - credited };
  };
  const calls: Call[] = [];
  const injections: Injection[] = [];
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  async function handle(c: Call): Promise<Response> {
    const p = c.url.pathname;
    if (c.url.host === "identity.xero.com" && (p === "/connect/token" || p === "/connect/revocation")) {
      if (c.headers.get("authorization") !== `Basic ${Buffer.from("test-client-id:test-client-secret").toString("base64")}`) return res(401, { error: "invalid_client" });
      const form = new URLSearchParams(c.body);
      if (p === "/connect/revocation") {
        state.revokedTokens.push(form.get("token") ?? "");
        return new Response(null, { status: 200 });
      }
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
        { id: "conn-1", authEventId: "evt-1", tenantId: TENANT, tenantType: "ORGANISATION", tenantName: "Demo Company (US)" },
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
    if (method === "GET" && api === "/Accounts") {
      if (state.accountsDown) return { status: 503, body: { Title: "Service Unavailable" } };
      return {
        status: 200,
        body: {
          Accounts: [
            { Code: "090", Name: "PayPal clearing", Type: "BANK", Status: "ACTIVE", CurrencyCode: "USD" },
            { Code: "091", Name: "Stellar treasury", Type: "BANK", Status: "ACTIVE", CurrencyCode: "USD" },
            { Code: "092", Name: "Business bank account", Type: "BANK", Status: "ACTIVE", CurrencyCode: "USD" },
            { Code: "093", Name: "Euro account", Type: "BANK", Status: "ACTIVE", CurrencyCode: "EUR" },
            { Code: "404", Name: "Bank Fees", Type: "EXPENSE", Status: "ACTIVE" },
            { Code: "429", Name: "General Expenses", Type: "EXPENSE", Status: "ACTIVE" },
            { Code: "400", Name: "Advertising", Type: "OVERHEADS", Status: "ACTIVE" },
            { Code: "620", Name: "Prepayments", Type: "PREPAYMENT", Status: "ACTIVE" },
            { Code: "825", Name: "Tax withheld", Type: "CURRLIAB", Status: "ACTIVE", EnablePaymentsToAccount: true },
            { Code: "826", Name: "Other liability", Type: "CURRLIAB", Status: "ACTIVE", EnablePaymentsToAccount: false },
            { Code: "999", Name: "Old account", Type: "EXPENSE", Status: "ARCHIVED" },
          ],
        },
      };
    }
    if (method === "GET" && api === "/TaxRates") return { status: 200, body: { TaxRates: [{ TaxType: "INPUT", Name: "Tax on Purchases", Status: "ACTIVE", CanApplyToExpenses: true }, { TaxType: "NONE", Name: "Tax Exempt", Status: "ACTIVE", CanApplyToExpenses: true }] } };
    if (method === "GET" && api === "/Currencies") return { status: 200, body: { Currencies: state.currencies.map((Code) => ({ Code })) } };
    if (method === "GET" && api === "/Organisation") return { status: 200, body: { Organisations: [{ BaseCurrency: "USD" }] } };
    if (method === "GET" && api === "/TrackingCategories") return { status: 200, body: { TrackingCategories: [{ Name: "Departure", Status: "ACTIVE", Options: [{ Name: "HG-4D-0921", Status: "ACTIVE" }] }] } };
    if (method === "GET" && api === "/Contacts") {
      // searchTerm: Xero matches any part of the name, in any case.
      const term = (c.url.searchParams.get("searchTerm") ?? "").toLowerCase();
      return { status: 200, body: { Contacts: state.contacts.filter((x) => term && x.Name.toLowerCase().includes(term)) } };
    }
    if (method === "PUT" && api === "/Contacts") {
      const body = JSON.parse(c.body) as { Contacts: Array<{ Name: string }> };
      const made = { ContactID: `c-${state.contacts.length + 1}`, Name: body.Contacts[0].Name, ContactStatus: "ACTIVE" };
      state.contacts.push(made);
      return { status: 200, body: { Contacts: [made] } };
    }
    const one = api.match(/^\/Invoices\/(.+)$/);
    if (method === "GET" && one) {
      const inv = state.invoices.find((i) => i.InvoiceID === decodeURIComponent(one[1]));
      if (!inv) return { status: 404, body: { Title: "Not found" } };
      // As Xero documents it: an invoice's Payments list carries id, date and amount, not the payment's reference.
      const pays = state.payments.filter((x) => (x.Invoice as { InvoiceID: string }).InvoiceID === inv.InvoiceID && x.Status !== "DELETED").map((x) => ({ PaymentID: x.PaymentID, Date: x.Date, Amount: x.Amount }));
      const d = due(inv);
      return { status: 200, body: { Invoices: [{ ...inv, Payments: pays, AmountPaid: d.paid / 100, AmountCredited: d.credited / 100, AmountDue: d.due / 100 }] } };
    }
    if (method === "POST" && one) {
      const inv = state.invoices.find((i) => i.InvoiceID === decodeURIComponent(one[1]));
      if (!inv) return { status: 404, body: { Title: "Not found" } };
      const patch = (JSON.parse(c.body) as { Invoices: Array<Record<string, unknown>> }).Invoices[0];
      if (due(inv).paid > 0 || due(inv).credited > 0) return { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: "This document cannot be edited as it has a payment or credit note allocated to it." }] }] } };
      Object.assign(inv, patch);
      return { status: 200, body: { Invoices: [inv] } };
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
    if (method === "GET" && api === "/CreditNotes") return { status: 200, body: { CreditNotes: state.creditNotes.filter((x) => x.CreditNoteNumber === quoted("CreditNoteNumber")) } };
    if (method === "PUT" && api === "/CreditNotes") {
      const body = JSON.parse(c.body) as { CreditNotes: Array<Record<string, unknown>> };
      const cn = { ...body.CreditNotes[0], CreditNoteID: `cn-${state.creditNotes.length + 1}`, Status: "AUTHORISED" };
      state.creditNotes.push(cn);
      return { status: 200, body: { CreditNotes: [cn] } };
    }
    if (method === "GET" && api === "/Payments") {
      const forInvoice = where.match(/^Invoice\.InvoiceID==Guid\("([^"]+)"\)$/)?.[1];
      if (forInvoice) return { status: 200, body: { Payments: state.payments.filter((x) => (x.Invoice as { InvoiceID: string }).InvoiceID === forInvoice) } };
      return { status: 200, body: { Payments: state.payments.filter((x) => x.Reference === quoted("Reference")) } };
    }
    if (method === "PUT" && api === "/Payments") {
      const body = JSON.parse(c.body) as { Payments: Array<Record<string, unknown>> };
      const pay: Record<string, unknown> = { ...body.Payments[0], PaymentID: `pay-${state.payments.length + 1}`, Status: "AUTHORISED" };
      // As real Xero: a payment comes from a bank account or an account with payments enabled.
      if (!["090", "091", "092", "093", "825"].includes(String((pay.Account as { Code?: string } | undefined)?.Code))) return { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: "Account type is invalid for making a payment to/from" }] }] } };
      const inv = state.invoices.find((i) => i.InvoiceID === (pay.Invoice as { InvoiceID: string }).InvoiceID);
      // As real Xero: never more than the amount still owed on the document.
      if (inv && Math.round(Number(pay.Amount) * 100) > due(inv).due) return { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: "Payment amount exceeds the amount outstanding on this document" }] }] } };
      state.payments.push(pay);
      return { status: 200, body: { Payments: [pay] } };
    }
    const payOne = api.match(/^\/Payments\/(.+)$/);
    if (method === "GET" && payOne) {
      const pay = state.payments.find((x) => x.PaymentID === decodeURIComponent(payOne[1]));
      return pay ? { status: 200, body: { Payments: [pay] } } : { status: 404, body: { Title: "Not found" } };
    }
    if (method === "POST" && payOne) {
      const pay = state.payments.find((x) => x.PaymentID === decodeURIComponent(payOne[1]));
      if (!pay) return { status: 404, body: { Title: "Not found" } };
      if (state.reconciled.has(String(pay.PaymentID))) return { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: "Payment cannot be deleted as it has been reconciled" }] }] } };
      pay.Status = "DELETED";
      return { status: 200, body: { Payments: [pay] } };
    }
    const cnAlloc = api.match(/^\/CreditNotes\/([^/]+)\/Allocations$/);
    if (method === "PUT" && cnAlloc) {
      const cn = state.creditNotes.find((x) => x.CreditNoteID === decodeURIComponent(cnAlloc[1]));
      const a = (JSON.parse(c.body) as { Allocations: Array<{ Invoice: { InvoiceID: string }; Amount: number }> }).Allocations[0];
      const inv = state.invoices.find((i) => i.InvoiceID === a.Invoice.InvoiceID);
      if (!cn || !inv) return { status: 404, body: { Title: "Not found" } };
      if (Math.round(a.Amount * 100) > due(inv).due) return { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: "The amount allocated exceeds the amount outstanding" }] }] } };
      const made = { AllocationID: `al-${Math.random().toString(16).slice(2, 8)}`, Amount: a.Amount, Invoice: { InvoiceID: inv.InvoiceID } };
      inv.Allocations = [...((inv.Allocations as unknown[]) ?? []), made];
      cn.Allocations = [...((cn.Allocations as unknown[]) ?? []), made];
      return { status: 200, body: { Allocations: [made] } };
    }
    const cnOne = api.match(/^\/CreditNotes\/([^/]+)$/);
    if (method === "GET" && cnOne) return { status: 200, body: { CreditNotes: state.creditNotes.filter((x) => x.CreditNoteID === decodeURIComponent(cnOne[1])) } };
    if (method === "GET" && api === "/BankTransactions") return { status: 200, body: { BankTransactions: state.bankTx.filter((x) => x.Reference === quoted("Reference")) } };
    if (method === "PUT" && api === "/BankTransactions") {
      const body = JSON.parse(c.body) as { BankTransactions: Array<Record<string, unknown>> };
      const tx = { ...body.BankTransactions[0], BankTransactionID: `bt-${state.bankTx.length + 1}`, Status: "AUTHORISED" };
      state.bankTx.push(tx);
      return { status: 200, body: { BankTransactions: [tx] } };
    }
    return { status: 404, body: { Message: `no route ${method} ${api}` } };
  }

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!/(^|\.)xero\.com$/.test(url.host)) throw new Error(`unexpected network call to ${url.host}`);
    const c: Call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "", signal: init?.signal ?? null };
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
      if (r === "ok_unreadable") {
        await handle(c); // Xero did it and said 200, but the body cannot be read.
        return new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (r === "hang_after") {
        await handle(c); // Xero did it; this process never hears back (it stopped).
        return new Promise<Response>(() => undefined);
      }
      return r;
    }
    return handle(c);
  });

  const api = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === `/api.xro/2.0${path}`);
  const amountDue = (number: string) => due(state.invoices.find((i) => i.InvoiceNumber === number)!).due / 100;
  return { state, calls, injections, fetch, api, res, amountDue };
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

/** As if Xero had been connected before the demo's requests were approved, so they belong to the live push. */
function connectedEarlier(): void {
  db.update(xeroConnections).set({ syncFrom: "2000-01-01T00:00:00.000Z" }).run();
}

async function settle(id: string) {
  const ob = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
  if (ob.state === "awaiting_approval") approveObligation(db, id, "user:minh");
  await executeObligation(db, id, { actor: "user:minh" });
  await confirmSettlement(db, id);
}

const as = (u: string) => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const conn = () => db.select().from(xeroConnections).where(eq(xeroConnections.businessId, DEMO_BUSINESS_ID)).get();
const records = (kind?: string) => db.select().from(xeroRecords).all().filter((r) => !kind || r.kind === kind);
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

beforeEach(async () => {
  acc.destination = "xero";
  acc.xero.clientId = "test-client-id";
  acc.xero.clientSecret = "test-client-secret";
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  delete process.env.XERO_SCOPES;
  // A fixed test key (not a secret): Xero tokens are only stored under a real data key.
  process.env.CHECKRAIL_DATA_KEY = Buffer.from("checkrail xero tests 32 byte key").toString("base64");
  xero = fakeXero();
  vi.stubGlobal("fetch", xero.fetch);
  db = openTestDb();
  ({ story } = (await seedDemo(db, { history: false })) as { story: typeof story });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CHECKRAIL_DATA_KEY;
  delete process.env.CHECKRAIL_DEMO_PERSONAS;
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
    expect(c).toMatchObject({ tenantId: TENANT, tenantName: "Demo Company (US)", connectionId: "conn-1", status: "connected" });
    expect(c.syncFrom).toBe(c.connectedAt);
    expect(c.accessTokenEnc).not.toContain(xero.state.access);
    expect(c.refreshTokenEnc).not.toContain("rt-1");
    expect(decryptField(c.refreshTokenEnc)).toBe("rt-1");
    // The chart was read straight away and the mapping filled with first guesses.
    expect(c).toMatchObject({ paypalAccountCode: "090", stellarAccountCode: "091", bankAccountCode: "092", feeAccountCode: "404", expenseAccountCode: "429", taxType: "NONE", withholdingAccountCode: "825" });
    // The state is single use.
    const replay = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${state}`, OWNER), db);
    expect(replay.headers.get("location")).toContain("xero=invalid_state");
    // Every call to Xero carries a timeout.
    expect(xero.calls.every((x) => x.signal instanceof AbortSignal)).toBe(true);
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

  it("says plainly when the owner did not allow access, and logs (server side, no secrets) why a code was refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s1 = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "daniel", actor: "user:daniel" }).state;
    const denied = await handleXeroCallback(req("GET", `/api/xero/callback?error=access_denied&state=${s1}`, OWNER), db);
    expect(denied.headers.get("location")).toContain("xero=denied");
    const s2 = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "daniel", actor: "user:daniel" }).state;
    const bad = await handleXeroCallback(req("GET", `/api/xero/callback?code=stale-code&state=${s2}`, OWNER), db);
    expect(bad.headers.get("location")).toContain("xero=failed");
    expect(conn()).toBeUndefined();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[xero] connect failed");
    expect(logged).toContain("HTTP 400 invalid_grant");
    for (const secret of ["stale-code", "test-client-secret", s2]) expect(logged).not.toContain(secret);
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

  it("refresh is compare-and-swap: when another process rotated first, its tokens win and are used", async () => {
    await connect();
    // Another process refreshes while this one's call to Xero is in flight, and stores its own pair first.
    xero.injections.push({
      when: (c) => new URLSearchParams(c.body).get("grant_type") === "refresh_token",
      times: 1,
      respond: () => {
        db.update(xeroConnections).set({ accessTokenEnc: encryptField("at-other-process"), refreshTokenEnc: encryptField("rt-other-process") }).run();
        return xero.res(200, { access_token: "at-this-process", refresh_token: "rt-this-process", expires_in: 1800 });
      },
    });
    const token = await refreshXeroToken(db, DEMO_BUSINESS_ID);
    expect(token).toBe("at-other-process");
    expect(decryptField(conn()!.refreshTokenEnc)).toBe("rt-other-process");
    expect(conn()!.status).toBe("connected");
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
    connectedEarlier();
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
    connectedEarlier();
    const before = xero.calls.length;
    await settle(story.paypal);
    // Nothing on the payment path called Xero.
    expect(xero.calls.length).toBe(before);
    const sync = db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, story.paypal)).get()!;
    expect(sync).toMatchObject({ destination: "xero", status: "pending" });

    const r1 = await runXeroSync(db);
    expect(r1.failed).toBe(0);
    // Maria Santos is already a contact in Xero: found, not created. The fee's contact (PayPal) is created once.
    expect(xero.state.contacts.map((c) => c.Name)).toEqual(["Maria Santos", "Ana Reyes", "PayPal"]);
    const bill = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-HG4D-0921")!;
    expect(bill).toMatchObject({ Type: "ACCPAY", Contact: { ContactID: "c-maria" }, CurrencyCode: "USD", Status: "AUTHORISED", LineAmountTypes: "NoTax" });
    const line = (bill.LineItems as Array<Record<string, unknown>>)[0];
    // 310 is not in this chart: the chosen expense account takes it. The tracking option exists, so it is tagged.
    expect(line).toMatchObject({ UnitAmount: 180, AccountCode: "429", Tracking: [{ Name: "Departure", Option: "HG-4D-0921" }] });
    expect(line.TaxType).toBeUndefined();
    // The other agreed request (JOB-HG4D-0914) is a bill too, without a tracking option Xero does not have.
    const other = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-HG4D-0914")!;
    expect((other.LineItems as Array<Record<string, unknown>>)[0].Tracking).toBeUndefined();

    const pay = xero.state.payments[0];
    expect(pay).toMatchObject({ Invoice: { InvoiceID: bill.InvoiceID }, Account: { Code: "090" }, Amount: 180 });
    const fee = xero.state.bankTx[0];
    expect(fee).toMatchObject({ Type: "SPEND", BankAccount: { Code: "090" }, CurrencyCode: "USD", Reference: `fee JOB-HG4D-0921 ${story.paypal}` });
    const feeLine = (fee.LineItems as Array<Record<string, unknown>>)[0];
    expect(feeLine.AccountCode).toBe("404");
    expect(Number(pay.Amount) + Number(feeLine.UnitAmount)).toBeCloseTo(Number(JSON.parse(sync.payloadJson!).netPaid), 2);

    // Writes carry an Idempotency-Key, and the key was written to the record before the call.
    for (const c of xero.calls.filter((c) => c.method === "PUT")) expect(c.headers.get("idempotency-key")).toMatch(/^checkrail-xr_[0-9a-f]+-\d+$/);
    for (const r of records().filter((x) => x.kind !== "settlement")) expect(r.idemKey ?? "").toMatch(r.kind === "contact" && r.label.includes("Maria") ? /^$/ : /^checkrail-/);
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
    expect(xeroCardView(db, DEMO_BUSINESS_ID)).toMatchObject({ connected: true, tenantName: "Demo Company (US)", pushed: 4 });
  });

  it("Stellar: the bill and the payment of the gross, with no separate fee spend; a new contact is created", async () => {
    await connect();
    await settle(story.stellar);
    await runXeroSync(db);
    const bill = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-PAL3D-0927")!;
    // The archived Ana Reyes is passed over: a live contact is created and the bill goes to it.
    const ana = xero.state.contacts.filter((c) => c.Name === "Ana Reyes");
    expect(ana.map((c) => c.ContactStatus)).toEqual(["ARCHIVED", "ACTIVE"]);
    expect(bill.Contact).toEqual({ ContactID: ana[1].ContactID });
    expect(xero.state.payments.find((p) => (p.Invoice as { InvoiceID: string }).InvoiceID === bill.InvoiceID)).toMatchObject({ Amount: 750, Account: { Code: "091" } });
    expect(xero.state.bankTx).toHaveLength(0);
  });

  it("a payment whose answer was lost is found on the bill, not created again", async () => {
    await connect();
    connectedEarlier();
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
    // Found by its own reference, so it is ours: its fee is booked, not skipped.
    expect(xero.state.bankTx).toHaveLength(1);
    expect(xeroCardView(db, DEMO_BUSINESS_ID).skippedFees).toBe(0);
  });

  it("a repeated request with the same Idempotency-Key gets Xero's first answer, not a second bill", async () => {
    await connect();
    connectedEarlier();
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => "network_after" });
    await runXeroSync(db);
    const failed = records("bill").find((r) => r.status === "failed")!;
    expect(failed.uncertain).toBe(true);
    // Make the look-up miss, so the create is repeated: the same key returns the cached answer.
    xero.injections.push({ when: (c) => c.method === "GET" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => xero.res(200, { Invoices: [] }) });
    await runXeroSync(db, { force: true });
    const keys = xero.api("PUT", "/Invoices").map((c) => c.headers.get("idempotency-key"));
    expect(new Set(keys).size).toBeLessThan(keys.length);
    expect(xero.state.invoices.filter((i) => i.InvoiceNumber === failed.label.split(" ")[1].replace(",", ""))).toHaveLength(1);
  });

  it("a failure is kept on the record in plain words and never touches the payment", async () => {
    await connect();
    connectedEarlier();
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
    connectedEarlier();
    await settle(story.paypal);
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => xero.res(429, { Title: "Too many requests" }, { "Retry-After": "30", "X-Rate-Limit-Problem": "minute" }) });
    const t0 = Date.now();
    const r1 = await runXeroSync(db, { now: () => t0 });
    expect(r1).toMatchObject({ rateLimited: true, failed: 0 });
    expect(r1.errors[0]).toMatch(/slow down.*30 seconds/);
    expect(Date.parse(conn()!.blockedUntil!)).toBe(t0 + 30_000);
    const n = xero.calls.length;
    const r2 = await runXeroSync(db, { now: () => t0 + 10_000 });
    expect(r2.rateLimited).toBe(true);
    expect(xero.calls.length).toBe(n);
    const r3 = await runXeroSync(db, { now: () => t0 + 31_000 });
    expect(r3.rateLimited).toBe(false);
    expect(xero.state.payments).toHaveLength(1);
  });

  it("keeps under 60 calls a minute, with the count in the database so every process shares it", async () => {
    await connect();
    const t0 = Date.now();
    for (let i = 0; i < 70; i++) {
      const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: `Invoice INV-RL-${1000 + i} from Dao Mountain Lodge. Room block, USD ${100 + i}.`, evidence: [{ kind: "invoice", label: `Invoice INV-RL-${1000 + i}`, amountMinor: (100 + i) * 100, currency: "USD", reference: `INV-RL-${1000 + i}`, excerpt: "Dao Mountain Lodge" }], actor: "user:lan" });
      try {
        approveObligation(db, id, "user:daniel");
      } catch {
        // Some may be held by the rules; the rest are enough.
      }
    }
    db.update(xeroConnections).set({ rateWindowStart: null, rateWindowCalls: 0 }).run();
    const atStart = xero.calls.length;
    for (let k = 0; k < 4; k++) await runXeroSync(db, { now: () => t0 + k * 1000 });
    expect(xero.calls.length - atStart).toBe(55);
    expect(conn()!.rateWindowCalls).toBe(55);
    // A second process asking in the same minute gets no call either.
    expect(takeXeroCallSlot(db, DEMO_BUSINESS_ID, t0 + 5000)).toBeGreaterThan(0);
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).groups.length).toBeGreaterThan(0);
    // A minute later it carries on.
    await runXeroSync(db, { now: () => t0 + 61_000 });
    expect(xero.calls.length - atStart).toBeGreaterThan(55);
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

/** The independent review's scenarios, as tests. */
describe("Review round 1", () => {
  it("1. a process that stops between Xero's answer and the save leaves a 'sending' row that is looked up, not sent again, after the idempotency window", async () => {
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    const t0 = Date.now();
    // Xero books the fee; this process never hears back (it stopped).
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/BankTransactions"), times: 1, respond: () => "hang_after" });
    void runXeroSync(db, { now: () => t0 });
    await until(() => xero.api("PUT", "/BankTransactions").length === 1);
    const fee = records("fee")[0];
    expect(fee).toMatchObject({ status: "sending", uncertain: true });
    expect(fee.idemKey).toBe(xero.api("PUT", "/BankTransactions")[0].headers.get("idempotency-key"));
    // A forced push does not wait on the stuck pass: it says so at once.
    const busy = await handleXeroPush(req("POST", "/api/xero/push", OWNER, {}), db);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { message: string }).message).toMatch(/already running/);
    // Seven minutes on: the stuck pass's lease ran out and Xero has forgotten the key.
    xero.state.idem.clear();
    await runXeroSync(db, { now: () => t0 + 7 * 60_000 });
    expect(xero.state.bankTx).toHaveLength(1);
    expect(xero.api("PUT", "/BankTransactions")).toHaveLength(1);
    expect(records("fee")[0]).toMatchObject({ status: "pushed", xeroId: xero.state.bankTx[0].BankTransactionID });
  });

  it("2. after a demo reset the old bill is not paid again, and the reset clears the sync records but keeps the connection", async () => {
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    await runXeroSync(db);
    expect(xero.state.payments).toHaveLength(1);
    ({ story } = (await seedDemo(db, { history: false })) as { story: typeof story });
    expect(records()).toHaveLength(0);
    expect(conn()).toMatchObject({ status: "connected", tenantId: TENANT, paypalAccountCode: "090" });
    // Even when the new demo's payments fall inside the live push, the same bill is found and its payment recognised.
    connectedEarlier();
    await settle(story.paypal);
    await runXeroSync(db);
    expect(xero.state.invoices.filter((i) => i.InvoiceNumber === "JOB-HG4D-0921")).toHaveLength(1);
    expect(xero.state.payments).toHaveLength(1);
    expect(xero.state.bankTx).toHaveLength(1);
    expect(records("payment")[0]).toMatchObject({ status: "pushed", xeroId: xero.state.payments[0].PaymentID, localKey: expect.stringContaining(`${story.paypal}|paypal|`) });
    expect(records("fee")[0]).toMatchObject({ status: "skipped" });
    expect(records("fee")[0].error).toMatch(/^Skipped fee/);
    expect(xeroCardView(db, DEMO_BUSINESS_ID).skippedFees).toBe(1);
  });

  it("2b. a deposit and a balance of the same amount on one bill are both paid", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-7001", totalMinor: 40_000, currency: "USD" });
    const parts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 20_000);
      approveObligation(db, id, "user:minh");
      parts.push(id);
    }
    for (const id of parts) {
      await executeObligation(db, id, { actor: "user:minh" });
      await confirmSettlement(db, id);
    }
    await runXeroSync(db);
    expect(xero.state.invoices.filter((i) => i.InvoiceNumber === "INV-MS-7001")).toHaveLength(1);
    expect(xero.state.payments.map((p) => p.Amount)).toEqual([200, 200]);
  });

  it("3. exporting the CSV first does not stop the record going to Xero", async () => {
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    expect(exportPendingCsv(db).count).toBeGreaterThan(0);
    await runXeroSync(db);
    expect(xero.state.payments).toHaveLength(1);
    expect(xero.state.bankTx).toHaveLength(1);
    // The CSV's own mark stays.
    expect(db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, story.paypal)).get()!.status).toBe("exported");
  });

  it("4. another contact's bill with the same number is never used, for the bill or its payment", async () => {
    xero.state.contacts.push({ ContactID: "c-someone", Name: "Someone Else" });
    xero.state.invoices.push({ InvoiceID: "inv-someone", Type: "ACCPAY", InvoiceNumber: "JOB-HG4D-0921", Contact: { ContactID: "c-someone" }, Status: "AUTHORISED" });
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    await runXeroSync(db);
    const maria = xero.state.invoices.filter((i) => i.InvoiceNumber === "JOB-HG4D-0921" && (i.Contact as { ContactID: string }).ContactID === "c-maria");
    expect(maria).toHaveLength(1);
    expect(records("bill").find((r) => r.label.includes("0921"))!.xeroId).toBe(maria[0].InvoiceID);
    expect(xero.state.payments[0]).toMatchObject({ Invoice: { InvoiceID: maria[0].InvoiceID } });
  });

  it("4b. a payment whose bill came from the file is matched on this vendor's contact only, else said plainly", async () => {
    await connect();
    connectedEarlier();
    // The bill went out in the file before (so it is not pushed here), and in Xero only another contact has that number.
    db.update(obligations).set({ xeroBillExportedAt: "2026-01-01T00:00:00.000Z" }).run();
    xero.state.invoices.push({ InvoiceID: "inv-someone", Type: "ACCPAY", InvoiceNumber: "JOB-HG4D-0921", Contact: { ContactID: "c-someone" }, Status: "AUTHORISED" });
    await settle(story.paypal);
    await runXeroSync(db);
    expect(xero.state.payments).toHaveLength(0);
    expect(records("payment")[0].error).toBe("The bill JOB-HG4D-0921 for Maria Santos is not in Xero, so its payment cannot be matched to it. It goes once the bill is there.");
  });

  it("5. bills approved before Xero was connected stay in the files; the card says how many", async () => {
    await connect();
    await settle(story.paypal); // approved when the demo was seeded, before the connection
    await runXeroSync(db);
    expect(xero.state.invoices).toHaveLength(0);
    expect(xero.state.payments).toHaveLength(0);
    expect(xeroCardView(db, DEMO_BUSINESS_ID).earlierBills).toBe(2);
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.map((r) => r["*InvoiceNumber"])).toContain("JOB-HG4D-0921");
    // Approved after: it goes.
    await settle(story.stellar);
    await runXeroSync(db);
    expect(xero.state.invoices.map((i) => i.InvoiceNumber)).toEqual(["JOB-PAL3D-0927"]);
    expect(xero.state.payments).toHaveLength(1);
  });

  it("6. a chart of accounts that cannot be read is a plain error that backs off, and Push to Xero answers it, not a 500", async () => {
    await connect();
    connectedEarlier();
    db.update(xeroConnections).set({ chartJson: null }).run();
    xero.state.accountsDown = true;
    const push = await handleXeroPush(req("POST", "/api/xero/push", OWNER, {}), db);
    expect(push.status).toBe(502);
    expect(((await push.json()) as { message: string }).message).toMatch(/^Could not read the chart of accounts from Xero: Xero had a problem \(HTTP 503\)/);
    expect(conn()).toMatchObject({ chartAttempts: 1 });
    expect(conn()!.lastError).toMatch(/chart of accounts/);
    expect(Date.parse(conn()!.chartRetryAt!)).toBeGreaterThan(Date.now());
    const n = xero.calls.length;
    expect((await runXeroSync(db)).skipped).toBe("chart_wait");
    expect(xero.calls.length).toBe(n);
    xero.state.accountsDown = false;
    await runXeroSync(db, { force: true });
    expect(conn()).toMatchObject({ chartAttempts: 0, chartRetryAt: null });
    expect(xero.state.invoices.length).toBeGreaterThan(0);
  });

  it("7. one pass at a time across processes: a live lease held elsewhere means busy, an expired one is taken over", async () => {
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    const t0 = Date.now();
    db.update(xeroConnections).set({ leaseOwner: "lease_other_process", leaseUntil: new Date(t0 + 30_000).toISOString() }).run();
    const n = xero.calls.length;
    const busy = await runXeroSync(db, { now: () => t0 });
    expect(busy.skipped).toBe("busy");
    expect(xero.calls.length).toBe(n);
    const later = await runXeroSync(db, { now: () => t0 + 31_000 });
    expect(later.skipped).toBeUndefined();
    expect(xero.state.payments).toHaveLength(1);
    expect(conn()).toMatchObject({ leaseOwner: null, leaseUntil: null });
  });

  it("8. a deposit's and a balance's fees have their own references, so a look-up never takes one for the other", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-8001", totalMinor: 30_000, currency: "USD" });
    const parts: string[] = [];
    for (const amount of [10_000, 20_000]) {
      const id = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, amount);
      approveObligation(db, id, "user:minh");
      await executeObligation(db, id, { actor: "user:minh" });
      await confirmSettlement(db, id);
      parts.push(id);
    }
    // The balance's fee call gets no answer and Xero did not book it.
    let feePuts = 0;
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/BankTransactions") && ++feePuts === 2, times: 1, respond: () => "network" });
    await runXeroSync(db);
    expect(xero.state.bankTx).toHaveLength(1);
    await runXeroSync(db, { force: true });
    expect(xero.state.bankTx).toHaveLength(2);
    expect(new Set(xero.state.bankTx.map((t) => t.Reference)).size).toBe(2);
    expect(xero.state.bankTx.map((t) => t.Reference)).toEqual(expect.arrayContaining(parts.map((id) => `fee INV-MS-8001 ${id}`)));
  });

  it("9. LineAmountTypes is always sent, and a tax type is required in the mapping", async () => {
    await connect();
    const noTax = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "429", paypalAccountCode: "090", taxType: "" }), db);
    expect(noTax.status).toBe(400);
    expect(((await noTax.json()) as { message: string }).message).toMatch(/^Tax rate on bills: choose one/);
    await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "429", paypalAccountCode: "090", stellarAccountCode: "091", bankAccountCode: "092", feeAccountCode: "404", taxType: "INPUT" }), db);
    await settle(story.stellar);
    await runXeroSync(db);
    const bill = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-PAL3D-0927")!;
    // A rate with tax in it: the amount includes the tax, so the bill's total is still what is paid.
    expect(bill.LineAmountTypes).toBe("Inclusive");
    expect((bill.LineItems as Array<Record<string, unknown>>)[0]).toMatchObject({ UnitAmount: 750, TaxType: "INPUT" });
    expect(xero.state.payments[0].Amount).toBe(750);
  });

  it("11. a bank account in another currency is refused plainly", async () => {
    await connect();
    connectedEarlier();
    await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "429", paypalAccountCode: "093", stellarAccountCode: "091", bankAccountCode: "092", feeAccountCode: "404", taxType: "NONE" }), db);
    await settle(story.paypal);
    await runXeroSync(db);
    expect(xero.state.payments).toHaveLength(0);
    expect(records("payment")[0].error).toBe("The PayPal bank account in Xero (093 Euro account) is in EUR, but this payment is in USD. Choose a USD bank account for PayPal in Settings, Xero.");
  });
});

describe("Review round 2", () => {
  it("S1. a bill split across the connect time stays wholly in the files, balance payment included", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-9001", totalMinor: 40_000, currency: "USD" });
    const dep = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 20_000);
    approveObligation(db, dep, "user:minh");
    await connect();
    const bal = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 20_000);
    approveObligation(db, bal, "user:minh");
    await executeObligation(db, bal, { actor: "user:minh" });
    await confirmSettlement(db, bal);
    await runXeroSync(db);
    expect(xero.state.invoices.filter((i) => i.InvoiceNumber === "INV-MS-9001")).toHaveLength(0);
    expect(records("payment")).toHaveLength(0);
    expect(xeroCardView(db, DEMO_BUSINESS_ID).failures).toHaveLength(0);
    // Marked as left to the files, so it is not read again on every pass.
    const sync = db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, bal)).get()!;
    expect(records("settlement").find((r) => r.accountingSyncId === sync.id)).toMatchObject({ status: "skipped" });
  });

  it("S2. disconnect and reconnect to the same organisation keeps the starting point and what was sent; the payment still goes", async () => {
    await connect();
    const from = conn()!.syncFrom;
    approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    expect(xero.state.invoices.map((i) => i.InvoiceNumber)).toEqual(["JOB-PAL3D-0927"]);
    await handleXeroDisconnect(req("DELETE", "/api/xero/connection", OWNER, {}), db);
    await settle(story.stellar);
    xero.state.refresh = "rt-1";
    await connect();
    expect(conn()!.syncFrom).toBe(from);
    expect(conn()).toMatchObject({ status: "connected", stellarAccountCode: "091" });
    await runXeroSync(db);
    expect(xero.state.invoices).toHaveLength(1);
    expect(xero.state.payments).toHaveLength(1);
    expect(xero.state.payments[0]).toMatchObject({ Invoice: { InvoiceID: xero.state.invoices[0].InvoiceID }, Amount: 750 });
  });

  it("S3. the Accounting page summary counts a skipped fee", async () => {
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    await runXeroSync(db);
    ({ story } = (await seedDemo(db, { history: false })) as { story: typeof story });
    connectedEarlier();
    await settle(story.paypal);
    await runXeroSync(db);
    expect(xeroCardView(db, DEMO_BUSINESS_ID)).toMatchObject({ skippedFees: 1, connected: true });
  });

  it("S4. without a real CHECKRAIL_DATA_KEY, Xero cannot be connected even with demo personas on; the card says why", async () => {
    delete process.env.CHECKRAIL_DATA_KEY;
    process.env.CHECKRAIL_DEMO_PERSONAS = "1";
    const r = handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db);
    expect(r.headers.get("location")).toContain("xero=no_data_key");
    expect(xeroCardView(db, DEMO_BUSINESS_ID)).toMatchObject({ configured: true, dataKeyMissing: true, connected: false });
    // A callback that somehow arrives stores nothing.
    const s = beginXeroConnect(db, { businessId: DEMO_BUSINESS_ID, login: "daniel", actor: "user:daniel" }).state;
    const back = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${s}`, OWNER), db);
    expect(back.headers.get("location")).toContain("xero=failed");
    expect(conn()).toBeUndefined();
    expect(xero.calls.filter((c) => c.url.host === "identity.xero.com")).toHaveLength(0);
  });

});

/** Pay a bill part end to end: request, approval, payout, settlement. */
async function payPart(bill: string, amountMinor: number): Promise<string> {
  const id = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, amountMinor);
  approveObligation(db, id, "user:daniel");
  await executeObligation(db, id, { actor: "user:daniel" });
  await confirmSettlement(db, id);
  return id;
}
const noW9 = (on: boolean) => db.update(vendors).set({ taxForm: on ? null : "w9" }).where(eq(vendors.id, "ven_jake")).run();

describe("Review round 3", () => {
  it("M1. rounding: 1,000.02 in two parts of 500.01 at 24% clears exactly, the bill at gross", async () => {
    await connect();
    noW9(true);
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_jake", { kind: "invoice", reference: "INV-JM-5001", totalMinor: 100_002, currency: "USD" });
    for (const amount of [50_001, 50_001]) {
      await payPart(bill, amount);
      await runXeroSync(db);
    }
    const live = xero.state.invoices.find((i) => i.InvoiceNumber === "INV-JM-5001")!;
    expect((live.LineItems as Array<{ UnitAmount: number }>).map((l) => l.UnitAmount)).toEqual([1000.02]);
    expect(xero.amountDue("INV-JM-5001")).toBe(0);
    expect(xero.state.payments.map((x) => [x.Amount, (x.Account as { Code: string }).Code])).toEqual([
      [380, "090"],
      [120.01, "825"],
      [380, "090"],
      [120.01, "825"],
    ]);
    expect(xeroCardView(db, DEMO_BUSINESS_ID).failures).toHaveLength(0);
    // The bills file carries the same gross bill, no withholding line: the withheld part is settled as a payment.
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: false, includeLive: true }).rows.filter((r) => r["*InvoiceNumber"] === "INV-JM-5001").map((r) => r["*UnitAmount"])).toEqual(["1000.02"]);
  });

  for (const order of ["W-9 filed between deposit and balance", "W-9 withdrawn between deposit and balance"] as const) {
    it(`M1. ${order}: each part clears with what it really withheld`, async () => {
      await connect();
      noW9(order.includes("filed"));
      const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_jake", { kind: "invoice", reference: "INV-JM-6001", totalMinor: 45_000, currency: "USD" });
      await payPart(bill, 22_500);
      await runXeroSync(db);
      noW9(!order.includes("filed"));
      await payPart(bill, 22_500);
      await runXeroSync(db);
      await runXeroSync(db);
      expect(xero.amountDue("INV-JM-6001")).toBe(0);
      expect(xero.state.payments.filter((x) => (x.Account as { Code: string }).Code === "825").map((x) => x.Amount)).toEqual([54]);
      expect(xeroCardView(db, DEMO_BUSINESS_ID).failures).toHaveLength(0);
    });
  }

  it("M1. a single payment with withholding: net from the bank, the withheld part from the liability account", async () => {
    await connect();
    noW9(true);
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_jake", { kind: "invoice", reference: "INV-JM-7001", totalMinor: 45_000, currency: "USD" });
    const id = await payPart(bill, 45_000);
    await runXeroSync(db);
    expect(xero.amountDue("INV-JM-7001")).toBe(0);
    expect(xero.state.payments.map((x) => [x.Amount, (x.Account as { Code: string }).Code, x.Reference])).toEqual([
      [342, "090", expect.stringMatching(/^paypal:/)],
      [108, "825", expect.stringMatching(/^paypal:.*:wh$/)],
    ]);
    expect(records("withholding")[0]).toMatchObject({ status: "pushed", localKey: expect.stringMatching(new RegExp(`^${id}\\|paypal\\|.*\\|wh$`)) });
    // Twice: nothing new.
    await runXeroSync(db);
    expect(xero.state.payments).toHaveLength(2);
  });

  it("M1. no withholding: one payment, nothing from the liability account", async () => {
    await connect();
    connectedEarlier();
    await settle(story.paypal);
    await runXeroSync(db);
    expect(xero.state.payments).toHaveLength(1);
    expect(records("withholding")).toHaveLength(0);
    expect(xero.amountDue("JOB-HG4D-0921")).toBe(0);
  });

  it("M1. a withholding account must take payments", async () => {
    await connect();
    const r = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "429", withholdingAccountCode: "826", taxType: "NONE" }), db);
    expect(((await r.json()) as { message: string }).message).toMatch(/^Tax withheld: 826 Other liability does not take payments\. In Xero, open Accounting, Chart of accounts/);
  });

  it("S1. a cancelled request's unpaid bill is voided in Xero", async () => {
    await connect();
    approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    const inv = xero.state.invoices.find((i) => i.InvoiceNumber === "JOB-PAL3D-0927")!;
    rejectObligation(db, story.stellar, "user:minh", "Trip cancelled");
    await runXeroSync(db);
    expect(inv.Status).toBe("VOIDED");
    expect(records("bill").find((r) => r.label.includes("0927"))!.status).toBe("voided");
  });

  it("S1. a payout that came back and is paid again: the first Xero payment is removed, the new one fits", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-1101", totalMinor: 20_000, currency: "USD" });
    const first = await payPart(bill, 20_000);
    await runXeroSync(db);
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), first, "RETURN-1101");
    await payPart(bill, 20_000);
    await runXeroSync(db);
    expect(xero.state.payments.map((x) => x.Status)).toEqual(["DELETED", "AUTHORISED"]);
    expect(xero.amountDue("INV-MS-1101")).toBe(0);
    expect(xeroCardView(db, DEMO_BUSINESS_ID).failures).toHaveLength(0);
  });

  it("S1. when Xero will not remove it (reconciled), a person is asked and nothing retries", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-1201", totalMinor: 20_000, currency: "USD" });
    const first = await payPart(bill, 20_000);
    await runXeroSync(db);
    xero.state.reconciled.add(String(xero.state.payments[0].PaymentID));
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), first, "RETURN-1201");
    await runXeroSync(db);
    const f = xeroCardView(db, DEMO_BUSINESS_ID).failures[0];
    expect(f).toMatchObject({ needsPerson: true });
    expect(f.error).toMatch(/Xero would not remove the payment \(Xero said: Payment cannot be deleted as it has been reconciled\)\. Reverse it in Xero by hand/);
    const n = xero.api("POST", `/Payments/${xero.state.payments[0].PaymentID}`).length;
    await runXeroSync(db, { force: true });
    expect(xero.api("POST", `/Payments/${xero.state.payments[0].PaymentID}`).length).toBe(n);
  });

  it("S1. an amended reference on an approved request updates its unpaid bill in Xero", async () => {
    await connect();
    approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    await amendObligation(db, story.stellar, "user:lan", { sourceRef: "JOB-PAL3D-0927-R" }, "Re-issued invoice");
    const ob = db.select().from(obligations).where(eq(obligations.id, story.stellar)).get()!;
    if (ob.state !== "approved") approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    expect(xero.state.invoices).toHaveLength(1);
    expect(xero.state.invoices[0].InvoiceNumber).toBe("JOB-PAL3D-0927-R");
    expect(records("bill").find((r) => r.xeroId === xero.state.invoices[0].InvoiceID)).toMatchObject({ localKey: expect.stringContaining("JOB-PAL3D-0927-R") });
  });

  it("S2. a deposit approved then cancelled before connecting, the balance approved after: the bill and its payment both go", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-1301", totalMinor: 40_000, currency: "USD" });
    const dep = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 20_000);
    approveObligation(db, dep, "user:minh");
    rejectObligation(db, dep, "user:minh", "Not needed");
    await connect();
    await payPart(bill, 40_000);
    await runXeroSync(db);
    expect(xero.state.invoices.filter((i) => i.InvoiceNumber === "INV-MS-1301")).toHaveLength(1);
    expect(xero.amountDue("INV-MS-1301")).toBe(0);
  });

  it("S3. a credit applied to a bill is allocated in Xero once, so the payments clear it", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-1401", totalMinor: 85_000, currency: "USD" });
    await payPart(bill, 40_000);
    const cn = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "credit_note", reference: "CN-MS-1401", totalMinor: 8_500, currency: "USD", note: "One night not used" });
    await runXeroSync(db);
    applyCredit(db, DEMO_BUSINESS_ID, as("daniel"), cn, bill, 8_500);
    await payPart(bill, 36_500);
    await runXeroSync(db);
    await runXeroSync(db);
    expect(xero.amountDue("INV-MS-1401")).toBe(0);
    expect(xero.api("PUT", `/CreditNotes/${xero.state.creditNotes[0].CreditNoteID}/Allocations`)).toHaveLength(1);
    expect(records("allocation")[0]).toMatchObject({ status: "pushed" });
  });

  it("nit. a 2xx whose body cannot be read is treated as maybe done: looked up, not sent again", async () => {
    await connect();
    approveObligation(db, story.stellar, "user:minh");
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Invoices"), times: 1, respond: () => "ok_unreadable" });
    await runXeroSync(db);
    expect(records("bill")[0]).toMatchObject({ status: "failed", uncertain: true });
    // Xero forgets the key; the look-up still finds the bill.
    xero.state.idem.clear();
    await runXeroSync(db, { force: true });
    expect(xero.state.invoices).toHaveLength(1);
  });

  it("nit. with Xero live, the bills file leaves out the bills the live push owns", async () => {
    await connect();
    approveObligation(db, story.stellar, "user:minh");
    const file = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.map((r) => r["*InvoiceNumber"]);
    expect(file).not.toContain("JOB-PAL3D-0927");
    expect(file).toContain("JOB-HG4D-0921"); // approved before connecting: the file's
    acc.destination = "csv";
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.map((r) => r["*InvoiceNumber"])).toContain("JOB-PAL3D-0927");
  });
});

describe("Review round 4", () => {
  it("M1. a payout that came back while its withheld part had failed is removed once and never re-created", async () => {
    await connect();
    noW9(true);
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_jake", { kind: "invoice", reference: "INV-JM-8101", totalMinor: 45_000, currency: "USD" });
    const id = await payPart(bill, 45_000);
    xero.injections.push({ when: (c) => c.method === "PUT" && c.url.pathname.endsWith("/Payments") && c.body.includes(':wh"'), times: 1, respond: () => xero.res(500, { Title: "Server error" }) });
    await runXeroSync(db);
    expect(records("withholding")[0]).toMatchObject({ status: "failed" });
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), id, "RETURN-8101");
    for (let i = 0; i < 4; i++) await runXeroSync(db, { force: true });
    const puts = xero.api("PUT", "/Payments");
    expect(puts.filter((c) => !c.body.includes(':wh"'))).toHaveLength(1);
    expect(puts.filter((c) => c.body.includes(':wh"'))).toHaveLength(1);
    expect(xero.state.payments.map((x) => x.Status)).toEqual(["DELETED"]);
    expect(records("withholding")[0]).toMatchObject({ status: "skipped" });
    expect(xeroCardView(db, DEMO_BUSINESS_ID).failures).toHaveLength(0);
  });

  it("M2. approve, sync, amend, sync, approve, sync, settle, sync: the bill is updated and the payment goes", async () => {
    await connect();
    approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    await amendObligation(db, story.stellar, "user:lan", { sourceRef: "JOB-PAL3D-0927-R" }, "Re-issued invoice");
    await runXeroSync(db);
    if (db.select().from(obligations).where(eq(obligations.id, story.stellar)).get()!.state !== "approved") approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    await executeObligation(db, story.stellar, { actor: "user:minh" });
    await confirmSettlement(db, story.stellar);
    await runXeroSync(db);
    expect(xero.state.invoices.map((i) => i.InvoiceNumber)).toEqual(["JOB-PAL3D-0927-R"]);
    expect(xero.state.payments).toHaveLength(1);
    expect(xero.amountDue("JOB-PAL3D-0927-R")).toBe(0);
  });

  it("2. the settlement CSV says which rows Xero already has", async () => {
    await connect();
    await settle(story.stellar);
    await runXeroSync(db);
    const lines = allRecordsCsv(db).csv.trim().split("\n");
    expect(lines[0].split(",").pop()).toBe("xeroPayment");
    expect(lines.find((l) => l.includes("JOB-PAL3D-0927"))!.split(",").pop()).toBe(`xero:${xero.state.payments[0].PaymentID}`);
  });

  it("3. a credit applied to a bill in the files stays in the files and asks a person to apply it in Xero", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-8301", totalMinor: 40_000, currency: "USD" });
    approveObligation(db, await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 20_000), "user:minh");
    await connect();
    const cn = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "credit_note", reference: "CN-MS-8301", totalMinor: 5_000, currency: "USD", note: "Short day" });
    applyCredit(db, DEMO_BUSINESS_ID, as("daniel"), cn, bill, 5_000);
    await runXeroSync(db);
    expect(xero.state.creditNotes).toHaveLength(0);
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.map((r) => r["*InvoiceNumber"])).toContain("CN-MS-8301");
    const f = xeroCardView(db, DEMO_BUSINESS_ID).failures.find((x) => x.label.includes("CN-MS-8301"))!;
    expect(f).toMatchObject({ needsPerson: true });
    expect(f.error).toMatch(/that bill is in the bills file, not sent to Xero\. Apply the credit to the bill in Xero by hand\.$/);
  });

  it("4. a deposit paid then the balance cancelled: the bill still open in Xero is put to a person", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-8401", totalMinor: 40_000, currency: "USD" });
    await payPart(bill, 20_000);
    await runXeroSync(db);
    const bal = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill, 20_000);
    approveObligation(db, bal, "user:minh");
    rejectObligation(db, bal, "user:minh", "Trip shortened");
    await runXeroSync(db);
    const f = xeroCardView(db, DEMO_BUSINESS_ID).failures.find((x) => x.label.includes("INV-MS-8401"))!;
    expect(f.error).toBe("Bill INV-MS-8401, Maria Santos: a part was cancelled here and the rest is paid, so the bill is still open by USD 200.00 in Xero. Adjust the bill or credit it in Xero.");
    expect(xero.state.invoices[0].Status).toBe("AUTHORISED");
  });

  it("5. one stuck after-send item keeps its own error and backoff and does not block the pass", async () => {
    await connect();
    approveObligation(db, story.stellar, "user:minh");
    await runXeroSync(db);
    const inv = xero.state.invoices[0];
    rejectObligation(db, story.stellar, "user:minh", "Trip cancelled");
    xero.injections.push({ when: (c) => c.method === "GET" && c.url.pathname.endsWith(`/Invoices/${inv.InvoiceID}`), times: 1, respond: () => xero.res(500, { Title: "Server error" }) });
    const vnd = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice INV-RL-8501 from Dao Mountain Lodge. Room block, USD 120.", evidence: [{ kind: "invoice", label: "Invoice INV-RL-8501", amountMinor: 12_000, currency: "USD", reference: "INV-RL-8501", excerpt: "Dao Mountain Lodge" }], actor: "user:lan" });
    approveObligation(db, vnd, "user:daniel");
    await runXeroSync(db);
    expect(xero.state.invoices.map((i) => i.InvoiceNumber)).toContain("INV-RL-8501");
    const stuck = xeroCardView(db, DEMO_BUSINESS_ID).failures.find((x) => x.label.includes("0927"))!;
    expect(stuck.error).toMatch(/voiding the bill did not go through \(Xero had a problem \(HTTP 500\)/);
    const rec = records("bill").find((r) => r.label.includes("0927"))!;
    expect(Date.parse(rec.nextAttemptAt!)).toBeGreaterThan(Date.now());
    await runXeroSync(db);
    expect(inv.Status).toBe("AUTHORISED"); // waiting its turn
    await runXeroSync(db, { force: true });
    expect(inv.Status).toBe("VOIDED");
  });

  it("6. a payment already deleted in Xero is taken as done, not deleted again", async () => {
    await connect();
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-8601", totalMinor: 20_000, currency: "USD" });
    const id = await payPart(bill, 20_000);
    await runXeroSync(db);
    xero.state.payments[0].Status = "DELETED"; // someone removed it in Xero
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), id, "RETURN-8601");
    await runXeroSync(db);
    expect(xero.calls.filter((c) => c.method === "POST" && c.url.pathname.includes("/Payments/"))).toHaveLength(0);
    expect(records("payment")[0]).toMatchObject({ status: "reversed" });
  });

  it("nit. the match-by-amount fallback never takes a withheld part for a payment", async () => {
    await connect();
    noW9(true);
    // Part A (100.00) withholds 24.00; part B (31.58) sends a net of exactly 24.00.
    const bill = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_jake", { kind: "invoice", reference: "INV-JM-8701", totalMinor: 13_158, currency: "USD" });
    await payPart(bill, 10_000);
    await runXeroSync(db);
    await payPart(bill, 3_158);
    await runXeroSync(db);
    expect(xero.state.payments.map((x) => x.Amount)).toEqual([76, 24, 24, 7.58]);
    expect(xero.amountDue("INV-JM-8701")).toBe(0);
  });

  it("nit. stuck settlements do not hold the first places: newer ones go on a later pass", async () => {
    process.env.XERO_SETTLEMENTS_PER_PASS = "2";
    try {
      await connect();
      const stuck: string[] = [];
      for (const ref of ["INV-MS-8801", "INV-MS-8802"]) {
        const b = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: ref, totalMinor: 10_000, currency: "USD" });
        stuck.push(await payPart(b, 10_000));
        // Their bills went out in a file and are not in Xero, so their payments cannot go.
        db.update(bills).set({ xeroExportedAt: "2026-11-01T00:00:00.000Z" }).where(eq(bills.id, b)).run();
        db.update(obligations).set({ xeroBillExportedAt: "2026-11-01T00:00:00.000Z" }).where(eq(obligations.billId, b)).run();
      }
      const c = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "invoice", reference: "INV-MS-8803", totalMinor: 10_000, currency: "USD" });
      await payPart(c, 10_000);
      await runXeroSync(db);
      await runXeroSync(db);
      expect(xero.state.payments).toHaveLength(1);
      expect(xero.amountDue("INV-MS-8803")).toBe(0);
    } finally {
      delete process.env.XERO_SETTLEMENTS_PER_PASS;
    }
  });

  it("nit. without a match for this sign-in's organisation, the connection is refused, not given another one", async () => {
    xero.state.access = jwt({ authentication_event_id: "evt-unknown", n: 1 });
    const start = handleXeroConnect(req("GET", "/api/xero/connect", OWNER), db);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const back = await handleXeroCallback(req("GET", `/api/xero/callback?code=good-code&state=${state}`, OWNER), db);
    expect(back.headers.get("location")).toContain("xero=failed");
    expect(conn()).toBeUndefined();
  });
});

describe("Mapping and disconnect", () => {
  it("saves a mapping only with accounts of the right kind from this organisation", async () => {
    await connect();
    const bad = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { paypalAccountCode: "429", taxType: "NONE" }), db);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe("PayPal: 429 General Expenses is the wrong kind of account (expense).");
    const missing = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "999", taxType: "NONE" }), db);
    expect(((await missing.json()) as { message: string }).message).toMatch(/not in this Xero organisation's chart/);
    const ok = await handleXeroMapping(req("POST", "/api/xero/mapping", OWNER, { expenseAccountCode: "400", paypalAccountCode: "092", stellarAccountCode: "091", bankAccountCode: "092", feeAccountCode: "404", taxType: "INPUT" }), db);
    expect(ok.status).toBe(200);
    expect(conn()).toMatchObject({ expenseAccountCode: "400", paypalAccountCode: "092", taxType: "INPUT" });
  });

  it("disconnect removes the connection at Xero, revokes the refresh token and wipes the tokens here", async () => {
    await connect();
    const r = await handleXeroDisconnect(req("DELETE", "/api/xero/connection", OWNER, {}), db);
    expect(r.status).toBe(200);
    expect(xero.state.deletedConnections).toEqual(["conn-1"]);
    expect(xero.state.revokedTokens).toEqual(["rt-1"]);
    expect(conn()).toMatchObject({ status: "disconnected", accessTokenEnc: "", refreshTokenEnc: "" });
    expect((await runXeroSync(db)).skipped).toBe("not_connected");
    expect(xeroCardView(db, DEMO_BUSINESS_ID).connected).toBe(false);
  });

  it("disconnect wipes locally even when Xero cannot be reached", async () => {
    await connect();
    xero.injections.push({ when: (c) => c.method === "DELETE", times: 1, respond: () => "network" });
    const r = await handleXeroDisconnect(req("DELETE", "/api/xero/connection", OWNER, {}), db);
    expect(((await r.json()) as { message: string }).message).toMatch(/Connected apps in Xero/);
    expect(conn()).toMatchObject({ status: "disconnected", accessTokenEnc: "", refreshTokenEnc: "" });
  });

  it("disconnect after the sign-in expired says what happened", async () => {
    await connect();
    db.update(xeroConnections).set({ status: "needs_reconnect" }).run();
    const n = xero.calls.length;
    const r = await handleXeroDisconnect(req("DELETE", "/api/xero/connection", OWNER, {}), db);
    expect(((await r.json()) as { message: string }).message).toBe("Disconnected here. The Xero sign-in had already expired, so Xero could not be told: remove Checkrail Pay under Connected apps in Xero.");
    expect(xero.calls.length).toBe(n);
    expect(conn()).toMatchObject({ status: "disconnected", accessTokenEnc: "", refreshTokenEnc: "" });
  });

  it("the card view carries no token or secret", async () => {
    await connect();
    connectedEarlier();
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
    ["disconnect", () => handleXeroDisconnect(req("DELETE", "/api/xero/connection", who, {}), db)],
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
