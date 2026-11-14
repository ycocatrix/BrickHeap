import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, radius } from '@/theme';
import { fmtBadge, tpl } from '@/i18n/format';
import { ui } from '@/i18n/fr/ui';

/** Yellow pill, fmtBadge (7 → '7', 120 → '99+'); the screen reader gets the exact quantity. */
export function QuantityBadge(p: { quantity: number }): ReactElement {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={tpl(ui.quantity.badge, { n: p.quantity })}
      style={s.pill}
    >
      <Text style={s.text} maxFontSizeMultiplier={1.4}>
        {fmtBadge(p.quantity)}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: {
    minWidth: 24,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  text: { color: colors.onPrimary, fontSize: font.small, fontWeight: '800' },
});
