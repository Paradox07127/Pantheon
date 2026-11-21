import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { AlertDialog } from '../../apps/web/node_modules/@base-ui/react/alert-dialog/index.mjs';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import type { SnapshotSession } from '@/screens/board/panels-model';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 12, 12);
const noop = () => {};
const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: 'lead-1:importer',
    owner_session_id: 'lead-1',
    title: 'ship the importer',
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'running',
    state: 'running',
    blockers: [],
    segments: [],
    additions: null,
    deletions: null,
    checks: 'none',
    started_at: null,
    ended_at: null,
    last_progress_at: null,
    blocked_since: null,
    turn_running: true,
    claim: { session_id: 'session-1', runtime: 'codex', model: null },
    ...extra,
  }) as Task;

const board = (row: Task) =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    milestones: [],
    tasks: [row],
    leads: [{ session_id: 'lead-1', title: 'lead', state: 'idle', inbox: 0, updated_at: 0 }],
  }) as unknown as BoardModel;

const run = vi.fn(async (..._args: unknown[]) => null as string | null);
const drawer = (row: Task) =>
  mount(() =>
    TaskDrawer({
      model: board(row),
      taskId: row.id,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
      tell: { sessions: [lead], run },
    }),
  );
/** The button of a drawer action and its dialog, rendered from the props the drawer gives them. */
function dialogOf(element: { type: unknown; props: object }, opener: string, name: string) {
  const h = mount(() => (element.type as (p: object) => ReactNode)(element.props));
  find(h.value, (n) => n.type === 'button' && text(n) === opener).props.onClick();
  h.render();
  const dialog = named(h.value, name);
  return mount(() => (dialog.type as (p: object) => ReactNode)(dialog.props));
}
const handBack = (tree: unknown) =>
  nodes(tree as never).find((n) => typeof n.type === 'function' && n.type.name === 'HandBack');

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  run.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('handing a task back to its lead', () => {
  it('offers the hand-back only while the task has an unfinished session', () => {
    expect(handBack(drawer(task()).value)).toBeDefined();
    expect(handBack(drawer(task({ state: 'gating' })).value)).toBeDefined();
    expect(handBack(drawer(task({ claim: undefined, state: 'todo' })).value)).toBeUndefined();
    expect(handBack(drawer(task({ state: 'merged', status: 'done' })).value)).toBeUndefined();
    expect(handBack(drawer(task({ state: 'failed', status: 'failed' })).value)).toBeUndefined();
  });

  it('keeps the task actions below the scrolling body, as the last row of the drawer', () => {
    const parts = (row: Task) =>
      [drawer(row).value!.props.children].flat().filter(Boolean) as { props: any }[];
    const shown = parts(task());
    expect(shown.at(-1)!.props.className).toBe('bd-dstart');
    expect(handBack(shown.at(-1))).toBeDefined();
    const body = shown.find((n) => n.props.className === 'bd-dbody')!;
    expect(nodes(body as never).some((n) => n.props.className === 'bd-dstart')).toBe(false);
    expect(parts(task({ owner_session_id: undefined })).at(-1)!.props.className).toBe('bd-dbody');
  });

  it('keeps the action row of the docked drawer at the bottom of the canvas, under the scrolling body', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/board/flow.css', import.meta.url),
      'utf8',
    );
    expect(css).toMatch(/\n\.bd-drw \{[^}]*min-height: 0;[^}]*display: flex;/);
    expect(css).toMatch(/\.bd-dbody \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
  });

  const opened = () =>
    dialogOf(handBack(drawer(task()).value)!, zh('board.task.handback.open'), 'HandBackDialog');
  const send = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'button' && text(n) === zh('board.task.handback.send'));
  const reason = (tree: unknown) =>
    find(tree as never, (n) => n.props['aria-label'] === zh('board.task.handback.reason'));

  it('needs a reason, then sends task.handback with it', async () => {
    const d = opened();
    expect(send(d.value).props.disabled).toBe(true);
    reason(d.value).props.onChange({ target: { value: '  tests skip the empty file case ' } });
    d.render();
    send(d.value).props.onClick();
    await d.flush();
    expect(run.mock.calls).toEqual([
      [
        'task.handback',
        {
          lead_session_id: 'lead-1',
          task_id: 'importer',
          reason: 'tests skip the empty file case',
        },
        null,
      ],
    ]);
  });

  it("shows the daemon's refusal", async () => {
    run.mockResolvedValueOnce('Task importer has no unfinished session');
    const d = opened();
    reason(d.value).props.onChange({ target: { value: 'redo it' } });
    d.render();
    send(d.value).props.onClick();
    await d.flush();
    expect(text(find(d.value, (n) => n.props.role === 'alert'))).toBe(
      'Task importer has no unfinished session',
    );
  });
});

describe('reassigning or cancelling a task from the drawer', () => {
  const queued = (extra: Partial<Task> = {}) =>
    task({
      status: 'todo',
      state: 'todo',
      turn_running: false,
      claim: undefined,
      dispatch_wait: 'device_resource',
      planned: { device: 'ws', uses: { gpu: 1 } },
      ...extra,
    });
  const component = (tree: unknown, name: string) =>
    nodes(tree as never).find((n) => typeof n.type === 'function' && n.type.name === name);
  const footer = (row: Task) =>
    ([drawer(row).value!.props.children].flat().filter(Boolean) as { props: any }[]).at(-1)!;

  it('offers to have the lead reassign a task sent to a device', () => {
    const tell = component(footer(queued()), 'TellLead')!;
    expect(tell.props.text).toBe(zh('board.task.drawer.reassign'));
    expect(tell.props.lead).toBe(lead);
    expect(tell.props.draft).toBe(
      zh('board.tellLead.draftTask')
        .replace('{title}', 'ship the importer')
        .replace('{id}', 'importer'),
    );
    expect(component(footer(queued({ planned: {} })), 'TellLead')).toBeUndefined();
    expect(
      component(
        footer(queued({ state: 'merged', status: 'done', dispatch_wait: undefined })),
        'TellLead',
      ),
    ).toBeUndefined();
  });

  it('offers to cancel a task that is queued or has an unfinished session', () => {
    expect(component(footer(queued()), 'CancelTask')).toBeDefined();
    expect(component(footer(task()), 'CancelTask')).toBeDefined();
    expect(component(drawer(queued({ dispatch_wait: undefined })).value, 'CancelTask')).toBe(
      undefined,
    );
  });

  it('asks before cancelling a task in an alert dialog', () => {
    const cancel = component(drawer(queued()).value, 'CancelTask')!;
    const h = mount(() => (cancel.type as (p: object) => ReactNode)(cancel.props));
    expect(nodes(h.value).some((n) => n.type === AlertDialog.Root)).toBe(true);
    const d = dialogOf(cancel, zh('board.task.cancel.open'), 'CancelDialog');
    expect(text(find(d.value, (n) => n.type === AlertDialog.Title))).toBe(
      zh('board.task.cancel.open'),
    );
  });

  it('needs a reason, then sends task.stop for the task in its lead plan', async () => {
    const cancel = zh('board.task.cancel.open');
    const d = dialogOf(component(drawer(queued()).value, 'CancelTask')!, cancel, 'CancelDialog');
    const confirm = () => find(d.value, (n) => n.type === 'button' && text(n) === cancel);
    expect(confirm().props.disabled).toBe(true);
    find(d.value, (n) => n.props['aria-label'] === zh('board.task.cancel.reason')).props.onChange({
      target: { value: ' no gpu free this week ' },
    });
    d.render();
    confirm().props.onClick();
    await d.flush();
    expect(run.mock.calls).toEqual([
      [
        'task.stop',
        {
          project_id: 'project-a',
          lead_session_id: 'lead-1',
          task_id: 'importer',
          reason: 'no gpu free this week',
        },
        null,
      ],
    ]);
  });
});

describe('what the drawer offers on a task its lead works on or a session cannot open on yet', () => {
  const direct = (extra: Partial<Task> = {}) =>
    task({ claim: { session_id: 'lead-1', runtime: 'codex', model: null }, ...extra });
  const starts = (row: Task) =>
    nodes(
      mount(() =>
        TaskDrawer({
          model: board(row),
          taskId: row.id,
          onSelect: noop,
          onOpenSession: noop,
          onOpenStory: noop,
          onStartTask: noop,
          tell: { sessions: [lead], run },
        }),
      ).value as never,
    ).some((n) => n.type === 'button' && text(n) === zh('board.task.drawer.start'));
  const todo = (extra: Partial<Task> = {}) =>
    task({ status: 'todo', state: 'todo', turn_running: false, claim: undefined, ...extra });

  it('offers no hand-back on a task its lead claimed itself', () => {
    expect(handBack(drawer(direct()).value)).toBeUndefined();
  });

  it('offers a new session only while the daemon would open one', () => {
    expect(starts(todo())).toBe(true);
    expect(starts(task({ state: 'merged', status: 'done' }))).toBe(true);
    expect(starts(task())).toBe(false);
    expect(starts(direct({ state: 'merged', status: 'done' }))).toBe(false);
    expect(starts(todo({ blocked_since: NOW - 60_000 }))).toBe(false);
    for (const wait of ['upstream', 'scope', 'answer'] as const)
      expect(starts(todo({ dispatch_wait: wait }))).toBe(false);
    expect(starts(todo({ dispatch_wait: 'capacity' }))).toBe(true);
  });
});
