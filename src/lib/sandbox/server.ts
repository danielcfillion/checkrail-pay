import { randomBytes } from "node:crypto";
import path from "node:path";
import * as nextStore from "next/dist/server/app-render/work-unit-async-storage.external";
import { config } from "../config";
import { setDbResolver, withDb, type Db } from "../db";
import { seedDemo } from "../demo/seed";
import { runAutopilot } from "../engine/autopilot";
import { clientIp } from "../throttle";
import { SandboxPool, isSandboxBusy } from "./pool";
import { MIN_SANDBOX_SECRET, SANDBOX_COOKIE, SANDBOX_HEADER, sandboxKeyMaterial, sandboxSetting, verifySandboxToken, type Env } from "./settings";

/**
 * Sandbox mode on the Node server: which copy of the database a request gets.
 *
 * The middleware (edge) gives each browser a signed sandbox cookie and passes the token on in a request header. The
 * database seam (getDb in src/lib/db/index.ts) asks the resolver installed here, and the resolver reads the token
 * from Next's own request store, the AsyncLocalStorage that `headers()` and `cookies()` read. That store is there for
 * every page render, server action and route handler, so one resolver covers them all without touching any of them.
 * Middleware cannot do this itself: it runs on the edge runtime, away from the database.
 *
 * It fails closed. With sandbox mode on, getDb() returns the shared database only on the paths that are not a visitor
 * (SHARED_PATHS: an agent on /api/mcp with no cookie, PayPal's webhook, a scheduler's tick). Anywhere else, no
 * verified token, no request store, or a store of a shape this code does not know (a Next upgrade) throws a plain
 * error instead of quietly handing one visitor the database everyone else would see.
 */

type Installed = { pool: SandboxPool; material: string };
const g = globalThis as typeof globalThis & { __checkrailSandbox?: Installed | null };

/** Paths that are not a visitor and use the shared database when they carry no sandbox token. */
const SHARED_PATHS = new Set(["/api/mcp", "/api/webhooks/paypal", "/api/autopilot/tick"]);

export class SandboxScopeError extends Error {}

/** A per-sandbox autopilot pass at most this often, run when the visitor's copy is used (see onUse). */
const PASS_EVERY_MS = 10_000;
const lastPass = new Map<string, number>();
/** Requests turned away because the pool is busy: they see the busy page over a read-only template. */
const busyRequests = new WeakSet<object>();

type RequestShape = { type: "request"; headers: { get(n: string): string | null }; cookies?: { get(n: string): { value: string } | undefined }; url?: { pathname?: string } };

/** Next's request store for this request, or null when there is none or it is not the shape this code knows. */
function requestStore(): RequestShape | null {
  const als = (nextStore as { workUnitAsyncStorage?: { getStore?: () => unknown } }).workUnitAsyncStorage;
  const store = typeof als?.getStore === "function" ? (als.getStore() as Partial<RequestShape> | undefined) : undefined;
  if (!store || store.type !== "request" || typeof store.headers?.get !== "function") return null;
  return store as RequestShape;
}

/** The sandbox token on a request: the middleware's header first, then the cookie itself. */
function tokenOf(store: RequestShape): string | null {
  return store.headers.get(SANDBOX_HEADER) || (typeof store.cookies?.get === "function" ? store.cookies.get(SANDBOX_COOKIE)?.value : undefined) || null;
}

/** The sandbox token on the current request. */
export function requestToken(): string | null {
  const store = requestStore();
  return store ? tokenOf(store) : null;
}

/** The verified sandbox id of the current request, or null (also null with sandbox mode off). */
export function activeSandboxId(): string | null {
  const s = g.__checkrailSandbox;
  return s ? verifySandboxToken(requestToken(), s.material) : null;
}

/** Sandbox mode is running in this process. */
export function sandboxActive(): boolean {
  return Boolean(g.__checkrailSandbox);
}

/** When this visitor's copy was made, or null. The tour uses it to notice a fresh copy under an old tour step. */
export function activeCopiedAt(): number | null {
  const s = g.__checkrailSandbox;
  const id = activeSandboxId();
  return s && id ? s.pool.copiedAt(id) : null;
}

/**
 * True when this request was turned away because the pool is busy (full of copies in use, or too many new copies
 * from this address). The layout then shows the busy page; the request reads a read-only template meanwhile.
 */
export function sandboxBusy(): boolean {
  const store = requestStore();
  if (!g.__checkrailSandbox || !store || !tokenOf(store)) return false;
  resolve(g.__checkrailSandbox); // records the request when it is turned away
  return busyRequests.has(store);
}

/** Start over: replace this visitor's copy with a fresh one. False when there is no sandbox for this request. */
export function resetActiveSandbox(): boolean {
  const s = g.__checkrailSandbox;
  const id = activeSandboxId();
  if (!s || !id) return false;
  s.pool.reset(id);
  return true;
}

function resolve(s: Installed): Db | null {
  const store = requestStore();
  if (!store) throw new SandboxScopeError("Sandbox mode: no request to choose a copy of the demo for. Reload the page.");
  const id = verifySandboxToken(tokenOf(store), s.material);
  if (!id) {
    if (SHARED_PATHS.has(store.url?.pathname ?? "")) return null;
    throw new SandboxScopeError("Sandbox mode: this request carries no copy of the demo. Reload the page.");
  }
  try {
    return s.pool.dbFor(id, { client: clientIp(store.headers as Headers, process.env.CHECKRAIL_CLIENT_IP_HEADER) });
  } catch (e) {
    if (!isSandboxBusy(e)) throw e;
    busyRequests.add(store);
    return s.pool.readOnly();
  }
}

/** Install a pool as the request resolver. Exported for tests; the server calls startSandboxes. */
export function installSandboxPool(pool: SandboxPool, material: string): void {
  const s = { pool, material };
  g.__checkrailSandbox = s;
  setDbResolver(() => resolve(s));
}

export function uninstallSandboxPool(): void {
  g.__checkrailSandbox?.pool.close();
  g.__checkrailSandbox = null;
  setDbResolver(null);
  lastPass.clear();
}

/** Housekeeping from a timer: delete idle copies, reseed the template at a quiet moment. */
export function maintainSandboxes(): void {
  g.__checkrailSandbox?.pool.maintain();
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
 * Called once at server start (instrumentation), before any request. Seeds the template, installs the resolver and
 * starts a housekeeping timer when sandbox mode is asked for and allowed. Refused (and logged) whenever a live rail,
 * live AI or real money is configured, or in production without CHECKRAIL_SANDBOX_SECRET: the server then runs the
 * shared database exactly as without the setting. In development a missing secret is made up for this process and
 * put in the environment, where the middleware reads it. Returns whether sandbox mode is on.
 */
export async function startSandboxes(env: Env = process.env, dir: string = sandboxDir()): Promise<boolean> {
  const s = sandboxSetting(env);
  if (!s.requested) return false;
  if (!s.on) {
    console.error(`[sandbox] CHECKRAIL_SANDBOX=1 refused: ${s.refused}. Running the one shared database.`);
    return false;
  }
  if (g.__checkrailSandbox) return true;
  if (!sandboxKeyMaterial(env)) {
    env.CHECKRAIL_SANDBOX_SECRET = randomBytes(32).toString("base64url");
    console.warn(`[sandbox] CHECKRAIL_SANDBOX_SECRET is not set (at least ${MIN_SANDBOX_SECRET} characters): using a random one for this development server.`);
  }
  const pool = new SandboxPool({ dir, max: s.max, ttlMs: s.ttlMinutes * 60_000, seed: async (db) => void (await seedDemo(db, { history: true })), onUse: passOnUse });
  const t = Date.now();
  await pool.init();
  installSandboxPool(pool, sandboxKeyMaterial(env)!);
  setInterval(() => {
    try {
      pool.maintain();
    } catch (e) {
      console.error("[sandbox] housekeeping failed:", (e as Error).message);
    }
  }, 60_000).unref?.();
  console.log(`[sandbox] on: a private copy of the demo per browser, at most ${s.max}, deleted after ${s.ttlMinutes} min idle. Template seeded in ${Date.now() - t} ms.`);
  return true;
}
