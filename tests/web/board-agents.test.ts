import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { LeadPanel } from '@/screens/board/LeadPanel';
import type { BoardLead } from '@/screens/board/frame-model';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { find, nodes, text } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 18, 12);

const task = (id: string, owner: string, state: Task['state'], status: Task['status']): Task =>
  ({
    id,
    owner_session_id: owner,
    title: `task ${id}`,
    goal: '',
    lane_id: null,
    milestone_id: null,
    status,
    state,
    segments: [],
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
  }) as unknown as Task;

const lead: BoardLead = {
  session_id: 'lead-1',
  title: 'Refunds plan',
  state: 'running',
  inbox: 0,
  updated_at: NOW,
  context: { used_tokens: 62_000, window_tokens: 100_000 },
};

const model = (tasks: Task[]): BoardModel =>
  ({ now: NOW, tasks, leads: [lead], needs: [] }) as unknown as BoardModel;

const panel = (tasks: Task[], sessions: SnapshotSession[] = [], onOpenTask = vi.fn()) =>
  LeadPanel({
    model: model(tasks),
    sessions,
    projectId: 'project-a',
    onOpenSession: vi.fn(),
    onOpenTask,
  });

/** Draws the hookless parts of the panel a level down. */
const drawn = (el: ReactElement<any>) =>
  (el.type as (props: unknown) => ReactElement<any>)(el.props);
const rows = (tree: ReactElement) => nodes(tree).filter((n) => n.props.className === 'bld-i');
const workers = (row: ReactElement) =>
  drawn(find(row, (n) => typeof n.type === 'function' && n.type.name === 'Workers'));
const state = (id: string) => zh(`board.task.state.${id}`);

describe('agents', () => {
  it("draws a tile per task in a lead's hands, the group naming each state's count, merged ones left out", () => {
    const onOpenTask = vi.fn();
    const tree = panel(
      [
        task('run', 'lead-1', 'running', 'running'),
        task('gate', 'lead-1', 'failed', 'failed'),
        task('review', 'lead-1', 'awaiting_merge', 'ready'),
        task('merged', 'lead-1', 'merged', 'done'),
        task('other', 'lead-2', 'running', 'running'),
      ],
      [],
      onOpenTask,
    );
    const group = find(workers(rows(tree)[0]!), (n) => n.props.role === 'group');
    expect(group.props['aria-label']).toBe(
      zhf('board.lead.workers', {
        count: 3,
        parts: [
          zhf('board.overview.statePart', { state: state('running'), count: 1 }),
          zhf('board.overview.statePart', { state: state('failed'), count: 1 }),
          zhf('board.overview.statePart', { state: state('awaitingMerge'), count: 1 }),
        ].join('，'),
      }),
    );
    const tiles = nodes(group).filter((n) => n.type === 'button');
    expect(tiles.map((n) => n.props['aria-label'])).toEqual([
      zhf('board.task.link.label', { title: 'task run', status: state('running') }),
      zhf('board.task.link.label', { title: 'task gate', status: state('failed') }),
      zhf('board.task.link.label', { title: 'task review', status: state('awaitingMerge') }),
    ]);
    tiles[1]!.props.onClick();
    expect(onOpenTask).toHaveBeenCalledWith('gate');
    expect(text(workers(rows(tree)[0]!))).toContain('3');
  });

  it("names the share of the lead's context its ring draws", () => {
    const row = rows(panel([]))[0]!;
    const context = drawn(
      find(row, (n) => typeof n.type === 'function' && n.type.name === 'AgentContext'),
    );
    const ring = drawn(
      find(context, (n) => typeof n.type === 'function' && n.type.name === 'ContextRing'),
    );
    expect(ring.props.role).toBe('img');
    expect(ring.props['aria-label']).toBe(zhf('board.plan.flow.context', { percent: 62 }));
    expect(text(context)).toBe('62%');
  });

  it("gives the project's open resident a line of its own after the leads, opening its session", () => {
    const resident = {
      id: 'triage-1',
      project_id: 'project-a',
      runtime: 'codex',
      title: 'Triage',
      state: 'open',
      resident: { kind: 'triage', agent_id: 'agent-triage' },
    } as unknown as SnapshotSession;
    const handedOver = { ...resident, id: 'triage-0', rotation: { flush_turn_id: 't', at: NOW } };
    const elsewhere = { ...resident, id: 'triage-x', project_id: 'project-b' };
    const tree = panel([task('signal', 'triage-1', 'running', 'running')], [
      handedOver,
      elsewhere,
      resident,
    ] as SnapshotSession[]);
    const lines = rows(tree);
    expect(lines).toHaveLength(2);
    const open = find(lines[1]!, (n) => n.props.className === 'bld-t');
    expect(text(open)).toBe('Triage');
    expect(open.props['aria-label']).toBe(
      zhf('board.frame.lead.label', { name: 'Triage', state: zh('board.leadStates.idle') }),
    );
    expect(find(workers(lines[1]!), (n) => n.props.role === 'group').props['aria-label']).toBe(
      zhf('board.lead.workers', {
        count: 1,
        parts: zhf('board.overview.statePart', { state: state('running'), count: 1 }),
      }),
    );
  });
});
