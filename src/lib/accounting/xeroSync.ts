import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { accountingSyncs, auditEntries, billAllocations, bills, businesses, obligations, xeroConnections, xeroRecords } from "../db/schema";
import { config } from "../config";
import { audit } from "../domain/stateMachine";
import { newId } from "../domain/ids";
import type { AccountingPayload } from "./record";
import { advancesAccount } from "./billLine";
import { toXeroFeeTransaction, toXeroPayment, xeroFeeReference } from "./xero";
import { xeroBillRows, type XeroBillGroup } from "./xeroBills";
import { createXeroClient, XeroApiError, type XeroClient, type XeroRequest } from "./xeroClient";
import { getXeroConnection, type XeroConnectionRow } from "./xeroAuth";
import { parseChart, refreshXeroChart, type XeroChart } from "./xeroSettings";
import { billApprovedAt, splitGroups } from "./xeroScope";

/**
 * The live push to Xero. It runs beside the payment path, never in it:
 *
 *  - The hook is the accounting record itself. A bill is sent once its obligation is agreed (approved, sending, sent
 *    or settled): the same rows the "Import bills" file would carry, read with xeroBillRows. A payment and its fee are
 *    sent once the orchestrator has queued the settlement's accounting record (accounting_syncs). Progress is kept
 *    here, in xero_records, never in accounting_syncs.status, so exporting the CSV does not stop a record going to Xero.
 *    Nothing in the orchestrator, the rails or the domain calls this file or waits for it.
 *  - Only what was approved after Xero was connected goes (xeroScope.ts); earlier bills stay in the files.
 *  - It runs on the autopilot heartbeat (instrumentation-node.ts), on POST /api/autopilot/tick (not awaited), and on
 *    "Push to Xero". One pass at a time per business across every server process: a lease row with an expiry.
 *  - Every object sent is a row in xero_records with Xero's id, keyed on something that survives a demo reset (the
 *    contact name; the contact and invoice number; the obligation, rail and provider transaction id). Before each
 *    create call the row is marked "sending" with its Idempotency-Key. A row still "sending" on a later pass (the
 *    process stopped between Xero's answer and the save), or one whose last call got no answer, is looked up in Xero
 *    before anything is created again. Bills and payments are always looked up first.
 *  - A failure is a plain sentence on that row, retried on a later pass after a short wait (1, 2, 4 ... up to 60
 *    minutes) or at once with the button. It never changes an obligation's state or a settlement.
 *  - A bill sent here is stamped exported, as the bills file would stamp it, so the file does not carry it again.
 */

export interface XeroSyncResult {
  skipped?: "destination" | "not_connected" | "needs_reconnect" | "busy" | "chart_wait";
  pushed: number;
  failed: number;
  waiting: number;
  errors: string[];
  rateLimited: boolean;
}

/** The most settled payments one pass reads; the rest are read on the next pass. */
const MAX_SETTLEMENTS_PER_PASS = 100;
/** The most calls one pass makes; the rest wait for the next pass. Well under Xero's 60 a minute. */
const MAX_CALLS_PER_PASS = 40;
/** A pass holds the lease this long and renews it before every call; a crashed process loses it when it runs out. */
export const LEASE_MS = 90_000;

type RecordRow = typeof xeroRecords.$inferSelect;
/** "settlement" marks one accounting record as finished (payment and fee in Xero, or left to the files), so it is not read again. */
type Kind = "contact" | "bill" | "credit_note" | "payment" | "withholding" | "fee" | "settlement" | "allocation";

/** This pass has used its share of calls, or another process took over: stop quietly, the next pass carries on. */
class PassPaused extends Error {}
/** A problem Checkrail can see before calling Xero (no account chosen, currency not turned on). */
class PlainFailure extends Error {}

/** Xero dates are YYYY-MM-DD. */
const isoDay = (v: unknown) => String(v ?? "").slice(0, 10);
const hundredths = (v: unknown) => Math.round(Number(v || 0) * 100);
const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function billKey(contactName: string, invoiceNumber: string): string {
  return `${contactName.trim().toLowerCase()}\u0000${invoiceNumber.trim()}`;
}

/** A payment's natural key: the obligation, the rail and the provider's own transaction id. */
export function paymentKey(p: Pick<AccountingPayload, "obligationId" | "rail" | "externalTransactionId">): string {
  return `${p.obligationId}|${p.rail}|${p.externalTransactionId}`;
}

function backoffMinutes(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

const empty = (): XeroSyncResult => ({ pushed: 0, failed: 0, waiting: 0, errors: [], rateLimited: false });

export async function runXeroSync(db: Db, opts: { businessId?: string; force?: boolean; now?: () => number } = {}): Promise<XeroSyncResult> {
  const businessId = opts.businessId ?? db.select({ id: businesses.id }).from(businesses).limit(1).get()?.id;
  const now = opts.now ?? Date.now;
  if (!businessId) return { ...empty(), skipped: "not_connected" };
  if (config.accounting.destination !== "xero") return { ...empty(), skipped: "destination" };
  const conn = getXeroConnection(db, businessId);
  if (!conn) return { ...empty(), skipped: "not_connected" };
  if (conn.status !== "connected") return { ...empty(), skipped: "needs_reconnect", errors: [conn.lastError ?? "Connect to Xero again."] };
  // One pass at a time, across processes. A forced push does not wait for a running one: it says so and returns.
  const owner = newId("lease");
  const nowIso = new Date(now()).toISOString();
  const got = db
    .update(xeroConnections)
    .set({ leaseOwner: owner, leaseUntil: new Date(now() + LEASE_MS).toISOString() })
    .where(and(eq(xeroConnections.businessId, businessId), or(isNull(xeroConnections.leaseUntil), lt(xeroConnections.leaseUntil, nowIso))))
    .run();
  if (got.changes !== 1) return { ...empty(), skipped: "busy", errors: ["A push to Xero is already running. It finishes on its own."] };
  try {
    return await pass(db, businessId, owner, opts.force ?? false, now);
  } finally {
    db.update(xeroConnections).set({ leaseOwner: null, leaseUntil: null }).where(and(eq(xeroConnections.businessId, businessId), eq(xeroConnections.leaseOwner, owner))).run();
  }
}

/** For the heartbeat: never throws, never logs a token. */
export function runXeroSyncInBackground(db: Db): void {
  if (config.accounting.destination !== "xero") return;
  runXeroSync(db).catch((e) => console.error("[xero] pass failed:", (e as Error).message));
}

/**
 * After a demo reset: forget what was sent (the demo's obligations are new rows) and start the live push from now, so
 * the re-seeded history stays in the files. The connection and its account mapping stay.
 */
export function resetXeroSyncState(db: Db, businessId: string): void {
  db.delete(xeroRecords).where(eq(xeroRecords.businessId, businessId)).run();
  const ts = new Date().toISOString();
  db.update(xeroConnections)
    // The lease is left alone: a pass running now finishes (or expires) on its own.
    .set({ syncFrom: ts, lastPushAt: null, lastError: null, blockedUntil: null, rateWindowStart: null, rateWindowCalls: 0, chartAttempts: 0, chartRetryAt: null, updatedAt: ts })
    .where(eq(xeroConnections.businessId, businessId))
    .run();
}

interface SettlementItem {
  sync: typeof accountingSyncs.$inferSelect;
  payload: AccountingPayload;
}

/**
 * Settled payments not yet finished, oldest first and at most MAX_SETTLEMENTS_PER_PASS: a record is finished once its
 * payment and fee are in Xero, or once it is found to belong to the files, and is then never read again. A payment goes
 * live only when its bill does: the bill's first approval (any part) must be after the connection, so a bill split
 * across the connect time stays wholly in the files.
 */
function pendingSettlements(db: Db, conn: XeroConnectionRow): SettlementItem[] {
  const rows = db
    .select({ s: accountingSyncs })
    .from(accountingSyncs)
    .innerJoin(obligations, eq(obligations.id, accountingSyncs.obligationId))
    .where(
      and(
        eq(obligations.businessId, conn.businessId),
        gte(accountingSyncs.createdAt, conn.syncFrom),
        sql`NOT EXISTS (SELECT 1 FROM xero_records r WHERE r.accounting_sync_id = ${accountingSyncs.id} AND r.kind = 'settlement' AND r.business_id = ${conn.businessId} AND r.tenant_id = ${conn.tenantId})`,
      ),
    )
    .orderBy(asc(accountingSyncs.createdAt))
    .limit(MAX_SETTLEMENTS_PER_PASS)
    .all()
    .map((r) => r.s);
  if (!rows.length) return [];
  const when = billApprovedAt(db, rows.map((r) => r.obligationId));
  const out: SettlementItem[] = [];
  for (const sync of rows) {
    const payload = JSON.parse(sync.payloadJson ?? "{}") as AccountingPayload;
    if ((when.get(sync.obligationId) ?? "") < conn.syncFrom || !payload.reference || !payload.vendorName) {
      finishSettlement(db, conn, sync, "skipped", "Approved before Xero was connected: it stays in the bills file and the settlement CSV.");
      continue;
    }
    out.push({ sync, payload });
  }
  return out;
}

function finishSettlement(db: Db, conn: XeroConnectionRow, sync: typeof accountingSyncs.$inferSelect, status: "pushed" | "skipped", note: string | null): void {
  const ts = new Date().toISOString();
  db.insert(xeroRecords)
    .values({ id: newId("xr"), businessId: conn.businessId, tenantId: conn.tenantId, kind: "settlement", localKey: sync.id, label: `Settlement ${sync.id}`, obligationId: sync.obligationId, accountingSyncId: sync.id, status, error: note, pushedAt: status === "pushed" ? ts : null, createdAt: ts, updatedAt: ts })
    .onConflictDoNothing()
    .run();
}

async function pass(db: Db, businessId: string, owner: string, force: boolean, now: () => number): Promise<XeroSyncResult> {
  const result = empty();
  let conn = getXeroConnection(db, businessId)!;
  const { live } = splitGroups(db, xeroBillRows(db, businessId, { onlyNew: true, includeLive: true }).groups, conn.syncFrom);
  const settlements = pendingSettlements(db, conn);
  const upkeep = findUpkeep(db, conn);
  if (!live.length && !settlements.length && !upkeep.any) return result;

  let budget = MAX_CALLS_PER_PASS;
  const base = createXeroClient(db, businessId, conn.tenantId, { now });
  const client: XeroClient = {
    tenantId: base.tenantId,
    async request<T>(req: XeroRequest): Promise<T> {
      if (budget-- <= 0) throw new PassPaused();
      // Renew the lease; if another process holds it now (this one stalled past its expiry), stop.
      const renewed = db.update(xeroConnections).set({ leaseUntil: new Date(now() + LEASE_MS).toISOString() }).where(and(eq(xeroConnections.businessId, businessId), eq(xeroConnections.leaseOwner, owner))).run();
      if (renewed.changes !== 1) throw new PassPaused();
      return base.request<T>(req);
    },
  };

  const ts = () => new Date(now()).toISOString();
  try {
    if (!conn.chartJson) {
      // The chart of accounts is needed to post anything. A failure here waits and backs off like any other.
      if (!force && conn.chartRetryAt && Date.parse(conn.chartRetryAt) > now()) return { ...result, skipped: "chart_wait", errors: [conn.lastError ?? "Waiting to read the chart of accounts again."] };
      try {
        // Through this pass's client: the same lease renewal and call budget as every other call.
        await refreshXeroChart(db, businessId, client);
        db.update(xeroConnections).set({ chartAttempts: 0, chartRetryAt: null }).where(eq(xeroConnections.businessId, businessId)).run();
      } catch (e) {
        const attempts = conn.chartAttempts + 1;
        const message = `Could not read the chart of accounts from Xero: ${e instanceof XeroApiError ? e.message : "unexpected answer"}`;
        db.update(xeroConnections).set({ chartAttempts: attempts, chartRetryAt: new Date(now() + backoffMinutes(attempts) * 60_000).toISOString(), lastError: message, updatedAt: ts() }).where(eq(xeroConnections.businessId, businessId)).run();
        if (!(e instanceof XeroApiError)) console.error("[xero] chart read failed:", (e as Error).message);
        return { ...result, failed: 1, errors: [message], rateLimited: e instanceof XeroApiError && e.kind === "rate_limited" };
      }
      conn = getXeroConnection(db, businessId)!;
    }
    const ctx: Ctx = { db, businessId, conn, chart: parseChart(conn.chartJson), client, now, force, result };
    // Changes after a bill went: cancelled bills are voided, payouts that came back are taken off, amended bills updated.
    await voidCancelled(ctx, upkeep.cancelled);
    await reverseReturned(ctx, upkeep.returned);
    if (upkeep.amended.length) await updateAmended(ctx, upkeep.amended);
    for (const g of live) await pushBillGroup(ctx, g);
    // Credits before payments, so each payment fits what is still owed.
    await pushAllocations(ctx, upkeep.allocations);
    for (const s of settlements) await pushSettlement(ctx, s);
  } catch (e) {
    if (e instanceof PassPaused) {
      result.rateLimited = true;
    } else if (e instanceof XeroApiError && e.kind === "rate_limited") {
      result.rateLimited = true;
      result.errors.push(e.message);
    } else if (e instanceof XeroApiError && e.kind === "auth") {
      result.errors.push(e.message);
    } else {
      // Never a 500 for the button, never a crash for the heartbeat: say it, log it, try again next pass.
      console.error("[xero] pass stopped:", (e as Error).message);
      result.errors.push("Sending to Xero stopped on an unexpected error. It will be tried again.");
    }
  }
  db.update(xeroConnections)
    .set({ ...(result.pushed ? { lastPushAt: ts() } : {}), lastError: result.errors[0] ?? null, updatedAt: ts() })
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

const recordWhere = (ctx: Ctx, kind: Kind, localKey: string) => and(eq(xeroRecords.businessId, ctx.businessId), eq(xeroRecords.tenantId, ctx.conn.tenantId), eq(xeroRecords.kind, kind), eq(xeroRecords.localKey, localKey));

function findRecord(ctx: Ctx, kind: Kind, localKey: string): RecordRow | null {
  return ctx.db.select().from(xeroRecords).where(recordWhere(ctx, kind, localKey)).get() ?? null;
}

function recordFor(ctx: Ctx, kind: Kind, localKey: string, label: string, extra: { obligationId?: string | null; accountingSyncId?: string | null; parentKey?: string | null; amount?: string | null } = {}): RecordRow {
  const found = findRecord(ctx, kind, localKey);
  if (found) return found;
  const ts = new Date(ctx.now()).toISOString();
  ctx.db
    .insert(xeroRecords)
    .values({ id: newId("xr"), businessId: ctx.businessId, tenantId: ctx.conn.tenantId, kind, localKey, label, obligationId: extra.obligationId ?? null, accountingSyncId: extra.accountingSyncId ?? null, parentKey: extra.parentKey ?? null, amount: extra.amount ?? null, status: "pending", createdAt: ts, updatedAt: ts })
    .onConflictDoNothing()
    .run();
  return findRecord(ctx, kind, localKey)!;
}

const reload = (ctx: Ctx, r: RecordRow) => ctx.db.select().from(xeroRecords).where(eq(xeroRecords.id, r.id)).get()!;

/** Not yet due for another try (a failure waits a little), unless a person pressed the button. */
function waiting(ctx: Ctx, r: RecordRow): boolean {
  return !ctx.force && r.status === "failed" && r.nextAttemptAt !== null && Date.parse(r.nextAttemptAt) > ctx.now();
}

/** A row that may already be in Xero: its last call got no answer, or the process stopped while it was being sent. */
const unsure = (r: RecordRow) => r.uncertain || r.status === "sending";

const idemKey = (r: RecordRow) => `checkrail-${r.id}-${r.keySeq}`;

function markPushed(ctx: Ctx, r: RecordRow, xeroId: string): void {
  const ts = new Date(ctx.now()).toISOString();
  ctx.db.update(xeroRecords).set({ status: "pushed", xeroId, error: null, uncertain: false, nextAttemptAt: null, pushedAt: ts, attempts: r.attempts + 1, updatedAt: ts }).where(eq(xeroRecords.id, r.id)).run();
  if (r.kind !== "contact") ctx.result.pushed++;
}

/** Keep the failure on the row in plain words. A definite refusal moves the idempotency key on; no answer keeps it, so the retry is the same request. */
function markFailed(ctx: Ctx, r: RecordRow, message: string, uncertain = false): void {
  const cur = reload(ctx, r);
  const ts = new Date(ctx.now()).toISOString();
  const attempts = cur.attempts + 1;
  const waitMin = uncertain ? 1 : backoffMinutes(attempts);
  ctx.db
    .update(xeroRecords)
    .set({ status: "failed", error: message, attempts, uncertain, keySeq: uncertain ? cur.keySeq : cur.keySeq + 1, nextAttemptAt: new Date(ctx.now() + waitMin * 60_000).toISOString(), updatedAt: ts })
    .where(eq(xeroRecords.id, r.id))
    .run();
  if (r.kind !== "contact") ctx.result.failed++;
  if (!ctx.result.errors.includes(message)) ctx.result.errors.push(message);
}

/**
 * The one create call for a record: first the row is marked "sending" with the Idempotency-Key it is about to use, in
 * the database, so a process that stops before saving Xero's answer leaves a row the next pass looks up first.
 */
function writeFor(ctx: Ctx, r: RecordRow, onWrite: () => void = () => undefined) {
  return async <T>(req: Omit<XeroRequest, "idempotencyKey">): Promise<T> => {
    onWrite();
    const key = idemKey(reload(ctx, r));
    ctx.db.update(xeroRecords).set({ status: "sending", uncertain: true, idemKey: key, updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
    return ctx.client.request<T>({ ...req, idempotencyKey: key });
  };
}

type Write = ReturnType<typeof writeFor>;

/**
 * Run one record against Xero. Rate limits and a lost lease stop the whole pass (the record is left for next time);
 * an auth failure stops it too; anything else is kept on the record.
 */
async function attempt(ctx: Ctx, r: RecordRow, create: (write: Write) => Promise<string>, lookup?: () => Promise<string | null>): Promise<string | null> {
  // Whether this attempt reached the create call. If it did not, a row that was unsure stays unsure.
  let wrote = false;
  const wasUnsure = unsure(r);
  try {
    if (unsure(r) && lookup) {
      const existing = await lookup();
      if (existing) {
        markPushed(ctx, r, existing);
        return existing;
      }
    }
    const id = await create(writeFor(ctx, r, () => (wrote = true)));
    markPushed(ctx, r, id);
    return id;
  } catch (e) {
    if (e instanceof PassPaused || (e instanceof XeroApiError && (e.kind === "rate_limited" || e.kind === "auth"))) {
      // Not this record's fault. If it was mid-send, it stays unsure and is looked up next time.
      throw e;
    }
    if (e instanceof PlainFailure || e instanceof XeroApiError) {
      const noAnswer = e instanceof XeroApiError && e.uncertain;
      markFailed(ctx, r, e.message, wrote ? noAnswer : wasUnsure || noAnswer);
      return null;
    }
    throw e;
  }
}

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

/**
 * How the line amounts are read, always sent: with no tax rate (or Xero's NONE) the amounts carry no tax; with a rate
 * chosen, the tax is inside the amount. Either way the bill's total is what the vendor invoiced and what is paid.
 */
function taxTerms(ctx: Ctx): { LineAmountTypes: "NoTax" | "Inclusive"; taxType?: string } {
  const t = ctx.conn.taxType;
  return t && t !== "NONE" ? { LineAmountTypes: "Inclusive", taxType: t } : { LineAmountTypes: "NoTax" };
}

function tracking(ctx: Ctx, name: unknown, option: unknown): Array<{ Name: string; Option: string }> | undefined {
  if (!name || !option) return undefined;
  // Only a category and option the organisation has: Xero refuses an unknown one, and the bill matters more than the tag.
  const cat = ctx.chart?.tracking.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  const opt = cat?.options.find((o) => o.toLowerCase() === String(option).toLowerCase());
  return cat && opt ? [{ Name: cat.name, Option: opt }] : undefined;
}

/** A contact by exact name (any case), or null. */
async function findContact(ctx: Ctx, name: string): Promise<string | null> {
  const known = findRecord(ctx, "contact", name.trim().toLowerCase());
  if (known?.status === "pushed" && known.xeroId) return known.xeroId;
  // searchTerm is Xero's indexed search (partial and any case); the exact name is checked on what comes back.
  const res = await ctx.client.request<{ Contacts: Array<{ ContactID: string; Name: string; ContactStatus?: string }> }>({ method: "GET", path: "/Contacts", query: { searchTerm: name.trim() } });
  // An archived contact cannot take a new bill; it is passed over and a live one used or created.
  return res.Contacts?.find((c) => c.ContactStatus !== "ARCHIVED" && c.Name.trim().toLowerCase() === name.trim().toLowerCase())?.ContactID ?? null;
}

/** Find a contact by name, else create it. One record per name, so a vendor is looked up once. */
async function contactId(ctx: Ctx, name: string, extra: { email?: string | null; country?: string | null } = {}): Promise<string> {
  const r = recordFor(ctx, "contact", name.trim().toLowerCase(), `Contact ${name}`);
  if (r.status === "pushed" && r.xeroId) return r.xeroId;
  const id = await attempt(
    ctx,
    r,
    async (write) => {
      const existing = await findContact(ctx, name);
      if (existing) return existing;
      const body = { Contacts: [{ Name: name, ...(extra.email ? { EmailAddress: extra.email } : {}), ...(extra.country ? { Addresses: [{ AddressType: "POBOX", Country: extra.country }] } : {}) }] };
      const res = await write<{ Contacts: Array<{ ContactID: string }> }>({ method: "PUT", path: "/Contacts", body });
      const made = res.Contacts?.[0]?.ContactID;
      if (!made) throw new XeroApiError("Xero did not return the new contact.", "validation");
      return made;
    },
    () => findContact(ctx, name),
  );
  if (!id) throw new PlainFailure(`Contact ${name}: ${reload(ctx, r).error ?? "could not be sent"}`);
  return id;
}

/** A bill for this contact with this number (sent here, or imported from the bills file). Never another contact's. */
async function findBill(ctx: Ctx, number: string, contact: string): Promise<string | null> {
  const res = await ctx.client.request<{ Invoices: Array<{ InvoiceID: string; Status: string; Contact?: { ContactID?: string } }> }>({ method: "GET", path: "/Invoices", query: { where: `Type=="ACCPAY"&&InvoiceNumber=="${q(number)}"` } });
  const hit = (res.Invoices ?? []).find((i) => i.Status !== "DELETED" && i.Status !== "VOIDED" && i.Contact?.ContactID === contact);
  return hit?.InvoiceID ?? null;
}

async function findCreditNote(ctx: Ctx, number: string, contact: string): Promise<string | null> {
  const res = await ctx.client.request<{ CreditNotes: Array<{ CreditNoteID: string; Status: string; Contact?: { ContactID?: string } }> }>({ method: "GET", path: "/CreditNotes", query: { where: `CreditNoteNumber=="${q(number)}"` } });
  return (res.CreditNotes ?? []).find((c) => c.Status !== "DELETED" && c.Status !== "VOIDED" && c.Contact?.ContactID === contact)?.CreditNoteID ?? null;
}

/** What a bill looks like in Xero, from its file rows, and a digest of it (to see an amendment later). */
function billBody(ctx: Ctx, g: XeroBillGroup, contact: string) {
  const first = g.rows[0];
  const number = String(first["*InvoiceNumber"]);
  const currency = String(first.Currency ?? "");
  const terms = taxTerms(ctx);
  const lines = g.rows.map((row) => {
    const amount = Number(row["*UnitAmount"]);
    const trk = tracking(ctx, row.TrackingName1, row.TrackingOption1);
    return {
      Description: String(row.Description ?? number),
      Quantity: 1,
      // A credit note is entered positive in the API; the file carries it negative.
      UnitAmount: g.kind === "credit_note" ? Math.abs(amount) : amount,
      AccountCode: lineAccount(ctx, String(row["*AccountCode"])),
      ...(terms.taxType ? { TaxType: terms.taxType } : {}),
      ...(trk ? { Tracking: trk } : {}),
    };
  });
  const common = { Contact: { ContactID: contact }, Date: isoDay(first["*InvoiceDate"]), CurrencyCode: currency, Status: "AUTHORISED", LineAmountTypes: terms.LineAmountTypes, LineItems: lines };
  const body = g.kind === "credit_note" ? { Type: "ACCPAYCREDIT", CreditNoteNumber: number, ...common } : { Type: "ACCPAY", InvoiceNumber: number, DueDate: isoDay(first["*DueDate"]), Reference: "Checkrail Pay", ...common };
  return { body, number, currency, hash: groupHash(g) };
}

/** A digest of the bill as the files describe it: number, dates, currency and lines. */
function groupHash(g: XeroBillGroup): string {
  const view = g.rows.map((r) => [r["*InvoiceNumber"], r["*InvoiceDate"], r["*DueDate"], r.Currency, r.Description, r["*UnitAmount"], r["*AccountCode"]]);
  return createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 32);
}

async function pushBillGroup(ctx: Ctx, g: XeroBillGroup): Promise<void> {
  const first = g.rows[0];
  if (!first) return;
  const contactName = String(first["*ContactName"]);
  const number = String(first["*InvoiceNumber"]);
  const currency = String(first.Currency ?? "");
  const kind: Kind = g.kind === "credit_note" ? "credit_note" : "bill";
  const r = recordFor(ctx, kind, billKey(contactName, number), `${kind === "bill" ? "Bill" : "Credit note"} ${number}, ${contactName}`, { obligationId: g.obligationIds[0] ?? null, parentKey: g.source });
  if (r.status !== "pushed") {
    if (waiting(ctx, r) || r.status === "needs_person") {
      ctx.result.waiting++;
      return;
    }
    let sentHash: string | null = null;
    const created = await attempt(ctx, r, async (write) => {
      checkCurrency(ctx, currency);
      const contact = await contactId(ctx, contactName, { email: first.EmailAddress as string | null, country: first.POCountry as string | null });
      // Always look first: a bill already in Xero for this contact and number (imported from the file, or sent before
      // a demo reset, or before the process stopped) is used, not created again.
      const existing = kind === "credit_note" ? await findCreditNote(ctx, number, contact) : await findBill(ctx, number, contact);
      const { body, hash } = billBody(ctx, g, contact);
      sentHash = hash;
      if (existing) return existing;
      if (kind === "credit_note") {
        const res = await write<{ CreditNotes: Array<{ CreditNoteID: string }> }>({ method: "PUT", path: "/CreditNotes", body: { CreditNotes: [body] } });
        const cid = res.CreditNotes?.[0]?.CreditNoteID;
        if (!cid) throw new XeroApiError("Xero did not return the credit note.", "validation");
        return cid;
      }
      const res = await write<{ Invoices: Array<{ InvoiceID: string }> }>({ method: "PUT", path: "/Invoices", body: { Invoices: [body] } });
      const iid = res.Invoices?.[0]?.InvoiceID;
      if (!iid) throw new XeroApiError("Xero did not return the bill.", "validation");
      return iid;
    });
    if (!created) return;
    ctx.db.update(xeroRecords).set({ sentHash, parentKey: g.source }).where(eq(xeroRecords.id, r.id)).run();
    audit(ctx.db, { obligationId: g.obligationIds[0] ?? null, actor: "system", action: "accounting.xero_bill_pushed", detail: { invoice: number, contact: contactName, kind } });
  }
  // In Xero now: stamp it as the bills file would, so the file does not carry it a second time.
  const ts = new Date(ctx.now()).toISOString();
  if (g.obligationIds.length) ctx.db.update(obligations).set({ xeroBillExportedAt: ts }).where(and(inArray(obligations.id, g.obligationIds), isNull(obligations.xeroBillExportedAt))).run();
  if (g.billId) ctx.db.update(bills).set({ xeroExportedAt: ts }).where(and(eq(bills.id, g.billId), isNull(bills.xeroExportedAt))).run();
}

interface Upkeep {
  any: boolean;
  cancelled: RecordRow[];
  returned: RecordRow[];
  amended: RecordRow[];
  allocations: Array<typeof billAllocations.$inferSelect>;
}

/** Work on what already went to Xero, found from the database alone (no call to Xero), so an idle pass costs nothing. */
function findUpkeep(db: Db, conn: XeroConnectionRow): Upkeep {
  const mine = and(eq(xeroRecords.businessId, conn.businessId), eq(xeroRecords.tenantId, conn.tenantId));
  const sourcesOf = (rows: Array<{ id: string; billId: string | null }>) => [...new Set(rows.flatMap((o) => [`ob:${o.id}`, ...(o.billId ? [`bill:${o.billId}`] : [])]))];
  // Bills whose request was cancelled (or rejected) after they went.
  const cancelledObs = db.select({ id: obligations.id, billId: obligations.billId }).from(obligations).where(and(eq(obligations.businessId, conn.businessId), eq(obligations.state, "cancelled"), gte(obligations.updatedAt, conn.syncFrom))).all();
  const cancelled = cancelledObs.length ? db.select().from(xeroRecords).where(and(mine, eq(xeroRecords.kind, "bill"), eq(xeroRecords.status, "pushed"), inArray(xeroRecords.parentKey, sourcesOf(cancelledObs)))).all() : [];
  // Payments whose payout came back.
  const returned = db
    .select({ r: xeroRecords })
    .from(xeroRecords)
    .innerJoin(obligations, eq(obligations.id, xeroRecords.obligationId))
    .where(and(mine, inArray(xeroRecords.kind, ["payment", "withholding"]), eq(xeroRecords.status, "pushed"), eq(obligations.state, "refunded")))
    .all()
    .map((x) => x.r);
  // Bills whose request was amended after they went.
  const amendedIds = db.select({ id: auditEntries.obligationId }).from(auditEntries).where(and(eq(auditEntries.action, "obligation.amended"), gte(auditEntries.createdAt, conn.syncFrom))).all().map((a) => a.id).filter((x): x is string => Boolean(x));
  const amendedObs = amendedIds.length ? db.select({ id: obligations.id, billId: obligations.billId }).from(obligations).where(inArray(obligations.id, amendedIds)).all() : [];
  const amended = amendedObs.length
    ? db.select().from(xeroRecords).where(and(mine, eq(xeroRecords.kind, "bill"), eq(xeroRecords.status, "pushed"), inArray(xeroRecords.parentKey, sourcesOf(amendedObs)))).all().filter((r) => {
        const last = db.select({ at: auditEntries.createdAt }).from(auditEntries).where(and(eq(auditEntries.action, "obligation.amended"), inArray(auditEntries.obligationId, amendedObs.filter((o) => r.parentKey === `ob:${o.id}` || r.parentKey === `bill:${o.billId}`).map((o) => o.id)))).all().map((x) => x.at).sort().pop();
        return Boolean(last && last > r.updatedAt);
      })
    : [];
  // Credits applied to bills, not yet sent.
  const sentAllocations = new Set(db.select({ k: xeroRecords.localKey }).from(xeroRecords).where(and(mine, eq(xeroRecords.kind, "allocation"), inArray(xeroRecords.status, ["pushed", "needs_person"]))).all().map((x) => x.k));
  const allocations = db
    .select({ a: billAllocations })
    .from(billAllocations)
    .innerJoin(bills, eq(bills.id, billAllocations.creditBillId))
    .where(and(eq(bills.businessId, conn.businessId), gte(billAllocations.createdAt, conn.syncFrom)))
    .all()
    .map((x) => x.a)
    .filter((a) => !sentAllocations.has(a.id));
  return { any: cancelled.length + returned.length + amended.length + allocations.length > 0, cancelled, returned, amended, allocations };
}

function needsPerson(ctx: Ctx, r: RecordRow, message: string): void {
  ctx.db.update(xeroRecords).set({ status: "needs_person", error: message, updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
  if (!ctx.result.errors.includes(message)) ctx.result.errors.push(message);
}

type InvoiceView = { InvoiceID: string; Status?: string; AmountPaid?: number; AmountCredited?: number; Payments?: Array<{ PaymentID: string; Amount: number }> };
async function getInvoice(ctx: Ctx, id: string): Promise<InvoiceView | null> {
  const res = await ctx.client.request<{ Invoices: InvoiceView[] }>({ method: "GET", path: `/Invoices/${encodeURIComponent(id)}` });
  return res.Invoices?.[0] ?? null;
}
const unpaid = (inv: InvoiceView) => !(inv.Payments ?? []).length && !(inv.AmountPaid ?? 0) && !(inv.AmountCredited ?? 0);

/** A cancelled request's bill, with nothing paid on it, is voided in Xero; with payments, a person sorts it out there. */
async function voidCancelled(ctx: Ctx, rows: RecordRow[]): Promise<void> {
  for (const r of rows) {
    const src = r.parentKey ?? "";
    const parts = src.startsWith("bill:") ? ctx.db.select({ state: obligations.state }).from(obligations).where(eq(obligations.billId, src.slice(5))).all() : ctx.db.select({ state: obligations.state }).from(obligations).where(eq(obligations.id, src.slice(3))).all();
    if (!parts.length || parts.some((x) => x.state !== "cancelled")) continue;
    try {
      const inv = r.xeroId ? await getInvoice(ctx, r.xeroId) : null;
      if (!inv || inv.Status === "VOIDED" || inv.Status === "DELETED") {
        ctx.db.update(xeroRecords).set({ status: "voided", updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
        continue;
      }
      if (!unpaid(inv)) {
        needsPerson(ctx, r, `${r.label} was cancelled here but has payments in Xero. Remove the payments in Xero, then void the bill there.`);
        continue;
      }
      await ctx.client.request({ method: "POST", path: `/Invoices/${encodeURIComponent(r.xeroId!)}`, body: { Invoices: [{ InvoiceID: r.xeroId, Status: "VOIDED" }] }, idempotencyKey: `checkrail-${r.id}-void` });
      ctx.db.update(xeroRecords).set({ status: "voided", updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
      audit(ctx.db, { obligationId: r.obligationId, actor: "system", action: "accounting.xero_bill_voided", detail: { label: r.label } });
    } catch (e) {
      if (e instanceof XeroApiError && e.kind === "validation") needsPerson(ctx, r, `${r.label} was cancelled here, but Xero would not void it (${e.message}). Void it in Xero by hand.`);
      else throw e;
    }
  }
}

/** A payout that came back: its payment (and withheld part) is taken off the bill in Xero, so paying it again fits. */
async function reverseReturned(ctx: Ctx, rows: RecordRow[]): Promise<void> {
  for (const r of rows) {
    try {
      await ctx.client.request({ method: "POST", path: `/Payments/${encodeURIComponent(r.xeroId!)}`, body: { Status: "DELETED" }, idempotencyKey: `checkrail-${r.id}-reverse` });
      ctx.db.update(xeroRecords).set({ status: "reversed", error: "The payout came back, so this payment was removed in Xero.", updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
      audit(ctx.db, { obligationId: r.obligationId, actor: "system", action: "accounting.xero_payment_reversed", detail: { label: r.label } });
    } catch (e) {
      // Xero will not delete a reconciled payment, for one. Nothing is retried: a person takes it from here.
      if (e instanceof XeroApiError && (e.kind === "validation" || e.kind === "not_found")) needsPerson(ctx, r, `${r.label}: the payout came back, but Xero would not remove the payment (${e.message}). Reverse it in Xero by hand; the new payment waits until then.`);
      else throw e;
    }
  }
}

/** An amended request whose bill is in Xero and unpaid: the bill is updated to match. A paid one needs a person. */
async function updateAmended(ctx: Ctx, rows: RecordRow[]): Promise<void> {
  const groups = xeroBillRows(ctx.db, ctx.businessId, { onlyNew: false, includeLive: true }).groups;
  for (const r of rows) {
    const g = groups.find((x) => x.source === r.parentKey && x.kind === "bill");
    const touch = () => ctx.db.update(xeroRecords).set({ updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
    if (!g || groupHash(g) === r.sentHash) {
      touch();
      continue;
    }
    const inv = await getInvoice(ctx, r.xeroId!);
    if (!inv || !unpaid(inv)) {
      needsPerson(ctx, r, `${r.label} was changed here after it went to Xero and has payments there. Make the same change in Xero by hand.`);
      continue;
    }
    const contact = (await findContact(ctx, String(g.rows[0]["*ContactName"]))) ?? "";
    const { body, number, hash } = billBody(ctx, g, contact);
    try {
      await ctx.client.request({ method: "POST", path: `/Invoices/${encodeURIComponent(r.xeroId!)}`, body: { Invoices: [{ ...body, InvoiceID: r.xeroId }] }, idempotencyKey: `checkrail-${r.id}-upd-${hash.slice(0, 12)}` });
    } catch (e) {
      if (e instanceof XeroApiError && e.kind === "validation") {
        needsPerson(ctx, r, `${r.label} was changed here, but Xero would not update it (${e.message}). Make the same change in Xero by hand.`);
        continue;
      }
      throw e;
    }
    const contactName = String(g.rows[0]["*ContactName"]);
    ctx.db.update(xeroRecords).set({ sentHash: hash, localKey: billKey(contactName, number), label: `Bill ${number}, ${contactName}`, updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, r.id)).run();
    audit(ctx.db, { obligationId: r.obligationId, actor: "system", action: "accounting.xero_bill_updated", detail: { invoice: number } });
  }
}

/** A credit applied to a bill here is allocated to that bill in Xero, once. */
async function pushAllocations(ctx: Ctx, allocations: Upkeep["allocations"]): Promise<void> {
  for (const a of allocations) {
    const cn = ctx.db.select().from(xeroRecords).where(and(eq(xeroRecords.businessId, ctx.businessId), eq(xeroRecords.tenantId, ctx.conn.tenantId), eq(xeroRecords.kind, "credit_note"), eq(xeroRecords.parentKey, `bill:${a.creditBillId}`), eq(xeroRecords.status, "pushed"))).get();
    const bill = ctx.db.select().from(xeroRecords).where(and(eq(xeroRecords.businessId, ctx.businessId), eq(xeroRecords.tenantId, ctx.conn.tenantId), eq(xeroRecords.kind, "bill"), eq(xeroRecords.parentKey, `bill:${a.billId}`), eq(xeroRecords.status, "pushed"))).get();
    if (!cn?.xeroId || !bill?.xeroId) continue; // both go first; the allocation follows on a later pass
    const amount = (a.amountMinor / 100).toFixed(2);
    const r = recordFor(ctx, "allocation", a.id, `Credit ${cn.label.replace(/^Credit note /, "")} applied to ${bill.label.replace(/^Bill /, "")}`, { parentKey: `bill:${a.billId}`, amount });
    if (r.status === "pushed" || waiting(ctx, r)) continue;
    const date = isoDay(a.createdAt);
    await attempt(
      ctx,
      r,
      async (write) => {
        const res = await write<{ Allocations?: Array<{ AllocationID?: string }> }>({ method: "PUT", path: `/CreditNotes/${encodeURIComponent(cn.xeroId!)}/Allocations`, body: { Allocations: [{ Invoice: { InvoiceID: bill.xeroId }, Amount: Number(amount), Date: date }] } });
        return res.Allocations?.[0]?.AllocationID ?? `${cn.xeroId}:${bill.xeroId}:${a.id}`;
      },
      async () => {
        const res = await ctx.client.request<{ CreditNotes: Array<{ Allocations?: Array<{ AllocationID?: string; Amount: number; Invoice?: { InvoiceID?: string } }> }> }>({ method: "GET", path: `/CreditNotes/${encodeURIComponent(cn.xeroId!)}` });
        const hit = (res.CreditNotes?.[0]?.Allocations ?? []).find((x) => x.Invoice?.InvoiceID === bill.xeroId && hundredths(x.Amount) === a.amountMinor);
        return hit ? (hit.AllocationID ?? `${cn.xeroId}:${bill.xeroId}:${a.id}`) : null;
      },
    );
  }
}

/** The bank account for a rail, checked to be in the payment's currency. */
function bankFor(ctx: Ctx, rail: string, currency: string): string {
  const code = rail === "paypal" ? ctx.conn.paypalAccountCode : rail === "stellar" ? ctx.conn.stellarAccountCode : ctx.conn.bankAccountCode;
  const name = rail === "paypal" ? "PayPal" : rail === "stellar" ? "Stellar treasury" : "Wise and bank file";
  if (!code) throw new PlainFailure(`Choose the Xero bank account for ${name} payments in Settings, Xero.`);
  const acct = ctx.chart?.accounts.find((a) => a.code === code);
  const acctCurrency = acct ? (acct.currency ?? ctx.chart?.baseCurrency ?? null) : null;
  if (acctCurrency && acctCurrency !== currency) throw new PlainFailure(`The ${name} bank account in Xero (${code} ${acct!.name}) is in ${acctCurrency}, but this payment is in ${currency}. Choose a ${currency} bank account for ${name} in Settings, Xero.`);
  return code;
}

/** The bill a payment goes against: the one sent here, else one for this vendor's contact with this number. */
async function billForPayment(ctx: Ctx, p: AccountingPayload): Promise<string> {
  const rec = findRecord(ctx, "bill", billKey(p.vendorName, p.reference));
  if (rec?.status === "pushed" && rec.xeroId) return rec.xeroId;
  const contact = await findContact(ctx, p.vendorName);
  const bill = contact ? await findBill(ctx, p.reference, contact) : null;
  if (!bill) throw new PlainFailure(`The bill ${p.reference} for ${p.vendorName} is not in Xero, so its payment cannot be matched to it. It goes once the bill is there.`);
  return bill;
}

async function pushSettlement(ctx: Ctx, item: SettlementItem): Promise<void> {
  const { sync, payload: p } = item;
  const key = paymentKey(p);
  const parent = billKey(p.vendorName, p.reference);
  const amount = String(toXeroPayment(p, "").Amount);
  const pay = recordFor(ctx, "payment", key, `Payment ${p.reference}, ${p.vendorName}`, { obligationId: sync.obligationId, accountingSyncId: sync.id, parentKey: parent, amount });
  const needsFee = hundredths(p.feeAmount) > 0 && p.rail !== "stellar";
  const feeLabel = `Fee on ${p.reference} (${p.rail})`;
  // The part kept back for the tax office: paid against the same bill from the withholding liability account, so the
  // bill (sent at its gross) clears exactly with what this part really withheld.
  const withheld = hundredths(p.withheldAmount);
  const whLabel = `Tax withheld on ${p.reference}, ${p.vendorName}`;

  if (pay.status !== "pushed") {
    if (waiting(ctx, pay)) {
      ctx.result.waiting++;
      return;
    }
    let adoptedByAmount = false;
    const done = await attempt(ctx, pay, async (write) => {
      checkCurrency(ctx, p.grossCurrency);
      const bank = bankFor(ctx, p.rail, p.grossCurrency);
      const invoiceId = await billForPayment(ctx, p);
      // First our own payment, by its reference (rail and provider transaction id).
      const mine = await paymentByReference(ctx, toXeroPayment(p, bank).Reference, invoiceId);
      if (mine) return mine;
      // Last resort: if Xero holds more payments of this amount on this bill than Checkrail has sent, one of them is this
      // payment (sent before a demo reset, or entered by hand): it is used, not paid twice, and its fee is not booked.
      const inv = await ctx.client.request<{ Invoices: Array<{ Payments?: Array<{ PaymentID: string; Amount: number }> }> }>({ method: "GET", path: `/Invoices/${encodeURIComponent(invoiceId)}` });
      const payments = inv.Invoices?.[0]?.Payments ?? [];
      const ours = ctx.db
        .select({ xeroId: xeroRecords.xeroId })
        .from(xeroRecords)
        .where(and(eq(xeroRecords.businessId, ctx.businessId), eq(xeroRecords.tenantId, ctx.conn.tenantId), eq(xeroRecords.kind, "payment"), eq(xeroRecords.parentKey, parent), eq(xeroRecords.amount, amount), eq(xeroRecords.status, "pushed")))
        .all()
        .map((x) => x.xeroId);
      const sameAmount = payments.filter((x) => hundredths(x.Amount) === hundredths(amount) && !ours.includes(x.PaymentID));
      if (sameAmount.length) {
        adoptedByAmount = true;
        return sameAmount[0].PaymentID;
      }
      const body = toXeroPayment(p, bank);
      const res = await write<{ Payments: Array<{ PaymentID: string }> }>({ method: "PUT", path: "/Payments", body: { Payments: [{ ...body, Invoice: { InvoiceID: invoiceId }, Date: isoDay(body.Date) }] } });
      const id = res.Payments?.[0]?.PaymentID;
      if (!id) throw new XeroApiError("Xero did not return the payment.", "validation");
      return id;
    });
    if (!done) return;
    if (adoptedByAmount && withheld > 0) {
      const wh = recordFor(ctx, "withholding", `${key}|wh`, whLabel, { obligationId: sync.obligationId, accountingSyncId: sync.id, parentKey: parent });
      ctx.db.update(xeroRecords).set({ status: "skipped", error: "The payment was already on the bill in Xero, so its withheld part was taken to be there too.", updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, wh.id)).run();
    }
    if (adoptedByAmount && needsFee) {
      // The payment was already in Xero, so its fee is taken to be there too; it is not booked a second time.
      const fee = recordFor(ctx, "fee", key, feeLabel, { obligationId: sync.obligationId, accountingSyncId: sync.id, parentKey: key });
      ctx.db.update(xeroRecords).set({ status: "skipped", error: "Skipped fee: a payment of this amount was already on the bill in Xero, so it was used and its fee was not sent again.", updatedAt: new Date(ctx.now()).toISOString() }).where(eq(xeroRecords.id, fee.id)).run();
    }
  }

  if (withheld > 0) {
    const wh = recordFor(ctx, "withholding", `${key}|wh`, whLabel, { obligationId: sync.obligationId, accountingSyncId: sync.id, parentKey: parent, amount: (withheld / 100).toFixed(2) });
    if (wh.status !== "pushed" && wh.status !== "skipped") {
      if (waiting(ctx, wh) || wh.status === "needs_person") {
        ctx.result.waiting++;
        return;
      }
      const reference = `${toXeroPayment(p, "").Reference}:wh`;
      const done = await attempt(
        ctx,
        wh,
        async (write) => {
          const account = ctx.conn.withholdingAccountCode;
          if (!account) throw new PlainFailure("Choose the Xero account for tax withheld in Settings, Xero (a liability account with payments enabled).");
          const invoiceId = await billForPayment(ctx, p);
          const found = await paymentByReference(ctx, reference, invoiceId);
          if (found) return found;
          const res = await write<{ Payments: Array<{ PaymentID: string }> }>({ method: "PUT", path: "/Payments", body: { Payments: [{ Invoice: { InvoiceID: invoiceId }, Account: { Code: account }, Date: isoDay(p.paymentDate), Amount: withheld / 100, Reference: reference }] } });
          const id = res.Payments?.[0]?.PaymentID;
          if (!id) throw new XeroApiError("Xero did not return the withheld payment.", "validation");
          return id;
        },
      );
      if (!done) return;
    }
  }

  const fee = needsFee ? recordFor(ctx, "fee", key, feeLabel, { obligationId: sync.obligationId, accountingSyncId: sync.id, parentKey: key }) : null;
  if (fee && fee.status !== "pushed" && fee.status !== "skipped") {
    if (waiting(ctx, fee)) {
      ctx.result.waiting++;
      return;
    }
    const reference = xeroFeeReference(p);
    const done = await attempt(
      ctx,
      fee,
      async (write) => {
        const bank = bankFor(ctx, p.rail, p.feeCurrency || p.grossCurrency);
        if (!ctx.conn.feeAccountCode) throw new PlainFailure("Choose the Xero account for payment fees in Settings, Xero.");
        const tx = toXeroFeeTransaction(p, bank, ctx.conn.feeAccountCode)!;
        const contact = await contactId(ctx, tx.Contact.Name);
        const res = await write<{ BankTransactions: Array<{ BankTransactionID: string }> }>({
          method: "PUT",
          path: "/BankTransactions",
          body: { BankTransactions: [{ ...tx, Contact: { ContactID: contact }, Date: isoDay(tx.Date), CurrencyCode: p.feeCurrency || p.grossCurrency, LineAmountTypes: "NoTax" }] },
        });
        const id = res.BankTransactions?.[0]?.BankTransactionID;
        if (!id) throw new XeroApiError("Xero did not return the fee transaction.", "validation");
        return id;
      },
      async () => {
        const res = await ctx.client.request<{ BankTransactions: Array<{ BankTransactionID: string; Status?: string; Reference?: string }> }>({ method: "GET", path: "/BankTransactions", query: { where: `Reference=="${q(reference)}"` } });
        return res.BankTransactions?.find((x) => x.Status !== "DELETED" && x.Reference === reference)?.BankTransactionID ?? null;
      },
    );
    if (!done) return;
  }

  // The accounting record says where it went, when it was still waiting; an exported CSV row keeps its own mark.
  const paymentId = findRecord(ctx, "payment", key)?.xeroId;
  const ts = new Date(ctx.now()).toISOString();
  ctx.db.update(accountingSyncs).set({ status: "synced", externalRef: `xero:${paymentId}`, updatedAt: ts }).where(and(eq(accountingSyncs.id, sync.id), eq(accountingSyncs.status, "pending"))).run();
  finishSettlement(ctx.db, ctx.conn, sync, "pushed", null);
  audit(ctx.db, { obligationId: sync.obligationId, actor: "system", action: "accounting.xero_payment_pushed", detail: { reference: p.reference, fee: needsFee } });
}

/** Our own payment on this bill, found by its reference. A deleted one (a payout that came back) does not count. */
async function paymentByReference(ctx: Ctx, reference: string, invoiceId: string): Promise<string | null> {
  const res = await ctx.client.request<{ Payments: Array<{ PaymentID: string; Status?: string; Reference?: string; Invoice?: { InvoiceID?: string } }> }>({ method: "GET", path: "/Payments", query: { where: `Reference=="${q(reference)}"` } });
  return (res.Payments ?? []).find((x) => x.Status !== "DELETED" && x.Reference === reference && (!x.Invoice?.InvoiceID || x.Invoice.InvoiceID === invoiceId))?.PaymentID ?? null;
}

