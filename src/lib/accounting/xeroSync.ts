import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { accountingSyncs, bills, businesses, obligations, xeroConnections, xeroRecords } from "../db/schema";
import { config } from "../config";
import { audit } from "../domain/stateMachine";
import { newId } from "../domain/ids";
import type { AccountingPayload } from "./record";
import { advancesAccount } from "./billLine";
import { toXeroFeeTransaction, toXeroPayment } from "./xero";
import { xeroBillRows, type XeroBillGroup } from "./xeroBills";
import { createXeroClient, XeroApiError, type XeroClient } from "./xeroClient";
import { getXeroConnection, type XeroConnectionRow } from "./xeroAuth";
import { parseChart, refreshXeroChart, type XeroChart } from "./xeroSettings";

/**
 * The live push to Xero. It runs beside the payment path, never in it:
 *
 *  - The hook is the accounting record itself. A bill is sent once its obligation is agreed (approved, sending, sent
 *    or settled): the same rows the "Import bills" file would carry, read with xeroBillRows. A payment and its fee are
 *    sent once the orchestrator has queued the settlement's accounting record (accounting_syncs, destination xero).
 *    Nothing in the orchestrator, the rails or the domain calls this file or waits for it.
 *  - It runs on the autopilot heartbeat (instrumentation-node.ts), on POST /api/autopilot/tick (not awaited), and on
 *    "Push to Xero". One pass at a time per business.
 *  - Every object sent is a row in xero_records with Xero's id. A pushed row is never sent again; a row whose last
 *    attempt got no answer is looked up in Xero before it is created again; writes carry an Idempotency-Key.
 *  - A failure is a plain sentence on that row, retried on the next pass after a short wait (1, 2, 4 ... up to 60
 *    minutes) or at once with the button. It never changes an obligation's state or a settlement.
 *  - A bill sent here is stamped exported, as the bills file would stamp it, so the file never carries it a second time.
 */

export interface XeroSyncResult {
  skipped?: "destination" | "not_connected" | "needs_reconnect" | "busy";
  pushed: number;
  failed: number;
  waiting: number;
  errors: string[];
  rateLimited: boolean;
}

const running = new Map<string, Promise<XeroSyncResult>>();

/** The most calls one pass makes; the rest wait for the next pass. Well under Xero's 60 a minute. */
const MAX_CALLS_PER_PASS = 40;

type RecordRow = typeof xeroRecords.$inferSelect;
type Kind = "contact" | "bill" | "credit_note" | "payment" | "fee";

class PassBudgetSpent extends Error {}

/** Xero dates are YYYY-MM-DD. */
const isoDay = (v: unknown) => String(v ?? "").slice(0, 10);
const hundredths = (v: unknown) => Math.round(Number(v || 0) * 100);

export function billKey(contactName: string, invoiceNumber: string): string {
  return `${contactName.trim().toLowerCase()}\u0000${invoiceNumber.trim()}`;
}

function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

export function runXeroSync(db: Db, opts: { businessId?: string; force?: boolean; now?: () => number } = {}): Promise<XeroSyncResult> {
  const businessId = opts.businessId ?? db.select({ id: businesses.id }).from(businesses).limit(1).get()?.id;
  const empty: XeroSyncResult = { pushed: 0, failed: 0, waiting: 0, errors: [], rateLimited: false };
  if (!businessId) return Promise.resolve({ ...empty, skipped: "not_connected" });
  const inFlight = running.get(businessId);
  if (inFlight) return opts.force ? inFlight : Promise.resolve({ ...empty, skipped: "busy" });
  const p = pass(db, businessId, opts.force ?? false, opts.now ?? Date.now).finally(() => running.delete(businessId));
  running.set(businessId, p);
  return p;
}

/** For the heartbeat: never throws, never logs a token. */
export function runXeroSyncInBackground(db: Db): void {
  if (config.accounting.destination !== "xero") return;
  runXeroSync(db).catch((e) => console.error("[xero] pass failed:", (e as Error).message));
}

async function pass(db: Db, businessId: string, force: boolean, now: () => number): Promise<XeroSyncResult> {
  const result: XeroSyncResult = { pushed: 0, failed: 0, waiting: 0, errors: [], rateLimited: false };
  if (config.accounting.destination !== "xero") return { ...result, skipped: "destination" };
  let conn = getXeroConnection(db, businessId);
  if (!conn) return { ...result, skipped: "not_connected" };
  if (conn.status !== "connected") return { ...result, skipped: "needs_reconnect", errors: [conn.lastError ?? "Connect to Xero again."] };

  const groups = xeroBillRows(db, businessId, { onlyNew: true }).groups;
  const settlements = db
    .select({ s: accountingSyncs })
    .from(accountingSyncs)
    .innerJoin(obligations, eq(obligations.id, accountingSyncs.obligationId))
    .where(and(eq(obligations.businessId, businessId), eq(accountingSyncs.destination, "xero"), eq(accountingSyncs.status, "pending")))
    .all()
    .map((r) => r.s);
  if (!groups.length && !settlements.length) return result;

  let budget = MAX_CALLS_PER_PASS;
  const base = createXeroClient(db, businessId, conn.tenantId, { now });
  const client: XeroClient = {
    tenantId: base.tenantId,
    async request<T>(req: Parameters<XeroClient["request"]>[0]): Promise<T> {
      // This pass has used its share; the rest goes on the next one. Not an error for anyone to read.
      if (budget-- <= 0) throw new PassBudgetSpent();
      return base.request<T>(req);
    },
  };

  try {
    if (!conn.chartJson) {
      await refreshXeroChart(db, businessId);
      conn = getXeroConnection(db, businessId)!;
    }
    const ctx: Ctx = { db, businessId, conn, chart: parseChart(conn.chartJson), client, now, force, result };
    for (const g of groups) await pushBillGroup(ctx, g);
    for (const s of settlements) await pushSettlement(ctx, s);
  } catch (e) {
    if (e instanceof PassBudgetSpent) {
      result.rateLimited = true;
    } else if (e instanceof XeroApiError && e.kind === "rate_limited") {
      result.rateLimited = true;
      result.errors.push((e as Error).message);
    } else if (e instanceof XeroApiError && e.kind === "auth") {
      result.errors.push(e.message);
    } else {
      throw e;
    }
  }
  const ts = new Date(now()).toISOString();
  db.update(xeroConnections)
    .set({ ...(result.pushed ? { lastPushAt: ts } : {}), lastError: result.errors[0] ?? null, updatedAt: ts })
    .where(eq(xeroConnections.businessId, businessId))
    .run();
  return result;
}

interface Ctx {
  db: Db;
  businessId: string;
  conn: XeroConnectionRow;
  chart: XeroChart | null;
  client: XeroClient;
  now: () => number;
  force: boolean;
  result: XeroSyncResult;
}

function recordFor(ctx: Ctx, kind: Kind, localKey: string, label: string, extra: { obligationId?: string | null; accountingSyncId?: string | null } = {}): RecordRow {
  const where = and(eq(xeroRecords.businessId, ctx.businessId), eq(xeroRecords.tenantId, ctx.conn.tenantId), eq(xeroRecords.kind, kind), eq(xeroRecords.localKey, localKey));
  const found = ctx.db.select().from(xeroRecords).where(where).get();
  if (found) return found;
  const ts = new Date(ctx.now()).toISOString();
  ctx.db
    .insert(xeroRecords)
    .values({ id: newId("xr"), businessId: ctx.businessId, tenantId: ctx.conn.tenantId, kind, localKey, label, obligationId: extra.obligationId ?? null, accountingSyncId: extra.accountingSyncId ?? null, status: "pending", createdAt: ts, updatedAt: ts })
    .onConflictDoNothing()
    .run();
  return ctx.db.select().from(xeroRecords).where(where).get()!;
}

/** Not yet due for another try (a failure waits a little), unless a person pressed the button. */
function waiting(ctx: Ctx, r: RecordRow): boolean {
  return !ctx.force && r.status === "failed" && r.nextAttemptAt !== null && Date.parse(r.nextAttemptAt) > ctx.now();
}

const idemKey = (r: RecordRow) => `checkrail-${r.id}-${r.keySeq}`;

function markPushed(ctx: Ctx, r: RecordRow, xeroId: string): void {
  const ts = new Date(ctx.now()).toISOString();
  ctx.db.update(xeroRecords).set({ status: "pushed", xeroId, error: null, uncertain: false, nextAttemptAt: null, pushedAt: ts, attempts: r.attempts + 1, updatedAt: ts }).where(eq(xeroRecords.id, r.id)).run();
  if (r.kind !== "contact") ctx.result.pushed++;
}

/** Keep the failure on the row in plain words. A definite refusal moves the idempotency key on; no answer keeps it, so the retry is the same request. */
function markFailed(ctx: Ctx, r: RecordRow, message: string, uncertain = false): void {
  const ts = new Date(ctx.now()).toISOString();
  const attempts = r.attempts + 1;
  const waitMin = uncertain ? 1 : backoffMinutes(attempts);
  ctx.db
    .update(xeroRecords)
    .set({ status: "failed", error: message, attempts, uncertain, keySeq: uncertain ? r.keySeq : r.keySeq + 1, nextAttemptAt: new Date(ctx.now() + waitMin * 60_000).toISOString(), updatedAt: ts })
    .where(eq(xeroRecords.id, r.id))
    .run();
  if (r.kind !== "contact") ctx.result.failed++;
  if (!ctx.result.errors.includes(message)) ctx.result.errors.push(message);
}

/**
 * Run one create against Xero for a record. Rate limits stop the whole pass (the record is untouched and goes next
 * time); an auth failure stops it too; anything else is kept on the record.
 */
async function attempt(ctx: Ctx, r: RecordRow, create: () => Promise<string>, lookup?: () => Promise<string | null>): Promise<string | null> {
  try {
    if (r.uncertain && lookup) {
      // The last try got no answer: it may have worked. Look before creating again.
      const existing = await lookup();
      if (existing) {
        markPushed(ctx, r, existing);
        return existing;
      }
    }
    const id = await create();
    markPushed(ctx, r, id);
    return id;
  } catch (e) {
    if (e instanceof XeroApiError && (e.kind === "rate_limited" || e.kind === "auth")) throw e;
    if (e instanceof PlainFailure) {
      markFailed(ctx, r, e.message);
      return null;
    }
    if (e instanceof XeroApiError) {
      markFailed(ctx, r, e.message, e.uncertain);
      return null;
    }
    throw e;
  }
}

/** A problem Checkrail can see before calling Xero (no account chosen, currency not turned on). */
class PlainFailure extends Error {}

function checkCurrency(ctx: Ctx, currency: string): void {
  const c = ctx.chart;
  if (!c || !c.baseCurrency || currency === c.baseCurrency || c.currencies.includes(currency)) return;
  throw new PlainFailure(`Your Xero organisation does not have ${currency} turned on. Add it in Xero (Accounting, Advanced, Currencies), then press Push to Xero.`);
}

/** The account a bill line posts to. The bill's own code when the chart has it; for an expense, the chosen expense account otherwise. */
function lineAccount(ctx: Ctx, code: string): string {
  const c = ctx.chart;
  if (!c || !c.accounts.length || c.accounts.some((a) => a.code === code)) return code;
  const withholding = process.env.XERO_WITHHOLDING_ACCOUNT || "825";
  if (code === withholding) throw new PlainFailure(`Account ${code} (tax withheld) is not in your Xero chart of accounts. Add it in Xero, or set XERO_WITHHOLDING_ACCOUNT to the liability account you use.`);
  if (code === advancesAccount()) throw new PlainFailure(`Account ${code} (prepayments, for cash advances) is not in your Xero chart of accounts. Add it in Xero, or set XERO_ADVANCES_ACCOUNT.`);
  if (!ctx.conn.expenseAccountCode) throw new PlainFailure(`Account ${code} is not in your Xero chart of accounts. Choose the account for supplier bills in Settings, Xero.`);
  return ctx.conn.expenseAccountCode;
}

function taxTypeFor(ctx: Ctx): string | undefined {
  return ctx.conn.taxType ?? undefined;
}

function tracking(ctx: Ctx, name: unknown, option: unknown): Array<{ Name: string; Option: string }> | undefined {
  if (!name || !option) return undefined;
  // Only a category and option the organisation has: Xero refuses an unknown one, and the bill matters more than the tag.
  const cat = ctx.chart?.tracking.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  const opt = cat?.options.find((o) => o.toLowerCase() === String(option).toLowerCase());
  return cat && opt ? [{ Name: cat.name, Option: opt }] : undefined;
}

/** Find a contact by name, else create it. One record per name, so a vendor is looked up once. */
async function contactId(ctx: Ctx, name: string, extra: { email?: string | null; country?: string | null } = {}): Promise<string> {
  const r = recordFor(ctx, "contact", name.trim().toLowerCase(), `Contact ${name}`);
  if (r.status === "pushed" && r.xeroId) return r.xeroId;
  const find = async () => {
    const res = await ctx.client.request<{ Contacts: Array<{ ContactID: string; Name: string }> }>({ method: "GET", path: "/Contacts", query: { where: `Name=="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` } });
    return res.Contacts?.find((c) => c.Name.trim().toLowerCase() === name.trim().toLowerCase())?.ContactID ?? res.Contacts?.[0]?.ContactID ?? null;
  };
  try {
    const existing = await find();
    if (existing) {
      markPushed(ctx, r, existing);
      return existing;
    }
    const body = { Contacts: [{ Name: name, ...(extra.email ? { EmailAddress: extra.email } : {}), ...(extra.country ? { Addresses: [{ AddressType: "POBOX", Country: extra.country }] } : {}) }] };
    const res = await ctx.client.request<{ Contacts: Array<{ ContactID: string }> }>({ method: "PUT", path: "/Contacts", body, idempotencyKey: idemKey(r) });
    const id = res.Contacts?.[0]?.ContactID;
    if (!id) throw new XeroApiError("Xero did not return the new contact.", "validation");
    markPushed(ctx, r, id);
    return id;
  } catch (e) {
    if (e instanceof XeroApiError && (e.kind === "rate_limited" || e.kind === "auth")) throw e;
    if (e instanceof XeroApiError) {
      markFailed(ctx, r, e.message, e.uncertain);
      throw new PlainFailure(`Contact ${name}: ${e.message}`);
    }
    throw e;
  }
}

async function pushBillGroup(ctx: Ctx, g: XeroBillGroup): Promise<void> {
  const first = g.rows[0];
  if (!first) return;
  const contactName = String(first["*ContactName"]);
  const number = String(first["*InvoiceNumber"]);
  const currency = String(first.Currency ?? "");
  const kind: Kind = g.kind === "credit_note" ? "credit_note" : "bill";
  const r = recordFor(ctx, kind, billKey(contactName, number), `${kind === "bill" ? "Bill" : "Credit note"} ${number}, ${contactName}`, { obligationId: g.obligationIds[0] ?? null });
  if (r.status !== "pushed") {
    if (waiting(ctx, r)) {
      ctx.result.waiting++;
      return;
    }
    const lookup = async () => {
      if (kind === "credit_note") {
        const res = await ctx.client.request<{ CreditNotes: Array<{ CreditNoteID: string; Status: string }> }>({ method: "GET", path: "/CreditNotes", query: { where: `CreditNoteNumber=="${number.replace(/"/g, '\\"')}"` } });
        return res.CreditNotes?.find((c) => c.Status !== "DELETED" && c.Status !== "VOIDED")?.CreditNoteID ?? null;
      }
      return findBill(ctx, number, contactName);
    };
    const created = await attempt(
      ctx,
      r,
      async () => {
        checkCurrency(ctx, currency);
        const id = await contactId(ctx, contactName, { email: first.EmailAddress as string | null, country: first.POCountry as string | null });
        const lines = g.rows.map((row) => {
          const amount = Number(row["*UnitAmount"]);
          return {
            Description: String(row.Description ?? number),
            Quantity: 1,
            // A credit note is entered positive in the API; the file carries it negative.
            UnitAmount: kind === "credit_note" ? Math.abs(amount) : amount,
            AccountCode: lineAccount(ctx, String(row["*AccountCode"])),
            ...(taxTypeFor(ctx) ? { TaxType: taxTypeFor(ctx) } : {}),
            ...(tracking(ctx, row.TrackingName1, row.TrackingOption1) ? { Tracking: tracking(ctx, row.TrackingName1, row.TrackingOption1) } : {}),
          };
        });
        if (kind === "credit_note") {
          const res = await ctx.client.request<{ CreditNotes: Array<{ CreditNoteID: string }> }>({
            method: "PUT",
            path: "/CreditNotes",
            idempotencyKey: idemKey(r),
            body: { CreditNotes: [{ Type: "ACCPAYCREDIT", Contact: { ContactID: id }, Date: isoDay(first["*InvoiceDate"]), CreditNoteNumber: number, CurrencyCode: currency, Status: "AUTHORISED", LineItems: lines }] },
          });
          const cid = res.CreditNotes?.[0]?.CreditNoteID;
          if (!cid) throw new XeroApiError("Xero did not return the credit note.", "validation");
          return cid;
        }
        const res = await ctx.client.request<{ Invoices: Array<{ InvoiceID: string }> }>({
          method: "PUT",
          path: "/Invoices",
          idempotencyKey: idemKey(r),
          body: { Invoices: [{ Type: "ACCPAY", Contact: { ContactID: id }, Date: isoDay(first["*InvoiceDate"]), DueDate: isoDay(first["*DueDate"]), InvoiceNumber: number, Reference: "Checkrail Pay", CurrencyCode: currency, Status: "AUTHORISED", LineItems: lines }] },
        });
        const iid = res.Invoices?.[0]?.InvoiceID;
        if (!iid) throw new XeroApiError("Xero did not return the bill.", "validation");
        return iid;
      },
      lookup,
    );
    if (!created) return;
    audit(ctx.db, { obligationId: g.obligationIds[0] ?? null, actor: "system", action: "accounting.xero_bill_pushed", detail: { invoice: number, contact: contactName, kind } });
  }
  // In Xero now: stamp it as the bills file would, so the file never carries it a second time.
  const ts = new Date(ctx.now()).toISOString();
  if (g.obligationIds.length) ctx.db.update(obligations).set({ xeroBillExportedAt: ts }).where(inArray(obligations.id, g.obligationIds)).run();
  if (g.billId) ctx.db.update(bills).set({ xeroExportedAt: ts }).where(eq(bills.id, g.billId)).run();
}

/** A bill already in Xero (sent here, or imported from the bills file): by invoice number, for this contact when there are several. */
async function findBill(ctx: Ctx, number: string, contactName: string): Promise<string | null> {
  const res = await ctx.client.request<{ Invoices: Array<{ InvoiceID: string; Status: string; Contact?: { Name?: string } }> }>({ method: "GET", path: "/Invoices", query: { where: `Type=="ACCPAY"&&InvoiceNumber=="${number.replace(/"/g, '\\"')}"` } });
  const live = (res.Invoices ?? []).filter((i) => i.Status !== "DELETED" && i.Status !== "VOIDED");
  return (live.find((i) => i.Contact?.Name?.trim().toLowerCase() === contactName.trim().toLowerCase()) ?? live[0])?.InvoiceID ?? null;
}

function bankFor(ctx: Ctx, rail: string): string {
  const code = rail === "paypal" ? ctx.conn.paypalAccountCode : rail === "stellar" ? ctx.conn.stellarAccountCode : ctx.conn.bankAccountCode;
  if (code) return code;
  const name = rail === "paypal" ? "PayPal" : rail === "stellar" ? "the Stellar treasury" : "Wise and bank file";
  throw new PlainFailure(`Choose the Xero bank account for ${name} payments in Settings, Xero.`);
}

async function pushSettlement(ctx: Ctx, s: typeof accountingSyncs.$inferSelect): Promise<void> {
  const p = JSON.parse(s.payloadJson ?? "{}") as AccountingPayload;
  if (!p.reference || !p.vendorName) return;
  const pay = recordFor(ctx, "payment", s.id, `Payment ${p.reference}, ${p.vendorName}`, { obligationId: s.obligationId, accountingSyncId: s.id });
  const needsFee = hundredths(p.feeAmount) > 0 && p.rail !== "stellar";
  const fee = needsFee ? recordFor(ctx, "fee", s.id, `Fee on ${p.reference} (${p.rail})`, { obligationId: s.obligationId, accountingSyncId: s.id }) : null;

  if (pay.status !== "pushed") {
    if (waiting(ctx, pay)) {
      ctx.result.waiting++;
      return;
    }
    const done = await attempt(
      ctx,
      pay,
      async () => {
        checkCurrency(ctx, p.grossCurrency);
        const bank = bankFor(ctx, p.rail);
        const billRecord = ctx.db.select().from(xeroRecords).where(and(eq(xeroRecords.businessId, ctx.businessId), eq(xeroRecords.tenantId, ctx.conn.tenantId), eq(xeroRecords.kind, "bill"), eq(xeroRecords.localKey, billKey(p.vendorName, p.reference)))).get();
        const invoiceId = billRecord?.status === "pushed" && billRecord.xeroId ? billRecord.xeroId : await findBill(ctx, p.reference, p.vendorName);
        if (!invoiceId) throw new PlainFailure(`The bill ${p.reference} is not in Xero yet, so its payment cannot be matched to it. It goes once the bill is there.`);
        const body = toXeroPayment(p, bank);
        const res = await ctx.client.request<{ Payments: Array<{ PaymentID: string }> }>({
          method: "PUT",
          path: "/Payments",
          idempotencyKey: idemKey(pay),
          body: { Payments: [{ ...body, Invoice: { InvoiceID: invoiceId }, Date: isoDay(body.Date) }] },
        });
        const id = res.Payments?.[0]?.PaymentID;
        if (!id) throw new XeroApiError("Xero did not return the payment.", "validation");
        return id;
      },
      async () => {
        const res = await ctx.client.request<{ Payments: Array<{ PaymentID: string; Status?: string }> }>({ method: "GET", path: "/Payments", query: { where: `Reference=="${`${p.rail}:${p.externalTransactionId}`.replace(/"/g, '\\"')}"` } });
        return res.Payments?.find((x) => x.Status !== "DELETED")?.PaymentID ?? null;
      },
    );
    if (!done) return;
  }

  if (fee && fee.status !== "pushed") {
    if (waiting(ctx, fee)) {
      ctx.result.waiting++;
      return;
    }
    const done = await attempt(
      ctx,
      fee,
      async () => {
        const bank = bankFor(ctx, p.rail);
        if (!ctx.conn.feeAccountCode) throw new PlainFailure("Choose the Xero account for payment fees in Settings, Xero.");
        const tx = toXeroFeeTransaction(p, bank, ctx.conn.feeAccountCode)!;
        const contact = await contactId(ctx, tx.Contact.Name);
        const res = await ctx.client.request<{ BankTransactions: Array<{ BankTransactionID: string }> }>({
          method: "PUT",
          path: "/BankTransactions",
          idempotencyKey: idemKey(fee),
          body: { BankTransactions: [{ ...tx, Contact: { ContactID: contact }, Date: isoDay(tx.Date), CurrencyCode: p.feeCurrency || p.grossCurrency, LineAmountTypes: "NoTax" }] },
        });
        const id = res.BankTransactions?.[0]?.BankTransactionID;
        if (!id) throw new XeroApiError("Xero did not return the fee transaction.", "validation");
        return id;
      },
      async () => {
        const res = await ctx.client.request<{ BankTransactions: Array<{ BankTransactionID: string; Status?: string }> }>({ method: "GET", path: "/BankTransactions", query: { where: `Reference=="fee ${p.reference.replace(/"/g, '\\"')}"` } });
        return res.BankTransactions?.find((x) => x.Status !== "DELETED")?.BankTransactionID ?? null;
      },
    );
    if (!done) return;
  }

  const paymentId = ctx.db.select({ x: xeroRecords.xeroId }).from(xeroRecords).where(eq(xeroRecords.id, pay.id)).get()?.x;
  const ts = new Date(ctx.now()).toISOString();
  ctx.db.update(accountingSyncs).set({ status: "synced", externalRef: `xero:${paymentId}`, updatedAt: ts }).where(eq(accountingSyncs.id, s.id)).run();
  audit(ctx.db, { obligationId: s.obligationId, actor: "system", action: "accounting.xero_payment_pushed", detail: { reference: p.reference, fee: needsFee } });
}

