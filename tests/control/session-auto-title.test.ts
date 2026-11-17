import { expect, it } from 'vitest';
import { ClaudeAdapter, CodexAdapter } from '@pantheon/adapters';
import type { AgentEvent, Session, SessionSpec, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

/** A workbench fixture whose fixture adapter stands in for the named runtime. */
async function runtimeFixture(runtime: 'claude' | 'codex') {
  const f = await workbenchFixture();
  f.control.adapters.delete(f.adapter.name);
  f.adapter.name = runtime;
  const real = runtime === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
  Object.assign(f.adapter, { generatesTitles: real.generatesTitles });
  f.control.adapters.set(runtime, f.adapter);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  return { ...f, ctx };
}

const generated = (title: string, key = 'title'): AgentEvent => ({
  key,
  provider_sequence: 1,
  kind: 'title.generated',
  title,
});

const renames = (f: Awaited<ReturnType<typeof runtimeFixture>>) =>
  f.store.kindEvents(f.project.id, ['session.renamed']).map((event) => event.payload);

it('lets the runtime name a new conversation and shows the title it generated', async () => {
  const f = await runtimeFixture('claude');
  const session = await f.create('Fix the importer\nIt drops the last row');
  expect(session.title).toBe('Fix the importer');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed',
    () => f.control.tick(),
  );
  const [spec, sink] = f.start.mock.calls[0]! as [SessionSpec, (event: AgentEvent) => void];
  expect(spec.auto_title).toBe(true);
  expect(spec.native_title).toBeUndefined();
  sink(generated('  Importer drops\nthe last row  '));
  const named = f.store.must<Session>('sessions', session.id);
  expect(named.title).toBe('Importer drops the last row');
  expect(named).not.toHaveProperty('title_source');
  expect(f.list()[0]!.title).toBe('Importer drops the last row');
  expect(renames(f)).toEqual([{ title: 'Importer drops the last row', source: 'auto' }]);
});

it('drops a generated title that arrives after the user renamed the session', async () => {
  const f = await runtimeFixture('codex');
  const session = await f.create('Fix the importer');
  const renamed = f.call<Session>(
    'session.rename',
    { session_id: session.id, title: 'My own name' },
    session.revision,
  );
  agentEvent(f.ctx, session.id, generated('Fix importer rows'));
  expect(f.store.must<Session>('sessions', session.id)).toEqual(renamed);
  expect(renames(f)).toEqual([{ title: 'My own name' }]);
});

it('keeps the title of a task session, of a fixture session and on an empty generated title', async () => {
  const f = await runtimeFixture('claude');
  const created = await f.create('Work on a planned task');
  const task = f.store.update<Session>(
    'sessions',
    { ...created, title: 'Planned task', task: { lead_session_id: 'lead', id: 'task-1' } },
    created.revision,
  );
  agentEvent(f.ctx, task.id, generated('Generated task title'));
  expect(f.store.must<Session>('sessions', task.id).title).toBe('Planned task');
  const plain = await f.create('Fix the importer');
  agentEvent(f.ctx, plain.id, generated(' \n ', 'empty'));
  expect(f.store.must<Session>('sessions', plain.id).title).toBe('Fix the importer');
  const fixture = f.store.update<Session>(
    'sessions',
    { ...plain, runtime: 'fixture' },
    f.store.must<Session>('sessions', plain.id).revision,
  );
  agentEvent(f.ctx, fixture.id, generated('Generated fixture title', 'fixture'));
  expect(f.store.must<Session>('sessions', fixture.id).title).toBe('Fix the importer');
  expect(renames(f)).toEqual([]);
});

it('keeps pushing the native title for sessions the runtime does not name', async () => {
  const f = await runtimeFixture('claude');
  const conversation = await f.create('Fix the importer');
  await awaitWorkspaceReady(f.control, conversation.workspace_id!);
  expect(workbenchSessionSpec(f.ctx, conversation)).toMatchObject({ auto_title: true });
  // A lead the board opened is titled by the board, and its first message is an instruction.
  const lead = await f.create('Plan the work the sync found');
  const [first] = f.turns(lead.id) as SessionTurn[];
  f.store.update<SessionTurn>('session_turns', { ...first!, origin: 'sync' }, first!.revision);
  const task = await f.create('Work on a planned task');
  const assigned = f.store.update<Session>(
    'sessions',
    { ...task, task: { lead_session_id: lead.id, id: 'task-1' } },
    task.revision,
  );
  for (const session of [lead, assigned]) {
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    const spec = workbenchSessionSpec(f.ctx, f.store.must<Session>('sessions', session.id));
    expect(spec).not.toHaveProperty('auto_title');
    expect(spec.native_title).toBe('Workbench project · Project conversation');
  }
});
