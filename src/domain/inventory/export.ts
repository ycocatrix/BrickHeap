// Pure export builders (WP6, EX_18): CSV, JSON, BrickLink XML (wanted list) and file names.
import type { ColorId, ExportFormat, InventoryRow, PartId } from '../types';
import { fold } from './inventory';

export interface ExportRow {
  listName: string; partId: PartId; partName: string; colorId: ColorId; colorName: string;
  colorHex: string; quantity: number; bricklinkItemId: string; bricklinkColorId: number | null;
}

/** One row per inventory row with quantity > 0, in input order. bricklinkItemId = part.bricklinkIds[0] ?? partId;
 *  colorName = Rebrickable (English) name; missing catalogue text → '', missing BrickLink colour → null. */
export function toExportRows(rows: readonly InventoryRow[]): ExportRow[] {
  return rows
    .filter((r) => r.quantity > 0)
    .map((r) => ({
      listName: r.listName,
      partId: r.partId,
      partName: r.part?.name ?? '',
      colorId: r.colorId,
      colorName: r.color?.name ?? '',
      colorHex: r.color?.hex ?? '',
      quantity: r.quantity,
      bricklinkItemId: r.part?.bricklinkIds[0] ?? r.partId,
      bricklinkColorId: r.color?.bricklinkId ?? null,
    }));
}

export const CSV_HEADER =
  'list,part_id,part_name,color_id,color_name,color_hex,quantity,bricklink_item_id,bricklink_color_id';

function csvField(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with BOM (the caller encodes the string as UTF-8), CRLF line ends (including after the last record),
 *  RFC 4180 quoting. */
export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push([
      r.listName, r.partId, r.partName, r.colorId, r.colorName, r.colorHex, r.quantity, r.bricklinkItemId,
      r.bricklinkColorId,
    ].map(csvField).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** { "app": "BrickHeap", "version": 1, "exportedAt": iso, "items": ExportRow[] }, 2-space indent. */
export function toJson(rows: readonly ExportRow[], exportedAt: string): string {
  return JSON.stringify({ app: 'BrickHeap', version: 1, exportedAt, items: rows }, null, 2);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** BrickLink wanted-list XML. Rows are merged by (bricklinkItemId, bricklinkColorId) across lists (quantities
 *  summed, first-appearance order). Rows whose colour has no BrickLink id are returned in `skipped`. */
export function toBricklinkXml(rows: readonly ExportRow[]): { xml: string; skipped: ExportRow[]; items: number } {
  const merged = new Map<string, { itemId: string; colorId: number; qty: number }>();
  const skipped: ExportRow[] = [];
  for (const r of rows) {
    if (r.bricklinkColorId === null) {
      skipped.push(r);
      continue;
    }
    const k = `${r.bricklinkItemId}\u0000${r.bricklinkColorId}`;
    const m = merged.get(k);
    if (m) m.qty += r.quantity;
    else merged.set(k, { itemId: r.bricklinkItemId, colorId: r.bricklinkColorId, qty: r.quantity });
  }
  const lines = ['<INVENTORY>'];
  for (const m of merged.values()) {
    lines.push(
      `<ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>${xmlEscape(m.itemId)}</ITEMID>`
      + `<COLOR>${m.colorId}</COLOR><MINQTY>${m.qty}</MINQTY></ITEM>`,
    );
  }
  lines.push('</INVENTORY>');
  return { xml: lines.join('\n') + '\n', skipped, items: merged.size };
}

const EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', json: 'json', bricklink_xml: 'xml' };

function slug(s: string): string {
  const out = fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return out || 'liste';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'brickheap-<slug(list name or "tout")>-<YYYYMMDD>.<csv|json|xml>' — ASCII slug, local date. */
export function exportFileName(format: ExportFormat, listName: string | null, date: Date): string {
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `brickheap-${slug(listName ?? 'tout')}-${ymd}.${EXTENSIONS[format]}`;
}
