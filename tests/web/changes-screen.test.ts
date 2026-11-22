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
import { ChangeInspector, ChangesScreen, ReviewGuide } from '@/screens/changes/ChangesScreen';
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
  const inspector = async (target: ChangeRow) => {
    const h = mount(() => ChangeInspector({ row: target, onClose() {} }));
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
    button(h.value, zh('changes.inspector.openSession'))!.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list');
  });
});
