// Fenced code, indented code after a blank line, inline code spans and escaped backslashes are
// matched first so delimiters inside or after them stay literal.
const segments =
  /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\3[`~]*[ \t]*(?=\n|$)|$)|(?:^|\n[ \t]*\n)(?: {4}| {0,3}\t)[^\n]*(?:\n(?:(?: {4}| {0,3}\t)[^\n]*|[ \t]*(?=\n)))*|(`+)[\s\S]*?[^`]\4(?!`)|\\\\|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

/** Rewrites `\(…\)` and `\[…\]` into the `$$` delimiters remark-math understands. */
export function normalizeMathDelimiters(text: string): string {
  return text.replace(
    segments,
    (match, _lead, _indent, _fence, _tick, inline?: string, display?: string) => {
      if (inline !== undefined) return `$$${inline}$$`;
      if (display !== undefined) return `\n$$\n${display}\n$$\n`;
      return match;
    },
  );
}
