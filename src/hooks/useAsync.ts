import { useCallback, useEffect, useState } from 'react';
import type { AppError, Result } from '@/domain/types';
import { toAppError } from '@/domain/result';

export interface AsyncState<T> { data: T | undefined; loading: boolean; error: AppError | null; reload: () => void }

interface Settled<T> { deps: readonly unknown[]; tick: number; data: T | undefined; error: AppError | null }

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/** Runs `fn` on mount and whenever deps change; ignores stale results; maps rejections with toAppError.
 *  The previous data stays available while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  return useAsyncResult(async () => ({ ok: true as const, value: await fn() }), deps);
}

export function useAsyncResult<T>(fn: () => Promise<Result<T>>, deps: readonly unknown[]): AsyncState<T> {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    let stale = false;
    const runDeps = deps;
    const runTick = tick;
    Promise.resolve()
      .then(fn)
      .then(
        (r) => {
          if (stale) return;
          setSettled((prev) =>
            r.ok
              ? { deps: runDeps, tick: runTick, data: r.value, error: null }
              : { deps: runDeps, tick: runTick, data: prev?.data, error: r.error },
          );
        },
        (e: unknown) => {
          if (stale) return;
          setSettled((prev) => ({ deps: runDeps, tick: runTick, data: prev?.data, error: toAppError(e) }));
        },
      );
    return () => {
      stale = true;
    };
    // `fn` is intentionally not a dependency: callers pass an inline closure and list what it reads in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = settled !== null && settled.tick === tick && sameDeps(settled.deps, deps);
  return {
    data: settled?.data,
    loading: !current,
    error: current ? settled.error : null,
    reload,
  };
}
