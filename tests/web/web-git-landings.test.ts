import { describe, expect, it } from 'vitest';
import type { ChangeStory, ReviewFinding, StoryCard, StoryResult } from '@pantheon/domain';
import type { DiffHunk, LandingDiff } from '@pantheon/protocol';
import { cardFindings, cardLines, pointFacts } from '@/screens/sessions/story/model';

const story = (id: string, created_at: number, extra: Partial<ChangeStory> = {}): ChangeStory => ({
  id,
  revision: 1,
  project_id: 'project',
  source: '/repo',
  from_sha: 'a0',
  to_sha: 'a1',
  state: 'running',
  created_at,
  ...extra,
});

const card = (hunks: string[], extra: Partial<StoryCard> = {}): StoryCard => ({
  title: 'Login form',
  kind: 'added',
  surface: 'ui',
  acceptance: [0],
  before: 'no form',
  after: 'a form',
  how: [],
  hunks,
  tests: [],
  out_of_scope: false,
  evidence: [],
  shared_with: [],
  ...extra,
});

const hunk = (id: string, file: string, text: string): DiffHunk => ({
  id,
  file,
  header: '@@ -1,1 +1,1 @@',
  old_start: 1,
  old_lines: 1,
  new_start: 1,
  new_lines: 1,
  text,
});

const diff = (hunks: DiffHunk[]): LandingDiff => ({
  source: '/repo',
  from_sha: 'a0',
  to_sha: 'a1',
  files: [],
  hunks,
  truncated: false,
});

const finding = (id: string, location: string): ReviewFinding => ({
  id,
  review_id: 'review',
  runtime: 'codex',
  round: 1,
  location,
  quote: 'quote',
  evidence: 'evidence',
  impact: 'impact',
  status: 'open',
  blocking: false,
});

describe('point facts', () => {
  const result: StoryResult = {
    overall: { before: [], after: [] },
    cards: [card(['H1']), card(['H2'], { acceptance: [], out_of_scope: true })],
    noise: ['H3'],
    uninterpreted: ['H4'],
    hunk_total: 4,
    unmatched_acceptance: [1],
  };

  it('gives no counts until the story is ready', () => {
    expect(pointFacts(null, ['a', 'b'])).toEqual({ story: null });
    expect(pointFacts(story('s', 1, { result }), ['a', 'b'])).toEqual({ story: null });
  });

  it('counts cards, out-of-scope cards, covered hunks and cited acceptance of a ready story', () => {
    expect(pointFacts(story('s', 1, { state: 'ready', result }), ['a', 'b'])).toEqual({
      story: { cards: 2, out_of_scope: 1, covered: 3, hunk_total: 4, cited: 1, total: 2 },
    });
  });
});

describe('card lines', () => {
  it("counts added and removed lines in the card's hunks only", () => {
    const d = diff([
      hunk('H1', 'a.ts', ' keep\n-old\n+new\n+more'),
      hunk('H2', 'b.ts', '-gone\n-gone too\n\\ No newline at end of file'),
      hunk('H3', 'c.ts', '+not this card'),
    ]);
    expect(cardLines(card(['H1', 'H2']), d)).toEqual({ additions: 2, deletions: 3 });
  });
});

describe('card findings', () => {
  it("keeps findings whose location names a file the card's hunks change", () => {
    const d = diff([hunk('H1', 'src/a.ts', '+x'), hunk('H2', 'src/b.ts', '+y')]);
    const found = cardFindings(card(['H1']), d, [
      finding('in', 'src/a.ts:1'),
      finding('other-file', 'src/b.ts:3'),
      finding('nowhere', 'README.md'),
    ]);
    expect(found.map((f) => f.id)).toEqual(['in']);
  });

  it('keeps a finding with a line only for the card whose hunk covers that line', () => {
    const d = diff([
      { ...hunk('H1', 'src/a.ts', '+x'), new_start: 10, new_lines: 5 },
      { ...hunk('H2', 'src/a.ts', '+y'), new_start: 100, new_lines: 5 },
    ]);
    const findings = [finding('late', 'src/a.ts:102'), finding('file', 'src/a.ts')];
    expect(cardFindings(card(['H1']), d, findings).map((f) => f.id)).toEqual(['file']);
    expect(cardFindings(card(['H2']), d, findings).map((f) => f.id)).toEqual(['late', 'file']);
  });

  it('matches the whole path, not a path that ends with it', () => {
    const d = diff([hunk('H1', 'src/a.ts', '+x')]);
    const found = cardFindings(card(['H1']), d, [
      finding('nested', 'test/src/a.ts:1'),
      finding('nested-file', 'test/src/a.ts'),
    ]);
    expect(found).toEqual([]);
  });

  it('keeps a finding on a removed line of a hunk that only deletes', () => {
    const d = diff([
      {
        ...hunk('H1', 'src/a.ts', ' keep();\n-gone();'),
        old_start: 9,
        old_lines: 2,
        new_start: 9,
        new_lines: 1,
      },
    ]);
    const findings = [
      { ...finding('removed', 'src/a.ts:10'), quote: 'gone();' },
      { ...finding('elsewhere', 'src/a.ts:10'), quote: 'other();' },
    ];
    expect(cardFindings(card(['H1']), d, findings).map((f) => f.id)).toEqual(['removed']);
  });
});
