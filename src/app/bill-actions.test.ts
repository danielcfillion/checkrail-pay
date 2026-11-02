import { beforeEach, describe, expect, it, vi } from "vitest";

// The actions read the login from the request headers the middleware sets, and the app database. Both are stood in for.
const state = vi.hoisted(() => ({ headers: new Headers(), db: null as unknown }));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, getDb: () => state.db };
});

import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "@/lib/db";
import { ACTOR_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { bills, obligations } from "@/lib/db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "@/lib/demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "@/lib/engine/orchestrator";
import { createBill, payBill } from "@/lib/engine/bills";
import { resolveActor } from "@/lib/engine/users";
import { settleAdvanceAction } from "./actions";

/** Review R9-S3: a bill recorded by settling an advance picks up the outside requests already naming it. */

let db: Db;
beforeEach(async () => {
  db = openTestDb();
  state.db = db;
  await seedDemo(db, { history: false });
  const h = new Headers();
  h.set(ACTOR_HEADER, "daniel");
  h.set(ROLE_HEADER, "admin");
  state.headers = h;
});

describe("settling an advance", () => {
  it("puts a waiting outside request that names the difference bill on it", async () => {
    const lan = resolveActor(db, DEMO_BUSINESS_ID, "lan", "clerk");
    const adv = createBill(db, DEMO_BUSINESS_ID, lan, "ven_rosa", { kind: "advance", reference: "ADV-ROSA-NOV", totalMinor: 10_000, currency: "USD" });
    // The advance is paid out first.
    const out = await payBill(db, DEMO_BUSINESS_ID, lan, adv, 10_000);
    approveObligation(db, out, "user:minh", "Advance for November");
    await executeObligation(db, out, { actor: "user:minh" });
    await confirmSettlement(db, out);
    expect(db.select().from(obligations).where(eq(obligations.id, out)).get()!.state).toBe("settled");
    // An integration already asked to be paid against the overspend bill the settlement will record ("<ref>-S").
    const waiting = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID, sourceType: "invoice", sourceRef: "ADV-ROSA-NOV-S", rawInput: "[Integration request apr_x] Pay USD 30.00 to Rosa Villanueva for ADV-ROSA-NOV-S.", actor: "api:erp",
      evidence: [{ kind: "receipt", label: "Receipts ADV-ROSA-NOV-S", amountMinor: 3_000, currency: "USD", reference: "ADV-ROSA-NOV-S", excerpt: "Rosa Villanueva, receipts over the advance, USD 30." }],
      stated: { vendorId: "ven_rosa", amountMinor: 3_000, currency: "USD", sourceRef: "ADV-ROSA-NOV-S", flags: [], trusted: true }, evidenceSource: "system",
    });
    expect(db.select().from(obligations).where(eq(obligations.id, waiting)).get()!.billId).toBeNull();
    const r = await settleAdvanceAction(adv, 13_000, "Receipts came to USD 130");
    expect(r).toMatchObject({ ok: true });
    const diff = db.select().from(bills).all().find((b) => b.reference.startsWith("ADV-ROSA-NOV") && b.id !== adv)!;
    expect(diff).toBeTruthy();
    const after = db.select().from(obligations).where(eq(obligations.id, waiting)).get()!;
    expect(after.billId).toBe(diff.id);
    expect(after.state).not.toBe("approved");
  });
});
