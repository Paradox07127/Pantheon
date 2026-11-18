import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AgentProfile, SessionTurn } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import {
  type HookHost,
  deferred,
  find,
  mount,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '../../apps/web/src/data/board.js';
import { runCommand } from '../../apps/web/src/data/commands.js';
import { useDrafts } from '../../apps/web/src/data/drafts.js';
import { failureText } from '../../apps/web/src/data/needs-you.js';
import { ASSISTANT, chooseRequestTarget } from '../../apps/web/src/data/request-target.js';
import type { Routing } from '../../apps/web/src/data/routing-receipt.js';
import { buildTranscript } from '../../apps/web/src/data/transcript.js';
import {
  PublishBar,
  RoutingLine,
  type PublishCommand,
} from '../../apps/web/src/screens/board/PublishBar.js';
import type { SnapshotSession } from '../../apps/web/src/screens/board/panels-model.js';
import { ThreadTurn } from '../../apps/web/src/screens/sessions/Thread.js';

const ok = (value: unknown) => ({ ok: true as const, value });
const refused = { ok: false as const, error: { code: 'invalid_state', message: 'refused' } };

const agent = (id: string, template: AgentProfile['template'], name: string): AgentProfile =>
  ({
    id,
    revision: 1,
    project_id: 'project-a',
    template,
    name,
    role: 'AG',
    created_at: 1,
  }) as AgentProfile;
const AGENTS = [
  agent('agent-assistant', 'assistant', 'Assistant'),
  agent('agent-triage', 'triage', 'Triage'),
  agent('agent-ledger', 'custom', 'Ledger keeper'),
];

const boardTask = (id: string, title: string) =>
  ({ id, title, lane_id: null }) as unknown as BoardModel['tasks'][number];
// The Assistant's plan is the one of its session assistant-1; lead-x is another lead's.
const VIEW = {
  lanes: [
    { id: 'assistant-1:lane-a', title: 'Refunds v2 rollout' },
    { id: 'assistant-1:lane-b', title: 'Invoices on the new ledger' },
    { id: 'lead-x:lane-c', title: 'Someone else' },
  ],
  tasks: [
    boardTask('assistant-1:task-1', 'Reconciliation CSV export'),
    boardTask('assistant-1:task-2', 'Refund audit log'),
  ],
} as unknown as BoardModel;

const resident = {
  id: 'assistant-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
  resident: { kind: 'assistant', agent_id: 'agent-assistant' },
} as unknown as SnapshotSession;

const turn = (routing?: SessionTurn['routing']): SessionTurn => ({
  id: 'turn-sent',
  revision: 2,
  project_id: 'project-a',
  session_id: 'assistant-1',
  input: 'Add CSV export to the reconciliation report',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...(routing ? { routing } : {}),
});

const daemon = (turns: SessionTurn[]) =>
  useBoard.setState({
    board: {
      cursor: 5,
      projects: [],
      sessions: [resident as never],
      session_turns: turns,
      workspaces: [],
    },
    events: [],
    cursor: 5,
  });

beforeEach(() => {
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      query: async (method: string) =>
        ok(method === 'agent.list' ? AGENTS : method === 'board.view' ? VIEW : []),
    },
  });
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  });
  chooseRequestTarget('project-a', ASSISTANT);
  useDrafts.setState({ drafts: {}, answers: {} });
  daemon([]);
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

/** The routing line of a turn, with its names read. */
const line = async (routing: Routing, run: PublishCommand = async () => ok({})) => {
  const h = mount(() => RoutingLine({ turn: { ...turn(), routing }, run }));
  await h.flush();
  h.render();
  return h;
};
const group = (h: HookHost<any>) => find(h.value, (n) => n.props.role === 'group');
const menu = (h: HookHost<any>) => named(h.value, 'Menu');
const entries = (h: HookHost<any>) =>
  nodes(menu(h).props.children).filter(
    (n) =>
      typeof n.type === 'function' && (n.type.name === 'MenuItem' || n.type.name === 'SubMenu'),
  );
const entryText = (n: { type: any; props: any }) =>
  n.type.name === 'SubMenu' ? n.props.label : text(n.props.children);
const pick = (h: HookHost<any>, name: string) =>
  entries(h)
    .find(
      (n) => (n.type as { name?: string }).name === 'MenuItem' && text(n.props.children) === name,
    )!
    .props.onClick();
const alert = (h: HookHost<any>) => nodes(h.value).find((n) => n.props.role === 'alert');

describe('routing receipt', () => {
  it.each<[string, Routing, string]>([
    ['answered', { kind: 'answered' }, '已在这里回答'],
    [
      'new_plan',
      { kind: 'new_plan', lane_id: 'lane-b', task_ids: ['task-2'] },
      '新计划 Invoices on the new ledger',
    ],
    [
      'added',
      { kind: 'added', lane_id: 'lane-a', task_ids: ['task-1', 'task-2'] },
      '已加入 Refunds v2 rollout，任务 Reconciliation CSV export, Refund audit log',
    ],
    [
      'new_plan on a lane the board view does not have yet',
      {
        kind: 'new_plan',
        lane_id: 'lane-new',
        task_ids: ['task-new'],
        lane_title: 'Payout reports',
        task_titles: ['Payout CSV'],
      },
      '新计划 Payout reports',
    ],
    [
      'added with tasks the board view does not have yet',
      {
        kind: 'added',
        lane_id: 'lane-new',
        task_ids: ['task-new', 'task-next'],
        lane_title: 'Payout reports',
        task_titles: ['Payout CSV', 'Payout audit'],
      },
      '已加入 Payout reports，任务 Payout CSV, Payout audit',
    ],
    [
      'added to a lane and task renamed since the receipt',
      {
        kind: 'added',
        lane_id: 'lane-a',
        task_ids: ['task-1'],
        lane_title: 'Refunds rollout',
        task_titles: ['CSV export'],
      },
      '已加入 Refunds v2 rollout，任务 Reconciliation CSV export',
    ],
    ['sent', { kind: 'sent', agent_id: 'agent-ledger' }, '已转给 Ledger keeper'],
    ['asked', { kind: 'asked' }, '已询问你'],
  ])('says what the resident did with a request it %s', async (_kind, routing, said) => {
    const h = await line(routing);
    expect(text(find(group(h), (n) => n.type === 'span'))).toBe(said);
    expect(group(h).props['aria-label']).toBe(`已分流：${said}`);
  });

  it('offers every other route, and sends a picked lane for the turn', async () => {
    const run = vi.fn<PublishCommand>(async (type) =>
      type === 'request.reroute'
        ? ok({ session_id: 'assistant-1', turn_id: 'turn-rerouted' })
        : ok({ session_id: 'assistant-1', turn_id: 'turn-sent' }),
    );
    const bar = mount(() =>
      PublishBar({
        projectId: 'project-a',
        leads: undefined,
        sessions: [resident],
        tasks: [],
        defaults: undefined,
        run,
      }),
    );
    find(bar.value, (n) => n.type === 'textarea').props.onChange({
      target: { value: 'Add CSV export to the reconciliation report' },
    });
    bar.render();
    find(bar.value, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await bar.flush();
    daemon([turn({ kind: 'added', lane_id: 'lane-a', task_ids: ['task-1'] })]);
    bar.render();
    const card = named(bar.value, 'ReceiptCard');
    const routed = named((card.type as (props: unknown) => ReactNode)(card.props), 'RoutingLine');
    const h = mount(() => RoutingLine(routed.props));
    await h.flush();
    h.render();

    expect(menu(h).props.label).toBe('换个分流');
    expect(text(menu(h).props.trigger)).toBe('换个分流');
    expect(entries(h).map(entryText)).toEqual([
      '在这里回答',
      '新计划',
      '加入计划',
      'Invoices on the new ledger',
      `转给 ${zh('sessions.agents.template.triage')}`,
      '转给 Ledger keeper',
    ]);
    pick(h, 'Invoices on the new ledger');
    await h.flush();
    expect(run.mock.calls.at(-1)).toEqual([
      'request.reroute',
      { turn_id: 'turn-sent', to: { lane_id: 'lane-b' } },
      null,
    ]);
  });

  it('shows why a reroute failed at the receipt, with the menu off while it is out', async () => {
    const reply = deferred<typeof refused>();
    const h = await line({ kind: 'answered' }, () => reply.promise);
    pick(h, '新计划');
    h.render();
    expect(menu(h).props.trigger.props.disabled).toBe(true);
    reply.resolve(refused);
    await h.flush();
    expect(menu(h).props.trigger.props.disabled).toBe(false);
    expect(text(alert(h))).toBe(failureText(refused.error));
  });

  it('draws the line under the user turn a resident routed', () => {
    const draw = (routing?: SessionTurn['routing']) =>
      mount(() =>
        ThreadTurn({
          view: buildTranscript([turn(routing)], []).turns[0]!,
          folders: [],
          status: { kind: 'ended', tool: null, since: null },
          fresh: new Set(),
          request: () => null,
          listed: null,
        }),
      );
    const routed = named(draw({ kind: 'answered' }).value, 'RoutingLine');
    expect(routed.props.turn.id).toBe('turn-sent');
    expect(routed.props.run).toBe(runCommand);
    expect(() => named(draw().value, 'RoutingLine')).toThrow();
  });
});
