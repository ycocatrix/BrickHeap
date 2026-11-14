// C4 — Export (EX_18, EX_23): formSheet route. Format radio, scope, « Partager »; the result is shown inline
// (a formSheet hides the snackbar host, §3).
import { useState, type ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AppError, ExportFormat, ListId } from '@/domain/types';
import { useLists } from '@/hooks/useInventory';
import { shareExport } from '@/services/exportShare';
import { feedback } from '@/services/feedback';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { colors, font, radius, spacing, touch } from '@/theme';
import { common } from '@/i18n/fr/common';
import { fmtCount, plural, tpl } from '@/i18n/format';
import { inventory as t } from '@/i18n/fr/inventory';

const FORMATS: readonly ExportFormat[] = ['csv', 'json', 'bricklink_xml'];

type Outcome = { ok: true; rows: number; skipped: number; format: ExportFormat } | { ok: false; error: AppError };

function Radio(p: { label: string; hint?: string; checked: boolean; onPress: () => void }): ReactElement {
  return (
    <Pressable
      onPress={p.onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: p.checked }}
      accessibilityLabel={p.hint ? `${p.label}, ${p.hint}` : p.label}
      style={({ pressed }) => [s.radio, p.checked && s.radioOn, pressed && s.pressed]}
    >
      <Icon name={p.checked ? 'radio-button-on' : 'radio-button-off'} size={22} color={p.checked ? colors.primary : colors.muted} />
      <View style={s.radioTexts}>
        <Text style={[s.radioLabel, p.checked && s.radioLabelOn]}>{p.label}</Text>
        {p.hint ? <Text style={s.radioHint}>{p.hint}</Text> : null}
      </View>
    </Pressable>
  );
}

function lines(n: number): string {
  return tpl(plural(n, t.export.linesOne, t.export.linesOther), { n: fmtCount(n) });
}

export default function ExportSheet(): ReactElement {
  const params = useLocalSearchParams<{ listId?: string }>();
  const paramListId: ListId | null = typeof params.listId === 'string' && params.listId !== '' ? params.listId : null;
  const insets = useSafeAreaInsets();
  const lists = useLists();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [scope, setScope] = useState<ListId | null>(paramListId);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const all = lists.data ?? [];
  const list = paramListId ? all.find((l) => l.id === paramListId) ?? null : null;
  const totalRefs = all.reduce((sum, l) => sum + l.refCount, 0);
  const effectiveScope = list ? scope : null;

  const share = async () => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    const res = await shareExport(format, effectiveScope);
    setBusy(false);
    if (res.ok) {
      feedback.success();
      setOutcome({ ok: true, rows: res.value.rows, skipped: res.value.skipped, format });
    } else {
      feedback.error();
      setOutcome({ ok: false, error: res.error });
    }
  };

  const resultText = outcome?.ok
    ? [
        tpl(plural(outcome.rows, t.export.doneOne, t.export.doneOther), { n: fmtCount(outcome.rows) }),
        outcome.format === 'bricklink_xml' && outcome.skipped > 0
          ? tpl(plural(outcome.skipped, t.export.skippedOne, t.export.skippedOther), { n: fmtCount(outcome.skipped) })
          : null,
      ].filter(Boolean).join('\n')
    : null;

  return (
    <View style={[s.root, { paddingBottom: insets.bottom + spacing.lg }]}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.title} accessibilityRole="header">
          {t.export.title}
        </Text>

        <Text style={s.section}>{t.export.formatLabel}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={t.export.formatLabel} style={s.group}>
          {FORMATS.map((f) => (
            <Radio
              key={f}
              label={t.export.formats[f]}
              hint={t.export.formatHints[f]}
              checked={format === f}
              onPress={() => {
                setFormat(f);
                setOutcome(null);
              }}
            />
          ))}
        </View>

        <Text style={s.section}>{t.export.scopeLabel}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={t.export.scopeLabel} style={s.group}>
          {list ? (
            <Radio
              label={tpl(t.export.scopeList, { name: list.name, n: lines(list.refCount) })}
              checked={effectiveScope === list.id}
              onPress={() => {
                setScope(list.id);
                setOutcome(null);
              }}
            />
          ) : null}
          <Radio
            label={tpl(t.export.scopeAll, { n: lines(totalRefs) })}
            checked={effectiveScope === null}
            onPress={() => {
              setScope(null);
              setOutcome(null);
            }}
          />
        </View>

        {outcome ? (
          outcome.ok ? (
            <Banner tone="ok" text={resultText ?? ''} />
          ) : (
            <Banner tone={outcome.error.code === 'invalid' ? 'warn' : 'error'} text={outcome.error.message} />
          )
        ) : null}
      </ScrollView>
      <View style={s.actions}>
        <Button
          label={t.export.share}
          icon="share-outline"
          loading={busy}
          accessibilityHint={t.export.shareHint}
          onPress={() => void share()}
        />
        <Button label={common.actions.close} variant={outcome?.ok ? 'primary' : 'ghost'} onPress={() => router.back()} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  section: { color: colors.muted, fontSize: font.small, fontWeight: '600', marginTop: spacing.sm },
  group: { gap: spacing.sm },
  radio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  radioOn: { borderColor: colors.primary },
  pressed: { opacity: 0.7 },
  radioTexts: { flex: 1 },
  radioLabel: { color: colors.text, fontSize: font.body },
  radioLabelOn: { fontWeight: '700' },
  radioHint: { color: colors.muted, fontSize: font.small, marginTop: 2 },
  actions: { paddingHorizontal: spacing.lg, gap: spacing.sm },
});
