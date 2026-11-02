import { beforeEach, describe, expect, it, vi } from "vitest";

// Try it yourself runs the clerk's own server actions in the visitor's sandbox copy. The request headers the
// middleware sets, the copy this request has, and the app database are stood in for; nothing else is.
const state = vi.hoisted(() => ({ headers: new Headers(), db: null as unknown, sandbox: "sbx_judge" as string | null, copiedAt: 1 }));
vi.mock("next/headers", () => ({ headers: async () => state.headers, cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, getDb: () => state.db };
});
vi.mock("@/lib/sandbox/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sandbox/server")>();
  return { ...real, activeSandboxId: () => state.sandbox, activeCopiedAt: () => (state.sandbox ? state.copiedAt : null), sandboxActive: () => state.sandbox !== null };
});

import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "@/lib/db";
import { ACTOR_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { accountingSyncs, obligations } from "@/lib/db/schema";
import { seedDemo } from "@/lib/demo/seed";
import { config } from "@/lib/config";
import { tryAttachAction, trySubmitAction, tryCorrectAction, tryRejectAction, tryPayAction, tryApproveAction, tryStatusAction, type TryEvidence } from "./actions";
import { TRY_LIMIT_PER_COPY, TryBudget, tryBudgets, tryRefusal } from "./guard";
import { TRY_SAMPLES, editField, fieldsFor, sampleById, type SampleId } from "./samples";

let db: Db;

/** A fresh copy of the demo, as a new visitor or Start over gets, signed in as the AP clerk. */
async function freshCopy(): Promise<void> {
  db = openTestDb();
  state.db = db;
  await seedDemo(db, { history: true });
  state.sandbox = "sbx_judge";
  state.copiedAt += 1; // a new copy: its own budget
  const h = new Headers();
  h.set(ACTOR_HEADER, "lan");
  h.set(ROLE_HEADER, "clerk");
  state.headers = h;
}

async function attach(id: SampleId): Promise<TryEvidence> {
  const r = await tryAttachAction(id);
  if (!r.ok || !r.data) throw new Error(r.message);
  return r.data;
}

async function submit(id: SampleId, edit?: Partial<Record<"payee" | "amount" | "reference", string>>) {
  const sample = sampleById(id)!;
  let f = fieldsFor(sample);
  for (const [k, v] of Object.entries(edit ?? {})) f = editField(sample, f, k as "payee" | "amount" | "reference", v);
  const r = await trySubmitAction({ text: f.text, evidence: await attach(id) });
  if (!r.ok || !r.data) throw new Error(r.message);
  return r.data;
}

const row = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(freshCopy);

describe("the three samples in a fresh copy", () => {
  it("clean: passes, is approved by policy under the line, and is paid on the simulated rail into the books", async () => {
    const s = await submit("clean");
    expect(s.state).toBe("approved");
    expect(s.vendorName).toBe("Rosa Villanueva");
    expect(s.amountMinor).toBe(19_000);
    expect(s.rules.filter((r) => !r.passed)).toEqual([]);
    expect(s.action).toMatchObject({ kind: "pay" });
    const paid = await tryPayAction(s.id, (s.action as { rail: string }).rail);
    expect(paid.ok).toBe(true);
    expect(row(s.id).state).toBe("settled");
    if (!paid.ok) return;
    expect(paid.data?.settled).toMatchObject({ grossMinor: 19_000, grossCurrency: "USD" });
    expect(db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, s.id)).get()).toBeTruthy();
  });

  it("overcharge: USD 1,100 against an USD 800 trip sheet is blocked, with Correct to USD 800", async () => {
    const s = await submit("overcharge");
    expect(s.state).toBe("blocked");
    expect(s.amountMinor).toBe(110_000);
    expect(row(s.id).blockedReason).toMatch(/Requested USD 1,100.00 but .* says USD 800.00/);
    expect(s.action).toMatchObject({ kind: "amend_amount", amountMinor: 80_000, label: "Correct to USD 800.00" });
    const fixed = await tryCorrectAction(s.id, "800");
    expect(fixed.ok).toBe(true);
    // Above the USD 250 line it waits for a person, and not the clerk who prepared it.
    expect(row(s.id).state).toBe("awaiting_approval");
    expect(row(s.id).amountMinor).toBe(80_000);
    const self = await tryApproveAction(s.id, fixed.ok ? fixed.data!.shownWarnings : []);
    expect(self.ok).toBe(false);
    expect(row(s.id).state).toBe("awaiting_approval");
  });

  it("repeat: an invoice number already paid is blocked as a duplicate, and cancelling moves no money", async () => {
    const s = await submit("repeat");
    expect(s.state).toBe("blocked");
    expect(row(s.id).blockedReason).toMatch(/INV-2026-0138 was already used/);
    const pay = await tryPayAction(s.id, "paypal");
    expect(pay.ok).toBe(false);
    const r = await tryRejectAction(s.id);
    expect(r.ok).toBe(true);
    expect(row(s.id).state).toBe("cancelled");
  });

  it("each sample gives the same outcome again after Start over", async () => {
    for (let round = 0; round < 2; round++) {
      await freshCopy();
      const out = [];
      for (const s of TRY_SAMPLES) out.push((await submit(s.id)).state);
      expect(out).toEqual(["approved", "blocked", "blocked"]);
    }
  });
});

describe("the judge's own figures go through the real checks", () => {
  it("the overcharge typed down to USD 800 is no longer blocked", async () => {
    const s = await submit("overcharge", { amount: "800" });
    expect(s.state).not.toBe("blocked");
    expect(s.amountMinor).toBe(80_000);
  });

  it("the clean fee typed up to USD 300 is blocked against the rate card", async () => {
    const s = await submit("clean", { amount: "300" });
    expect(s.state).toBe("blocked");
    expect(s.amountMinor).toBe(30_000);
    expect(row(s.id).blockedReason).toMatch(/USD 190.00/);
  });

  it("a request the clerk's role may not make is refused by the same permission check", async () => {
    state.headers = new Headers({ [ACTOR_HEADER]: "thu", [ROLE_HEADER]: "accountant" });
    const r = await trySubmitAction({ text: fieldsFor(sampleById("clean")!).text, evidence: null });
    expect(r.ok).toBe(false);
  });
});

describe("refused where it must not run", () => {
  it("refuses on live rails, and creates nothing", async () => {
    const before = db.select().from(obligations).all().length;
    const rails = config.rails as { mode: string };
    rails.mode = "live";
    try {
      expect(tryRefusal()).toMatch(/simulated rails/);
      expect((await tryAttachAction("clean")).ok).toBe(false);
      expect((await trySubmitAction({ text: "Please pay Rosa Villanueva USD 190", evidence: null })).ok).toBe(false);
      expect((await tryStatusAction("anything")).ok).toBe(false);
    } finally {
      rails.mode = "mock";
    }
    expect(tryRefusal({ PAYPAL_ENV: "live" })).toMatch(/real money/);
    expect(db.select().from(obligations).all().length).toBe(before);
  });

  it("refuses outside a visitor's own sandbox copy", async () => {
    state.sandbox = null;
    expect((await trySubmitAction({ text: "Please pay Rosa Villanueva USD 190", evidence: null })).message).toMatch(/your own copy/);
  });
});

describe("rate limit per copy", () => {
  it(`allows ${TRY_LIMIT_PER_COPY} requests per copy, then refuses; a fresh copy starts again`, async () => {
    const text = "Please pay Rosa Villanueva, USD 95. Note for the files.";
    for (let i = 0; i < TRY_LIMIT_PER_COPY; i++) expect((await trySubmitAction({ text: `${text} ${i}`, evidence: null })).ok).toBe(true);
    const over = await trySubmitAction({ text, evidence: null });
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/Start over/);
    await freshCopy();
    expect((await trySubmitAction({ text, evidence: null })).ok).toBe(true);
  }, 60_000);

  it("counts documents and requests separately, per copy", () => {
    const b = new TryBudget(2);
    expect([b.take("a"), b.take("a"), b.take("a"), b.take("b")]).toEqual([true, true, false, true]);
    expect(b.left("a")).toBe(0);
    expect(tryBudgets().requests).not.toBe(tryBudgets().documents);
  });

  it("a refused request does not use up the budget", async () => {
    state.headers = new Headers({ [ACTOR_HEADER]: "thu", [ROLE_HEADER]: "accountant" });
    const key = `sbx_judge:${state.copiedAt}`;
    const before = tryBudgets().requests.left(key);
    expect((await trySubmitAction({ text: "Please pay Rosa Villanueva, USD 95.", evidence: null })).ok).toBe(false);
    expect(tryBudgets().requests.left(key)).toBe(before);
  });

  it("forgets the least recently used copy first, not all of them", () => {
    const b = new TryBudget(2, 2);
    b.take("a");
    b.take("a");
    b.take("b");
    b.take("a"); // refused: a is spent, and stays remembered
    b.take("c"); // a third copy: the oldest (a, touched before b) goes
    expect(b.has("b")).toBe(true);
    expect(b.left("b")).toBe(1);
    expect(b.left("c")).toBe(1);
    expect(b.left("a")).toBe(2);
  });
});
