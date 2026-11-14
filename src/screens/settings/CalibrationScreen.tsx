// Calibration mode (EX_10 / EX_11, §7.1). Compares the last raw Inventorier capture (scanStore.lastResult, before
// any user correction) with an expected list, and saves/shares the session JSON (no image, no personal data).
import { useMemo, useState, type ReactElement } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Icon, type IconName } from '@/components/Icon';
import { EmptyState } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import type { AppError, CalibrationMetrics, CalibrationRow, CountedLine, ScanResult } from '@/domain/types';
import { buildCalibrationSession, computeMetrics, countDetected, parseExpected } from '@/domain/pile/calibration';
import { useAsync } from '@/hooks/useAsync';
import { fmtPercent, tpl } from '@/i18n/format';
import { calibration as t } from '@/i18n/fr/calibration';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import {
  deleteCalibrationSession,
  listCalibrationSessions,
  saveCalibrationSession,
  shareCalibrationSession,
  type SavedCalibrationSession,
} from '@/services/calibrationSessions';
import { useStore } from '@/state/createStore';
import { scanStore } from '@/state/scanStore';
import { goBack } from '@/screens/auth/authUi';
import { colors, font, radius, spacing } from '@/theme';

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function refLabel(row: Pick<CalibrationRow, 'partId' | 'colorId'>): string {
  return row.colorId == null ? `${row.partId} (${t.table.anyColor})` : `${row.partId}/${row.colorId}`;
}

function rowStatus(row: CalibrationRow): { icon: IconName; text: string; color: string } {
  if (row.detected === row.expected) return { icon: 'checkmark', text: t.table.equal, color: colors.ok };
  if (row.detected > row.expected) return { icon: 'arrow-up', text: t.table.tooMany, color: colors.warn };
  return { icon: 'arrow-down', text: t.table.missing, color: colors.error };
}

function Stat(p: { label: string; value: string }): ReactElement {
  return (
    <View style={s.stat} accessible accessibilityLabel={`${p.label} : ${p.value}`}>
      <Text style={s.statLabel}>{p.label}</Text>
      <Text style={s.statValue}>{p.value}</Text>
    </View>
  );
}

function LastScanCard(p: { result: ScanResult }): ReactElement {
  const ms = (n: number): string => tpl(t.lastScan.ms, { n: Math.round(n) });
  const tm = p.result.timings;
  return (
    <View style={s.card}>
      <Text style={s.h2} accessibilityRole="header">
        {t.lastScan.title}
      </Text>
      <Stat label={t.lastScan.boxes} value={String(p.result.pieces.length)} />
      <Stat label={t.lastScan.background} value={t.background[p.result.background]} />
      {p.result.wholeImage ? <Text style={s.muted}>{t.lastScan.wholeImage}</Text> : null}
      <Stat label={t.lastScan.prepare} value={ms(tm.prepareMs)} />
      <Stat label={t.lastScan.segment} value={ms(tm.segmentMs)} />
      <Stat label={t.lastScan.identify} value={ms(tm.identifyMs)} />
      <Stat label={t.lastScan.catalog} value={ms(tm.catalogMs)} />
      <Stat label={t.lastScan.total} value={ms(tm.totalMs)} />
      <Stat label={t.lastScan.calls} value={String(tm.brickognizeCalls)} />
    </View>
  );
}

function ComparisonTable(p: { metrics: CalibrationMetrics }): ReactElement {
  const m = p.metrics;
  return (
    <View style={s.card}>
      <Text style={s.h2} accessibilityRole="header">
        {t.table.title}
      </Text>
      <View style={[s.tr, s.thead]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={[s.th, s.colRef]}>{t.table.reference}</Text>
        <Text style={[s.th, s.colNum]}>{t.table.expected}</Text>
        <Text style={[s.th, s.colNum]}>{t.table.detected}</Text>
        <Text style={[s.th, s.colDiff]}>{t.table.diff}</Text>
      </View>
      {m.rows.map((row) => {
        const st = rowStatus(row);
        const diff = row.detected - row.expected;
        const ref = refLabel(row);
        return (
          <View
            key={`${row.partId}|${row.colorId ?? '?'}`}
            style={s.tr}
            accessible
            accessibilityLabel={tpl(t.table.rowLabel, {
              ref,
              expected: row.expected,
              detected: row.detected,
              status: st.text,
            })}
          >
            <Text style={[s.td, s.colRef]}>{ref}</Text>
            <Text style={[s.td, s.colNum]}>{row.expected}</Text>
            <Text style={[s.td, s.colNum]}>{row.detected}</Text>
            <View style={[s.colDiff, s.diffCell]}>
              <Icon name={st.icon} size={16} color={st.color} />
              <Text style={s.td}>{diff > 0 ? `+${diff}` : String(diff)}</Text>
              <Text style={s.diffText}>{st.text}</Text>
            </View>
          </View>
        );
      })}
      <Text style={[s.h2, s.summaryTitle]} accessibilityRole="header">
        {t.summary.title}
      </Text>
      <Stat label={t.summary.precision} value={fmtPercent(m.precision)} />
      <Stat label={t.summary.recall} value={fmtPercent(m.recall)} />
      <Stat label={t.summary.partPrecision} value={fmtPercent(m.partPrecision)} />
      <Stat label={t.summary.partRecall} value={fmtPercent(m.partRecall)} />
      <Stat
        label={t.summary.countError}
        value={`${m.countError > 0 ? '+' : ''}${m.countError} (${tpl(t.summary.counts, {
          detected: m.countDetected,
          expected: m.countExpected,
        })})`}
      />
    </View>
  );
}

function SessionRow(p: { session: SavedCalibrationSession; onChanged: () => void; onError: (e: AppError) => void }): ReactElement {
  const date = fmtDate(p.session.createdAt);
  const share = async (): Promise<void> => {
    const r = await shareCalibrationSession(p.session.uri);
    if (!r.ok) p.onError(r.error);
  };
  const remove = (): void => {
    Alert.alert(t.sessions.deleteTitle, t.sessions.deleteText, [
      { text: common.actions.cancel, style: 'cancel' },
      {
        text: t.sessions.delete,
        style: 'destructive',
        onPress: () => void deleteCalibrationSession(p.session.id).then(p.onChanged),
      },
    ]);
  };
  const metrics =
    p.session.precision == null || p.session.recall == null
      ? null
      : tpl(t.sessions.metrics, { p: fmtPercent(p.session.precision), r: fmtPercent(p.session.recall) });
  return (
    <View style={s.sessionRow}>
      <View style={s.sessionText}>
        <Text style={s.td}>{date}</Text>
        {metrics ? <Text style={s.muted}>{metrics}</Text> : null}
      </View>
      <View style={s.sessionActions}>
        <Button
          label={t.sessions.share}
          icon="share-outline"
          variant="secondary"
          onPress={() => void share()}
          accessibilityHint={tpl(t.sessions.shareLabel, { date })}
        />
        <Button
          label={t.sessions.delete}
          icon="trash-outline"
          variant="ghost"
          onPress={remove}
          accessibilityHint={tpl(t.sessions.deleteLabel, { date })}
        />
      </View>
    </View>
  );
}

export default function CalibrationScreen(): ReactElement {
  const result = useStore(scanStore, (st) => st.lastResult);
  const [text, setText] = useState('');
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [compared, setCompared] = useState<{ result: ScanResult; expected: CountedLine[]; metrics: CalibrationMetrics } | null>(
    null,
  );
  const [error, setError] = useState<AppError | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sessions = useAsync(() => listCalibrationSessions(), []);

  // A new scan invalidates a comparison made on the previous one.
  const current = useMemo(() => (compared && compared.result === result ? compared : null), [compared, result]);

  const compare = (): void => {
    if (!result) return;
    setError(null);
    setInfo(null);
    const parsed = parseExpected(text);
    const errs = parsed.errors.map((e) => tpl(t.expected.errorLine, { line: e.line, text: e.text }));
    if (parsed.lines.length === 0 && errs.length === 0) errs.push(t.expected.emptyList);
    setParseErrors(errs);
    if (parsed.lines.length === 0) {
      setCompared(null);
      return;
    }
    const metrics = computeMetrics(countDetected(result.pieces), parsed.lines);
    setCompared({ result, expected: parsed.lines, metrics });
  };

  const save = async (): Promise<void> => {
    if (!current) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const session = buildCalibrationSession({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        platform: `${Platform.OS} ${String(Platform.Version)}`,
        appVersion: Constants.expoConfig?.version ?? '0.0.0',
        result: current.result,
        expected: current.expected,
      });
      const r = await saveCalibrationSession(session);
      if (r.ok) {
        setInfo(t.saved);
        sessions.reload();
      } else {
        setError(r.error);
      }
    } catch {
      setError({ code: 'unknown', message: t.errors.saveFailed });
    } finally {
      setSaving(false);
    }
  };

  const savedList = sessions.data ?? [];

  return (
    <Screen title={t.title} onBack={() => goBack(routes.settings)} scroll>
      <View style={s.content}>
        {!result ? (
          <EmptyState
            icon="flask-outline"
            title={t.empty.title}
            message={t.empty.message}
            actionLabel={t.empty.action}
            onAction={() => router.navigate(routes.scanner)}
          />
        ) : (
          <>
            <LastScanCard result={result} />
            <View style={s.block}>
              <TextField
                label={t.expected.label}
                value={text}
                onChangeText={setText}
                placeholder={t.expected.placeholder}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityHint={t.expected.help}
              />
              <Text style={s.muted}>{t.expected.help}</Text>
              {parseErrors.length > 0 ? (
                <View style={s.errors} accessibilityLiveRegion="polite">
                  {parseErrors.map((e) => (
                    <View key={e} style={s.errorRow}>
                      <Icon name="alert-circle" size={16} color={colors.error} />
                      <Text style={s.errorText}>{e}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Button label={t.compare} icon="git-compare-outline" onPress={compare} />
            </View>
            {current ? (
              <>
                <ComparisonTable metrics={current.metrics} />
                <Button label={t.save} icon="save-outline" variant="secondary" onPress={() => void save()} loading={saving} disabled={saving} />
                <Text style={s.muted}>{t.privacy}</Text>
              </>
            ) : null}
          </>
        )}
        {error ? <Banner tone="error" text={error.message} onDismiss={() => setError(null)} /> : null}
        {info ? <Banner tone="ok" text={info} onDismiss={() => setInfo(null)} /> : null}
        <View style={s.block}>
          <Text style={s.h2} accessibilityRole="header">
            {t.sessions.title}
          </Text>
          {savedList.length === 0 ? (
            <Text style={s.muted}>{t.sessions.none}</Text>
          ) : (
            savedList.map((ss) => <SessionRow key={ss.uri} session={ss} onChanged={sessions.reload} onError={setError} />)
          )}
        </View>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  content: { gap: spacing.lg, paddingVertical: spacing.lg },
  block: { gap: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  h2: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  summaryTitle: { marginTop: spacing.md },
  muted: { color: colors.muted, fontSize: font.small },
  stat: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap' },
  statLabel: { color: colors.muted, fontSize: font.body, flexShrink: 1 },
  statValue: { color: colors.text, fontSize: font.body, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  thead: { paddingVertical: spacing.xs },
  th: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  td: { color: colors.text, fontSize: font.body, fontVariant: ['tabular-nums'] },
  colRef: { flex: 3 },
  colNum: { flex: 1.2, textAlign: 'right' },
  colDiff: { flex: 2.6 },
  diffCell: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  diffText: { color: colors.muted, fontSize: font.tiny },
  errors: { gap: spacing.xs },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  errorText: { color: colors.error, fontSize: font.small, flexShrink: 1 },
  sessionRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sessionText: { gap: spacing.xs },
  sessionActions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
