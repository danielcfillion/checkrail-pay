import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { isNull } from "drizzle-orm";

// Switches for the two failures these tests need: ingest itself failing, and reading the request back failing after
// ingest succeeded. Everything else is the real orchestrator.
const ctl = vi.hoisted(() => ({ failIngest: false, failPreview: 0 }));
vi.mock("../engine/orchestrator", async (orig) => {
  const real = await orig<typeof import("../engine/orchestrator")>();
  return {
    ...real,
    ingestObligation: async (...a: Parameters<typeof real.ingestObligation>) => {
      if (ctl.failIngest) throw new Error("ingest is down");
      return real.ingestObligation(...a);
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
});
