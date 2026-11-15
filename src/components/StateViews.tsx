import type { ReactElement } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type DimensionValue } from 'react-native';
import type { AppError } from '@/domain/types';
import { colors, font, radius, spacing } from '@/theme';
import { common } from '@/i18n/fr/common';
import { ui } from '@/i18n/fr/ui';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

export function LoadingState(p: { label?: string }): ReactElement {
  const label = p.label ?? ui.state.loading;
  return (
    <View style={s.center} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={s.muted}>{label}</Text>
    </View>
  );
}

export function EmptyState(p: {
  icon: IconName;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactElement {
  return (
    <View style={s.center}>
      <Icon name={p.icon} size={48} color={colors.muted} />
      <Text style={s.title} accessibilityRole="header">
        {p.title}
      </Text>
      {p.message ? <Text style={s.muted}>{p.message}</Text> : null}
      {p.actionLabel && p.onAction ? <Button label={p.actionLabel} onPress={p.onAction} style={s.action} /> : null}
    </View>
  );
}

const ERROR_ICON: Partial<Record<AppError['code'], IconName>> = {
  offline: 'cloud-offline-outline',
  timeout: 'time-outline',
  rate_limited: 'hourglass-outline',
  unauthorized: 'lock-closed-outline',
  not_found: 'search-outline',
};

export function ErrorState(p: {
  error: AppError;
  onRetry?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}): ReactElement {
  return (
    <View style={s.center}>
      <Icon name={ERROR_ICON[p.error.code] ?? 'alert-circle-outline'} size={48} color={colors.error} />
      <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite" style={s.errorText}>
        <Text style={s.title}>{ui.state.errorTitle}</Text>
        <Text style={s.muted}>{p.error.message}</Text>
      </View>
      {p.onRetry ? <Button label={common.actions.retry} icon="refresh" onPress={p.onRetry} style={s.action} /> : null}
      {p.secondaryLabel && p.onSecondary ? (
        <Button label={p.secondaryLabel} variant="ghost" onPress={p.onSecondary} />
      ) : null}
    </View>
  );
}

/** Static placeholder block (no looping animation, §7.2-8). Hidden from screen readers. */
export function Skeleton(p: { width?: DimensionValue; height: number; radius?: number }): ReactElement {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ width: p.width ?? '100%', height: p.height, borderRadius: p.radius ?? radius.sm, backgroundColor: colors.surface }}
    />
  );
}

const s = StyleSheet.create({
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  title: { color: colors.text, fontSize: font.h2, fontWeight: '700', textAlign: 'center' },
  muted: { color: colors.muted, fontSize: font.body, textAlign: 'center' },
  errorText: { alignItems: 'center', gap: spacing.sm },
  action: { alignSelf: 'stretch', marginTop: spacing.sm },
});
