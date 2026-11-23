import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewMetrics } from '@pantheon/domain';
import type { ChangeRow, ProjectGateRun } from '@pantheon/protocol';
import { mount, named, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
    setState: (patch: object) => Object.assign(mock.shell, patch),
  }),
  resolveTheme: () => 'light',
}));
import { GATE_RUNS } from '@/lib/gate-model';
import { ChangeInspector, ChangesScreen } from '@/screens/changes/ChangesScreen';
import { QualityStrip } from '@/screens/changes/QualityStrip';
import { gateQuality, reviewMatrix } from '@/screens/changes/quality-model';
import { GateTracker } from '@/screens/sessions/GateTracker';
import { zh, zhf } from './i18n-setup.js';

type Result = ProjectGateRun['results'][number];
const passed = (name: string, over: Partial<Result> = {}): Result => ({
  name,
  command: ['pnpm', name],
  exit_code: 0,
  timed_out: false,
  duration_ms: 1000,
  ...over,
});
const failed = (name: string, over: Partial<Result> = {}): Result =>
  passed(name, { exit_code: 1, ...over });

let at = 0;
/**
 * A run of a session, or of a landing when the owner starts with `landing:`; first marks the
 * owner's first recorded run.
 */
const run = (owner: string, commit: string, results: Result[], first = false): ProjectGateRun => ({
  run_id: `run-${++at}`,
  commit,
  started_at: new Date(Date.UTC(2026, 10, 20, 10, at)).toISOString(),
  finished_at: new Date(Date.UTC(2026, 10, 20, 10, at, 30)).toISOString(),
  results,
  ...(first ? { first: true as const } : {}),
  ...(owner.startsWith('landing:')
    ? { landing_id: owner.slice('landing:'.length), branch: `docs/${owner}` }
    : { session_id: owner, session_title: `Session ${owner}` }),
});

const metrics = (runtime: string, counts: Partial<ReviewMetrics>): ReviewMetrics => ({
  runtime,
  reviews: 1,
  reviews_without_findings: 0,
  findings: 0,
  fixed: 0,
  intentional: 0,
  not_worth_it: 0,
  wrong: 0,
  unresolved: 0,
  invalid: 0,
  ...counts,
});

describe('gate quality', () => {
  it('counts each session and landing once, by whether its first run passed', () => {
    // Newest first, as project.gates.history answers.
    const runs = [
      run('refunds', 'b', [passed('test')]),
      run('landing:docs', 'c', [passed('test')], true),
      run('refunds', 'a', [passed('build'), failed('test')], true),
      run('webhooks', 'd', [passed('test'), passed('lint', { skipped: true })], true),
      run('landing:report', 'e', [passed('build'), failed('test', { timed_out: true })], true),
    ];
    expect(gateQuality(runs).firstPass).toEqual({ passed: 2, total: 4 });
    expect(gateQuality([]).firstPass).toEqual({ passed: 0, total: 0 });
  });

  it('leaves out an owner whose first run fell out of the window, though its oldest run there passed', () => {
    const runs = [
      run('refunds', 'b', [passed('test')]),
      run('refunds', 'b', [passed('test')]),
      run('webhooks', 'd', [failed('test')], true),
    ];
    expect(gateQuality(runs).firstPass).toEqual({ passed: 0, total: 1 });
  });

  it('marks a step flaky when it passed and failed on one commit, in any run of the project', () => {
    const runs = [
      run('refunds', 'a', [passed('test'), passed('lint')]),
      run('landing:docs', 'c', [passed('e2e')]),
      run('webhooks', 'c', [failed('e2e', { exit_code: null, timed_out: true })]),
      run('refunds', 'a', [failed('test')]),
      run('refunds', 'b', [failed('lint')]),
      run('refunds', '', [passed('build')]),
      run('refunds', '', [failed('build')]),
      run('webhooks', 'd', [failed('docs'), passed('docs', { skipped: true })]),
    ];
    expect(gateQuality(runs).flaky).toEqual([
      { key: 'e2e\0pnpm e2e', name: 'e2e', commits: 1 },
      { key: 'test\0pnpm test', name: 'test', commits: 1 },
    ]);
  });

  it('keeps apart two steps of one name with different commands', () => {
    const runs = [
      run('refunds', 'a', [passed('test', { command: ['pnpm', 'test:unit'] })]),
      run('refunds', 'a', [failed('test', { command: ['pnpm', 'test:e2e'] })]),
    ];
    expect(gateQuality(runs).flaky).toEqual([]);
  });

  it('looks for flaky steps in the newest runs the tracker draws only', () => {
    const runs = [
      ...Array.from({ length: GATE_RUNS }, () => run('refunds', 'new', [passed('test')])),
      run('refunds', 'old', [passed('test')]),
      run('refunds', 'old', [failed('test')]),
    ];
    expect(gateQuality(runs).flaky).toEqual([]);
    expect(gateQuality(runs.slice(2)).flaky.map((step) => step.name)).toEqual(['test']);
  });
});

describe('review matrix', () => {
  const rows = [
    metrics('codex', {
      findings: 10,
      unresolved: 2,
      fixed: 5,
      intentional: 1,
      invalid: 2,
    }),
    metrics('claude', { findings: 8, fixed: 6, not_worth_it: 1, wrong: 1 }),
    metrics('gemini', {}),
  ];

  it('puts each runtime in a row with its outcomes as shares of its own findings', () => {
    const matrix = reviewMatrix(rows);
    expect(matrix.map((r) => r.runtime)).toEqual(['claude', 'codex', 'gemini']);
    const shares = (runtime: string) =>
      matrix.find((r) => r.runtime === runtime)!.cells.map((c) => [c.key, c.count, c.share]);
    expect(shares('codex')).toEqual([
      ['unresolved', 2, 0.2],
      ['adopted', 5, 0.5],
      ['dismissed', 1, 0.1],
      ['invalid', 2, 0.2],
    ]);
    expect(shares('claude')).toEqual([
      ['unresolved', 0, 0],
      ['adopted', 6, 0.75],
      ['dismissed', 2, 0.25],
      ['invalid', 0, 0],
    ]);
    expect(shares('gemini').map(([, , share]) => share)).toEqual([0, 0, 0, 0]);
    expect(matrix[0]!.cells.map((c) => c.color)).toEqual([
      'var(--wait)',
      'var(--ok)',
      'var(--idle)',
      'var(--bad)',
    ]);
  });

  it('rates adoption as the fixed findings out of all a reviewer recorded, none without findings', () => {
    expect(reviewMatrix(rows).map((r) => [r.runtime, r.adoption])).toEqual([
      ['claude', 0.75],
      ['codex', 0.5],
      ['gemini', null],
    ]);
  });
});

let answers: Record<string, unknown>;
let query: ReturnType<typeof vi.fn>;
beforeEach(() => {
  at = 0;
  answers = {};
  query = vi.fn(async (method: string) =>
    method in answers
      ? { ok: true, value: answers[method] }
      : { ok: false, error: { code: 'not_found', message: method } },
  );
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  mock.board = {
    board: {
      cursor: 1,
      projects: [{ id: 'alpha', name: 'Alpha' }],
      sessions: [],
      workspaces: [],
      session_turns: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function strip(onOpenLanding = vi.fn()) {
  const h = mount(() =>
    QualityStrip({ projectId: 'alpha', onOpenLanding, landingIds: new Set(['docs']) }),
  );
  await h.flush();
  return h;
}
const group = (tree: unknown, id: string) =>
  nodes(tree as ReactElement).find(
    (n) => n.props.role === 'group' && n.props['aria-label'] === zh(id),
  );

describe('quality strip', () => {
  const runs = [
    run('refunds', 'b', [passed('test')]),
    run('landing:docs', 'c', [passed('test')], true),
    run('refunds', 'b', [failed('test')], true),
    run('webhooks', 'd', [passed('test')], true),
  ];

  it('reads the gate history and the review metrics of the project', async () => {
    answers = { 'project.gates.history': { runs }, 'project.review.metrics': [] };
    await strip();
    expect(query).toHaveBeenCalledWith('project.gates.history', {
      project_id: 'alpha',
      limit: '100',
    });
    expect(query).toHaveBeenCalledWith('project.review.metrics', { project_id: 'alpha' });
  });

  it('shows the first-pass rate with its count and names the flaky steps', async () => {
    answers = { 'project.gates.history': { runs }, 'project.review.metrics': [] };
    const h = await strip();
    expect(h.value.props['aria-label']).toBe(zh('changes.quality.label'));
    expect(text(group(h.value, 'changes.quality.firstPass'))).toBe(
      zh('changes.quality.firstPass') +
        '67%' +
        zhf('changes.quality.firstPassCount', { passed: 2, total: 3 }),
    );
    const flaky = group(h.value, 'changes.quality.flaky');
    expect(
      nodes(flaky)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual(['test']);
    expect(text(flaky)).toBe(`${zh('changes.quality.flaky')}1test`);
  });

  it('draws the gate history and opens a landing run in the list, a session run in its session', async () => {
    answers = { 'project.gates.history': { runs }, 'project.review.metrics': [] };
    const onOpenLanding = vi.fn();
    const h = await strip(onOpenLanding);
    const tracker = named(group(h.value, 'changes.quality.history'), 'GateTracker');
    expect(tracker.props.runs).toBe(runs);
    tracker.props.onRun({ run_id: 'run-2', landing_id: 'docs', commit: 'c', finished_at: '' });
    expect(onOpenLanding).toHaveBeenCalledWith('docs');
    tracker.props.onRun({ run_id: 'run-1', session_id: 'refunds', commit: 'b', finished_at: '' });
    expect(mock.shell.openSession).toHaveBeenCalledExactlyOnceWith('refunds', 'checks', 'run-1');
  });

  it('names the branch or the session of a project run in its cell', () => {
    const tree = mount(() => GateTracker({ runs: runs.slice(0, 2), onRun: () => {} })).value;
    const labels = nodes(tree)
      .filter((n) => n.type === 'button')
      .map((n) => n.props['aria-label']);
    expect(labels[0]).toContain('docs/landing:docs');
    expect(labels[1]).toContain('Session refunds');
  });

  it('draws a run it cannot open as a picture, not a button, and the strip opens only listed landings', async () => {
    const tree = mount(() =>
      GateTracker({ runs: runs.slice(0, 2), onRun: () => {}, openable: (c) => !c.landing_id }),
    ).value;
    const cells = nodes(tree).filter((n) => typeof n.props['aria-label'] === 'string');
    const landingCell = cells.find((n) => n.props['aria-label'].includes('docs/landing:docs'))!;
    const sessionCell = cells.find((n) => n.props['aria-label'].includes('Session refunds'))!;
    expect(landingCell.type).toBe('span');
    expect(landingCell.props.role).toBe('img');
    expect(sessionCell.type).toBe('button');
    answers = { 'project.gates.history': { runs }, 'project.review.metrics': [] };
    const h = await strip();
    const tracker = named(group(h.value, 'changes.quality.history'), 'GateTracker');
    expect(tracker.props.openable({ landing_id: 'docs' })).toBe(true);
    expect(tracker.props.openable({ landing_id: 'gone' })).toBe(false);
    expect(tracker.props.openable({ session_id: 'refunds' })).toBe(true);
  });

  it('draws each reviewer as a bar of its outcomes, named by its counts, and its adoption rate', async () => {
    answers = {
      'project.gates.history': { runs: [] },
      'project.review.metrics': [metrics('codex', { findings: 4, fixed: 3, invalid: 1 })],
    };
    const h = await strip();
    const adoption = group(h.value, 'changes.quality.adoption')!;
    const bar = nodes(adoption).find((n) => n.props.className === 'cq-bar')!;
    expect(bar.props['aria-label']).toBe(
      zhf('changes.quality.outcomes', {
        runtime: 'Codex',
        findings: 4,
        adopted: 3,
        dismissed: 0,
        unresolved: 0,
        invalid: 1,
      }),
    );
    expect(
      nodes(bar)
        .filter((n) => n.type === 'i')
        .map((n) => n.props.style),
    ).toEqual([
      { width: '0%', backgroundColor: 'var(--wait)' },
      { width: '75%', backgroundColor: 'var(--ok)' },
      { width: '0%', backgroundColor: 'var(--idle)' },
      { width: '25%', backgroundColor: 'var(--bad)' },
    ]);
    expect(text(adoption)).toContain('75%');
    expect(group(h.value, 'changes.quality.history')).toBeUndefined();
  });

  it('stands with dashes under aria-busy until its reads land', () => {
    // A project no earlier test read, so no cached answer stands in.
    const h = mount(() =>
      QualityStrip({ projectId: 'beta', onOpenLanding: () => {}, landingIds: new Set() }),
    );
    expect(h.value.props['aria-busy']).toBe(true);
    expect(text(group(h.value, 'changes.quality.firstPass'))).toBe(
      `${zh('changes.quality.firstPass')}—`,
    );
    expect(text(group(h.value, 'changes.quality.adoption'))).toBe(
      `${zh('changes.quality.adoption')}—`,
    );
  });
});

describe('changes screen with the quality strip', () => {
  const row = (over: Partial<ChangeRow> & { id: string; title: string }): ChangeRow => ({
    kind: over.id.startsWith('landing:') ? 'branch' : 'session',
    status: 'running',
    gate: { state: 'none' },
    updated_at: '2026-11-20T10:00:00.000Z',
    ...over,
  });

  it('puts the strip above the rows and opens a landing chosen in it, under all when filtered out', async () => {
    answers = {
      'project.changes': {
        changes: [
          row({ id: 'session:refunds', title: 'Refund list page', status: 'ready' }),
          row({ id: 'landing:docs', title: 'docs/refund-api', status: 'merged' }),
        ],
      },
    };
    const h = mount(() => ChangesScreen({ projectId: 'alpha', sessions: [] }));
    await h.flush();
    const main = nodes(h.value).find((n) => n.props.className === 'chg-main')!;
    const children = (main.props.children as unknown[]).filter(Boolean) as ReactElement<any>[];
    expect(children[0]!.type).toBe(QualityStrip);
    expect(children[0]!.props.projectId).toBe('alpha');
    const root = () => nodes(h.value).find((n) => n.props.className === 'tb-pg')!;
    const stripOf = () => nodes(h.value).find((n) => n.type === QualityStrip)!;
    // Show only the rows that can land, then choose the landing's run in the strip.
    root().props.onValueChange('ready');
    h.render();
    stripOf().props.onOpenLanding('docs');
    h.render();
    expect(root().props.value).toBe('all');
    expect(nodes(h.value).find((n) => n.type === ChangeInspector)!.props.row.id).toBe(
      'landing:docs',
    );
    stripOf().props.onOpenLanding('gone');
    h.render();
    expect(nodes(h.value).find((n) => n.type === ChangeInspector)!.props.row.id).toBe(
      'landing:docs',
    );
  });
});
