import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { vendors } from "../db/schema";
import { clean } from "../agent/guard";
import { OBLIGATION_STATES } from "../domain/types";

/**
 * What an integration may read of a rule's message, the same rewrite the agent guard gives agents (src/lib/agent/guard.ts,
 * forAgent and otherNames, which are private there and left as they are). That a reference is on another supplier's
 * payment is enough to stop; which supplier, and how far that payment got, would let a caller map who was paid for what.
 * Then the guard's clean(): no emails, account numbers or payout addresses, and no other supplier's name.
 */

const OTHER_VENDOR_TEXT = "This reference is also on a payment to another supplier; a person checks who did the job";
/** The policy message for reference_other_vendor, for stored reasons that no longer carry their rule id. */
const OTHER_VENDOR_MESSAGE = /Reference \S+ is also on a payment to .*? \([a-z_]+\); confirm who did this job/g;

/** A request state as policy messages write it ("settled", "awaiting_approval" or "awaiting approval"). */
const STATE = `(?:${OBLIGATION_STATES.flatMap((s) => [s, s.replace(/_/g, " ")]).join("|")})`;

export function forIntegration(rule: string | null, message: string): string {
  if (rule === "reference_other_vendor") return OTHER_VENDOR_TEXT;
  // How far an earlier payment got is not the integration's to know (review R4-N1): "(settled)" goes, and
  // "(USD 190.00, approved 1 Nov)" keeps only the amount.
  return message
    .replace(OTHER_VENDOR_MESSAGE, OTHER_VENDOR_TEXT)
    .replace(new RegExp(`\\s*\\(${STATE}\\)`, "g"), "")
    .replace(new RegExp(`, ${STATE}(?: \\d{1,2} [A-Z][a-z]{2})?\\)`, "g"), ")");
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/** Every supplier's name except the ones kept (the payee asked about). */
export function otherNames(db: Db, businessId: string, keep: Array<string | null | undefined>): string[] {
  const kept = new Set(keep.filter(Boolean).map((n) => norm(n!)));
  return db.select({ name: vendors.name }).from(vendors).where(eq(vendors.businessId, businessId)).all().map((v) => v.name).filter((n) => !kept.has(norm(n)));
}

export function reasonForIntegration(rule: string | null, message: string, others: string[], keep: string | null): string {
  return clean(forIntegration(rule, message), others, keep);
}
