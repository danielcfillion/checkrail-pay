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
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(re)) {
      const k = m[0].toUpperCase();
      out.add(k);
      // JOB-HG4D-0914 and trip sheet HG-4D-0914 name the same departure: normalise by stripping the prefix and dashes.
      const core = k.replace(/^(INV|JOB|BK|PO|REF|TRIP|TOUR|AGR)-/, "").replace(/-/g, "");
      if (core.length >= 6) out.add(`~${core}`);
    }
  }
  return [...out].map((k) => k.toLowerCase());
}
