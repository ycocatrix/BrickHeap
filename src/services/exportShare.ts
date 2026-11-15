// EX_18: builds the export file in the cache directory and opens the system share sheet.
import { File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import type { ExportFormat, ListId, Result } from '@/domain/types';
import { err, ok, toAppError } from '@/domain/result';
import { utf8Encode } from '@/domain/utf8';
import { exportFileName, toBricklinkXml, toCsv, toExportRows, toJson } from '@/domain/inventory/export';
import { getItems } from '@/data/inventoryRepo';
import { inventory as t } from '@/i18n/fr/inventory';

const TYPES: Record<ExportFormat, { mimeType: string; UTI: string }> = {
  csv: { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' },
  json: { mimeType: 'application/json', UTI: 'public.json' },
  bricklink_xml: { mimeType: 'application/xml', UTI: 'public.xml' },
};

/** Never rejects. err('invalid') when there is nothing to export (or, for BrickLink XML, no row has a BrickLink
 *  colour); err('unknown') when sharing is unavailable. `rows` = lines written (merged items for XML). */
export async function shareExport(format: ExportFormat, listId: ListId | null):
  Promise<Result<{ rows: number; skipped: number }>> {
  try {
    const items = await getItems(listId);
    const rows = toExportRows(items);
    if (rows.length === 0) return err('invalid', t.errors.nothingToExport);

    let content: string;
    let written: number;
    let skipped = 0;
    if (format === 'csv') {
      content = toCsv(rows);
      written = rows.length;
    } else if (format === 'json') {
      content = toJson(rows, new Date().toISOString());
      written = rows.length;
    } else {
      const xml = toBricklinkXml(rows);
      if (xml.items === 0) return err('invalid', t.errors.noBricklinkColor);
      content = xml.xml;
      written = xml.items;
      skipped = xml.skipped.length;
    }

    if (!(await isAvailableAsync())) return err('unknown', t.errors.sharingUnavailable);

    const listName = listId === null ? null : items[0]?.listName ?? null;
    const file = new File(Paths.cache, exportFileName(format, listName, new Date()));
    file.create({ overwrite: true });
    await file.write(utf8Encode(content));
    await shareAsync(file.uri, { ...TYPES[format], dialogTitle: t.export.dialogTitle });
    return ok({ rows: written, skipped });
  } catch (e) {
    const error = toAppError(e);
    return { ok: false, error };
  }
}
