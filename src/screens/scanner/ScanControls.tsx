// Thumb zone (B1): mode switch, then shutter / scanning indicator / « Analyser », or « Reprendre » + « Valider ».
import type { ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ScanMode } from '@/domain/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { SegmentedControl } from '@/components/SegmentedControl';
import { tpl } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, spacing } from '@/theme';

const t = scanner.controls;

export function ScanControls(p: {
  mode: ScanMode;
  phase: 'live' | 'analyzing' | 'frozen';
  onModeChange: (m: ScanMode) => void;
  /** Live loop running (Explorer indicator). */
  scanning: boolean;
  /** Explorer without live (setting off or automatic fallback): manual « Analyser ». */
  manualAnalyze: boolean;
  /** Camera ready and no capture in flight. */
  canCapture: boolean;
  capturing: boolean;
  onShutter: () => void;
  onAnalyze: () => void;
  onResume: () => void;
  validateCount: number;
  onValidate: () => void;
}): ReactElement {
  const modes: { value: ScanMode; label: string }[] = [
    { value: 'explore', label: scanner.modes.explore },
    { value: 'inventory', label: scanner.modes.inventory },
  ];

  let actions: ReactElement;
  if (p.phase === 'live') {
    if (p.mode === 'inventory') {
      actions = (
        <View style={s.center}>
          <Pressable
            onPress={p.onShutter}
            disabled={!p.canCapture || p.capturing}
            style={({ pressed }) => [s.shutter, (!p.canCapture || p.capturing) && s.disabled, pressed && s.pressed]}
            accessibilityRole="button"
            accessibilityLabel={t.shutter}
            accessibilityHint={t.shutterHint}
            accessibilityState={{ disabled: !p.canCapture || p.capturing, busy: p.capturing }}
            hitSlop={8}
          >
            {p.capturing ? <ActivityIndicator color={colors.onPrimary} /> : <Icon name="camera" size={30} color={colors.onPrimary} />}
          </Pressable>
        </View>
      );
    } else if (p.manualAnalyze) {
      actions = (
        <Button
          label={t.analyze}
          icon="scan-outline"
          onPress={p.onAnalyze}
          disabled={!p.canCapture}
          loading={p.capturing}
          accessibilityHint={t.analyzeHint}
        />
      );
    } else {
      actions = (
        <View style={s.indicator} accessible accessibilityRole="text" accessibilityLabel={t.scanning}>
          {p.scanning ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon name="scan-outline" size={18} color={colors.muted} />}
          <Text style={s.indicatorText}>{t.scanning}</Text>
        </View>
      );
    }
  } else {
    actions = (
      <View style={s.row}>
        <Button
          label={t.resume}
          icon="refresh"
          variant="secondary"
          onPress={p.onResume}
          accessibilityHint={t.resumeHint}
          style={s.flex}
        />
        {p.mode === 'inventory' && p.phase === 'frozen' ? (
          <Button
            label={tpl(t.validate, { n: p.validateCount })}
            icon="checkmark"
            onPress={p.onValidate}
            disabled={p.validateCount === 0}
            accessibilityHint={t.validateHint}
            style={s.flex}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={s.root}>
      {p.phase === 'analyzing' ? (
        <View style={s.indicator} accessibilityLiveRegion="polite">
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={s.indicatorText}>{t.analyzing}</Text>
        </View>
      ) : null}
      <SegmentedControl options={modes} value={p.mode} onChange={p.onModeChange} accessibilityLabel={scanner.modes.label} />
      {actions}
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md, gap: spacing.md, backgroundColor: colors.bg },
  center: { alignItems: 'center' },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary,
    borderWidth: 4,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.5 },
  pressed: { transform: [{ scale: 0.95 }] },
  indicator: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  indicatorText: { color: colors.muted, fontSize: font.small },
  row: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1 },
});
