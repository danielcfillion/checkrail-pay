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
      const core = k.replace(/^(INV|JOB|BK|PO|REF|TRIP|TOUR|AGR)-/, "").replace(/-/g, "");
      if (core.length >= 6) out.add(`~${core}`);
      // A re-issued invoice often carries a suffix: INV-TAM-0834-B, INV-0152-R, INV-0152-REV2. Index it under the original too.
      const reissue = k.match(/^(.*\d{3,6})-(?:[A-Z]|R\d?|REV\d*|COPY|V\d)$/);
      if (reissue) {
        const base = reissue[1].replace(/^(INV|JOB|BK|PO|REF|TRIP|TOUR|AGR)-/, "").replace(/-/g, "");
        if (base.length >= 6) out.add(`~${base}`);
      }
    }
  }
  return [...out].map((k) => k.toLowerCase());
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

/** True when the flag comes only from mixed scripts that the fold list could not map back to Latin. */
export function mixesScripts(s: string | null | undefined): boolean {
  return !!s && hasConfusables(s) && foldConfusables(s) === s.normalize("NFKC");
}
