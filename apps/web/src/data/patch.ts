export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  /** Git's `\ No newline at end of file` follows this line. */
  noNewline?: true;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  status?: 'A' | 'D';
}

const ESCAPES: Partial<Record<string, number>> = {
  n: 10,
  t: 9,
  r: 13,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  '\\': 92,
  '"': 34,
};

/**
 * Reads git's C-style quoted string whose opening quote is at `start`; null when it is not closed
 * or holds an escape git does not write.
 */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let plain = start + 1;
  for (let i = plain; i < text.length;) {
    const c = text[i];
    if (c !== '"' && c !== '\\') {
      i++;
      continue;
    }
    bytes.push(...encoder.encode(text.slice(plain, i)));
    if (c === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(i + 1, i + 4));
    const escape = ESCAPES[text[i + 1] ?? ''];
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 4;
    } else if (escape !== undefined) {
      bytes.push(escape);
      i += 2;
    } else return null;
    plain = i;
  }
  return null;
}

/** Undoes git's C-style quoting of paths with special or non-ASCII bytes; keeps malformed text as is. */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  const quoted = readQuoted(value, 0);
  return quoted?.end === value.length ? quoted.value : value;
}

/** `a/x` or `"a/x"` without its a/ or b/ prefix. */
function sidePath(value: string): string {
  return unquote(value).replace(/^[ab]\//, '');
}

/** The new side of a `diff --git` header, where either path may be quoted or hold spaces. */
function headerPath(header: string): string {
  if (header.startsWith('"')) {
    const old = readQuoted(header, 0);
    return sidePath(old && header[old.end] === ' ' ? header.slice(old.end + 1) : header);
  }
  // An unquoted path never holds a quote.
  const quoted = header.indexOf(' "');
  if (quoted >= 0) return sidePath(header.slice(quoted + 1));
  // Without a rename both sides name one path, so the header is `a/<path> b/<path>`.
  const half = (header.length - 1) / 2;
  if (
    header[half] === ' ' &&
    header.startsWith('a/') &&
    header.startsWith('b/', half + 1) &&
    header.slice(2, half) === header.slice(half + 3)
  )
    return header.slice(half + 3);
  return sidePath(header.slice(header.lastIndexOf(' b/') + 1));
}

/** The name in a `---` or `+++` line; git ends a name that holds a space with a tab. */
const markerName = (line: string): string => line.slice(4).replace(/\t$/, '');

/** Splits `git diff` output into files at `diff --git` and into hunks at `@@`; binary files have no hunks. */
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let named = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: headerPath(line.slice('diff --git '.length)), hunks: [] };
      files.push(file);
      hunk = null;
      named = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@')) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // The new side names the file; a deletion only has the old side.
      if (line.startsWith('new file mode ')) file.status = 'A';
      else if (line.startsWith('deleted file mode ')) file.status = 'D';
      else if (line.startsWith('rename to ')) {
        file.path = unquote(line.slice('rename to '.length));
        named = true;
      } else if (line.startsWith('+++ ') && markerName(line) !== '/dev/null') {
        file.path = sidePath(markerName(line));
        named = true;
      } else if (line.startsWith('--- ') && markerName(line) !== '/dev/null' && !named)
        file.path = sidePath(markerName(line));
      continue;
    }
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line[0] === ' ' ? 'ctx' : null;
    if (kind) hunk.lines.push({ kind, text: line.slice(1) });
    else if (line.startsWith('\\') && hunk.lines.length > 0) hunk.lines.at(-1)!.noNewline = true;
  }
  return files;
}
