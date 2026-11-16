import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { Milestones } from '@/screens/board/Charts';
import { TellLead } from '@/screens/board/TellLead';
import {
  watchAcceptance,
  type BoardMilestone,
  type SnapshotMilestone,
  type SnapshotSession,
} from '@/screens/board/panels-model';

const NOW = Date.UTC(2026, 10, 1, 12);
const run = async () => null;

const milestone = (id: string, status: BoardMilestone['status']): BoardMilestone => ({
  id,
  title: `milestone ${id}`,
  session_ids: ['s-1'],
  merged: 1,
  status,
  criteria: [],
});

describe('the acceptance check plays only for an acceptance seen happening', () => {
  it('records the first look without playing, even for accepted milestones', () => {
    const first = watchAcceptance(null, [milestone('a', 'completed'), milestone('b', 'active')]);
    expect([...first.accepted]).toEqual([]);
    expect([...first.unaccepted]).toEqual(['b']);
  });

  it('plays for a milestone seen unaccepted that is accepted now, and keeps it', () => {
    const first = watchAcceptance(null, [milestone('a', 'ready_for_acceptance')]);
    const second = watchAcceptance(first, [milestone('a', 'completed')]);
    expect([...second.accepted]).toEqual(['a']);
    expect([...second.unaccepted]).toEqual([]);
    const third = watchAcceptance(second, [milestone('a', 'completed')]);
    expect([...third.accepted]).toEqual(['a']);
  });

  it('does not play for a milestone that shows up already accepted', () => {
    const first = watchAcceptance(null, [milestone('a', 'active')]);
    const second = watchAcceptance(first, [milestone('a', 'active'), milestone('b', 'completed')]);
    expect([...second.accepted]).toEqual([]);
    expect([...second.unaccepted]).toEqual(['a']);
  });
});

const isRoot = (n: ReactElement<any>) => 'onOpenChangeComplete' in (n.props ?? {});
const rootOf = (tree: unknown, content: string) =>
  find(
    tree as any,
    (n) => isRoot(n) && nodes(n.props.children).some((c) => (c.type as any)?.name === content),
  );
const holds = (tree: unknown, content: string) =>
  nodes(tree as any).some((n) => (n.type as any)?.name === content);

describe('board dialogs keep their content until the exit transition ends', () => {
  it('keeps the message dialog mounted while it closes, then releases it', () => {
    const lead: SnapshotSession = {
      id: 'lead-1',
      revision: 1,
      project_id: 'project-a',
      runtime: 'fixture',
      state: 'open',
      turn_count: 1,
    } as SnapshotSession;
    const h = new HookHost(() => TellLead({ lead, draft: 'hello', label: 'ship it', run }));
    let tree = h.render();
    expect(holds(tree, 'TellDialog')).toBe(false);
    find(
      tree,
      (n) => n.props['aria-label'] === `${zh('board.lead.tell.title')} ship it`,
    ).props.onClick();
    tree = h.render();
    const root = rootOf(tree, 'TellDialog');
    expect(root.props.open).toBe(true);

    root.props.onOpenChange(false);
    tree = h.render();
    expect(rootOf(tree, 'TellDialog').props.open).toBe(false);

    root.props.onOpenChangeComplete(false);
    tree = h.render();
    expect(holds(tree, 'TellDialog')).toBe(false);
  });

  it('keeps the accept dialog mounted while it closes, then releases it', () => {
    const stored = {
      id: 'ms-1',
      revision: 2,
      project_id: 'project-a',
      title: 'first release',
      required_sessions: ['s-1'],
      criteria: ['done'],
      created_at: NOW,
      updated_by: 'user',
    } as SnapshotMilestone;
    const model = {
      now: NOW,
      merges: [],
      milestones: [{ ...milestone('ms-1', 'ready_for_acceptance'), title: 'first release' }],
    } as unknown as BoardModel;
    const h = new HookHost(() =>
      Milestones({
        model,
        actions: { projectId: 'project-a', milestones: [stored], sessions: [], run },
      }),
    );
    let tree = h.render();
    find(
      tree,
      (n) => n.type === 'button' && text(n) === zh('board.milestones.accept'),
    ).props.onClick();
    tree = h.render();
    const root = rootOf(tree, 'AcceptDialog');
    expect(root.props.open).toBe(true);

    root.props.onOpenChange(false);
    tree = h.render();
    expect(rootOf(tree, 'AcceptDialog').props.open).toBe(false);

    root.props.onOpenChangeComplete(false);
    tree = h.render();
    expect(holds(tree, 'AcceptDialog')).toBe(false);
  });
});
