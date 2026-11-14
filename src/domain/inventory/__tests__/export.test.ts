import type { CatalogColor, CatalogPart, InventoryRow } from '../../types';
import {
  CSV_HEADER, exportFileName, toBricklinkXml, toCsv, toExportRows, toJson, type ExportRow,
} from '../export';

jest.mock('../../catalog/partInfo', () => ({
  partLabel: (name: string) => name,
  categoryLabel: (_id: number | null, fallback: string | null) => fallback,
}));

function er(patch: Partial<ExportRow>): ExportRow {
  return {
    listName: 'Mon inventaire', partId: '3001', partName: 'Brick 2 x 4', colorId: 4, colorName: 'Red',
    colorHex: 'C91A09', quantity: 3, bricklinkItemId: '3001', bricklinkColorId: 5, ...patch,
  };
}

describe('toExportRows', () => {
  const color: CatalogColor = { colorId: 4, name: 'Red', hex: 'C91A09', isTrans: false, bricklinkId: 5 };
  const part: CatalogPart = {
    partId: '3062b', name: 'Brick Round 1 x 1', categoryId: 20, imageUrl: null, bricklinkIds: ['3062', '3062b'],
    legoIds: [], printOf: null, yearFrom: null, yearTo: null, source: 'rebrickable', resolution: 'resolved',
  };
  const base = {
    listId: 'L1', updatedAt: '', listName: 'Vrac', imageUrl: null, coloredImage: false, categoryName: null,
  };

  it('maps catalogue data and falls back when it is missing', () => {
    const rows: InventoryRow[] = [
      { ...base, partId: '3062b', colorId: 4, quantity: 2, part, color },
      { ...base, partId: 'x123', colorId: 999, quantity: 1, part: null, color: null },
      { ...base, partId: 'zero', colorId: 1, quantity: 0, part: null, color: null },
    ];
    expect(toExportRows(rows)).toEqual([
      { listName: 'Vrac', partId: '3062b', partName: 'Brick Round 1 x 1', colorId: 4, colorName: 'Red',
        colorHex: 'C91A09', quantity: 2, bricklinkItemId: '3062', bricklinkColorId: 5 },
      { listName: 'Vrac', partId: 'x123', partName: '', colorId: 999, colorName: '', colorHex: '', quantity: 1,
        bricklinkItemId: 'x123', bricklinkColorId: null },
    ]);
  });
});

describe('toCsv', () => {
  it('starts with a BOM, uses CRLF and the header', () => {
    const csv = toCsv([er({})]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      CSV_HEADER,
      'Mon inventaire,3001,Brick 2 x 4,4,Red,C91A09,3,3001,5',
      '',
    ]);
    expect(CSV_HEADER).toBe(
      'list,part_id,part_name,color_id,color_name,color_hex,quantity,bricklink_item_id,bricklink_color_id');
  });

  it('quotes ", comma and newlines (RFC 4180) and writes null as empty', () => {
    const csv = toCsv([er({ listName: 'Projet "MOC", salon', partName: 'Ligne 1\nLigne 2', bricklinkColorId: null })]);
    expect(csv).toBe(
      '﻿' + CSV_HEADER + '\r\n' + '"Projet ""MOC"", salon",3001,"Ligne 1\nLigne 2",4,Red,C91A09,3,3001,\r\n');
  });

  it('keeps accents as is', () => {
    expect(toCsv([er({ listName: 'Élodie' })])).toContain('Élodie,3001');
  });
});

describe('toJson', () => {
  it('is parseable with the documented shape and count', () => {
    const rows = [er({}), er({ partId: '3003' })];
    const text = toJson(rows, '2026-11-15T10:00:00.000Z');
    const parsed = JSON.parse(text) as { app: string; version: number; exportedAt: string; items: ExportRow[] };
    expect(parsed).toEqual({ app: 'BrickHeap', version: 1, exportedAt: '2026-11-15T10:00:00.000Z', items: rows });
    expect(parsed.items).toHaveLength(2);
    expect(text).toContain('\n  "app": "BrickHeap"');
  });
});

describe('toBricklinkXml', () => {
  it('writes the exact structure for two rows', () => {
    const r = toBricklinkXml([er({}), er({ partId: '3020', bricklinkItemId: '3020', bricklinkColorId: 7, quantity: 12 })]);
    expect(r.xml).toBe(
      '<INVENTORY>\n'
      + '<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>3001</ITEMID><COLOR>5</COLOR><MINQTY>3</MINQTY></ITEM>\n'
      + '<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>3020</ITEMID><COLOR>7</COLOR><MINQTY>12</MINQTY></ITEM>\n'
      + '</INVENTORY>\n');
    expect(r.skipped).toEqual([]);
    expect(r.items).toBe(2);
  });

  it('escapes & and <', () => {
    const r = toBricklinkXml([er({ bricklinkItemId: 'a&b<c>' })]);
    expect(r.xml).toContain('<ITEMID>a&amp;b&lt;c&gt;</ITEMID>');
  });

  it('merges the same BrickLink key from two lists', () => {
    const r = toBricklinkXml([er({ listName: 'A', quantity: 2 }), er({ listName: 'B', quantity: 5 })]);
    expect(r.items).toBe(1);
    expect(r.xml).toContain('<MINQTY>7</MINQTY>');
  });

  it('returns colours without BrickLink id in skipped', () => {
    const noBl = er({ partId: '3003', bricklinkItemId: '3003', bricklinkColorId: null });
    const r = toBricklinkXml([er({}), noBl]);
    expect(r.skipped).toEqual([noBl]);
    expect(r.xml).not.toContain('3003');
    expect(r.items).toBe(1);
  });
});

describe('exportFileName', () => {
  const date = new Date(2026, 10, 5, 12, 0, 0);
  it('slugs the list name and formats the date', () => {
    expect(exportFileName('csv', 'Vrac Salon', date)).toBe('brickheap-vrac-salon-20261105.csv');
    expect(exportFileName('json', 'Projet « Élodie » ½ !', date)).toBe('brickheap-projet-elodie-20261105.json');
    expect(exportFileName('bricklink_xml', null, date)).toBe('brickheap-tout-20261105.xml');
    expect(exportFileName('csv', '★★★', date)).toBe('brickheap-liste-20261105.csv');
  });
});
