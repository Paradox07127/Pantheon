import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
const runCommand = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<any> => ({ ok: true, value: {} })),
);
vi.mock('@/data/commands', () => ({ runCommand }));
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { clockText } from '@/lib/time-text';
import { PersonalNeedsList } from '@/screens/sessions/PersonalNeedsList';
import { ThreadTurn } from '@/screens/sessions/Thread';

const AT = new Date(2026, 10, 12, 10, 0).getTime();
const minute = (n: number) => AT + n * 60_000;

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-p',
  created_at: '2026-11-12T00:00:00.000Z',
  title: 'Personal agent',
  runtime: 'fixture',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: null,
  workspace_kind: 'in_place',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-12T00:00:00.000Z',
  changes: null,
  merge: null,
  resident: { kind: 'personal', agent_id: 'agent-p' },
  ...extra,
});
const turn = (extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id: 'turn-a',
  revision: 1,
  project_id: 'home',
  session_id: 'session-p',
  input: 'What needs me across all projects?',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});
let sequence = 0;
const event = (kind: string, at: number, payload: Record<string, unknown> = {}) =>
  ({
    sequence: ++sequence,
    event_id: `event-${sequence}`,
    kind,
    // The agent's events belong to the session and name their turn.
    aggregate_id: kind.startsWith('agent.') ? 'session-p' : 'turn-a',
    aggregate_revision: sequence,
    project_id: 'home',
    causation_id: 'cause',
    created_at: at,
    payload: { turn_id: 'turn-a', ...payload },
  }) as DaemonEvent;
const call = (id: string, name: string, input: unknown, output: unknown, at: number) => [
  event('agent.tool.started', at - 1000, { tool_call_id: id, name, input }),
  event('agent.tool.completed', at, { tool_call_id: id, ok: true, output }),
];
const need = (extra: Record<string, unknown>) => ({
  source: { table: 'approvals', id: `approval-${String(extra.title ?? Math.random())}` },
  kind: 'permission',
  status: 'pending',
  reason: 'permission_requested',
  actions: [],
  ...extra,
});
const NEEDS = [
  need({
    project_id: 'billing',
    kind: 'lead.question',
    source: { table: 'sessions', id: 'lead-b', revision: 1 },
    session_id: 'lead-b',
    request_id: 'q-1',
    decision: 'question',
    question: { question: 'Keep EU VAT on the invoice header?' },
    blocks: 1,
    created_at: minute(-50),
  }),
  need({
    project_id: 'payments',
    session_id: 'session-x',
    source: { table: 'approvals', id: 'approval-1', revision: 1 },
    decision: 'permission',
    blocks: 3,
    created_at: minute(-12),
  }),
  need({
    project_id: 'payments',
    session_id: 'session-y',
    source: { table: 'approvals', id: 'approval-2', revision: 1 },
    decision: 'permission',
    blocks: 2,
    created_at: minute(-26),
  }),
];
// The fixture runtime gives the MCP result's text; Claude gives its content blocks.
// A call is read once by its id, so each test's call has its own.
let calls = 0;
const needsCall = (output: unknown = JSON.stringify({ items: NEEDS }), at = minute(0)) =>
  call(`call-needs-${++calls}`, 'needs_you', {}, output, at);

const host = (
  session: WorkbenchSession | null,
  events: DaemonEvent[],
  options: { turn?: SessionTurn; personalKey?: string | null } = {},
) =>
  mount(() =>
    ThreadTurn({
      view: buildTranscript(
        [options.turn ?? turn()],
        [...events, event('turn.completed', minute(1))],
      ).turns[0]!,
      folders: [],
      status: { kind: 'ended', tool: null, since: null },
      fresh: new Set(),
      request: () => null,
      listed: session,
      ...(options.personalKey === undefined ? {} : { personalKey: options.personalKey }),
    }),
  );
// The list is a memo, whose element type holds the component.
const listOf = (tree: unknown) => find(tree as any, (n) => n.type === PersonalNeedsList);
const draw = (tree: unknown, name: string) => {
  const node = name === 'PersonalNeedsList' ? listOf(tree) : named(tree as any, name);
  const body = ((node.type as any).type ?? node.type) as (props: unknown) => ReactNode;
  return mount(() => body(node.props) as ReactElement<any>);
};
const groups = (tree: unknown) => nodes(tree as any).filter((n) => n.props.role === 'group');

let query: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sequence = 0;
  query = vi.fn(async () => ({ ok: true, value: [] }));
  vi.stubGlobal('window', { pantheon: { query } });
  mock.board = {
    board: {
      projects: [
        { id: 'payments', name: 'Payments service', roots: ['/p'] },
        { id: 'billing', name: 'Billing portal', roots: ['/b'] },
        { id: 'home', name: 'Personal', roots: [], kind: 'personal' },
      ],
      sessions: [
        { id: 'session-p', runtime: 'fixture', revision: 1 },
        { id: 'session-x', title: 'Refunds v2 rollout', project_id: 'payments' },
        { id: 'session-y', title: 'Webhook signature check', project_id: 'payments' },
        { id: 'assistant-b', title: 'Assistant', project_id: 'billing' },
      ],
      session_turns: [],
    },
    events: [],
  };
  mock.shell = {
    openProject: vi.fn(),
    openProjectSession: vi.fn(),
    openProjectNeed: vi.fn(),
    openProjectSessions: vi.fn(),
    openPersonal: vi.fn(),
  };
  runCommand.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('what waits, as the personal agent read it', () => {
  it.each([
    ['the text the fixture runtime gives', JSON.stringify({ items: NEEDS })],
    [
      'the content blocks Claude gives',
      { content: [{ type: 'text', text: JSON.stringify({ items: NEEDS }) }] },
    ],
  ])('is one list grouped by project from %s', (_from, output) => {
    const list = draw(host(listed(), needsCall(output)).value, 'PersonalNeedsList');
    const [whole, ...projects] = groups(list.value);
    expect(whole!.props['aria-label']).toBe(
      zhf('sessions.personalAgent.needs.label', { count: 3, projects: 2 }),
    );
    // The project whose item blocks the most comes first.
    expect(projects.map((g) => g.props['aria-label'])).toEqual([
      'Payments service',
      'Billing portal',
    ]);
    expect(text(projects[0]!)).toContain(zhf('data.attention.blocks', { count: 3 }));
  });

  it('says when it was read and holds that read when the turn draws again', () => {
    const events = needsCall();
    const first = listOf(host(listed(), events).value);
    const list = draw(first, 'PersonalNeedsList');
    expect(text(list.value)).toContain(
      zhf('sessions.personalAgent.needs.asOf', { time: clockText(minute(0)) }),
    );
    // A later draw of the same call, as while the reply streams, keeps the same list.
    const again = listOf(
      host(listed(), [...events, event('agent.message.delta', minute(1), { text: 'Three.' })])
        .value,
    );
    expect(again.props.items).toBe(first.props.items);
    expect(again.props.at).toBe(minute(0));
  });

  it('opens a row in its project', () => {
    const list = draw(host(listed(), needsCall()).value, 'PersonalNeedsList');
    const payments = groups(list.value)[1]!;
    find(payments, (n) => n.type === 'button').props.onClick();
    expect(mock.shell.openProjectSession).toHaveBeenCalledWith('payments', 'session-x');
  });

  it('shows five rows of a project, then how many more', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      need({
        project_id: 'payments',
        source: { table: 'approvals', id: `approval-${i}`, revision: 1 },
        session_id: 'session-x',
        created_at: minute(-i - 1),
      }),
    );
    const list = draw(
      host(listed(), needsCall(JSON.stringify({ items: many }))).value,
      'PersonalNeedsList',
    );
    const buttons = nodes(list.value).filter((n) => n.type === 'button');
    expect(buttons).toHaveLength(6);
    expect(text(buttons[5]!)).toBe(zhf('sessions.personalAgent.needs.more', { count: 2 }));
  });

  it('is a plain tool row in a project session', () => {
    const h = host(listed({ resident: { kind: 'assistant', agent_id: 'a' } }), needsCall());
    expect(nodes(h.value).some((n) => n.type === PersonalNeedsList)).toBe(false);
  });
});

describe('a request the personal agent sent', () => {
  it('names the Assistant and the project it went to, each opening it', () => {
    const sent = call(
      'call-send',
      'mcp__pantheon__send_request',
      { project_id: 'billing', input: 'Keep EU VAT on the invoice header.' },
      JSON.stringify({ receipt: { session_id: 'assistant-b', turn_id: 'turn-b' } }),
      minute(0),
    );
    const line = draw(host(listed(), sent).value, 'PersonalSentLine');
    const group = find(line.value, (n) => n.props.role === 'group');
    expect(group.props['aria-label']).toBe(
      zhf('sessions.personalAgent.sentTo', {
        agent: zh('sessions.personalAgent.assistant'),
        project: 'Billing portal',
      }),
    );
    const link = (name: string) => find(group, (n) => n.type === 'button' && text(n) === name);
    link(zh('sessions.personalAgent.assistant')).props.onClick();
    expect(mock.shell.openProjectSession).toHaveBeenCalledWith('billing', 'assistant-b');
    link('Billing portal').props.onClick();
    expect(mock.shell.openProject).toHaveBeenCalledWith('billing');
  });
});

describe('a project turn a personal key sent', () => {
  const via = (key: string) =>
    turn({ project_id: 'billing', via: { kind: 'personal', key_id: key } });
  const project = listed({ resident: { kind: 'assistant', agent_id: 'a' } });

  it('names the personal agent, with no way to open it, when its built-in key sent it', () => {
    const h = host(project, [], { turn: via('k-built'), personalKey: 'k-built' });
    const from = find(
      h.value,
      (n) => n.props['aria-label'] === zh('sessions.personalAgent.sentBy'),
    );
    expect(text(from)).toBe(zh('app.screenName.personal'));
    expect(nodes(from).filter((n) => n.type === 'button')).toEqual([]);
    expect(text(h.value).includes(zh('sessions.thread.viaPersonal'))).toBe(false);
  });

  it('keeps the key marker for another key', () => {
    const h = host(project, [], { turn: via('k-laptop'), personalKey: 'k-built' });
    expect(text(h.value).includes(zh('sessions.thread.viaPersonal'))).toBe(true);
  });
});
