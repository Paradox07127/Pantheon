import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import {
  deferred,
  find,
  HookHost,
  named,
  nodes,
  text,
  mount,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { buildTranscript } from '@/data/transcript';
import { useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { useQueued } from '@/screens/sessions/parts';
import { ContextBreakdown } from '@/screens/sessions/ContextBreakdown';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-14T09:00:00.000Z',
  title: 'Signed callbacks',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-14T09:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const running: Session = {
  id: 'session-a',
  revision: 4,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'running',
  turn_count: 1,
};
let sequence = 0;
const event = (kind: string, payload: Record<string, unknown>) => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: NOW - 5_000,
  payload: { turn_id: 'turn-a', ...payload },
});
const runningTurn = (events: unknown[]) =>
  buildTranscript(
    [
      {
        id: 'turn-a',
        revision: 1,
        project_id: 'project-a',
        session_id: 'session-a',
        input: 'Verify the callback signature',
        kind: 'send',
        delivery: 'delivered',
        state: 'running',
      } as any,
    ],
    events as any,
  ).turns[0]!;
const usage = { context_tokens: 150_000, context_window: 200_000 };

const status = (capabilities: Record<string, 'supported' | 'unsupported'>) => ({
  runtime: 'claude',
  enabled: true,
  installed: true,
  auth: { state: 'logged_in' },
  capabilities: Object.fromEntries(
    Object.entries(capabilities).map(([name, s]) => [name, { status: s }]),
  ),
});

let session: Session;
let command: ReturnType<typeof vi.fn>;
/** A component the tree holds as an element, drawn with its props. */
function drawn(tree: unknown, name: string) {
  const element = named(tree as any, name);
  return mount(() => (element.type as (props: unknown) => ReactNode)(element.props));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  session = running;
  useDrafts.setState({ drafts: {} });
  useQueued.setState({ queued: {}, failures: {} });
  useFeedback.setState({ items: {} });
  mock.board = {
    board: {
      cursor: 1,
      projects: [
        {
          id: 'project-a',
          name: 'Payments',
          extension_overrides: {
            claude: {
              disabled_mcp_servers: [],
              disabled_plugins: [],
              disabled_skills: [],
              disable_apps: false,
              disable_hooks: false,
              enabled_user_connectors: ['gmail', 'drive'],
            },
          },
        },
      ],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  const query = vi.fn(async (method: string, params: Record<string, string>) =>
    method === 'runtime.status'
      ? { ok: true, value: [status({ write_isolation: 'supported' })] }
      : method === 'extensions.inventory'
        ? {
            ok: true,
            value: {
              runtime: params.runtime,
              mcp_servers: [],
              plugins: [],
              skills: [],
              apps: true,
              connectors: [
                { name: 'gmail', enabled: true, title: 'Gmail' },
                { name: 'drive', enabled: true, title: 'Drive' },
                { name: 'slack', enabled: true, title: 'Slack' },
              ],
              hooks: [],
            },
          }
        : { ok: true, value: [] },
  );
  vi.stubGlobal('window', {
    pantheon: { command, query },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the status line while the runtime retries or compacts', () => {
  const compose = (events: unknown[], row = listed()) =>
    mount(() =>
      SessionCompose({
        session,
        listed: row,
        title: 'Signed callbacks',
        running: runningTurn(events),
        usage,
      }),
    );

  it('says which retry this is, why, and counts down to it', () => {
    const h = compose([
      event('agent.message.delta', { text: 'Reading the handler.' }),
      event('agent.turn.retrying', { attempt: 2, retry_at: NOW + 12_000, reason: 'rate_limit' }),
    ]);
    const line = drawn(h.value, 'ComposeStatus');
    expect(text(line.value)).toContain('第 2 次重试，限流');
    expect(text(line.value)).toContain('12 秒后重试');
    vi.advanceTimersByTime(3_000);
    line.render();
    expect(text(line.value)).toContain('9 秒后重试');
  });

  it('names an overload or network retry, without a countdown when no time is given', () => {
    const overloaded = compose([
      event('agent.turn.retrying', { attempt: 1, reason: 'overloaded' }),
    ]);
    const line = text(drawn(overloaded.value, 'ComposeStatus').value);
    expect(line).toContain('第 1 次重试，过载');
    expect(line).not.toContain('秒后重试');
    const network = compose([event('agent.turn.retrying', { attempt: 3, reason: 'network' })]);
    expect(text(drawn(network.value, 'ComposeStatus').value)).toContain('第 3 次重试，网络');
  });

  it('drops the retry once the model writes again', () => {
    const h = compose([
      event('agent.turn.retrying', { attempt: 2, retry_at: NOW + 12_000, reason: 'rate_limit' }),
      event('agent.message.delta', { text: 'Back on it.' }),
    ]);
    expect(text(drawn(h.value, 'ComposeStatus').value)).not.toContain('重试');
  });

  it('says the context is being compacted, automatic or asked for, until it is compacted', () => {
    const auto = compose([event('agent.context.compacting', { trigger: 'auto' })]);
    expect(text(drawn(auto.value, 'ComposeStatus').value)).toContain('正在自动压缩上下文');
    const manual = compose([event('agent.context.compacting', { trigger: 'manual' })]);
    const line = text(drawn(manual.value, 'ComposeStatus').value);
    expect(line).toContain(zh('sessions.thread.compacting'));
    expect(line).not.toContain('自动');
    const done = compose([
      event('agent.context.compacting', { trigger: 'auto' }),
      event('agent.context.compacted', { trigger: 'auto' }),
    ]);
    expect(text(drawn(done.value, 'ComposeStatus').value)).not.toContain('压缩');
  });

  it('spins the context ring while the context is being compacted', () => {
    const spinning = (h: HookHost<any>) =>
      nodes(drawn(h.value, 'ContextRing').value).some(
        (n) => n.type === 'svg' && n.props.className === 'si-spin',
      );
    expect(spinning(compose([event('agent.context.compacting', { trigger: 'auto' })]))).toBe(true);
    expect(spinning(compose([event('agent.message.delta', { text: 'Reading.' })]))).toBe(false);
  });
});

describe('the automatic compaction point on the context bar', () => {
  const breakdown = (value: unknown) => mount(() => ContextBreakdown({ usage: value }));

  it('marks where the runtime compacts by itself and writes the number', () => {
    const h = breakdown({ ...usage, auto_compact_at_tokens: 160_000 });
    const bar = find(h.value, (n) => n.props.role === 'img');
    const mark = find(bar, (n) => n.props.className === 'cp-cxm');
    expect(mark.props.style.left).toBe('80%');
    expect(text(h.value)).toContain('160k 时自动压缩');
  });

  it('draws no mark when the runtime reports no point', () => {
    const h = breakdown(usage);
    expect(nodes(h.value).some((n) => n.props.className === 'cp-cxm')).toBe(false);
    expect(text(h.value)).not.toContain('自动压缩');
  });
});

describe('the connectors of one session', () => {
  const compose = async (row: WorkbenchSession) => {
    session = { ...running, state: 'open' };
    const h = mount(() => SessionCompose({ session, listed: row, title: 'Signed callbacks' }));
    await h.flush();
    await h.flush();
    return h;
  };
  const connectorItems = (h: HookHost<any>) => {
    const sub = find(
      h.value,
      (n) =>
        typeof n.type === 'function' &&
        n.type.name === 'MenuSubmenuRoot' &&
        text(n).startsWith(zh('sessions.composer.connectors')),
    );
    return nodes(sub).filter((n) => typeof n.props.onCheckedChange === 'function');
  };
  const sent = () => command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision]);

  it("lists the project's connectors, all on while the session follows the project", async () => {
    const h = await compose(listed({ state: 'idle' }));
    const items = connectorItems(h);
    expect(items.map(text)).toEqual(['Gmail', 'Drive']);
    expect(items.map((i) => i.props.checked)).toEqual([true, true]);
  });

  it("turns one off for this session with the session's own list", async () => {
    const h = await compose(listed({ state: 'idle' }));
    connectorItems(h)[0]!.props.onCheckedChange(false);
    await h.flush();
    expect(sent()).toEqual([
      ['session.setConnectors', { session_id: 'session-a', enabled: ['drive'] }, 4],
    ]);
  });

  it("starts from the session's own list once it has one", async () => {
    const h = await compose(listed({ state: 'idle', enabled_user_connectors: ['drive'] }));
    const items = connectorItems(h);
    expect(items.map((i) => i.props.checked)).toEqual([false, true]);
    items[0]!.props.onCheckedChange(true);
    await h.flush();
    expect(sent()).toEqual([
      ['session.setConnectors', { session_id: 'session-a', enabled: ['drive', 'gmail'] }, 4],
    ]);
  });

  it('holds the connectors while a change of them is on its way', async () => {
    const h = await compose(listed({ state: 'idle' }));
    const answer = deferred<unknown>();
    command.mockReturnValueOnce(answer.promise);
    connectorItems(h)[0]!.props.onCheckedChange(false);
    await h.flush();
    expect(connectorItems(h).map((i) => i.props.disabled)).toEqual([true, true]);
    answer.resolve({ ok: true, value: {} });
    await h.flush();
    expect(connectorItems(h).map((i) => i.props.disabled)).toEqual([false, false]);
  });
});
