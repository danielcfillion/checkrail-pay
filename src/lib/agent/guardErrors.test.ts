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
import { seedDemo } from "../demo/seed";
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

describe("an internal error while creating a request (API review R6-2, MCP side)", () => {
  it("reaches the agent as one fixed sentence, and the detail goes to the server log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ctl.fail = true;
    await expect(requestPayment(db, agent, { payee: "Rosa Villanueva", amount: "190", currency: "USD", reference: "INV-ROSA-7777", idempotency_key: "guard-err-0001" })).rejects.toThrow(/^Checkrail could not process this request\. Nothing was paid\.$/);
    expect(log.mock.calls.flat().map(String).join(" ")).toMatch(/internal detail/);
    log.mockRestore();
  });
});
