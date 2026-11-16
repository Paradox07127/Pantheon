import type { FileRef } from '@pantheon/protocol';

export type LinkTarget = { kind: 'web'; url: string } | { kind: 'file'; ref: FileRef };

const WEB_SCHEMES = ['http', 'https', 'mailto'];
const SCHEME = /^([a-z][a-z\d+.-]*):/i;
const LINE_AT_END = /^(.+?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/;

/** Splits `path:line[:col]` or `path#L<line>[C<col>]`. */
function withLine(text: string): FileRef {
  const match = LINE_AT_END.exec(text);
  if (!match) return { path: text };
  const line = Number(match[2] ?? match[4]);
  const column = match[3] ?? match[5];
  return column === undefined
    ? { path: match[1]!, line }
    : { path: match[1]!, line, column: Number(column) };
}

// Markdown percent-encodes link destinations, so a path with spaces or CJK names arrives encoded.
const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** What clicking a Markdown link opens; null for anchors and unsupported protocols. */
export function linkTarget(href: string): LinkTarget | null {
  if (href === '' || href.startsWith('#')) return null;
  const scheme = SCHEME.exec(href)?.[1];
  if (scheme === undefined) return { kind: 'file', ref: withLine(decoded(href)) };
  const lower = scheme.toLowerCase();
  if (WEB_SCHEMES.includes(lower)) return { kind: 'web', url: href };
  if (lower === 'file') return { kind: 'file', ref: withLine(lower + href.slice(scheme.length)) };
  // `name.ext:12` reads as a scheme but is a file and line.
  if (/^\d/.test(href.slice(scheme.length + 1)))
    return { kind: 'file', ref: withLine(decoded(href)) };
  return null;
}

/** The file inline code names, or null when the code does not look like a path. */
export function codePath(text: string): FileRef | null {
  if (/\s/.test(text) || text.includes('://')) return null;
  if (!text.includes('/') && !/^[^:/]+\.\w+:\d+(?::\d+)?$/.test(text)) return null;
  return withLine(text);
}
