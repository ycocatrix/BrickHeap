// Behaviour of src/services/catalog.ts with the database and the proxy mocked (acceptance checks of WP5).
import type { CatalogPart } from '../../types';

const mockInvoke = jest.fn();
jest.mock('@/services/supabase', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => mockInvoke(...a) } } }));
jest.mock('@/data/catalogRepo', () => ({
  readPalette: jest.fn(async () => ({ colors: [], categories: [] })),
  writePalette: jest.fn(async () => undefined),
  getBlMap: jest.fn(async () => new Map()),
  getPartRows: jest.fn(async () => new Map()),
  getPartRow: jest.fn(async () => null),
  saveBricklinkResolutions: jest.fn(async () => undefined),
  saveProvisionalParts: jest.fn(async () => true),
  saveParts: jest.fn(async () => undefined),
  markRebrickableNotFound: jest.fn(async () => undefined),
  replaceProvisional: jest.fn(async () => undefined),
  getPartColor: jest.fn(async () => null),
  savePartColors: jest.fn(async () => undefined),
  missingPartColors: jest.fn(async () => []),
}));
jest.mock('@/data/meta', () => ({ getMeta: jest.fn(async () => new Date().toISOString()) }));
jest.mock('@/data/dbEvents', () => ({ notify: jest.fn() }));
jest.mock('@/data/inventoryRepo', () => ({ renamePart: jest.fn(async () => undefined) }));

/* eslint-disable import/first */
import * as repo from '@/data/catalogRepo';
import { renamePart } from '@/data/inventoryRepo';
import {
  getPalette, getPartDetail, hydrateParts, resetCatalogBreaker, resolveCandidates,
} from '@/services/catalog';
/* eslint-enable import/first */

const mocked = repo as jest.Mocked<typeof repo>;
const wirePart = (id: string) => ({
  part_id: id, name: `Part ${id}`, part_cat_id: 11, image_url: null, bricklink_ids: [id], lego_ids: [],
  print_of: null, year_from: 2000, year_to: 2020,
});
const rebrickable = (id: string): CatalogPart => ({
  partId: id, name: id, categoryId: 11, imageUrl: null, bricklinkIds: [], legoIds: [], printOf: null, yearFrom: null,
  yearTo: null, source: 'rebrickable', resolution: 'resolved',
});

beforeEach(() => {
  jest.clearAllMocks();
  resetCatalogBreaker();
});

describe('resolveCandidates', () => {
  const cands = [
    { bricklinkId: '3001', name: 'Brick 2 x 4', imageUrl: 'a' },
    { bricklinkId: '3062', name: 'Brick, Round 1 x 1', imageUrl: 'b' },
    { bricklinkId: '3001special', name: 'Special', imageUrl: null },
  ];

  it('returns pending provisional parts when the proxy is unreachable, then skips it (circuit breaker)', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: Object.assign(new Error('Failed to send a request'), { name: 'FunctionsFetchError' }) });
    const out = await resolveCandidates(cands);
    expect([...out.keys()]).toEqual(['3001', '3062', '3001special']);
    for (const p of out.values()) expect(p).toMatchObject({ source: 'brickognize', resolution: 'pending' });
    expect(out.get('3062')?.partId).toBe('3062');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mocked.saveProvisionalParts).toHaveBeenCalledTimes(1);

    await resolveCandidates(cands);
    expect(mockInvoke).toHaveBeenCalledTimes(1); // breaker open for 5 minutes
  });

  it('maps found / not_found and re-requests pending ids', async () => {
    jest.useFakeTimers();
    try {
      mockInvoke
        .mockResolvedValueOnce({ data: { parts: {
          '3001': { status: 'found', part: wirePart('3001') },
          '3062': { status: 'pending' },
          '3001special': { status: 'not_found' } }, stale: false }, error: null })
        .mockResolvedValueOnce({ data: { parts: { '3062': { status: 'found', part: wirePart('3062b') } }, stale: false }, error: null });
      const promise = resolveCandidates(cands);
      await jest.advanceTimersByTimeAsync(2000);
      const out = await promise;
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockInvoke.mock.calls[1][1].body).toEqual({ op: 'parts', id_type: 'bricklink', ids: ['3062'] });
      expect(out.get('3001')).toMatchObject({ partId: '3001', source: 'rebrickable', resolution: 'resolved' });
      expect(out.get('3062')).toMatchObject({ partId: '3062b', source: 'rebrickable' });
      expect(out.get('3001special')).toMatchObject({ partId: '3001special', source: 'brickognize', resolution: 'not_found' });
      expect(mocked.saveBricklinkResolutions).toHaveBeenCalledWith(
        [expect.objectContaining({ bricklinkId: '3001' }), expect.objectContaining({ bricklinkId: '3062' })],
        ['3001special'], expect.any(String));
    } finally {
      jest.useRealTimers();
    }
  });

  it('answers from a fresh local BrickLink map without calling the proxy', async () => {
    const now = new Date().toISOString();
    mocked.getBlMap.mockResolvedValueOnce(new Map([['4073', { bricklinkId: '4073', partId: '6141', fetchedAt: now }]]));
    mocked.getPartRows.mockResolvedValueOnce(new Map([['6141', { part: rebrickable('6141'), fetchedAt: now }]]));
    const out = await resolveCandidates([{ bricklinkId: '4073', name: 'Plate Round 1 x 1', imageUrl: null }]);
    expect(out.get('4073')?.partId).toBe('6141');
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('hydrateParts', () => {
  it('asks the proxy at most once per 7 days for an id answered not_found', async () => {
    mockInvoke.mockResolvedValue({ data: { parts: { zz1: { status: 'not_found' } }, stale: false }, error: null });
    await hydrateParts(['zz1']);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mocked.markRebrickableNotFound).toHaveBeenCalledWith(['zz1'], expect.any(String));

    const placeholder: CatalogPart = { ...rebrickable('zz1'), source: 'brickognize', resolution: 'not_found' };
    mocked.getPartRows.mockResolvedValueOnce(new Map([['zz1', { part: placeholder, fetchedAt: new Date().toISOString() }]]));
    await hydrateParts(['zz1']);
    expect(mockInvoke).toHaveBeenCalledTimes(1); // negative cache still fresh

    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    mocked.getPartRows.mockResolvedValueOnce(new Map([['zz1', { part: placeholder, fetchedAt: old }]]));
    await hydrateParts(['zz1']);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('renames a pending provisional part resolved to another part_num', async () => {
    const pending: CatalogPart = { ...rebrickable('3062'), source: 'brickognize', resolution: 'pending' };
    mocked.getPartRows.mockResolvedValueOnce(new Map([['3062', { part: pending, fetchedAt: new Date().toISOString() }]]));
    mockInvoke.mockResolvedValueOnce({ data: { parts: { '3062': { status: 'found', part: wirePart('3062b') } }, stale: false }, error: null });
    await hydrateParts(['3062']);
    expect(mockInvoke.mock.calls[0][1].body).toEqual({ op: 'parts', id_type: 'bricklink', ids: ['3062'] });
    expect(renamePart).toHaveBeenCalledWith('3062', '3062b');
    expect(mocked.replaceProvisional).toHaveBeenCalledWith('3062', expect.objectContaining({ partId: '3062b' }), expect.any(String));
  });
});

describe('getPartDetail / getPalette', () => {
  it('refuses provisional parts without a network call', async () => {
    mocked.getPartRow.mockResolvedValueOnce({ ...rebrickable('3001special'), source: 'brickognize', resolution: 'not_found' });
    const r = await getPartDetail('3001special', 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('returns an error (sets) when the proxy fails, and the seed palette when the tables are empty', async () => {
    mockInvoke.mockResolvedValue({ data: null, error: Object.assign(new Error('x'), { name: 'FunctionsFetchError' }) });
    const r = await getPartDetail('3001', 4);
    expect(r.ok).toBe(false);
    const palette = await getPalette();
    expect(palette.colors.length).toBeGreaterThanOrEqual(270);
    expect(palette.byBricklinkId.get(77)?.colorId).toBe(148);
  });
});
