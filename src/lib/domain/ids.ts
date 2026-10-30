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
      out.add(k);
      // JOB-HG4D-0914 and trip sheet HG-4D-0914 name the same departure: normalise by stripping the prefix and dashes.
      // Only JOB, TRIP and TOUR name a departure; INV, BK, PO and REF stay, so INV-2026-0152 is not PO-2026-0152
      // (AG5-3), and an agreement number stays an agreement number (AGR...) for the shared-contract exclusions (AG4-2).
      const core = k.replace(/^(JOB|TRIP|TOUR)-/, "").replace(/-/g, "");
      if (core.length >= 6) out.add(`~${core}`);
      for (const f of canonicalForms(k)) out.add(`~${f}`);
      // A re-issued invoice often carries a suffix: INV-TAM-0834-B, INV-0152-R, INV-0152-REV2. Index it under the original too.
      const reissue = k.match(/^(.*\d{3,6})-(?:[A-Z]|R\d?|REV\d*|COPY|V\d)$/);
      if (reissue) {
        const base = reissue[1].replace(/^(JOB|TRIP|TOUR)-/, "").replace(/-/g, "");
        if (base.length >= 6) out.add(`~${base}`);
        for (const f of canonicalForms(reissue[1])) out.add(`~${f}`);
      }
    }
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
  const compact = runs.join("");
  if ((compact.match(/\d/g) ?? []).length >= 8) out.push(compact);
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
  if (prefixed && prefixed[3]) out.push(...formsOf(prefixed[3]));
  out.push(...formsOf(t));
  return [...new Set(out)];
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
  const reissue = t.match(/^(.*\d{3,6})[^\p{L}\p{N}]+(?:[A-Z]|R\d?|REV\d*|COPY|V\d)$/u);
  if (reissue) for (const f of canonicalForms(reissue[1])) out.add(`~${f}`);
  return [...out];
}

/** The re-issue base of a reference when it has one, else its first comparison form: what a probe for one job keys on. */
export function jobOfRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const t = foldRef(ref);
  const reissue = t.match(/^(.*\d{3,6})[^\p{L}\p{N}]+(?:[A-Z]|R\d?|REV\d*|COPY|V\d)$/u);
  // The first form is the departure form (JOB/TRIP/TOUR set aside, numbers kept apart), the same for every spelling
  // the duplicate check treats as one job (AG5-6).
  return canonicalForms(reissue ? reissue[1] : t)[0] ?? null;
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
