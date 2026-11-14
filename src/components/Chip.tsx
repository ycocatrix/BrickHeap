import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';
import { Icon, type IconName } from './Icon';

const VISUAL_HEIGHT = 36;
const SLOP = Math.ceil((touch.min - VISUAL_HEIGHT) / 2);

/** Filter / choice chip. Selected = filled + check icon (never colour alone). Without onPress it is a static label. */
export function Chip(p: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName }): ReactElement {
  const fg = p.selected ? colors.onPrimary : colors.text;
  const icon: IconName | undefined = p.selected ? 'checkmark' : p.icon;
  const content = (
    <>
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Text style={[s.text, { color: fg }, p.selected && s.textSelected]}>{p.label}</Text>
    </>
  );
  if (!p.onPress) {
    return (
      <View accessible accessibilityLabel={p.label} style={[s.chip, p.selected && s.selected]}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={p.onPress}
      hitSlop={{ top: SLOP, bottom: SLOP, left: 2, right: 2 }}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ selected: !!p.selected }}
      style={({ pressed }) => [s.chip, p.selected && s.selected, pressed && s.pressed]}
    >
      {content}
    </Pressable>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    minHeight: VISUAL_HEIGHT,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  selected: { backgroundColor: colors.primary, borderColor: colors.primary },
  text: { fontSize: font.small + 1 },
  textSelected: { fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
