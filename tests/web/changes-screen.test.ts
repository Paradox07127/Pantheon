import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewFinding } from '@pantheon/domain';
import type { ChangeRow, WorkbenchSession } from '@pantheon/protocol';
import { Tabs } from '../../apps/web/node_modules/@base-ui/react/tabs';
import { mount, nodes, text, unmountAll, type HookHost } from './web-hook-host.js';

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
vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
import { runCommand } from '@/data/commands';
import {
  ChangeDetails,
  ChangeInspector,
  ChangesScreen,
  ReviewGuide,
} from '@/screens/changes/ChangesScreen';
import { GateResults } from '@/screens/sessions/GateResults';
import { zh, zhf } from './i18n-setup.js';

const row = (over: Partial<ChangeRow> & { id: string; title: string }): ChangeRow => ({
  kind: over.id.startsWith('landing:') ? 'branch' : 'session',
  status: 'running',
  gate: { state: 'none' },
  updated_at: '2026-11-20T10:00:00.000Z',
  ...over,
});

const finding = (over: Partial<ReviewFinding> & { id: string; location: string }) =>
  ({
    review_id: 'review-refunds',
    runtime: 'claude',
    round: 1,
    quote: 'const picked = rows[index]',
    evidence: 'the index is per page',
    impact: `impact of ${over.id}`,
    status: 'open',
    blocking: false,
    ...over,
  }) as ReviewFinding;

let changes: ChangeRow[];
let query: ReturnType<typeof vi.fn>;
let answers: Record<string, unknown>;

beforeEach(() => {
  changes = [];
  answers = {};
  query = vi.fn(async (method: string) =>
    method === 'project.changes'
      ? { ok: true, value: { changes } }
      : method in answers
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
  vi.mocked(runCommand).mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const sessions = [
  { id: 'refund-list', changes: { files: 3, additions: 184, deletions: 22 } },
] as unknown as WorkbenchSession[];

async function screen() {
  const h = mount(() => ChangesScreen({ projectId: 'alpha', sessions }));
  await h.flush();
  return h;
}
const grid = (tree: unknown) =>
  nodes(tree as ReactElement).find(
    (n) => n.props.role === 'grid' && n.props['aria-label'] === zh('app.screenName.changes'),
  );
const rows = (tree: unknown) =>
  nodes(grid(tree)).filter(
    (n) => n.props.role === 'row' && !nodes(n).some((c) => c.props.role === 'columnheader'),
  );
const tabs = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => n.type === Tabs.Tab)
    .map((n) => text(n));
const inspectorOf = (h: HookHost<ReactElement>) =>
  nodes(h.value).find((n) => n.type === ChangeInspector);
/** Presses a plain key on the list and renders what it changed. */
function press(h: HookHost<ReactElement>, key: string) {
  grid(h.value)!.props.onKeyDown({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  });
  h.render();
}

describe('changes screen', () => {
  beforeEach(() => {
    changes = [
      row({
        id: 'session:old',
        title: 'Webhook signature',
        status: 'needs_you',
        updated_at: '2026-11-18T10:00:00.000Z',
      }),
      row({
        id: 'session:refund-list',
        title: 'Refund list page',
        status: 'ready',
        branch: 'pt/refund-list',
        ahead: 3,
        updated_at: '2026-11-20T12:00:00.000Z',
      }),
      row({
        id: 'landing:docs',
        title: 'docs/refund-api',
        status: 'merged',
        updated_at: '2026-11-19T10:00:00.000Z',
      }),
      row({
        id: 'session:report',
        title: 'Reconcile report',
        status: 'merged',
        updated_at: '2026-11-17T10:00:00.000Z',
      }),
    ];
  });

  it('reads the project changes and lists them newest first, with the diff size of a session row', async () => {
    const h = await screen();
    expect(query).toHaveBeenCalledWith('project.changes', { project_id: 'alpha' });
    const listed = rows(h.value);
    expect(listed.map((r) => text(r))).toEqual([
      expect.stringContaining('Refund list page'),
      expect.stringContaining('docs/refund-api'),
      expect.stringContaining('Webhook signature'),
      expect.stringContaining('Reconcile report'),
    ]);
    expect(text(listed[0]!)).toContain('+184 −22');
    expect(text(listed[0]!)).toContain('pt/refund-list');
    expect(text(listed[0]!)).toContain('↑3');
    expect(text(listed[1]!)).not.toMatch(/\+\d/);
  });

  it('counts each filter and lists only its rows', async () => {
    const h = await screen();
    expect(tabs(h.value)).toEqual([
      `${zh('changes.filter.all')}4`,
      `${zh('changes.filter.ready')}1`,
      `${zh('changes.filter.needsYou')}1`,
      `${zh('changes.filter.merged')}2`,
      zh('changes.local.tab'),
      zh('changes.commits.tab'),
      zh('changes.pulls.tab'),
    ]);
    const root = nodes(h.value).find((n) => n.type === Tabs.Root)!;
    root.props.onValueChange('merged');
    h.render();
    expect(rows(h.value).map((r) => text(r))).toEqual([
      expect.stringContaining('docs/refund-api'),
      expect.stringContaining('Reconcile report'),
    ]);
    root.props.onValueChange('needs_you');
    h.render();
    expect(rows(h.value).map((r) => text(r))).toEqual([
      expect.stringContaining('Webhook signature'),
    ]);
  });

  it('moves the highlight with J and K and opens the highlighted row with Enter', async () => {
    const h = await screen();
    const inspector = () => nodes(h.value).find((n) => n.type === ChangeInspector);
    expect(inspector()).toBeUndefined();
    for (const key of ['j', 'j', 'k']) press(h, key);
    expect(grid(h.value)!.props['aria-activedescendant']).toBe('chg-landing:docs');
    press(h, 'Enter');
    expect(inspector()!.props.row.id).toBe('landing:docs');
    expect(rows(h.value).map((r) => r.props['aria-selected'])).toEqual([false, true, false, false]);
  });

  it('scrolls the row the keys highlight into view', async () => {
    const scrollIntoView = vi.fn();
    class FakeElement {
      constructor(readonly id: string) {}
    }
    Object.assign(FakeElement.prototype, { scrollIntoView });
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('document', { getElementById: (id: string) => new FakeElement(id) });
    const h = await screen();
    press(h, 'j');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts.at(-1)).toMatchObject({ id: 'chg-landing:docs' });
    press(h, 'End');
    expect(scrollIntoView.mock.contexts.at(-1)).toMatchObject({ id: 'chg-session:report' });
  });

  it('keeps only the status, the title and the landing column while the inspector is open', async () => {
    const h = await screen();
    const headers = () =>
      nodes(grid(h.value))
        .filter((n) => n.props.role === 'columnheader')
        .map((n) => text(n))
        .filter(Boolean);
    const every = ['change', 'diff', 'branch', 'gate', 'review', 'landing'].map((c) =>
      zh(`changes.column.${c}`),
    );
    expect(headers()).toEqual(every);
    press(h, 'Enter');
    expect(headers()).toEqual([zh('changes.column.change'), zh('changes.column.landing')]);
    for (const listed of rows(h.value))
      expect(nodes(listed).filter((n) => n.props.role === 'gridcell')).toHaveLength(3);
  });

  it('closes the inspector when its row leaves the filter', async () => {
    const h = await screen();
    const inspector = () => nodes(h.value).find((n) => n.type === ChangeInspector);
    press(h, 'Enter');
    expect(inspector()!.props.row.id).toBe('session:refund-list');
    const root = () => nodes(h.value).find((n) => n.type === Tabs.Root)!;
    root().props.onValueChange('merged');
    h.render();
    expect(inspector()).toBeUndefined();
    root().props.onValueChange('all');
    h.render();
    expect(inspector()).toBeUndefined();
  });

  it.each([
    ['a failed session that never landed', { status: 'failed' }, ''],
    ['a landed row', { status: 'merged' }, zh('changes.landing.merged')],
    ['a queued landing', { status: 'running', landing: 'queued' }, zh('changes.landing.queued')],
  ] as const)('shows in the landing column of %s only its landing', async (_, over, landing) => {
    changes = [row({ id: 'session:one', title: 'One', ...over })];
    const h = await screen();
    const cells = nodes(rows(h.value)[0]!).filter((n) => n.props.role === 'gridcell');
    expect(text(cells.at(-1)!)).toBe(landing);
  });

  it('counts the open blocking findings of a review that has no verdict yet', async () => {
    changes = [
      row({
        id: 'session:one',
        title: 'One',
        review: { id: 'review-one', state: 'running', verdicts: [], blocking_open: 2 },
      }),
    ];
    const h = await screen();
    const cell = nodes(rows(h.value)[0]!).find(
      (n) => typeof n.type === 'function' && n.type.name === 'ReviewCell',
    )!;
    const shown = text((cell.type as (props: unknown) => ReactElement)(cell.props));
    expect(shown).toContain(zh('changes.review.running'));
    expect(shown).toContain(zhf('changes.review.blocking', { count: 2 }));
  });

  const reviewCell = (h: HookHost<ReactElement>) => {
    const cell = nodes(rows(h.value)[0]!).find(
      (n) => typeof n.type === 'function' && n.type.name === 'ReviewCell',
    )!;
    return (cell.type as (props: unknown) => ReactElement)(cell.props);
  };

  it('shows a completed review a reviewer left without a full result as incomplete, with no pass mark', async () => {
    changes = [
      row({
        id: 'session:one',
        title: 'One',
        review: {
          id: 'review-one',
          state: 'completed',
          incomplete: true,
          verdicts: [{ runtime: 'claude', verdict: 'pass' }],
          blocking_open: 0,
        },
      }),
    ];
    const h = await screen();
    const cell = reviewCell(h);
    expect(text(cell)).toContain(zh('changes.review.incomplete'));
    expect(
      nodes(cell)
        .filter((n) => n.props.className === 'chg-dot')
        .map((n) => n.props['data-tone']),
    ).toEqual([undefined]);
  });

  it('shows a running gate as running', async () => {
    changes = [row({ id: 'session:one', title: 'One', gate: { state: 'running' } })];
    const h = await screen();
    const marks = nodes(rows(h.value)[0]!).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'GateMark',
    );
    expect(marks.map((n) => n.props.state)).toEqual(['running']);
    expect(text(rows(h.value)[0]!)).toContain(zh('sessions.screen.gateRunning'));
  });

  it.each([
    ['its close button', (h: HookHost<ReactElement>) => inspectorOf(h)!.props.onClose()],
    ['Escape', (h: HookHost<ReactElement>) => press(h, 'Escape')],
  ])('gives the focus back to the list on the row it showed when %s closes it', async (_, shut) => {
    const h = await screen();
    press(h, 'j');
    press(h, 'Enter');
    expect(inspectorOf(h)!.props.row.id).toBe('landing:docs');
    const focus = vi.fn();
    Object.assign(grid(h.value)!.props.ref ?? {}, { current: { focus } });
    shut(h);
    h.render();
    expect(inspectorOf(h)).toBeUndefined();
    expect(focus).toHaveBeenCalledOnce();
    expect(grid(h.value)!.props['aria-activedescendant']).toBe('chg-landing:docs');
  });

  it('says there are no changes and shows nothing else when the list is empty', async () => {
    changes = [];
    const h = await screen();
    expect(grid(h.value)).toBeUndefined();
    expect(text(h.value)).toContain(zh('changes.empty'));
  });
});

describe('review guide', () => {
  const blockingList = (tree: ReactElement, count: number) =>
    nodes(tree).find(
      (n) => n.type === 'ul' && n.props['aria-label'] === zhf('changes.review.blocking', { count }),
    );
  const fileList = (tree: ReactElement) =>
    nodes(tree).find((n) => n.type === 'ul' && n.props['aria-label'] === zh('changes.guide.files'));

  it('lists the open blocking findings first and counts the reports', () => {
    const tree = ReviewGuide({
      review: {
        findings: [
          finding({ id: 'retry', location: 'src/refunds/api.ts:41' }),
          finding({ id: 'paging', location: 'src/refunds/list.tsx:88', blocking: true }),
          finding({
            id: 'fixed',
            location: 'src/refunds/list.tsx:12',
            blocking: true,
            resolution: { outcome: 'fixed', resolved_at: 1, resolved_by: 'user' },
          }),
          finding({
            id: 'rejected',
            location: 'src/refunds/list.css:3',
            blocking: true,
            status: 'rejected',
          }),
          finding({ id: 'header', location: 'src/refunds/list.tsx:20' }),
        ],
      },
      sessionId: 'refund-list',
    }) as ReactElement;
    const blocking = blockingList(tree, 1)!;
    const items = nodes(blocking).filter((n) => n.type === 'li');
    expect(items.map((n) => text(n))).toEqual(['src/refunds/list.tsx:88impact of paging']);
    const all = text(tree);
    expect(all.indexOf('impact of paging')).toBeLessThan(
      all.indexOf(zhf('changes.guide.reports', { count: 2 })),
    );
    expect(all).not.toContain('impact of retry');
    const location = nodes(blocking).find((n) => n.type === 'button')!;
    location.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list', 'review');
  });

  it('lists a blocking finding that went stale unresolved', () => {
    const tree = ReviewGuide({
      review: {
        findings: [
          finding({
            id: 'moved',
            location: 'src/refunds/list.tsx:88',
            blocking: true,
            status: 'stale',
          }),
          finding({
            id: 'settled',
            location: 'src/refunds/list.tsx:12',
            blocking: true,
            status: 'stale',
            resolution: { outcome: 'fixed', resolved_at: 1, resolved_by: 'user' },
          }),
        ],
      },
      sessionId: null,
    }) as ReactElement;
    const items = nodes(blockingList(tree, 1)!).filter((n) => n.type === 'li');
    expect(items.map((n) => text(n))).toEqual(['src/refunds/list.tsx:88impact of moved']);
  });

  it.each(['a.ts:9', 'a.ts:9:4', 'a.ts:9-14'])('counts %s under its file', (location) => {
    const findings = [
      finding({ id: 'line', location: 'a.ts:1' }),
      finding({ id: 'other', location }),
    ];
    const tree = ReviewGuide({ review: { findings }, sessionId: null }) as ReactElement;
    const files = nodes(fileList(tree)!).filter((n) => n.type === 'li');
    expect(files.map((n) => text(n))).toEqual(['a.ts2']);
  });

  it('ranks the files by blocking findings and lists at most eight', () => {
    const findings = [
      finding({ id: 'a1', location: 'a.ts:1' }),
      finding({ id: 'b1', location: 'b.ts:1', blocking: true }),
      finding({ id: 'b2', location: 'b.ts:2' }),
      finding({ id: 'c1', location: 'c.ts:1', blocking: true }),
      finding({ id: 'c2', location: 'c.ts:9', blocking: true }),
      ...['d', 'e', 'f', 'g', 'h', 'i', 'j'].map((name) =>
        finding({ id: name, location: `${name}.ts:1` }),
      ),
    ];
    const tree = ReviewGuide({ review: { findings }, sessionId: null }) as ReactElement;
    const files = nodes(fileList(tree)!).filter((n) => n.type === 'li');
    expect(files.map((n) => text(n))).toEqual([
      'c.ts2',
      'b.ts2',
      'a.ts1',
      'd.ts1',
      'e.ts1',
      'f.ts1',
      'g.ts1',
      'h.ts1',
      zhf('changes.guide.moreFiles', { count: 2 }),
    ]);
    const meters = nodes(fileList(tree)!).filter((n) => n.props.role === 'img');
    expect(meters[1]!.props['aria-label']).toBe(
      zhf('changes.guide.fileRisk', { blocking: 1, reports: 1 }),
    );
  });
});

describe('change inspector', () => {
  // The host draws one component, so the details are drawn beside the inspector in the same host.
  const inspector = async (target: ChangeRow) => {
    const h = mount(() => {
      const drawn = ChangeInspector({ row: target, onClose() {} });
      const details = nodes(drawn).find((n) => n.type === ChangeDetails)!;
      return [drawn, ChangeDetails(details.props)];
    });
    await h.flush();
    return h;
  };
  const button = (tree: unknown, name: string) =>
    nodes(tree as ReactElement).find((n) => n.type === 'button' && text(n) === name);

  it('cancels a queued branch landing by its landing id', async () => {
    const h = await inspector(
      row({ id: 'landing:land-7', title: 'docs/refund-api', status: 'running', landing: 'queued' }),
    );
    const cancel = button(h.value, zh('changes.inspector.cancelLanding'))!;
    cancel.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.landing.cancel',
      { landing_id: 'land-7' },
      null,
    );
  });

  it('keeps the cancel disabled as cancelling once the daemon accepted it', async () => {
    const h = await inspector(
      row({ id: 'landing:land-7', title: 'docs/refund-api', status: 'running', landing: 'queued' }),
    );
    button(h.value, zh('changes.inspector.cancelLanding'))!.props.onClick();
    await h.flush();
    expect(button(h.value, zh('changes.inspector.cancelLanding'))).toBeUndefined();
    expect(button(h.value, zh('changes.inspector.cancelling'))!.props.disabled).toBe(true);
  });

  it('keeps an out-of-date gate marked as such above the gate results it read', async () => {
    answers['session.gates'] = {
      configured: true,
      running: false,
      last: {
        commit: 'abcdef1234567890',
        checked_at: 1,
        results: [{ name: 'Unit tests', exit_code: 0, timed_out: false, output_tail: '' }],
      },
    };
    const h = await inspector(
      row({ id: 'session:refund-list', title: 'Refund list page', gate: { state: 'stale' } }),
    );
    const gate = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === zh('changes.inspector.gate'),
    )!;
    const parts = nodes(gate);
    const results = parts.findIndex((n) => n.type === GateResults);
    const stale = parts.findIndex(
      (n) =>
        typeof n.type === 'function' && n.type.name === 'GateMark' && n.props.state === 'stale',
    );
    expect(results).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(-1);
    expect(stale).toBeLessThan(results);
    expect(text(gate)).toContain(zh('sessions.screen.gateStale'));
  });

  it('reruns only the failed gate steps of the session and reads the gate again', async () => {
    mock.board.board.sessions = [{ id: 'refund-list', revision: 9, state: 'open' }];
    answers['session.gates'] = {
      configured: true,
      running: false,
      last: {
        commit: 'abcdef1234567890',
        checked_at: 1,
        results: [
          { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '' },
          { name: 'Lint', exit_code: 0, timed_out: false, output_tail: '' },
        ],
      },
    };
    const h = await inspector(
      row({
        id: 'session:refund-list',
        title: 'Refund list page',
        gate: { state: 'failed', failed: ['Unit tests'] },
      }),
    );
    const reads = () => query.mock.calls.filter(([method]) => method === 'session.gates').length;
    const before = reads();
    button(h.value, zh('changes.inspector.rerunFailed'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'session.gates.run',
      { session_id: 'refund-list', only_failed: true },
      9,
    );
    expect(reads()).toBeGreaterThan(before);
    expect(nodes(h.value).find((n) => n.type === GateResults)!.props.readOnly).toBe(true);
  });

  it('offers no rerun of the failed steps when every step passed', async () => {
    answers['session.gates'] = {
      configured: true,
      running: false,
      last: {
        commit: 'abcdef1234567890',
        checked_at: 1,
        results: [{ name: 'Unit tests', exit_code: 0, timed_out: false, output_tail: '' }],
      },
    };
    const h = await inspector(
      row({ id: 'session:refund-list', title: 'Refund list page', gate: { state: 'passed' } }),
    );
    expect(nodes(h.value).some((n) => n.type === GateResults)).toBe(true);
    expect(button(h.value, zh('changes.inspector.rerunFailed'))).toBeUndefined();
  });

  it('offers no cancel on a landed row', async () => {
    const h = await inspector(row({ id: 'landing:land-8', title: 'docs/old', status: 'merged' }));
    expect(button(h.value, zh('changes.inspector.cancelLanding'))).toBeUndefined();
  });

  it('opens the session of a session row and shows the guide of its review', async () => {
    answers['review.read'] = {
      id: 'review-refunds',
      findings: [finding({ id: 'paging', location: 'src/refunds/list.tsx:88', blocking: true })],
    };
    const h = await inspector(
      row({
        id: 'session:refund-list',
        title: 'Refund list page',
        review: {
          id: 'review-refunds',
          state: 'completed',
          verdicts: [{ runtime: 'codex', verdict: 'pass' }],
          blocking_open: 1,
        },
      }),
    );
    expect(query).toHaveBeenCalledWith('review.read', { review_id: 'review-refunds' });
    const guide = nodes(h.value).find((n) => n.type === ReviewGuide)!;
    expect(guide.props.review.findings).toHaveLength(1);
    expect(button(h.value, zh('changes.inspector.cancelLanding'))).toBeUndefined();
    // The button is looked up in what ChangeDetails drew, not in the children handed to it.
    button((h.value as unknown[])[1], zh('changes.inspector.openSession'))!.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list');
  });
});
