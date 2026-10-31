import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Next keeps the request (headers, cookies) in an AsyncLocalStorage that it creates from globalThis.AsyncLocalStorage,
// which the Next server sets up and a plain test process does not. Set it before anything loads Next, so these tests
// can run code inside a request store exactly as a page, server action or route handler runs in the server.
const state = vi.hoisted(() => {
  const hooks = process.getBuiltinModule("node:async_hooks") as typeof import("node:async_hooks");
  (globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = hooks.AsyncLocalStorage;
  process.env.DATABASE_PATH = ":memory:";
  return { headers: new Headers() };
});
vi.mock("next/headers", () => ({ headers: async () => state.headers, cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { getDb, type Db } from "@/lib/db";
import { agentChecks, auditEntries, obligations } from "@/lib/db/schema";
import { seedDemo } from "@/lib/demo/seed";
import { ACTOR_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { amendAction, resetDemoAction } from "@/app/actions";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { middleware } from "@/middleware";
import { SandboxPool } from "./pool";
import { activeSandboxId, installSandboxPool, startSandboxes, uninstallSandboxPool } from "./server";
import { hmacSha256, sha256 } from "./hmac";
import { SANDBOX_COOKIE, SANDBOX_HEADER, newSandboxId, sandboxForRequest, sandboxKeyMaterial, sandboxSetting, signSandboxId, verifySandboxToken } from "./settings";

const MATERIAL = "sandbox-test-secret";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "checkrail-sandbox-"));
const seed = async (db: Db) => void (await seedDemo(db, { history: true }));
const phuongOf = (db: Db) => db.select().from(obligations).where(eq(obligations.sourceRef, "INV-2026-0152")).get()!;

/** Run `fn` inside a Next request store, as the server does for every page, action and route handler. */
function inRequest<T>(token: string | null, fn: () => T, via: "header" | "cookie" = "header"): T {
  const h = new Headers({ [ACTOR_HEADER]: "daniel", [ROLE_HEADER]: "admin", "content-type": "application/json" });
  if (token && via === "header") h.set(SANDBOX_HEADER, token);
  state.headers = h;
  const cookies = { get: (n: string) => (token && via === "cookie" && n === SANDBOX_COOKIE ? { name: n, value: token } : undefined) };
  return workUnitAsyncStorage.run({ type: "request", headers: h, cookies } as never, fn);
}

describe("sandbox setting", () => {
  it("is off unless asked for", () => {
    expect(sandboxSetting({}).on).toBe(false);
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1" })).toMatchObject({ on: true, refused: null, max: 50, ttlMinutes: 120 });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", RAIL_MODE: "mock", CHECKRAIL_SANDBOX_MAX: "3", CHECKRAIL_SANDBOX_TTL_MINUTES: "5" })).toMatchObject({ on: true, max: 3, ttlMinutes: 5 });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", CHECKRAIL_SANDBOX_MAX: "zero" }).max).toBe(50);
  });

  it("is refused with a live rail, live AI or anything pointing at real money", () => {
    for (const env of [{ RAIL_MODE: "live" }, { AI_MODE: "live" }, { PAYPAL_ENV: "live" }, { STELLAR_NETWORK: "public" }, { WISE_ENV: "live" }]) {
      const s = sandboxSetting({ CHECKRAIL_SANDBOX: "1", ...env });
      expect(s.requested).toBe(true);
      expect(s.on).toBe(false);
      expect(s.refused).toBeTruthy();
    }
  });

  it("refuses to start with live rails: no pool, no resolver, the shared database as before", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = tmp();
    expect(await startSandboxes({ CHECKRAIL_SANDBOX: "1", RAIL_MODE: "live" }, dir)).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/refused: RAIL_MODE is not mock/));
    expect(fs.readdirSync(dir)).toEqual([]);
    const token = signSandboxId(newSandboxId(), MATERIAL);
    expect(inRequest(token, () => getDb())).toBe(getDb());
    err.mockRestore();
  });
});

describe("the signed cookie", () => {
  it("signs with HMAC-SHA256, the same as node:crypto", () => {
    const enc = new TextEncoder();
    for (const [k, m] of [["key", "message"], ["", ""], ["x".repeat(100), "y".repeat(300)]]) {
      expect(Buffer.from(hmacSha256(enc.encode(k), enc.encode(m))).toString("hex")).toBe(createHmac("sha256", k).update(m).digest("hex"));
    }
    expect(Buffer.from(sha256(enc.encode("abc"))).toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("accepts its own token and nothing else", () => {
    const id = newSandboxId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    const token = signSandboxId(id, MATERIAL);
    expect(verifySandboxToken(token, MATERIAL)).toBe(id);
    expect(verifySandboxToken(token, "another key")).toBeNull();
    expect(verifySandboxToken(`${newSandboxId()}.${token.split(".")[1]}`, MATERIAL)).toBeNull();
    expect(verifySandboxToken(`../../etc.${token.split(".")[1]}`, MATERIAL)).toBeNull();
    expect(verifySandboxToken(id, MATERIAL)).toBeNull();
    expect(verifySandboxToken(null, MATERIAL)).toBeNull();
  });

  it("keeps a valid cookie and replaces a forged one", () => {
    const env = { CHECKRAIL_SANDBOX_SECRET: MATERIAL };
    const mine = signSandboxId(newSandboxId(), MATERIAL);
    expect(sandboxForRequest(mine, env)).toEqual({ token: mine, fresh: false });
    const forged = sandboxForRequest(`${newSandboxId()}.forged`, env);
    expect(forged.fresh).toBe(true);
    expect(verifySandboxToken(forged.token, MATERIAL)).toBeTruthy();
    expect(sandboxKeyMaterial({})).not.toBe(sandboxKeyMaterial({ CHECKRAIL_USERS: "judge:pw:admin" }));
  });

  it("the middleware sets an httpOnly, SameSite=Lax cookie once and forwards the token, replacing any sent by the client", () => {
    vi.stubEnv("CHECKRAIL_SANDBOX", "1");
    vi.stubEnv("CHECKRAIL_SANDBOX_SECRET", MATERIAL);
    vi.stubEnv("CHECKRAIL_USERS", "");
    vi.stubEnv("CHECKRAIL_BASIC_AUTH", "");
    try {
      const first = middleware(new NextRequest("http://checkrail.test/", { headers: { [SANDBOX_HEADER]: "someone-elses-token" } }));
      const forwarded = first.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)!;
      expect(verifySandboxToken(forwarded, MATERIAL)).toBeTruthy();
      const cookie = first.headers.get("set-cookie")!;
      expect(cookie).toContain(`${SANDBOX_COOKIE}=${forwarded}`);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=lax/i);
      const again = middleware(new NextRequest("http://checkrail.test/obligations", { headers: { cookie: `${SANDBOX_COOKIE}=${forwarded}` } }));
      expect(again.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBe(forwarded);
      expect(again.headers.get("set-cookie")).toBeNull();
      // PayPal's webhook is no visitor: no copy is made for it.
      const hook = middleware(new NextRequest("http://checkrail.test/api/webhooks/paypal", { method: "POST" }));
      expect(hook.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBeNull();
      expect(hook.headers.get("set-cookie")).toBeNull();
      vi.stubEnv("CHECKRAIL_SANDBOX", "");
      const off = middleware(new NextRequest("http://checkrail.test/", { headers: { [SANDBOX_HEADER]: forwarded } }));
      expect(off.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBeNull();
      expect(off.headers.get("set-cookie")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the pool", () => {
  let dir: string;
  let clock = 1_000_000;
  let pool: SandboxPool;
  beforeAll(async () => {
    dir = tmp();
    pool = new SandboxPool({ dir, max: 3, ttlMs: 60_000, seed, now: () => clock, retireDelayMs: 0 });
    await pool.init();
  }, 30_000);
  afterAll(() => pool.close());

  it("copies the seeded template for each visitor, and their changes never meet", () => {
    const a = newSandboxId();
    const b = newSandboxId();
    const dbA = pool.dbFor(a);
    const dbB = pool.dbFor(b);
    expect(dbA).not.toBe(dbB);
    expect(pool.dbFor(a)).toBe(dbA);
    expect(phuongOf(dbA).state).toBe("blocked");
    dbA.update(obligations).set({ state: "cancelled" }).where(eq(obligations.id, phuongOf(dbA).id)).run();
    expect(phuongOf(dbA).state).toBe("cancelled");
    expect(phuongOf(dbB).state).toBe("blocked");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite"))).toHaveLength(3); // template + two copies
  });

  it("refuses an id that is not a sandbox id", () => {
    expect(() => pool.dbFor("../template")).toThrow();
  });

  it("evicts the copy idle longest when full", () => {
    const ids = pool.ids();
    clock += 1000;
    pool.dbFor(ids[1]); // the second one is now the most recent
    const c = newSandboxId();
    clock += 1000;
    pool.dbFor(c);
    expect(pool.size).toBe(3);
    const d = newSandboxId();
    clock += 1000;
    pool.dbFor(d);
    expect(pool.size).toBe(3);
    expect(pool.has(ids[0])).toBe(false); // idle longest
    expect(pool.has(ids[1])).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(`sbx-${ids[0]}`))).toEqual([]);
  });

  it("deletes a copy idle past the TTL, and a returning visitor gets a fresh one", () => {
    const keep = pool.ids()[pool.size - 1];
    clock += 50_000;
    pool.dbFor(keep);
    clock += 30_000; // the others are now 80 s idle, past the 60 s TTL
    const gone = pool.sweep(clock, true);
    expect(gone.length).toBe(2);
    expect(pool.ids()).toEqual([keep]);
    const back = gone[0];
    expect(phuongOf(pool.dbFor(back)).state).toBe("blocked");
  });

  it("Start over gives the visitor a fresh copy and leaves the others alone", () => {
    const [x, y] = [newSandboxId(), newSandboxId()];
    for (const id of [x, y]) pool.dbFor(id).update(obligations).set({ state: "cancelled" }).where(eq(obligations.sourceRef, "INV-2026-0152")).run();
    const fresh = pool.reset(x);
    expect(phuongOf(fresh).state).toBe("blocked");
    expect(phuongOf(pool.dbFor(y)).state).toBe("cancelled");
  });
});

describe("one request, one visitor's copy", () => {
  let pool: SandboxPool;
  const a = signSandboxId(newSandboxId(), MATERIAL);
  const b = signSandboxId(newSandboxId(), MATERIAL);
  let shared: Db;
  let sharedAudit = 0;
  beforeAll(async () => {
    shared = getDb();
    await seedDemo(shared, { history: true });
    sharedAudit = shared.select().from(auditEntries).all().length;
    pool = new SandboxPool({ dir: tmp(), max: 10, ttlMs: 3600_000, seed, retireDelayMs: 0 });
    await pool.init();
    installSandboxPool(pool, MATERIAL);
  }, 30_000);
  afterAll(() => uninstallSandboxPool());
  afterEach(() => vi.unstubAllEnvs());

  it("outside a request, and in a request without a valid token, getDb() is the shared database", () => {
    expect(getDb()).toBe(shared);
    expect(inRequest(null, () => getDb())).toBe(shared);
    expect(inRequest(signSandboxId(newSandboxId(), "wrong key"), () => getDb())).toBe(shared);
    const viaHeader = inRequest(a, () => getDb());
    expect(viaHeader).not.toBe(shared);
    expect(inRequest(a, () => getDb(), "cookie")).toBe(viaHeader);
    expect(inRequest(b, () => getDb())).not.toBe(viaHeader);
  });

  it("a server action changes only the visitor's copy", async () => {
    const id = inRequest(a, () => phuongOf(getDb()).id);
    expect(inRequest(b, () => phuongOf(getDb()).id)).toBe(id); // the same ids in every copy: they come from one template
    const r = await inRequest(a, () => amendAction(id, { amountMinor: 80_000 }, "Corrected to the trip sheet"));
    expect(r).toMatchObject({ ok: true });
    expect(inRequest(a, () => phuongOf(getDb()).state)).toBe("awaiting_approval");
    expect(inRequest(b, () => phuongOf(getDb()).state)).toBe("blocked");
    expect(phuongOf(shared).state).toBe("blocked");
  });

  it("a route handler (/api/mcp, which the middleware never sees) uses the visitor's copy from the cookie", async () => {
    vi.stubEnv("CHECKRAIL_AGENT_DEMO_OPEN", "1");
    vi.stubEnv("CHECKRAIL_AGENT_KEYS", "");
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_payment", arguments: { payee: "Maria Santos", amount: "180", currency: "USD", reference: "JOB-HG4D-0914" } } };
    const res = await inRequest(b, () => mcpPost(new Request("http://checkrail.test/api/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })), "cookie");
    expect(res.status).toBe(200);
    expect(inRequest(b, () => getDb().select().from(agentChecks).all()).map((c) => c.verdict)).toEqual(["block"]);
    expect(inRequest(a, () => getDb().select().from(agentChecks).all())).toEqual([]);
    expect(shared.select().from(agentChecks).all()).toEqual([]);
  });

  it("Start over resets only the visitor's copy", async () => {
    expect(inRequest(a, () => activeSandboxId())).toBe(a.split(".")[0]);
    const r = await inRequest(a, () => resetDemoAction());
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/Started over/) });
    expect(inRequest(a, () => phuongOf(getDb()).state)).toBe("blocked");
    expect(inRequest(b, () => getDb().select().from(agentChecks).all())).toHaveLength(1);
    // The shared database was never touched by any of it.
    expect(shared.select().from(auditEntries).all()).toHaveLength(sharedAudit);
  });
});
