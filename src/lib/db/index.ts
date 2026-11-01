import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { config } from "../config";

export type Db = BetterSQLite3Database<typeof schema>;

let _db: Db | null = null;
let _sqlite: Database.Database | null = null;

/*
 * Which database a call gets. Normally the process singleton below. Two things can stand in for it, both kept on
 * globalThis because Next can load this module more than once in one process:
 *  - a scope: `withDb(db, fn)` makes every getDb() inside fn (and everything it awaits) return `db`. Used to seed the
 *    sandbox template and to run an autopilot pass on one visitor's copy.
 *  - a resolver: in sandbox mode (src/lib/sandbox/server.ts) it returns the copy of the database that belongs to the
 *    browser making the current request, or null outside a request. Not installed otherwise, so with sandbox mode off
 *    (development, tests, live mode) getDb() is exactly the singleton it always was.
 */
const g = globalThis as typeof globalThis & { __checkrailDbScope?: AsyncLocalStorage<Db>; __checkrailDbResolver?: (() => Db | null) | null };
const scope = (g.__checkrailDbScope ??= new AsyncLocalStorage<Db>());

/** Run `fn` with `db` as the database every getDb() inside it returns, including after awaits. */
export function withDb<T>(db: Db, fn: () => T): T {
  return scope.run(db, fn);
}

/** Install the per-request database resolver (sandbox mode), or remove it with null. */
export function setDbResolver(fn: (() => Db | null) | null): void {
  g.__checkrailDbResolver = fn;
}

/** Opens (and migrates) the database. Safe to call repeatedly; returns a singleton (or the scoped copy, see above). */
export function getDb(dbPath: string = config.dbPath): Db {
  const scoped = scope.getStore() ?? g.__checkrailDbResolver?.() ?? null;
  if (scoped) return scoped;
  if (_db) return _db;
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  _sqlite = new Database(dbPath);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _db = drizzle(_sqlite, { schema });
  migrate(_db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return _db;
}

/** For tests: a fresh in-memory database, not shared with the singleton. */
export function openTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

/**
 * An in-memory copy of a database, for evaluating a payment without changing the real books: everything written to the
 * copy (a draft request, an audit row, a scheduled release) disappears with it. Nothing reads back from it into `db`.
 */
export function snapshotOf(db: Db): Db {
  const source = (db as unknown as { $client: Database.Database }).$client;
  const image = source.serialize();
  // The app's database runs in WAL mode, and that is recorded in the file header (bytes 18 and 19 = 2). An in-memory
  // copy has no WAL file, so it refuses every write until the header says rollback journal (1).
  image[18] = 1;
  image[19] = 1;
  const sqlite = new Database(image);
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export { schema };
