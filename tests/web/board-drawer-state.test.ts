import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import {
  HookHost,
  deferred,
  find,
  mount,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const { runCommand, modelReads } = vi.hoisted(() => ({
  runCommand: vi.fn(),
  modelReads: [] as string[][],
}));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/runtime-models', () => ({
  useRuntimeModels: (_project: string, runtimes: string[]) => {
    modelReads.push([...runtimes]);
    return Object.fromEntries(
      runtimes.map((runtime) => [
        runtime,
        {
          state: 'ready',
          models: [
            {
              id: `${runtime}-small`,
              label: 'small',
              efforts: ['low', 'high'],
              default_effort: 'high',
              default: true,
            },
            { id: 'gpt-a', label: 'gpt a', efforts: ['low', 'medium', 'high'], default: false },
            { id: 'claude-opus', label: 'opus', efforts: ['high', 'xhigh'], default: false },
          ],
        },
      ]),
    );
  },
}));
import { STOP_REASON } from '@/data/plan-edit';
import { PlanEdit } from '@/screens/board/PlanEdit';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { TellLead } from '@/screens/board/TellLead';
import type { SnapshotSession } from '@/screens/board/panels-model';

const NOW = Date.UTC(2026, 10, 1, 12);
const noop = () => {};
const tell = (key: string) => zh(`board.lead.tell.${key}`);
const plan = (key: string) => zh(`board.plan.${key}`);

const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;

describe('telling the lead', () => {
  it('shows the sent state only for the item the message was about', () => {
    let target = { draft: '关于任务「A」（a）：\n', label: 'task A' };
    const host = new HookHost(() => TellLead({ lead, ...target, run: async () => null }));
    let tree = host.render();
    find(tree, (n) => n.props['aria-label'] === `${tell('title')} task A`).props.onClick();
    tree = host.render();
    named(tree, 'TellDialog').props.onSent();
    tree = host.render();
    expect(text(find(tree, (n) => n.type === 'button'))).toBe(tell('sent'));

    target = { draft: '关于任务「B」（b）：\n', label: 'task B' };
    tree = host.render();
    expect(text(find(tree, (n) => n.type === 'button'))).toBe(tell('title'));
  });

  it('names the button by the sent label it shows', () => {
    const host = new HookHost(() =>
      TellLead({ lead, draft: '关于任务「A」（a）：\n', label: 'task A', run: async () => null }),
    );
    let tree = host.render();
    find(tree, (n) => n.props['aria-label'] === `${tell('title')} task A`).props.onClick();
    tree = host.render();
    named(tree, 'TellDialog').props.onSent();
    tree = host.render();
    expect(find(tree, (n) => n.type === 'button').props['aria-label']).toBe(
      `${tell('sent')} task A`,
    );
  });

  it('keeps a later opening open when an earlier send completes', () => {
    const host = new HookHost(() =>
      TellLead({ lead, draft: '关于任务「A」（a）：\n', label: 'task A', run: async () => null }),
    );
    const root = (tree: ReturnType<typeof host.render>) =>
      find(tree, (n) => typeof n.props.onOpenChangeComplete === 'function').props;
    const button = (tree: ReturnType<typeof host.render>) => find(tree, (n) => n.type === 'button');
    let tree = host.render();
    button(tree).props.onClick();
    tree = host.render();
    const earlierSent = named(tree, 'TellDialog').props.onSent;

    root(tree).onOpenChange(false);
    tree = host.render();
    root(tree).onOpenChangeComplete(false);
    tree = host.render();
    button(tree).props.onClick();
    tree = host.render();

    earlierSent();
    tree = host.render();
    expect(root(tree).open).toBe(true);
  });

  it('holds the message read-only while it is being sent', async () => {
    const host = new HookHost(() =>
      TellLead({ lead, draft: '关于任务「A」（a）：\n', label: 'task A', run: async () => null }),
    );
    let tree = host.render();
    find(tree, (n) => n.type === 'button').props.onClick();
    tree = host.render();
    const reply = deferred<string | null>();
    const dialog = named(tree, 'TellDialog');
    const inner = new HookHost(() =>
      (dialog.type as (props: object) => ReturnType<typeof host.render>)({
        ...dialog.props,
        run: () => reply.promise,
      }),
    );
    let body = inner.render();
    expect(find(body, (n) => n.type === 'textarea').props.readOnly).toBeFalsy();
    find(body, (n) => n.type === 'button' && text(n) === tell('send')).props.onClick();
    body = await inner.flush();
    expect(find(body, (n) => n.type === 'textarea').props.readOnly).toBe(true);
    reply.resolve('failed');
    body = await inner.flush();
    expect(find(body, (n) => n.type === 'textarea').props.readOnly).toBeFalsy();
  });
});

const board = {
  since: NOW - 86_400_000,
  now: NOW,
  lanes: [],
  edges: [],
  merges: [],
  milestones: [],
  tasks: [
    {
      id: 'lead-1:importer',
      title: 'ship the importer',
      goal: '',
      scope: [],
      lane_id: null,
      milestone_id: null,
      status: 'running',
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
    },
  ],
} as unknown as BoardModel;

describe('closing the task drawer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stays mounted until the exit timeout when no transition has started yet', async () => {
    vi.useFakeTimers();
    const listeners = { addEventListener: noop, removeEventListener: noop };
    vi.stubGlobal('window', {
      ...listeners,
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', { ...listeners, activeElement: null });
    vi.stubGlobal('HTMLElement', class {});
    let taskId: string | null = 'lead-1:importer';
    const host = new HookHost(() =>
      TaskDrawer({
        model: board,
        taskId,
        onSelect: noop,
        onOpenSession: noop,
        onOpenStory: noop,
      }),
    );
    const aside = host.render();
    expect(aside).not.toBeNull();
    aside!.props.ref.current = { contains: () => false, getAnimations: () => [] };

    taskId = null;
    host.render();
    expect(await host.flush()).not.toBeNull();
    vi.advanceTimersByTime(400);
    expect(host.render()).toBeNull();
  });

  it('moves focus into the drawer when a control outside opens it', () => {
    const listeners = { addEventListener: noop, removeEventListener: noop };
    vi.stubGlobal('window', {
      ...listeners,
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
    });
    class Element {}
    vi.stubGlobal('HTMLElement', Element);
    vi.stubGlobal('document', { ...listeners, activeElement: new Element() });
    const close = { focus: vi.fn() };
    const host = new HookHost(
      () =>
        TaskDrawer({
          model: board,
          taskId: 'lead-1:importer',
          onSelect: noop,
          onOpenSession: noop,
          onOpenStory: noop,
        }),
      (aside) => {
        if (!aside) return;
        aside.props.ref.current = { contains: () => false, getAnimations: () => [] };
        find(
          aside,
          (n) => n.props['aria-label'] === zh('board.task.drawer.close'),
        ).props.ref.current = close;
      },
    );
    host.render();
    expect(close.focus).toHaveBeenCalled();
  });

  it('takes the leaving drawer out of the tab order after focus goes back', () => {
    const listeners = { addEventListener: noop, removeEventListener: noop };
    vi.stubGlobal('window', {
      ...listeners,
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
    });
    class Element {
      isConnected = true;
      focus = vi.fn();
    }
    vi.stubGlobal('HTMLElement', Element);
    const opener = new Element();
    vi.stubGlobal('document', { ...listeners, activeElement: opener });
    let taskId: string | null = 'lead-1:importer';
    const host = new HookHost(() =>
      TaskDrawer({
        model: board,
        taskId,
        onSelect: noop,
        onOpenSession: noop,
        onOpenStory: noop,
      }),
    );
    const aside = host.render()!;
    const el = { contains: () => true, getAnimations: () => [], inert: false };
    aside.props.ref.current = el;

    taskId = null;
    host.render();
    expect(opener.focus).toHaveBeenCalled();
    expect(el.inert).toBe(true);
    host.unmount();
  });
});

describe('editing a plan task in the drawer', () => {
  const lead = {
    id: 'lead-1',
    revision: 1,
    project_id: 'project-a',
    runtime: 'fixture',
    state: 'open',
    turn_count: 1,
  } as SnapshotSession;
  type Task = BoardModel['tasks'][number];
  type Lead = NonNullable<BoardModel['leads']>[number];
  const planTask = (extra: Partial<Task> = {}): Task => ({
    ...board.tasks[0]!,
    status: 'todo',
    owner_session_id: 'lead-1',
    state: 'todo',
    planned: { runtime: 'codex', model: 'gpt-a', effort: 'high' },
    pending_edit: false,
    ...extra,
  });
  const planBoard = (task: Task, extra: Partial<Lead> = {}) =>
    ({
      ...board,
      tasks: [task],
      leads: [
        {
          session_id: 'lead-1',
          title: 'lead',
          state: 'idle',
          inbox: 0,
          updated_at: 0,
          plan_version: 3,
          pending_edits: [],
          rejected_edits: [],
          ...extra,
        },
      ],
    }) as unknown as BoardModel;
  const modelOp = {
    type: 'set_task' as const,
    task_id: 'importer',
    patch: { model: 'claude-opus' },
  };
  const scope = { project_id: 'project-a', lead_session_id: 'lead-1' };
  const status = (runtime: string, installed = true) => ({
    runtime,
    enabled: true,
    installed,
    auth: { state: 'ok' },
  });
  let statuses: ReturnType<typeof status>[] = [];

  beforeEach(() => {
    const listeners = { addEventListener: noop, removeEventListener: noop };
    statuses = [status('claude'), status('codex')];
    modelReads.length = 0;
    vi.stubGlobal('window', {
      ...listeners,
      innerWidth: 1440,
      matchMedia: () => ({ matches: false }),
      pantheon: {
        query: async (method: string) =>
          method === 'runtime.status'
            ? { ok: true, value: statuses }
            : { ok: false, error: { code: 'unknown_route', message: method } },
      },
    });
    vi.stubGlobal('document', { ...listeners, activeElement: null });
    vi.stubGlobal('HTMLElement', class {});
    runCommand.mockReset();
    runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  /** The drawer's plan editor, rendered on its own from the props the drawer gives it. */
  function editor(model: () => BoardModel) {
    const drawer = mount(() =>
      TaskDrawer({
        model: model(),
        taskId: 'lead-1:importer',
        onSelect: noop,
        onOpenSession: noop,
        onOpenStory: noop,
        tell: { sessions: [lead], run: async () => null },
      }),
    );
    let props!: Parameters<typeof PlanEdit>[0];
    const refresh = () => (props = named(drawer.render(), 'PlanEdit').props);
    refresh();
    const h = mount(() => PlanEdit(props));
    return {
      h,
      tree: () => h.value,
      rerender: () => {
        refresh();
        return h.render();
      },
    };
  }
  const buttons = (tree: unknown) =>
    nodes(tree as never)
      .filter((n) => n.type === 'button')
      .map((n) => text(n));
  const button = (tree: unknown, label: string) =>
    find(tree as never, (n) => n.type === 'button' && text(n) === label);
  const field = (tree: unknown, key: string) =>
    find(tree as never, (n) => n.props['aria-label'] === plan(`field.${key}`)).props;

  it('sends a model change as a set_task edit and shows that it took effect', async () => {
    const e = editor(() => planBoard(planTask()));
    field(e.tree(), 'model').onChange('claude-opus');
    await e.h.flush();
    expect(runCommand.mock.calls).toEqual([
      ['board.plan.edit', { ...scope, base_version: 3, ops: [modelOp] }, null],
    ]);
    expect(text(e.rerender())).toContain(plan('edit.applied'));
  });

  it('moves the effort to one the new model takes', async () => {
    const planned = { runtime: 'codex', model: 'codex-only', effort: 'medium' as const };
    const e = editor(() => planBoard(planTask({ planned })));
    await e.h.flush();
    field(e.tree(), 'runtime').onValueChange('claude');
    await e.h.flush();
    field(e.tree(), 'model').onChange('claude-opus');
    await e.h.flush();
    const patches = runCommand.mock.calls.map((call) => call[1].ops[0].patch);
    expect(patches).toEqual([
      { runtime: 'claude', model: 'claude-small', effort: 'high' },
      { model: 'claude-opus', effort: 'high' },
    ]);
  });

  it('offers the installed runtimes in table order with the task own one, and lists models only for them', async () => {
    statuses = [
      status('gemini'),
      status('kiro', false),
      status('codex'),
      status('grok', false),
      status('claude'),
    ];
    const planned = { runtime: 'kiro', model: null, effort: null };
    const e = editor(() => planBoard(planTask({ planned } as never)));
    await e.h.flush();
    const radios = field(e.tree(), 'runtime');
    const offered = ['claude', 'codex', 'gemini', 'kiro'];
    expect([radios.children].flat().map((n) => n.props.value)).toEqual(offered);
    expect(radios.value).toBe('kiro');
    expect(modelReads.at(-1)).toEqual(offered);
    expect(modelReads.flat()).not.toContain('grok');
  });

  it('shows an edit the daemon held as waiting for the lead', async () => {
    runCommand.mockResolvedValue({ ok: true, value: { applied: false, edit_id: 'edit-2' } });
    const e = editor(() => planBoard(planTask()));
    field(e.tree(), 'model').onChange('claude-opus');
    await e.h.flush();
    const shown = text(e.rerender());
    expect(shown).toContain(plan('edit.pending'));
    expect(shown).not.toContain(plan('edit.applied'));
  });

  it('stops showing an edit as waiting once the lead has decided it', async () => {
    runCommand.mockResolvedValue({ ok: true, value: { applied: false, edit_id: 'edit-2' } });
    let listed = false;
    const waiting = {
      id: 'edit-2',
      task_ids: ['importer'],
      summary: 'set_task importer',
      state: 'pending' as const,
      ops: [modelOp],
      base_version: 3,
      created_at: NOW,
    };
    const e = editor(() =>
      planBoard(planTask({ pending_edit: listed }), { pending_edits: listed ? [waiting] : [] }),
    );
    field(e.tree(), 'model').onChange('claude-opus');
    await e.h.flush();
    listed = true;
    expect(text(e.rerender())).toContain(plan('edit.pending'));
    await e.h.flush();
    listed = false;
    expect(text(e.rerender())).not.toContain(plan('edit.pending'));
  });

  it('lists what a pending edit changes and withdraws it', async () => {
    const pending = {
      id: 'edit-9',
      task_ids: ['importer'],
      summary: 'set_task importer',
      state: 'pending' as const,
      ops: [modelOp],
      base_version: 3,
      created_at: NOW - 60_000,
    };
    const e = editor(() =>
      planBoard(planTask({ pending_edit: true }), { pending_edits: [pending] }),
    );
    expect(text(find(e.tree(), (n) => n.type === 's'))).toBe('gpt-a');
    expect(text(e.tree())).toContain('claude-opus');
    find(e.tree(), (n) => n.props['aria-label'] === plan('edit.withdrawLabel')).props.onClick();
    await e.h.flush();
    expect(runCommand.mock.calls).toEqual([
      ['board.plan.edit.withdraw', { ...scope, edit_id: 'edit-9' }, null],
    ]);
  });

  it("shows the lead's reason for a rejected edit and a way to reply", () => {
    const rejected = {
      id: 'edit-8',
      task_ids: ['importer'],
      ops: [modelOp],
      reason: 'keep gpt-a for the benchmark',
      resolved_at: NOW,
    };
    const e = editor(() => planBoard(planTask(), { rejected_edits: [rejected] }));
    expect(text(e.tree())).toContain(plan('edit.rejected'));
    expect(text(e.tree())).toContain('keep gpt-a for the benchmark');
    expect(named(e.tree(), 'TellLead').props.text).toBe(plan('edit.reply'));

    const { reason: _reason, ...silent } = rejected;
    const quiet = editor(() => planBoard(planTask(), { rejected_edits: [silent] }));
    expect(text(quiet.tree())).toContain(plan('edit.rejected'));
    expect(nodes(quiet.tree()).some((n) => n.props.className === 'bd-bn-why')).toBe(false);
  });

  it('sends a refused edit again on the new plan version, or drops it', async () => {
    runCommand.mockResolvedValue({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan is at version 4' },
    });
    let version = 3;
    const e = editor(() => planBoard(planTask(), { plan_version: version }));
    field(e.tree(), 'effort').onValueChange('low');
    await e.h.flush();
    version = 4;
    expect(text(e.rerender())).toContain(plan('edit.conflict'));
    const effort = { type: 'set_task', task_id: 'importer', patch: { effort: 'low' } };
    runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-3' } });
    button(e.tree(), plan('edit.retry').replace('{version}', '4')).props.onClick();
    await e.h.flush();
    expect(runCommand.mock.calls).toEqual([
      ['board.plan.edit', { ...scope, base_version: 3, ops: [effort] }, null],
      ['board.plan.edit', { ...scope, base_version: 4, ops: [effort] }, null],
    ]);
    expect(text(e.rerender())).toContain(plan('edit.applied'));

    runCommand.mockResolvedValue({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan is at version 5' },
    });
    field(e.tree(), 'effort').onValueChange('medium');
    await e.h.flush();
    e.rerender();
    button(e.tree(), plan('edit.discard')).props.onClick();
    expect(text(e.rerender())).not.toContain(plan('edit.conflict'));
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it('offers stop, restart and delete only where each command applies', async () => {
    const claim = { session_id: 's1', runtime: 'codex', model: 'gpt-a' };
    const running = editor(() => planBoard(planTask({ state: 'running', claim })));
    expect(buttons(running.tree())).toEqual(
      expect.arrayContaining([plan('task.stop'), plan('task.remove')]),
    );
    expect(buttons(running.tree())).not.toContain(plan('task.restart'));
    button(running.tree(), plan('task.stop')).props.onClick();
    await running.h.flush();
    expect(runCommand).not.toHaveBeenCalled();
    named(running.rerender(), 'StopDialog').props.onStop();
    await running.h.flush();
    expect(runCommand.mock.calls.at(-1)).toEqual([
      'task.stop',
      { ...scope, task_id: 'importer', reason: STOP_REASON },
      null,
    ]);

    const queued = editor(() => planBoard(planTask({ dispatch_wait: 'capacity' })));
    expect(buttons(queued.tree())).toContain(plan('task.stop'));

    const failed = editor(() => planBoard(planTask({ state: 'failed' })));
    expect(buttons(failed.tree())).toEqual(
      expect.arrayContaining([plan('task.restart'), plan('task.remove')]),
    );
    expect(buttons(failed.tree())).not.toContain(plan('task.stop'));
    button(failed.tree(), plan('task.restart')).props.onClick();
    await failed.h.flush();
    expect(runCommand.mock.calls.at(-1)).toEqual([
      'task.start',
      { ...scope, task_ids: ['importer'] },
      null,
    ]);
    button(failed.tree(), plan('task.remove')).props.onClick();
    await failed.h.flush();
    expect(runCommand.mock.calls.at(-1)).toEqual([
      'board.plan.edit',
      { ...scope, base_version: 3, ops: [{ type: 'remove_task', task_id: 'importer' }] },
      null,
    ]);

    const merged = editor(() => planBoard(planTask({ state: 'merged', status: 'done' })));
    for (const label of [plan('task.stop'), plan('task.restart'), plan('task.remove')])
      expect(buttons(merged.tree())).not.toContain(label);
  });
});
