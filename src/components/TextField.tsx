import { useState, type ReactElement } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';
import { ui } from '@/i18n/fr/ui';
import { IconButton } from './Button';
import { Icon } from './Icon';

/** Label above, error below (icon + text, announced with accessibilityLiveRegion="polite"). */
export function TextField(
  p: Omit<TextInputProps, 'style'> & {
    label: string;
    error?: string | null;
    /** password field with a show/hide toggle */
    secure?: boolean;
  },
): ReactElement {
  const { label, error, secure, onFocus, onBlur, editable, ...rest } = p;
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const hasError = !!error;
  return (
    <View style={s.root}>
      <Text style={s.label} importantForAccessibility="no" accessibilityElementsHidden>
        {label}
      </Text>
      <View
        style={[
          s.box,
          focused && s.boxFocused,
          hasError && s.boxError,
          editable === false && s.boxDisabled,
        ]}
      >
        <TextInput
          placeholderTextColor={colors.muted}
          selectionColor={colors.primary}
          {...(secure ? { autoCapitalize: 'none' as const, autoCorrect: false } : null)}
          {...rest}
          editable={editable}
          secureTextEntry={secure ? !revealed : rest.secureTextEntry}
          accessibilityLabel={label}
          accessibilityHint={hasError ? ui.field.errorPrefix + error : rest.accessibilityHint}
          accessibilityState={{ disabled: editable === false }}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={s.input}
        />
        {secure ? (
          <IconButton
            icon={revealed ? 'eye-off-outline' : 'eye-outline'}
            label={revealed ? ui.password.hide : ui.password.show}
            active={revealed}
            onPress={() => setRevealed((v) => !v)}
            size={22}
          />
        ) : null}
      </View>
      <View accessibilityLiveRegion="polite">
        {hasError ? (
          <View style={s.errorRow}>
            <Icon name="alert-circle" size={16} color={colors.error} />
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { gap: spacing.xs, marginBottom: spacing.md },
  label: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touch.min,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  boxFocused: { borderColor: colors.primary },
  boxError: { borderColor: colors.error, borderWidth: 2 },
  boxDisabled: { opacity: 0.5 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: font.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    minHeight: touch.min,
  },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  errorText: { color: colors.error, fontSize: font.small, flex: 1 },
});
