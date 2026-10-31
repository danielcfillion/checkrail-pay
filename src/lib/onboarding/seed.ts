import { and, eq, like } from "drizzle-orm";
import type { Db } from "../db";
import { auditEntries, onboardingMappings, onboardingMarks, onboardingSuggestions } from "../db/schema";
import { newId } from "../domain/ids";
import { resolveActor } from "../engine/users";
import type { Category, RecheckRow } from "../check/recheck";
import { applySuggestion, generateSuggestions } from "./calibration";
import { loadCalls, weekStart, type Mark } from "./calls";
import { headerSignature, type ImportSpec } from "./detect";
import { storeImport } from "./imports";

/**
 * Demo onboarding data for Ridgeline Expeditions: a re-check of eight weeks of past VND bank payments to its four
 * Vietnamese suppliers, then four weekly re-checks since, with the owner's marks on the last six weeks, the
 * suggestions those marks produce, and one of them (connect a booking feed) applied. All fictional.
 *
 * Deterministic in shape: dates are placed in whole weeks counted back from the current Monday, so the weekly figures
 * are the same whatever day the seed runs. Readiness reads 3 of 4: holds that turned out fine were under 10% for the
 * last two weeks, every supplier is verified, no duplicate was missed, and rate cards cover about half the spend
 * (Dao Mountain Lodge and Tam Motorbike Rental have none; applying the proposed Dao rate card lifts it past 80%).
 */

/** The demo bank's export header (a fictional Vietnamese bank). src/lib/onboarding/__fixtures__/vn-bank-export.csv uses it. */
export const DEMO_BANK_HEADER = ["STT", "Ngày giao dịch", "Số tham chiếu", "Tên người hưởng", "Số tiền ghi nợ", "Số tiền ghi có", "Số dư", "Nội dung"];
export const DEMO_BANK_SPEC: ImportSpec = {
  skipRows: 4,
  columns: { date: "Ngày giao dịch", payee: "Tên người hưởng", amount: "Số tiền ghi nợ", reference: "Số tham chiếu", description: "Nội dung" },
  dateFormat: "DMY",
  outgoing: "any",
};

type Slot = "p1" | "l1" | "t1" | "d1" | "dup" | "p2" | "l2";
const SLOTS: Record<Exclude<Slot, "dup">, { payee: string; amount: number; offset: number; prefix: string }> = {
  p1: { payee: "Phuong Transport", amount: 400_000_000, offset: 0, prefix: "INV-PT" },
  l1: { payee: "Linh Family Homestay", amount: 540_000_000, offset: 1, prefix: "HS" },
  t1: { payee: "Tam Motorbike Rental", amount: 720_000_000, offset: 2, prefix: "INV-TAM" },
  d1: { payee: "Dao Mountain Lodge", amount: 1_360_000_000, offset: 2, prefix: "INV-DML" },
  p2: { payee: "Phuong Transport", amount: 400_000_000, offset: 3, prefix: "INV-PT" },
  l2: { payee: "Linh Family Homestay", amount: 540_000_000, offset: 4, prefix: "HS" },
};
const ORDER: Slot[] = ["p1", "l1", "t1", "d1", "dup", "p2", "l2"];

const EV = "evidence_present";
const SANE = "amount_sane";
/** A flagged call: what the re-check said and, from week 6 on, the owner's mark. */
type Flag = { kind: "hold"; rules: string[] } | { kind: "over"; amount: number } | { kind: "other"; rule: string } | { kind: "dup" };
type Spec = Partial<Record<Slot, [Flag, Mark?]>>;
const H = (...rules: string[]): Flag => ({ kind: "hold", rules });
const O = (amount: number): Flag => ({ kind: "over", amount });
const D: Flag = { kind: "dup" };

/** Weeks back from the current one (12 is the oldest). A week without "dup" has no repeat payment. */
const WEEKS: Record<number, Spec> = {
  12: { d1: [H(EV)], t1: [H(EV)] },
  11: { d1: [H(EV)], l2: [H(EV)], dup: [D] },
  10: { t1: [H(EV, SANE)], d1: [H(EV)] },
  9: { d1: [H(EV)], t1: [H(EV)], l1: [O(720_000_000)] },
  8: { d1: [H(EV)], t1: [H(EV)], p2: [H(EV)] },
  7: { d1: [H(EV, SANE)], t1: [H(EV)] },
  6: { d1: [H(EV), "was_fine"], t1: [H(EV), "was_fine"], l1: [H(EV), "was_fine"], dup: [D, "right_catch"] },
  5: { d1: [H(EV, SANE), "was_fine"], t1: [H(EV, SANE), "was_fine"], l1: [O(720_000_000), "right_catch"], p2: [H(EV), "right_catch"] },
  4: { d1: [H(SANE), "was_fine"], t1: [{ kind: "other", rule: "reference_other_vendor" }, "right_catch"], dup: [D, "right_catch"], l2: [H(EV), "right_catch"] },
  3: { d1: [H(SANE), "was_fine"], t1: [O(900_000_000), "right_catch"], dup: [D, "right_catch"], l1: [H(EV), "right_catch"], p2: [H(EV), "right_catch"] },
  2: { d1: [H(SANE), "right_catch"], t1: [O(900_000_000), "right_catch"], dup: [D, "right_catch"] },
  1: { dup: [D, "right_catch"], l2: [O(720_000_000), "right_catch"], t1: [H(EV), "right_catch"], p2: [H(EV)] },
};

/** The figures the seeded dashboard shows, for tests and the demo script. */
export const ONBOARDING_SEED = {
  imports: 5,
  payments: 6 * 12 + 6,
  flagged: Object.values(WEEKS).reduce((n, w) => n + Object.keys(w).length, 0),
  marked: Object.values(WEEKS).reduce((n, w) => n + Object.values(w).filter((v) => v?.[1]).length, 0),
  readinessMet: 3,
  readinessTotal: 4,
  /** Proposed: rate cards for Dao Mountain Lodge and Tam Motorbike Rental. Applied: connect a booking feed. */
  suggestions: { proposed: 2, applied: 1 },
} as const;

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const ymd = (t: number) => iso(t).slice(0, 10);
const VND = (minor: number) => `VND ${(minor / 100).toLocaleString("en-US")}`;

type SeedRow = Pick<RecheckRow, "row" | "date" | "payee" | "amountMinor" | "reference" | "category" | "verdict" | "reason" | "rules" | "overpaidMinor" | "duplicateOfRow"> & { mark?: Mark };

function weekRows(w: number, monday: number): Array<Omit<SeedRow, "row" | "duplicateOfRow"> & { slot: Slot; offset: number }> {
  const spec = WEEKS[w];
  const out: Array<Omit<SeedRow, "row" | "duplicateOfRow"> & { slot: Slot; offset: number }> = [];
  for (const slot of ORDER) {
    if (slot === "dup" && !spec.dup) continue;
    const base = SLOTS[slot === "dup" ? "p1" : slot];
    const offset = slot === "dup" ? 2 : base.offset;
    const date = ymd(monday + offset * DAY);
    // A repeat payment carries the reference of the one it repeats (Monday's transport invoice).
    const refDate = slot === "dup" ? ymd(monday + SLOTS.p1.offset * DAY) : date;
    const reference = `${base.prefix}-${refDate.slice(5, 7)}${refDate.slice(8, 10)}`;
    const [flag, mark] = spec[slot] ?? [];
    let amountMinor = base.amount;
    let category: Category = "clean";
    let reason = "Every rule passed";
    let rules: string[] = [];
    let overpaidMinor = 0;
    if (flag?.kind === "hold") {
      category = "needs_a_look";
      rules = flag.rules;
      reason = flag.rules[0] === EV ? "No supporting evidence: nothing shows the job behind this payment" : "More than this supplier is usually paid";
    } else if (flag?.kind === "over") {
      category = "overcharge";
      amountMinor = flag.amount;
      overpaidMinor = flag.amount - base.amount;
      rules = ["amount_matches_evidence"];
      reason = `Requested ${VND(flag.amount)} but the job record says ${VND(base.amount)}`;
    } else if (flag?.kind === "other") {
      category = "blocked_other";
      rules = [flag.rule];
      reason = `Reference ${reference} belongs to a payment to another supplier`;
    } else if (flag?.kind === "dup") {
      category = "duplicate";
      rules = ["no_duplicate"];
      reason = `Reference ${reference} was already paid`;
    }
    const verdict = category === "clean" ? "pay" : category === "needs_a_look" ? "hold" : "block";
    out.push({ slot, offset, date, payee: base.payee, amountMinor, reference, category, verdict, reason, rules, overpaidMinor, mark });
  }
  return out.sort((a, b) => a.offset - b.offset || ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
}

function numbered(weeks: number[], currentMonday: number): SeedRow[] {
  const rows: SeedRow[] = [];
  for (const w of weeks) {
    const monday = currentMonday - w * 7 * DAY;
    const firstRow = rows.length;
    const week = weekRows(w, monday);
    for (const r of week) {
      const row = rows.length + 2;
      const original = r.slot === "dup" ? rows.slice(firstRow).find((x) => x.payee === r.payee && x.reference === r.reference && x.category === "clean") : undefined;
      rows.push({ row, date: r.date, payee: r.payee, amountMinor: r.amountMinor, reference: r.reference, category: r.category, verdict: r.verdict, reason: original ? `${r.reason} in row ${original.row}` : r.reason, rules: r.rules, overpaidMinor: r.overpaidMinor, duplicateOfRow: original?.row ?? null, mark: r.mark });
    }
  }
  return rows;
}

export function seedOnboarding(db: Db, businessId: string, opts: { now?: Date } = {}): { importIds: string[] } {
  const now = (opts.now ?? new Date()).getTime();
  const currentMonday = Date.parse(`${weekStart(ymd(now))}T00:00:00Z`);
  const imports: Array<{ weeks: number[]; createdAt: number; file: string; markAt: number }> = [
    // The first upload: eight weeks of history, brought in on the Tuesday of week 4. Weeks 6 and 5 were marked then.
    { weeks: [12, 11, 10, 9, 8, 7, 6, 5], createdAt: currentMonday - 4 * 7 * DAY + DAY + 9 * 3600_000, file: "sao-ke-thang-8-9.csv", markAt: currentMonday - 4 * 7 * DAY + 2 * DAY + 10 * 3600_000 },
    // Then each week's payments, re-checked on the Sunday evening that ends it and marked an hour later.
    ...[4, 3, 2, 1].map((w) => ({ weeks: [w], createdAt: currentMonday - (w - 1) * 7 * DAY - 4 * 3600_000, file: `sao-ke-tuan-${ymd(currentMonday - w * 7 * DAY)}.csv`, markAt: currentMonday - (w - 1) * 7 * DAY - 3 * 3600_000 })),
  ];
  const importIds: string[] = [];
  for (const imp of imports) {
    const rows = numbered(imp.weeks, currentMonday);
    const id = storeImport(db, { businessId, fileName: imp.file, currency: "VND", header: DEMO_BANK_HEADER, spec: DEMO_BANK_SPEC, rowsRead: rows.length, outside: 0, skipped: [], results: rows, createdBy: "user:lan", createdAt: iso(imp.createdAt) });
    importIds.push(id);
    db.update(auditEntries).set({ createdAt: iso(imp.createdAt) }).where(and(eq(auditEntries.action, "onboarding.import_checked"), like(auditEntries.detailJson, `%${id}%`))).run();
    const calls = loadCalls(db, businessId, { importId: id });
    rows.forEach((r, i) => {
      if (!r.mark) return;
      const call = calls.find((c) => c.row === r.row)!;
      db.insert(onboardingMarks).values({ id: newId("obk"), businessId, resultId: call.id, mark: r.mark, note: null, markedBy: "user:daniel", markedAt: iso(imp.markAt + i * 60_000) }).run();
    });
  }
  // The same bank's next export maps itself.
  const first = iso(imports[0].createdAt);
  db.insert(onboardingMappings).values({ id: newId("obm"), businessId, signature: headerSignature(DEMO_BANK_HEADER), headerJson: JSON.stringify(DEMO_BANK_HEADER), specJson: JSON.stringify(DEMO_BANK_SPEC), usedCount: imports.length, createdBy: "user:lan", createdAt: first, updatedAt: iso(imports[imports.length - 1].createdAt) }).run();

  // What the marks point to, then the owner applying one of them the day after the first marks.
  generateSuggestions(db, businessId);
  const proposedAt = iso(imports[0].markAt + 3600_000);
  db.update(onboardingSuggestions).set({ createdAt: proposedAt }).where(eq(onboardingSuggestions.businessId, businessId)).run();
  const feed = db.select().from(onboardingSuggestions).where(and(eq(onboardingSuggestions.businessId, businessId), eq(onboardingSuggestions.kind, "booking_feed"))).get();
  if (feed) {
    const owner = resolveActor(db, businessId, "daniel", "admin");
    applySuggestion(db, businessId, owner, feed.id, { note: "Booking system export set up with the ops team" });
    const appliedAt = iso(imports[0].markAt + DAY);
    db.update(onboardingSuggestions).set({ decidedAt: appliedAt }).where(eq(onboardingSuggestions.id, feed.id)).run();
    db.update(auditEntries).set({ createdAt: appliedAt }).where(and(eq(auditEntries.action, "onboarding.suggestion_applied"), like(auditEntries.detailJson, `%${feed.id}%`))).run();
  }
  return { importIds };
}
