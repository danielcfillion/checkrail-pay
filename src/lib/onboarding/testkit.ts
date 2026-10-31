import type { Db } from "../db";
import { businesses, onboardingMarks, rateCards, vendors } from "../db/schema";
import { DEFAULT_POLICY, type ApprovalPolicy } from "../domain/types";
import { payoutHashOf } from "../engine/orchestrator";
import { resolveActor, seedDemoTeam, type Actor } from "../engine/users";
import type { Category } from "../check/recheck";
import { newId } from "../domain/ids";
import { storeImport } from "./imports";
import { DEMO_BANK_HEADER, DEMO_BANK_SPEC } from "./seed";
import { loadCalls, type Mark } from "./calls";

/** Test helpers for the onboarding modules: a small business, its people, suppliers and hand-made re-check results. */

export const BIZ = "biz_test_onb";

export function setUpBusiness(db: Db, policy: Partial<ApprovalPolicy> = {}, createdAt = "2026-08-01T00:00:00.000Z"): Record<"owner" | "approver" | "clerk" | "accountant", Actor> {
  db.insert(businesses).values({ id: BIZ, name: "Test Tours", baseCurrency: "USD", country: "VN", policyJson: JSON.stringify({ ...DEFAULT_POLICY, ...policy }), createdAt }).run();
  seedDemoTeam(db, BIZ);
  return {
    owner: resolveActor(db, BIZ, "daniel", "admin"),
    approver: resolveActor(db, BIZ, "minh", "approver"),
    clerk: resolveActor(db, BIZ, "lan", "clerk"),
    accountant: resolveActor(db, BIZ, "thu", "accountant"),
  };
}

export function addVendor(db: Db, id: string, name: string, opts: { verified?: boolean; status?: string } = {}): void {
  const payout = { paypalEmail: null, stellarAccount: null, bankLabel: `Bank ****${id.slice(-4)}`, bankCountry: "VN", bankCurrency: "VND" };
  db.insert(vendors).values({ id, businessId: BIZ, name, role: "supplier", country: "VN", ...payout, detailsHash: payoutHashOf(payout), verifiedAt: opts.verified === false ? null : "2026-08-01T00:00:00.000Z", verifiedBy: "user:minh", status: opts.status ?? "active", createdAt: "2026-08-01T00:00:00.000Z" }).run();
}

export function addRateCard(db: Db, vendorId: string): void {
  db.insert(rateCards).values({ id: newId("rte"), businessId: BIZ, vendorId, unit: "trip", rateMinor: 100_000_000, currency: "VND", validFrom: "2026-01-01", createdBy: "user:minh", createdAt: "2026-08-01T00:00:00.000Z" }).run();
}

export interface Line {
  date: string;
  payee: string;
  amount?: number;
  ref?: string | null;
  cat?: Category;
  rules?: string[];
  overpaid?: number;
  dupOf?: number;
  mark?: Mark;
}

/** Store one import of hand-made results (file rows numbered from 2) with the marks given. Returns the import id. */
export function addImport(db: Db, lines: Line[], createdAt = "2026-10-20T00:00:00.000Z"): string {
  const results = lines.map((l, i) => {
    const cat = l.cat ?? "clean";
    return { row: i + 2, date: l.date, payee: l.payee, amountMinor: l.amount ?? 100_000_000, reference: l.ref === undefined ? `REF-${i}` : l.ref, category: cat, verdict: (cat === "clean" ? "pay" : cat === "needs_a_look" ? "hold" : "block") as "pay" | "hold" | "block", reason: cat === "clean" ? "Every rule passed" : `Flagged: ${(l.rules ?? []).join(", ")}`, rules: l.rules ?? [], overpaidMinor: l.overpaid ?? 0, duplicateOfRow: l.dupOf ?? null };
  });
  const id = storeImport(db, { businessId: BIZ, fileName: "test.csv", currency: "VND", header: DEMO_BANK_HEADER, spec: DEMO_BANK_SPEC, rowsRead: results.length, outside: 0, skipped: [], results, createdBy: "user:lan", createdAt });
  // Marks go in directly, without the permission check: these are fixtures.
  const calls = loadCalls(db, BIZ, { importId: id });
  lines.forEach((l, i) => {
    if (!l.mark) return;
    const c = calls.find((x) => x.row === i + 2)!;
    db.insert(onboardingMarks).values({ id: newId("obk"), businessId: BIZ, resultId: c.id, mark: l.mark, markedBy: "user:daniel", markedAt: createdAt }).run();
  });
  return id;
}
