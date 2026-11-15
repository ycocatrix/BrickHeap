import type { Settings } from '@/domain/types';
import { kv } from '@/services/kv';
import { createStore, useStore, type Store } from './createStore';

export const DEFAULT_SETTINGS: Settings = {
  torchOnLaunch: false,
  haptics: true,
  liveExplorer: true,
  calibration: false,
  inventoryView: 'grid',
};

export const settingsStore: Store<Settings> = createStore<Settings>({ ...DEFAULT_SETTINGS });

/** Synchronous: kv 'settings' merged over the defaults (unknown keys and wrong types ignored). */
export function loadSettings(): void {
  const saved = kv.getJson<Record<string, unknown>>('settings', {});
  const next: Settings = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = saved[k];
      if (typeof v === typeof DEFAULT_SETTINGS[k]) (next as unknown as Record<string, unknown>)[k] = v;
    }
    if (next.inventoryView !== 'grid' && next.inventoryView !== 'list') next.inventoryView = 'grid';
  }
  settingsStore.set(next);
}

/** Updates the store and persists the whole settings object. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settingsStore.set({ [key]: value } as unknown as Partial<Settings>);
  kv.setJson('settings', settingsStore.get());
}

export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useStore(settingsStore, (s) => s[key]);
}
