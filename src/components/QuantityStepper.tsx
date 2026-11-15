import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, radius, spacing, touch } from '@/theme';
import { tpl } from '@/i18n/format';
import { ui } from '@/i18n/fr/ui';
import { Icon } from './Icon';
import { QTY_MAX, QTY_MIN, clampQuantity, parseQuantityInput } from './quantity';

const REPEAT_MS = 100;

/** − / value / +. The value is pressable: it turns into a numeric TextInput (select all), validated on
 *  blur/submit, clamped to min..max, non-numeric input reverts. Long-press on − / + repeats every 100 ms. */
export function QuantityStepper(p: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  /** a11y subject, e.g. 'Brique 2 × 4 Rouge' */
  label: string;
}): ReactElement {
  const min = p.min ?? QTY_MIN;
  const max = p.max ?? QTY_MAX;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editingRef = useRef(false);
  // Value used by the long-press repeat (props update asynchronously between ticks).
  const current = useRef(p.value);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onChangeRef = useRef(p.onChange);

  useEffect(() => {
    current.current = p.value;
  }, [p.value]);
  useEffect(() => {
    onChangeRef.current = p.onChange;
  }, [p.onChange]);
  useEffect(() => {
    const t = timer;
    return () => {
      if (t.current) clearInterval(t.current);
    };
  }, []);

  function step(delta: number): boolean {
    const next = clampQuantity(current.current + delta, min, max);
    if (next === current.current) return false;
    current.current = next;
    onChangeRef.current(next);
    return true;
  }
  function startRepeat(delta: number): void {
    stopRepeat();
    timer.current = setInterval(() => {
      if (!step(delta)) stopRepeat();
    }, REPEAT_MS);
  }
  function stopRepeat(): void {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }
  function commit(): void {
    if (!editingRef.current) return; // submit then blur: commit once
    editingRef.current = false;
    const next = parseQuantityInput(draft, p.value, min, max);
    setEditing(false);
    if (next !== p.value) {
      current.current = next;
      p.onChange(next);
    }
  }

  const canDec = p.value > min;
  const canInc = p.value < max;

  return (
    <View style={s.root}>
      <StepButton
        icon="remove"
        label={tpl(ui.quantity.decrease, { label: p.label })}
        disabled={!canDec}
        onPress={() => step(-1)}
        onLongPress={() => startRepeat(-1)}
        onPressOut={stopRepeat}
      />
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          selectTextOnFocus
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={String(max).length}
          onBlur={commit}
          onSubmitEditing={commit}
          accessibilityLabel={tpl(ui.quantity.edit, { label: p.label })}
          selectionColor={colors.primary}
          style={[s.value, s.input]}
        />
      ) : (
        <Pressable
          onPress={() => {
            setDraft(String(p.value));
            editingRef.current = true;
            setEditing(true);
          }}
          accessibilityRole="button"
          accessibilityLabel={tpl(ui.quantity.value, { n: p.value })}
          accessibilityHint={p.label}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'increment') step(1);
            else if (e.nativeEvent.actionName === 'decrement') step(-1);
          }}
          style={s.valueBox}
        >
          <Text style={s.value}>{p.value}</Text>
        </Pressable>
      )}
      <StepButton
        icon="add"
        label={tpl(ui.quantity.increase, { label: p.label })}
        disabled={!canInc}
        onPress={() => step(1)}
        onLongPress={() => startRepeat(1)}
        onPressOut={stopRepeat}
      />
    </View>
  );
}

function StepButton(p: {
  icon: 'add' | 'remove';
  label: string;
  disabled: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onPressOut: () => void;
}): ReactElement {
  return (
    <Pressable
      onPress={p.onPress}
      onLongPress={p.onLongPress}
      onPressOut={p.onPressOut}
      delayLongPress={350}
      disabled={p.disabled}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityHint={ui.quantity.hint}
      accessibilityState={{ disabled: p.disabled }}
      style={({ pressed }) => [s.btn, pressed && s.pressed, p.disabled && s.disabled]}
    >
      <Icon name={p.icon} size={22} color={colors.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  btn: { minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  valueBox: { minWidth: touch.min + 8, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
  value: {
    color: colors.text,
    fontSize: font.h2,
    fontWeight: '700',
    textAlign: 'center',
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    paddingHorizontal: spacing.xs,
  },
  input: {
    minWidth: touch.min + 8,
    minHeight: touch.min,
    textDecorationLine: 'none',
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingVertical: 0,
  },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
});
