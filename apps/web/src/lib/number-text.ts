export function tokenText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function usdText(value: number | null): string {
  return value == null ? '—' : `$${value.toFixed(2)}`;
}
