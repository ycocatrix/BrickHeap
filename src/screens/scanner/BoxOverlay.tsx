// Boxes over the live preview (cover mapping) or over the frozen still (contain mapping) — §4.6, RG_02/03/04.
import { memo, useMemo, type ReactElement } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import type { DetectionId, IdentifiedPiece, Palette, Point, ScanFrame, Size } from '@/domain/types';
import { boxToView, containTransform, coverTransform, viewToImagePoint, type ViewTransform } from '@/domain/vision/geometry';
import { Icon, type IconName } from '@/components/Icon';
import { fmtPercent } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, levelColor, levelIcon, radius, spacing } from '@/theme';
import { pieceView, type PieceView } from './display';
import { paintOrder, statusLevel } from './scannerLogic';

export interface BoxOverlayProps {
  frame: ScanFrame | null;
  pieces: readonly IdentifiedPiece[];
  viewSize: Size | null;
  /** 'cover' over the live preview, 'contain' over the frozen still (drawn by the overlay). */
  fit: 'cover' | 'contain';
  palette: Palette | null;
  highlighted: readonly DetectionId[];
  /** Explorer / frozen: tap a box. Undefined → boxes are a count preview and a tap does nothing. */
  onBoxPress?: (id: DetectionId) => void;
  /** Frozen only: long-press a box removes it. */
  onBoxLongPress?: (id: DetectionId) => void;
  /** Frozen: tap on empty space → manual box at that normalised point. */
  onBackgroundPress?: (p: Point) => void;
  /** Live: long-press on the preview toggles the focus lock. */
  onBackgroundLongPress?: () => void;
  backgroundHint?: string;
}

function statusIcon(v: PieceView): IconName | null {
  if (v.status === 'pending') return null;
  if (v.status === 'unavailable') return 'cloud-offline-outline';
  return levelIcon[statusLevel(v.status)];
}

function chipText(v: PieceView, confidence: number): string {
  switch (v.status) {
    case 'pending':
      return scanner.box.identifying;
    case 'unavailable':
      return scanner.status.unavailable;
    case 'too_small':
      return scanner.status.tooSmall;
    case 'empty':
      return scanner.box.unknownName;
    default: {
      const color = v.color.label !== '—' ? ` ${v.color.label}` : '';
      return `${v.short}${color} · ${fmtPercent(confidence)}`;
    }
  }
}

const Box = memo(function Box(p: {
  piece: IdentifiedPiece;
  rect: { left: number; top: number; width: number; height: number };
  palette: Palette | null;
  highlighted: boolean;
  onPress?: (id: DetectionId) => void;
  onLongPress?: (id: DetectionId) => void;
}): ReactElement {
  const { piece, rect } = p;
  const v = pieceView(piece, p.palette);
  const level = statusLevel(v.status);
  const tone = level === 'unknown' ? colors.muted : levelColor[level];
  const partial = piece.detection.partial && !piece.partialConfirmed;
  const icon = statusIcon(v);
  const id = piece.detection.id;
  const labelAbove = rect.top > 28;
  const interactive = !!p.onPress;

  return (
    <Pressable
      style={[s.box, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }]}
      onPress={interactive ? () => p.onPress?.(id) : undefined}
      onLongPress={p.onLongPress ? () => p.onLongPress?.(id) : undefined}
      disabled={!interactive && !p.onLongPress}
      pointerEvents={interactive || p.onLongPress ? 'auto' : 'none'}
      accessible
      accessibilityRole={interactive ? 'button' : 'image'}
      accessibilityLabel={v.a11y}
      accessibilityHint={p.onLongPress ? scanner.box.a11yRemoveHint : undefined}
      accessibilityState={{ selected: p.highlighted, busy: v.status === 'pending' }}
      hitSlop={rect.width < 48 || rect.height < 48 ? 8 : undefined}
    >
      <View
        style={[
          s.outer,
          p.highlighted && s.outerHighlighted,
        ]}
      >
        <View style={[s.inner, { borderColor: p.highlighted ? colors.primary : tone }, partial && s.dashed]} />
      </View>
      <View style={[s.chip, labelAbove ? s.chipAbove : s.chipInside]} pointerEvents="none">
        {icon ? (
          <Icon name={icon} size={12} color={tone} />
        ) : (
          <ActivityIndicator size="small" color={colors.white} style={s.spinner} />
        )}
        <Text style={s.chipText} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {chipText(v, piece.confidence)}
        </Text>
      </View>
      {partial || piece.detection.suspectMerged ? (
        <View style={[s.chip, s.chipBottom]} pointerEvents="none">
          <Text style={s.chipText} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {[partial ? scanner.box.partial : null, piece.detection.suspectMerged ? scanner.box.merged : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

export function BoxOverlay(p: BoxOverlayProps): ReactElement | null {
  const { frame, viewSize, fit } = p;
  const transform: ViewTransform | null = useMemo(() => {
    if (!frame || !viewSize || viewSize.width <= 0 || viewSize.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
    const image = { width: frame.width, height: frame.height };
    try {
      return fit === 'cover' ? coverTransform(image, viewSize) : containTransform(image, viewSize);
    } catch {
      return null;
    }
  }, [frame, viewSize, fit]);

  const ordered = useMemo(() => paintOrder(p.pieces.map((piece) => ({ piece, box: piece.detection.box }))), [p.pieces]);
  const highlighted = useMemo(() => new Set(p.highlighted), [p.highlighted]);

  const onBackgroundPress = (e: GestureResponderEvent) => {
    if (!p.onBackgroundPress || !frame || !transform) return;
    const { locationX, locationY } = e.nativeEvent;
    let pt: Point | null = null;
    try {
      pt = viewToImagePoint({ x: locationX, y: locationY }, { width: frame.width, height: frame.height }, transform);
    } catch {
      pt = null;
    }
    if (pt) p.onBackgroundPress(pt);
  };

  const hasBackground = !!p.onBackgroundPress || !!p.onBackgroundLongPress;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {fit === 'contain' && frame ? (
        <Image
          source={{ uri: frame.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          accessibilityIgnoresInvertColors
          accessible={false}
        />
      ) : null}
      {hasBackground ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={p.onBackgroundPress ? onBackgroundPress : undefined}
          onLongPress={p.onBackgroundLongPress}
          delayLongPress={600}
          accessible={!!p.backgroundHint}
          accessibilityRole="none"
          accessibilityHint={p.backgroundHint}
        />
      ) : null}
      {transform && frame
        ? ordered.map(({ piece }) => {
            let rect: { left: number; top: number; width: number; height: number };
            try {
              rect = boxToView(piece.detection.box, { width: frame.width, height: frame.height }, transform);
            } catch {
              return null;
            }
            return (
              <Box
                key={piece.detection.id}
                piece={piece}
                rect={rect}
                palette={p.palette}
                highlighted={highlighted.has(piece.detection.id)}
                onPress={p.onBoxPress}
                onLongPress={p.onBoxLongPress}
              />
            );
          })
        : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { position: 'absolute' },
  outer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderWidth: 3, borderColor: colors.white, borderRadius: radius.sm },
  outerHighlighted: { borderWidth: 4 },
  inner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderWidth: 2, borderRadius: 2 },
  dashed: { borderStyle: 'dashed' },
  chip: {
    position: 'absolute',
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    maxWidth: 220,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.overlay,
  },
  chipAbove: { bottom: '100%', marginBottom: 2 },
  chipInside: { top: 4, left: 4 },
  chipBottom: { top: '100%', marginTop: 2 },
  chipText: { color: colors.white, fontSize: font.tiny, fontWeight: '600', flexShrink: 1 },
  spinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
});
