import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ReviewFinding,
  StoryCardInput,
  StoryDiagram,
  StorySubmission,
} from '@pantheon/domain';
import type { DiffHunk, LandingDiff, LandingDiffFile } from '@pantheon/protocol';
import { cardPatch, checkStory } from '../../packages/control/src/change-story-check.js';
import { renderStoryBrief } from '../../packages/control/src/change-story-brief.js';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

function hunk(id: string, file: string, text: string, noise?: DiffHunk['noise']): DiffHunk {
  return {
    id,
    file,
    header: '@@ -1,1 +1,1 @@',
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: 1,
    text,
    ...(noise && { noise }),
  };
}

const diff: LandingDiff = {
  source: 'main',
  from_sha: FROM,
  to_sha: TO,
  files: [
    { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/b.ts', status: 'modified', additions: 1, deletions: 0 },
    { path: 'tests/a.test.ts', status: 'modified', additions: 1, deletions: 0 },
    { path: 'docs.md', status: 'modified', additions: 1, deletions: 1 },
  ],
  hunks: [
    hunk('H1', 'src/a.ts', ' export function a() {\n-  const value = 1;\n+  const value = 2;'),
    hunk('H2', 'src/b.ts', '+export const b = true;'),
    hunk('H3', 'tests/a.test.ts', "+it('reads the value', () => {});"),
    hunk('H4', 'docs.md', '-Some  text\n+Some text', 'whitespace'),
  ],
  truncated: false,
};

const task = {
  goal: 'Raise the value to two',
  acceptance: ['The value is two', 'b is exported', 'The docs read cleanly'],
} satisfies Parameters<typeof renderStoryBrief>[0];

function card(overrides: Partial<StoryCardInput> = {}): StoryCardInput {
  return {
    title: 'Raise the value',
    kind: 'behavior',
    surface: 'internal',
    acceptance: [0],
    before: 'The value is one',
    after: 'The value is two',
    how: [{ text: 'Change the constant', hunks: ['H1'] }],
    hunks: ['H1', 'H3'],
    tests: ['H3'],
    ...overrides,
  };
}

function submission(overrides: Partial<StorySubmission> = {}): StorySubmission {
  return {
    overall: { before: ['one'], after: ['two'] },
    cards: [
      card(),
      card({ title: 'Export b', acceptance: [1], how: [], hunks: ['H2'], tests: [] }),
    ],
    noise: ['H4'],
    ...overrides,
  };
}

const files: Record<string, string> = {
  [`${FROM}:src/a.ts`]: 'export function a() {\n  const value = 1;\n}\n',
  [`${TO}:src/a.ts`]: 'export function a() {\n  const value = 2;\n}\n',
};
function stub() {
  const calls: string[] = [];
  const show = (sha: string, file: string) => {
    calls.push(`${sha}:${file}`);
    return files[`${sha}:${file}`] ?? null;
  };
  return { calls, show };
}

function run(
  input: StorySubmission,
  extra: { gates?: Parameters<typeof checkStory>[0]['gates'] } = {},
) {
  return checkStory({
    diff,
    task,
    gates: extra.gates ?? [],
    submission: input,
    show: stub().show,
  });
}

function errorsOf(input: StorySubmission): string[] {
  const result = run(input);
  if (result.ok) throw new Error('expected errors');
  return result.errors;
}

function resultOf(
  input: StorySubmission,
  extra: Parameters<typeof run>[1] = {},
): Extract<ReturnType<typeof checkStory>, { ok: true }>['result'] {
  const result = run(input, extra);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.result;
}

function withDiagram(diagram: StoryDiagram): StorySubmission {
  return submission({ cards: [card({ diagram }), submission().cards[1]!] });
}

describe('checkStory hard errors', () => {
  it('rejects hunk ids that are not in the diff wherever they are cited', () => {
    const errors = errorsOf(
      submission({
        cards: [
          card({
            hunks: ['H1', 'H3', 'H9'],
            how: [{ text: 'x', hunks: ['H8'] }],
            tests: ['H7'],
          }),
        ],
        noise: ['H4', 'H6'],
      }),
    );
    for (const id of ['H9', 'H8', 'H7', 'H6'])
      expect(errors.some((error) => error.includes(`${id}, which is not a hunk in the diff`))).toBe(
        true,
      );
  });

  it('rejects unpaired overall lines', () => {
    expect(errorsOf(submission({ overall: { before: ['one'], after: [] } }))[0]).toMatch(
      /overall\.before has 1 entries but overall\.after has 0/,
    );
  });

  it.each<[string, StorySubmission, string[]]>([
    [
      'rejects how and tests hunks outside the card',
      submission({
        cards: [card({ how: [{ text: 'x', hunks: ['H2'] }], tests: ['H2'], hunks: ['H1'] })],
      }),
      [
        "card 0 how[0] cites H2, which is not in the card's hunks.",
        "card 0 tests cites H2, which is not in the card's hunks.",
      ],
    ],
    [
      'rejects acceptance indexes past the task list',
      submission({ cards: [card({ acceptance: [3] })] }),
      ['card 0 acceptance cites 3, but the task has 3 acceptance items.'],
    ],
    [
      'rejects a hunk that is both noise and in a card',
      submission({ noise: ['H4', 'H2'] }),
      ['card 1 hunks cites H2, which is also in noise.'],
    ],
    [
      'rejects a flow diagram whose nodes, lanes or edges do not line up',
      withDiagram({
        type: 'flow',
        title: 'Dispatch',
        lanes: ['control'],
        nodes: [
          { id: 'n1', label: 'a', lane: 'control', side: 'both' },
          { id: 'n1', label: 'b', lane: 'daemon', side: 'both' },
        ],
        edges: [{ from: 'n1', to: 'n2', side: 'after' }],
      }),
      [
        'card 0 flow node id n1 is used more than once.',
        'card 0 flow node n1 is in lane daemon, which is not in lanes.',
        'card 0 flow edge n1 -> n2 names n2, which is not a node id.',
      ],
    ],
    [
      'rejects a flow edge on a side where one of its nodes does not appear',
      withDiagram({
        type: 'flow',
        title: 'Dispatch',
        lanes: ['control'],
        nodes: [
          { id: 'old', label: 'a', lane: 'control', side: 'before' },
          { id: 'new', label: 'b', lane: 'control', side: 'after' },
          { id: 'kept', label: 'c', lane: 'control', side: 'both' },
        ],
        edges: [
          { from: 'kept', to: 'new', side: 'both' },
          { from: 'old', to: 'kept', side: 'after' },
          { from: 'kept', to: 'old', side: 'before' },
          { from: 'kept', to: 'new', side: 'after' },
        ],
      }),
      [
        'card 0 flow edge kept -> new is on side both, but node new is only on side after.',
        'card 0 flow edge old -> kept is on side after, but node old is only on side before.',
      ],
    ],
    [
      'rejects a ui sketch with a repeated region or an unknown parent',
      withDiagram({
        type: 'ui',
        title: 'Panel',
        regions: [
          { id: 'r1', label: 'a', side: 'both' },
          { id: 'r1', label: 'b', side: 'both' },
          { id: 'r2', label: 'c', parent: 'r9', side: 'after' },
        ],
      }),
      [
        'card 0 ui region id r1 is used more than once.',
        'card 0 ui region r2 has parent r9, which is not a region id.',
      ],
    ],
  ])('%s', (_name, input, errors) => {
    expect(errorsOf(input)).toEqual(errors);
  });
});

describe('checkStory results', () => {
  it('reports unclaimed hunks, out-of-scope cards, uncited acceptance and shared hunks', () => {
    const result = resultOf(
      submission({
        cards: [
          card({ hunks: ['H1', 'H3'] }),
          card({ title: 'Side change', acceptance: [], how: [], hunks: ['H1'], tests: [] }),
        ],
        noise: [],
      }),
    );
    expect(result.hunk_total).toBe(4);
    expect(result.uninterpreted).toEqual(['H2', 'H4']);
    expect(result.unmatched_acceptance).toEqual([1, 2]);
    expect(result.cards.map((entry) => entry.out_of_scope)).toEqual([false, true]);
    expect(result.cards.map((entry) => entry.shared_with)).toEqual([[1], [0]]);
  });

  it('marks no card out of scope when the task lists no acceptance items', () => {
    const result = checkStory({
      diff,
      task: { acceptance: [] },
      gates: [],
      submission: submission({
        cards: [
          card({ acceptance: [] }),
          card({ title: 'Export b', acceptance: [], how: [], hunks: ['H2'], tests: [] }),
        ],
      }),
      show: stub().show,
    });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.result.cards.map((entry) => entry.out_of_scope)).toEqual([false, false]);
    expect(result.result.unmatched_acceptance).toEqual([]);
  });

  it('cites landing gates whose output names a test file', () => {
    const gate = (name: string, exit_code: number, output: string) => ({
      name,
      argv: ['pnpm', 'test'],
      exit_code,
      duration_ms: 1,
      timed_out: false,
      output,
    });
    const result = resultOf(submission(), {
      gates: [gate('test', 1, 'FAIL a.test.ts'), gate('lint', 0, 'clean')],
    });
    expect(result.cards[0]!.evidence).toEqual([
      { source: 'gate', id: 'test', label: 'pnpm test', status: 'failed' },
    ]);
  });

  it('never reports a timed-out command as passed even when its exit code is zero', () => {
    const result = resultOf(submission(), {
      gates: [
        {
          name: 'Test',
          argv: ['pnpm', 'test'],
          exit_code: 0,
          timed_out: true,
          duration_ms: 1,
          output: 'a.test.ts',
        },
      ],
    });
    expect(result.cards[0]!.evidence[0]?.status).toBe('failed');
  });
});

describe('checkStory diagrams', () => {
  const flow = (nodes: Extract<StoryDiagram, { type: 'flow' }>['nodes']): StoryDiagram => ({
    type: 'flow',
    title: 'Value',
    lanes: ['control'],
    nodes,
    edges: [],
  });

  it('keeps anchors that occur at their commits and maps them to hunks', () => {
    const { calls, show } = stub();
    const result = checkStory({
      diff,
      task,
      gates: [],
      show,
      submission: withDiagram(
        flow([
          {
            id: 'old',
            label: 'one',
            lane: 'control',
            side: 'before',
            anchor: { file: 'src/a.ts', quote: 'const value = 1;' },
          },
          {
            id: 'new',
            label: 'two',
            lane: 'control',
            side: 'after',
            anchor: { file: 'src/a.ts', quote: 'const value = 2;' },
          },
          {
            id: 'both',
            label: 'fn',
            lane: 'control',
            side: 'both',
            anchor: { file: 'src/a.ts', quote: 'export function a() {' },
          },
          { id: 'guess', label: 'guess', lane: 'control', side: 'after' },
        ]),
      ),
    });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.result.cards[0]!.diagram).toMatchObject({
      inferred: ['guess'],
      hunks: { old: 'H1', new: 'H1', both: 'H1' },
    });
    expect(calls.sort()).toEqual([`${FROM}:src/a.ts`, `${TO}:src/a.ts`]);
  });

  it('infers anchors whose quote is not at the commit', () => {
    const result = resultOf(
      withDiagram(
        flow([
          {
            id: 'wrong',
            label: 'x',
            lane: 'control',
            side: 'before',
            anchor: { file: 'src/a.ts', quote: 'const value = 2;' },
          },
          {
            id: 'right',
            label: 'y',
            lane: 'control',
            side: 'after',
            anchor: { file: 'src/a.ts', quote: 'const value = 2;' },
          },
        ]),
      ),
    );
    expect(result.cards[0]!.diagram).toMatchObject({ inferred: ['wrong'], hunks: { right: 'H1' } });
  });

  it('drops a diagram when more than half its elements are inferred', () => {
    const result = resultOf(
      withDiagram({
        type: 'decision',
        title: 'Value rule',
        rows: [
          {
            case: 'default',
            before: 'one',
            after: 'two',
            before_anchor: { file: 'src/a.ts', quote: 'const value = 1;' },
            after_anchor: { file: 'src/a.ts', quote: 'const value = 2;' },
          },
          { case: 'unanchored', before: 'a', after: 'b' },
          {
            case: 'wrong',
            before: 'a',
            after: 'b',
            after_anchor: { file: 'src/a.ts', quote: 'const value = 1;' },
          },
        ],
      }),
    );
    expect(result.cards[0]).not.toHaveProperty('diagram');
  });

  it('infers a both-sides element missing from one commit', () => {
    const result = resultOf(
      withDiagram({
        type: 'type',
        name: 'Value',
        file: 'src/a.ts',
        fields: [
          { name: 'value', type: 'one', side: 'before', quote: 'const value = 1;' },
          { name: 'value', type: 'two', side: 'both', quote: 'const value = 2;' },
        ],
      }),
    );
    expect(result.cards[0]!.diagram).toMatchObject({ inferred: ['1'], hunks: { '0': 'H1' } });
  });

  it('infers a both-sides region whose file is missing at one commit', () => {
    const anchor = { file: 'src/b.ts', quote: 'export const b = true;' };
    const result = checkStory({
      diff,
      task,
      gates: [],
      show: (sha, file) => (sha === TO && file === 'src/b.ts' ? 'export const b = true;\n' : null),
      submission: submission({
        cards: [
          card(),
          card({
            title: 'Export b',
            surface: 'ui',
            acceptance: [1],
            how: [],
            hunks: ['H2'],
            tests: [],
            diagram: {
              type: 'ui',
              title: 'Panel',
              regions: [
                { id: 'panel', label: 'Panel', side: 'after', anchor },
                { id: 'row', label: 'Row', parent: 'panel', side: 'both', anchor },
              ],
            },
          }),
        ],
      }),
    });
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.result.cards[1]!.diagram).toMatchObject({
      inferred: ['row'],
      hunks: { panel: 'H2' },
    });
  });
});

// Never inherit user git configuration or identity.
function plainGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Diff Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Diff Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitAll(cwd: string, message: string): string {
  plainGit(cwd, 'add', '-A');
  plainGit(cwd, 'commit', '--quiet', '-m', message);
  return plainGit(cwd, 'rev-parse', 'HEAD').trim();
}

/** Just enough of a `git diff` parser to give each hunk its id, file and body. */
function parseDiff(patch: string, from_sha: string, to_sha: string): LandingDiff {
  const result: LandingDiff = {
    source: 'main',
    from_sha,
    to_sha,
    files: [],
    hunks: [],
    truncated: false,
  };
  let file: LandingDiffFile | undefined;
  const bodies: string[][] = [];
  for (const line of patch.split('\n')) {
    const start = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (start) {
      file = { path: start[2]!, status: 'modified', additions: 0, deletions: 0 };
      result.files.push(file);
    } else if (line.startsWith('new file mode')) file!.status = 'added';
    else if (line.startsWith('deleted file mode')) file!.status = 'deleted';
    else if (line.startsWith('@@')) {
      const [, oldStart, oldLines, newStart, newLines] =
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)!;
      bodies.push([]);
      result.hunks.push({
        id: `H${result.hunks.length + 1}`,
        file: file!.path,
        header: line,
        old_start: Number(oldStart),
        old_lines: Number(oldLines ?? 1),
        new_start: Number(newStart),
        new_lines: Number(newLines ?? 1),
        text: '',
      });
    } else if (bodies.length && /^[ +\-\\]/.test(line) && !/^(---|\+\+\+) /.test(line))
      bodies.at(-1)!.push(line);
  }
  result.hunks.forEach((entry, index) => (entry.text = bodies[index]!.join('\n')));
  return result;
}

describe('cardPatch', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reverts only the chosen hunks of a modified, an added and a deleted file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'card-patch-'));
    dirs.push(dir);
    plainGit(dir, 'init', '--quiet');
    const numbered = (change: (n: number) => string) =>
      `${Array.from({ length: 30 }, (_, i) => change(i + 1)).join('\n')}\n`;
    writeFileSync(path.join(dir, 'modified.txt'), numbered(String));
    writeFileSync(path.join(dir, 'deleted.txt'), 'gone\n');
    const from = commitAll(dir, 'base');
    writeFileSync(
      path.join(dir, 'modified.txt'),
      numbered((n) => (n === 3 ? 'three' : n === 25 ? 'twenty-five' : String(n))),
    );
    rmSync(path.join(dir, 'deleted.txt'));
    writeFileSync(path.join(dir, 'added.txt'), 'new\n');
    const to = commitAll(dir, 'change');
    const landing = parseDiff(plainGit(dir, 'diff', '--no-renames', from, to), from, to);
    expect(landing.hunks.map((entry) => `${entry.id} ${entry.file}`)).toEqual([
      'H1 added.txt',
      'H2 deleted.txt',
      'H3 modified.txt',
      'H4 modified.txt',
    ]);

    const patchFile = path.join(dir, '..', `${path.basename(dir)}.patch`);
    dirs.push(patchFile);
    writeFileSync(patchFile, cardPatch(landing, ['H4', 'H1', 'H2']));
    plainGit(dir, 'apply', '-R', '--check', patchFile);
    plainGit(dir, 'apply', '-R', patchFile);

    expect(existsSync(path.join(dir, 'added.txt'))).toBe(false);
    expect(readFileSync(path.join(dir, 'deleted.txt'), 'utf8')).toBe('gone\n');
    expect(readFileSync(path.join(dir, 'modified.txt'), 'utf8')).toBe(
      numbered((n) => (n === 3 ? 'three' : String(n))),
    );
  });
});

describe('renderStoryBrief', () => {
  it('numbers acceptance items, labels hunks and names the submit tool', () => {
    const finding = {
      id: 'finding-1',
      review_id: 'review-1',
      runtime: 'fixture',
      round: 1,
      location: 'src/a.ts:2',
      quote: 'const value = 2;',
      evidence: 'reads it',
      impact: 'callers see two',
      status: 'open',
      blocking: false,
    } satisfies ReviewFinding;
    const brief = renderStoryBrief(task, diff, [finding, { ...finding, status: 'rejected' }]);
    expect(brief).toContain('[0] The value is two');
    expect(brief).toContain('H1 src/a.ts @@ -1,1 +1,1 @@\n export function a() {');
    expect(brief).toContain('H4 docs.md @@ -1,1 +1,1 @@ noise: whitespace');
    expect(brief).toContain('`change_story_submit`');
    expect(brief).toContain('- src/a.ts:2: callers see two');
    expect(brief.match(/callers see two/g)).toHaveLength(1);
  });
});
