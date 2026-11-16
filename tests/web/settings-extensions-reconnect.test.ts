import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { deferred, find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { reconnectSession } from '@/data/extensions';
import { t } from '@/i18n';
import { McpReconnect } from '@/screens/settings/ExtensionsPage';

type Command = { type: string; input: Record<string, unknown> };

let answer: Promise<BridgeResult<unknown>> | BridgeResult<unknown> | null = null;
const bridge = {
  commands: [] as Command[],
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return answer ?? { ok: true, value: { reconnected: true } };
  },
};

const mount = () => host(() => McpReconnect({ sessionId: 'live', server: 'tracker' }));
const button = (tree: unknown) => find(tree as never, (n) => n.type === 'button');
const alert = (tree: unknown) => nodes(tree as never).find((n) => n.props.role === 'alert');

beforeEach(() => {
  answer = null;
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('MCP server reconnect', () => {
  it('reconnects the server through the live session, the button off while it runs', async () => {
    const pending = deferred<BridgeResult<unknown>>();
    answer = pending.promise;
    const h = mount();
    expect(text(button(h.value))).toBe(zh('settings.extensions.reconnect'));
    expect(button(h.value).props['aria-label']).toBe(
      t({ id: 'settings.extensions.reconnectServer', defaultMessage: '' }, { name: 'tracker' }),
    );
    button(h.value).props.onClick();
    await h.flush();
    expect(bridge.commands.map(({ type, input }) => ({ type, input }))).toEqual([
      { type: 'mcp.reconnect', input: { session_id: 'live', server: 'tracker' } },
    ]);
    expect(button(h.value).props.disabled).toBe(true);
    pending.resolve({ ok: true, value: { reconnected: true } });
    await h.flush();
    expect(button(h.value).props.disabled).toBe(false);
    expect(alert(h.value)).toBeUndefined();
  });

  it('shows a refused reconnect in the row', async () => {
    answer = {
      ok: false,
      error: { code: 'invalid_state', message: 'MCP reconnect requires a live runtime session' },
    };
    const h = mount();
    button(h.value).props.onClick();
    await h.flush();
    expect(text(alert(h.value))).toContain('MCP reconnect requires a live runtime session');
    expect(button(h.value).props.disabled).toBe(false);
  });

  it("goes through the project's running session on the runtime, else an open one", () => {
    const sessions = [
      { id: 'other', project_id: 'beta', runtime: 'claude', state: 'running' as const },
      { id: 'codex', project_id: 'alpha', runtime: 'codex', state: 'running' as const },
      { id: 'idle', project_id: 'alpha', runtime: 'claude', state: 'open' as const },
      { id: 'busy', project_id: 'alpha', runtime: 'claude', state: 'running' as const },
    ];
    expect(reconnectSession(sessions, 'alpha', 'claude')).toBe('busy');
    expect(reconnectSession(sessions.slice(0, 3), 'alpha', 'claude')).toBe('idle');
    expect(reconnectSession(sessions.slice(0, 2), 'alpha', 'claude')).toBeUndefined();
  });
});
