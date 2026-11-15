// Sync status for the Compte screen (EX_23): icon + text, never colour alone. Renders nothing for guests or
// when Supabase is not configured (state 'disabled').
import { useEffect, useState, type ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SyncStatus } from '@/domain/types';
import { agoParts } from '@/domain/sync/sync';
import { Button } from '@/components/Button';
import { Icon, type IconName } from '@/components/Icon';
import { syncNow, useSyncStatus } from '@/services/sync';
import { plural, tpl } from '@/i18n/format';
import { sync as t } from '@/i18n/fr/sync';
import { colors, font, spacing } from '@/theme';

interface Line { icon: IconName; color: string; text: string }

function syncedText(lastSyncAt: string | null, now: Date): string {
  if (!lastSyncAt) return t.status.neverSynced;
  const a = agoParts(lastSyncAt, now);
  if (a.unit === 'now') return t.status.syncedNow;
  const template = a.unit === 'min' ? t.status.syncedMin : a.unit === 'h' ? t.status.syncedHour : t.status.syncedDay;
  return tpl(template, { n: a.n });
}

function mainLine(s: SyncStatus, now: Date): Line {
  const pushable = s.pending - s.awaitingCatalog;
  switch (s.state) {
    case 'syncing':
      return { icon: 'sync-outline', color: colors.muted, text: t.status.syncing };
    case 'offline':
      return {
        icon: 'cloud-offline-outline',
        color: colors.warn,
        text: pushable > 0
          ? tpl(plural(pushable, t.status.offlinePendingOne, t.status.offlinePendingOther), { n: pushable })
          : t.status.offline,
      };
    case 'error':
      return { icon: 'alert-circle-outline', color: colors.error, text: s.error?.message ?? t.status.offline };
    case 'needs_login':
      return { icon: 'log-in-outline', color: colors.warn, text: t.status.needsLogin };
    case 'merge_pending':
    case 'account_mismatch':
      return { icon: 'hourglass-outline', color: colors.muted, text: t.status.waitingChoice };
    default:
      return { icon: 'checkmark-circle-outline', color: colors.ok, text: syncedText(s.lastSyncAt, now) };
  }
}

export function SyncStatusLine(): ReactElement | null {
  const status = useSyncStatus();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);   // keeps « il y a … » current
    return () => clearInterval(id);
  }, []);
  // A lastSyncAt newer than `now` reads « à l'instant » (agoParts clamps at 0) until the next tick.

  if (status.state === 'disabled') return null;

  const lines: Line[] = [mainLine(status, now)];
  if (status.awaitingCatalog > 0) {
    lines.push({
      icon: 'time-outline',
      color: colors.muted,
      text: tpl(plural(status.awaitingCatalog, t.status.awaitingCatalogOne, t.status.awaitingCatalogOther),
        { n: status.awaitingCatalog }),
    });
  }
  if (status.state === 'idle' && status.error) {
    lines.push({ icon: 'warning-outline', color: colors.warn, text: status.error.message });
  }
  const canRetry = status.state === 'error' || status.state === 'offline';

  return (
    <View style={styles.container}>
      <View accessible accessibilityRole="text" accessibilityLiveRegion="polite"
        accessibilityLabel={lines.map((l) => l.text).join('. ')}>
        {lines.map((l) => (
          <View key={l.text} style={styles.row}>
            <Icon name={l.icon} size={18} color={l.color} />
            <Text style={styles.text}>{l.text}</Text>
          </View>
        ))}
      </View>
      {canRetry ? (
        <Button label={t.status.retry} variant="ghost" icon="refresh" accessibilityHint={t.status.retryHint}
          onPress={() => void syncNow('manual')} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  text: { flex: 1, color: colors.text, fontSize: font.small },
});
