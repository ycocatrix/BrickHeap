// Pile drawer (EX_03, B2): three heights, drag or header tap; rows = groupPieces(pieces).
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Animated, FlatList, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import type { IdentifiedPiece, Palette, PileGroup } from '@/domain/types';
import { groupPieces } from '@/domain/pile/grouping';
import { ColorDot } from '@/components/ColorDot';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { Icon } from '@/components/Icon';
import { PartImage } from '@/components/PartImage';
import { tpl } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, radius, spacing, touch } from '@/theme';
import { a11yLabel, colorInfo, statusText } from './display';
import { drawerHeights, drawerVisible, nearestSnap, nextSnapOnTap, pieceStatus } from './scannerLogic';

const DEFAULT_HEADER = 56;
const ANIM_MS = 200;

export function groupStatusText(g: PileGroup, first: IdentifiedPiece | undefined): string {
  switch (g.kind) {
    case 'color_to_confirm':
      return scanner.review.colorToConfirm.toLowerCase();
    case 'partial':
      return scanner.box.partial;
    case 'unknown':
      return first ? statusText(pieceStatus(first)) : scanner.status.unknown;
    default:
      return statusText(g.level);
  }
}

export function PileDrawer(p: {
  containerHeight: number;
  snap: number;
  onSnapChange: (i: number) => void;
  pieces: readonly IdentifiedPiece[];
  palette: Palette | null;
  /** Live Inventorier: header with the count only (pieces are not identified yet). */
  countOnly: boolean;
  highlightedKey: string | null;
  onRowPress: (g: PileGroup) => void;
  onBadgePress: (g: PileGroup) => void;
  reduceMotion: boolean;
}): ReactElement | null {
  const [headerH, setHeaderH] = useState(DEFAULT_HEADER);
  const heights = useMemo(() => drawerHeights(p.containerHeight, headerH), [p.containerHeight, headerH]);
  const effectiveSnap = p.countOnly ? 0 : p.snap;
  const [height] = useState(() => new Animated.Value(heights[0]));
  const target = heights[effectiveSnap];
  useEffect(() => {
    if (p.reduceMotion) {
      height.setValue(target);
      return undefined;
    }
    const anim = Animated.timing(height, { toValue: target, duration: ANIM_MS, useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [target, p.reduceMotion, height]);

  // Drag on the header (plain responder props; the drag state is only touched inside the handlers).
  const drag = useRef({ startY: 0, lastY: 0, lastT: 0, vy: 0 });
  const clampH = (dy: number) => Math.min(heights[2], Math.max(heights[0], target - dy));
  const dragHandlers = {
    onStartShouldSetResponderCapture: (e: GestureResponderEvent) => {
      const { pageY, timestamp } = e.nativeEvent;
      drag.current = { startY: pageY, lastY: pageY, lastT: timestamp, vy: 0 };
      return false; // taps stay with the Pressable
    },
    onMoveShouldSetResponderCapture: (e: GestureResponderEvent) => Math.abs(e.nativeEvent.pageY - drag.current.startY) > 6,
    onResponderTerminationRequest: () => false,
    onResponderMove: (e: GestureResponderEvent) => {
      const { pageY, timestamp } = e.nativeEvent;
      const d = drag.current;
      d.vy = (pageY - d.lastY) / Math.max(1, timestamp - d.lastT);
      d.lastY = pageY;
      d.lastT = timestamp;
      height.setValue(clampH(pageY - d.startY));
    },
    onResponderRelease: (e: GestureResponderEvent) => {
      const d = drag.current;
      const next = nearestSnap(heights, clampH(e.nativeEvent.pageY - d.startY), d.vy, effectiveSnap);
      if (next === effectiveSnap) {
        Animated.timing(height, { toValue: target, duration: p.reduceMotion ? 0 : ANIM_MS, useNativeDriver: false }).start();
      } else {
        p.onSnapChange(next);
      }
    },
    onResponderTerminate: () => height.setValue(target),
  };

  const groups = useMemo(() => (p.countOnly ? [] : groupPieces(p.pieces)), [p.pieces, p.countOnly]);
  const byId = useMemo(() => new Map(p.pieces.map((x) => [x.detection.id, x])), [p.pieces]);

  const n = p.pieces.length;
  if (!drawerVisible(n)) return null;

  const countText = scanner.drawer.approx + tpl(n < 2 ? scanner.drawer.countOne : scanner.drawer.count, { n });
  const expanded = effectiveSnap > 0;

  return (
    <Animated.View style={[s.root, { height }]}>
      <View {...(p.countOnly ? {} : dragHandlers)}>
        <Pressable
          onLayout={(e) => {
            const h = Math.round(e.nativeEvent.layout.height);
            if (h > 0 && Math.abs(h - headerH) > 1) setHeaderH(h);
          }}
          onPress={p.countOnly ? undefined : () => p.onSnapChange(nextSnapOnTap(effectiveSnap))}
          disabled={p.countOnly}
          style={s.header}
          accessibilityRole={p.countOnly ? 'text' : 'button'}
          accessibilityLabel={countText}
          accessibilityHint={p.countOnly ? undefined : scanner.drawer.hint}
          accessibilityState={p.countOnly ? undefined : { expanded }}
        >
          <View style={s.grabber} />
          <View style={s.headerRow}>
            <Text style={s.count}>{countText}</Text>
            {p.countOnly ? null : (
              <Icon name={effectiveSnap === 2 ? 'chevron-down' : 'chevron-up'} size={20} color={colors.text} />
            )}
          </View>
        </Pressable>
      </View>
      {p.countOnly ? null : (
        <FlatList
          data={groups}
          keyExtractor={(g) => g.key}
          style={s.list}
          contentContainerStyle={s.listContent}
          renderItem={({ item }) => (
            <DrawerRow
              group={item}
              first={byId.get(item.detectionIds[0])}
              palette={p.palette}
              highlighted={p.highlightedKey === item.key}
              onPress={() => p.onRowPress(item)}
              onBadgePress={() => p.onBadgePress(item)}
            />
          )}
        />
      )}
    </Animated.View>
  );
}

function DrawerRow(p: {
  group: PileGroup;
  first: IdentifiedPiece | undefined;
  palette: Palette | null;
  highlighted: boolean;
  onPress: () => void;
  onBadgePress: () => void;
}): ReactElement {
  const g = p.group;
  const color = colorInfo(p.palette, g.colorId);
  const name = g.name || scanner.box.unknownName;
  const useCrop = g.kind !== 'ok' && !!g.cropUri;
  const label = a11yLabel({ name, color: color.label, confidence: g.confidence, status: groupStatusText(g, p.first) });
  return (
    <View style={[s.row, p.highlighted && s.rowHighlighted]}>
      <Pressable
        onPress={p.onPress}
        style={s.rowMain}
        accessibilityRole="button"
        accessibilityLabel={`${label}${g.count > 1 ? `, ×${g.count}` : ''}`}
        accessibilityState={{ selected: p.highlighted }}
      >
        {useCrop ? (
          <Image source={{ uri: g.cropUri ?? undefined }} style={s.thumb} contentFit="cover" accessible={false} />
        ) : (
          <PartImage uri={g.imageUrl} size={44} />
        )}
        <View style={s.rowText}>
          <Text style={s.name} numberOfLines={1}>
            {name}
          </Text>
          <View style={s.colorRow}>
            <ColorDot hex={color.hex} isTrans={color.isTrans} size={14} />
            <Text style={s.muted} numberOfLines={1}>
              {color.label}
            </Text>
          </View>
        </View>
        <Text style={s.qty}>×{g.count}</Text>
      </Pressable>
      {g.level === 'review' && g.kind !== 'unknown' ? (
        <Pressable
          onPress={p.onBadgePress}
          style={s.badge}
          accessibilityRole="button"
          accessibilityLabel={`${statusText('review')}, ${name}`}
          accessibilityHint={scanner.review.badgeHint}
        >
          <ConfidenceBadge level={g.level} confidence={g.confidence} compact />
        </Pressable>
      ) : (
        <View style={s.badge}>
          <ConfidenceBadge level={g.level} confidence={g.confidence} compact />
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    overflow: 'hidden',
  },
  header: { minHeight: touch.min, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, justifyContent: 'center' },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.line, marginVertical: spacing.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  count: { color: colors.text, fontSize: font.body, fontWeight: '700', flexShrink: 1 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.bg },
  rowHighlighted: { borderWidth: 2, borderColor: colors.primary },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, padding: spacing.sm },
  thumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.tileBg },
  rowText: { flex: 1 },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  colorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  muted: { color: colors.muted, fontSize: font.small, flexShrink: 1 },
  qty: { color: colors.text, fontSize: font.body, fontWeight: '700', fontVariant: ['tabular-nums'] },
  badge: { minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center', paddingRight: spacing.sm },
});
