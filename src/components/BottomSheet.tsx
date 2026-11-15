import type { ReactElement, ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, radius, spacing } from '@/theme';
import { common } from '@/i18n/fr/common';
import { ui } from '@/i18n/fr/ui';
import { IconButton } from './Button';
import { useReduceMotion } from './useReduceMotion';

/** RN Modal (transparent, slide). Backdrop press, the close button and Android back call onClose.
 *  Bottom inset applied, accessibilityViewIsModal. Content taller than 90 % of the screen must scroll itself. */
export function BottomSheet(p: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }): ReactElement {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  return (
    <Modal
      visible={p.visible}
      transparent
      animationType={reduceMotion ? 'none' : 'slide'}
      statusBarTranslucent
      onRequestClose={p.onClose}
    >
      <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={[StyleSheet.absoluteFill, s.backdrop]}
          onPress={p.onClose}
          accessibilityRole="button"
          accessibilityLabel={ui.sheet.backdrop}
        />
        <View
          accessibilityViewIsModal
          style={[s.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md), maxHeight: '90%' }]}
        >
          <View style={s.grabber} importantForAccessibility="no" accessibilityElementsHidden />
          <View style={s.header}>
            <View style={s.titleBox}>
              {p.title ? (
                <Text style={s.title} accessibilityRole="header">
                  {p.title}
                </Text>
              ) : null}
            </View>
            <IconButton icon="close" label={common.actions.close} onPress={p.onClose} />
          </View>
          <View style={s.body}>{p.children}</View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: colors.overlay },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: colors.line,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginTop: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.xs },
  titleBox: { flex: 1 },
  title: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  body: { flexShrink: 1, paddingHorizontal: spacing.lg },
});
