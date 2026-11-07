import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { schema, withDb, type Db } from "../db";
import { SANDBOX_ID_RE } from "./settings";

/**
 * The per-visitor copies of the demo database (sandbox mode). The demo is seeded once into a template file, and each
 * new visitor gets a file copy of it, opened as its own SQLite database: copying a 1 MB file takes about a
 * millisecond, where seeding takes a few seconds.
 *
 *  - At most `max` copies. When full, the copy idle longest is evicted, but only if nobody has used it for
 *    `protectMs` (30 minutes): a judge in the middle of the demo is never pushed out. Otherwise the pool is busy and
 *    dbFor throws SandboxBusyError; the server shows a calm "try again in a few minutes" page.
 *  - At most `newPerClient` new copies per client address in `newWindowMs` (5 in 10 minutes), so a script without a
 *    cookie jar cannot churn through the pool. Only new visitors count: a signed visitor whose copy was deleted (idle,
 *    or past its life) gets a fresh one without using up the address's allowance.
 *  - A copy is deleted `maxLifeMs` (4 hours) after it was made, even if a tab keeps refreshing it.
 *  - A copy idle for `ttlMs` is deleted (maintain(), from a timer, and throttled on use).
 *  - The seed dates everything relative to now, so maintain() seeds a new template once the current one is older than
 *    `templateMaxAgeMs`, at a quiet moment (no copy used for a minute), into a temp file swapped in with a rename.
 *    Never on a request.
 *  - A replaced copy (Start over, eviction) is closed after `retireDelayMs` (3 s) so a request still reading it
 *    finishes; more than a few waiting are closed at once, so open files cannot pile up.
 *  - Files live in `dir`, which belongs to the pool: it is emptied at start.
 */
export interface PoolOptions {
  dir: string;
  max: number;
  ttlMs: number;
  /** Fills a freshly migrated database with the demo. Runs inside withDb, so code that calls getDb() gets this one. */
  seed: (db: Db) => Promise<void>;
  protectMs?: number;
  newPerClient?: number;
  newWindowMs?: number;
  /** A copy is deleted this long after it was made, used or not (4 hours): an open tab that refreshes itself cannot keep one forever. */
  maxLifeMs?: number;
  templateMaxAgeMs?: number;
  quietMs?: number;
  retireDelayMs?: number;
  now?: () => number;
  /** Called each time a copy is handed out (sandbox/server.ts runs a throttled autopilot pass from it). */
  onUse?: (id: string, db: Db) => void;
}

export class SandboxBusyError extends Error {
  /** A brand, not instanceof: a production build can load this module more than once, each with its own class. */
  readonly sandboxBusy = true;
  constructor(readonly reason: "full" | "rate") {
    super("The demo is busy. Try again in a few minutes.");
  }
}

export function isSandboxBusy(e: unknown): e is SandboxBusyError {
  return typeof e === "object" && e !== null && (e as { sandboxBusy?: unknown }).sandboxBusy === true;
}

type Entry = { id: string; file: string; sqlite: Database.Database; db: Db; createdAt: number; lastUsed: number };

const OWN_FILE = /^(template\.sqlite|sbx-[a-f0-9]{32}-\d+\.sqlite(-wal|-shm|-journal)?|template-.*\.building(-journal)?)$/;
const SWEEP_EVERY_MS = 30_000;
const MAX_WAITING_TO_CLOSE = 4;

export class SandboxPool {
  private readonly entries = new Map<string, Entry>();
  private readonly created = new Map<string, number[]>();
  private readonly retiring = new Set<Entry>();
  /** Visitors who have had a copy (bounded): one coming back is not a new visitor. */
  private readonly known = new Set<string>();
  private templateAt = 0;
  private templateGen = 0;
  private readOnlyDb: { gen: number; sqlite: Database.Database; db: Db } | null = null;
  private refreshing: Promise<void> | null = null;
  private lastSweep = 0;
  private lastUse = 0;
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly o: PoolOptions) {
    this.now = o.now ?? Date.now;
  }

  get templatePath(): string {
    return path.join(this.o.dir, "template.sqlite");
  }

  get size(): number {
    return this.entries.size;
  }

  /** Copies replaced or evicted whose connection is not closed yet. */
  get waitingToClose(): number {
    return this.retiring.size;
  }

  get templateBuiltAt(): number {
    return this.templateAt;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** When this visitor's current copy was made (changes on Start over and when a deleted copy is made again). */
  copiedAt(id: string): number | null {
    return this.entries.get(id)?.createdAt ?? null;
  }

  /** Empty the directory of anything a previous run left, then seed the template. */
  async init(): Promise<void> {
    fs.mkdirSync(this.o.dir, { recursive: true });
    for (const f of fs.readdirSync(this.o.dir)) if (OWN_FILE.test(f)) fs.rmSync(path.join(this.o.dir, f), { force: true });
    await this.buildTemplate();
  }

  /** Seed a new template beside the old one, then swap it in with a rename (atomic), so a copy is never half a template. */
  async buildTemplate(): Promise<void> {
    const tmp = path.join(this.o.dir, `template-${process.pid}-${this.now()}-${++this.generation}.building`);
    const sqlite = new Database(tmp);
    try {
      // A standalone file (no -wal beside it), so a plain file copy is the whole database. The journal is kept in
      // memory and nothing is synced while seeding: the file is a scratch file until the rename, and a crash leaves
      // only a .building file that the next start deletes. (With a journal on disk the seed takes 20 times longer.)
      sqlite.pragma("journal_mode = MEMORY");
      sqlite.pragma("synchronous = OFF");
      sqlite.pragma("foreign_keys = ON");
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await withDb(db, () => this.o.seed(db));
      sqlite.close();
      fs.renameSync(tmp, this.templatePath);
      this.templateAt = this.now();
      this.templateGen++;
    } catch (e) {
      if (sqlite.open) sqlite.close();
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  /**
   * This visitor's database, made from the template on first use. Throws SandboxBusyError when a new copy is needed
   * and the pool is full of copies in use, or this client address made too many lately.
   */
  dbFor(id: string, opts: { client?: string } = {}): Db {
    if (!SANDBOX_ID_RE.test(id)) throw new Error("Not a sandbox id");
    const t = this.now();
    this.sweep(t);
    const e = this.entries.get(id) ?? this.open(id, t, opts.client ?? "unknown");
    e.lastUsed = t;
    this.lastUse = t;
    this.o.onUse?.(id, e.db);
    return e.db;
  }

  /** The template, opened read-only: what a visitor turned away as busy is shown behind the busy page. */
  readOnly(): Db {
    if (!this.readOnlyDb || this.readOnlyDb.gen !== this.templateGen) {
      this.readOnlyDb?.sqlite.close();
      const sqlite = new Database(this.templatePath, { readonly: true, fileMustExist: true });
      this.readOnlyDb = { gen: this.templateGen, sqlite, db: drizzle(sqlite, { schema }) };
    }
    return this.readOnlyDb.db;
  }

  /** Start over: a fresh copy of the template for this visitor. The old one is closed after the retire delay. */
  reset(id: string): Db {
    const old = this.entries.get(id);
    if (old) {
      this.entries.delete(id);
      this.retire(old);
    }
    // A replacement, not a new visitor: it does not count against the address limit.
    const e = this.open(id, this.now(), null);
    return this.dbFor(e.id);
  }

  /** Delete copies idle longer than the TTL. Throttled unless forced. */
  sweep(t: number = this.now(), force = false): string[] {
    if (!force && t - this.lastSweep < SWEEP_EVERY_MS) return [];
    this.lastSweep = t;
    const gone: string[] = [];
    for (const e of [...this.entries.values()]) {
      if (t - e.lastUsed > this.o.ttlMs || t - e.createdAt > (this.o.maxLifeMs ?? 4 * 3600_000)) {
        this.entries.delete(e.id);
        this.retire(e);
        gone.push(e.id);
      }
    }
    for (const [k, times] of this.created) if (!times.some((x) => t - x < (this.o.newWindowMs ?? 600_000))) this.created.delete(k);
    return gone;
  }

  /**
   * Housekeeping from a timer, never from a request: delete idle copies, and seed a new template when the current one
   * is old and nobody has used a copy for a minute (or it is twice as old as allowed). Returns the refresh under way.
   */
  maintain(t: number = this.now()): Promise<void> | null {
    this.sweep(t, true);
    const maxAge = this.o.templateMaxAgeMs ?? 3 * 3600_000;
    const age = t - this.templateAt;
    const quiet = t - this.lastUse >= (this.o.quietMs ?? 60_000);
    if (this.refreshing || age < maxAge || (!quiet && age < 2 * maxAge)) return this.refreshing;
    this.refreshing = this.buildTemplate()
      .catch((err) => {
        // Try again after another full period rather than every minute.
        this.templateAt = this.now();
        console.error("[sandbox] template refresh failed; copies keep coming from the previous one:", (err as Error).message);
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /** Close every copy now (tests, shutdown). */
  close(): void {
    for (const e of [...this.entries.values()]) this.retire(e, true);
    for (const e of [...this.retiring]) this.retire(e, true);
    this.entries.clear();
    this.readOnlyDb?.sqlite.close();
    this.readOnlyDb = null;
  }

  private open(id: string, t: number, client: string | null): Entry {
    if (client !== null && !this.known.has(id)) {
      const windowMs = this.o.newWindowMs ?? 600_000;
      const recent = (this.created.get(client) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= (this.o.newPerClient ?? 5)) throw new SandboxBusyError("rate");
      if (this.entries.size >= this.o.max) this.evictIdle(t);
      recent.push(t);
      this.created.set(client, recent);
    } else if (this.entries.size >= this.o.max) {
      this.evictIdle(t);
    }
    this.known.add(id);
    if (this.known.size > 10_000) this.known.delete(this.known.values().next().value!);
    const file = path.join(this.o.dir, `sbx-${id}-${++this.generation}.sqlite`);
    fs.copyFileSync(this.templatePath, file);
    const sqlite = new Database(file);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    // A small page cache per copy: fifty open copies must fit beside the app in a small instance.
    sqlite.pragma("cache_size = -1024");
    const entry: Entry = { id, file, sqlite, db: drizzle(sqlite, { schema }), createdAt: t, lastUsed: t };
    this.entries.set(id, entry);
    return entry;
  }

  /** Make room by deleting the copy idle longest, if nobody has used it for protectMs. Otherwise the pool is busy. */
  private evictIdle(t: number): void {
    let oldest: Entry | null = null;
    for (const e of this.entries.values()) if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
    if (!oldest || t - oldest.lastUsed < (this.o.protectMs ?? 30 * 60_000)) throw new SandboxBusyError("full");
    this.entries.delete(oldest.id);
    this.retire(oldest);
  }

  private retire(e: Entry, now = false): void {
    const close = () => {
      this.retiring.delete(e);
      try {
        e.sqlite.close();
      } catch {
        /* already closed */
      }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(e.file + suffix, { force: true });
    };
    const delay = this.o.retireDelayMs ?? 3_000;
    if (now || delay <= 0 || this.retiring.size >= MAX_WAITING_TO_CLOSE) return close();
    this.retiring.add(e);
    setTimeout(close, delay).unref?.();
  }
}
