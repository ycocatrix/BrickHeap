import type { ReactElement, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, spacing, touch } from '@/theme';
import { Icon } from './Icon';

/** Row with optional left/right content. Pressable rows without `right` show a chevron. */
export function ListRow(p: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  accessibilityLabel?: string;
}): ReactElement {
  const label = p.accessibilityLabel ?? (p.subtitle ? `${p.title}, ${p.subtitle}` : p.title);
  const content = (
    <>
      {p.left ? <View style={s.left}>{p.left}</View> : null}
      <View style={s.texts}>
        <Text style={[s.title, p.destructive && s.destructive]}>{p.title}</Text>
        {p.subtitle ? <Text style={s.subtitle}>{p.subtitle}</Text> : null}
      </View>
      {p.right !== undefined ? (
        <View style={s.right}>{p.right}</View>
      ) : p.onPress ? (
        <Icon name="chevron-forward" size={20} color={colors.muted} />
      ) : null}
    </>
  );
  if (!p.onPress) {
    return (
      <View style={s.row} accessible={p.right === undefined} accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={p.onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      {content}
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
  left: { alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: font.body },
  destructive: { color: colors.error, fontWeight: '600' },
  subtitle: { color: colors.muted, fontSize: font.small },
  right: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
