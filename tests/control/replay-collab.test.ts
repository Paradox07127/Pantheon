import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TraceIndex } from '@pantheon/control';
import type { BoardPlan, Entity, LeadNote, Session, SessionTurn } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  let now = 1000;
  const f = fixture({ now: () => now });
  cleanups.push(() => f.close());
  const record = (at: number, kind: string, owner: Entity, payload: unknown, cause = '') => {
    now = at;
    return f.store.event(kind, owner, f.project.id, payload, cause);
  };
  const session = (id: string, extra: Partial<Session> = {}) => {
    const row = f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
      ...extra,
    });
    record(1000, 'session.opened', row, row);
    return row;
  };
  const turn = (owner: Session, id = `${owner.id}-turn`, extra: Partial<SessionTurn> = {}) => {
    const row = f.store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id: f.project.id,
      session_id: owner.id,
      input: 'Review the changes',
      kind: 'send',
      delivery: 'pending',
      state: 'running',
      ...extra,
    });
    record(1100, 'turn.queued', row, row);
    record(1200, 'turn.running', row, {});
    return row;
  };
  const tool = (
    owner: Session,
    turnId: string,
    id: string,
    name: string,
    input: unknown,
    at = 2000,
  ) => record(at, 'agent.tool.started', owner, { turn_id: turnId, tool_call_id: id, name, input });
  return { ...f, record, session, turn, tool };
}

it('replays only the selected edit input without a worktree', async () => {
  const f = setup(),
    owner = f.session('writer'),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'first-edit', 'Edit', {
    file_path: 'src/main.ts',
    old_string: 'before\n',
    new_string: 'after\n',
  });
  f.tool(
    owner,
    turn.id,
    'later-edit',
    'Edit',
    { file_path: 'src/main.ts', old_string: 'after\n', new_string: 'later\n' },
    3000,
  );
  expect(await f.control.sessionStepDiff(user, owner.id, turn.id, 'first-edit')).toEqual({
    session_id: owner.id,
    turn_id: turn.id,
    span_id: 'first-edit',
    files: [
      {
        path: 'src/main.ts',
        patch:
          'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,1 @@\n-before\n+after\n',
        truncated: false,
      },
    ],
  });
  await expect(
    f.control.sessionStepDiff(user, owner.id, 'other-turn', 'first-edit'),
  ).rejects.toThrow();
  await expect(
    f.control.sessionStepDiff(
      { ...user, role: 'worker', project_id: 'other' },
      owner.id,
      turn.id,
      'first-edit',
    ),
  ).rejects.toThrow();
});

it('returns no files for a read and added content for a whole-file write', async () => {
  const f = setup(),
    owner = f.session('writer'),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'read', 'Read', { file_path: 'file.txt' });
  f.tool(owner, turn.id, 'write', 'Write', { file_path: 'file.txt', content: 'new content' });
  expect((await f.control.sessionStepDiff(user, owner.id, turn.id, 'read')).files).toEqual([]);
  expect((await f.control.sessionStepDiff(user, owner.id, turn.id, 'write')).files).toEqual([
    {
      path: 'file.txt',
      patch:
        'diff --git a/file.txt b/file.txt\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1,1 @@\n+new content\n\\ No newline at end of file\n',
      truncated: false,
    },
  ]);
});

it('replays patch tool files and multiple edits of the same file', async () => {
  const f = setup(),
    owner = f.session('writer'),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'patch', 'functions.apply_patch', {
    value:
      '*** Begin Patch\n*** Update File: main.ts\n*** Move to: renamed.ts\n@@\n-old\n+new\n*** Add File: added.ts\n+added\n*** Delete File: removed.ts\n*** End Patch',
  });
  const files = (await f.control.sessionStepDiff(user, owner.id, turn.id, 'patch')).files;
  expect(files.map((file) => file.path)).toEqual(['renamed.ts', 'added.ts', 'removed.ts']);
  expect(files[0]!.patch).toContain('--- a/main.ts\n+++ b/renamed.ts');
  expect(files[0]!.patch).toContain('@@ -1,1 +1,1 @@\n-old\n+new');
  expect(files[1]!.patch).toContain('--- /dev/null\n+++ b/added.ts');
  expect(files[2]).toEqual({ path: 'removed.ts', patch: null, truncated: false });
  f.tool(owner, turn.id, 'multi', 'MultiEdit', {
    file_path: 'main.ts',
    edits: [
      { old_string: 'one', new_string: 'two' },
      { old_string: 'two', new_string: 'three' },
    ],
  });
  const multi = (await f.control.sessionStepDiff(user, owner.id, turn.id, 'multi')).files;
  expect(multi).toHaveLength(1);
  expect(multi[0]!.patch).toContain('-one');
  expect(multi[0]!.patch).toContain('+three');
  f.tool(owner, turn.id, 'file-change', 'fileChange', {
    changes: [{ path: 'main.ts', diff: '-old\n+new\n' }],
  });
  expect(
    (await f.control.sessionStepDiff(user, owner.id, turn.id, 'file-change')).files[0]!.patch,
  ).toContain('@@ -1,1 +1,1 @@');
});

it('caps total diff bytes and never presents capped tool input as a complete patch', async () => {
  const f = setup(),
    owner = f.session('writer'),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'big-patch', 'fileChange', {
    changes: [
      { path: 'first', diff: '+界'.repeat(60000) },
      { path: 'second', diff: '+界'.repeat(60000) },
      { path: 'small', diff: '+small\n' },
    ],
  });
  const files = (await f.control.sessionStepDiff(user, owner.id, turn.id, 'big-patch')).files;
  expect(files.map((file) => file.truncated)).toEqual([false, true, false]);
  expect(files[1]!.patch).toBeNull();
  expect(
    files.reduce((sum, file) => sum + Buffer.byteLength(file.patch ?? ''), 0),
  ).toBeLessThanOrEqual(400 * 1024);
  f.tool(owner, turn.id, 'capped', 'Write', {
    file_path: 'large',
    content: 'partial',
    truncated: true,
  });
  expect((await f.control.sessionStepDiff(user, owner.id, turn.id, 'capped')).files).toEqual([
    { path: 'large', patch: null, truncated: true },
  ]);
});

it('takes context and gate snapshots at span start across turns without borrowing future data', async () => {
  const f = setup(),
    owner = f.session('writer'),
    other = f.session('other'),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'before', 'Read', {}, 1300);
  f.record(1400, 'agent.usage.updated', owner, { context_tokens: 20, context_window: 100 });
  f.record(1500, 'session.gate_checked', owner, {
    results: [{ exit_code: 0, timed_out: false }],
  });
  f.tool(owner, turn.id, 'passing', 'Read', {}, 1500);
  f.record(1600, 'session.gate_checked', other, {
    results: [{ exit_code: 1, timed_out: false }],
  });
  f.record(1700, 'agent.usage.updated', owner, { context_tokens: 40, context_window: 100 });
  f.record(1800, 'session.gate_checked', owner, {
    results: [{ exit_code: 0, timed_out: true }],
  });
  f.tool(owner, turn.id, 'failing', 'Read', {}, 1900);
  f.record(2000, 'agent.usage.updated', owner, { context_tokens: 90, context_window: 100 });
  f.record(2050, 'session.gate_checked', owner, {
    results: [{ exit_code: 0, timed_out: false }],
  });
  f.record(2100, 'session.gate_run_failed', owner, { run_id: 'gate-run', error: 'Process failed' });
  f.tool(owner, turn.id, 'gate-error', 'Read', {}, 2200);
  const spans = (await f.control.sessionTrace(user, f.project.id, owner.id, turn.id)).spans;
  expect(spans.find((span) => span.id === 'before')).toMatchObject({ gate_state: 'none' });
  expect(spans.find((span) => span.id === 'before')).not.toHaveProperty('context_tokens');
  expect(spans.find((span) => span.id === 'passing')).toMatchObject({
    context_tokens: 20,
    context_window: 100,
    gate_state: 'passed',
  });
  expect(spans.find((span) => span.id === 'failing')).toMatchObject({
    context_tokens: 40,
    context_window: 100,
    gate_state: 'failed',
  });
  expect(spans.find((span) => span.id === 'gate-error')).toMatchObject({ gate_state: 'failed' });
  const next = f.turn(owner, 'next-turn');
  f.tool(owner, next.id, 'next', 'Read', {}, 3000);
  expect(
    (await f.control.sessionTrace(user, f.project.id, owner.id, next.id)).spans.find(
      (span) => span.id === 'next',
    ),
  ).toMatchObject({ context_tokens: 90, gate_state: 'failed' });
});

it('counts directed lead messages and worker reports in the inclusive project range', async () => {
  const f = setup(),
    lead = f.session('lead'),
    worker = f.session('worker', { task: { lead_session_id: lead.id, id: 'export' } });
  f.turn(worker, 'lead-message', { origin: 'lead' });
  f.turn(worker, 'user-message');
  f.record(1500, 'task.reported', lead, { session_id: worker.id, at: 1500, kind: 'risk' });
  f.record(
    1500,
    'task.reported',
    lead,
    { session_id: worker.id, at: 1500, kind: 'blocked' },
    'handback',
  );
  f.record(1500, 'task.handed_back', lead, { session_id: worker.id }, 'handback');
  f.record(2500, 'task.reported', lead, { session_id: worker.id, at: 2500, kind: 'done' });
  const result = await f.control.projectCollab(user, f.project.id, 1100, 1500);
  expect(result.messages).toEqual([
    { sender: lead.id, receiver: worker.id, direction: 'lead_to_worker', count: 1 },
    { sender: worker.id, receiver: lead.id, direction: 'worker_to_lead', count: 1 },
  ]);
  await expect(
    f.control.projectCollab(
      { ...user, role: 'worker', project_id: 'other' },
      f.project.id,
      0,
      5000,
    ),
  ).rejects.toThrow();
});

it('keeps notes in flight until their receiving turn is delivered, even outside the requested range', async () => {
  const f = setup(),
    lead = f.session('lead'),
    worker = f.session('worker', { task: { lead_session_id: lead.id, id: 'export' } });
  const queued = f.turn(worker, 'lead-message', { origin: 'lead' });
  const note: LeadNote = {
    id: 'report-note',
    at: 1500,
    session_id: worker.id,
    task_id: 'export',
    kind: 'risk',
    text: 'The export needs review',
  };
  f.record(1500, 'lead.note_added', lead, note, 'report');
  f.record(1500, 'task.reported', lead, note, 'report');
  const plan = f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Export review',
    lanes: [],
    tasks: [],
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [note],
    notified: {},
    updated_at: 1500,
  });
  expect((await f.control.projectCollab(user, f.project.id, 4000, 5000)).in_flight).toEqual([
    { sender: lead.id, receiver: worker.id, sent_at: 1100 },
    { sender: worker.id, receiver: lead.id, sent_at: 1500 },
  ]);
  f.store.update('board_plans', { ...plan, inbox: [] }, plan.revision);
  const digest = f.turn(lead, 'digest', { lead_note_ids: ['report-note'] });
  expect((await f.control.projectCollab(user, f.project.id, 4000, 5000)).in_flight).toEqual([
    { sender: lead.id, receiver: worker.id, sent_at: 1100 },
    { sender: worker.id, receiver: lead.id, sent_at: 1500 },
  ]);
  for (const row of [queued, digest])
    f.store.update('session_turns', { ...row, delivery: 'delivered' }, row.revision);
  expect((await f.control.projectCollab(user, f.project.id, 4000, 5000)).in_flight).toEqual([]);
});

it('reconstructs model changes from records before the requested range and omits effort-only changes', async () => {
  const f = setup(),
    owner = f.session('writer', { requested_model: 'initial' });
  f.record(1200, 'session.model_changed', owner, { model: 'middle' });
  f.record(1500, 'session.model_changed', owner, { model: 'final' });
  f.record(1600, 'session.model_changed', owner, { model: 'final', effort: 'high' });
  f.record(1700, 'session.model_changed', owner, { model: null });
  f.record(1800, 'session.runtime_changed', owner, { from: 'claude', to: 'codex' });
  f.record(1900, 'session.model_changed', owner, { model: 'codex-model' });
  expect((await f.control.projectCollab(user, f.project.id, 1500, 1900)).model_changes).toEqual([
    { session_id: owner.id, at: 1500, before: 'middle', after: 'final' },
    { session_id: owner.id, at: 1700, before: 'final', after: null },
    { session_id: owner.id, at: 1900, after: 'codex-model' },
  ]);
});

it('reads full native edit inputs and subagent spans from the trace cache', async () => {
  const f = setup(),
    home = path.join(f.root, 'claude');
  const nativeId = 'aa24c772-a37b-478a-b12c-80cf63471cd1';
  const directory = path.join(home, 'projects', 'project');
  mkdirSync(directory, { recursive: true });
  const rows = [
    {
      type: 'user',
      sessionId: nativeId,
      cwd: f.projectRoot,
      timestamp: new Date(1200).toISOString(),
      message: { content: 'Edit the file' },
    },
    {
      type: 'assistant',
      timestamp: new Date(2000).toISOString(),
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'edit',
            name: 'Edit',
            input: { file_path: 'main.ts', old_string: 'before\n', new_string: 'after\n' },
          },
          {
            type: 'tool_use',
            id: 'agent',
            name: 'Agent',
            input: { description: 'Review exports' },
          },
        ],
      },
    },
    {
      type: 'user',
      timestamp: new Date(2500).toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'Reviewed' }] },
    },
  ];
  writeFileSync(
    path.join(directory, `${nativeId}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  const trace = new TraceIndex({
    file: path.join(f.root, 'trace.sqlite'),
    claudeHomes: [home],
    codexHomes: [],
  });
  cleanups.push(() => trace.close());
  const { Control } = await import('@pantheon/control');
  const control = new Control(f.store, f.files, [], undefined, { trace });
  cleanups.push(() => control.shutdown());
  const owner = f.session('writer', { runtime: 'claude', native_id: nativeId }),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'edit', 'Edit', {
    file_path: 'main.ts',
    old_string: 'partial',
    new_string: 'partial',
    truncated: true,
  });
  await trace.scan(
    [
      {
        id: f.project.id,
        roots: [f.projectRoot],
        workspaces: [],
        sessions: [{ session_id: owner.id, runtime: 'claude', native_id: nativeId }],
      },
    ],
    60000,
  );
  const scan = vi.spyOn(trace, 'scan').mockRejectedValue(new Error('Replay must use the cache'));
  expect(
    (await control.sessionStepDiff(user, owner.id, turn.id, 'edit')).files[0]!.patch,
  ).toContain('-before\n+after');
  scan.mockRestore();
  expect((await control.projectCollab(user, f.project.id, 2000, 2000)).subagents).toEqual([
    {
      session_id: owner.id,
      span_id: 'agent',
      name: 'Agent',
      start: 2000,
      duration_ms: 500,
      status: 'ok',
    },
  ]);
});

it('replays Codex custom patch input and recorded native file changes', async () => {
  const f = setup(),
    home = path.join(f.root, 'codex'),
    nativeId = '04c1e684-7384-44ed-8cbe-2463cfc34b72';
  const directory = path.join(home, 'sessions', '2026', '11', '13');
  mkdirSync(directory, { recursive: true });
  const rows = [
    { type: 'session_meta', payload: { id: nativeId, cwd: f.projectRoot } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'custom-patch',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: added.ts\n+added\n*** End Patch',
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'FileChange',
          id: 'native-change',
          status: 'completed',
          changes: {
            'main.ts': {
              type: 'update',
              unified_diff: '@@ -4 +4 @@\n-old\n+new\n',
              move_path: 'renamed.ts',
            },
          },
        },
      },
    },
  ];
  writeFileSync(
    path.join(directory, `rollout-${nativeId}.jsonl`),
    rows
      .map((row, index) =>
        JSON.stringify({ ...row, timestamp: new Date(1500 + index * 100).toISOString() }),
      )
      .join('\n') + '\n',
  );
  const trace = new TraceIndex({
    file: path.join(f.root, 'trace.sqlite'),
    claudeHomes: [],
    codexHomes: [home],
  });
  cleanups.push(() => trace.close());
  const { Control } = await import('@pantheon/control');
  const control = new Control(f.store, f.files, [], undefined, { trace });
  cleanups.push(() => control.shutdown());
  const owner = f.session('writer', { runtime: 'codex', native_id: nativeId }),
    turn = f.turn(owner);
  await trace.scan(
    [
      {
        id: f.project.id,
        roots: [f.projectRoot],
        workspaces: [],
        sessions: [{ session_id: owner.id, runtime: 'codex', native_id: nativeId }],
      },
    ],
    60000,
  );
  expect((await control.sessionStepDiff(user, owner.id, turn.id, 'custom-patch')).files).toEqual([
    { path: 'added.ts', patch: expect.stringContaining('+added\n'), truncated: false },
  ]);
  expect((await control.sessionStepDiff(user, owner.id, turn.id, 'native-change')).files).toEqual([
    {
      path: 'renamed.ts',
      patch:
        'diff --git a/main.ts b/renamed.ts\n--- a/main.ts\n+++ b/renamed.ts\n@@ -4 +4 @@\n-old\n+new\n',
      truncated: false,
    },
  ]);
});

it.each([
  ['--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n', 'diff --git a/old.ts b/new.ts\n'],
  ['diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n', ''],
])('keeps runtime patch headers after the file header: %s', async (patch, prefix) => {
  const f = setup(),
    owner = f.session('writer'),
    turn = f.turn(owner);
  f.tool(owner, turn.id, 'runtime-change', 'file_change', {
    changes: { 'old.ts': { move_path: 'new.ts', unified_diff: patch } },
  });
  expect(
    (await f.control.sessionStepDiff(user, owner.id, turn.id, 'runtime-change')).files,
  ).toEqual([{ path: 'new.ts', patch: prefix + patch, truncated: false }]);
});
