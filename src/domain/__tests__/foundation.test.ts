import { itemKey, parseItemKey, sameRef } from '@/domain/keys';
import { err, ok, toAppError } from '@/domain/result';
import { utf8Decode, utf8Encode } from '@/domain/utf8';
import { fmtBadge, fmtCount, fmtPercent, plural, tpl } from '@/i18n/format';
import { colorLabel } from '@/i18n/fr/colors';
import { common } from '@/i18n/fr/common';
import { createStore } from '@/state/createStore';
import { toSessionUser } from '@/state/session';

jest.mock('@/services/kv', () => ({
  kv: { getString: () => null, setString: () => {}, remove: () => {}, getJson: <T>(_k: string, f: T) => f, setJson: () => {} },
}));
jest.mock('@/services/supabase', () => ({ supabase: null, registerAutoRefresh: () => {} }));

describe('keys', () => {
  it('round-trips item keys', () => {
    expect(itemKey('3001', 4)).toBe('3001|4');
    expect(parseItemKey(itemKey('3001', 4))).toEqual({ partId: '3001', colorId: 4 });
    expect(parseItemKey(itemKey('973pr1|x', 0))).toEqual({ partId: '973pr1|x', colorId: 0 });
    expect(parseItemKey('3001')).toBeNull();
    expect(parseItemKey('3001|red')).toBeNull();
  });
  it('compares refs', () => {
    expect(sameRef({ listId: 'a', partId: 'p', colorId: 1 }, { listId: 'a', partId: 'p', colorId: 1 })).toBe(true);
    expect(sameRef({ listId: 'a', partId: 'p', colorId: 1 }, { listId: 'a', partId: 'p', colorId: 2 })).toBe(false);
  });
});

describe('result', () => {
  it('builds values', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
    expect(err('invalid', 'x')).toEqual({ ok: false, error: { code: 'invalid', message: 'x' } });
  });
  it('maps errors', () => {
    expect(toAppError(new TypeError('Network request failed')).code).toBe('offline');
    expect(toAppError(new TypeError('Network request failed')).message).toBe(common.errors.offline);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(toAppError(abort).code).toBe('timeout');
    expect(toAppError(null, 401).code).toBe('unauthorized');
    expect(toAppError(null, 403).code).toBe('unauthorized');
    expect(toAppError(null, 404).code).toBe('not_found');
    expect(toAppError(null, 429).code).toBe('rate_limited');
    expect(toAppError(null, 500).code).toBe('server');
    expect(toAppError(null, 418).code).toBe('unknown');
    expect(toAppError(new Error('boom')).code).toBe('unknown');
    const app = { code: 'invalid' as const, message: 'Nom requis' };
    expect(toAppError(app)).toBe(app);
  });
});

describe('format', () => {
  it('plural (French rule)', () => {
    expect(plural(0, 'pièce', 'pièces')).toBe('pièce');
    expect(plural(1, 'pièce', 'pièces')).toBe('pièce');
    expect(plural(2, 'pièce', 'pièces')).toBe('pièces');
  });
  it('fmtBadge', () => {
    expect(fmtBadge(7)).toBe('7');
    expect(fmtBadge(99)).toBe('99');
    expect(fmtBadge(100)).toBe('99+');
  });
  it('fmtPercent', () => {
    expect(fmtPercent(0.923)).toBe('92 %');
    expect(fmtPercent(1)).toBe('100 %');
    expect(fmtPercent(0)).toBe('0 %');
  });
  it('tpl', () => {
    expect(tpl('{n} pièces ajoutées à {liste}', { n: 3, liste: 'Mon inventaire' })).toBe('3 pièces ajoutées à Mon inventaire');
    expect(tpl('{a} {missing}', { a: 1 })).toBe('1 {missing}');
  });
  it('fmtCount', () => {
    expect(fmtCount(1234)).toBe('1 234');
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(1234567)).toBe('1 234 567');
  });
});

describe('createStore', () => {
  it('merges, applies functional sets and notifies subscribers', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = jest.fn();
    const off = store.subscribe(listener);
    store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: 'x' });
    store.set((s) => ({ a: s.a + 1 }));
    expect(store.get()).toEqual({ a: 3, b: 'x' });
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.set({ b: 'y' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('colorLabel', () => {
  it('uses the French name, else the Rebrickable name', () => {
    expect(colorLabel({ colorId: 4, name: 'Red' })).toBe('Rouge');
    expect(colorLabel({ colorId: 1103, name: 'Pearl Titanium' })).toBe('Pearl Titanium');
    expect(colorLabel(null)).toBe('—');
  });
});

describe('utf8', () => {
  const roundTrip = (s: string) => expect(utf8Decode(utf8Encode(s))).toBe(s);
  it('round-trips', () => {
    roundTrip('hello world');
    roundTrip('Élodie — pièce ½');
    roundTrip('brique 🧱 ok');
    const big = JSON.stringify({ access_token: 'x'.repeat(2000), user: { email: 'é@exemple.fr', meta: 'à'.repeat(1000) } });
    expect(big.length).toBeGreaterThan(3000);
    roundTrip(big);
  });
  it('encodes é as C3 A9 and an emoji as 4 bytes', () => {
    expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8Encode('🧱'))).toEqual([0xf0, 0x9f, 0xa7, 0xb1]);
  });
  it('replaces invalid sequences with U+FFFD', () => {
    expect(utf8Decode(Uint8Array.from([0x61, 0xff, 0x62]))).toBe('a�b');
    expect(utf8Decode(Uint8Array.from([0xc3]))).toBe('�');
  });
});

describe('toSessionUser', () => {
  it('reads id, email and pseudo', () => {
    expect(toSessionUser({ user: { id: 'u1', email: 'a@b.fr', user_metadata: { pseudo: 'Lou' } } })).toEqual({
      id: 'u1', email: 'a@b.fr', pseudo: 'Lou',
    });
    expect(toSessionUser({ user: { id: 'u1', email: 'a@b.fr' } })).toEqual({ id: 'u1', email: 'a@b.fr', pseudo: null });
    expect(toSessionUser({ user: { id: 'u1', email: null, user_metadata: { pseudo: 42 } } })).toEqual({
      id: 'u1', email: '', pseudo: null,
    });
  });
});
