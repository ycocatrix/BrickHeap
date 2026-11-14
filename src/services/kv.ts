// Synchronous key-value store over expo-sqlite/kv-store (D10).
// Keys in use: 'entered', 'settings', 'session.user', 'sb.<supabase storage key>', 'camera.pictureSize'.
import Storage from 'expo-sqlite/kv-store';

export const kv = {
  getString(key: string): string | null {
    return Storage.getItemSync(key);
  },
  setString(key: string, value: string): void {
    Storage.setItemSync(key, value);
  },
  remove(key: string): void {
    Storage.removeItemSync(key);
  },
  /** Fallback on a missing or unparsable value. */
  getJson<T>(key: string, fallback: T): T {
    const raw = Storage.getItemSync(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJson(key: string, value: unknown): void {
    Storage.setItemSync(key, JSON.stringify(value));
  },
};
