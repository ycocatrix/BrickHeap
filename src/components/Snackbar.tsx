import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createStore, useStore } from '@/state/createStore';
import { colors, font, radius, spacing, touch } from '@/theme';
import { ui } from '@/i18n/fr/ui';
import { ANIM_MS, useReduceMotion } from './useReduceMotion';

interface SnackItem {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  durationMs: number;
}

const DEFAULT_MS = 4000;
/** Height kept free for the JS tab bar under the snackbar ("above the tab bar"). */
const TAB_BAR_SPACE = 56;

const snackStore = createStore<{ current: SnackItem | null }>({ current: null });
let nextId = 1;

/** Shows one snackbar; a new call replaces the visible one. Never throws.
 *  Snackbar rule (§3): callers close their sheet BEFORE calling showSnackbar; never used from a formSheet. */
export function showSnackbar(o: {
  text: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  /** default 4000; undo snackbars use UNDO_MS */
  durationMs?: number;
}): void {
  snackStore.set({
    current: {
      id: nextId++,
      text: o.text,
      actionLabel: o.actionLabel,
      onAction: o.onAction,
      durationMs: o.durationMs ?? DEFAULT_MS,
    },
  });
}

export const UNDO_MS = 10000; // RG_09 / EX_16

function hide(id: number): void {
  if (snackStore.get().current?.id === id) snackStore.set({ current: null });
}

/** Mounted once in the root layout. Renders nothing while no snackbar is shown. */
export function SnackbarHost(): ReactElement {
  const item = useStore(snackStore, (s) => s.current);
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const reduceRef = useRef(reduceMotion);
  useEffect(() => {
    reduceRef.current = reduceMotion;
  }, [reduceMotion]);
  const [anim] = useState(() => new Animated.Value(0));
  const fired = useRef<number | null>(null);

  useEffect(() => {
    if (!item) return;
    const announce = item.actionLabel ? `${item.text}. ${item.actionLabel}` : item.text;
    AccessibilityInfo.announceForAccessibility(announce);
    anim.setValue(0);
    if (reduceRef.current) anim.setValue(1);
    else Animated.timing(anim, { toValue: 1, duration: ANIM_MS, useNativeDriver: true }).start();
    const timer = setTimeout(() => hide(item.id), item.durationMs);
    return () => clearTimeout(timer);
  }, [item, anim]);

  if (!item) return <></>;

  const onAction = () => {
    if (fired.current === item.id) return; // the action fires once
    fired.current = item.id;
    hide(item.id);
    try {
      Promise.resolve(item.onAction?.()).catch(() => undefined);
    } catch {
      // a throwing action must not crash the host
    }
  };

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, s.layer]}>
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityLabel={ui.snackbar.region}
        style={[
          s.bar,
          { marginBottom: insets.bottom + TAB_BAR_SPACE + spacing.sm },
          {
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
          },
        ]}
      >
        <Text style={s.text} accessibilityRole="text">
          {item.text}
        </Text>
        {item.actionLabel && item.onAction ? (
          <Pressable
            onPress={onAction}
            accessibilityRole="button"
            accessibilityLabel={item.actionLabel}
            style={({ pressed }) => [s.action, pressed && s.pressed]}
          >
            <Text style={s.actionText}>{item.actionLabel}</Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  layer: { justifyContent: 'flex-end', paddingHorizontal: spacing.md },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    backgroundColor: colors.text,
    borderRadius: radius.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    paddingVertical: spacing.xs,
    minHeight: touch.min,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  text: { flex: 1, minWidth: 160, color: colors.bg, fontSize: font.body, paddingVertical: spacing.sm },
  action: { minHeight: touch.min, minWidth: touch.min, justifyContent: 'center', paddingHorizontal: spacing.md },
  // Dark text on the light bar: action distinguished by weight + upper case, not colour alone.
  actionText: { color: colors.bg, fontWeight: '800', fontSize: font.body, textTransform: 'uppercase' },
  pressed: { opacity: 0.6 },
});
