import type { ReactElement, ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, spacing } from '@/theme';
import { common } from '@/i18n/fr/common';
import { IconButton } from './Button';

/** Safe-area top/left/right, title row with optional back button, optional fixed footer (bottom inset applied).
 *  The header row is omitted when there is no title, back button nor right content. */
export function Screen(p: {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
  scroll?: boolean;
  /** fixed bottom bar, bottom inset applied */
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const insets = useSafeAreaInsets();
  const hasHeader = !!(p.title || p.onBack || p.right);
  return (
    <View style={[s.root, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      {hasHeader ? (
        <View style={[s.header, !p.onBack && s.headerNoBack]}>
          {p.onBack ? <IconButton icon="chevron-back" label={common.actions.back} onPress={p.onBack} size={26} /> : null}
          <View style={s.titleBox}>
            {p.title ? (
              <Text style={s.title} accessibilityRole="header">
                {p.title}
              </Text>
            ) : null}
          </View>
          {p.right ? <View style={s.right}>{p.right}</View> : null}
        </View>
      ) : null}
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {p.scroll ? (
          <ScrollView
            style={s.flex}
            contentContainerStyle={s.scrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {p.children}
          </ScrollView>
        ) : (
          <View style={[s.flex, s.body]}>{p.children}</View>
        )}
        {p.footer ? (
          <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>{p.footer}</View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  headerNoBack: { paddingLeft: spacing.lg },
  titleBox: { flex: 1, justifyContent: 'center' },
  title: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  right: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  body: { paddingHorizontal: spacing.lg },
  scrollContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
});
