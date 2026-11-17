import { expect, it } from 'vitest';
import { agentEvent } from '../../packages/control/dist/agent.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it('answers with the MCP servers the session last reported at its start, without asking the runtime', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const other = await f.create('Read something else');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const adapter = ctx.adapters.get(session.runtime)!;
  adapter.mcpStatus = () => {
    throw new Error('The runtime was asked');
  };
  expect(f.control.sessionMcpServers(user, session.id)).toEqual([]);
  agentEvent(ctx, session.id, {
    key: 'started-with-servers',
    provider_sequence: 101,
    kind: 'session.started',
    native_session_id: 'native-with-servers',
    native: {
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'codegraph', status: 'connected' },
        { name: 'switched-off', status: 'disabled' },
      ],
    },
  });
  expect(f.control.sessionMcpServers(user, session.id)).toEqual([
    { name: 'codegraph', state: 'connected' },
    { name: 'switched-off', state: 'disabled' },
  ]);
  agentEvent(ctx, session.id, {
    key: 'started-again',
    provider_sequence: 102,
    kind: 'session.started',
    native_session_id: 'native-with-servers',
    native: {
      type: 'system',
      subtype: 'init',
      mcp_servers: [
        { name: 'codegraph', status: 'failed' },
        { name: 'docs', status: 'needs-auth' },
      ],
    },
  });
  expect(f.control.sessionMcpServers(user, session.id)).toEqual([
    { name: 'codegraph', state: 'failed' },
    { name: 'docs', state: 'needs_sign_in' },
  ]);
  expect(f.control.sessionMcpServers(user, other.id)).toEqual([]);
  expect(() => f.control.sessionMcpServers({ id: 'foreign', role: 'writer' }, session.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('names the servers a session loaded when its start reports none', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  agentEvent(ctx, session.id, {
    key: 'extensions-applied',
    provider_sequence: 101,
    kind: 'extensions.applied',
    mode: 'inherit',
    disabled: { mcp_servers: ['switched-off'], plugins: [], skills: [], apps: false, hooks: false },
    loaded: {
      mcp_servers: ['pantheon', 'codegraph'],
      plugins: [],
      skills: [],
      apps: false,
      hooks: false,
    },
  });
  expect(f.control.sessionMcpServers(user, session.id)).toEqual([
    { name: 'pantheon', state: 'unknown' },
    { name: 'codegraph', state: 'unknown' },
  ]);
});
