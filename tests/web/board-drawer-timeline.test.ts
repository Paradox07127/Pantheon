import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel, TaskTraceEntry, TaskTraceKind } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { TaskThread } from '@/screens/board/TaskThread';
import { TraceList } from '@/screens/board/TaskTimeline';

type Task = BoardModel['tasks'][number];

const NOW = new Date(2026, 10, 1, 15, 0).getTime();
const AT = new Date(2026, 10, 1, 14, 5).getTime();
const noop = () => {};

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'done',
  blockers: [],
  segments: [
    {
      id: 'worker-1',
      session_id: 'worker-1',
      title: 'worker one',
      runtime: 'claude',
      model: 'claude-opus',
      status: 'done',
      started_at: null,
      ended_at: null,
      tokens: 0,
    },
  ],
  additions: 3,
  deletions: 1,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...patch,
});

const merge: BoardModel['merges'][number] = {
  session_id: 'worker-1',
  title: 'worker one',
  merged_at: AT,
  from_sha: '0123456789abcdef',
  sha: 'fedcba9876543210',
  additions: 184,
  deletions: 22,
  story_id: 'story-1',
};

const board = (tasks: Task[]): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [merge],
    milestones: [],
    tasks,
  }) as unknown as BoardModel;

const trace = (key: string) => zh(`board.task.trace.${key}`);
const NAMES: Record<TaskTraceKind, string> = {
  start_requested: trace('startRequested'),
  dispatched: trace('dispatched'),
  lead_message: trace('leadMessage'),
  report: trace('report'),
  handback: trace('handback'),
  accepted: trace('accepted'),
  gate_passed: trace('gatePassed'),
  gate_failed: trace('gateFailed'),
  merge_started: trace('mergeStarted'),
  merge_blocked: trace('mergeBlocked'),
  merged: trace('merged'),
  discarded: trace('discarded'),
  user_edit: trace('userEdit'),
};

const list = (entries: TaskTraceEntry[], onOpenSession: (id: string) => void = noop) =>
  TraceList({
    entries,
    merges: [merge],
    segments: task('lead-1:t1').segments,
    now: NOW,
    onOpenSession,
    onOpenStory: noop,
  });

describe('task drawer timeline', () => {
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    useBoard.setState({ board: null, events: [] });
  });

  it('names each of the trace kinds in Chinese', () => {
    const kinds = Object.keys(NAMES) as TaskTraceKind[];
    const tree = list(kinds.map((kind, i) => ({ at: AT + i, kind, text: `text of ${kind}` })));
    const names = nodes(tree)
      .filter((n) => n.props.className === 'bd-tl-n')
      .map(text);
    expect(names).toEqual(kinds.map((kind) => NAMES[kind]));
    expect(new Set(Object.values(NAMES)).size).toBe(kinds.length);
  });

  it('tells a user edit, a lead message and a report apart by glyph and placement', () => {
    const tree = list([
      { at: AT, kind: 'lead_message', session_id: 'worker-1', text: 'do it' },
      { at: AT + 1, kind: 'report', session_id: 'worker-1', text: 'done' },
      { at: AT + 2, kind: 'user_edit', text: 'model changed' },
    ]);
    const items = nodes(tree).filter((n) => n.type === 'li');
    expect(items.map((n) => n.props['data-kind'])).toEqual(['lead_message', 'report', 'user_edit']);
    const glyphs = items.map((n) =>
      JSON.stringify(find(n, (g) => g.props.className === 'bd-tl-g').props.children),
    );
    expect(new Set(glyphs).size).toBe(3);
  });

  it('shows the commit range, change counts and story link on the merged entry', () => {
    const tree = list([{ at: AT + 2_000, kind: 'merged', session_id: 'worker-1' }]);
    expect(text(tree)).toContain('0123456..fedcba9');
    expect(text(tree)).toContain('+184');
    expect(text(tree)).toContain('−22');
    const story = zh('board.task.story.openLabel').replace('{title}', 'worker one');
    find(tree, (n) => n.props['aria-label'] === story);
  });

  it('opens the session of an entry that names one', () => {
    const open = vi.fn();
    const tree = list([{ at: AT, kind: 'report', session_id: 'worker-1', text: 'done' }], open);
    find(tree, (n) => n.type === 'button' && text(n) === NAMES.report).props.onClick();
    expect(open).toHaveBeenCalledWith('worker-1');
  });

  it('puts the merge into the thread only, and shows no thread for a session without a task', () => {
    const listeners = { addEventListener: noop, removeEventListener: noop };
    vi.stubGlobal('window', {
      ...listeners,
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', { ...listeners, activeElement: null });
    vi.stubGlobal('HTMLElement', class {});
    const drawer = (model: BoardModel, taskId: string) =>
      mount(() =>
        TaskDrawer({ model, taskId, onSelect: noop, onOpenSession: noop, onOpenStory: noop }),
      ).value;
    const mergeHeading = zh('board.task.drawer.merge');
    const headings = (tree: ReturnType<typeof drawer>) =>
      nodes(tree)
        .filter((n) => n.type === 'h3')
        .map(text);
    const plan = drawer(board([task('lead-1:t1')]), 'lead-1:t1');
    expect(nodes(plan).some((n) => n.type === TaskThread)).toBe(true);
    expect(headings(plan)).not.toContain(mergeHeading);
    const adhoc = drawer(board([task('worker-1')]), 'worker-1');
    expect(nodes(adhoc).some((n) => n.type === TaskThread)).toBe(false);
    expect(headings(adhoc)).toContain(mergeHeading);
  });
});
