import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChangeRow,
  PlanItemView,
  ProjectOverlap,
  ProjectPlanView,
  WorkbenchSession,
} from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', async (actual) => ({
  ...(await actual<object>()),
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { AgentList } from '@/screens/project/AgentList';
import { ItemInspector } from '@/screens/project/ItemInspector';
import { PlanList, PlanRow } from '@/screens/project/PlanList';
import type { ShownPlanItem } from '@/screens/project/project-model';
import { ChangeLine, UnplannedList } from '@/screens/project/UnplannedList';
import { useShell } from '@/store';

type Plan = NonNullable<ProjectPlanView['plan']>;

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession =>
  ({
    id,
    title: `title of ${id}`,
    runtime: 'codex',
    state: 'idle',
    last_activity_at: '2026-11-26T09:00:00.000Z',
    ...extra,
  }) as WorkbenchSession;

const lead = listed('lead', { conductor: true });
const spawned = (id: string, extra: Partial<WorkbenchSession> = {}) =>
  listed(id, { spawned_by: { session_id: 'lead' }, ...extra });

const overlap = (...pairs: [string, string, string[]][]): ProjectOverlap => ({
  pairs: pairs.map(([a, b, paths]) => ({ session_ids: [a, b], paths })),
  refresh_events: ['session.write_detected', 'turn.completed'],
});

const clipText = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'Clip')
    .map((n) => n.props.text as string);

/** Each agent row's title and the lines under it. */
const agentRows = (sessions: WorkbenchSession[], shared: ProjectOverlap | null) => {
  const h = mount(() => AgentList({ main: lead, sessions, overlap: shared }) as ReactElement);
  return Object.fromEntries(
    nodes(h.value)
      .filter((n) => n.type === 'button')
      .map((b) => {
        const [title, ...lines] = clipText(b);
        return [title, lines];
      }),
  );
};

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  useShell.setState({ screen: 'project', sessionId: null });
});
afterEach(() => unmountAll());

describe('an agent row whose session changed a file another open session changed', () => {
  it("says so on both rows, each with the other session's title", () => {
    const rows = agentRows(
      [lead, spawned('parser'), spawned('printer')],
      overlap(['parser', 'printer', ['src/ast.ts']]),
    );
    expect(rows['title of parser']).toEqual(['和「title of printer」改了同一个文件']);
    expect(rows['title of printer']).toEqual(['和「title of parser」改了同一个文件']);
    expect(rows['title of lead']).toEqual([]);
  });

  it('counts the other sessions when more than one changed the same file', () => {
    const rows = agentRows(
      [lead, spawned('a'), spawned('b'), spawned('c')],
      overlap(['a', 'b', ['src/ast.ts']], ['a', 'c', ['src/ast.ts']], ['b', 'c', ['src/ast.ts']]),
    );
    expect(rows['title of a']).toEqual(['和 2 个会话改了同一个文件']);
    expect(rows['title of c']).toEqual(['和 2 个会话改了同一个文件']);
  });

  it('says nothing without a shared file', () => {
    const rows = agentRows([lead, spawned('a'), spawned('b')], overlap());
    expect(rows['title of a']).toEqual([]);
    expect(rows['title of b']).toEqual([]);
  });

  it('keeps the headline and puts the line after it', () => {
    const rows = agentRows(
      [
        lead,
        spawned('a', { recap: { headline: 'Parser split', happened: '', at: 1 } }),
        spawned('b'),
      ],
      overlap(['a', 'b', ['src/ast.ts']]),
    );
    expect(rows['title of a']).toEqual(['Parser split', '和「title of b」改了同一个文件']);
  });

  it('shows only the failure when the last turn failed too', () => {
    const failed = spawned('a', {
      last_turn: { id: 't1', state: 'failed', error: 'Build failed', told_main_agent: true },
    });
    const rows = agentRows([lead, failed, spawned('b')], overlap(['a', 'b', ['src/ast.ts']]));
    expect(rows['title of a']).toHaveLength(1);
    expect(rows['title of a']![0]).toContain('Build failed');
    expect(rows['title of b']).toEqual(['和「title of a」改了同一个文件']);
  });
});

const item = (id: string, extra: Partial<PlanItemView> = {}): ShownPlanItem =>
  ({
    id,
    title: `Title of ${id}`,
    stage: 'write',
    status: 'running',
    gate_runs: [],
    ...extra,
  }) as ShownPlanItem;

const plan = (items: PlanItemView[]): Plan => ({
  session_id: 'lead',
  conductor_open: true,
  revision: 4,
  updated_at: '2026-11-26T09:00:00.000Z',
  milestones: [],
  items,
});

describe('a plan row whose session changed a file another open session changed', () => {
  const rowLines = (items: ShownPlanItem[], shared: ProjectOverlap | null) => {
    const sessions = [lead, spawned('parser'), spawned('printer')];
    const h = mount(
      () =>
        PlanList({
          plan: plan(items),
          sessions,
          selected: null,
          onSelect() {},
          overlap: shared,
        }) as ReactElement,
    );
    return Object.fromEntries(
      nodes(h.value)
        .filter((n) => n.type === PlanRow)
        .map((n) => {
          const [title, ...lines] = clipText(
            nodes(PlanRow(n.props)).find((c) => c.props.className === 'pj-t'),
          );
          return [title, { lines, reason: n.props.reason?.kind ?? null }];
        }),
    );
  };

  it('says so after the title, and only the failure under a failed item', () => {
    const rows = rowLines(
      [
        item('parse', { session_id: 'parser' }),
        item('print', {
          session_id: 'printer',
          status: 'failed',
          failure: {
            reason: 'Unit tests failed',
            handled_by: 'you',
            at: '2026-11-26T09:00:00.000Z',
          },
        }),
        item('later', { stage: 'plan', status: 'not_started' }),
      ],
      overlap(['parser', 'printer', ['src/ast.ts']]),
    );
    expect(rows['Title of parse']).toEqual({
      lines: ['和「title of printer」改了同一个文件'],
      reason: null,
    });
    expect(rows['Title of print']).toEqual({ lines: [], reason: 'failure' });
    expect(rows['Title of later']).toEqual({ lines: [], reason: null });
  });

  it('says nothing while the overlap is unread or failed', () => {
    const rows = rowLines([item('parse', { session_id: 'parser' })], null);
    expect(rows['Title of parse']).toEqual({ lines: [], reason: null });
  });
});

describe('the item inspector', () => {
  const PATHS = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
  const inspector = (read: { read: ProjectOverlap | null; error: string | null }) => {
    const reload = vi.fn();
    const shown = item('parse', { session_id: 'parser' });
    const h = mount(
      () =>
        ItemInspector({
          item: shown,
          plan: plan([shown]),
          projectId: 'alpha',
          sessions: [lead, spawned('parser'), spawned('printer'), spawned('lexer')],
          overlap: { ...read, reload },
          onClose() {},
        }) as ReactElement,
    );
    const section = nodes(h.value).find(
      (n) => n.type === 'section' && n.props['aria-label'] === '和别的会话改了同样的文件',
    );
    return { h, section, reload };
  };

  it('lists each overlapping session with at most five of its files and opens the session', () => {
    const { section } = inspector({
      read: overlap(['parser', 'printer', PATHS], ['lexer', 'parser', ['src/token.ts']]),
      error: null,
    });
    expect(section).toBeDefined();
    const groups = nodes(section).filter((n) => n.props.className === 'pj-ov');
    expect(groups.map((g) => clipText(g))).toEqual([['title of printer'], ['title of lexer']]);
    expect(
      nodes(groups[0])
        .filter((n) => n.type === 'li')
        .map((li) => text(li)),
    ).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', '还有 2 个']);
    expect(
      nodes(groups[1])
        .filter((n) => n.type === 'li')
        .map((li) => text(li)),
    ).toEqual(['src/token.ts']);
    nodes(groups[1])
      .find((n) => n.type === 'button')!
      .props.onClick();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: 'lexer' });
  });

  it('has no such section without a shared file', () => {
    expect(inspector({ read: overlap(['printer', 'lexer', ['x.ts']]), error: null }).section).toBe(
      undefined,
    );
  });

  it('says the read failed and offers a retry instead of the files', () => {
    const { section, reload } = inspector({
      read: overlap(['parser', 'printer', PATHS]),
      error: 'daemon gone',
    });
    expect(section).toBeDefined();
    expect(nodes(section).some((n) => n.props.className === 'pj-ov')).toBe(false);
    const failure = nodes(section).find(
      (n) => typeof n.type === 'function' && n.type.name === 'LoadError',
    )!;
    expect(failure.props.message).toContain('daemon gone');
    failure.props.onRetry();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('an unplanned change whose session changed a file another open session changed', () => {
  const change = (id: string): ChangeRow => ({
    id: `session:${id}`,
    kind: 'session',
    title: `title of ${id}`,
    runtime: 'codex',
    status: 'ready',
    gate: { state: 'passed' },
    changes: { files: 1, additions: 1, deletions: 0 },
    updated_at: '2026-11-26T09:00:00.000Z',
  });
  const rowLines = (shared: ProjectOverlap | null) => {
    const sessions = [lead, spawned('parser'), spawned('printer'), spawned('other')];
    const h = mount(
      () =>
        UnplannedList({
          rows: ['parser', 'printer', 'other'].map(change),
          sessions,
          overlap: shared,
        }) as ReactElement,
    );
    return Object.fromEntries(
      nodes(h.value)
        .filter((n) => n.type === ChangeLine)
        .map((n) => {
          const [title, ...lines] = clipText(
            nodes(ChangeLine(n.props)).find((c) => c.props.className === 'pj-t'),
          );
          return [title, lines];
        }),
    );
  };

  it("says so under the title, with the other session's title", () => {
    expect(rowLines(overlap(['parser', 'printer', ['src/ast.ts']]))).toEqual({
      'title of parser': ['和「title of printer」改了同一个文件'],
      'title of printer': ['和「title of parser」改了同一个文件'],
      'title of other': [],
    });
  });

  it('says nothing while the overlap is unread or failed', () => {
    expect(Object.values(rowLines(null)).flat()).toEqual([]);
  });
});
