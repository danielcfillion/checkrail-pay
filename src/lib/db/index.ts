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

/** Opens (and migrates) the database. Safe to call repeatedly; returns a singleton. */
export function getDb(dbPath: string = config.dbPath): Db {
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

export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

export { schema };
