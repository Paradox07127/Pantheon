/* Moving a key within an order */

/** Moves `key` to just before `before`, or to the end when `before` is null. */
export function moveBefore(order: readonly string[], key: string, before: string | null): string[] {
  const rest = order.filter((k) => k !== key);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** Moves `key` past its neighbour in `shown` towards `step`; at either end it stays. */
export function stepKey(
  order: readonly string[],
  shown: readonly string[],
  key: string,
  step: -1 | 1,
): string[] {
  const next = shown[shown.indexOf(key) + step];
  if (next === undefined) return [...order];
  if (step < 0) return moveBefore(order, key, next);
  const rest = order.filter((k) => k !== key);
  return [...rest.slice(0, rest.indexOf(next) + 1), key, ...rest.slice(rest.indexOf(next) + 1)];
}
