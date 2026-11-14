import { useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { colors, radius } from '@/theme';
import { ColorDot } from './ColorDot';
import { Icon } from './Icon';

/** expo-image, contentFit 'contain', background colors.tileBg, cachePolicy 'disk', cube icon placeholder (no uri or
 *  load error). `colorCue` draws a ColorDot bottom-left with a white ring, for images not known to be coloured. */
export function PartImage(p: {
  uri: string | null;
  size: number;
  accessibilityLabel?: string;
  /** Colour cue drawn on the image (ColorDot, bottom-left, white ring). */
  colorCue?: { hex: string; isTrans: boolean } | null;
}): ReactElement {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const showImage = !!p.uri && failedUri !== p.uri;
  const cue = Math.max(12, Math.round(p.size * 0.22));
  const inset = Math.max(2, Math.round(p.size * 0.05));
  return (
    <View
      accessible={!!p.accessibilityLabel}
      accessibilityRole={p.accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={p.accessibilityLabel}
      importantForAccessibility={p.accessibilityLabel ? 'yes' : 'no-hide-descendants'}
      style={[s.tile, { width: p.size, height: p.size }]}
    >
      {showImage ? (
        <Image
          source={{ uri: p.uri as string }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          cachePolicy="disk"
          transition={0}
          recyclingKey={p.uri}
          accessible={false}
          onError={() => setFailedUri(p.uri)}
        />
      ) : (
        <Icon name="cube-outline" size={Math.round(p.size * 0.45)} color={colors.muted} />
      )}
      {p.colorCue ? (
        <View style={[s.cue, { left: inset, bottom: inset, borderRadius: (cue + 4) / 2 }]}>
          <ColorDot hex={p.colorCue.hex} isTrans={p.colorCue.isTrans} size={cue} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  tile: {
    backgroundColor: colors.tileBg,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cue: { position: 'absolute', borderWidth: 2, borderColor: colors.white, backgroundColor: colors.white },
});
