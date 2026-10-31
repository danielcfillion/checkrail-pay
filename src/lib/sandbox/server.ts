import path from "node:path";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { config } from "../config";
import { setDbResolver, withDb, type Db } from "../db";
import { seedDemo } from "../demo/seed";
import { runAutopilot } from "../engine/autopilot";
import { SandboxPool } from "./pool";
import { SANDBOX_COOKIE, SANDBOX_HEADER, sandboxKeyMaterial, sandboxSetting, verifySandboxToken, type Env } from "./settings";

/**
 * Sandbox mode on the Node server: which copy of the database a request gets.
 *
 * The middleware (edge) gives each browser a signed sandbox cookie and passes the token on in a request header. The
 * database seam (getDb in src/lib/db/index.ts) asks the resolver installed here, and the resolver reads the token
 * from Next's own request store, the AsyncLocalStorage that `headers()` and `cookies()` read. That store is there for
 * every page render, server action and route handler, so one resolver covers them all without touching any of them.
 * Middleware cannot do this itself: it runs on the edge runtime, away from the database.
 *
 * /api/mcp is not seen by the middleware; there the resolver reads the same signed cookie (a browser) or the header
 * (an agent given the token). A request with neither, and code outside any request, gets the shared database.
 */

type Installed = { pool: SandboxPool; material: string };
const g = globalThis as typeof globalThis & { __checkrailSandbox?: Installed | null };

/** A per-sandbox autopilot pass at most this often, run when the visitor's copy is used (see onUse). */
const PASS_EVERY_MS = 10_000;
const lastPass = new Map<string, number>();

/** The sandbox token on the current request: the middleware's header first, then the cookie itself. */
export function requestToken(): string | null {
  const store = workUnitAsyncStorage.getStore() as { type?: string; headers?: { get(n: string): string | null }; cookies?: { get(n: string): { value: string } | undefined } } | undefined;
  if (!store || store.type !== "request") return null;
  return store.headers?.get(SANDBOX_HEADER) || store.cookies?.get(SANDBOX_COOKIE)?.value || null;
}

/** The verified sandbox id of the current request, or null. */
export function activeSandboxId(): string | null {
  const s = g.__checkrailSandbox;
  return s ? verifySandboxToken(requestToken(), s.material) : null;
}

/** Sandbox mode is running in this process. */
export function sandboxActive(): boolean {
  return Boolean(g.__checkrailSandbox);
}

/** Start over: replace this visitor's copy with a fresh one. False when there is no sandbox for this request. */
export function resetActiveSandbox(): boolean {
  const s = g.__checkrailSandbox;
  const id = activeSandboxId();
  if (!s || !id) return false;
  s.pool.reset(id);
  return true;
}

/** Install a pool as the request resolver. Exported for tests; the server calls startSandboxes. */
export function installSandboxPool(pool: SandboxPool, material: string): void {
  g.__checkrailSandbox = { pool, material };
  setDbResolver(() => {
    const id = activeSandboxId();
    return id ? pool.dbFor(id) : null;
  });
}

export function uninstallSandboxPool(): void {
  g.__checkrailSandbox?.pool.close();
  g.__checkrailSandbox = null;
  setDbResolver(null);
  lastPass.clear();
}

/** Delete copies idle past the TTL (the heartbeat calls this; using a copy also does, throttled). */
export function sweepSandboxes(): void {
  g.__checkrailSandbox?.pool.sweep();
}

/**
 * Autopilot in sandbox mode runs per copy, on use: when a visitor's copy is handed to a request, a pass runs on that
 * copy at most every ten seconds (releases due, settlements to confirm). The countdown on screen also asks for a pass
 * when it reaches zero, as it always has. A copy nobody is looking at runs nothing until its visitor comes back.
 */
function passOnUse(id: string, db: Db): void {
  const t = Date.now();
  if (t - (lastPass.get(id) ?? 0) < PASS_EVERY_MS) return;
  if (lastPass.size > 1000) lastPass.clear();
  lastPass.set(id, t);
  setImmediate(() => {
    withDb(db, () => runAutopilot(db)).catch((e) => console.error("[sandbox] autopilot pass failed:", (e as Error).message));
  });
}

/** Where the copies live: a folder beside the database file. */
export function sandboxDir(dbPath: string = config.dbPath): string {
  const base = dbPath === ":memory:" ? path.join(process.cwd(), "data") : path.dirname(path.resolve(dbPath));
  return path.join(base, "sandboxes");
}

/**
 * Called once at server start (instrumentation). Seeds the template and installs the resolver when sandbox mode is
 * asked for and allowed. Refused (and logged) whenever a live rail, live AI or real money is configured: the server
 * then runs the shared database exactly as without the setting. Returns whether sandbox mode is on.
 */
export async function startSandboxes(env: Env = process.env, dir: string = sandboxDir()): Promise<boolean> {
  const s = sandboxSetting(env);
  if (!s.requested) return false;
  if (!s.on) {
    console.error(`[sandbox] CHECKRAIL_SANDBOX=1 refused: ${s.refused}. Sandboxes are for simulated rails and the rule-based reader only; running the one shared database.`);
    return false;
  }
  if (g.__checkrailSandbox) return true;
  const pool = new SandboxPool({ dir, max: s.max, ttlMs: s.ttlMinutes * 60_000, seed: async (db) => void (await seedDemo(db, { history: true })), onUse: passOnUse });
  const t = Date.now();
  await pool.init();
  installSandboxPool(pool, sandboxKeyMaterial(env));
  if (!env.CHECKRAIL_SANDBOX_SECRET?.trim()) console.warn("[sandbox] CHECKRAIL_SANDBOX_SECRET is not set: the cookie is signed with a key derived from the login settings.");
  console.log(`[sandbox] on: a private copy of the demo per browser, at most ${s.max}, deleted after ${s.ttlMinutes} min idle. Template seeded in ${Date.now() - t} ms.`);
  return true;
}
