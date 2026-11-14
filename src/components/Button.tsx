import type { ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BG: Record<Variant, string> = {
  primary: colors.primary,
  secondary: colors.surface,
  ghost: 'transparent',
  danger: colors.error,
};
// Dark text on primary/error (contrast ≥ 4.5:1, §7.2-4), light text on surface.
const FG: Record<Variant, string> = {
  primary: colors.onPrimary,
  secondary: colors.text,
  ghost: colors.primary,
  danger: colors.onPrimary,
};

export function Button(p: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}): ReactElement {
  const variant = p.variant ?? 'primary';
  const inactive = !!(p.disabled || p.loading);
  const fg = FG[variant];
  return (
    <Pressable
      onPress={p.onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityHint={p.accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: !!p.loading }}
      style={({ pressed }) => [
        s.base,
        { backgroundColor: BG[variant] },
        variant === 'secondary' && s.secondary,
        pressed && !inactive && s.pressed,
        p.disabled && !p.loading && s.disabled,
        p.style,
      ]}
    >
      <View style={s.content}>
        {p.loading ? (
          <ActivityIndicator color={fg} size="small" />
        ) : p.icon ? (
          <Icon name={p.icon} size={20} color={fg} />
        ) : null}
        <Text style={[s.label, { color: fg }]}>{p.label}</Text>
      </View>
    </Pressable>
  );
}

export function IconButton(p: {
  icon: IconName;
  /** a11y label, required */
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  size?: number;
}): ReactElement {
  const size = p.size ?? 24;
  return (
    <Pressable
      onPress={p.onPress}
      disabled={p.disabled}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityState={{ disabled: !!p.disabled, selected: !!p.active }}
      style={({ pressed }) => [
        s.iconBtn,
        p.active && s.iconActive,
        pressed && !p.disabled && s.pressed,
        p.disabled && s.disabled,
      ]}
    >
      <Icon name={p.icon} size={size} color={p.active ? colors.primary : colors.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  base: {
    minHeight: touch.min,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  secondary: { borderWidth: 1, borderColor: colors.line },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, flexShrink: 1 },
  label: { fontSize: font.body, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
  iconBtn: {
    minWidth: touch.min,
    minHeight: touch.min,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // Active = colour + visible ring (never colour alone, §7.2-3).
  iconActive: { backgroundColor: colors.surface, borderColor: colors.primary },
});
