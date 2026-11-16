import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { LeadPanel } from '@/screens/board/LeadPanel';
import type { BoardLead } from '@/screens/board/frame-model';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { t } from '@/i18n';
import { find, named, nodes, text } from './web-hook-host.js';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 13, 12);
const dispatched = (count: number) =>
  t({ id: 'board.lead.dispatch.title', defaultMessage: '' }, { count });

const task = (id: string, planned?: Task['planned']): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    lane_id: null,
    milestone_id: null,
    status: 'todo',
    state: 'todo',
    last_progress_at: null,
    blocked_since: null,
    turn_running: false,
    ...(planned && { planned }),
  }) as Task;

const lead: BoardLead = {
  session_id: 'lead-1',
  title: 'Plan',
  state: 'running',
  inbox: 0,
  updated_at: NOW,
};
const sessions = [{ id: 'lead-1', runtime: 'claude' }] as SnapshotSession[];

const props = (tasks: Task[], onOpenTask = vi.fn()) => ({
  model: { tasks, needs: [], leads: [lead] } as unknown as BoardModel,
  sessions,
  onOpenSession: vi.fn(),
  onOpenTask,
});

const html = (tasks: Task[]) => renderToStaticMarkup(createElement(LeadPanel, props(tasks)));

const rowsOf = (tree: ReactElement) =>
  nodes(tree).filter((n) => n.type === 'button' && n.props.className === 'bld-dr');

describe('lead dispatch note', () => {
  const sent = [
    task('a', { device: 'ws', device_reason: 'needs a gpu' }),
    task('b', { device: 'pi5', device_reason: 'only arm64 box' }),
    task('c', { device: 'local' }),
    task('d'),
  ];

  it('lists the tasks the lead sent to other devices under a heading counting them', () => {
    const out = html(sent);
    expect(out).toContain(dispatched(2));
    const tree = LeadPanel(props(sent));
    const rows = rowsOf(tree);
    expect(rows).toHaveLength(2);
    expect(rows.map(text)).toEqual(['wstask aneeds a gpu', 'pi5task bonly arm64 box']);
    expect(out).toContain('<span class="chip mono">ws</span>');
    expect(out).toContain('<span class="chip mono">pi5</span>');
  });

  it('leaves the card out when no task goes to another device', () => {
    const out = html([task('c', { device: 'local' }), task('d')]);
    expect(out).not.toContain('bld-dn');
    expect(out).not.toContain(dispatched(0));
  });

  it('lists a task sent without a reason', () => {
    const rows = rowsOf(LeadPanel(props([task('a', { device: 'ws' })])));
    expect(rows).toHaveLength(1);
    expect(text(rows[0])).toBe('wstask a');
  });

  it('heads the tasks of each lead with that lead and its own count', () => {
    const other = { ...task('e', { device: 'pi5' }), id: 'lead-2:e', owner_session_id: 'lead-2' };
    const tree = LeadPanel({
      ...props([task('a', { device: 'ws' }), other]),
      sessions: [...sessions, { id: 'lead-2', runtime: 'codex' } as SnapshotSession],
    });
    const notes = nodes(tree).filter((n) => n.props.className === 'bld-dn');
    expect(
      notes.map((note) => [
        named(note, 'RuntimeGlyph').props.runtime,
        text(find(note, (n) => n.type === 'b')),
        rowsOf(note).map(text),
      ]),
    ).toEqual([
      ['claude', dispatched(1), ['wstask a']],
      ['codex', dispatched(1), ['pi5task e']],
    ]);
  });

  it("opens a row's task drawer", () => {
    const onOpenTask = vi.fn();
    const rows = rowsOf(LeadPanel(props(sent, onOpenTask)));
    rows[1]!.props.onClick();
    expect(onOpenTask).toHaveBeenCalledWith('lead-1:b');
  });
});
