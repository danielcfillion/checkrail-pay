import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The actions read the login from the request headers the middleware sets, and the app database. Both are stood in for.
const state = vi.hoisted(() => ({ headers: new Headers(), db: null as unknown }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, getDb: () => state.db };
});

import { openTestDb, type Db } from "@/lib/db";
import { ACTOR_HEADER, PERSONA_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { auditEntries, onboardingMarks, onboardingSuggestions, rateCards } from "@/lib/db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "@/lib/demo/seed";
import { loadCalls } from "@/lib/onboarding/calls";
import { applySuggestionAction, createImportAction, dashboardDataAction, detectColumnsAction, dismissSuggestionAction, getImportAction, importCallsAction, markCallAction } from "./actions";
import { GET } from "../api/onboarding/dashboard/route";

const VN = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "onboarding", "__fixtures__", "vn-bank-export.csv"), "utf8");

function as(username: string | null, role: string | null, extra: Record<string, string> = {}) {
  const h = new Headers(extra);
  if (username) h.set(ACTOR_HEADER, username);
  if (role) h.set(ROLE_HEADER, role);
  state.headers = h;
}

let db: Db;
beforeAll(async () => {
  db = openTestDb();
  state.db = db;
  await seedDemo(db);
});

/** A flagged call nobody has marked yet. */
const flaggedCall = () => loadCalls(db, DEMO_BUSINESS_ID).find((c) => c.category !== "clean" && !c.mark)!.id;

describe("who may call the onboarding actions", () => {
  it("nobody signed in, or a vendor-facing page, gets nothing", async () => {
    as(null, null);
    for (const r of [await detectColumnsAction(VN), await dashboardDataAction(), await markCallAction("x", "was_fine"), await applySuggestionAction("x"), await dismissSuggestionAction("x"), await importCallsAction("x"), await getImportAction("x")]) expect(r).toEqual({ ok: false, message: "Not signed in" });
    as("daniel", "admin", { "x-checkrail-public": "1" });
    expect(await dashboardDataAction()).toEqual({ ok: false, message: "Not signed in" });
    as("daniel", "superuser");
    expect((await dashboardDataAction()).ok).toBe(false);
  });

  it("an accountant reads the dashboard but cannot bring in data, mark calls or apply suggestions", async () => {
    as("thu", "accountant");
    expect((await dashboardDataAction()).ok).toBe(true);
    expect(await detectColumnsAction(VN)).toMatchObject({ ok: false, message: expect.stringMatching(/cannot bring in past payments/) });
    expect(await createImportAction({ csv: VN, fileName: "x.csv", currency: "VND", spec: {} })).toMatchObject({ ok: false, message: expect.stringMatching(/cannot bring in past payments/) });
    expect(await markCallAction(flaggedCall(), "was_fine")).toMatchObject({ ok: false, message: expect.stringMatching(/cannot mark/) });
    const s = db.select().from(onboardingSuggestions).all().find((x) => x.status === "proposed")!;
    expect(await applySuggestionAction(s.id)).toMatchObject({ ok: false, message: expect.stringMatching(/cannot apply/) });
    expect(await dismissSuggestionAction(s.id)).toMatchObject({ ok: false, message: expect.stringMatching(/cannot dismiss/) });
  });

  it("the AP clerk brings in data and re-checks it, but cannot mark calls", async () => {
    as("lan", "clerk");
    const d = await detectColumnsAction(VN);
    expect(d.ok && d.data.fromSaved).toBe(true);
    if (!d.ok) throw new Error(d.message);
    const created = await createImportAction({ csv: VN, fileName: "sao-ke.csv", currency: "VND", spec: d.data.spec });
    expect(created).toMatchObject({ ok: true, message: "Re-checked 6 payments from 2026-08-03 to 2026-08-14.", data: { payments: 6, duplicates: { count: 1 } } });
    if (!created.ok) throw new Error(created.message);
    const calls = await importCallsAction(created.data.id);
    expect(calls.ok && calls.data.length).toBeGreaterThan(0);
    expect((await getImportAction(created.data.id)).ok).toBe(true);
    expect(await markCallAction(flaggedCall(), "was_fine")).toMatchObject({ ok: false, message: expect.stringMatching(/cannot mark/) });
  });

  it("an approver marks calls and applies a rate card suggestion; a booking feed stays the owner's", async () => {
    as("minh", "approver");
    const id = flaggedCall();
    const marked = await markCallAction(id, "was_fine", "Normal invoice");
    expect(marked).toMatchObject({ ok: true, message: "Marked as fine." });
    expect(db.select().from(onboardingMarks).all().find((m) => m.resultId === id)).toMatchObject({ markedBy: "user:minh", note: "Normal invoice" });
    const rate = db.select().from(onboardingSuggestions).all().find((x) => x.status === "proposed" && x.kind === "rate_card")!;
    const applied = await applySuggestionAction(rate.id);
    expect(applied).toMatchObject({ ok: true, data: { changed: true, suggestion: { status: "applied", decidedBy: "user:minh" } } });
    expect(db.select().from(rateCards).all().some((r) => r.note === "Added from an onboarding suggestion")).toBe(true);
    expect(db.select().from(auditEntries).all().filter((a) => a.action === "onboarding.suggestion_applied").map((a) => a.actor)).toContain("user:minh");
  });

  it("a demo persona acting for the owner is recorded with the real login behind it", async () => {
    as("daniel", "admin", { [PERSONA_HEADER]: "owner-login" });
    const s = db.select().from(onboardingSuggestions).all().find((x) => x.status === "proposed")!;
    const r = await dismissSuggestionAction(s.id, "Not now");
    expect(r.ok).toBe(true);
    const row = db.select().from(auditEntries).all().filter((a) => a.action === "onboarding.suggestion_dismissed").pop()!;
    expect(row.actor).toBe("user:daniel");
    expect(JSON.parse(row.detailJson!).login).toBe("owner-login");
  });

  it("refuses an upload over 5 MB without reading it", async () => {
    as("daniel", "admin");
    const big = "a".repeat(5 * 1024 * 1024 + 1);
    expect(await detectColumnsAction(big)).toMatchObject({ ok: false, message: expect.stringMatching(/larger than 5 MB/) });
    expect(await createImportAction({ csv: big, fileName: "x.csv", currency: "VND", spec: { skipRows: 0 } })).toMatchObject({ ok: false, message: expect.stringMatching(/larger than 5 MB/) });
    expect(await createImportAction(null as never)).toMatchObject({ ok: false });
  });

  it("the dashboard action returns the seeded data", async () => {
    as("daniel", "admin");
    const r = await dashboardDataAction();
    expect(r.ok && r.data.readiness_summary[0].total).toBe(4);
    expect(r.ok && r.data.readiness_summary[0].level).toBe("assist");
    expect(r.ok && r.data.calls.length).toBeGreaterThan(0);
  });
});

describe("GET /api/onboarding/dashboard", () => {
  const get = (headers: Record<string, string>, query = "") => GET(new Request(`http://checkrail.test/api/onboarding/dashboard${query}`, { headers }));

  it("needs a login", async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ [ACTOR_HEADER]: "daniel", [ROLE_HEADER]: "admin", "x-checkrail-public": "1" })).status).toBe(401);
    expect((await get({ [ACTOR_HEADER]: "daniel", [ROLE_HEADER]: "root" })).status).toBe(401);
  });

  it("returns every data source, or one as a bare array, to any signed-in role, never cached", async () => {
    const all = await get({ [ACTOR_HEADER]: "thu", [ROLE_HEADER]: "accountant" });
    expect(all.status).toBe(200);
    expect(all.headers.get("cache-control")).toBe("no-store");
    const body = await all.json();
    expect(Object.keys(body)).toContain("weekly_false_holds");
    const one = await get({ [ACTOR_HEADER]: "thu", [ROLE_HEADER]: "accountant" }, "?source=rule_hits");
    expect(Array.isArray(await one.json())).toBe(true);
    expect((await get({ [ACTOR_HEADER]: "thu", [ROLE_HEADER]: "accountant" }, "?source=__proto__")).status).toBe(400);
  });
});
