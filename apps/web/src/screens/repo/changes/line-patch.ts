import type { DiffHunk } from '../../../data/patch';

/** Names one diff line in a selection by its hunk's index and its own. */
export const lineKey = (hunk: number, line: number) => `${hunk}:${line}`;

/** Each file's lines before its first hunk, as the patch has them, in the order `parsePatch` lists the files. */
export function fileHeaders(patch: string): string[] {
  const headers: string[] = [];
  let open = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      headers.push(line);
      open = true;
    } else if (line.startsWith('@@')) open = false;
    else if (open) headers[headers.length - 1] += `\n${line}`;
  }
  return headers;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * The patch `git apply -R` takes to drop the selected lines from the worktree, as git gui builds
 * it: a selected line keeps its sign, an unselected added line stays as context since the worktree
 * still holds it, an unselected removed line goes; only hunks with a selected line remain.
 */
export function discardPatch(
  file: string,
  hunks: readonly DiffHunk[],
  selected: ReadonlySet<string>,
): string {
  // A mode change is never a selected line, so the patch leaves it alone.
  const out = file.split('\n').filter((line) => !/^(old|new) mode /.test(line));
  // Lines the kept hunks so far add to the worktree over what is left after the discard.
  let shift = 0;
  hunks.forEach((hunk, h) => {
    const picked = (i: number) => hunk.lines[i]!.kind !== 'ctx' && selected.has(lineKey(h, i));
    if (!hunk.lines.some((_, i) => picked(i))) return;
    const body: string[] = [];
    let old = 0;
    let now = 0;
    hunk.lines.forEach((line, i) => {
      if (line.kind === 'del' && !picked(i)) return;
      const sign = !picked(i) ? ' ' : line.kind === 'add' ? '+' : '-';
      if (sign !== '+') old++;
      if (sign !== '-') now++;
      body.push(sign + line.text);
      if (line.noNewline) body.push('\\ No newline at end of file');
    });
    const [, , to, rest] = HUNK_HEAD.exec(hunk.header)!;
    // git apply -R looks for each hunk near its old start, so it must count the kept hunks before
    // it, not the full diff's; an empty side's start names the line before it.
    const first = now === 0 ? Number(to) + 1 : Number(to);
    const from = first - shift - (old === 0 ? 1 : 0);
    shift += now - old;
    out.push(`@@ -${from},${old} +${to},${now} @@${rest}`, ...body);
  });
  return `${out.join('\n')}\n`;
}
