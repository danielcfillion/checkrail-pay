import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq, isNull } from "drizzle-orm";

// Switches for the two failures these tests need: ingest itself failing, and reading the request back failing after
// ingest succeeded. Everything else is the real orchestrator.
const ctl = vi.hoisted(() => ({ failIngest: false, failPreview: 0, onIngest: null as null | (() => void) }));
vi.mock("../engine/orchestrator", async (orig) => {
  const real = await orig<typeof import("../engine/orchestrator")>();
  return {
    ...real,
    ingestObligation: async (...a: Parameters<typeof real.ingestObligation>) => {
      if (ctl.failIngest) throw new Error("ingest is down");
      const id = await real.ingestObligation(...a);
      ctl.onIngest?.();
      return id;
    },
    previewPolicy: (...a: Parameters<typeof real.previewPolicy>) => {
      if (ctl.failPreview > 0) {
        ctl.failPreview--;
        throw new Error("reading the request back failed");
      }
      return real.previewPolicy(...a);
    },
  };
});

import { openTestDb, type Db } from "../db";
import { apiRequests, attachments, obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { createRequest } from "./requests";
import type { ApiKey } from "./keys";

const erp: ApiKey = { name: "erp", scopes: ["requests:write", "requests:read"], digest: Buffer.alloc(32) };
let db: Db;

beforeEach(async () => {
  ctl.failIngest = false;
  ctl.failPreview = 0;
  ctl.onIngest = null;
  db = openTestDb();
  await seedDemo(db, { history: false });
});
afterEach(() => (db as unknown as { $client: { close(): void } }).$client.close());

const orphans = () => db.select().from(attachments).where(isNull(attachments.obligationId)).all().length;
const doc = (text: string) => ({ name: "invoice.txt", content_type: "text/plain", data: Buffer.from(text).toString("base64") });

describe("payment requests when something fails", () => {
  it("R1-7: a refused request leaves no stored document behind", async () => {
    const before = orphans();
    ctl.failIngest = true;
    await expect(createRequest(db, DEMO_BUSINESS_ID, erp, "r1-7-orphan-01", { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7401", documents: [doc("Invoice INV-MS-7401, Maria Santos, USD 45.00"), doc("Second page")] })).rejects.toThrow(/could not create the request/);
    expect(orphans()).toBe(before);
  });

  it("R1-6b: an error after the request was created keeps the key bound to it, so a retry does not make a second", async () => {
    const body = { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7402" };
    const count = db.select().from(obligations).all().length;
    ctl.failPreview = 1;
    await expect(createRequest(db, DEMO_BUSINESS_ID, erp, "r1-6-post-0001", body)).rejects.toThrow(/reading the request back failed/);
    expect(db.select().from(obligations).all().length).toBe(count + 1);
    expect(db.select().from(apiRequests).all()).toHaveLength(1);
    const retry = await createRequest(db, DEMO_BUSINESS_ID, erp, "r1-6-post-0001", body);
    expect(retry.id).toBe(db.select().from(apiRequests).get()!.obligationId);
    expect(db.select().from(obligations).all().length).toBe(count + 1);
  });

  it("R3 nit: a pending binding finds its request by the exact header, not a pattern (the id holds an underscore)", async () => {
    const { ingestObligation } = await import("../engine/orchestrator");
    // A request whose header differs from the binding's only where "_" would match any character in a LIKE pattern.
    const lookalike = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "[Integration request aprZbound01] Pay USD 45.00 to Maria Santos for INV-MS-7405.", actor: "user:lan" });
    db.insert(apiRequests).values({ id: "apr_bound01", businessId: DEMO_BUSINESS_ID, keyName: "erp", obligationId: "pending:apr_bound01", reference: "INV-MS-7405", idemKey: "r3-like-00001", bodySha256: null, createdAt: new Date().toISOString() }).run();
    const r = await createRequest(db, DEMO_BUSINESS_ID, erp, "r3-like-00001", { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7405" });
    expect(r.id).not.toBe(lookalike);
  });

  it("S2: the key is bound before the request is committed, so a crash in between cannot free it", async () => {
    const body = { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7403" };
    let boundAtCommit = 0;
    ctl.onIngest = () => (boundAtCommit = db.select().from(apiRequests).all().length);
    await createRequest(db, DEMO_BUSINESS_ID, erp, "s2-bound-00001", body);
    expect(boundAtCommit).toBe(1);
  });

  it("S2: a retry after a crash right after ingest finds the request, and makes no second one", async () => {
    const body = { payee: "Maria Santos", amount: "45", currency: "USD", reference: "INV-MS-7404" };
    // The process dies the moment ingest returns. Record the database as it is then; after the call unwinds, put it
    // back, since in a real crash none of the cleanup would have run.
    type Snapshot = { request: typeof obligations.$inferSelect; bound: Array<typeof apiRequests.$inferSelect> };
    let atCrash: Snapshot | null = null;
    ctl.onIngest = () => {
      const request = db.select().from(obligations).all().at(-1)!;
      atCrash = { request, bound: db.select().from(apiRequests).all() };
      throw new Error("process died");
    };
    await createRequest(db, DEMO_BUSINESS_ID, erp, "s2-crash-00001", body).catch(() => undefined);
    ctl.onIngest = null;
    const crash = atCrash as unknown as Snapshot;
    db.update(obligations).set(crash.request).where(eq(obligations.id, crash.request.id)).run();
    db.delete(apiRequests).run();
    for (const b of crash.bound) db.insert(apiRequests).values(b).run();

    const count = db.select().from(obligations).all().length;
    const retry = await createRequest(db, DEMO_BUSINESS_ID, erp, "s2-crash-00001", body);
    expect(retry.id).toBe(crash.request.id);
    expect(db.select().from(obligations).all().length).toBe(count);
  });
});
