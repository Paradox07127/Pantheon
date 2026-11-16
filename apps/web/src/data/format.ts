export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Splits path before its last two segments; a trailing slash stays with the last one. */
export function splitPath(path: string): [head: string, tail: string] {
  const trimmed = path.replace(/[\\/]+$/, '');
  const separators = [...trimmed.matchAll(/[\\/]/g)];
  const cut = separators.at(-2)?.index ?? -1;
  return cut > 0 ? [path.slice(0, cut), path.slice(cut)] : ['', path];
}
