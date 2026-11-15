import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';
import { ui } from '@/i18n/fr/ui';
import { IconButton } from './Button';
import { Icon, type IconName } from './Icon';

type Tone = 'info' | 'warn' | 'error' | 'ok';

const TONE: Record<Tone, { icon: IconName; color: string }> = {
  info: { icon: 'information-circle', color: colors.text },
  warn: { icon: 'warning', color: colors.warn },
  error: { icon: 'alert-circle', color: colors.error },
  ok: { icon: 'checkmark-circle', color: colors.ok },
};

/** Inline message; tone drives icon + colour (never colour alone). */
export function Banner(p: {
  tone: Tone;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}): ReactElement {
  const t = TONE[p.tone];
  const urgent = p.tone === 'warn' || p.tone === 'error';
  return (
    <View style={[s.root, { borderLeftColor: t.color }]}>
      <View
        style={s.main}
        accessible
        accessibilityRole={urgent ? 'alert' : 'text'}
        accessibilityLiveRegion="polite"
        accessibilityLabel={p.text}
      >
        <Icon name={t.icon} size={22} color={t.color} />
        <Text style={s.text}>{p.text}</Text>
      </View>
      {p.actionLabel && p.onAction ? (
        <Pressable
          onPress={p.onAction}
          accessibilityRole="button"
          accessibilityLabel={p.actionLabel}
          style={({ pressed }) => [s.action, pressed && s.pressed]}
        >
          <Text style={s.actionText}>{p.actionLabel}</Text>
        </Pressable>
      ) : null}
      {p.onDismiss ? <IconButton icon="close" label={ui.banner.dismiss} onPress={p.onDismiss} size={20} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderLeftWidth: 4,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
    marginVertical: spacing.xs,
  },
  main: { flex: 1, minWidth: 180, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  text: { flex: 1, color: colors.text, fontSize: font.small + 1 },
  action: { minHeight: touch.min, justifyContent: 'center', paddingHorizontal: spacing.md },
  actionText: { color: colors.primary, fontWeight: '700', fontSize: font.body },
  pressed: { opacity: 0.7 },
});
