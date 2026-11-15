// Local SQLite store (D10): single source of truth for inventory, sync metadata and the catalogue cache.
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

export const DB_NAME = 'brickheap.db';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
  list_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  color_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  base_quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (list_id, part_id, color_id)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY NOT NULL, v TEXT);

CREATE TABLE IF NOT EXISTS catalog_parts (
  part_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  category_id INTEGER,
  image_url TEXT,
  bricklink_ids TEXT NOT NULL DEFAULT '[]',
  lego_ids TEXT NOT NULL DEFAULT '[]',
  print_of TEXT,
  year_from INTEGER,
  year_to INTEGER,
  source TEXT NOT NULL DEFAULT 'rebrickable',
  resolution TEXT NOT NULL DEFAULT 'resolved',
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_bl_map (
  bricklink_id TEXT PRIMARY KEY NOT NULL,
  part_id TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_colors (
  color_id INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  hex TEXT NOT NULL,
  is_trans INTEGER NOT NULL DEFAULT 0,
  bricklink_id INTEGER
);
CREATE TABLE IF NOT EXISTS catalog_categories (id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_part_colors (
  part_id TEXT NOT NULL,
  color_id INTEGER NOT NULL,
  found INTEGER NOT NULL DEFAULT 1,
  element_ids TEXT NOT NULL DEFAULT '[]',
  image_url TEXT,
  num_sets INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (part_id, color_id)
);
`;

/** Ordered migrations: index i brings the schema from user_version i to i + 1. */
const MIGRATIONS: readonly string[] = [SCHEMA_V1];

let database: SQLiteDatabase | null = null;
let opening: Promise<void> | null = null;

async function migrate(conn: SQLiteDatabase): Promise<void> {
  await conn.execAsync('PRAGMA journal_mode = WAL;');
  const row = await conn.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const from = row?.user_version ?? 0;
  for (let v = from; v < MIGRATIONS.length; v++) {
    await conn.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync(MIGRATIONS[v]);
      await tx.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Opens the database and runs migrations (PRAGMA user_version). Rejects only on an unrecoverable error;
 *  calling it again after a rejection retries. */
export function openDb(): Promise<void> {
  if (database) return Promise.resolve();
  opening ??= (async () => {
    try {
      const conn = await openDatabaseAsync(DB_NAME);
      await migrate(conn);
      database = conn;
    } finally {
      opening = null;
    }
  })();
  return opening;
}

/** The opened database, for READS only. Throws Error('db not ready') before openDb() resolved. */
export function db(): SQLiteDatabase {
  if (!database) throw new Error('db not ready');
  return database;
}

let tail: Promise<unknown> = Promise.resolve();

/** The single write gate (D10). Callbacks run one at a time, in call order, each inside
 *  db().withExclusiveTransactionAsync (expo-sqlite opens a dedicated connection for it). The callback must issue
 *  every query on `tx` and must not call withWrite or any gated function (deadlock): pass `tx` down instead.
 *  A rejection rolls back that callback's transaction only and is re-thrown to its caller; the queue continues. */
export function withWrite<T>(fn: (tx: SQLiteDatabase) => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    let result!: T;
    await db().withExclusiveTransactionAsync(async (tx) => {
      result = await fn(tx);
    });
    return result;
  });
  tail = run.catch(() => undefined);
  return run;
}
