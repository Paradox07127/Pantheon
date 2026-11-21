import type {
  Approval,
  Event,
  Session,
  StepRun,
  RuntimeDiagnostics,
  RuntimeFinding,
  RuntimeFindingKind,
  SessionTurn,
  TraceSpan,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { backgroundTasks } from './progress.js';

const SECOND = 1000;
export const RUNTIME_LOOKBACK_MS = 60 * 60 * SECOND;
const REACH_MS = 24 * RUNTIME_LOOKBACK_MS;
const EVENT_LIMIT = 1024;
const DISPLAY_LIMIT = 24;

export const RUNTIME_EVENT_KINDS = [
  'turn.queued',
  'turn.prepare_started',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.turn.delivery',
  'session.gate_started',
  'session.gate_checked',
  'session.gate_run_cancelled',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.resolved',
  'approval.delivered',
  'approval.void',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.context.compacted',
  'agent.background.changed',
  'workflow.step_changed',
] as const;
type Finding = Omit<RuntimeFinding, 'at' | 'id' | 'evidence_ids' | 'evidence'>;
type NativeLane = { lane: { key: string }; spans: TraceSpan[] };

const SLOW_TOOL_MS = 5 * SECOND;
const MIN_MS: Partial<Record<RuntimeFindingKind, number>> = {
  turn_queue: 2 * SECOND,
  turn_prepare: 2 * SECOND,
  approval: 5 * SECOND,
  permission_delivery: 5 * SECOND,
  gate: 10 * SECOND,
  slow_tool: SLOW_TOOL_MS,
  background_task: 30 * SECOND,
  workflow_step: 5 * SECOND,
};
const END_TURN = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);
const pairKey = (a: string, b: string) => JSON.stringify([a, b]);
const payloadOf = (event: Event) => (event.payload ?? {}) as Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const elapsed = (start: number, end: number) => (end > start ? end - start : undefined);
const nonnegativeMs = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function toolCategory(name: unknown, kind?: TraceSpan['kind']): RuntimeFinding['tool_category'] {
  if (kind === 'subagent' || name === 'Agent' || name === 'Task' || name === 'collabAgentToolCall')
    return 'agent';
  if (name === 'write_stdin') return 'poll';
  if (['Bash', 'exec_command', 'commandExecution', 'command'].includes(String(name)))
    return 'shell';
  if (['apply_patch', 'Write', 'Edit', 'fileChange', 'file_change'].includes(String(name)))
    return 'edit';
  if (['Read', 'Grep', 'Glob'].includes(String(name))) return 'read';
  return 'other';
}

export function runtimeDiagnostics(
  ctx: ControlContext,
  projectId: string,
  from: number,
  to: number,
  options: {
    native?: readonly NativeLane[];
    nativeState?: RuntimeDiagnostics['native'];
    limit?: number;
    live?: boolean;
    excludeLanes?: readonly string[];
  } = {},
): RuntimeDiagnostics {
  const live = options.live ?? to >= ctx.store.now();
  const rows = ctx.store.windowEvents(
    projectId,
    RUNTIME_EVENT_KINDS,
    Math.max(0, from - REACH_MS),
    to,
    EVENT_LIMIT + 1,
  );
  const partial = rows.length > EVENT_LIMIT || options.nativeState === 'indexing';
  const events = rows.slice(-EVENT_LIMIT);
  const findings: RuntimeFinding[] = [];
  let pairedApprovals = 0,
    compactionCount = 0;
  const pending = new Map<string, { event: Event; finding: Finding }>();
  const terminalTurns = new Set(
    events.filter((event) => END_TURN.has(event.kind)).map((event) => event.aggregate_id),
  );
  const background = new Map<string, Event>();
  const turns = new Map<string, SessionTurn | undefined>();
  const observerLanes = new Set(options.excludeLanes ?? []);
  const turnOf = (id: string) => {
    if (!turns.has(id)) turns.set(id, ctx.store.get<SessionTurn>('session_turns', id));
    return turns.get(id);
  };
  const inScope = (lane?: string, turnId?: string) =>
    (!lane || !observerLanes.has(lane)) && (!turnId || turnOf(turnId)?.origin !== 'reflection');
  const evidenceById = new Map<string, NonNullable<RuntimeFinding['evidence']>[number]>(
    events.map((event) => [
      event.event_id,
      { source: 'daemon', at: event.created_at, id: event.event_id },
    ]),
  );
  const add = (eventId: string, at: number, finding: Finding, evidence: string[]) => {
    if (at < from || at > to) return;
    if (finding.kind !== 'workflow_step' && !inScope(finding.lane_key, finding.turn_id)) return;
    if (finding.kind === 'approval' && !finding.ongoing) pairedApprovals++;
    if (finding.kind === 'context_compaction') compactionCount++;
    if ((finding.duration_ms ?? 0) < (MIN_MS[finding.kind] ?? 0)) return;
    findings.push({
      ...finding,
      id: JSON.stringify([finding.kind, finding.lane_key, finding.task_id, eventId]),
      at,
      evidence_ids: evidence,
      evidence: evidence
        .map((id) => evidenceById.get(id)!)
        .sort((a, b) => a.at - b.at)
        .slice(0, 20),
    });
  };
  const begin = (key: string, event: Event, finding: Finding) => {
    if (!pending.has(key)) pending.set(key, { event, finding });
  };
  const end = (key: string, event: Event, extra: Partial<Finding> = {}) => {
    const start = pending.get(key);
    pending.delete(key);
    if (!start) return;
    add(
      event.event_id,
      event.created_at,
      {
        ...start.finding,
        ...extra,
        duration_ms: elapsed(start.event.created_at, event.created_at),
        started_at: start.event.created_at,
      },
      [start.event.event_id, event.event_id],
    );
  };

  const nativeTools = new Map<string, { span: TraceSpan; lane: string }>();
  const coveredNative = new Set<string>();
  const nativeCompactions: { span: TraceSpan; lane: string }[] = [];
  const compactions = new Map<string, number[]>();
  for (const { lane, spans } of options.native ?? []) {
    if (observerLanes.has(lane.key)) continue;
    for (const span of spans) {
      const point = span.end ?? span.start;
      if (span.timing === 'native' && point !== null && point >= from && point <= to)
        coveredNative.add(lane.key);
      if (span.kind === 'compact' && span.timing === 'native')
        nativeCompactions.push({ span, lane: lane.key });
      if ((span.kind !== 'tool' && span.kind !== 'subagent') || span.timing !== 'native') continue;
      if (span.start === null && span.end === null) continue;
      const key = pairKey(lane.key, span.id);
      nativeTools.set(key, { span, lane: lane.key });
    }
  }
  let tools_timed = 0,
    tools_untimed = 0;
  const tools = new Map<string, Event>();
  // By lane and tool call: a call's run starts at the user's decision, not while it waits for it.
  const approvedAt = new Map<string, number>();
  const asking = new Set<string>();
  const callKey = (p: Record<string, unknown>) => {
    const lane = text(p.session_id),
      call = text(p.tool_call_id);
    return lane && call ? pairKey(lane, call) : '';
  };
  const toolDone = (lane: string, native: TraceSpan | undefined, event?: Event, start?: Event) => {
    const p = event ? payloadOf(event) : {};
    const at =
      native?.native_interval !== false ? (native?.end ?? event?.created_at) : event?.created_at;
    const turn_id = text(p.turn_id) ?? (start && text(payloadOf(start).turn_id)) ?? native?.turn;
    if (at === undefined || at < from || at > to || !inScope(lane, turn_id)) return;
    const evidence = [start?.event_id, event?.event_id, native?.id].filter(
      (id): id is string => !!id,
    );
    // An explicit zero is a reported measurement, unlike a zero daemon receipt interval.
    const reported = nonnegativeMs(p.duration_ms ?? native?.duration_ms);
    const nativeDuration =
      native?.timing === 'native' &&
      native.native_interval !== false &&
      native.start !== null &&
      native.end !== null
        ? elapsed(native.start, native.end)
        : undefined;
    const daemon = start && event ? elapsed(start.created_at, event.created_at) : undefined;
    const duration_ms = reported ?? nativeDuration ?? daemon;
    const source =
      reported !== undefined
        ? 'runtime_reported'
        : nativeDuration !== undefined
          ? 'native'
          : 'daemon';
    if (event)
      evidenceById.set(event.event_id, {
        source,
        at: event.created_at,
        id: event.event_id,
        ...(duration_ms !== undefined ? { duration_ms } : {}),
      });
    if (native)
      evidenceById.set(native.id, {
        source: reported !== undefined ? 'runtime_reported' : 'native',
        at: native.end ?? native.start!,
        id: native.id,
        ...(duration_ms !== undefined ? { duration_ms } : {}),
      });
    const approved = approvedAt.get(pairKey(lane, text(p.tool_call_id) ?? native?.id ?? ''));
    const afterApproval =
      duration_ms !== undefined && approved !== undefined && approved > at - duration_ms;
    const finding = {
      layer: 'tool',
      source,
      lane_key: lane,
      turn_id,
      duration_ms: afterApproval ? elapsed(approved, at) : duration_ms,
      started_at: afterApproval
        ? approved
        : source === 'native'
          ? (native?.start ?? undefined)
          : source === 'daemon'
            ? start?.created_at
            : undefined,
      tool_category: toolCategory(
        start ? (payloadOf(start).name ?? native?.name) : native?.name,
        native?.kind,
      ),
      ...(native?.parent && native.parent !== native.turn
        ? {
            parent_span_id: native.parent,
            ...(native.name === 'command' ? { parent_inferred: true } : {}),
          }
        : {}),
    } as const;
    if (duration_ms !== undefined) tools_timed++;
    else tools_untimed++;
    if (p.ok === false || native?.status === 'error')
      add(evidence.at(-1)!, at, { ...finding, kind: 'tool_failure' }, evidence);
    else add(evidence.at(-1)!, at, { ...finding, kind: 'slow_tool' }, evidence);
  };

  for (const event of events) {
    const p = payloadOf(event),
      id = event.aggregate_id;
    const base = { source: 'daemon' } as const;
    if (
      event.kind === 'turn.queued' ||
      event.kind === 'turn.prepare_started' ||
      event.kind === 'turn.running' ||
      END_TURN.has(event.kind)
    ) {
      const lane_key = turnOf(id)?.session_id;
      if (!lane_key || !inScope(lane_key, id)) continue;
      if (event.kind === 'turn.queued')
        begin(pairKey('turn', id), event, {
          ...base,
          layer: 'harness',
          kind: 'turn_queue',
          lane_key,
          turn_id: id,
        });
      else if (event.kind === 'turn.prepare_started') {
        end(pairKey('turn', id), event);
        begin(pairKey('prepare', id), event, {
          ...base,
          layer: 'harness',
          kind: 'turn_prepare',
          lane_key,
          turn_id: id,
        });
      } else if (event.kind === 'turn.running') {
        end(pairKey('turn', id), event);
        end(pairKey('prepare', id), event);
      } else {
        end(pairKey('turn', id), event);
        end(pairKey('prepare', id), event);
        if (event.kind === 'turn.failed')
          add(
            event.event_id,
            event.created_at,
            {
              ...base,
              layer: 'runtime',
              kind: 'turn_failure',
              lane_key,
              turn_id: id,
              error: text(p.error),
            },
            [event.event_id],
          );
      }
    } else if (event.kind === 'approval.requested') {
      const lane_key = text(p.session_id);
      if (callKey(p)) asking.add(callKey(p));
      if (lane_key)
        begin(pairKey('approval', id), event, {
          ...base,
          layer: 'human',
          kind: 'approval',
          lane_key,
          turn_id: text(p.turn_id),
        });
    } else if (event.kind === 'approval.approved' || event.kind === 'approval.rejected') {
      const key = pairKey('approval', id);
      const request = pending.get(key);
      // A runtime/session rejection can also use approval.rejected. Its event has no user decision.
      if (request && (p.decided_by || event.causation_id)) {
        asking.delete(callKey(p));
        if (callKey(p)) approvedAt.set(callKey(p), event.created_at);
        end(key, event);
        begin(pairKey('permission_delivery', id), event, {
          ...request.finding,
          layer: 'runtime',
          kind: 'permission_delivery',
        });
      }
    } else if (
      event.kind === 'approval.resolved' ||
      event.kind === 'approval.delivered' ||
      event.kind === 'approval.void'
    ) {
      const key = pairKey('approval', id);
      pending.delete(key);
      asking.delete(callKey(p));
      if (event.kind === 'approval.void') pending.delete(pairKey('permission_delivery', id));
      else end(pairKey('permission_delivery', id), event);
    } else if (event.kind === 'session.gate_started') {
      const key = pairKey('gate', id);
      pending.delete(key);
      begin(key, event, { ...base, layer: 'harness', kind: 'gate', lane_key: id });
    } else if (
      event.kind === 'session.gate_checked' ||
      event.kind === 'session.gate_run_cancelled'
    ) {
      const key = pairKey('gate', id);
      const start = pending.get(key);
      if (start) {
        const recorded = payloadOf(start.event);
        if (
          event.kind === 'session.gate_checked' &&
          recorded.commit === p.commit &&
          recorded.run_id === p.run_id
        )
          end(key, event);
        else if (event.kind === 'session.gate_run_cancelled' && recorded.run_id === p.run_id)
          pending.delete(key);
      }
    } else if (event.kind === 'agent.tool.started' || event.kind === 'agent.tool.completed') {
      const tool = text(p.tool_call_id);
      if (!tool || !inScope(id, text(p.turn_id))) continue;
      const key = pairKey(id, tool);
      if (event.kind === 'agent.tool.started') tools.set(key, event);
      else {
        toolDone(id, nativeTools.get(key)?.span, event, tools.get(key));
        tools.delete(key);
        nativeTools.delete(key);
      }
    } else if (event.kind === 'agent.background.changed') {
      if (inScope(id, text(p.turn_id))) background.set(id, event);
    } else if (event.kind === 'workflow.step_changed') {
      const key = pairKey('step', id);
      if (p.state !== 'running') end(key, event);
      else {
        const step = ctx.store.get<StepRun>('workflow_step_runs', id);
        if (!step) continue;
        begin(key, event, {
          ...base,
          layer: 'harness',
          kind: 'workflow_step',
          lane_key: step.session_id ?? step.lead_session_id,
          task_id: step.task_id,
        });
      }
    } else if (event.kind === 'agent.context.compacted') {
      if (!inScope(id, text(p.turn_id))) continue;
      const times = compactions.get(id) ?? [];
      times.push(event.created_at);
      compactions.set(id, times);
      add(
        event.event_id,
        event.created_at,
        {
          ...base,
          layer: 'runtime',
          kind: 'context_compaction',
          lane_key: id,
          turn_id: text(p.turn_id),
        },
        [event.event_id],
      );
    }
  }

  for (const { lane, span } of nativeCompactions) {
    const at = span.end ?? span.start;
    if (at === null || compactions.get(lane)?.some((time) => Math.abs(time - at) <= 2000)) continue;
    evidenceById.set(span.id, { source: 'native', at, id: span.id });
    add(
      span.id,
      at,
      {
        kind: 'context_compaction',
        layer: 'runtime',
        source: 'native',
        lane_key: lane,
        turn_id: span.turn,
      },
      [span.id],
    );
  }
  for (const { lane, span } of nativeTools.values())
    if (span.status === 'ok' || span.status === 'error') toolDone(lane, span);
  for (const { event, finding } of pending.values()) {
    // Live rows must still be pending in the authoritative entities. A historical unmatched start
    // has no proven outcome and is omitted.
    if (!live) continue;
    const { kind, turn_id } = finding;
    const open =
      ((kind === 'turn_queue' || kind === 'turn_prepare') &&
        !!turn_id &&
        turnOf(turn_id)?.state === 'queued') ||
      (kind === 'approval' &&
        ctx.store.get<Approval>('approvals', event.aggregate_id)?.state === 'pending') ||
      (kind === 'permission_delivery' &&
        (() => {
          const approval = ctx.store.get<Approval>('approvals', event.aggregate_id);
          return (
            (approval?.state === 'approved' || approval?.state === 'rejected') &&
            approval.resolved_at === undefined &&
            approval.reason !== 'session_lost'
          );
        })()) ||
      (kind === 'gate' &&
        (() => {
          const session = ctx.store.get<Session>('sessions', event.aggregate_id);
          return payloadOf(event).run_id
            ? session?.gate_run?.state === 'running' &&
                session.gate_run.id === payloadOf(event).run_id
            : session?.merge?.state === 'running';
        })()) ||
      (kind === 'workflow_step' &&
        ctx.store.get<StepRun>('workflow_step_runs', event.aggregate_id)?.state === 'running');
    if (open)
      add(
        event.event_id,
        to,
        {
          ...finding,
          duration_ms: elapsed(event.created_at, to),
          started_at: event.created_at,
          ongoing: true,
        },
        [event.event_id],
      );
  }
  for (const [key, start] of tools) {
    const turn_id = text(payloadOf(start).turn_id);
    if (
      !live ||
      !turn_id ||
      terminalTurns.has(turn_id) ||
      turnOf(turn_id)?.state !== 'running' ||
      nativeTools.get(key)?.span.end != null ||
      asking.has(key)
    )
      continue;
    const begun = Math.max(start.created_at, approvedAt.get(key) ?? 0);
    add(
      start.event_id,
      to,
      {
        kind: 'slow_tool',
        layer: 'tool',
        source: 'daemon',
        lane_key: start.aggregate_id,
        turn_id,
        duration_ms: elapsed(begun, to),
        started_at: begun,
        tool_category: toolCategory(payloadOf(start).name),
        ongoing: true,
      },
      [start.event_id],
    );
  }
  if (live)
    for (const [lane_key, event] of background) {
      const tasks = backgroundTasks(ctx, lane_key);
      const session = ctx.store.get<Session>('sessions', lane_key);
      if (!session || session.state === 'closed' || session.state === 'reconciling') continue;
      for (const task of tasks)
        add(
          pairKey(event.event_id, task.id),
          to,
          {
            layer: 'tool',
            source: 'daemon',
            kind: 'background_task',
            lane_key,
            duration_ms: elapsed(task.started_at, to),
            ongoing: true,
          },
          [event.event_id],
        );
    }
  findings.sort(
    (a, b) =>
      Number(!!b.ongoing) - Number(!!a.ongoing) ||
      Number(b.kind.endsWith('_failure')) - Number(a.kind.endsWith('_failure')) ||
      (b.duration_ms ?? 0) - (a.duration_ms ?? 0) ||
      b.at - a.at,
  );
  const events_read = events.filter((event) => event.created_at >= from).length;
  return {
    from,
    to,
    events_read,
    slow_tool_ms: SLOW_TOOL_MS,
    coverage: {
      daemon_events: events_read,
      native_lanes: coveredNative.size,
      paired_approvals: pairedApprovals,
      compactions: compactionCount,
    },
    tools_timed,
    tools_untimed,
    partial,
    native: options.nativeState ?? 'unavailable',
    findings: findings.slice(0, options.limit ?? DISPLAY_LIMIT),
  };
}
