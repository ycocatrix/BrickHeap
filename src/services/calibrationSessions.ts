// Calibration sessions on disk (WP7, §4.9, EX_11): Paths.document/calibration/<id>.json. Nothing leaves the device
// unless the user taps « Partager ». The JSON holds no image and no personal data.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { CalibrationSession, Result } from '@/domain/types';
import { err, ok } from '@/domain/result';
import { calibration } from '@/i18n/fr/calibration';

export interface SavedCalibrationSession {
  id: string;
  createdAt: string;
  uri: string;
  /** Read from the file; null when unreadable (extra fields, compatible with the §4.9 contract). */
  precision: number | null;
  recall: number | null;
}

const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

function sessionsDir(): Directory {
  return new Directory(Paths.document, 'calibration');
}

export async function saveCalibrationSession(session: CalibrationSession): Promise<Result<{ uri: string }>> {
  try {
    const dir = sessionsDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${safeId(session.id)}.json`);
    if (!file.exists) file.create({ intermediates: true });
    await file.write(JSON.stringify(session, null, 2));
    return ok({ uri: file.uri });
  } catch (e) {
    return err('unknown', calibration.errors.saveFailed, e);
  }
}

/** Newest first. Never rejects (an unreadable directory gives an empty list). */
export async function listCalibrationSessions(): Promise<SavedCalibrationSession[]> {
  try {
    const dir = sessionsDir();
    if (!dir.exists) return [];
    const files = dir.list().filter((f): f is File => f instanceof File && f.name.endsWith('.json'));
    const rows = await Promise.all(
      files.map(async (f): Promise<SavedCalibrationSession> => {
        const id = f.name.slice(0, -'.json'.length);
        try {
          const s = JSON.parse(await f.text()) as Partial<CalibrationSession>;
          return {
            id: typeof s.id === 'string' ? s.id : id,
            createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
            uri: f.uri,
            precision: typeof s.metrics?.precision === 'number' ? s.metrics.precision : null,
            recall: typeof s.metrics?.recall === 'number' ? s.metrics.recall : null,
          };
        } catch {
          return { id, createdAt: '', uri: f.uri, precision: null, recall: null };
        }
      }),
    );
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  } catch {
    return [];
  }
}

/** Never rejects; a missing file is not an error. */
export async function deleteCalibrationSession(id: string): Promise<void> {
  try {
    const file = new File(sessionsDir(), `${safeId(id)}.json`);
    if (file.exists) file.delete();
  } catch {
    // nothing to do
  }
}

/** expo-sharing, user-initiated. */
export async function shareCalibrationSession(uri: string): Promise<Result<void>> {
  try {
    if (!(await Sharing.isAvailableAsync())) return err('unknown', calibration.errors.shareUnavailable);
    await Sharing.shareAsync(uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: calibration.title });
    return ok(undefined);
  } catch (e) {
    return err('unknown', calibration.errors.shareFailed, e);
  }
}
