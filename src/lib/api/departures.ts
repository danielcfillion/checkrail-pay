import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { apiDepartureRefs, departureServices, departures, vendors } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { newId, now } from "../domain/ids";
import { listDepartures, UNITS, type Unit } from "../engine/rates";
import { recheckVendorItems } from "../engine/orchestrator";
import { ApiError, Problems, isObject, onlyFields } from "./http";

/**
 * The booking feed: a booking system sends its departures (tour code, dates, guests, who serves it) and Checkrail keeps
 * them as the job records its rules already read, exactly as an approver's manifest import does (src/lib/engine/rates.ts).
 * Departures are matched by the booking system's own id (external_id), so sending one again updates it and replaces
 * its services. A departure an approver imported or typed in is never taken over or changed by the feed. A batch is
 * all or nothing: one bad departure and nothing is written.
 *
 * Like the manifest import, the requests waiting on the suppliers it touches are checked again afterwards: a request
 * typed before the departure arrived is judged against it now. Policy and the autonomy setting decide what that
 * means; nothing here approves or sends.
 */

const CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,99}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DEPARTURES_PER_CALL = 200;
const MAX_SERVICES = 50;

interface DepartureIn { externalId: string; code: string; startDate: string; endDate: string; guests: number; services: Array<{ vendorId: string; unit: Unit; quantity: number }> }

const realDate = (s: unknown): s is string => typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function validateDepartures(db: Db, businessId: string, body: unknown): DepartureIn[] {
  const p = new Problems();
  if (!isObject(body)) throw new ApiError(422, "validation_failed", "The body must be an object: {\"departures\": [...]}");
  onlyFields(p, body, ["departures"]);
  const list = body.departures;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_DEPARTURES_PER_CALL) {
    p.add("departures", `must be a list of 1 to ${MAX_DEPARTURES_PER_CALL} departures`);
    p.throwIfAny();
  }
  const all = db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.businessId, businessId)).all();
  const byId = new Map(all.map((v) => [v.id, v.id]));
  const byName = new Map(all.map((v) => [v.name.trim().toLowerCase(), v.id]));
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const out: DepartureIn[] = [];
  (list as unknown[]).forEach((raw, i) => {
    const at = `departures[${i}]`;
    if (!isObject(raw)) return void p.add(at, "must be an object");
    onlyFields(p, raw, ["external_id", "code", "start_date", "end_date", "guests", "services"], `${at}.`);
    const externalId = typeof raw.external_id === "string" ? raw.external_id.trim() : "";
    if (!EXTERNAL_ID.test(externalId)) p.add(`${at}.external_id`, "is required: the booking system's own id, up to 100 letters, digits and . _ : / # -");
    else if (seenIds.has(externalId)) p.add(`${at}.external_id`, "appears twice in this call");
    const code = typeof raw.code === "string" ? raw.code.trim().toUpperCase() : "";
    if (!CODE.test(code)) p.add(`${at}.code`, "must be the tour code, 3 to 32 letters, digits and dashes, e.g. HG-4D-1004");
    else if (seenCodes.has(code)) p.add(`${at}.code`, "appears twice in this call");
    const startOk = realDate(raw.start_date);
    const endOk = realDate(raw.end_date);
    if (!startOk) p.add(`${at}.start_date`, "must be a date, YYYY-MM-DD");
    if (!endOk) p.add(`${at}.end_date`, "must be a date, YYYY-MM-DD");
    if (startOk && endOk && (raw.end_date as string) < (raw.start_date as string)) p.add(`${at}.end_date`, "must be on or after start_date");
    const guests = raw.guests;
    if (!(typeof guests === "number" && Number.isInteger(guests) && guests >= 0 && guests <= 500)) p.add(`${at}.guests`, "must be a whole number from 0 to 500");
    const svcRaw = raw.services ?? [];
    const services: DepartureIn["services"] = [];
    if (!Array.isArray(svcRaw) || svcRaw.length > MAX_SERVICES) p.add(`${at}.services`, `must be a list of at most ${MAX_SERVICES} services`);
    else
      svcRaw.forEach((s, j) => {
        const sat = `${at}.services[${j}]`;
        if (!isObject(s)) return void p.add(sat, "must be an object");
        onlyFields(p, s, ["vendor_id", "vendor", "unit", "quantity"], `${sat}.`);
        let vendorId: string | undefined;
        if (typeof s.vendor_id === "string" && s.vendor_id) {
          vendorId = byId.get(s.vendor_id);
          if (!vendorId) p.add(`${sat}.vendor_id`, "is not a supplier on file (see GET /api/v1/vendors)");
        } else if (typeof s.vendor === "string" && s.vendor.trim()) {
          vendorId = byName.get(s.vendor.trim().toLowerCase());
          if (!vendorId) p.add(`${sat}.vendor`, "is not the exact name of a supplier on file (see GET /api/v1/vendors)");
        } else p.add(sat, "needs vendor_id or vendor (the supplier's exact name)");
        if (!(UNITS as readonly unknown[]).includes(s.unit)) p.add(`${sat}.unit`, `must be one of ${UNITS.join(", ")}`);
        const q = s.quantity;
        if (!(typeof q === "number" && Number.isInteger(q) && q >= 1 && q <= 10_000)) p.add(`${sat}.quantity`, "must be a whole number from 1 to 10000");
        if (vendorId) services.push({ vendorId, unit: s.unit as Unit, quantity: q as number });
      });
    seenIds.add(externalId);
    seenCodes.add(code);
    out.push({ externalId, code, startDate: raw.start_date as string, endDate: raw.end_date as string, guests: guests as number, services });
  });
  p.throwIfAny();
  return out;
}

export interface UpsertResult { departures: Array<{ external_id: string; id: string; code: string; result: "created" | "updated" }>; rechecked: number }

export async function upsertDepartures(db: Db, businessId: string, keyName: string, items: DepartureIn[]): Promise<UpsertResult> {
  const actor = `api:${keyName}`;
  const results: UpsertResult["departures"] = [];
  const touched = new Set<string>();
  const ts = now();
  db.transaction((tx) => {
    for (const d of items) {
      const ref = tx.select().from(apiDepartureRefs).where(and(eq(apiDepartureRefs.businessId, businessId), eq(apiDepartureRefs.externalId, d.externalId))).get();
      const byCode = tx.select().from(departures).where(and(eq(departures.businessId, businessId), eq(departures.code, d.code))).get();
      // A departure belongs to the key that first sent it: another key cannot change it (review R6 nit).
      if (ref && ref.keyName !== keyName) throw new ApiError(409, "departure_conflict", `external_id ${d.externalId} was sent by another API key, so this key cannot change it. Nothing in this call was saved.`);
      let id: string | null = ref?.departureId ?? null;
      if (id && byCode && byCode.id !== id) throw new ApiError(409, "departure_conflict", `external_id ${d.externalId}: code ${d.code} already belongs to another departure on file. Nothing in this call was saved.`);
      if (!id && byCode) {
        // A code already on file under no external id. Another external id claiming it is a conflict; one an approver
        // imported or typed in is refused just below.
        const claimed = tx.select().from(apiDepartureRefs).where(eq(apiDepartureRefs.departureId, byCode.id)).get();
        if (claimed) throw new ApiError(409, "departure_conflict", `external_id ${d.externalId}: code ${d.code} is already on file under another external_id. Nothing in this call was saved.`);
        id = byCode.id;
      }
      const current = id ? tx.select().from(departures).where(eq(departures.id, id)).get() : undefined;
      // A departure an approver imported or typed in is theirs: with the rate card it sets what a job may cost, which
      // only an approver or the owner may change. The feed neither takes it over nor overwrites it (review R2-S1).
      if (current && current.source !== "booking_system") {
        throw new ApiError(409, "departure_conflict", `external_id ${d.externalId}: departure ${current.code} was imported or entered by an approver in Checkrail, so the feed cannot change it. An approver updates it there. Nothing in this call was saved.`);
      }
      const existed = Boolean(current);
      if (id && existed) {
        tx.update(departures).set({ code: d.code, startDate: d.startDate, endDate: d.endDate, guests: d.guests, source: "booking_system" }).where(eq(departures.id, id)).run();
        for (const o of tx.select({ vendorId: departureServices.vendorId }).from(departureServices).where(eq(departureServices.departureId, id)).all()) touched.add(o.vendorId);
        tx.delete(departureServices).where(eq(departureServices.departureId, id)).run();
      } else {
        id = newId("dep");
        tx.insert(departures).values({ id, businessId, code: d.code, startDate: d.startDate, endDate: d.endDate, guests: d.guests, source: "booking_system", createdBy: actor, createdAt: ts }).run();
      }
      for (const s of d.services) {
        tx.insert(departureServices).values({ id: newId("dsv"), departureId: id, vendorId: s.vendorId, unit: s.unit, quantity: s.quantity }).run();
        touched.add(s.vendorId);
      }
      if (ref) tx.update(apiDepartureRefs).set({ departureId: id, updatedAt: ts }).where(eq(apiDepartureRefs.id, ref.id)).run();
      else tx.insert(apiDepartureRefs).values({ id: newId("adr"), businessId, externalId: d.externalId, departureId: id, keyName, createdAt: ts, updatedAt: ts }).run();
      results.push({ external_id: d.externalId, id, code: d.code, result: existed ? "updated" : "created" });
    }
  });
  audit(db, {
    obligationId: null,
    actor,
    action: "departures.upserted",
    detail: { created: results.filter((r) => r.result === "created").length, updated: results.filter((r) => r.result === "updated").length, codes: results.slice(0, 20).map((r) => r.code), services: items.reduce((n, d) => n + d.services.length, 0) },
  });
  // What waits on the suppliers it touched is checked again, as after a manifest import or a new rate.
  let rechecked = 0;
  for (const vendorId of touched) {
    try {
      rechecked += await recheckVendorItems(db, businessId, vendorId, actor);
    } catch (e) {
      console.error("[checkrail] api departures: re-check failed", vendorId, e);
    }
  }
  return { departures: results, rechecked };
}

/** The departures this key sent, starting on or after `since`: a key never reads another key's or an approver's (R7-N1). */
export function departuresSince(db: Db, businessId: string, keyName: string, since: string | null) {
  if (since !== null && !realDate(since)) throw new ApiError(422, "validation_failed", "since must be a date, YYYY-MM-DD", [{ field: "since", message: "must be a date, YYYY-MM-DD" }]);
  const refs = db.select().from(apiDepartureRefs).where(and(eq(apiDepartureRefs.businessId, businessId), eq(apiDepartureRefs.keyName, keyName))).all();
  const refOf = new Map(refs.map((r) => [r.departureId, r]));
  const deps = listDepartures(db, businessId).filter((d) => refOf.has(d.id) && (!since || d.startDate >= since));
  return deps
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.code.localeCompare(b.code))
    .slice(0, 1000)
    .map((d) => ({
      id: d.id,
      external_id: refOf.get(d.id)?.externalId ?? null,
      code: d.code,
      start_date: d.startDate,
      end_date: d.endDate,
      guests: d.guests,
      source: d.source,
      updated_at: refOf.get(d.id)?.updatedAt ?? d.createdAt,
      services: d.services.map((s) => ({ vendor_id: s.vendorId, vendor: s.vendorName, unit: s.unit, quantity: s.quantity })),
    }));
}
