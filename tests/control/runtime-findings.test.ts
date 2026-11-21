import { expect, it, vi } from 'vitest';
import type {
  Approval,
  BoardPlan,
  Principal,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { runtimeDiagnostics } from '../../packages/control/dist/runtime-findings.js';
import { eventually, fixture, user } from '../helpers.js';

it('pairs lifecycle timestamps, distinguishes tool timing sources and gives reflection bounded read-only evidence', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const project = f.project.id;
    const workspace = f.store.insert<Workspace>('workspaces', {
      id: 'runtime-worktree',
      revision: 1,
      project_id: project,
      kind: 'linked_worktree',
      path: f.projectRoot,
      owner: 'runtime-lead',
      ownership_epoch: 1,
    });
    const lead = f.store.insert<Session>('sessions', {
      id: 'runtime-lead',
      revision: 1,
      project_id: project,
      runtime: 'fixture',
      state: 'open',
      workspace_id: workspace.id,
      turn_count: 1,
    });
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: 'runtime-turn',
      revision: 1,
      project_id: project,
      session_id: lead.id,
      state: 'completed',
      input: 'private input',
      kind: 'send',
      delivery: 'delivered',
    });
    const ev = (kind: string, entity: { id: string; revision: number }, data = {}) =>
      f.store.event(kind, entity, project, data);
    ev('turn.queued', turn);
    now += 3_000;
    ev('turn.prepare_started', turn);
    now += 2_200;
    ev('turn.running', turn);
    const approval = { id: 'runtime-approval', revision: 1 };
    ev('approval.requested', approval, { session_id: lead.id, turn_id: turn.id });
    now += 6_000;
    ev('approval.approved', approval, {
      session_id: lead.id,
      turn_id: turn.id,
      decided_by: 'local-user',
    });
    now += 4_000;
    ev('approval.resolved', approval, { session_id: lead.id, turn_id: turn.id });
    const tool = (tool_call_id: string) => ({ tool_call_id, turn_id: turn.id });
    ev('agent.tool.started', lead, { ...tool('reported'), input: 'SECRET_TOOL_TEXT' });
    ev('agent.tool.completed', lead, {
      ...tool('reported'),
      ok: true,
      duration_ms: 5_231,
      output: 'SECRET_TOOL_TEXT',
    });
    ev('agent.tool.started', lead, tool('missing'));
    ev('agent.tool.completed', lead, { ...tool('missing'), ok: false });
    ev('task.start_requested', lead, { task_ids: ['sample'] });
    const requestAt = now;
    now += 1_000;
    const reason = ev('task.dispatch_wait_changed', lead, {
      task_id: 'sample',
      wait: 'scope',
      requested_at: requestAt,
    });
    now += 6_000;
    ev('task.dispatched', lead, { task_id: 'sample', session_id: lead.id });
    ev('turn.completed', turn);
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const result = runtimeDiagnostics(ctx, project, from, now);
    expect(result).toMatchObject({ tools_timed: 1, tools_untimed: 1, partial: false });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'turn_queue', duration_ms: 3_000, turn_id: turn.id }),
        expect.objectContaining({ kind: 'turn_prepare', duration_ms: 2_200, turn_id: turn.id }),
        expect.objectContaining({ kind: 'approval', duration_ms: 6_000, layer: 'human' }),
        expect.objectContaining({
          kind: 'slow_tool',
          duration_ms: 5_231,
          source: 'runtime_reported',
        }),
        expect.objectContaining({ kind: 'tool_failure', duration_ms: undefined }),
        expect.objectContaining({
          kind: 'dispatch_queue',
          duration_ms: 7_000,
          wait_reason: 'scope',
          wait_ms_by_reason: { scope: 6_000 },
          evidence_ids: expect.arrayContaining([reason.event_id]),
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('SECRET_TOOL_TEXT');
    const principal: Principal = {
      id: 'runtime-lead-principal',
      role: 'lead',
      project_id: project,
      session_id: lead.id,
      expires_at: now + 60_000,
    };
    const input = { project_id: project, lead_session_id: lead.id, from, to: now };
    // A session the user opened holds no credential, so its principal is refused before the action check.
    expect(() => f.call('trace.reflect', input, null, principal)).toThrow(
      'Active session credential required',
    );

    const window = { project_id: project, from, to: now };
    const { session_id } = f.call<{ session_id: string }>('trace.reflect', window);
    expect(session_id).not.toBe(lead.id);
    expect(f.store.must<Session>('sessions', lead.id)).toEqual(lead);
    expect(
      f.store.list<SessionTurn>('session_turns').filter((row) => row.session_id === lead.id),
    ).toEqual([turn]);
    const reflection = f.store
      .list<SessionTurn>('session_turns')
      .find((row) => row.session_id === session_id)!;
    expect(reflection.origin).toBe('reflection');
    expect(reflection.input).not.toContain(reason.event_id);
    expect(f.call('trace.reflect', window)).toEqual({ session_id });
    const analysisPrincipal: Principal = {
      ...principal,
      role: 'planner',
      session_id,
      id: 'analysis',
    };
    expect(f.control.sessionPrincipal(analysisPrincipal).allowed_tool_names).toEqual([
      'trace.evidence',
      'trace.report',
    ]);
    expect(() => f.control.projectRead(analysisPrincipal, project)).toThrow(
      'Action outside session role',
    );
    expect(() => f.call('trace.evidence', { project_id: project }, null, principal)).toThrow(
      'Active session credential required',
    );
    f.store.update('session_turns', { ...reflection, state: 'running' }, reflection.revision);
    const summary = f.call('trace.evidence', { project_id: project }, null, analysisPrincipal);
    expect(summary).toMatchObject({ counts: { approval: 1, dispatch_queue: 1 } });
    const page = f.call<{ items: { id: string; evidence_ids: string[] }[] }>(
      'trace.evidence',
      {
        project_id: project,
        view: 'findings',
        kind: 'dispatch_queue',
        limit: 1,
      },
      null,
      analysisPrincipal,
    );
    expect(page.items[0]?.evidence_ids).toContain(reason.event_id);
    expect(JSON.stringify(page)).not.toContain('SECRET_TOOL_TEXT');
    const report = {
      project_id: project,
      summary: 'Scope wait',
      disposition: 'experiment',
      finding_ids: [page.items[0]!.id],
      change: 'Separate ownership',
      baseline: 'Same task type',
      metric: 'Dispatch P95 milliseconds',
      rollback: 'Revert on worse first-pass quality',
    };
    expect(() =>
      f.call('trace.report', { ...report, finding_ids: ['unknown'] }, null, analysisPrincipal),
    ).toThrow('Cite findings');
    expect(f.call('trace.report', report, null, analysisPrincipal)).toEqual({ saved: true });
    f.store.insert<BoardPlan>('board_plans', {
      id: lead.id,
      revision: 1,
      project_id: project,
      headline: 'Original plan',
      lanes: [],
      tasks: [],
      pending_edits: [],
      risks: [],
      assumptions: [],
      inbox: [],
      notified: {},
      plan_version: 1,
      updated_at: now,
    });
    expect(f.call('trace.share', { session_id, lead_session_id: lead.id })).toEqual({
      shared: true,
    });
    expect(f.store.must<Session>('sessions', lead.id)).toEqual(lead);
    expect(() => f.call('trace.remember', { session_id })).toThrow('successful experiment');
    f.call('trace.verify', {
      session_id,
      outcome: 'improved',
      baseline: 7000,
      trial: 3000,
      evidence: 'matched runs',
    });
    expect(f.call('trace.remember', { session_id })).toMatchObject({
      memory_id: expect.any(String),
    });
    expect(f.store.list<{ id: string; revision: number; state: string }>('memory_records')).toEqual(
      [expect.objectContaining({ state: 'draft' })],
    );
    for (let index = 0; index < 6; index++)
      f.call('trace.evidence', { project_id: project }, null, analysisPrincipal);
    expect(() =>
      f.call('trace.evidence', { project_id: project }, null, analysisPrincipal),
    ).toThrow('read limit');
  } finally {
    await f.close();
  }
});

it('distinguishes runtime delivery from the user decision and native-only coverage', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const id = f.project.id;
    const ev = (kind: string, approval: string, data = {}) =>
      f.store.event(kind, { id: approval, revision: 1 }, id, { session_id: 'session', ...data });
    ev('approval.requested', 'void');
    ev('approval.requested', 'runtime-only');
    ev('approval.requested', 'paired');
    now += 6_000;
    ev('approval.void', 'void');
    ev('approval.resolved', 'runtime-only');
    ev('approval.approved', 'paired', { decided_by: 'local-user' });
    now += 9_000;
    ev('approval.resolved', 'paired');
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const result = runtimeDiagnostics(ctx, id, from, now, {
      native: [
        {
          lane: { key: 'native:claude:case' },
          spans: [
            {
              id: 'compact',
              parent: 'turn',
              turn: 'turn',
              kind: 'compact',
              name: 'compact',
              timing: 'native',
              status: 'ok',
              start: now,
              end: now,
            },
          ],
        },
      ],
    });
    expect(result.coverage).toMatchObject({ paired_approvals: 1, native_lanes: 1, compactions: 1 });
    expect(
      result.findings.map(({ kind, layer, duration_ms }) => [kind, layer, duration_ms]),
    ).toEqual([
      ['permission_delivery', 'runtime', 9_000],
      ['approval', 'human', 6_000],
      ['context_compaction', 'runtime', undefined],
    ]);
  } finally {
    await f.close();
  }
});

it('ends queue and preparation waits at the terminal event of a turn that never ran', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const project = f.project.id;
    const turn = (id: string) =>
      f.store.insert<SessionTurn>('session_turns', {
        id,
        revision: 1,
        project_id: project,
        session_id: 'terminal-lane',
        state: 'failed',
        input: 'input',
        kind: 'send',
        delivery: 'failed',
      });
    const startup = turn('startup-fails');
    const prepare = turn('preparation-fails');
    f.store.event('turn.queued', startup, project, {});
    f.store.event('turn.queued', prepare, project, {});
    now += 1_000;
    f.store.event('turn.prepare_started', prepare, project, {});
    now += 29_000;
    f.store.event('turn.failed', startup, project, {});
    now += 11_000;
    f.store.event('turn.failed', prepare, project, {});
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const result = runtimeDiagnostics(ctx, project, from, now, { live: false });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'turn_queue', turn_id: startup.id, duration_ms: 30_000 }),
        expect.objectContaining({ kind: 'turn_prepare', turn_id: prepare.id, duration_ms: 40_000 }),
      ]),
    );
  } finally {
    await f.close();
  }
});

it('reports a decided approval the runtime has not acknowledged as an ongoing delivery', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const project = f.project.id;
    const approval = (id: string) =>
      f.store.insert<Approval>('approvals', {
        id,
        revision: 1,
        project_id: project,
        kind: 'permission',
        session_id: 'delivery-lane',
        request_id: id,
        input_hash: id,
        decider: 'user',
        state: 'pending',
        created_at: now,
      });
    const stalled = approval('stalled');
    const lost = approval('lost');
    for (const row of [stalled, lost])
      f.store.event('approval.requested', row, project, { session_id: 'delivery-lane' });
    now += 6_000;
    const approved = f.store.update<Approval>(
      'approvals',
      { ...stalled, state: 'approved', decided_by: 'local-user' },
      stalled.revision,
    );
    const approvedEvent = f.store.event('approval.approved', approved, project, {
      session_id: 'delivery-lane',
      decided_by: 'local-user',
    });
    const decided = f.store.update<Approval>(
      'approvals',
      { ...lost, state: 'approved', decided_by: 'local-user' },
      lost.revision,
    );
    f.store.event('approval.approved', decided, project, {
      session_id: 'delivery-lane',
      decided_by: 'local-user',
    });
    f.store.update<Approval>(
      'approvals',
      { ...decided, state: 'rejected', reason: 'session_lost' },
      decided.revision,
    );
    now += 10_000;
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const result = runtimeDiagnostics(ctx, project, from, now, { live: true });
    const delivery = result.findings.filter((finding) => finding.kind === 'permission_delivery');
    expect(delivery).toEqual([
      expect.objectContaining({ layer: 'runtime', ongoing: true, duration_ms: 10_000 }),
    ]);
    expect(delivery[0]!.evidence_ids).toEqual([approvedEvent.event_id]);
  } finally {
    await f.close();
  }
});

it('starts a new dispatch wait when a stopped request is requested again', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const project = f.project.id;
    const lead = { id: 'dispatch-lead', revision: 1 };
    f.store.event('task.start_requested', lead, project, { task_ids: ['sample'] });
    f.store.event('task.dispatch_wait_changed', lead, project, {
      task_id: 'sample',
      wait: 'capacity',
      requested_at: from,
    });
    now += 60_000;
    f.store.event('task.stop_requested', lead, project, { task_id: 'sample' });
    now += 60_000;
    f.store.event('task.start_requested', lead, project, { task_ids: ['sample'] });
    now += 6_000;
    f.store.event('task.dispatched', lead, project, { task_id: 'sample', session_id: 'worker' });
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const result = runtimeDiagnostics(ctx, project, from, now, { live: false });
    const queue = result.findings.filter((finding) => finding.kind === 'dispatch_queue');
    expect(queue).toEqual([
      expect.objectContaining({ duration_ms: 6_000, started_at: now - 6_000 }),
    ]);
    expect(queue[0]!.wait_ms_by_reason).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('starts a fresh read-only runtime and accepts a follow-up without opening the project context', async () => {
  const f = await fixture();
  try {
    const start = vi.spyOn(f.adapter, 'start'),
      send = vi.spyOn(f.adapter, 'send');
    const project_id = f.project.id,
      to = f.store.now();
    const { session_id } = f.call<{ session_id: string }>('trace.reflect', {
      project_id,
      from: to - 1000,
      to,
    });
    const settle = () =>
      eventually(
        () =>
          f.store.must<Session>('sessions', session_id).state === 'open' &&
          send.mock.calls.length > 0,
        () => f.control.tick(),
      );
    await settle();
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      role: 'reviewer',
      project_id,
      extensions: { mode: 'none' },
      mcp_servers: [],
      control_instructions: expect.stringContaining('trace_evidence'),
    });
    expect(start.mock.calls[0]?.[0].cwd).not.toBe(f.projectRoot);
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      read_only: true,
      input: 'Analyze the selected runtime evidence and save your conclusion.',
    });
    expect(f.control.sessionList(user, project_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: session_id, runtime_review: true, state: 'idle' }),
      ]),
    );
    f.call(
      'session.send',
      { session_id, input: 'What is missing from the evidence?' },
      f.store.must<Session>('sessions', session_id).revision,
    );
    await settle();
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      read_only: true,
      input: 'What is missing from the evidence?',
    });
  } finally {
    await f.close();
  }
});

it('publishes the slow threshold and chronological daemon and native evidence', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const owner = { id: 'evidence-session', revision: 1 };
    const start = f.store.event('agent.tool.started', owner, f.project.id, {
      tool_call_id: 'shell',
      name: 'Bash',
    });
    now += 6000;
    const end = f.store.event('agent.tool.completed', owner, f.project.id, {
      tool_call_id: 'shell',
      ok: true,
      duration_ms: 5000,
    });
    const short = f.store.event('agent.tool.completed', owner, f.project.id, {
      tool_call_id: 'short',
      ok: true,
      duration_ms: 4999,
    });
    const result = runtimeDiagnostics(ctx, f.project.id, from, now, {
      native: [
        {
          lane: { key: 'external' },
          spans: [
            {
              id: 'native-shell',
              parent: 'turn',
              turn: 'turn',
              kind: 'tool',
              name: 'command',
              start: from + 1,
              end: now - 1,
              status: 'error',
              timing: 'native',
            },
          ],
        },
      ],
    });
    expect(result.slow_tool_ms).toBe(5000);
    const daemon = result.findings.find((finding) => finding.kind === 'slow_tool')!;
    expect(daemon.evidence_ids).toEqual([start.event_id, end.event_id]);
    expect(daemon.evidence).toEqual([
      { source: 'daemon', at: from, id: start.event_id },
      { source: 'runtime_reported', at: now, id: end.event_id, duration_ms: 5000 },
    ]);
    expect(result.findings.some((finding) => finding.evidence_ids.includes(short.event_id))).toBe(
      false,
    );
    expect(result.findings.find((finding) => finding.kind === 'tool_failure')?.evidence).toEqual([
      { source: 'native', at: now - 1, id: 'native-shell', duration_ms: 5998 },
    ]);
    for (const finding of result.findings) {
      expect(finding.evidence!.length).toBeLessThanOrEqual(20);
      expect(finding.evidence!.map((item) => item.at)).toEqual(
        finding.evidence!.map((item) => item.at).sort((a, b) => a - b),
      );
    }
  } finally {
    await f.close();
  }
});

it('times a tool call from its approval to its result and keeps the failure of a turn', async () => {
  let now = 1_800_000_000_000;
  const from = now;
  const f = await fixture({ now: () => now });
  try {
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    const project = f.project.id;
    const lane = { id: 'approval-lane', revision: 1 };
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: 'approval-turn',
      revision: 1,
      project_id: project,
      session_id: lane.id,
      state: 'failed',
      input: '',
      kind: 'send',
      delivery: 'delivered',
    });
    const asked = { session_id: lane.id, turn_id: turn.id, tool_call_id: 'shell-call' };
    const quick = { ...asked, tool_call_id: 'quick-call' };
    const shellApproval = { id: 'shell-approval', revision: 1 };
    const quickApproval = { id: 'quick-approval', revision: 1 };
    f.store.event('agent.tool.started', lane, project, { ...asked, name: 'Bash' });
    f.store.event('approval.requested', shellApproval, project, asked);
    now += 180_000;
    const approvedAt = now;
    f.store.event('approval.approved', shellApproval, project, {
      ...asked,
      decided_by: 'local-user',
    });
    now += 2_000;
    f.store.event('approval.resolved', shellApproval, project, asked);
    now += 6_000;
    f.store.event('agent.tool.completed', lane, project, { ...asked, ok: true });
    f.store.event('agent.tool.started', lane, project, quick);
    f.store.event('approval.requested', quickApproval, project, quick);
    now += 60_000;
    f.store.event('approval.approved', quickApproval, project, {
      ...quick,
      decided_by: 'local-user',
    });
    now += 1_000;
    f.store.event('agent.tool.completed', lane, project, { ...quick, ok: true });
    f.store.event('turn.failed', turn, project, {
      error: 'SessionStartError: Protocol transport closed',
    });
    const result = runtimeDiagnostics(ctx, project, from, now);
    const pick = (kind: string) =>
      result.findings
        .filter((finding) => finding.kind === kind)
        .map(({ duration_ms, started_at, error }) => ({ duration_ms, started_at, error }));
    expect(pick('approval')).toEqual([
      { duration_ms: 180_000, started_at: from, error: undefined },
      { duration_ms: 60_000, started_at: approvedAt + 8_000, error: undefined },
    ]);
    expect(pick('slow_tool')).toEqual([
      { duration_ms: 8_000, started_at: approvedAt, error: undefined },
    ]);
    expect(pick('turn_failure')).toEqual([
      {
        duration_ms: undefined,
        started_at: undefined,
        error: 'SessionStartError: Protocol transport closed',
      },
    ]);
  } finally {
    await f.close();
  }
});
