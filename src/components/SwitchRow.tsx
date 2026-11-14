import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { colors, font, spacing, touch } from '@/theme';

/** The whole row toggles; it is announced once as a switch with its state. */
export function SwitchRow(p: { label: string; value: boolean; onValueChange: (v: boolean) => void; hint?: string }): ReactElement {
  return (
    <Pressable
      onPress={() => p.onValueChange(!p.value)}
      accessibilityRole="switch"
      accessibilityLabel={p.label}
      accessibilityHint={p.hint}
      accessibilityState={{ checked: p.value }}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      <View style={s.texts}>
        <Text style={s.label}>{p.label}</Text>
        {p.hint ? <Text style={s.hint}>{p.hint}</Text> : null}
      </View>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Switch
          value={p.value}
          onValueChange={p.onValueChange}
          trackColor={{ false: colors.line, true: colors.primary }}
          thumbColor={colors.white}
          ios_backgroundColor={colors.line}
        />
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touch.min + 8,
    paddingVertical: spacing.sm,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  pressed: { backgroundColor: colors.surface },
  texts: { flex: 1, gap: 2 },
  label: { color: colors.text, fontSize: font.body },
  hint: { color: colors.muted, fontSize: font.small },
});
