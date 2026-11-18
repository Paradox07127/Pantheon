import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { t } from '@/i18n';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'frame-id' }),
);
import { BoardView } from '@/screens/board/BoardScreen';
import { Clip } from '@/components/Clip';
import { Milestones, useFloatTip } from '@/screens/board/Charts';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
import { TaskProgressStrip } from '@/screens/board/ProgressCharts';
import type { BoardMilestone, SnapshotMilestone } from '@/screens/board/panels-model';

const NOW = Date.UTC(2026, 10, 1, 12);
const say = (id: string, values: Record<string, string | number>) =>
  t({ id, defaultMessage: '' }, values);
const acceptLabel = (milestone: string) => say('board.milestones.acceptLabel', { milestone });
const reviseLabel = (milestone: string) => say('board.milestones.reviseLabel', { milestone });
const labelled = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.props['aria-label'] === label);
const groupNamed = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.props.role === 'group' && n.props['aria-label'] === label);
const buttonNamed = (tree: unknown, label: string) =>
  find(tree as ReactElement, (n) => n.type === 'button' && text(n) === label);
/** Renders the frame inside the dialog element `dialog` returns, read again on each render. */
const inside = (dialog: () => ReactElement<any>) =>
  new HookHost(() => {
    const frame = (dialog().type as (props: unknown) => ReactElement<any>)(dialog().props);
    return (frame.type as (props: unknown) => ReactElement<any>)(frame.props);
  });

const milestone = (
  status: BoardMilestone['status'],
  accepted: [boolean, boolean],
): BoardMilestone => ({
  id: 'ms-1',
  title: 'first release',
  session_ids: ['s-1'],
  merged: 1,
  status,
  criteria: [
    { text: 'Exports download', accepted: accepted[0] },
    { text: 'Docs name the format', accepted: accepted[1] },
  ],
});
const stored = {
  id: 'ms-1',
  revision: 2,
  project_id: 'project-a',
  title: 'first release',
  required_sessions: ['s-1'],
  criteria: ['Exports download', 'Docs name the format'],
  created_at: NOW,
  updated_by: 'user',
} as SnapshotMilestone;
const model = (ms: BoardMilestone) =>
  ({
    now: NOW,
    merges: [{ session_id: 's-1', title: 'Task A' }],
    milestones: [ms],
  }) as unknown as BoardModel;

describe('accepting a milestone criterion by criterion', () => {
  it('keeps the submit disabled until every criterion is checked, then sends their indices', () => {
    const run = vi.fn(async (..._args: unknown[]) => null);
    const ready = model(milestone('ready_for_acceptance', [false, false]));
    const actions = { projectId: 'project-a', milestones: [stored], sessions: [], run };
    const board = new HookHost(() => Milestones({ model: ready, actions }));
    let tree = board.render();
    labelled(tree, acceptLabel('first release')).props.onClick();
    tree = board.render();
    const dialog = named(tree, 'AcceptDialog');
    const host = inside(() => dialog);
    const parts = () => {
      const out = host.render();
      const group = groupNamed(out, zh('board.milestones.criteria'));
      const boxes = nodes(group).filter((n) => n.type === 'input');
      const submit = buttonNamed(out, zh('board.accept.submit'));
      const described = submit.props['aria-describedby'];
      const reason = described
        ? text(find(out, (n) => n.props.id === described && n.props.hidden))
        : null;
      return { out, boxes, submit, reason };
    };

    let now = parts();
    expect(text(labelled(now.out, zh('board.milestones.criteria')))).toContain('Exports download');
    expect(now.boxes.map((box) => box.props.checked)).toEqual([false, false]);
    expect(now.submit.props.disabled).toBe(true);
    expect(now.reason).toContain('2');
    expect(find(now.out, (n) => typeof n.props.content === 'string').props.content).toBe(
      now.reason,
    );

    now.boxes[1]!.props.onChange();
    now = parts();
    expect(now.submit.props.disabled).toBe(true);
    expect(now.reason).toContain('1');

    now.boxes[0]!.props.onChange();
    now = parts();
    expect(now.boxes.map((box) => box.props.checked)).toEqual([true, true]);
    expect(now.submit.props.disabled).toBe(false);
    expect(now.submit.props['aria-describedby']).toBeUndefined();
    now.submit.props.onClick();
    expect(run).toHaveBeenCalledWith(
      'milestone.accept',
      { milestone_id: 'ms-1', evidence_refs: ['session:s-1'], criteria_checked: [0, 1] },
      2,
    );
  });

  it('shows the stored criteria of the revision it submits, not an older board copy', () => {
    const run = vi.fn(async (..._args: unknown[]) => null);
    const ready: BoardMilestone = {
      ...milestone('ready_for_acceptance', [false, false]),
      criteria: [{ text: 'Exports download', accepted: false }],
    };
    const revised = {
      ...stored,
      revision: 3,
      criteria: ['Exports download as CSV', 'Docs name the format'],
    } as SnapshotMilestone;
    const actions = { projectId: 'project-a', milestones: [revised], sessions: [], run };
    const shown = model(ready);
    const board = new HookHost(() => Milestones({ model: shown, actions }));
    let tree = board.render();
    labelled(tree, acceptLabel('first release')).props.onClick();
    tree = board.render();
    const dialog = named(tree, 'AcceptDialog');
    const host = inside(() => dialog);
    let out = host.render();
    const group = () => groupNamed(out, zh('board.milestones.criteria'));
    expect(text(group())).toContain('Exports download as CSV');
    expect(text(group())).toContain('Docs name the format');
    for (const box of nodes(group()).filter((n) => n.type === 'input')) {
      box.props.onChange();
      out = host.render();
    }
    buttonNamed(out, zh('board.accept.submit')).props.onClick();
    expect(run).toHaveBeenCalledWith(
      'milestone.accept',
      { milestone_id: 'ms-1', evidence_refs: ['session:s-1'], criteria_checked: [0, 1] },
      3,
    );
  });

  it('offers a lead milestone the tasks the lead accepted as evidence', () => {
    const run = vi.fn(async (..._args: unknown[]) => null);
    const task = (id: string, title: string, sessionId: string) => ({
      id: `lead-1:${id}`,
      owner_session_id: 'lead-1',
      title,
      milestone_id: 'ms-l',
      status: 'done',
      segments: [{ id: sessionId, session_id: sessionId, status: 'done', title }],
    });
    const lead: BoardMilestone = {
      id: 'ms-l',
      title: 'research done',
      session_ids: ['s-report', 's-build'],
      merged: 1,
      status: 'ready_for_acceptance',
      criteria: [],
      owner_session_id: 'lead-1',
      tasks: { done: 2, total: 2 },
    };
    const leadStored = {
      id: 'ms-l',
      revision: 5,
      project_id: 'project-a',
      title: 'research done',
      required_sessions: [],
      criteria: [],
      created_at: NOW,
      updated_by: 'lead-1',
      owner_session_id: 'lead-1',
      key: 'research',
    } as unknown as SnapshotMilestone;
    const board = {
      now: NOW,
      merges: [{ session_id: 's-build', title: 'Build the parser' }],
      milestones: [lead],
      tasks: [
        task('report', 'Write the report', 's-report'),
        task('build', 'Build the parser', 's-build'),
      ],
    } as unknown as BoardModel;
    const actions = { projectId: 'project-a', milestones: [leadStored], sessions: [], run };
    const host = new HookHost(() => Milestones({ model: board, actions }));
    let tree = host.render();
    labelled(tree, acceptLabel('research done')).props.onClick();
    tree = host.render();
    const dialog = named(tree, 'AcceptDialog');
    const inner = inside(() => dialog);
    const out = inner.render();
    const picks = text(groupNamed(out, zh('board.accept.evidence')));
    expect(picks).toContain('Write the report');
    expect(picks).toContain('Build the parser');
    const submit = buttonNamed(out, zh('board.accept.submit'));
    expect(submit.props.disabled).toBe(false);
    submit.props.onClick();
    expect(run).toHaveBeenCalledWith(
      'milestone.accept',
      {
        milestone_id: 'ms-l',
        evidence_refs: ['session:s-build', 'task:report'],
        criteria_checked: [],
      },
      5,
    );
  });

  it('opens a fresh dialog for each milestone instead of reusing the last one', () => {
    const second = { ...milestone('active', [false, false]), id: 'ms-2', title: 'second release' };
    const board = {
      now: NOW,
      merges: [],
      milestones: [milestone('active', [false, false]), second],
    } as unknown as BoardModel;
    const actions = {
      projectId: 'project-a',
      milestones: [stored, { ...stored, id: 'ms-2', title: 'second release' } as SnapshotMilestone],
      sessions: [],
      run: async () => null,
    };
    const host = new HookHost(() => Milestones({ model: board, actions }));
    let tree = host.render();
    labelled(tree, reviseLabel('first release')).props.onClick();
    tree = host.render();
    const first = named(tree, 'MilestoneDialog');
    // Closing starts the exit transition; the second opens before it ends.
    find(tree, (n) => 'onOpenChangeComplete' in (n.props ?? {})).props.onOpenChange(false);
    labelled(tree, reviseLabel('second release')).props.onClick();
    tree = host.render();
    const next = named(tree, 'MilestoneDialog');
    expect(next.props.stored.id).toBe('ms-2');
    expect(next.key).not.toBeNull();
    expect(next.key).not.toBe(first.key);
  });

  it('retries an acceptance refused while open at the revision the snapshot moved to', async () => {
    const run = vi.fn(async (..._args: unknown[]) => 'revision_conflict' as string | null);
    const ready = model(milestone('ready_for_acceptance', [false, false]));
    let rows = [stored];
    const board = new HookHost(() =>
      Milestones({
        model: ready,
        actions: { projectId: 'project-a', milestones: rows, sessions: [], run },
      }),
    );
    labelled(board.render(), acceptLabel('first release')).props.onClick();
    let dialog = named(board.render(), 'AcceptDialog');
    const host = inside(() => dialog);
    let out = host.render();
    const group = () => groupNamed(out, zh('board.milestones.criteria'));
    for (const box of nodes(group()).filter((n) => n.type === 'input')) {
      box.props.onChange();
      out = host.render();
    }
    const submit = () => buttonNamed(out, zh('board.accept.submit')).props.onClick();
    submit();
    out = await host.flush();
    expect(run).toHaveBeenLastCalledWith('milestone.accept', expect.anything(), 2);

    rows = [{ ...stored, revision: 4 } as SnapshotMilestone];
    dialog = named(board.render(), 'AcceptDialog');
    out = host.render();
    run.mockResolvedValue(null);
    submit();
    expect(run).toHaveBeenLastCalledWith('milestone.accept', expect.anything(), 4);
  });

  it('retries a revision refused while open at the revision the snapshot moved to, keeping the draft', async () => {
    const run = vi.fn(async (..._args: unknown[]) => 'revision_conflict' as string | null);
    const shown = model(milestone('active', [false, false]));
    let rows = [stored];
    const board = new HookHost(() =>
      Milestones({
        model: shown,
        actions: { projectId: 'project-a', milestones: rows, sessions: [], run },
      }),
    );
    labelled(board.render(), reviseLabel('first release')).props.onClick();
    let dialog = named(board.render(), 'MilestoneDialog');
    const host = inside(() => dialog);
    let out = host.render();
    find(out, (n) => n.props.id === 'bp-ms-title').props.onChange({
      target: { value: 'first public release' },
    });
    out = host.render();
    const submit = () => buttonNamed(out, zh('board.milestoneForm.save')).props.onClick();
    submit();
    out = await host.flush();
    expect(run).toHaveBeenLastCalledWith('milestone.revise', expect.anything(), 2);

    rows = [{ ...stored, revision: 4 } as SnapshotMilestone];
    dialog = named(board.render(), 'MilestoneDialog');
    out = host.render();
    submit();
    expect(run).toHaveBeenLastCalledWith(
      'milestone.revise',
      expect.objectContaining({ title: 'first public release' }),
      4,
    );
  });

  it('marks each criterion on the card pending or accepted', () => {
    const accepted = model(milestone('completed', [true, false]));
    const tree = new HookHost(() => Milestones({ model: accepted })).render();
    const list = labelled(tree, say('board.milestones.criteriaOf', { milestone: 'first release' }));
    const html = renderToStaticMarkup(list);
    const mark = (criterion: string) =>
      html
        .match(
          new RegExp(
            `<i class="mk ([a-z]+)"[^>]*aria-label="([^"]+)"[^>]*></i><span>${criterion}</span>`,
          ),
        )
        ?.slice(1);
    expect(mark('Exports download')).toEqual(['acc', zh('board.milestones.accepted')]);
    expect(mark('Docs name the format')).toEqual(['pend', zh('board.milestones.awaiting')]);
    const css = readFileSync(
      new URL('../../apps/web/src/screens/board/charts.css', import.meta.url),
      'utf8',
    );
    expect(css).toMatch(/\.bp-crit \.mk\.pend \{[^}]*var\(--ready\)/);
    expect(css).toMatch(/\.bp-crit \.mk\.acc \{[^}]*var\(--ok\)/);
  });
});

describe('current milestone card', () => {
  const noop = () => {};
  const planTask = (id: string, state: BoardTaskState, milestone_id: string | null = 'ms-cur') =>
    ({
      id: `lead-1:${id}`,
      owner_session_id: 'lead-1',
      title: id,
      milestone_id,
      status: state === 'merged' ? 'done' : 'running',
      state,
      blockers: [],
      segments: [],
    }) as unknown as BoardModel['tasks'][number];
  const current = (status: BoardMilestone['status']): BoardMilestone => ({
    id: 'ms-cur',
    title: 'importer ready',
    session_ids: [],
    merged: 0,
    status,
    criteria: [
      { text: 'Imports a CSV', accepted: false },
      { text: 'Reports bad rows', accepted: false },
    ],
    owner_session_id: 'lead-1',
    tasks: { done: 1, total: 3 },
  });
  const finished: BoardMilestone = {
    ...current('completed'),
    id: 'ms-done',
    title: 'parser ready',
  };
  const later: BoardMilestone = { ...current('active'), id: 'ms-next', title: 'exporter ready' };
  const tasks = [
    planTask('parse rows', 'merged'),
    planTask('map columns', 'running'),
    planTask('write rows', 'blocked'),
    planTask('export rows', 'todo', 'ms-next'),
  ];
  const firstScreen = (milestones: BoardMilestone[]) =>
    ({
      now: NOW,
      headline: null,
      counts: { running: 1, waiting: 0, ready: 0, failed: 0, merged: 0, tokens: 0 },
      tasks,
      edges: [],
      milestones,
      burnup: [],
      task_progress: {
        totals: {
          done: 1,
          running: 1,
          waiting: 0,
          idle: 0,
          ready: 0,
          failed: 1,
          discarded: 0,
          not_started: 1,
        },
      },
      merges: [],
      findings: [],
      risks: [],
    }) as unknown as BoardModel;
  const view = (milestones: BoardMilestone[]) =>
    new HookHost(() =>
      BoardView({
        model: firstScreen(milestones),
        loading: false,
        error: null,
        onRetry: noop,
        range: 7,
        onRange: noop,
        page: 'now',
        onPage: noop,
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
      }),
    ).render();
  const cardStored = {
    ...stored,
    id: 'ms-cur',
    title: 'importer ready',
    criteria: ['Imports a CSV', 'Reports bad rows'],
  } as SnapshotMilestone;

  it('puts the first unfinished milestone on the first screen with its criteria', () => {
    const card = named(view([finished, current('active'), later]), 'MilestoneCard');
    const out = new HookHost(() => MilestoneCard(card.props)).render();
    expect(text(find(out, (n) => n.type === 'h2'))).toBe('importer ready');
    const criteria = labelled(out, zh('board.plan.milestone.criteria'));
    expect(
      nodes(criteria)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual(['Imports a CSV', 'Reports bad rows']);
    expect(find(out, (n) => n.props.role === 'img').props['aria-label']).toBe(
      say('board.plan.milestone.merged', { done: 1, total: 3 }),
    );
  });

  it('keeps each criterion whole behind a two-line clip', () => {
    const out = new HookHost(() =>
      MilestoneCard({
        model: firstScreen([current('active')]),
        milestone: current('active'),
        onOpenTask: noop,
      }),
    ).render();
    const items = nodes(labelled(out, zh('board.plan.milestone.criteria'))).filter(
      (n) => n.type === 'li',
    );
    expect(items.map((li) => find(li, (n) => n.type === Clip).props)).toEqual([
      { text: 'Imports a CSV', lines: 2 },
      { text: 'Reports bad rows', lines: 2 },
    ]);
  });

  it('draws a cell for each task of the milestone in its state, each opening the task', () => {
    const onOpenTask = vi.fn();
    const model = firstScreen([current('active')]);
    const out = new HookHost(() =>
      MilestoneCard({ model, milestone: current('active'), onOpenTask }),
    ).render();
    const cells = nodes(out).filter((n) => n.type === 'button' && 'data-state' in n.props);
    expect(cells.map((c) => c.props['data-state'])).toEqual(['merged', 'running', 'blocked']);
    cells[1]!.props.onClick();
    expect(onOpenTask).toHaveBeenCalledWith('lead-1:map columns');
  });

  it('keeps the acceptance off until the milestone is ready, then opens the acceptance dialog', () => {
    const run = vi.fn(async (..._args: unknown[]) => null);
    const actions = { projectId: 'project-a', milestones: [cardStored], sessions: [], run };
    const accept = (tree: unknown) =>
      find(
        tree as ReactElement,
        (n) =>
          n.type === 'button' &&
          n.props['aria-label'] ===
            say('board.plan.milestone.acceptLabel', { title: 'importer ready' }),
      );
    const card = (status: BoardMilestone['status']) =>
      new HookHost(() =>
        MilestoneCard({
          model: firstScreen([current(status)]),
          milestone: current(status),
          actions,
          onOpenTask: noop,
        }),
      );
    expect(accept(card('active').render()).props.disabled).toBe(true);

    const ready = card('ready_for_acceptance');
    expect(accept(ready.render()).props.disabled).toBe(false);
    accept(ready.render()).props.onClick();
    const dialog = named(ready.render(), 'AcceptDialog');
    expect(dialog.props.stored).toBe(cardStored);
    expect(dialog.props.run).toBe(run);
  });

  it('leaves the card out without an unfinished milestone', () => {
    for (const milestones of [[], [finished]]) {
      const tree = view(milestones);
      expect(nodes(tree).some((n) => n.type === MilestoneCard)).toBe(false);
      expect(nodes(tree).some((n) => n.type === TaskProgressStrip)).toBe(true);
    }
  });

  it.each([
    ['2026-11-04', say('board.plan.milestone.daysLeft', { count: 3 }), false],
    ['2026-11-01', zh('board.plan.milestone.dueToday'), false],
    ['2026-10-30', say('board.plan.milestone.overdue', { count: 2 }), true],
  ])('shows the days to a due day of %s on the line', (due_on, words, late) => {
    const milestone = { ...current('active'), due_on };
    const out = new HookHost(() =>
      MilestoneCard({ model: firstScreen([milestone]), milestone, onOpenTask: noop }),
    ).render();
    const due = find(out, (n) => n.props.className === 'bms-due');
    expect(text(due)).toBe(words);
    expect(!!due.props['data-late']).toBe(late);
  });

  it('sends a picked due day as an edit of the lead plan, and a cleared one as none', async () => {
    const run = vi.fn(async (..._args: unknown[]) => null);
    const milestones = [{ ...cardStored, owner_session_id: 'lead-1', key: 'importer' }];
    const milestone = current('active');
    const model = {
      ...firstScreen([milestone]),
      leads: [{ session_id: 'lead-1', plan_version: 4 }],
    } as unknown as BoardModel;
    const host = new HookHost(() =>
      MilestoneCard({
        model,
        milestone,
        actions: { projectId: 'project-a', milestones, sessions: [], run },
        onOpenTask: noop,
      }),
    );
    const input = () =>
      find(
        host.render(),
        (n) => n.type === 'input' && n.props['aria-label'] === zh('board.plan.milestone.dueOn'),
      );
    input().props.onChange({ target: { value: '2026-11-20' } });
    await host.flush();
    input().props.onChange({ target: { value: '' } });
    await host.flush();
    const edit = (due_on: string | null) => [
      'board.plan.edit',
      {
        project_id: 'project-a',
        lead_session_id: 'lead-1',
        base_version: 4,
        ops: [{ type: 'set_milestone', milestone_id: 'importer', patch: { due_on } }],
      },
      null,
    ];
    expect(run.mock.calls).toEqual([edit('2026-11-20'), edit(null)]);
  });
});

describe('chart tooltip', () => {
  it('closes on Escape', () => {
    const keys = new Map<string, (e: { key: string }) => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: { key: string }) => void) => keys.set(type, fn),
      removeEventListener: (type: string) => keys.delete(type),
    });
    const host = new HookHost(() => useFloatTip());
    host.render().show({ clientX: 4, clientY: 4 }, { rows: [{ label: 'tokens', value: '12' }] });
    expect(host.render().node).not.toBeNull();
    keys.get('keydown')!({ key: 'Escape' });
    expect(host.render().node).toBeNull();
    expect(keys.has('keydown')).toBe(false);
    vi.unstubAllGlobals();
  });
});
