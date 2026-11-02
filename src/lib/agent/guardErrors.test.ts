import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Ingest fails, once switched on, with an internal message that must never reach an agent.
const ctl = vi.hoisted(() => ({ fail: false }));
vi.mock("../engine/orchestrator", async (orig) => {
  const real = await orig<typeof import("../engine/orchestrator")>();
  return {
    ...real,
    ingestObligation: async (...a: Parameters<typeof real.ingestObligation>) => {
      if (ctl.fail) throw new Error("This vendor already has a invoice INV-ROSA-7777 (internal detail, obl_abc123)");
      return real.ingestObligation(...a);
    },
  };
});

import { openTestDb, type Db } from "../db";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { requestPayment } from "./guard";
import type { AgentKey } from "./keys";

const agent: AgentKey = { name: "assistant", scopes: ["check", "request"], digest: Buffer.alloc(32) };
let db: Db;
beforeEach(async () => {
  ctl.fail = false;
  db = openTestDb();
  await seedDemo(db, { history: false });
});
afterEach(() => (db as unknown as { $client: { close(): void } }).$client.close());

describe("bill rules for agents (API review R7-S3)", () => {
  it("answer with a fixed sentence and no amounts", async () => {
    const { createBill } = await import("../engine/bills");
    const { resolveActor } = await import("../engine/users");
    const { checkPayment } = await import("./guard");
    createBill(db, DEMO_BUSINESS_ID, resolveActor(db, DEMO_BUSINESS_ID, "lan", "clerk"), "ven_rosa", { kind: "invoice", reference: "INV-ROSA-6001", totalMinor: 10_000, currency: "USD" });
    const bookings: AgentKey = { name: "bookings", scopes: ["check", "request", "attest"], digest: Buffer.alloc(32) };
    const r = await checkPayment(db, bookings, { payee: "Rosa Villanueva", amount: "150", currency: "USD", reference: "INV-ROSA-6001", evidence: [{ kind: "job_sheet", label: "Trip sheet INV-ROSA-6001", amount: "150", reference: "INV-ROSA-6001", excerpt: "Guide: Rosa Villanueva. Total USD 150." }] });
    const misfit = r.blocks.find((b) => b.rule === "bill_misfit");
    expect(misfit?.message).toBe("The amount or currency does not fit what is still open on the bill; a person records it by hand if it is right.");
    const leak = JSON.stringify(r).match(/.{0,80}(?:USD 100|100\.00).{0,40}/);
    expect(leak?.[0]).toBeUndefined();
  });
});

describe("an internal error while creating a request (API review R6-2, MCP side)", () => {
  it("reaches the agent as one fixed sentence, and the detail goes to the server log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ctl.fail = true;
    await expect(requestPayment(db, agent, { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-7777", idempotency_key: "guard-err-0001" })).rejects.toThrow(/^Checkrail could not process this request\. Nothing was paid\.$/);
    expect(log.mock.calls.flat().map(String).join(" ")).toMatch(/internal detail/);
    log.mockRestore();
  });
});
