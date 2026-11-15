import type { ComponentProps, ReactElement } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** Decorative icon: hidden from screen readers (the surrounding control carries the label). */
export function Icon(p: { name: IconName; size?: number; color?: string }): ReactElement {
  return (
    <Ionicons
      name={p.name}
      size={p.size ?? 24}
      color={p.color ?? colors.text}
      accessible={false}
      importantForAccessibility="no"
    />
  );
}
