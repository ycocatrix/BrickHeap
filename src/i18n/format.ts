// Tiny formatting helpers (D18): no i18n library, no Intl.

/** Replaces every `{name}` with vars.name; unknown placeholders are left as is. */
export function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** French rule: |n| < 2 → singular. */
export function plural(n: number, one: string, other: string): string {
  return Math.abs(n) < 2 ? one : other;
}

/** 0.923 → '92 %' (clamped to 0..100). */
export function fmtPercent(confidence: number): string {
  const v = Number.isFinite(confidence) ? Math.round(confidence * 100) : 0;
  return `${Math.min(100, Math.max(0, v))} %`;
}

/** 7 → '7', 120 → '99+'. */
export function fmtBadge(quantity: number): string {
  return quantity > 99 ? '99+' : String(quantity);
}

/** 1234 → '1 234' (space thousands separator). */
export function fmtCount(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.trunc(Math.abs(n)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
