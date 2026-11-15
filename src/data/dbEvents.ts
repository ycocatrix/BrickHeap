import { useCallback, useSyncExternalStore } from 'react';

/** 'mutation' = a local user change that must be synced (emitted by inventoryRepo only, never by sync). */
export type DbTopic = 'inventory' | 'lists' | 'catalog' | 'mutation';

const listeners: Record<DbTopic, Set<() => void>> = {
  inventory: new Set(),
  lists: new Set(),
  catalog: new Set(),
  mutation: new Set(),
};
const versions: Record<DbTopic, number> = { inventory: 0, lists: 0, catalog: 0, mutation: 0 };

export function notify(...topics: DbTopic[]): void {
  const unique = [...new Set(topics)];
  for (const t of unique) versions[t]++;
  const called = new Set<() => void>();
  for (const t of unique) {
    for (const l of [...listeners[t]]) {
      if (called.has(l)) continue;
      called.add(l);
      try {
        l();
      } catch {
        // a faulty listener must not break the others
      }
    }
  }
}

export function subscribe(topic: DbTopic, listener: () => void): () => void {
  listeners[topic].add(listener);
  return () => {
    listeners[topic].delete(listener);
  };
}

/** Increments whenever one of the topics is notified; use as an effect dependency. */
export function useDbVersion(...topics: DbTopic[]): number {
  const key = [...new Set(topics)].sort().join(',');
  const sub = useCallback(
    (l: () => void) => {
      const offs = (key ? (key.split(',') as DbTopic[]) : []).map((t) => subscribe(t, l));
      return () => offs.forEach((off) => off());
    },
    [key],
  );
  const snapshot = useCallback(
    () => (key ? (key.split(',') as DbTopic[]) : []).reduce((sum, t) => sum + versions[t], 0),
    [key],
  );
  return useSyncExternalStore(sub, snapshot);
}
