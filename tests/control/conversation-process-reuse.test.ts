import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  AgentEventSink,
  CancelReceipt,
  HarnessAdapter,
  Project,
  Session,
  SessionHandle,
  SessionSpec,
  SessionTurn,
  UserTurn,
  Workspace,
} from '@pantheon/domain';
import { eventually, fixture } from '../helpers.js';
import { git } from './workbench-fixture.js';

const idleLimit = 10 * 60 * 1000;

/** With a reported model, it reports the model once when the session starts, as Codex does. */
function conversationAdapter(reportedModel?: string) {
  const sinks = new Map<SessionHandle, AgentEventSink>(),
    turns = new Map<SessionHandle, UserTurn>();
  let sequence = 0,
    launches = 0;
  const emit = (handle: SessionHandle, event: AgentEvent) => sinks.get(handle)!(event);
  const complete = (
    handle: SessionHandle,
    status: 'completed' | 'failed' | 'interrupted' = 'completed',
  ) => {
    const turn = turns.get(handle);
    if (!turn) return;
    turns.delete(handle);
    emit(handle, {
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'turn.completed',
      turn_id: turn.turn_id,
      status,
    });
  };
  const receipt = (stopped: boolean, deadline: number): CancelReceipt => ({
    stopped,
    deadline,
    finished_at: new Date().toISOString(),
    evidence: { method: 'none', members: [] },
  });
  const launch = async (spec: SessionSpec, sink: AgentEventSink): Promise<SessionHandle> => {
    launches++;
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: `native-${spec.platform_session_id}`,
      adapter_version: '1',
      device_id: 'local',
      process_identity: { pid: 900000 + launches, start_time_us: launches },
      ...(reportedModel ? { reported_model: reportedModel } : {}),
    };
    sinks.set(handle, sink);
    sink({
      key: String(++sequence),
      provider_sequence: sequence,
      kind: 'session.started',
      native_session_id: handle.native_session_id,
      ...(reportedModel ? { reported_model: reportedModel } : {}),
    });
    return handle;
  };
  const start = vi.fn((spec: SessionSpec, sink: AgentEventSink) => launch(spec, sink)),
    resume = vi.fn((spec: SessionSpec, _nativeId: string, sink: AgentEventSink) =>
      launch(spec, sink),
    );
  const close = vi.fn(async (_handle: SessionHandle, deadline: number) => receipt(true, deadline)),
    cancel = vi.fn(async (handle: SessionHandle, deadline: number) => {
      complete(handle, 'interrupted');
      return receipt(true, deadline);
    });
  const adapter: HarnessAdapter = {
    name: 'fixture',
    report: new FixtureAdapter().report,
    async probe() {
      return this.report;
    },
    start,
    resume,
    async inspect(handle) {
      return {
        state: 'unknown',
        native_session_id: handle.native_session_id,
        observed_at: new Date().toISOString(),
      };
    },
    async send(handle, turn) {
      turns.set(handle, turn);
      return { turn_id: turn.turn_id, status: 'delivered' };
    },
    async answerPermission() {
      return { ok: false };
    },
    close,
    cancel,
  };
  return { adapter, start, resume, close, cancel, complete };
}

/** Worktree sessions branch from a commit of the project root. */
function commitProjectRoot(root: string) {
  git(root, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

async function setup(now: () => number, reportedModel?: string) {
  const stub = conversationAdapter(reportedModel),
    f = await fixture({ adapter: stub.adapter, now, managedWorkspaces: true });
  commitProjectRoot(f.projectRoot);
  return { stub, f };
}

/** Creates a session and prepares its worktree; the first turn starts on the next tick. */
async function open(f: Awaited<ReturnType<typeof fixture>>) {
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Start the conversation',
  });
  await f.control.tick();
  await eventually(
    () =>
      f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state === 'ready',
  );
  const first = f.store
    .list<SessionTurn>('session_turns')
    .find((turn) => turn.session_id === session.id)!;
  return { session, first };
}

function send(f: Awaited<ReturnType<typeof fixture>>, session: Session) {
  return f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Continue the conversation' },
    f.store.must<Session>('sessions', session.id).revision,
  );
}

/** Runs one user turn to completion and returns its live handle; without a turn it sends one. */
async function converse(
  f: Awaited<ReturnType<typeof fixture>>,
  stub: ReturnType<typeof conversationAdapter>,
  session: Session,
  queued?: SessionTurn,
) {
  const turn = queued ?? send(f, session);
  await f.control.tick();
  const handle = [...f.control.handles.values()].find((h) => h.platform_session_id === session.id)!;
  stub.complete(handle);
  await eventually(() => f.store.must<SessionTurn>('session_turns', turn.id).state === 'completed');
  return { turn, handle };
}

function processOf(f: Awaited<ReturnType<typeof fixture>>, session: Session) {
  return f.store.must<Session>('sessions', session.id).process_identity;
}

it('reuses the native process for the next user turn', async () => {
  const { stub, f } = await setup(() => 100000);
  try {
    const { session, first } = await open(f);
    await converse(f, stub, session, first);
    expect(f.store.must<Session>('sessions', session.id).state).toBe('open');
    expect(processOf(f, session)).toBeDefined();
    const { turn } = await converse(f, stub, session);
    expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('completed');
    expect(stub.start).toHaveBeenCalledTimes(1);
    expect(stub.resume).toHaveBeenCalledTimes(0);
    expect(stub.close).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('records the model the session reported at its start on a later turn of the same process', async () => {
  const { stub, f } = await setup(() => 100000, 'reported-model-1');
  try {
    const { session, first } = await open(f);
    await converse(f, stub, session, first);
    const { turn } = await converse(f, stub, session);
    expect(stub.start).toHaveBeenCalledTimes(1);
    expect(f.store.must<SessionTurn>('session_turns', turn.id).reported_model).toBe(
      'reported-model-1',
    );
  } finally {
    await f.close();
  }
});

it('closes an idle conversation process after ten minutes and resumes on the next input', async () => {
  let now = 100000;
  const { stub, f } = await setup(() => now);
  try {
    const { session, first } = await open(f);
    const { handle } = await converse(f, stub, session, first);
    expect(processOf(f, session)).toBeDefined();
    now += idleLimit - 1;
    await f.control.tick();
    expect(stub.close).not.toHaveBeenCalled();
    expect(processOf(f, session)).toBeDefined();
    now += 1;
    await f.control.tick();
    await eventually(() => processOf(f, session) === undefined);
    expect(stub.close).toHaveBeenCalledTimes(1);
    expect(stub.close.mock.calls[0]![0]).toBe(handle);
    await converse(f, stub, session);
    expect(stub.start).toHaveBeenCalledTimes(1);
    expect(stub.resume).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('closes the process after a failed turn', async () => {
  const { stub, f } = await setup(() => 100000);
  try {
    const { session, first: turn } = await open(f);
    await f.control.tick();
    const handle = f.control.handles.get(turn.id)!;
    stub.complete(handle, 'failed');
    await eventually(() => processOf(f, session) === undefined);
    expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('failed');
    expect(stub.close).toHaveBeenCalledTimes(1);
    expect(stub.close.mock.calls[0]![0]).toBe(handle);
    expect(f.control.handles.size).toBe(0);
  } finally {
    await f.close();
  }
});

it('stops an idle conversation process at shutdown', async () => {
  const { stub, f } = await setup(() => 100000);
  try {
    const { session, first } = await open(f);
    const { handle } = await converse(f, stub, session, first);
    await f.control.shutdown();
    expect(stub.cancel).toHaveBeenCalledTimes(1);
    expect(stub.cancel.mock.calls[0]![0]).toBe(handle);
    expect(processOf(f, session)).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('publishes an event for the session change when an idle process closes', async () => {
  let now = 100000;
  const { stub, f } = await setup(() => now);
  try {
    const { session, first } = await open(f);
    await converse(f, stub, session, first);
    now += idleLimit;
    await f.control.tick();
    await eventually(() => processOf(f, session) === undefined);
    const current = f.store.must<Session>('sessions', session.id);
    expect(
      f.store
        .events(0, undefined, 10000)
        .some((e) => e.aggregate_id === session.id && e.aggregate_revision === current.revision),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it('removes a project whose conversation process is idle and closes that process', async () => {
  const { stub, f } = await setup(() => 100000);
  try {
    const { session, first } = await open(f);
    const { handle } = await converse(f, stub, session, first);
    f.call(
      'project.remove',
      { project_id: f.project.id },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    await eventually(() => processOf(f, session) === undefined);
    expect(stub.close.mock.calls.map(([closed]) => closed)).toEqual([handle]);
  } finally {
    await f.close();
  }
});

it('starts the conversation process again after the project environment changes', async () => {
  const { stub, f } = await setup(() => 100000);
  try {
    const { session, first } = await open(f);
    await converse(f, stub, session, first);
    const project = f.store.must<Project>('projects', f.project.id);
    await f.call(
      'project.environment.set',
      {
        project_id: project.id,
        name: project.name,
        roots: project.roots,
        env: { CONVERSATION_VALUE: 'new' },
      },
      project.revision,
    );
    await eventually(() => processOf(f, session) === undefined);
    await converse(f, stub, session);
    expect(stub.resume).toHaveBeenCalledTimes(1);
    expect(stub.resume.mock.calls[0]![0].env).toMatchObject({ CONVERSATION_VALUE: 'new' });
  } finally {
    await f.close();
  }
});
