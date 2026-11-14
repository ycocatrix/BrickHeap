import type { SetRef } from '../../types';
import {
  categoryLabel, designId, filterSets, parseDimensions, partLabel, pickABrickUrl, provisionalPart, setYears,
} from '../partInfo';

describe('parseDimensions', () => {
  it('parses a brick', () => {
    expect(parseDimensions('Brick 2 x 4')).toEqual({ label: '2 × 4', studsX: '2', studsY: '4', height: null });
  });
  it('parses three dimensions', () => {
    expect(parseDimensions('Panel 4 x 4 x 6 Quarter Cylinder')).toEqual({ label: '4 × 4 × 6', studsX: '4', studsY: '4', height: '6' });
  });
  it('parses a mixed-fraction height', () => {
    expect(parseDimensions('Vehicle Base, Trailer 8 x 30 x 3 1/3'))
      .toEqual({ label: '8 × 30 × 3 1/3', studsX: '8', studsY: '30', height: '3 1/3' });
  });
  it('ignores the slope angle and parses a fractional height', () => {
    expect(parseDimensions('Slope 30° 1 x 1 x 2/3')).toEqual({ label: '1 × 1 × 2/3', studsX: '1', studsY: '1', height: '2/3' });
  });
  it('returns null for a Technic pin', () => {
    expect(parseDimensions('Technic Pin with Friction Ridges Lengthwise')).toBeNull();
  });
});

describe('designId', () => {
  it('prefers the legoIds entry equal to the numeric root', () => {
    expect(designId({ partId: '3062b', legoIds: ['3062', '30068'] })).toBe('3062');
  });
  it('falls back to legoIds[0], then to the part id', () => {
    expect(designId({ partId: '6141', legoIds: ['4073', '30057'] })).toBe('4073');
    expect(designId({ partId: '3001special', legoIds: [] })).toBe('3001special');
  });
});

describe('pickABrickUrl', () => {
  const base = 'https://www.lego.com/fr-fr/pick-and-build/pick-a-brick?query=';
  it('uses the last element id when known', () => {
    expect(pickABrickUrl({ partId: '3001', legoIds: ['3001'] }, ['300121', '4113915'])).toBe(`${base}4113915`);
  });
  it('uses the design id otherwise', () => {
    expect(pickABrickUrl({ partId: '3001', legoIds: ['3001'] })).toBe(`${base}3001`);
    expect(pickABrickUrl({ partId: '3001', legoIds: ['3001'] }, [])).toBe(`${base}3001`);
  });
  it('URI-encodes the query', () => {
    expect(pickABrickUrl({ partId: '973pr1 a&b', legoIds: [] })).toBe(`${base}973pr1%20a%26b`);
  });
});

describe('filterSets / setYears', () => {
  const sets: SetRef[] = [
    { setNum: '10018-1', name: 'Darth Maul', year: 2001, numParts: 1868, imageUrl: null },
    { setNum: '6080-1', name: 'King’s Castle', year: 1984, numParts: 674, imageUrl: null },
    { setNum: '21318-1', name: 'Cabane dans l’arbre Été', year: 2019, numParts: 3036, imageUrl: null },
    { setNum: '75192-1', name: 'Millennium Falcon', year: 2019, numParts: 7541, imageUrl: null },
  ];
  it('matches name case- and diacritics-insensitively', () => {
    expect(filterSets(sets, { query: 'ete', year: null }).map((s) => s.setNum)).toEqual(['21318-1']);
    expect(filterSets(sets, { query: 'DARTH', year: null }).map((s) => s.setNum)).toEqual(['10018-1']);
  });
  it('matches set numbers and years', () => {
    expect(filterSets(sets, { query: '6080', year: null }).map((s) => s.setNum)).toEqual(['6080-1']);
    expect(filterSets(sets, { query: '', year: 2019 }).map((s) => s.setNum)).toEqual(['21318-1', '75192-1']);
    expect(filterSets(sets, { query: 'falcon', year: 2001 })).toEqual([]);
    expect(filterSets(sets, { query: '  ', year: null })).toHaveLength(4);
  });
  it('lists distinct years, descending', () => {
    expect(setYears(sets)).toEqual([2019, 2001, 1984]);
    expect(setYears([])).toEqual([]);
  });
});

describe('partLabel', () => {
  it('translates leading words and the × sign', () => {
    expect(partLabel('Brick 2 x 4')).toBe('Brique 2 × 4');
    expect(partLabel('Plate Round 1 x 1')).toBe('Plaque ronde 1 × 1');
    expect(partLabel('Slope 45 2 x 1')).toBe('Pente 45 2 × 1');
    expect(partLabel('Tile 1 x 2 with Groove')).toBe('Tuile 1 × 2 with Groove');
  });
  it('matches whole words only', () => {
    expect(partLabel('Bricklink Special')).toBe('Bricklink Special');
    expect(partLabel('Plate, Modified 1 x 2')).toBe('Plaque, Modified 1 × 2');
  });
  it('keeps an unmapped name unchanged', () => {
    expect(partLabel('Technic Pin')).toBe('Technic Pin');
    expect(partLabel('Minifig Head')).toBe('Minifig Head');
    expect(partLabel('Animal Horse')).toBe('Animal Horse');
  });
});

describe('categoryLabel', () => {
  it('uses the French name for a known id', () => {
    expect(categoryLabel(11, 'Bricks')).toBe('Briques');
    expect(categoryLabel(14, null)).toBe('Plaques');
  });
  it('falls back to the Rebrickable name, then null', () => {
    expect(categoryLabel(9999, 'Mystery')).toBe('Mystery');
    expect(categoryLabel(9999, null)).toBeNull();
    expect(categoryLabel(null, 'Bricks')).toBe('Bricks');
    expect(categoryLabel(null, null)).toBeNull();
  });
});

describe('provisionalPart', () => {
  it('builds a provisional part from a Brickognize candidate', () => {
    const c = { bricklinkId: '3062', name: 'Brick, Round 1 x 1', imageUrl: 'https://img/3062.png' };
    expect(provisionalPart(c, 'pending')).toEqual({
      partId: '3062', name: 'Brick, Round 1 x 1', categoryId: null, imageUrl: 'https://img/3062.png',
      bricklinkIds: ['3062'], legoIds: [], printOf: null, yearFrom: null, yearTo: null,
      source: 'brickognize', resolution: 'pending',
    });
    expect(provisionalPart({ ...c, imageUrl: null }, 'not_found')).toMatchObject({ resolution: 'not_found', imageUrl: null });
  });
});
