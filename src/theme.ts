import type { ConfidenceLevel } from '@/domain/types';

export const colors = {
  bg: '#12141A',
  surface: '#1E222B',
  line: '#2A2F3A',
  text: '#F5F6F8',
  muted: '#9AA3B2',
  primary: '#FFD02E',
  ok: '#2BD96B',
  warn: '#FF9F1C',
  error: '#FF4D4F',
  tileBg: '#F1F2F5',
  onPrimary: '#12141A',
  white: '#FFFFFF',
  overlay: 'rgba(0,0,0,0.55)',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 4, md: 10, lg: 16, pill: 999 } as const;
export const font = { title: 22, h2: 18, body: 16, small: 13, tiny: 11 } as const;
/** Minimum touch target in dp (acceptance criterion). */
export const touch = { min: 48 } as const;

export const levelColor: Record<ConfidenceLevel, string> = {
  accepted: colors.ok,
  review: colors.warn,
  unknown: colors.muted,
};

/** Ionicons names: ✓ / ? / –. */
export const levelIcon: Record<ConfidenceLevel, 'checkmark' | 'help' | 'remove'> = {
  accepted: 'checkmark',
  review: 'help',
  unknown: 'remove',
};
