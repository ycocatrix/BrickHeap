import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme';

/** Colour swatch. Decorative: the colour name must always be shown next to it (§7.2-3).
 *  null → hatched « ? » dot; isTrans → see-through fill with a diagonal highlight. Accepts 'C91A09' or '#C91A09'. */
export function ColorDot(p: { hex: string | null; size?: number; isTrans?: boolean }): ReactElement {
  const size = p.size ?? 16;
  const hex = p.hex ? p.hex.replace(/^#/, '') : null;
  const ring = { width: size, height: size, borderRadius: size / 2 };
  if (!hex) {
    return (
      <View accessible={false} importantForAccessibility="no-hide-descendants" style={[s.base, s.unknown, ring]}>
        <View style={[s.hatch, { width: size * 1.5, left: -size * 0.25, top: size / 2 - 1 }]} />
        <Text style={[s.q, { fontSize: Math.max(8, size * 0.6), lineHeight: size }]} allowFontScaling={false}>
          ?
        </Text>
      </View>
    );
  }
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[s.base, ring, p.isTrans && s.transBg]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: '#' + hex, opacity: p.isTrans ? 0.55 : 1 }]} />
      {p.isTrans ? (
        <View style={[s.glint, { width: size * 1.5, left: -size * 0.25, top: size * 0.35, height: Math.max(2, size * 0.14) }]} />
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  base: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unknown: { backgroundColor: colors.surface, borderStyle: 'dashed' },
  hatch: { position: 'absolute', height: 2, backgroundColor: colors.line, transform: [{ rotate: '-45deg' }] },
  q: { color: colors.text, fontWeight: '700', textAlign: 'center' },
  transBg: { backgroundColor: colors.white },
  glint: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.7)', transform: [{ rotate: '-45deg' }] },
});
