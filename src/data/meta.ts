// `meta` table: small per-device values written through the write gate.
import type { SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { db, withWrite } from './db';

export type MetaKey = 'owner_uid' | 'device_id' | 'since' | 'pending_batch' | 'last_list_id' | 'palette_fetched_at';

/** With `tx`: runs on it (caller already inside withWrite). Without: reads db(). */
export async function getMeta(key: MetaKey, tx?: SQLiteDatabase): Promise<string | null> {
  const row = await (tx ?? db()).getFirstAsync<{ v: string | null }>('SELECT v FROM meta WHERE k = ?', key);
  return row?.v ?? null;
}

async function writeMeta(conn: SQLiteDatabase, key: MetaKey, value: string | null): Promise<void> {
  if (value === null) await conn.runAsync('DELETE FROM meta WHERE k = ?', key);
  else await conn.runAsync('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
}

/** null deletes. With `tx`: runs on it. Without: opens its own withWrite callback. */
export async function setMeta(key: MetaKey, value: string | null, tx?: SQLiteDatabase): Promise<void> {
  if (tx) return writeMeta(tx, key, value);
  return withWrite((t) => writeMeta(t, key, value));
}

let deviceId: Promise<string> | null = null;
/** Creates a UUID on first call; memoised. Must not be called inside a withWrite callback. */
export function getDeviceId(): Promise<string> {
  deviceId ??= withWrite(async (tx) => {
    const existing = await getMeta('device_id', tx);
    if (existing) return existing;
    const id = randomUUID();
    await writeMeta(tx, 'device_id', id);
    return id;
  }).catch((e: unknown) => {
    deviceId = null;
    throw e;
  });
  return deviceId;
}
