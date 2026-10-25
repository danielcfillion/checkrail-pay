import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { businesses, obligations, reconciliations, settlements, vendors } from "../db/schema";
import { audit, transition } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import { localDateString } from "../format";
import { toBaseOrZero } from "../fx";
import { actorCan, requirePermission, type Actor } from "./users";
import { openBills } from "./bills";

/**
 * The accountant's side: does the provider's statement agree with what the app says it paid, what is owed and how
 * late, and which months are closed.
 */

/* ---------- PayPal statement reconciliation ---------- */

export interface StatementLine {
  date: string;
  type: string;
  status: string;
  currency: string;
  grossMinor: number;
  feeMinor: number;
  toEmail: string;
  name: string;
  transactionId: string;
  note: string;
}

/** Parse PayPal's activity download (CSV). Header names are matched case-insensitively; extra columns are ignored. */
export function parsePayPalCsv(text: string): StatementLine[] {
  if (text.length > 5_000_000) throw new Error("File too large (5 MB at most)");
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new Error("The file has no rows");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => {
    const i = head.findIndex((h) => names.includes(h));
    return i;
  };
  const c = { date: col("date"), type: col("type"), status: col("status"), currency: col("currency"), gross: col("gross"), fee: col("fee"), to: col("to email address", "to email"), name: col("name"), id: col("transaction id"), subject: col("subject"), note: col("note") };
  if (c.date < 0 || c.gross < 0 || c.currency < 0 || c.id < 0) throw new Error("This does not look like a PayPal activity download: it needs Date, Currency, Gross and Transaction ID columns");
  const money = (v: string | undefined) => {
    const n = Number((v ?? "").replace(/[,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  const date = (v: string) => {
    const t = v.trim();
    const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t;
  };
  return rows
    .slice(1, 20_001)
    .filter((r) => r.length > 1)
    .map((r) => ({
      date: date(r[c.date] ?? ""),
      type: (r[c.type] ?? "").trim(),
      status: (r[c.status] ?? "").trim(),
      currency: (r[c.currency] ?? "").trim().toUpperCase(),
      grossMinor: money(r[c.gross]),
      feeMinor: money(r[c.fee]),
      toEmail: (r[c.to] ?? "").trim().toLowerCase(),
      name: (r[c.name] ?? "").trim(),
      transactionId: (r[c.id] ?? "").trim(),
      note: `${r[c.subject] ?? ""} ${r[c.note] ?? ""}`.trim(),
    }));
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      out.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    out.push(row);
  }
  return out;
}

export interface ReconResult {
  matched: Array<{ settlementId: string; obligationId: string; vendorName: string; amountMinor: number; currency: string; statementRef: string; date: string }>;
  /** Money that left PayPal with no payment in the app: the line to look at first. */
  statementOnly: Array<{ date: string; name: string; toEmail: string; amountMinor: number; currency: string; transactionId: string; type: string }>;
  /** Payments the app recorded as paid by PayPal in the period that the statement does not show. */
  appOnly: Array<{ settlementId: string; obligationId: string; vendorName: string; amountMinor: number; currency: string; settledAt: string }>;
  /** Payouts that came back (unclaimed, reversed, returned): the vendor is owed again. */
  returned?: Array<{ obligationId: string; vendorName: string; amountMinor: number; currency: string; date: string; transactionId: string; type: string }>;
  /** Matched payouts whose statement fee differs from the fee recorded here. */
  feeDiffs?: Array<{ obligationId: string; vendorName: string; statementFeeMinor: number; recordedFeeMinor: number; currency: string }>;
  feesMinor: Record<string, number>;
  periodFrom: string | null;
  periodTo: string | null;
}

const PAYOUT_TYPE = /payout|mass pay|payment sent|general payment/i;
const RETURN_TYPE = /reversal|returned|unclaimed|refund/i;

/**
 * Match outgoing payout lines to PayPal settlements: same recipient email, same amount and currency, within three
 * days, each line and each settlement used once. A matched settlement is marked reconciled with the line's id.
 */
export function reconcilePayPal(db: Db, businessId: string, by: Actor, lines: StatementLine[], fileName?: string): { id: string; result: ReconResult } {
  if (!actorCan(by, "reconcile")) requirePermission(by, "pay", "reconcile statements");
  const out = lines.filter((l) => l.grossMinor < 0 && PAYOUT_TYPE.test(l.type) && !/denied|reversed|refunded/i.test(l.status));
  const dates = lines.map((l) => l.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const periodFrom = dates[0] ?? null;
  const periodTo = dates[dates.length - 1] ?? null;
  const rows = db
    .select({ s: settlements, email: vendors.paypalEmail, vendorName: vendors.name, businessId: obligations.businessId })
    .from(settlements)
    .innerJoin(obligations, eq(obligations.id, settlements.obligationId))
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), eq(settlements.rail, "paypal")))
    .all();
  const used = new Set<string>();
  const result: ReconResult = { matched: [], statementOnly: [], appOnly: [], returned: [], feeDiffs: [], feesMinor: {}, periodFrom, periodTo };
  for (const l of out) {
    const amount = -l.grossMinor;
    result.feesMinor[l.currency] = (result.feesMinor[l.currency] ?? 0) + Math.abs(l.feeMinor);
    const lineDay = Date.parse(`${l.date}T00:00:00Z`);
    const m = rows.find((r) => !used.has(r.s.id) && r.s.grossCurrency === l.currency && r.s.grossMinor === amount && (!l.toEmail || (r.email ?? "").toLowerCase() === l.toEmail) && Math.abs(Date.parse(r.s.settledAt) - lineDay) <= 4 * 86_400_000);
    if (m) {
      used.add(m.s.id);
      result.matched.push({ settlementId: m.s.id, obligationId: m.s.obligationId, vendorName: m.vendorName, amountMinor: amount, currency: l.currency, statementRef: l.transactionId, date: l.date });
      // PayPal reports the fee on the payout line; the app recorded the quoted one.
      if (l.feeMinor && Math.abs(l.feeMinor) !== m.s.feeMinor) result.feeDiffs!.push({ obligationId: m.s.obligationId, vendorName: m.vendorName, statementFeeMinor: Math.abs(l.feeMinor), recordedFeeMinor: m.s.feeMinor, currency: l.currency });
    } else result.statementOnly.push({ date: l.date, name: l.name, toEmail: l.toEmail, amountMinor: amount, currency: l.currency, transactionId: l.transactionId, type: l.type });
  }
  // Money coming back: an unclaimed payout returned after 30 days, a reversal. The payment it belongs to is no longer paid.
  const backs = lines.filter((l) => l.grossMinor > 0 && RETURN_TYPE.test(`${l.type} ${l.status} ${l.note}`));
  const returnedIds = new Set<string>();
  for (const l of backs) {
    const m = rows.find((r) => !returnedIds.has(r.s.id) && r.s.grossCurrency === l.currency && r.s.grossMinor === l.grossMinor && (!l.toEmail || (r.email ?? "").toLowerCase() === l.toEmail || !r.email));
    if (!m) {
      result.statementOnly.push({ date: l.date, name: l.name, toEmail: l.toEmail, amountMinor: -l.grossMinor, currency: l.currency, transactionId: l.transactionId, type: l.type });
      continue;
    }
    returnedIds.add(m.s.id);
    result.returned!.push({ obligationId: m.s.obligationId, vendorName: m.vendorName, amountMinor: l.grossMinor, currency: l.currency, date: l.date, transactionId: l.transactionId, type: l.type });
  }
  if (periodFrom && periodTo) {
    for (const r of rows) {
      if (used.has(r.s.id)) continue;
      const d = localDateString(new Date(r.s.settledAt));
      if (d >= periodFrom && d <= periodTo) result.appOnly.push({ settlementId: r.s.id, obligationId: r.s.obligationId, vendorName: r.vendorName, amountMinor: r.s.grossMinor, currency: r.s.grossCurrency, settledAt: r.s.settledAt });
    }
  }
  const ts = now();
  db.transaction((tx) => {
    for (const m of result.matched) tx.update(settlements).set({ reconciledAt: ts, statementRef: m.statementRef.slice(0, 64) }).where(eq(settlements.id, m.settlementId)).run();
  });
  for (const r of result.returned!) {
    const o = db.select({ state: obligations.state }).from(obligations).where(eq(obligations.id, r.obligationId)).get();
    // The money is back with the business: the payment stands as refunded, its bill (if any) is open again, and the
    // vendor's job can be requested again once their details are checked.
    if (o?.state === "settled") transition(db, r.obligationId, "refunded", by.id, "settlement.returned", { amountMinor: r.amountMinor, currency: r.currency, statementRef: r.transactionId, type: r.type, date: r.date });
  }
  const id = newId("rec");
  db.insert(reconciliations).values({ id, businessId, source: "paypal_csv", fileName: fileName?.slice(0, 120) ?? null, periodFrom, periodTo, summaryJson: JSON.stringify(result), createdBy: by.id, createdAt: ts }).run();
  audit(db, { obligationId: null, actor: by.id, action: "books.reconciled", detail: { reconciliationId: id, matched: result.matched.length, statementOnly: result.statementOnly.length, appOnly: result.appOnly.length, returned: result.returned!.length, feeDiffs: result.feeDiffs!.length } });
  return { id, result };
}

export function listReconciliations(db: Db, businessId: string) {
  return db
    .select()
    .from(reconciliations)
    .where(eq(reconciliations.businessId, businessId))
    .all()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({ ...r, result: JSON.parse(r.summaryJson) as ReconResult }));
}

/* ---------- Aged payables ---------- */

export const AGE_BUCKETS = ["Not yet due", "1 to 30 days", "31 to 60 days", "61 to 90 days", "Over 90 days"] as const;

export interface PayableRow {
  kind: "payment" | "bill";
  id: string;
  vendorId: string;
  vendorName: string;
  reference: string;
  amountMinor: number;
  currency: string;
  baseMinor: number;
  dueDate: string;
  daysOverdue: number;
  bucket: (typeof AGE_BUCKETS)[number];
  state: string;
}

function bucketOf(days: number): (typeof AGE_BUCKETS)[number] {
  return days <= 0 ? AGE_BUCKETS[0] : days <= 30 ? AGE_BUCKETS[1] : days <= 60 ? AGE_BUCKETS[2] : days <= 90 ? AGE_BUCKETS[3] : AGE_BUCKETS[4];
}

/**
 * What the business owes and how late it is: open bills at their open amount, and payments not tied to a bill that
 * are agreed or waiting but not yet paid. Blocked requests are left out until fixed: a duplicate is not owed, and a
 * mismatched amount is not owed as asked. Overdue counts from the due date, or the date raised when there is none.
 */
export function agedPayables(db: Db, businessId: string, today = localDateString()): { rows: PayableRow[]; totals: Record<string, number>; baseCurrency: string } {
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get()!;
  const base = biz.baseCurrency;
  const t0 = Date.parse(`${today}T00:00:00Z`);
  const days = (d: string) => Math.floor((t0 - Date.parse(`${d}T00:00:00Z`)) / 86_400_000);
  const rows: PayableRow[] = [];
  for (const b of openBills(db, businessId)) {
    if (b.kind !== "invoice" || b.balance.openMinor <= 0) continue;
    const due = b.dueDate ?? b.billDate ?? localDateString(new Date(b.createdAt));
    rows.push({ kind: "bill", id: b.id, vendorId: b.vendorId, vendorName: b.vendorName, reference: b.reference, amountMinor: b.balance.openMinor, currency: b.currency, baseMinor: toBaseOrZero(b.balance.openMinor, b.currency, base), dueDate: due, daysOverdue: days(due), bucket: bucketOf(days(due)), state: "open" });
  }
  const obs = db
    .select({ o: obligations, vendorName: vendors.name })
    .from(obligations)
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), inArray(obligations.state, ["awaiting_approval", "approved", "failed", "needs_evidence"])))
    .all();
  for (const { o, vendorName } of obs) {
    if (o.billId || !o.amountMinor || !o.currency) continue;
    const due = o.dueDate ?? localDateString(new Date(o.createdAt));
    rows.push({ kind: "payment", id: o.id, vendorId: o.vendorId!, vendorName, reference: o.sourceRef ?? o.id, amountMinor: o.amountMinor, currency: o.currency, baseMinor: toBaseOrZero(o.amountMinor, o.currency, base), dueDate: due, daysOverdue: days(due), bucket: bucketOf(days(due)), state: o.state });
  }
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
  const totals = Object.fromEntries(AGE_BUCKETS.map((k) => [k, rows.filter((r) => r.bucket === k).reduce((a, r) => a + r.baseMinor, 0)]));
  return { rows, totals, baseCurrency: base };
}

/* ---------- Period lock ---------- */

/**
 * Close the books through a date. Afterwards nothing dated on or before it can be amended, cancelled, credited or
 * voided, so a month already reported to the tax office cannot change underneath the accountant. Moving the lock
 * earlier (reopening) is for the owner only, and recorded.
 */
export function setPeriodLock(db: Db, businessId: string, by: Actor, through: string | null): void {
  requirePermission(by, "lock_period", "close accounting periods");
  if (through !== null && !/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new Error("Date must be YYYY-MM-DD");
  if (through && through > localDateString()) throw new Error("A period cannot be closed before it has ended");
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get()!;
  const reopening = biz.lockedThrough && (!through || through < biz.lockedThrough);
  if (reopening && by.role !== "admin") throw new Error("Only the owner can reopen a closed period");
  db.update(businesses).set({ lockedThrough: through }).where(eq(businesses.id, businessId)).run();
  audit(db, { obligationId: null, actor: by.id, action: reopening ? "books.period_reopened" : "books.period_locked", detail: { from: biz.lockedThrough, to: through } });
}

/** Refuse a change to something dated inside a closed period. */
export function assertOpenPeriod(db: Db, businessId: string, date: string | null | undefined, what: string): void {
  if (!date) return;
  const lock = db.select({ l: businesses.lockedThrough }).from(businesses).where(eq(businesses.id, businessId)).get()?.l;
  if (lock && localDateString(new Date(date.length === 10 ? `${date}T12:00:00Z` : date)) <= lock) throw new Error(`The books are closed through ${lock}; ${what} dated ${date.slice(0, 10)} cannot change. Ask the owner to reopen the period.`);
}
