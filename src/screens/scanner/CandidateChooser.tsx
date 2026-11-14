// RG_04 chooser: the real piece's crop next to the top candidates (image + name + score).
import type { ReactElement } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { Candidate } from '@/domain/types';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import { PartImage } from '@/components/PartImage';
import { confidenceLevel } from '@/domain/pile/thresholds';
import { displayName } from './display';
import { fmtPercent, tpl } from '@/i18n/format';
import { scanner } from '@/i18n/fr/scanner';
import { colors, font, radius, spacing, touch } from '@/theme';

const t = scanner.chooser;

export function CandidateChooser(p: {
  visible: boolean;
  onClose: () => void;
  /** IdentifiedPiece.cropUri / PileGroup.cropUri: photo of the real piece. */
  cropUri: string | null;
  candidates: readonly Candidate[];
  /** Identification still in flight: spinner « Identification… ». */
  pending: boolean;
  /** Brickognize unavailable for this piece (EX_09). */
  unavailable?: boolean;
  onChoose: (c: Candidate) => void;
}): ReactElement {
  return (
    <BottomSheet visible={p.visible} onClose={p.onClose} title={t.title}>
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        <View style={s.header}>
          {p.cropUri ? (
            <Image
              source={{ uri: p.cropUri }}
              style={s.crop}
              contentFit="contain"
              accessible
              accessibilityLabel={t.photo}
              accessibilityIgnoresInvertColors
            />
          ) : (
            <View style={[s.crop, s.cropEmpty]} />
          )}
          <Text style={s.title} accessibilityRole="header">
            {t.title}
          </Text>
        </View>
        {p.pending && p.candidates.length === 0 ? (
          <View style={s.pending} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.primary} />
            <Text style={s.muted}>{scanner.box.identifying}</Text>
          </View>
        ) : null}
        {!p.pending && p.candidates.length === 0 ? (
          <Text style={s.muted} accessibilityLiveRegion="polite">
            {p.unavailable ? t.unavailable : t.noCandidate}
          </Text>
        ) : null}
        {p.candidates.map((c) => {
          const name = displayName(c.name);
          return (
            <Pressable
              key={c.bricklinkId}
              onPress={() => p.onChoose(c)}
              style={({ pressed }) => [s.row, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel={tpl(t.candidateA11y, { name, id: c.bricklinkId, percent: fmtPercent(c.confidence) })}
              accessibilityHint={t.choose}
            >
              <PartImage uri={c.imageUrl} size={56} />
              <View style={s.rowText}>
                <Text style={s.name} numberOfLines={2}>
                  {name}
                </Text>
                <Text style={s.muted}>{c.bricklinkId}</Text>
              </View>
              <ConfidenceBadge level={confidenceLevel(c.confidence)} confidence={c.confidence} compact />
            </Pressable>
          );
        })}
        <Button label={t.none} variant="ghost" onPress={p.onClose} style={s.none} />
      </ScrollView>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  scroll: { maxHeight: 560 },
  content: { padding: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.sm },
  crop: { width: 96, height: 96, borderRadius: radius.md, backgroundColor: colors.tileBg },
  cropEmpty: { opacity: 0.4 },
  title: { flex: 1, color: colors.text, fontSize: font.h2, fontWeight: '700' },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touch.min,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  pressed: { opacity: 0.7 },
  rowText: { flex: 1 },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: font.small },
  none: { marginTop: spacing.sm },
});
