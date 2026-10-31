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
 * millisecond, where seeding takes about two seconds.
 *
 *  - At most `max` copies. When full, the one idle longest is evicted.
 *  - A copy idle for `ttlMs` is deleted (checked at most every 30 seconds, on use and from the heartbeat).
 *  - The seed dates everything relative to now, so the template is rebuilt in the background once it is older than
 *    `templateMaxAgeMs`; until the new one is ready, copies come from the old one.
 *  - A replaced copy (Start over, eviction) is closed after `retireDelayMs`, so a request still reading it finishes.
 *  - Files live in `dir`, which belongs to the pool: it is emptied at start.
 */
export interface PoolOptions {
  dir: string;
  max: number;
  ttlMs: number;
  /** Fills a freshly migrated database with the demo. Runs inside withDb, so code that calls getDb() gets this one. */
  seed: (db: Db) => Promise<void>;
  templateMaxAgeMs?: number;
  retireDelayMs?: number;
  now?: () => number;
  /** Called each time a copy is handed out (sandbox/server.ts runs a throttled autopilot pass from it). */
  onUse?: (id: string, db: Db) => void;
}

type Entry = { id: string; file: string; sqlite: Database.Database; db: Db; createdAt: number; lastUsed: number };

const OWN_FILE = /^(template\.sqlite|sbx-[a-f0-9]{32}-\d+\.sqlite(-wal|-shm|-journal)?|template-.*\.building(-journal)?)$/;
const SWEEP_EVERY_MS = 30_000;

export class SandboxPool {
  private readonly entries = new Map<string, Entry>();
  private templateAt = 0;
  private refreshing: Promise<void> | null = null;
  private lastSweep = 0;
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

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
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
    } catch (e) {
      if (sqlite.open) sqlite.close();
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** This visitor's database, made from the template on first use. */
  dbFor(id: string): Db {
    if (!SANDBOX_ID_RE.test(id)) throw new Error("Not a sandbox id");
    const t = this.now();
    this.sweep(t);
    const e = this.entries.get(id) ?? this.open(id, t);
    e.lastUsed = t;
    this.refreshTemplateIfStale(t);
    this.o.onUse?.(id, e.db);
    return e.db;
  }

  /** Start over: a fresh copy of the template for this visitor. The old one is closed after the retire delay. */
  reset(id: string): Db {
    const old = this.entries.get(id);
    if (old) {
      this.entries.delete(id);
      this.retire(old);
    }
    return this.dbFor(id);
  }

  /** Delete copies idle longer than the TTL. Throttled unless forced. */
  sweep(t: number = this.now(), force = false): string[] {
    if (!force && t - this.lastSweep < SWEEP_EVERY_MS) return [];
    this.lastSweep = t;
    const gone: string[] = [];
    for (const e of [...this.entries.values()]) {
      if (t - e.lastUsed > this.o.ttlMs) {
        this.entries.delete(e.id);
        this.retire(e);
        gone.push(e.id);
      }
    }
    return gone;
  }

  /** Close every copy now (tests, shutdown). */
  close(): void {
    for (const e of [...this.entries.values()]) this.retire(e, true);
    this.entries.clear();
  }

  private open(id: string, t: number): Entry {
    while (this.entries.size >= this.o.max) this.evictOldest();
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

  private evictOldest(): void {
    let oldest: Entry | null = null;
    for (const e of this.entries.values()) if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
    if (!oldest) return;
    this.entries.delete(oldest.id);
    this.retire(oldest);
  }

  private retire(e: Entry, now = false): void {
    const close = () => {
      try {
        e.sqlite.close();
      } catch {
        /* already closed */
      }
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(e.file + suffix, { force: true });
    };
    const delay = this.o.retireDelayMs ?? 15_000;
    if (now || delay <= 0) close();
    else setTimeout(close, delay).unref?.();
  }

  private refreshTemplateIfStale(t: number): void {
    const maxAge = this.o.templateMaxAgeMs ?? 3 * 3600_000;
    if (this.refreshing || t - this.templateAt < maxAge) return;
    this.refreshing = this.buildTemplate()
      .catch((err) => {
        // Try again after another full period rather than on every request.
        this.templateAt = this.now();
        console.error("[sandbox] template refresh failed; copies keep coming from the previous one:", (err as Error).message);
      })
      .finally(() => {
        this.refreshing = null;
      });
  }
}
