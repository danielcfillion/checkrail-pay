import { randomUUID, createHash } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Stable hash of a vendor's payout details. Any change invalidates verification. */
export function hashPayoutDetails(parts: Array<string | null | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("|")).digest("hex").slice(0, 24);
}

/** Idempotency key derived from the obligation and attempt number. Same inputs, same key. */
export function idempotencyKey(obligationId: string, attemptNo: number): string {
  return createHash("sha256").update(`${obligationId}:${attemptNo}`).digest("hex").slice(0, 32);
}

/**
 * Identifiers that name a job, trip or invoice inside free text: INV-2026-0152, JOB-HG4D-0914,
 * HG-4D-0927, PAL-3D-0927, PO-1182. Lower-cased and de-duplicated. Used to catch the same job
 * re-submitted under a different reference.
 */
/**
 * A departure code in any spelling in free text: CEB-2D-1107, CEB2D1107, CEB 2D 1107. The middle part is a number of
 * days ("2D", "10D"), so "NOV 2ND 2026", "ROOM 2A 1105" and "PAX 4X 1200" are not departures (AG7-4).
 */
const DEPARTURE_LOOSE = /\b([A-Za-z]{2,5})[-_ ./]?(\d{1,2}[Dd])[-_ ./]?(\d{3,6})\b/g;
/**
 * Words before a "2D 1105"-shaped run that make it not a departure: places in a room or a vehicle, months and days,
 * and ordinary short words ("for 3d 1500") (AG8-5).
 */
const NOT_A_DEPARTURE = new Set(["ROOM", "RM", "SEAT", "ROW", "GATE", "BED", "UNIT", "FLOOR", "FLR", "LEVEL", "BLOCK", "COVID", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "SEPT", "OCT", "NOV", "DEC", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN", "THE", "FOR", "AND", "AT", "IN", "ON", "OF", "TO", "BY", "PER", "WITH", "FROM", "ABOUT", "OVER", "PAY", "PAID", "USD", "PHP", "VND", "THB", "EUR", "GBP", "QTY", "PAX", "NO", "NR", "NUM"]);
/** A year as the trip number ("Trip MNL 1D 2026") counts only when the code is written with dashes, as departures are. */
const departureRun = (prefix: string, trip: string, dashed = true) => !NOT_A_DEPARTURE.has(prefix.toUpperCase()) && (dashed || !/^(?:19|20)\d{2}$/.test(trip));

/** Is this reference itself a departure code ("HG-4D-1184", "ceb2d1305")? Its forms then name the job, wherever it is filed (AG8-3). */
export function isDepartureRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const t = foldRef(ref).replace(/^(?:JOB|TRIP|TOUR)[^\p{L}\p{N}]*/u, "");
  const m = t.match(/^([A-Z]{2,5})[^\p{L}\p{N}]?(\d{1,2}D)[^\p{L}\p{N}]?(\d{3,6})$/u);
  return Boolean(m && departureRun(m[1], m[3]));
}

/**
 * A re-issue suffix on a reference: "-B", "-R2", "-REV2", "-COPY", "-V2", or a single letter glued to the number
 * ("INV-2026-0452B") (AG8-4). The original is matched too.
 */
const REISSUE = /^(.*\d{3,6})(?:[^\p{L}\p{N}]+(?:[A-Z]|R\d?|REV\d*|COPY|V\d)|[A-Z])$/u;

/** Strip the strength mark from a key: "~" names one job, "^" a booking or order that one or a few jobs share. */
export const bareKey = (k: string) => k.replace(/^[~^]/, "");
export const isSharedKey = (k: string) => k.startsWith("^");

export function jobKeys(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  const re = /\b(?:(?:INV|JOB|BK|PO|REF|TRIP|TOUR|AGR)-[A-Z0-9][A-Z0-9-]{2,}|[A-Z]{2,5}-\d[A-Z0-9]{0,3}-\d{3,6})\b/gi;
  for (const raw of texts) {
    if (!raw) continue;
    const t = foldConfusables(raw);
    for (const m of t.matchAll(re)) {
      // A match that runs into a truncation mark ("JOB-KAL2...") is a cut-off identifier, not a job. Skip it.
      const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 3);
      if (after.startsWith("...") || after.startsWith("…")) continue;
      const k = m[0].toUpperCase();
      // "OCT-31-2026", "RM-2-101", "GATE-3-1100" are a date, a room and a gate, not a departure (AG8-5).
      const shape = k.match(/^([A-Z]{2,5})-\d[A-Z0-9]{0,3}-(\d{3,6})$/);
      if (shape && !/^(?:INV|JOB|BK|PO|REF|TRIP|TOUR|AGR)$/.test(shape[1]) && !departureRun(shape[1], shape[2])) continue;
      // A booking or purchase order number in text (BK-55825, PO-7795) is shared by the parts of one job: "^" keys,
      // a hold, not a block (AG7-6). The departure it names, if any, is still the job ("~").
      const mark = /^(?:BK|PO)-/.test(k) ? "^" : "~";
      out.add(mark === "^" ? `^${k}` : k);
      // Compared in its comparison forms (see canonicalForms): JOB-HG4D-0914 and the trip sheet's HG-4D-0914 are one
      // departure; INV-2026-0152 is not PO-2026-0152 (AG5-3); INV-12-345 is not INV-123-45 (AG6-4).
      const deps = new Set(departureForms(k));
      for (const f of canonicalForms(k)) out.add(`${deps.has(f) ? "~" : mark}${f}`);
      // A re-issued invoice often carries a suffix: INV-TAM-0834-B, INV-0152-R, INV-0152-REV2. Index it under the original too.
      const reissue = k.match(REISSUE);
      if (reissue) for (const f of canonicalForms(reissue[1])) out.add(`${deps.has(f) ? "~" : mark}${f}`);
    }
    // A departure written without dashes in free text ("CEB2D1107", "CEB 2D 1107") is the same departure (AG6-7).
    // In any case and with any of - _ . / or a space between the parts (AG8-1); not a room, seat, date or year (AG8-5).
    for (const m of t.matchAll(DEPARTURE_LOOSE)) if (departureRun(m[1], m[3], /^[^-]*-[^-]*-[^-]*$/.test(m[0]))) for (const f of canonicalForms(`${m[1].toUpperCase()}-${m[2].toUpperCase()}-${m[3]}`)) out.add(`~${f}`);
  }
  return [...out].map((k) => k.toLowerCase());
}

/**
 * A reference folded for comparison: look-alike letters to Latin, accents and Đ set aside, "№" dropped, "INVOICE"
 * read as "INV", upper case. Letters of other scripts are kept, not deleted (agent guard review AG4-3).
 */
function foldRef(ref: string): string {
  return foldConfusables(ref.replace(/№/g, " ")).normalize("NFKD").replace(/\p{M}/gu, "").replace(/Đ/g, "D").replace(/đ/g, "d").toUpperCase().replace(/^INVOICE(?=[^\p{L}]|$)/u, "INV").trim();
}

/** Letters and digits of a folded reference, two ways: digit runs kept apart and without leading zeros, and, for a long number, all run together. */
function formsOf(t: string): string[] {
  const runs = t.match(/\p{L}+|\d+/gu) ?? [];
  let dotted = "";
  runs.forEach((r, i) => {
    const digits = /^\d+$/.test(r);
    if (digits && i > 0 && /^\d+$/.test(runs[i - 1])) dotted += ".";
    dotted += digits ? r.replace(/^0+(?=\d)/, "") : r;
  });
  const out = [dotted];
  // A long number written once with a separator and once without (INV-2026-0152, INV20260152) is one number; three or
  // more numbers are not run together, so INV-2026-1-123 is not INV-2026-11-23 (AG6-4).
  const compact = runs.join("");
  if ((compact.match(/\d/g) ?? []).length >= 8 && runs.filter((r) => /^\d+$/.test(r)).length <= 2) out.push(compact);
  return out.filter((f) => f.replace(/\./g, "").length >= 3 && /\d/.test(f)).map((f) => f.toLowerCase());
}

/**
 * The forms a reference is compared in, whatever separators, case, leading zeros or look-alike letters it was written
 * with (agent guard reviews AG3-1, AG4-1): "INV-0152", "INV_152", "inv152" and "INV#152" share "inv152", and
 * "JOB-HG4D-0914", "JOBHG4D0914" and the trip sheet's "HG-4D-0914" share "hg4d914". Only JOB, TRIP and TOUR are set
 * aside as a prefix (they name the departure); INV, PO, BK, REF and AGR stay, so "INV-1182" is not "PO-1182" (AG4-3).
 * Two numbers kept apart by a separator stay apart ("2026-1-12" is not "2026-11-2"). Empty when nothing is left.
 */
export function canonicalForms(ref: string | null | undefined): string[] {
  if (!ref) return [];
  const t = foldRef(ref);
  const out: string[] = [];
  const prefixed = t.match(/^(JOB|TRIP|TOUR)([^\p{L}\p{N}]*)(.*)$/u);
  // "TOUR 2026" or "TRIP 152" is a year or a count, not a departure: a bare number after TOUR or TRIP needs five
  // digits before it stands alone (AG7-12). JOB-152 and a bare 152 stay one job.
  const tooShort = prefixed && prefixed[1] !== "JOB" && /^\d{1,4}$/.test(prefixed[3].replace(/[^\p{L}\p{N}]/gu, ""));
  if (prefixed && prefixed[3] && !tooShort) out.push(...formsOf(prefixed[3]));
  out.push(...formsOf(t));
  out.push(...departureForms(t));
  return [...new Set(out)];
}

/**
 * The departure an invoice, order or booking is named after (INV-HG4D-1031, PO.CEB2D.1024, INVHG4D1183), in comparison
 * form (AG6-1, AG7-3). Only a departure-shaped remainder counts, so INV-TAM-0834 and PO-TAM-0834 stay apart.
 */
export function departureForms(ref: string | null | undefined): string[] {
  if (!ref) return [];
  const t = foldRef(ref);
  const named = t.match(/^(?:INV|PO|BK|REF)[^\p{L}\p{N}]*(.+)$/u);
  const dep = named?.[1].match(/^([A-Z]{2,5})[^\p{L}\p{N}]?(\d[A-Z]{1,3})[^\p{L}\p{N}]?(\d{3,6})(?:[^\p{L}\p{N}].*)?$/u);
  return dep ? formsOf(`${dep[1]}-${dep[2]}-${dep[3]}`) : [];
}

/** The first comparison form of a reference, or null (see canonicalForms). */
export function canonicalRef(ref: string | null | undefined): string | null {
  return canonicalForms(ref)[0] ?? null;
}

/**
 * The keys a stated reference is matched on, beside the job identifiers jobKeys finds in text: the reference as
 * written, its comparison forms, and those of the original when it carries a re-issue suffix after a separator
 * ("10234-B", "INV 0152 R", "INV-0834-REV2" also key 10234, inv152, inv834).
 */
export function sourceRefKeys(ref: string | null | undefined): string[] {
  if (!ref) return [];
  const t = foldRef(ref);
  const out = new Set<string>([foldConfusables(ref).toLowerCase().trim()]);
  for (const f of canonicalForms(t)) out.add(`~${f}`);
  const reissue = t.match(REISSUE);
  if (reissue) for (const f of canonicalForms(reissue[1])) out.add(`~${f}`);
  return [...out];
}

/**
 * What a probe for one job keys on: the re-issue base, JOB/TRIP/TOUR set aside, and a long number run together, so
 * every spelling the duplicate check treats as one job keys the same (AG5-6, AG6-12).
 */
export function jobOfRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const t = foldRef(ref);
  const reissue = t.match(REISSUE);
  const base = reissue ? reissue[1] : t;
  const stripped = base.match(/^(?:JOB|TRIP|TOUR)[^\p{L}\p{N}]*(.+)$/u)?.[1] ?? base;
  const forms = formsOf(stripped);
  return forms.find((f) => !f.includes(".") && (f.match(/\d/g) ?? []).length >= 8) ?? forms[0] ?? null;
}

/**
 * A booking or purchase order named in free text ("booking BKG-55821", "PO# 7781", "reservation no. 4471"): soft "^"
 * keys, since one booking can honestly carry a deposit and a balance (AG6-5, AG6-7).
 */
export function bookingKeys(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  // "PO" only in capitals: "po" is also a Tagalog particle (AG7-5).
  const re = /\b(?:(?:[Bb]ooking|BOOKING|[Bb]kg|BKG|[Rr]eservation|RESERVATION|[Pp]urchase\s+[Oo]rder|PURCHASE\s+ORDER)|P\.?O\.?)\s*(?:[Rr]ef(?:erence)?|REF|[Nn]o\.?|NO\.?|[Nn]umber|#)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})\b(?!\s*(?:VND|USD|PHP|THB|EUR|đ|₫|dong|nights?|guests?|pax))/g;
  for (const raw of texts) {
    if (!raw) continue;
    for (const m of foldConfusables(raw).matchAll(re)) {
      const r = m[1];
      const digits = (r.match(/\d/g) ?? []).length;
      // A year, a date run together, a phone number, an amount or a duration ("4D3N") is not a booking (AG7-5).
      if (r.length < 5 || digits === 0 || isDateLike(r) || /^(?:19|20)\d{2}$/.test(r) || /^(?:19|20)\d{6}$/.test(r) || /^\+?0?\d{9,11}$/.test(r) || /^\d+D\d+N$/i.test(r)) continue;
      // A season ("Q4-2026", "2026-Q4") is not a booking (AG8-7).
      if (/^Q[1-4][-/]?(?:19|20)\d{2}$/i.test(r) || /^(?:19|20)\d{2}[-/]?Q[1-4]$/i.test(r)) continue;
      // A booking named after a departure names that departure: the job, not a shared record (AG8-3).
      const dep = isDepartureRef(r) ? new Set(canonicalForms(r)) : new Set(departureForms(r));
      for (const f of canonicalForms(r)) out.add(`${dep.has(f) ? "~" : "^"}${f}`);
    }
  }
  return [...out];
}

/** A date written as a reference ("2026-10-31", "31/10/2026") names a day, not a job (AG6-3). */
export function isDateLike(ref: string): boolean {
  return /^\s*(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\s*$/.test(ref);
}

/**
 * Letters from other scripts that look like Latin ones in references (Cyrillic and Greek capitals and smalls),
 * folded to Latin so "JOB-HG4D-0914" with a Cyrillic O keys the same job as the plain one.
 */
const CONFUSABLE: Record<string, string> = {
  "\u0410": "A", "\u0412": "B", "\u0415": "E", "\u041A": "K", "\u041C": "M", "\u041D": "H", "\u041E": "O", "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u0423": "Y", "\u0406": "I", "\u0408": "J", "\u0405": "S",
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P", "\u03A4": "T", "\u03A5": "Y", "\u03A7": "X",
  "\u03BF": "o", "\u03B9": "i", "\u03BA": "k", "\u03BD": "v",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE).join("")}]`, "g");

/** NFKC (full-width digits and letters become ASCII), look-alike letters to Latin, every dash to "-", zero-width marks removed. */
export function foldConfusables(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLE[c]);
}

/** Letters and digits that are plain Latin: ASCII, Latin-1 to Extended-B and Latin Extended Additional (Vietnamese and the like). */
const PLAIN_LATIN = /[A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF]/g;

/**
 * True when a reference carries letters from another script or invisible marks that make it look like something else.
 * The fold list above only covers Cyrillic and Greek, so there is a second, list-free test: a token (a run of letters
 * and digits) that mixes plain ASCII with any letter or digit outside plain Latin (Armenian, Cherokee, Coptic, Latin
 * small capitals, Devanagari digits and the rest) is flagged. A whole word in another script, or Vietnamese with
 * its diacritics, is not.
 */
export function hasConfusables(s: string | null | undefined): boolean {
  if (!s) return false;
  const n = s.normalize("NFKC");
  if (foldConfusables(s) !== n) return true;
  return n.split(/[^\p{L}\p{N}]+/u).some((tok) => /[A-Za-z0-9]/.test(tok) && /[\p{L}\p{N}]/u.test(tok.replace(PLAIN_LATIN, "")));
}

/**
 * Reference-shaped words in free text that carry a look-alike: a letter from another script or a hidden character
 * inside something shaped like JOB-HG4D-0914 or PO-1182. The reference field is always ASCII, so the look-alike has
 * to be looked for in the request and its records, where it hides a re-issued job from the duplicate checks. Words
 * with no hyphen and a digit after it (ordinary prose, Thai or Khmer text with a number glued on) are not references
 * and are left alone.
 */
export function lookalikeWords(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of t.split(/\s+/)) {
      if (!w || w.length > 80) continue;
      if (!/[A-Za-z]{1,6}-[A-Za-z0-9-]*\d/.test(w.replace(/[^\x00-\x7F]/g, ""))) continue;
      if (hasConfusables(w)) out.add(w);
    }
  }
  return [...out];
}

/** True when the flag comes only from mixed scripts that the fold list could not map back to Latin. */
export function mixesScripts(s: string | null | undefined): boolean {
  return !!s && hasConfusables(s) && foldConfusables(s) === s.normalize("NFKC");
}
