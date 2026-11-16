import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { nodes, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/commands', () => ({ runCommand: mock.runCommand }));
import { Collapsible } from '../../apps/web/node_modules/@base-ui/react/collapsible/index.mjs';
import { Markdown } from '@/components/Markdown';
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type RequestItem, type SessionTurn } from '@/data/transcript';
import type { PendingPermission } from '@/screens/sessions/model';
import { Items } from '@/screens/sessions/parts';
import { PlanCard, RequestSlot } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const turn: SessionTurn = {
  id: 'turn-1',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-main',
  input: 'Plan the change',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
};
const event = (sequence: number, kind: string, payload: unknown): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'session-main',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload,
});

afterEach(() => {
  unmountAll();
  mock.runCommand.mockReset();
});
const named = (tree: unknown, name: string) =>
  nodes(tree as any).filter((n) => typeof n.type === 'function' && n.type.name === name);
const text = (node: ReactElement<any>): string =>
  nodes(node.props.children)
    .map((n) => (typeof n.props.children === 'string' ? n.props.children : ''))
    .join('') || (typeof node.props.children === 'string' ? node.props.children : '');
const button = (tree: unknown, label: string) =>
  nodes(tree as any).find((n) => n.type === 'button' && text(n) === label)!;

describe('reasoning in the transcript', () => {
  it('places reasoning events as their own items between the text and keeps the summary flag', () => {
    const view = buildTranscript(
      [turn],
      [
        event(1, 'agent.reasoning', { turn_id: 'turn-1', text: 'Read the config first.' }),
        event(2, 'agent.message.delta', { turn_id: 'turn-1', text: 'Looking.' }),
        event(3, 'agent.reasoning', { turn_id: 'turn-1', text: '**Plan**', summary: true }),
        event(4, 'agent.reasoning', { turn_id: 'turn-1', text: '' }),
        event(5, 'agent.message.delta', { turn_id: 'turn-1', text: 'Done.' }),
      ],
    ).turns[0]!;
    expect(view.items).toEqual([
      { kind: 'reasoning', text: 'Read the config first.', summary: false },
      { kind: 'text', text: 'Looking.' },
      { kind: 'reasoning', text: '**Plan**', summary: true },
      { kind: 'text', text: 'Done.' },
    ]);
    expect(view.text).toBe('Looking.Done.');
  });

  it('folds a reasoning block to its first line and opens it in the expanded transcript', () => {
    const item = {
      kind: 'reasoning' as const,
      text: '**Check the tests**\n\nThen the adapter.',
      summary: true,
    };
    const blocks = (verbose: boolean) =>
      named(
        mount(() => Items({ items: [item], verbose, ended: true, folders: [], sessionId: 's' }))
          .value,
        'Reasoning',
      );
    expect(blocks(false).map((n) => n.props.open)).toEqual([false]);
    expect(blocks(true).map((n) => n.props.open)).toEqual([true]);
    const block = blocks(false)[0]!;
    const tree = mount(() => (block.type as (p: unknown) => unknown)(block.props)).value;
    const root = nodes(tree as any).find((n) => n.type === Collapsible.Root)!;
    expect(root.props.open).toBe(false);
    expect(
      nodes(tree as any).find((n) => n.type === Collapsible.Trigger)!.props['aria-label'],
    ).toBe('思考摘要：Check the tests');
    expect(nodes(tree as any).find((n) => n.type === Markdown)!.props.text).toBe(item.text);
  });
});

describe('plan card', () => {
  const needs = { items: [], loading: false, error: null, reload: () => {} };
  const permission: PendingPermission = {
    id: 'approval-plan',
    tool: 'ExitPlanMode',
    revision: 3,
    request: 'request-plan',
  };
  const plan = '# Steps\n\n1. Edit the adapter';

  it('shows an ExitPlanMode request in its thread place as the plan card', () => {
    const item: RequestItem = {
      kind: 'request',
      id: 'request-plan',
      tool: 'ExitPlanMode',
      input: { plan },
      questions: [],
    };
    const slot = mount(() =>
      RequestSlot({ item, permission, needs, folders: [], enter: '' }),
    ).value;
    const card = nodes(slot as any).find((n) => n.props?.permission?.id === permission.id)!;
    const shown = (card.type as (p: unknown) => ReactElement<any>)(card.props);
    expect(shown.type).toBe(PlanCard);
    expect(shown.props.input).toEqual({ plan });
  });

  it('renders the plan as Markdown and approves it through the approval answer', async () => {
    mock.runCommand.mockResolvedValue({ ok: true, value: {} });
    const h = mount(() => PlanCard({ permission, needs, input: { plan } }));
    expect(nodes(h.value as any).find((n) => n.type === Markdown)!.props.text).toBe(plan);
    button(h.value, zh('sessions.card.approvePlan')).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'approval.respond',
      { approval_id: 'approval-plan', decision: 'approve' },
      3,
    );
  });

  it('sends the plan back with the note through the denial reason to keep planning', async () => {
    mock.runCommand.mockResolvedValue({ ok: true, value: {} });
    const h = mount(() => PlanCard({ permission, needs, input: { plan } }));
    expect(nodes(h.value as any).some((n) => n.type === 'input')).toBe(false);
    button(h.value, zh('sessions.card.keepPlanning')).props.onClick();
    h.render();
    const input = nodes(h.value as any).find((n) => n.type === 'input')!;
    expect(input.props['aria-label']).toBe(zh('sessions.card.planFeedback'));
    input.props.onChange({ target: { value: '  Split the second step  ' } });
    h.render();
    button(h.value, zh('sessions.composer.send')).props.onClick();
    await h.flush();
    expect(mock.runCommand).toHaveBeenCalledWith(
      'approval.respond',
      { approval_id: 'approval-plan', decision: 'reject', reason: 'Split the second step' },
      3,
    );
  });

  it('keeps approval off while the card has no plan to show', () => {
    const h = mount(() => PlanCard({ permission, needs }));
    expect(button(h.value, zh('sessions.card.approvePlan')).props['aria-disabled']).toBe(true);
    button(h.value, zh('sessions.card.approvePlan')).props.onClick();
    expect(mock.runCommand).not.toHaveBeenCalled();
  });
});
