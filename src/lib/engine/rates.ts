import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { departureServices, departures, rateCards, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import { SUPPORTED_CURRENCIES, isValidAmountMinor } from "../domain/money";
import { fmt } from "../domain/policy";
import { requirePermission, type Actor } from "./users";

/**
 * Rate cards and departures: the business's own record of what a job should cost. A driver's invoice for
 * HG-4D-0927 can be checked against "4 vehicle-days at USD 200" without anyone reading the contract. Because these
 * records come from the business (not the vendor), a match also counts as independent support for Autopilot.
 */

export const UNITS = ["day", "vehicle_day", "guest_night", "room_night", "guest", "trip"] as const;
export type Unit = (typeof UNITS)[number];
export const UNIT_LABEL: Record<Unit, string> = { day: "day", vehicle_day: "vehicle-day", guest_night: "guest-night", room_night: "room-night", guest: "guest", trip: "trip" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export function setRate(db: Db, businessId: string, by: Actor, vendorId: string, raw: { unit: unknown; rateMinor: unknown; currency: unknown; validFrom: unknown; validTo?: unknown; note?: unknown }): string {
  // Rates decide what is paid without a person: an approver or the owner sets them, not the clerk who requests payments.
  requirePermission(by, "verify_vendor", "set rate cards");
  if (!(UNITS as readonly unknown[]).includes(raw.unit)) throw new Error(`Unit must be one of: ${UNITS.join(", ")}`);
  if (!isValidAmountMinor(raw.rateMinor)) throw new Error("Rate must be a positive amount");
  if (typeof raw.currency !== "string" || !SUPPORTED_CURRENCIES.includes(raw.currency)) throw new Error("Unsupported currency");
  if (typeof raw.validFrom !== "string" || !DATE.test(raw.validFrom)) throw new Error("Valid from must be YYYY-MM-DD");
  const validTo = typeof raw.validTo === "string" && raw.validTo ? raw.validTo : null;
  if (validTo && (!DATE.test(validTo) || validTo < raw.validFrom)) throw new Error("Valid to must be a date after valid from");
  const v = db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.businessId, businessId))).get();
  if (!v) throw new Error("No such vendor");
  const unit = raw.unit as Unit;
  // A new rate ends the open-ended one for the same unit the day before it starts.
  const prior = db.select().from(rateCards).where(and(eq(rateCards.vendorId, vendorId), eq(rateCards.unit, unit))).all();
  for (const p of prior) if (!p.validTo && p.validFrom < raw.validFrom) db.update(rateCards).set({ validTo: dayBefore(raw.validFrom) }).where(eq(rateCards.id, p.id)).run();
  const id = newId("rte");
  db.insert(rateCards).values({ id, businessId, vendorId, unit, rateMinor: raw.rateMinor, currency: raw.currency, validFrom: raw.validFrom, validTo, note: typeof raw.note === "string" ? raw.note.slice(0, 200) : null, createdBy: by.id, createdAt: now() }).run();
  audit(db, { obligationId: null, actor: by.id, action: "rate.set", detail: { vendorId, unit, rateMinor: raw.rateMinor, currency: raw.currency, validFrom: raw.validFrom, validTo } });
  return id;
}

function dayBefore(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

export function ratesFor(db: Db, vendorId: string) {
  return db.select().from(rateCards).where(eq(rateCards.vendorId, vendorId)).all().sort((a, b) => b.validFrom.localeCompare(a.validFrom));
}

/** A vendor's rate cards as policy reads them, to check a unit price an invoice states against the contract. */
export function rateCardsForPolicy(db: Db, vendorId: string) {
  return ratesFor(db, vendorId).map((r) => ({ unit: r.unit, rateMinor: r.rateMinor, currency: r.currency, validFrom: r.validFrom, validTo: r.validTo }));
}

/**
 * Import departures from a manifest CSV, one service per row:
 *   code,start,end,guests,vendor,unit,quantity
 *   HG-4D-1004,2026-10-04,2026-10-07,12,Phuong Transport,vehicle_day,4
 * Vendors are matched by exact name. A departure already on file is updated (dates, guests, its services replaced).
 * Only an approver or the owner imports: the manifest decides what a job may cost without a person looking.
 */
export function importDepartures(db: Db, businessId: string, by: Actor, csv: string): { departures: number; services: number; errors: string[]; /** Vendors that now have (or lost) a service on a departure; their waiting payments should be checked again. */ vendorIds: string[] } {
  // A departure and its services set the expected amount that Autopilot and Assist accept without a person, exactly as
  // a rate does, so the same people may change them. A clerk who could import one could write the "independent
  // support" for their own payment request, or raise the quantities on a real departure to lift its ceiling.
  requirePermission(by, "verify_vendor", "import departures");
  if (csv.length > 500_000) throw new Error("File too large (500 KB at most)");
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("The file is empty");
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const want = ["code", "start", "end", "guests", "vendor", "unit", "quantity"];
  if (want.some((w, i) => header[i] !== w)) throw new Error(`First line must be: ${want.join(",")}`);
  const vendorByName = new Map(db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.businessId, businessId)).all().map((v) => [v.name.toLowerCase(), v.id]));
  const errors: string[] = [];
  const byCode = new Map<string, { start: string; end: string; guests: number; services: Array<{ vendorId: string; unit: Unit; quantity: number }> }>();
  lines.slice(1, 2001).forEach((line, i) => {
    const cols = splitCsv(line);
    const [code, start, end, guests, vendor, unit, qty] = cols.map((c) => c.trim());
    const n = i + 2;
    const codeU = (code ?? "").toUpperCase();
    if (!CODE.test(codeU)) return void errors.push(`Line ${n}: departure code "${code}" is not valid`);
    if (!DATE.test(start ?? "") || !DATE.test(end ?? "") || end < start) return void errors.push(`Line ${n}: dates must be YYYY-MM-DD, end on or after start`);
    const g = Number(guests);
    if (!Number.isInteger(g) || g < 0 || g > 500) return void errors.push(`Line ${n}: guests must be a whole number`);
    const vendorId = vendorByName.get((vendor ?? "").toLowerCase());
    if (!vendorId) return void errors.push(`Line ${n}: no vendor named "${vendor}"`);
    if (!(UNITS as readonly string[]).includes(unit)) return void errors.push(`Line ${n}: unit must be one of ${UNITS.join(", ")}`);
    const q = Number(qty);
    if (!Number.isInteger(q) || q <= 0 || q > 10_000) return void errors.push(`Line ${n}: quantity must be a positive whole number`);
    const d = byCode.get(codeU) ?? { start, end, guests: g, services: [] };
    d.services.push({ vendorId, unit: unit as Unit, quantity: q });
    byCode.set(codeU, d);
  });
  let services = 0;
  const touched = new Set<string>();
  db.transaction((tx) => {
    for (const [code, d] of byCode) {
      const existing = tx.select().from(departures).where(and(eq(departures.businessId, businessId), eq(departures.code, code))).get();
      const id = existing?.id ?? newId("dep");
      if (existing) {
        tx.update(departures).set({ startDate: d.start, endDate: d.end, guests: d.guests, source: "csv" }).where(eq(departures.id, id)).run();
        for (const o of tx.select({ vendorId: departureServices.vendorId }).from(departureServices).where(eq(departureServices.departureId, id)).all()) touched.add(o.vendorId);
        tx.delete(departureServices).where(eq(departureServices.departureId, id)).run();
      } else tx.insert(departures).values({ id, businessId, code, startDate: d.start, endDate: d.end, guests: d.guests, source: "csv", createdBy: by.id, createdAt: now() }).run();
      for (const s of d.services) {
        tx.insert(departureServices).values({ id: newId("dsv"), departureId: id, vendorId: s.vendorId, unit: s.unit, quantity: s.quantity }).run();
        services += 1;
        touched.add(s.vendorId);
      }
    }
  });
  audit(db, { obligationId: null, actor: by.id, action: "departures.imported", detail: { departures: byCode.size, services, errors: errors.length } });
  return { departures: byCode.size, services, errors: errors.slice(0, 50), vendorIds: [...touched] };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export interface Expectation {
  departureCode: string;
  /** Last day of the departure; the rate card counts as support only once it has passed. */
  endDate: string;
  expectedMinor: number;
  currency: string;
  /** "4 vehicle-days x USD 200.00" for the reviewer. */
  basis: string;
}

/**
 * What the business's own records say this vendor should be paid for the departure the request names: each service
 * the vendor provides on that departure, times the rate in force on its start date. Null when there is no
 * departure, no service for this vendor on it, or a service with no rate.
 */
export function expectedAmount(db: Db, businessId: string, vendorId: string, jobKeys: string[], currency: string): Expectation | null {
  const codes = [...new Set(jobKeys.map((k) => k.replace(/^~/, "").toUpperCase()).filter((k) => CODE.test(k)))];
  if (!codes.length) return null;
  const deps = db.select().from(departures).where(and(eq(departures.businessId, businessId), inArray(departures.code, codes))).all();
  for (const d of deps) {
    const svcs = db.select().from(departureServices).where(and(eq(departureServices.departureId, d.id), eq(departureServices.vendorId, vendorId))).all();
    if (!svcs.length) continue;
    const rates = ratesFor(db, vendorId).filter((r) => r.currency === currency && r.validFrom <= d.startDate && (!r.validTo || r.validTo >= d.startDate));
    let total = 0;
    const parts: string[] = [];
    for (const s of svcs) {
      const r = rates.find((x) => x.unit === s.unit);
      if (!r) return null;
      total += r.rateMinor * s.quantity;
      parts.push(`${s.quantity} ${UNIT_LABEL[s.unit as Unit]}${s.quantity === 1 ? "" : "s"} x ${fmt(r.rateMinor, r.currency)}`);
    }
    return { departureCode: d.code, endDate: d.endDate, expectedMinor: total, currency, basis: parts.join(" + ") };
  }
  return null;
}

export function listDepartures(db: Db, businessId: string) {
  const deps = db.select().from(departures).where(eq(departures.businessId, businessId)).all().sort((a, b) => b.startDate.localeCompare(a.startDate));
  const names = new Map(db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.businessId, businessId)).all().map((v) => [v.id, v.name]));
  return deps.map((d) => ({ ...d, services: db.select().from(departureServices).where(eq(departureServices.departureId, d.id)).all().map((s) => ({ ...s, vendorName: names.get(s.vendorId) ?? s.vendorId })) }));
}

/** The departure a payment belongs to, for reporting: a code on file named in the text, else the first code-shaped token. */
export function departureCodeFor(db: Db, businessId: string, texts: Array<string | null | undefined>): string | null {
  const hay = texts.filter(Boolean).join(" ").toUpperCase();
  const tokens = [...new Set(hay.match(/\b[A-Z]{2,4}-\d{1,2}D-\d{4}\b/g) ?? [])];
  if (!tokens.length) return null;
  const known = db.select({ code: departures.code }).from(departures).where(and(eq(departures.businessId, businessId), inArray(departures.code, tokens))).all();
  return known[0]?.code ?? tokens[0];
}
