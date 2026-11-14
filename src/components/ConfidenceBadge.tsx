import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ConfidenceLevel } from '@/domain/types';
import { colors, font, levelColor, levelIcon, radius, spacing } from '@/theme';
import { fmtPercent, tpl } from '@/i18n/format';
import { ui } from '@/i18n/fr/ui';
import { Icon } from './Icon';

/** RG_04: icon (✓ / ? / –) + text + colour, and a distinct shape per level (filled / filled / dashed outline) so
 *  the three levels stay distinguishable in greyscale. Not pressable: callers wrap it to open the chooser. */
export function ConfidenceBadge(p: { level: ConfidenceLevel; confidence?: number; compact?: boolean }): ReactElement {
  const label = ui.confidence.levels[p.level];
  const percent = p.confidence == null ? null : fmtPercent(p.confidence);
  const filled = p.level !== 'unknown';
  const fg = filled ? colors.onPrimary : colors.muted;
  const text = p.compact ? (percent ?? label) : percent ? `${label} · ${percent}` : label;
  const a11y = percent
    ? tpl(ui.confidence.a11yPercent, { level: label, percent })
    : tpl(ui.confidence.a11y, { level: label });
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={a11y}
      style={[
        s.pill,
        filled ? { backgroundColor: levelColor[p.level], borderColor: levelColor[p.level] } : s.outline,
        p.compact && s.compact,
      ]}
    >
      <Icon name={levelIcon[p.level]} size={p.compact ? 12 : 14} color={fg} />
      <Text style={[s.text, p.compact && s.textCompact, { color: fg }]}>{text}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1.5,
  },
  outline: { backgroundColor: 'transparent', borderColor: colors.muted, borderStyle: 'dashed' },
  compact: { paddingHorizontal: 6, paddingVertical: 1 },
  text: { fontSize: font.small, fontWeight: '700' },
  textCompact: { fontSize: font.tiny },
});
