// Supabase client with encrypted session storage (RT_02, D12).
import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { env, isSupabaseConfigured } from './env';
import { kv } from './kv';
import { utf8Decode, utf8Encode } from '@/domain/utf8';

const KEY_NAME = 'brickheap.session-key'; // SecureStore: alphanumerics . - _ only
let keyPromise: Promise<AESEncryptionKey> | null = null;
const sessionKey = (): Promise<AESEncryptionKey> =>
  (keyPromise ??= (async () => {
    try {
      const stored = await SecureStore.getItemAsync(KEY_NAME);
      if (stored) return await AESEncryptionKey.import(stored, 'base64');
      const key = await AESEncryptionKey.generate(); // 256-bit
      await SecureStore.setItemAsync(KEY_NAME, await key.encoded('base64'));
      return key;
    } catch (e) {
      keyPromise = null; // let a later call retry (e.g. keystore temporarily unavailable)
      throw e;
    }
  })());

// Key in the OS keystore, AES-GCM ciphertext in kv-store: a session JSON exceeds the ~2 KB SecureStore limit.
const storage = {
  async getItem(k: string): Promise<string | null> {
    const sealed = kv.getString('sb.' + k);
    if (!sealed) return null;
    try {
      const bytes = await aesDecryptAsync(AESSealedData.fromCombined(sealed), await sessionKey()); // Uint8Array
      return utf8Decode(bytes);
    } catch {
      // key lost (reinstall) or corrupted value → signed out
      kv.remove('sb.' + k);
      return null;
    }
  },
  async setItem(k: string, v: string): Promise<void> {
    const sealed = await aesEncryptAsync(utf8Encode(v), await sessionKey()); // bytes, never a raw string
    kv.setString('sb.' + k, await sealed.combined('base64'));
  },
  async removeItem(k: string): Promise<void> {
    kv.remove('sb.' + k);
  },
};

/** null when !isSupabaseConfigured(): guest-only installation. */
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(env.supabaseUrl, env.supabaseKey, {
      auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    })
  : null;

let autoRefreshRegistered = false;
/** RG_12: refresh tokens only while the app is in the foreground. Registered once, from initSession(). */
export function registerAutoRefresh(): void {
  const client = supabase;
  if (!client || autoRefreshRegistered) return;
  autoRefreshRegistered = true;
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void client.auth.startAutoRefresh();
    else void client.auth.stopAutoRefresh();
  });
}
