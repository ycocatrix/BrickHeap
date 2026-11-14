// Rebrickable API client for Edge Functions (Deno). The key lives only in the function secret
// REBRICKABLE_API_KEY and is sent as `Authorization: key …` (never `?key=`). Never logged.
const RB = "https://rebrickable.com/api/v3/lego";
const SPACING_MS = 1100;
let last = 0;

export class UpstreamError extends Error {
  constructor(public status: number) {
    super(`rebrickable ${status}`);
  }
}

/** Sequential, spaced GET (≥ 1100 ms between two calls of this isolate). `path` is relative to /api/v3/lego.
 *  Returns null on 404, throws UpstreamError on any other non-2xx or network failure. */
// deno-lint-ignore no-explicit-any
export async function rb(path: string): Promise<any | null> {
  const wait = last + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  let r: Response;
  try {
    r = await fetch(RB + path, {
      headers: { Authorization: `key ${Deno.env.get("REBRICKABLE_API_KEY") ?? ""}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UpstreamError(0);
  }
  if (r.status === 404) {
    await r.body?.cancel();
    return null;
  }
  if (!r.ok) {
    await r.body?.cancel();
    throw new UpstreamError(r.status);
  }
  return await r.json();
}

/** Follows an absolute `next` URL returned by Rebrickable (same host only). */
// deno-lint-ignore no-explicit-any
export async function rbNext(nextUrl: string): Promise<any | null> {
  if (!nextUrl.startsWith(RB)) throw new UpstreamError(0);
  return await rb(nextUrl.slice(RB.length));
}
