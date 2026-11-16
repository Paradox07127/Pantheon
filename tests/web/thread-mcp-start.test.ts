import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ board: { sessions: [] } }), {
    getState: () => ({ board: { sessions: [] } }),
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';
import { zhf } from './i18n-setup.js';

const turn: SessionTurn = {
  id: 'turn-1',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: 'hello',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
};
const ERROR = 'Codex did not provide CODEX_APP_TOOLS_PIPE_PATH';
const failedStart = {
  sequence: 1,
  event_id: 'event-1',
  kind: 'agent.native',
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: new Date(2026, 10, 12, 10, 7).getTime(),
  payload: {
    turn_id: 'turn-1',
    native_type: 'mcpServer/startupStatus/updated',
    native: {
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'codex_app', status: 'failed', error: ERROR },
    },
  },
} as DaemonEvent;

const body = (tree: unknown, name: string) => {
  const node = named(tree as any, name);
  return mount(() => (node.type as (props: unknown) => ReactNode)(node.props) as ReactElement<any>);
};

afterEach(unmountAll);

describe('a failed MCP server start in the thread', () => {
  it('reads as a notice naming the server, with the error cut to one line and whole in its title', () => {
    const view = buildTranscript([turn], [failedStart]).turns[0]!;
    const h = mount(() =>
      ThreadTurn({
        view,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
      }),
    );
    const items = body(h.value, 'Items').value;
    const mark = body(body(items, 'McpStartNotice').value, 'ThreadMark').value;
    expect(text(mark)).toBe(
      `${zhf('sessions.thread.mcpStartFailed', { name: 'codex_app' })}${ERROR}10:07`,
    );
    const error = nodes(mark).find((n) => n.props.title === ERROR);
    expect(text(error!)).toBe(ERROR);
  });
});
