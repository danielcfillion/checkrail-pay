import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// An in-memory database for the route's getDb() singleton. Must be set before config loads.
const h = vi.hoisted(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.CHECKRAIL_ALLOW_MOCK_WEBHOOK = "1";
  return { failNext: false };
});
vi.mock("@/lib/engine/orchestrator", async (orig) => {
  const actual = await orig<typeof import("@/lib/engine/orchestrator")>();
  return {
    ...actual,
    confirmSettlement: vi.fn(async (...args: Parameters<typeof actual.confirmSettlement>) => {
      if (h.failNext) {
        h.failNext = false;
        throw new Error("simulated processing failure");
      }
      return actual.confirmSettlement(...args);
    }),
  };
});

import { eq } from "drizzle-orm";
import { POST } from "./route";
import { getDb } from "@/lib/db";
import { events, obligations, paymentAttempts } from "@/lib/db/schema";
import { seedDemo } from "@/lib/demo/seed";
import { executeObligation } from "@/lib/engine/orchestrator";
import { config } from "@/lib/config";
import { resetRails } from "@/lib/rails";

let story: Awaited<ReturnType<typeof seedDemo>>["story"];
let batchId: string;
const db = () => getDb();
const state = () => db().select().from(obligations).where(eq(obligations.id, story.paypal)).get()!.state;

const post = (body: unknown, raw?: string) => POST(new Request("http://localhost/api/webhooks/paypal", { method: "POST", body: raw ?? JSON.stringify(body) }));
const event = (id: string | undefined, batch = batchId) => ({ ...(id ? { id } : {}), event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS", resource: { batch_header: { payout_batch_id: batch } } });

beforeEach(async () => {
  resetRails();
  ({ story } = await seedDemo(db(), { history: false }));
  await executeObligation(db(), story.paypal, { actor: "user:daniel" });
  batchId = db().select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, story.paypal)).get()!.externalId!;
  h.failNext = false;
});
afterEach(() => resetRails());

describe("PayPal webhook (H9)", () => {
  it("stores the event once, triggers a status check, and never sets state itself", async () => {
    expect(state()).toBe("sent");
    const res = await post(event("WH-1"));
    expect(res.status).toBe(200);
    expect(state()).toBe("settled"); // because the rail confirmed it, not because the event said so
    const rows = db().select().from(events).where(eq(events.externalEventId, "WH-1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].processedAt).not.toBeNull();
  });

  it("skips a replay of a fully processed event", async () => {
    await post(event("WH-2"));
    const again = await (await post(event("WH-2"))).json();
    expect(again.duplicate).toBe(true);
    expect(db().select().from(events).where(eq(events.externalEventId, "WH-2")).all()).toHaveLength(1);
  });

  it("returns 500 on a processing error, and the retry is processed rather than swallowed as a duplicate", async () => {
    h.failNext = true;
    const first = await post(event("WH-3"));
    expect(first.status).toBe(500);
    expect(state()).toBe("sent");
    expect(db().select().from(events).where(eq(events.externalEventId, "WH-3")).get()!.processedAt).toBeNull();
    const retry = await post(event("WH-3"));
    expect(retry.status).toBe(200);
    expect((await retry.json()).duplicate).toBeUndefined();
    expect(state()).toBe("settled");
    expect(db().select().from(events).where(eq(events.externalEventId, "WH-3")).all()).toHaveLength(1);
  });

  it("dedupes events that carry no id by a hash of the body", async () => {
    const body = event(undefined);
    await post(body);
    const again = await (await post(body)).json();
    expect(again.duplicate).toBe(true);
    expect(db().select().from(events).all()).toHaveLength(1);
  });

  it("the database refuses a second row for the same event id", () => {
    db().insert(events).values({ id: "e1", source: "paypal_webhook", externalEventId: "DUP", type: "t", payloadJson: "{}", createdAt: "x" }).run();
    expect(() => db().insert(events).values({ id: "e2", source: "paypal_webhook", externalEventId: "DUP", type: "t", payloadJson: "{}", createdAt: "x" }).run()).toThrow();
  });

  it("a forged event for an unknown batch changes nothing", async () => {
    const res = await post(event("WH-F", "NOT-A-BATCH"));
    expect(res.status).toBe(200);
    expect(state()).toBe("sent");
  });

  it("does not exist in mock mode unless a test asks for it", async () => {
    delete process.env.CHECKRAIL_ALLOW_MOCK_WEBHOOK;
    try {
      expect((await post(event("WH-M"))).status).toBe(404);
      expect(db().select().from(events).all().some((e) => e.externalEventId === "WH-M")).toBe(false);
    } finally {
      process.env.CHECKRAIL_ALLOW_MOCK_WEBHOOK = "1";
    }
  });

  it("rejects invalid JSON", async () => {
    expect((await post(null, "{not json")).status).toBe(400);
  });

  it("in live mode fails closed when the signature cannot be verified", async () => {
    const rails = config.rails as { mode: string };
    rails.mode = "live";
    try {
      const res = await post(event("WH-L"));
      expect(res.status).toBe(400);
      expect(state()).toBe("sent");
      expect(db().select().from(events).where(eq(events.externalEventId, "WH-L")).all()).toHaveLength(0);
    } finally {
      rails.mode = "mock";
    }
  });
});
