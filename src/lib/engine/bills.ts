import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db";
import { billAllocations, bills, obligations, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import { SUPPORTED_CURRENCIES, isValidAmountMinor, isValidSourceRef } from "../domain/money";
import { fmt } from "../domain/policy";
import { requirePermission, type Actor } from "./users";
import { ingestObligation } from "./orchestrator";

/**
 * Bills: what is owed to a vendor, separate from the payments that settle it.
 *
 * - An invoice is paid in one payment, or a deposit now and the balance later. Each payment is an ordinary
 *   obligation linked to the bill; policy lets it through only while it fits in what is still open.
 * - A credit note is money the vendor owes back (a cancellation, an overcharge). Applying it to an invoice lowers
 *   what is left to pay.
 * - An advance is cash given to a guide before a trip. Afterwards the receipts settle it: spent more, the business
 *   owes the difference (a new invoice); spent less, the guide owes it back (a credit to set against later bills).
 */

/** Payment states that count against a bill: money committed or moved. A cancelled or failed payment frees its share. */
export const COMMITTED = ["awaiting_approval", "approved", "execution_pending", "sent", "settled"] as const;

export type BillKind = "invoice" | "credit_note" | "advance";

export interface BillBalance {
  totalMinor: number;
  /** Settled payments. */
  paidMinor: number;
  /** Payments waiting, approved or on their way. */
  pendingMinor: number;
  /** Credits applied to this bill (for an invoice), or applied from it (for a credit note). */
  creditedMinor: number;
  /** What is still to pay (invoice) or still to use (credit note). Never below zero. */
  openMinor: number;
}

export function billBalance(db: Db, billId: string, exceptObligationId?: string): BillBalance {
  const b = db.select().from(bills).where(eq(bills.id, billId)).get();
  if (!b) throw new Error("No such bill");
  const pays = db
    .select({ id: obligations.id, state: obligations.state, amountMinor: obligations.amountMinor, currency: obligations.currency })
    .from(obligations)
    .where(and(eq(obligations.billId, billId), exceptObligationId ? ne(obligations.id, exceptObligationId) : undefined))
    .all()
    .filter((o) => (COMMITTED as readonly string[]).includes(o.state) && o.currency === b.currency);
  const paidMinor = pays.filter((o) => o.state === "settled").reduce((a, o) => a + (o.amountMinor ?? 0), 0);
  const pendingMinor = pays.filter((o) => o.state !== "settled").reduce((a, o) => a + (o.amountMinor ?? 0), 0);
  const allocs = db.select().from(billAllocations).where(b.kind === "credit_note" ? eq(billAllocations.creditBillId, billId) : eq(billAllocations.billId, billId)).all();
  const creditedMinor = allocs.reduce((a, x) => a + x.amountMinor, 0);
  const used = b.kind === "credit_note" ? creditedMinor : paidMinor + pendingMinor + creditedMinor;
  return { totalMinor: b.totalMinor, paidMinor, pendingMinor, creditedMinor, openMinor: Math.max(0, b.totalMinor - used) };
}

function validateBill(raw: { kind?: unknown; reference?: unknown; totalMinor?: unknown; currency?: unknown; billDate?: unknown; dueDate?: unknown; note?: unknown }) {
  const kind = raw.kind === "invoice" || raw.kind === "credit_note" || raw.kind === "advance" ? raw.kind : null;
  if (!kind) throw new Error("Kind must be invoice, credit_note or advance");
  if (typeof raw.reference !== "string" || !isValidSourceRef(raw.reference.trim())) throw new Error("Reference must be 1 to 64 characters: letters, digits and . _ / # : -");
  if (!isValidAmountMinor(raw.totalMinor)) throw new Error("Total must be a positive amount");
  if (typeof raw.currency !== "string" || !SUPPORTED_CURRENCIES.includes(raw.currency)) throw new Error(`Currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}`);
  const date = (v: unknown, name: string) => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${name} must be YYYY-MM-DD`);
    return v;
  };
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 300) || null : null;
  return { kind, reference: raw.reference.trim().toUpperCase(), totalMinor: raw.totalMinor, currency: raw.currency, billDate: date(raw.billDate, "Bill date"), dueDate: date(raw.dueDate, "Due date"), note };
}

/** Record a bill. `by` is a person, or "agent" when the agent read a deposit request against an invoice total. */
export function createBill(db: Db, businessId: string, by: Actor | "agent", vendorId: string, raw: Parameters<typeof validateBill>[0]): string {
  if (by !== "agent") requirePermission(by, "ingest", "record bills");
  const v = db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.businessId, businessId))).get();
  if (!v) throw new Error("No such vendor");
  const b = validateBill(raw);
  const clash = db.select({ id: bills.id }).from(bills).where(and(eq(bills.vendorId, vendorId), eq(bills.reference, b.reference), eq(bills.kind, b.kind))).get();
  if (clash) throw new Error(`This vendor already has a ${b.kind.replace("_", " ")} ${b.reference}`);
  const id = newId("bil");
  const actor = by === "agent" ? "ai:bills" : by.id;
  db.insert(bills).values({ id, businessId, vendorId, ...b, status: "open", createdBy: actor, createdAt: now() }).run();
  audit(db, { obligationId: null, actor, action: "bill.created", detail: { billId: id, vendorId, kind: b.kind, reference: b.reference, totalMinor: b.totalMinor, currency: b.currency } });
  return id;
}

export function findBill(db: Db, vendorId: string, reference: string, kind: BillKind = "invoice") {
  return db.select().from(bills).where(and(eq(bills.vendorId, vendorId), eq(bills.reference, reference.toUpperCase()), eq(bills.kind, kind))).get() ?? null;
}

/**
 * Pay all or part of an invoice, or pay out an advance. Creates an ordinary payment request linked to the bill;
 * the agent and policy check it like any other, and policy refuses it if it is more than what is still open.
 */
export async function payBill(db: Db, businessId: string, by: Actor, billId: string, amountMinor: number, note?: string): Promise<string> {
  requirePermission(by, "ingest", "request payments");
  const b = db.select().from(bills).where(and(eq(bills.id, billId), eq(bills.businessId, businessId))).get();
  if (!b) throw new Error("No such bill");
  if (b.kind === "credit_note") throw new Error("A credit note is applied to an invoice, not paid");
  if (b.status !== "open") throw new Error("This bill is closed");
  if (!isValidAmountMinor(amountMinor)) throw new Error("Amount must be positive");
  const bal = billBalance(db, billId);
  if (amountMinor > bal.openMinor) throw new Error(`${fmt(amountMinor, b.currency)} is more than the ${fmt(bal.openMinor, b.currency)} still open on ${b.reference}`);
  const vendor = db.select().from(vendors).where(eq(vendors.id, b.vendorId)).get()!;
  const paymentKind = b.kind === "advance" ? "advance" : amountMinor === bal.openMinor ? (bal.openMinor === b.totalMinor ? "full" : "balance") : "part";
  const what = paymentKind === "advance" ? "cash advance" : paymentKind === "balance" ? "balance" : paymentKind === "part" ? "part payment" : "payment";
  const id = await ingestObligation(db, {
    businessId,
    sourceType: "invoice",
    // The figure to pay comes right after "Please pay" so the reader takes it, not the bill total mentioned after.
    rawInput: `Please pay ${fmt(amountMinor, b.currency)} to ${vendor.name}: ${what} on ${b.kind === "advance" ? "advance" : "invoice"} ${b.reference} (bill total ${fmt(b.totalMinor, b.currency)}).${note ? ` ${note.slice(0, 200)}` : ""}`,
    evidence: [{ kind: b.kind === "advance" ? "purchase_order" : "invoice", label: `${b.kind === "advance" ? "Advance" : "Invoice"} ${b.reference} (${vendor.name})`, amountMinor: b.totalMinor, currency: b.currency, reference: b.reference, excerpt: `${vendor.name}, ${b.reference}, total ${fmt(b.totalMinor, b.currency)}${b.note ? `. ${b.note}` : ""}` }],
    actor: by.id,
    billId,
    paymentKind,
  });
  return id;
}

/** Set part of a credit note against an invoice of the same vendor and currency. */
export function applyCredit(db: Db, businessId: string, by: Actor, creditBillId: string, billId: string, amountMinor: number): void {
  requirePermission(by, "amend", "apply credits");
  const c = db.select().from(bills).where(and(eq(bills.id, creditBillId), eq(bills.businessId, businessId))).get();
  const b = db.select().from(bills).where(and(eq(bills.id, billId), eq(bills.businessId, businessId))).get();
  if (!c || c.kind !== "credit_note") throw new Error("Choose a credit note");
  if (!b || b.kind !== "invoice") throw new Error("Credit applies to an invoice");
  if (c.vendorId !== b.vendorId || c.currency !== b.currency) throw new Error("Credit and invoice must be the same vendor and currency");
  if (!isValidAmountMinor(amountMinor)) throw new Error("Amount must be positive");
  db.transaction((tx) => {
    const cb = billBalance(tx as unknown as Db, creditBillId);
    const bb = billBalance(tx as unknown as Db, billId);
    if (amountMinor > cb.openMinor) throw new Error(`Only ${fmt(cb.openMinor, c.currency)} of this credit is left`);
    if (amountMinor > bb.openMinor) throw new Error(`Only ${fmt(bb.openMinor, b.currency)} is still open on ${b.reference}`);
    tx.insert(billAllocations).values({ id: newId("bal"), creditBillId, billId, amountMinor, createdBy: by.id, createdAt: now() }).run();
  });
  closeIfDone(db, creditBillId);
  closeIfDone(db, billId);
  audit(db, { obligationId: null, actor: by.id, action: "bill.credit_applied", detail: { creditBillId, billId, amountMinor, currency: b.currency } });
}

/**
 * Settle a cash advance against the receipts the guide brought back. The advance closes; the difference becomes
 * an invoice (the business owes more) or a credit note (the guide owes it back), each with the receipts total
 * recorded so the books show what the money was spent on.
 */
export function settleAdvance(db: Db, businessId: string, by: Actor, advanceBillId: string, receiptsMinor: number, note?: string): { differenceBillId: string | null; owedTo: "vendor" | "business" | null; differenceMinor: number } {
  requirePermission(by, "amend", "settle advances");
  const a = db.select().from(bills).where(and(eq(bills.id, advanceBillId), eq(bills.businessId, businessId))).get();
  if (!a || a.kind !== "advance") throw new Error("Choose an advance");
  if (a.status !== "open") throw new Error("This advance is already settled");
  if (!Number.isSafeInteger(receiptsMinor) || receiptsMinor < 0) throw new Error("Receipts total must be zero or more");
  const bal = billBalance(db, advanceBillId);
  const given = bal.paidMinor;
  if (bal.pendingMinor > 0) throw new Error("The advance has a payment still on its way; settle once it has been paid");
  if (given === 0) throw new Error("Nothing has been paid out on this advance yet");
  const diff = receiptsMinor - given;
  let differenceBillId: string | null = null;
  const ref = `${a.reference}-S`.slice(0, 64);
  if (diff !== 0) {
    differenceBillId = createBill(db, businessId, by, a.vendorId, { kind: diff > 0 ? "invoice" : "credit_note", reference: ref, totalMinor: Math.abs(diff), currency: a.currency, note: `Settlement of advance ${a.reference}: receipts ${fmt(receiptsMinor, a.currency)} against ${fmt(given, a.currency)} advanced${note ? `. ${note.slice(0, 150)}` : ""}` });
  }
  db.update(bills).set({ status: "closed" }).where(eq(bills.id, advanceBillId)).run();
  audit(db, { obligationId: null, actor: by.id, action: "bill.advance_settled", detail: { advanceBillId, givenMinor: given, receiptsMinor, differenceMinor: diff, differenceBillId } });
  return { differenceBillId, owedTo: diff > 0 ? "vendor" : diff < 0 ? "business" : null, differenceMinor: Math.abs(diff) };
}

export function voidBill(db: Db, businessId: string, by: Actor, billId: string, reason: string): void {
  requirePermission(by, "amend", "void bills");
  const b = db.select().from(bills).where(and(eq(bills.id, billId), eq(bills.businessId, businessId))).get();
  if (!b) throw new Error("No such bill");
  const bal = billBalance(db, billId);
  if (bal.paidMinor + bal.pendingMinor + bal.creditedMinor > 0) throw new Error("This bill has payments or credits against it; cancel those first");
  db.update(bills).set({ status: "void" }).where(eq(bills.id, billId)).run();
  audit(db, { obligationId: null, actor: by.id, action: "bill.voided", detail: { billId, reason: reason.slice(0, 200) } });
}

/** A bill whose open amount reaches zero through settled payments and credits closes itself. */
export function closeIfDone(db: Db, billId: string): void {
  const b = db.select().from(bills).where(eq(bills.id, billId)).get();
  if (!b || b.status !== "open" || b.kind === "advance") return;
  const bal = billBalance(db, billId);
  const settledOut = b.kind === "credit_note" ? bal.creditedMinor : bal.paidMinor + bal.creditedMinor;
  if (settledOut >= b.totalMinor) db.update(bills).set({ status: "closed" }).where(eq(bills.id, billId)).run();
}

/** Every bill for a vendor with its balance, and the vendor's position per currency. */
export function vendorBills(db: Db, vendorId: string) {
  const rows = db.select().from(bills).where(eq(bills.vendorId, vendorId)).all().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const withBal = rows.map((b) => ({ ...b, balance: billBalance(db, b.id) }));
  const position = new Map<string, { owedMinor: number; creditMinor: number; advancesOutMinor: number }>();
  for (const b of withBal) {
    if (b.status === "void") continue;
    const p = position.get(b.currency) ?? { owedMinor: 0, creditMinor: 0, advancesOutMinor: 0 };
    if (b.kind === "invoice") p.owedMinor += b.balance.openMinor;
    else if (b.kind === "credit_note") p.creditMinor += b.balance.openMinor;
    else if (b.status === "open") p.advancesOutMinor += b.balance.paidMinor;
    position.set(b.currency, p);
  }
  return { bills: withBal, position: [...position.entries()].map(([currency, p]) => ({ currency, ...p })) };
}

export function openBills(db: Db, businessId: string) {
  return db
    .select({ bill: bills, vendorName: vendors.name })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(and(eq(bills.businessId, businessId), inArray(bills.status, ["open"])))
    .all()
    .map((r) => ({ ...r.bill, vendorName: r.vendorName, balance: billBalance(db, r.bill.id) }));
}
