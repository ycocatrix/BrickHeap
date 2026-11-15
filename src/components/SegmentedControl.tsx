import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';

/** Selected segment = filled + bold label (never colour alone). */
export function SegmentedControl<T extends string>(p: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  accessibilityLabel: string;
}): ReactElement {
  return (
    <View style={s.root} accessibilityRole="radiogroup" accessibilityLabel={p.accessibilityLabel}>
      {p.options.map((o) => {
        const selected = o.value === p.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => {
              if (!selected) p.onChange(o.value);
            }}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected, checked: selected }}
            style={({ pressed }) => [s.seg, selected && s.selected, pressed && !selected && s.pressed]}
          >
            <Text style={[s.text, selected && s.textSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 2,
  },
  seg: {
    flex: 1,
    minHeight: touch.min - 4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md - 2,
  },
  selected: { backgroundColor: colors.primary },
  pressed: { opacity: 0.7 },
  text: { color: colors.text, fontSize: font.small + 1, textAlign: 'center' },
  textSelected: { color: colors.onPrimary, fontWeight: '800' },
});
