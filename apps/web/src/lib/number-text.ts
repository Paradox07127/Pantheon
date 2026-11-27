export function tokenText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** `tokenText` rounded down, for a count that is only a lower bound. */
export function tokenFloorText(n: number): string {
  if (n >= 1e6) return `${(Math.floor(n / 1e5) / 10).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.floor(n / 1e3)}k`;
  return String(Math.floor(n));
}

export function usdText(value: number | null): string {
  return value == null ? '—' : `$${value.toFixed(2)}`;
}
