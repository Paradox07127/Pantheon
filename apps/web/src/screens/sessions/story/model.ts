import type { ChangeStory, ReviewFinding, StoryCard } from '@pantheon/domain';
import type { DiffHunk, LandingDiff } from '@pantheon/protocol';

/** A commit range merged into its source. */
export interface LandedPoint {
  kind: 'landed';
  workspace_id: string;
  task_goal: string | null;
  source: string;
  branch: string | null;
  from_sha: string;
  to_sha: string;
  at: number;
}

export interface PointFacts {
  /** Counts from a ready interpretation; null until one is ready. */
  story: {
    cards: number;
    out_of_scope: number;
    covered: number;
    hunk_total: number;
    cited: number;
    total: number;
  } | null;
}

/** The mechanical facts a timeline row shows; acceptance is the goal's acceptance list. */
export function pointFacts(story: ChangeStory | null, acceptance: readonly string[]): PointFacts {
  const result = story?.state === 'ready' ? story.result : undefined;
  if (!result) return { story: null };
  const total = acceptance.length;
  return {
    story: {
      cards: result.cards.length,
      out_of_scope: result.cards.filter((c) => c.out_of_scope).length,
      covered: result.hunk_total - result.uninterpreted.length,
      hunk_total: result.hunk_total,
      cited: total - result.unmatched_acceptance.length,
      total,
    },
  };
}

/** Added and removed lines in the card's hunks. */
export function cardLines(
  card: StoryCard,
  diff: LandingDiff,
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of diff.hunks) {
    if (!card.hunks.includes(hunk.id)) continue;
    for (const line of hunk.text.split('\n')) {
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  return { additions, deletions };
}

/** Whether the hunk removes old line `line` and that line holds the quote's first line. */
function removes(hunk: DiffHunk, line: number, quote: string): boolean {
  const first = quote.split('\n')[0]!.trim();
  let old = hunk.old_start;
  for (const text of hunk.text.split('\n')) {
    if (text.startsWith('-')) {
      if (old === line) return first !== '' && text.slice(1).trim().includes(first);
      old++;
    } else if (text.startsWith(' ')) old++;
  }
  return false;
}

/**
 * Findings whose location names a file one of the card's hunks changes, and when it gives a line,
 * a new line inside that hunk or a removed line that holds the finding's quote.
 */
export function cardFindings(
  card: StoryCard,
  diff: LandingDiff,
  findings: readonly ReviewFinding[],
): ReviewFinding[] {
  const own = diff.hunks.filter((h) => card.hunks.includes(h.id));
  return findings.filter((f) => {
    const at = /^(.+?)(?::(\d+)(?:-\d+)?)?$/.exec(f.location);
    const path = at?.[1];
    const line = at?.[2] === undefined ? NaN : Number(at[2]);
    return own.some(
      (h) =>
        path === h.file &&
        (Number.isNaN(line) ||
          (line >= h.new_start && line < h.new_start + h.new_lines) ||
          removes(h, line, f.quote)),
    );
  });
}
