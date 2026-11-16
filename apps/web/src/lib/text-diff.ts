export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const lines = (text: string): string[] =>
  text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

const MAX_CELLS = 1_000_000;

/** Line diff by longest common subsequence; in a changed run the removed lines come first. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  // A table this large stalls the render that asks for it; the changed run shows as one block.
  if ((x.length + 1) * (y.length + 1) > MAX_CELLS)
    return [
      ...a.slice(0, head).map((text): DiffLine => ({ kind: 'same', text })),
      ...x.map((text): DiffLine => ({ kind: 'del', text })),
      ...y.map((text): DiffLine => ({ kind: 'add', text })),
      ...a.slice(a.length - tail).map((text): DiffLine => ({ kind: 'same', text })),
    ];
  // common[i][j]: longest common run of x[i..] and y[j..].
  const common = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      common[i]![j] =
        x[i] === y[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (j >= y.length || (i < x.length && common[i + 1]![j]! >= common[i]![j + 1]!)) {
      out.push({ kind: 'del', text: x[i++]! });
    } else {
      out.push({ kind: 'add', text: y[j++]! });
    }
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text });
  return out;
}
