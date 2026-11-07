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
import { agentChecks, auditEntries, businesses, obligations } from "@/lib/db/schema";
import { seedDemo } from "@/lib/demo/seed";
import { ACTOR_HEADER, ROLE_HEADER } from "@/lib/basicAuth";
import { amendAction, resetDemoAction } from "@/app/actions";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { middleware } from "@/middleware";
import { runAutopilot, setAutonomy } from "@/lib/engine/autopilot";
import { DEMO_BUSINESS_ID } from "@/lib/demo/seed";
import { SandboxBusyError, SandboxPool, isSandboxBusy } from "./pool";
import { activeCopiedAt, activeSandboxId, installSandboxPool, sandboxBusy, startSandboxes, uninstallSandboxPool } from "./server";
import { hmacSha256, sha256 } from "./hmac";
import { SANDBOX_COOKIE, SANDBOX_HEADER, newSandboxId, sandboxForRequest, sandboxKeyMaterial, sandboxSetting, signSandboxId, verifySandboxToken } from "./settings";

const MATERIAL = "sandbox-test-secret";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "checkrail-sandbox-"));
const seed = async (db: Db) => void (await seedDemo(db, { history: true }));
const phuongOf = (db: Db) => db.select().from(obligations).where(eq(obligations.sourceRef, "INV-2026-0152")).get()!;

/** Run `fn` inside a Next request store, as the server does for every page, action and route handler. */
function inRequest<T>(token: string | null, fn: () => T, via: "header" | "cookie" = "header", pathname = "/", ip = "198.51.100.7"): T {
  const h = new Headers({ [ACTOR_HEADER]: "daniel", [ROLE_HEADER]: "admin", "content-type": "application/json", "x-forwarded-for": ip });
  if (token && via === "header") h.set(SANDBOX_HEADER, token);
  state.headers = h;
  const cookies = { get: (n: string) => (token && via === "cookie" && n === SANDBOX_COOKIE ? { name: n, value: token } : undefined) };
  return workUnitAsyncStorage.run({ type: "request", headers: h, cookies, url: { pathname, search: "" } } as never, fn);
}

describe("sandbox setting", () => {
  it("is off unless asked for", () => {
    expect(sandboxSetting({}).on).toBe(false);
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1" })).toMatchObject({ on: true, refused: null, max: 50, ttlMinutes: 120 });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", RAIL_MODE: "mock", CHECKRAIL_SANDBOX_MAX: "3", CHECKRAIL_SANDBOX_TTL_MINUTES: "5" })).toMatchObject({ on: true, max: 3, ttlMinutes: 5 });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", CHECKRAIL_SANDBOX_MAX: "zero" }).max).toBe(50);
  });

  it("requires CHECKRAIL_SANDBOX_SECRET in production, and never derives one from the logins or the data key", () => {
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", NODE_ENV: "production" })).toMatchObject({ on: false, refused: expect.stringMatching(/CHECKRAIL_SANDBOX_SECRET/) });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", NODE_ENV: "production", CHECKRAIL_SANDBOX_SECRET: "short" }).on).toBe(false);
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", NODE_ENV: "production", CHECKRAIL_SANDBOX_SECRET: MATERIAL }).on).toBe(true);
    expect(sandboxKeyMaterial({ CHECKRAIL_USERS: "judge:a-long-password:admin", CHECKRAIL_DATA_KEY: "x".repeat(44) })).toBeNull();
    expect(sandboxForRequest(undefined, {})).toBeNull();
  });

  it("raises the per-address limit when the client address is unverified in production", () => {
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1" })).toMatchObject({ newPerClient: 5, addressVerified: true });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", NODE_ENV: "production", CHECKRAIL_SANDBOX_SECRET: MATERIAL })).toMatchObject({ newPerClient: 30, addressVerified: false });
    expect(sandboxSetting({ CHECKRAIL_SANDBOX: "1", NODE_ENV: "production", CHECKRAIL_SANDBOX_SECRET: MATERIAL, CHECKRAIL_CLIENT_IP_HEADER: "cf-connecting-ip" })).toMatchObject({ newPerClient: 5, addressVerified: true });
  });

  it("makes up a random secret for a development server that has none", async () => {
    const env: Record<string, string | undefined> = { CHECKRAIL_SANDBOX: "1" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(getDb().select().from(businesses).all()).toEqual([]); // the shared database starts empty here
      expect(await startSandboxes(env, tmp())).toBe(true);
      expect(env.CHECKRAIL_SANDBOX_SECRET?.length).toBeGreaterThanOrEqual(32);
      // Seeded at start, for outside agents on /api/mcp that carry no cookie.
      expect(workUnitAsyncStorage.run({ type: "request", headers: new Headers(), url: { pathname: "/api/mcp" } } as never, () => getDb().select().from(businesses).all()).length).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/random one/));
    } finally {
      uninstallSandboxPool();
      warn.mockRestore();
      log.mockRestore();
    }
  }, 60_000);

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
    expect(verifySandboxToken(token, "another key that is long")).toBeNull();
    const [, exp, sig] = token.split(".");
    expect(verifySandboxToken(`${newSandboxId()}.${exp}.${sig}`, MATERIAL)).toBeNull();
    expect(verifySandboxToken(`../../etc.${exp}.${sig}`, MATERIAL)).toBeNull();
    expect(verifySandboxToken(`${id}.${(parseInt(exp, 36) + 1000).toString(36)}.${sig}`, MATERIAL)).toBeNull(); // a later expiry is not signed
    expect(verifySandboxToken(id, MATERIAL)).toBeNull();
    expect(verifySandboxToken(null, MATERIAL)).toBeNull();
  });

  it("carries an expiry: a day after it was signed it is refused", () => {
    const t0 = Date.UTC(2026, 10, 1);
    const token = signSandboxId(newSandboxId(), MATERIAL, t0);
    expect(verifySandboxToken(token, MATERIAL, t0 + 23 * 3600_000)).toBeTruthy();
    expect(verifySandboxToken(token, MATERIAL, t0 + 25 * 3600_000)).toBeNull();
    const env = { CHECKRAIL_SANDBOX_SECRET: MATERIAL };
    expect(sandboxForRequest(token, env, t0 + 25 * 3600_000)?.fresh).toBe(true);
  });

  it("renews a token in use once it is past half its life, for the same copy", () => {
    const t0 = Date.UTC(2026, 10, 1);
    const env = { CHECKRAIL_SANDBOX_SECRET: MATERIAL };
    const id = newSandboxId();
    const token = signSandboxId(id, MATERIAL, t0);
    expect(sandboxForRequest(token, env, t0 + 3600_000)).toEqual({ token, fresh: false });
    const renewed = sandboxForRequest(token, env, t0 + 13 * 3600_000)!;
    expect(renewed.fresh).toBe(true);
    expect(renewed.token).not.toBe(token);
    expect(verifySandboxToken(renewed.token, MATERIAL, t0 + 30 * 3600_000)).toBe(id);
  });

  it("keeps a valid cookie and replaces a forged one", () => {
    const env = { CHECKRAIL_SANDBOX_SECRET: MATERIAL };
    const mine = signSandboxId(newSandboxId(), MATERIAL);
    expect(sandboxForRequest(mine, env)).toEqual({ token: mine, fresh: false });
    const forged = sandboxForRequest(`${newSandboxId()}.forged`, env)!;
    expect(forged.fresh).toBe(true);
    expect(verifySandboxToken(forged.token, MATERIAL)).toBeTruthy();
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
      // An API key on /api/v1 is no visitor either: no copy, no cookie, and a client's token is not forwarded.
      const api = middleware(new NextRequest("http://checkrail.test/api/v1/requests", { headers: { cookie: `${SANDBOX_COOKIE}=${forwarded}`, [SANDBOX_HEADER]: forwarded } }));
      expect(api.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBeNull();
      expect(api.headers.get("set-cookie")).toBeNull();
      // PayPal's webhook is no visitor: no copy is made for it.
      const hook = middleware(new NextRequest("http://checkrail.test/api/webhooks/paypal", { method: "POST" }));
      expect(hook.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBeNull();
      expect(hook.headers.get("set-cookie")).toBeNull();
      // A vendor link without this browser's cookie gets a plain page, never a new copy.
      const link = "http://checkrail.test/onboard/abcdefghijklmnopqrstuvwxyz012345";
      const stranger = middleware(new NextRequest(link));
      expect(stranger.headers.get("set-cookie")).toBeNull();
      expect(stranger.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBeNull();
      expect(stranger.headers.get("content-type")).toMatch(/text\/html/);
      const owner = middleware(new NextRequest(link, { headers: { cookie: `${SANDBOX_COOKIE}=${forwarded}` } }));
      expect(owner.headers.get(`x-middleware-request-${SANDBOX_HEADER}`)).toBe(forwarded);
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
    pool = new SandboxPool({ dir, max: 3, ttlMs: 60_000, seed, now: () => clock, retireDelayMs: 0, protectMs: 0, newPerClient: 100 });
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

  it("evicts the copy idle longest when full (with no protection window)", () => {
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

  it("fails closed: no request, no token or an unknown store never gets the shared database", () => {
    expect(() => getDb()).toThrow(/no request/);
    expect(() => inRequest(null, () => getDb())).toThrow(/carries no copy/);
    expect(() => inRequest(signSandboxId(newSandboxId(), "a wrong key, long enough"), () => getDb())).toThrow(/carries no copy/);
    // The internal store changed shape (a Next upgrade): no type, or headers that are not Headers.
    expect(() => workUnitAsyncStorage.run({ kind: "request", headers: new Headers({ [SANDBOX_HEADER]: a }) } as never, () => getDb())).toThrow();
    expect(() => workUnitAsyncStorage.run({ type: "request", headers: { [SANDBOX_HEADER]: a }, url: { pathname: "/" } } as never, () => getDb())).toThrow();
    // Only the paths that are no visitor may use the shared database without a token.
    for (const p of ["/api/mcp", "/api/webhooks/paypal", "/api/autopilot/tick"]) expect(inRequest(null, () => getDb(), "header", p)).toBe(shared);
    // The REST API is server-to-server: the shared database, even with a visitor's token in the header or cookie.
    for (const p of ["/api/v1/requests", "/api/v1/departures", "/api/v1/requests/obl_x"]) {
      expect(inRequest(null, () => getDb(), "header", p)).toBe(shared);
      expect(inRequest(a, () => getDb(), "header", p)).toBe(shared);
      expect(inRequest(a, () => getDb(), "cookie", p)).toBe(shared);
    }
    // RT-2: a path under /api/v1 that is not one of the routes renders the app layout for a visitor: their copy, never shared.
    for (const p of ["/api/v1/zzz", "/api/v1/", "/api/v1/requests/a/b", "/api/v1/vendors/x"]) {
      expect(inRequest(a, () => getDb(), "header", p), p).not.toBe(shared);
      expect(inRequest(a, () => getDb(), "cookie", p), p).not.toBe(shared);
      expect(() => inRequest(null, () => getDb(), "header", p), p).toThrow(/carries no copy/);
    }
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
    // The demo seed carries its own agent-check rows; count only what this call adds.
    const seeded = (v: string) => inRequest(v, () => getDb().select().from(agentChecks).all()).length;
    const [beforeA, beforeB, beforeShared] = [seeded(a), seeded(b), shared.select().from(agentChecks).all().length];
    const res = await inRequest(b, () => mcpPost(new Request("http://checkrail.test/api/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })), "cookie");
    expect(res.status).toBe(200);
    expect(inRequest(b, () => getDb().select().from(agentChecks).all()).slice(beforeB).map((c) => c.verdict)).toEqual(["block"]);
    expect(seeded(a)).toBe(beforeA);
    expect(shared.select().from(agentChecks).all()).toHaveLength(beforeShared);
  });

  it("Start over works for every demo person in sandbox mode: it only touches their own copy", async () => {
    const lan = signSandboxId(newSandboxId(), MATERIAL);
    const r = await workUnitAsyncStorage.run({ type: "request", headers: new Headers({ [SANDBOX_HEADER]: lan, [ACTOR_HEADER]: "lan", [ROLE_HEADER]: "clerk" }), url: { pathname: "/" } } as never, () => {
      state.headers = new Headers({ [ACTOR_HEADER]: "lan", [ROLE_HEADER]: "clerk" });
      return resetDemoAction();
    });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/Started over/) });
  });

  it("Start over resets only the visitor's copy, and gives it a new copy time", async () => {
    expect(inRequest(a, () => activeSandboxId())).toBe(a.split(".")[0]);
    const before = inRequest(a, () => activeCopiedAt());
    await new Promise((r) => setTimeout(r, 5));
    const r = await inRequest(a, () => resetDemoAction());
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/Started over/) });
    expect(inRequest(a, () => phuongOf(getDb()).state)).toBe("blocked");
    expect(inRequest(a, () => activeCopiedAt())).not.toBe(before);
    // b keeps the check the /api/mcp test added on top of the seeded rows; a's reset did not touch it.
    expect(inRequest(b, () => getDb().select().from(agentChecks).all()).filter((c) => c.reference === "JOB-HG4D-0914" && c.verdict === "block")).toHaveLength(1);
    // The shared database was never touched by any of it.
    expect(shared.select().from(auditEntries).all()).toHaveLength(sharedAudit);
  });
});

describe("a busy pool never pushes out a judge in the middle of the demo", () => {
  let clock = 5_000_000;
  let pool: SandboxPool;
  beforeAll(async () => {
    pool = new SandboxPool({ dir: tmp(), max: 3, ttlMs: 3 * 3600_000, seed, now: () => clock, retireDelayMs: 0 });
    await pool.init();
  }, 30_000);
  afterAll(() => pool.close());

  it("allows five new copies per address in ten minutes", () => {
    const big = new SandboxPool({ dir: tmp(), max: 50, ttlMs: 3600_000, seed, now: () => clock, retireDelayMs: 0 });
    (big as unknown as { templateAt: number }).templateAt = clock;
    fs.copyFileSync(pool.templatePath, big.templatePath);
    for (let i = 0; i < 5; i++) big.dbFor(newSandboxId(), { client: "203.0.113.9" });
    expect(() => big.dbFor(newSandboxId(), { client: "203.0.113.9" })).toThrow(SandboxBusyError);
    expect(() => big.dbFor(newSandboxId(), { client: "203.0.113.10" })).not.toThrow();
    clock += 11 * 60_000;
    expect(() => big.dbFor(newSandboxId(), { client: "203.0.113.9" })).not.toThrow();
    big.close();
  });

  it("when full, evicts only a copy idle for 30 minutes; otherwise the newcomer is told the demo is busy", () => {
    const judges = [newSandboxId(), newSandboxId(), newSandboxId()];
    judges.forEach((id, i) => pool.dbFor(id, { client: `10.0.0.${i}` }));
    clock += 60_000;
    // Anonymous newcomers with a full pool of copies used a minute ago: nobody is pushed out.
    for (let i = 0; i < 4; i++) expect(() => pool.dbFor(newSandboxId(), { client: `192.0.2.${i}` })).toThrow(SandboxBusyError);
    expect(judges.every((id) => pool.has(id))).toBe(true);
    // Half an hour later, judge 0 has gone quiet while 1 and 2 kept going: only judge 0's copy makes room.
    clock += 31 * 60_000;
    pool.dbFor(judges[1]);
    pool.dbFor(judges[2]);
    const late = newSandboxId();
    pool.dbFor(late, { client: "192.0.2.99" });
    expect(pool.has(judges[0])).toBe(false);
    expect(pool.has(judges[1]) && pool.has(judges[2]) && pool.has(late)).toBe(true);
  });

  it("a returning visitor whose copy was deleted does not use up the address's allowance", () => {
    let own = 9_000_000;
    const p2 = new SandboxPool({ dir: tmp(), max: 50, ttlMs: 60_000, seed, now: () => own, retireDelayMs: 0, newPerClient: 2 });
    fs.copyFileSync(pool.templatePath, p2.templatePath);
    const [v1, v2] = [newSandboxId(), newSandboxId()];
    p2.dbFor(v1, { client: "203.0.113.50" });
    p2.dbFor(v2, { client: "203.0.113.50" });
    own += 2 * 60_000;
    expect(p2.sweep(own, true).sort()).toEqual([v1, v2].sort()); // both idle past the TTL
    expect(() => p2.dbFor(v1, { client: "203.0.113.50" })).not.toThrow(); // known visitors come back
    expect(() => p2.dbFor(newSandboxId(), { client: "203.0.113.50" })).toThrow(SandboxBusyError); // a third new one does not
    p2.close();
  });

  it("deletes a copy four hours after it was made, even if a tab keeps refreshing it", () => {
    let own = 9_000_000;
    const p3 = new SandboxPool({ dir: tmp(), max: 5, ttlMs: 3600_000, seed, now: () => own, retireDelayMs: 0 });
    fs.copyFileSync(pool.templatePath, p3.templatePath);
    const v = newSandboxId();
    p3.dbFor(v);
    const made = p3.copiedAt(v);
    for (let i = 0; i < 8; i++) {
      own += 30 * 60_000;
      p3.sweep(own, true);
      expect(p3.copiedAt(v)).toBe(made); // still the same copy up to four hours
      p3.dbFor(v); // refreshed every half hour
    }
    own += 30 * 60_000;
    p3.sweep(own, true);
    expect(p3.has(v)).toBe(false); // four and a half hours: gone, refreshes or not
    p3.close();
  });

  it("closes replaced copies promptly, so open files cannot pile up", () => {
    const slow = new SandboxPool({ dir: tmp(), max: 10, ttlMs: 3600_000, seed, now: () => clock, retireDelayMs: 60_000 });
    fs.copyFileSync(pool.templatePath, slow.templatePath);
    const id = newSandboxId();
    slow.dbFor(id);
    for (let i = 0; i < 10; i++) slow.reset(id);
    expect(slow.waitingToClose).toBeLessThanOrEqual(4);
    slow.close();
    expect(slow.waitingToClose).toBe(0);
  });

  it("reseeds the template from housekeeping at a quiet moment, never on a request", async () => {
    const built = pool.templateBuiltAt;
    clock += 4 * 3600_000; // older than the three hours allowed
    pool.dbFor(pool.ids()[0]);
    expect(pool.templateBuiltAt).toBe(built); // a request never starts it
    expect(pool.maintain(clock)).toBeNull(); // used a moment ago: not quiet yet
    clock += 2 * 60_000;
    const refresh = pool.maintain(clock);
    expect(refresh).not.toBeNull();
    await refresh;
    expect(pool.templateBuiltAt).toBe(clock);
  }, 60_000);
});

describe("a busy visitor sees the busy page, not someone else's copy", () => {
  let pool: SandboxPool;
  beforeAll(async () => {
    pool = new SandboxPool({ dir: tmp(), max: 1, ttlMs: 3600_000, seed, retireDelayMs: 0 });
    await pool.init();
    installSandboxPool(pool, MATERIAL);
  }, 30_000);
  afterAll(() => uninstallSandboxPool());

  it("recognises a busy error from another copy of the module (a production build bundles it more than once)", () => {
    class ForeignBusy extends Error {
      readonly sandboxBusy = true;
    }
    expect(new ForeignBusy("x") instanceof SandboxBusyError).toBe(false);
    expect(isSandboxBusy(new ForeignBusy("x"))).toBe(true);
    expect(isSandboxBusy(new Error("x"))).toBe(false);
  });

  it("reads the template read-only and is flagged busy", () => {
    const first = signSandboxId(newSandboxId(), MATERIAL);
    const second = signSandboxId(newSandboxId(), MATERIAL);
    expect(inRequest(first, () => sandboxBusy())).toBe(false);
    const own = inRequest(first, () => getDb());
    expect(inRequest(second, () => sandboxBusy())).toBe(true);
    const shown = inRequest(second, () => getDb());
    expect(shown).not.toBe(own);
    expect(phuongOf(shown).state).toBe("blocked");
    expect(() => shown.update(obligations).set({ state: "cancelled" }).run()).toThrow(/readonly/);
    expect(pool.size).toBe(1);
  });
});

describe("autopilot passes on two copies at once", () => {
  it("each copy gets its own pass, its own result and its own scheduled rows", async () => {
    const pool = new SandboxPool({ dir: tmp(), max: 5, ttlMs: 3600_000, seed, retireDelayMs: 0 });
    await pool.init();
    try {
      const [a, b] = [pool.dbFor(newSandboxId()), pool.dbFor(newSandboxId())];
      for (const db of [a, b]) setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 60 });
      // Make B's copy differ: its clean request is cancelled, so B has nothing to schedule.
      const clean = (db: Db) => db.select().from(obligations).where(eq(obligations.sourceRef, "JOB-HG4D-0921")).get()!;
      b.update(obligations).set({ state: "cancelled" }).where(eq(obligations.id, clean(b).id)).run();
      const [ra, rb] = await Promise.all([runAutopilot(a), runAutopilot(b)]);
      expect(ra.scheduled).toEqual([clean(a).id]);
      expect(rb.scheduled).toEqual([]);
      expect(clean(a).releaseAt).not.toBeNull();
      expect(clean(b).releaseAt).toBeNull();
      // And the other way round: B's pass runs even while A's is in flight.
      b.update(obligations).set({ state: "approved" }).where(eq(obligations.id, clean(b).id)).run();
      const [, rb2] = await Promise.all([runAutopilot(a), runAutopilot(b)]);
      expect(rb2.scheduled).toEqual([clean(b).id]);
    } finally {
      pool.close();
    }
  }, 60_000);
});
