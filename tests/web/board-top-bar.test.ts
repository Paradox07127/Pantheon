import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel, DeviceListItem } from '@pantheon/protocol';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'top-bar' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    (selector: any) => selector({ openSession() {}, openSessionGroup() {}, openTaskSession() {} }),
    { setState() {}, getState: () => ({}) },
  ),
}));
vi.mock('@/data/runtime-models', () => ({
  useRuntimeModels: (_project: string, runtimes: string[]) =>
    Object.fromEntries(runtimes.map((runtime) => [runtime, { state: 'ready', models: [] }])),
}));
import { TopBar } from '@/components/TopBar';
import { BoardDevices, DeviceState, ResourceMeter } from '@/screens/board/BoardDevices';
import { BoardScreen, BoardView } from '@/screens/board/BoardScreen';
import { FlowGroupControl, MainView } from '@/screens/board/MainView';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { CanvasBar, type CanvasState } from '@/screens/board/CanvasView';
import { EditButton } from '@/screens/board/EditMode';
import { NewTask } from '@/screens/board/NewTask';
import { LeadPlan } from '@/screens/board/LeadPlan';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const noop = () => {};
type Task = BoardModel['tasks'][number];

const task = (id: string): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    scope: [],
    lane_id: 'lead-1:main',
    milestone_id: null,
    status: 'todo',
    state: 'todo',
    blockers: [],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'none',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
    depends_on: [],
    planned: {},
    pending_edit: false,
  }) as unknown as Task;

const board = (): BoardModel =>
  ({
    since: NOW - 7 * DAY,
    now: NOW,
    headline: null,
    counts: {
      running: 0,
      waiting: 1,
      ready: 1,
      failed: 0,
      merged: 0,
      median_ms: null,
      tokens: 0,
      tokens_by_runtime: {},
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
      cost_usd: null,
    },
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    iterations: [],
    tasks: [task('a'), task('b')],
    edges: [],
    milestones: [],
    burnup: [],
    task_progress: {
      totals: {
        done: 0,
        running: 0,
        waiting: 0,
        idle: 0,
        ready: 2,
        failed: 0,
        discarded: 0,
        not_started: 0,
      },
      daily: [],
      cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
    },
    usage: [],
    models: [],
    merges: [],
    findings: [],
    risks: [],
    needs: [
      {
        source: { table: 'approvals', id: 'approval-1', revision: 1 },
        kind: 'approval.requested',
        project_id: 'project-a',
        status: 'pending',
        created_at: NOW - 60_000,
        reason: 'approval_pending',
        actions: [],
        unblocks: 1,
      },
    ],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: NOW,
        plan_version: 4,
        pending_edits: [],
        rejected_edits: [],
      },
    ],
  }) as unknown as BoardModel;

const view = (page: 'now' | 'history' | 'canvas' = 'now') =>
  BoardView({
    model: board(),
    loading: false,
    error: null,
    onRetry: noop,
    range: 'active',
    onRange: noop,
    page,
    onPage: noop,
    projectId: 'project-a',
    onOpenSession: noop,
    onOpenStory: noop,
    onOpenTrace: noop,
    actions: { milestones: [], sessions: [], run: vi.fn() },
  });

const has = (tree: ReactNode, name: string) =>
  nodes(tree).some((n) => typeof n.type === 'function' && n.type.name === name);
const bar = (tree: ReactNode) => find(tree, (n) => n.type === TopBar);
const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const css = (file: string) =>
  readFileSync(new URL(`../../apps/web/src/screens/board/${file}`, import.meta.url), 'utf8');

let stored: Record<string, string>;
beforeEach(() => {
  stored = {};
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => void (stored[key] = value),
  });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(() => new Promise(() => {})),
      command: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the board top bar', () => {
  it('holds the view tabs as the bar segmented control, with no second header row', () => {
    const tree = mount(() => view()).value;
    const tabs = labelled(bar(tree).props.children, zh('board.view.label'));
    expect(tabs.props.className.split(' ')).toContain('tb-seg');
    expect(tabs.props.value).toBe('now');
    expect(nodes(tree).some((n) => n.props.className === 'bd-bar')).toBe(false);
  });

  it('opens the now page on the in-progress range', () => {
    const h = mount(() =>
      find(
        BoardScreen({ projectId: 'project-a', onOpenSession: noop }),
        (n) => n.type === BoardView,
      ),
    );
    expect(h.value.props.range).toBe('active');
  });

  it('reads today for in progress and the last 3 or 7 days for the other ranges', async () => {
    const h = mount(() =>
      find(
        // A project no other test reads, so no earlier read of the same range is shared.
        BoardScreen({ projectId: 'project-range', onOpenSession: noop }),
        (n) => n.type === BoardView,
      ),
    );
    const query = (window as any).pantheon.query;
    const days = () =>
      query.mock.calls.filter(([type]: [string]) => type === 'board.view').at(-1)[1].days;
    await h.flush();
    expect(days()).toBe('1');
    h.value.props.onRange(3);
    await h.flush();
    expect(days()).toBe('3');
    h.value.props.onRange(7);
    await h.flush();
    expect(days()).toBe('7');
  });

  it('puts the grouping in the bar, and the flow chart bands by the group picked there', () => {
    const tree = mount(() => view()).value;
    const control = named(bar(tree).props.children, 'FlowGroupControl');
    const group = mount(() =>
      (control.type as (p: object) => ReactElement<any>)(control.props),
    ).value;
    expect(group.props['aria-label']).toBe(zh('board.canvas.group.label'));
    group.props.onValueChange('state');
    const main = mount(() =>
      MainView({
        model: board(),
        projectId: 'project-a',
        selected: null,
        onSelect: noop,
        onOpenSession: noop,
      }),
    ).value;
    expect(named(main, 'FlowChart').props.group).toBe('state');
    expect(nodes(main).some((n) => n.props['aria-label'] === zh('board.canvas.group.label'))).toBe(
      false,
    );
    expect(FlowGroupControl).toBe(control.type);
  });

  it("puts the whole history's range at the right end of the bar, with no grid around the page", () => {
    const h = mount(() => view('history'));
    const end = find(bar(h.value).props.children, (n) => n.props.className === 'tb-end');
    const slot = find(end, (n) => typeof n.props.ref === 'function');
    const element = { nodeType: 1 } as unknown as HTMLElement;
    slot.props.ref(element);
    h.render();
    expect(named(h.value, 'HistoryTab').props.bar).toBe(element);
    expect(nodes(h.value).some((n) => n.props.className === 'bd-grid')).toBe(false);
  });

  it('leaves the needs-you request cards off the board', () => {
    const tree = mount(() => view()).value;
    expect(has(tree, 'NeedsStrip')).toBe(false);
    expect(nodes(tree).some((n) => n.props.className === 'bd-need')).toBe(false);
  });

  it('docks the open task drawer as the second column of the body, the chart kept in place', () => {
    const h = mount(() => view());
    const split = () => find(h.value, (n) => n.props.className === 'bd-split');
    const columns = () => [split().props.children].flat().filter(Boolean) as ReactElement<any>[];
    const before = columns()[0]!;
    named(h.value, 'MainView').props.onSelect('lead-1:a');
    h.render();
    const [body, drawer] = columns();
    expect(body!.props.className).toBe(before.props.className);
    expect(body!.key).toBe(before.key);
    expect(drawer!.type).toBe(TaskDrawer);
    expect(drawer!.props.taskId).toBe('lead-1:a');
    expect(has(named(h.value, 'MainView'), 'TaskDrawer')).toBe(false);

    expect(css('board.css')).toMatch(
      /\.bd-split:has\(> \.bd-drw\) \{[^}]*grid-template-columns: minmax\(0, 1fr\) 400px;/,
    );
    const drawerRule = /\n\.bd-drw \{([^}]*)\}/.exec(css('flow.css'))![1]!;
    expect(drawerRule).not.toContain('position: fixed');
  });

  it('puts the device summary at the right end of the bar', () => {
    for (const page of ['now', 'history', 'canvas'] as const) {
      const end = find(
        bar(mount(() => view(page)).value).props.children,
        (n) => n.props.className === 'tb-end',
      );
      expect(has(end, 'BoardDevices')).toBe(true);
    }
  });
});

describe('the board top bar in a narrow window', () => {
  const sheet = (file: string) =>
    readFileSync(new URL(`../../apps/web/src/${file}`, import.meta.url), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
  // The rules inside each `@container tb (width < N)` block of the sheets.
  const narrowRules = (width: number) =>
    ['index.css', 'screens/board/board.css'].flatMap((file) => {
      const css = sheet(file);
      const blocks: string[] = [];
      const head = `@container tb (width < ${width}px)`;
      for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
        let depth = 0;
        let end = css.indexOf('{', at);
        const start = end + 1;
        do {
          if (css[end] === '{') depth++;
          if (css[end] === '}') depth--;
          end++;
        } while (depth > 0);
        blocks.push(css.slice(start, end - 1));
      }
      return blocks.flatMap((block) =>
        [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
          selector: m[1]!.trim().replace(/\s+/g, ' '),
          body: m[2]!.replace(/\s/g, ''),
        })),
      );
    });
  const shortened = (button: ReactElement<any>, label: string) => {
    expect(button.props['aria-label']).toBe(label);
    expect(button.props.title).toBe(label);
    expect(text(find(button, (n) => n.props.className === 'tb-lbl'))).toBe(label);
  };

  it('names each icon and text button by its text, the text kept in a label the bar can hide', async () => {
    shortened(
      mount(() => EditButton({ projectId: 'project-a', disabled: false })).value,
      zh('board.editMode.edit'),
    );
    const counted = mount(() =>
      EditButton({ projectId: 'project-a', disabled: false, count: 2 }),
    ).value;
    expect(text(find(counted, (n) => n.props.className === 'tb-lbl'))).toBe(
      zh('board.editMode.edit'),
    );
    expect(find(counted, (n) => n.props.className === 'bd-ed-n')).toBeTruthy();
    shortened(
      find(
        mount(() => NewTask({ model: board(), disabled: false, onNew: noop })).value,
        (n) => n.type === 'button',
      ),
      zh('board.newTask.title'),
    );
    const canvas = {
      editing: false,
      setEditing: noop,
      refreshable: [{}],
      progress: null,
      refreshAll: noop,
    } as unknown as CanvasState;
    const [refresh, edit] = [
      CanvasBar({ canvas, empty: false }).props.children,
    ].flat() as ReactElement<any>[];
    shortened(refresh!, zh('board.canvas.refreshAll'));
    shortened(edit!, zh('board.canvas.editLayout'));
    const done = CanvasBar({ canvas: { ...canvas, editing: true }, empty: false });
    expect(nodes(done).some((n) => n.props.className === 'tb-lbl')).toBe(false);

    vi.stubGlobal('window', {
      pantheon: { query: vi.fn(async () => ({ ok: true, value: [] })) },
    });
    const h = mount(() => BoardDevices());
    await h.flush();
    const trigger = find(h.value, (n) => n.props.className === 'btn ghost bdv-tg');
    expect(trigger.props.title).toBe(trigger.props['aria-label']);
    expect(text(find(trigger, (n) => n.props.className === 'tb-lbl'))).toBe(
      zh('board.devices.title'),
    );
  });

  it('names each view tab, its text kept in a label the bar can hide', () => {
    const tabs = labelled(bar(mount(() => view()).value).props.children, zh('board.view.label'));
    const radios = nodes(tabs.props.children).filter((n) => n.props.value !== undefined);
    expect(radios.map((r) => r.props['aria-label'])).toEqual([
      zh('board.history.span.now'),
      zh('board.history.span.history'),
      zh('board.view.canvas'),
    ]);
    expect(radios.map((r) => text(find(r, (n) => n.props.className === 'tb-lbl')))).toEqual([
      zh('board.history.span.now'),
      zh('board.history.span.history'),
      zh('board.view.canvas'),
    ]);
  });

  it('folds by its own width: lead plan off under 1280px, icons only under 1180px, the tab text off under 960px', () => {
    expect(sheet('index.css')).toMatch(/\.tb\{[^}]*container:tb\/inline-size/);
    const hides = (width: number) =>
      narrowRules(width)
        .filter((rule) => rule.body.includes('display:none'))
        .map((rule) => rule.selector);
    expect(hides(1280)).toContain('.tb > .bgl');
    expect(hides(1180).some((selector) => selector.includes('.tb-lbl'))).toBe(true);
    expect(hides(1180)).toContain('.bd-bar-v');
    expect(hides(960).some((selector) => selector.includes('.tb-lbl'))).toBe(true);
  });

  it('says only the plan sentence and its time in the bar, so the sentence has the room', () => {
    const plan = LeadPlan({
      headline: { text: 'Ship the importer', by_session: 'lead-1', updated_at: NOW },
    });
    const at = text(find(plan, (n) => n.type === 'time'));
    expect(at).toMatch(/^\d\d:\d\d$/);
    expect(text(plan)).toBe(`Ship the importer${at}`);
  });
});

describe('the device summary', () => {
  const device = (id: string, online: boolean, extra: Partial<DeviceListItem> = {}) =>
    ({
      id,
      name: id,
      labels: [],
      resources: {},
      max_sessions: 2,
      online,
      checked_at: new Date(NOW).toISOString(),
      runtimes: {},
      tools: {},
      load: { sessions: 0, uses: {}, active_sessions: [] },
      ...extra,
    }) as DeviceListItem;
  const answer = (devices: DeviceListItem[]) =>
    vi.stubGlobal('window', {
      pantheon: { query: vi.fn(async () => ({ ok: true, value: devices })) },
    });
  async function summary() {
    const h = mount(() => BoardDevices());
    await h.flush();
    return h;
  }

  it('shows nothing until device.list has answered', () => {
    expect(mount(() => BoardDevices()).value).toBeNull();
  });

  it('counts the online devices of all, and lists each with its state and load', async () => {
    answer([
      device('local', true, { os: 'macos', load: { sessions: 3, uses: {}, active_sessions: [] } }),
      device('ws', true, {
        resources: { gpu: 1 },
        load: { sessions: 1, uses: { gpu: 1 }, active_sessions: [] },
      }),
      device('pi5', false, { resources: { camera: 1 } }),
    ]);
    const tree = (await summary()).value;
    const trigger = find(tree, (n) => n.props.className === 'btn ghost bdv-tg');
    expect(trigger.props['aria-label']).toBe('设备，3 台里 2 台在线');
    expect(text(trigger)).toBe('设备2 / 3');
    const rows = nodes(tree).filter((n) => n.props.className === 'bdv-d');
    expect(rows.map((r) => text(r))).toEqual(['这台 Mac3 个会话', 'ws会话 1 / 2gpu', 'pi5连不上']);
    const states = nodes(tree)
      .filter((n) => n.type === DeviceState)
      .map((n) => DeviceState(n.props));
    expect(states.map((s) => [s.props.ok, s.props.label])).toEqual([
      [true, zh('settings.devices.online')],
      [true, zh('settings.devices.online')],
      [false, zh('settings.devices.offline')],
    ]);
    const use = find(rows[1], (n) => n.type === ResourceMeter);
    expect(text(ResourceMeter(use.props))).toBe('1 / 1');
    const meter = find(ResourceMeter(use.props), (n) => n.props.role === 'meter');
    expect(meter.props.className).toBe('meter bdv-meter');
    expect(meter.props['data-full']).toBe(true);
    expect(meter.props['aria-label']).toBe('ws 的 gpu：1 个里占用 1 个');
  });
});
