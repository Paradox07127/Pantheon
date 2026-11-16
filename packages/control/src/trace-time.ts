import type {
  Event,
  TraceSpan,
  TraceTimeAllocation,
  TraceTimeEvidence,
  TraceTimeKind,
  TraceTimeSlice,
} from '@pantheon/domain';

export const TIME_EVENTS = [
  'turn.queued',
  'turn.prepare_started',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'agent.tool.started',
  'agent.tool.completed',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.void',
  'approval.resolved',
  'approval.delivered',
  'session.gate_started',
  'session.gate_checked',
  'session.gate_run_cancelled',
  'session.gate_run_failed',
];

type Kind = Exclude<TraceTimeKind, 'parallel' | 'unknown'>;
type Interval = { start: number; end: number };
type Operation = Interval & { kind: Kind; evidence: TraceTimeEvidence };
type Lane = { lane: { key: string; runtime: string }; turns: TraceSpan[]; spans: TraceSpan[] };

const terminal = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);
const spanKinds = { llm: 'llm', tool: 'tool', subagent: 'subagent', compact: 'compact' } as const;
const SAMPLE_LIMIT = 5;
const payload = (event: Event) => event.payload as Record<string, unknown>;
const string = (value: unknown) => (typeof value === 'string' ? value : undefined);
const operationKey = (lane: string, id: string) => JSON.stringify([lane, id]);

function clip(
  start: number | null,
  end: number | null,
  from: number,
  to: number,
): Interval | undefined {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) return;
  const a = Math.max(start, from),
    b = Math.min(end, to);
  return b > a ? { start: a, end: b } : undefined;
}

function subtract(base: Interval, cuts: Interval[]): Interval[] {
  let cursor = base.start;
  const result: Interval[] = [];
  for (const { start, end } of cuts.sort((a, b) => a.start - b.start)) {
    if (start > cursor) result.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < base.end) result.push({ start: cursor, end: base.end });
  return result;
}

function addSlice(
  slices: Map<TraceTimeKind, TraceTimeSlice>,
  kind: TraceTimeKind,
  ms: number,
  evidence: readonly TraceTimeEvidence[],
) {
  let row = slices.get(kind);
  if (!row) {
    row = { kind, ms: 0, evidence: [] };
    slices.set(kind, row);
  }
  row.ms += ms;
  for (const item of evidence) {
    if (row.evidence.length >= SAMPLE_LIMIT) break;
    if (
      !row.evidence.some(
        (previous) => previous.id === item.id && previous.lane_key === item.lane_key,
      )
    )
      row.evidence.push(item);
  }
  return row;
}

function wallSlices(requests: Interval[], operations: Operation[]) {
  const points: { at: number; add: boolean; operation?: Operation }[] = [];
  for (const { start, end } of requests)
    points.push({ at: start, add: true }, { at: end, add: false });
  for (const operation of operations)
    points.push(
      { at: operation.start, add: true, operation },
      { at: operation.end, add: false, operation },
    );
  points.sort((a, b) => a.at - b.at);
  const slices = new Map<TraceTimeKind, TraceTimeSlice>();
  const active = new Map<Kind, Set<Operation>>();
  const combinations = new Map<string, NonNullable<TraceTimeSlice['concurrent']>[number]>();
  let inRequest = 0;
  let last = points[0]?.at ?? 0;
  for (const { at, add, operation } of points) {
    if (inRequest > 0 && at > last) {
      const kinds = [...active.keys()].sort();
      const kind = kinds.length > 1 ? 'parallel' : (kinds[0] ?? 'unknown');
      const evidence = kinds.flatMap((key) => {
        const first = active.get(key)!.values().next().value;
        return first ? [first.evidence] : [];
      });
      addSlice(slices, kind, at - last, evidence);
      if (kind === 'parallel') {
        const key = kinds.join(',');
        const combination = combinations.get(key);
        if (combination) combination.ms += at - last;
        else combinations.set(key, { kinds, ms: at - last });
      }
    }
    last = at;
    if (!operation) inRequest += add ? 1 : -1;
    else if (add) {
      const set = active.get(operation.kind) ?? new Set();
      set.add(operation);
      active.set(operation.kind, set);
    } else {
      const set = active.get(operation.kind)!;
      set.delete(operation);
      if (!set.size) active.delete(operation.kind);
    }
  }
  const parallel = slices.get('parallel');
  if (parallel)
    parallel.concurrent = [...combinations.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, SAMPLE_LIMIT);
  return [...slices.values()].sort((a, b) => b.ms - a.ms);
}

type EventPair = { start: Event; end?: Event };
type TurnBounds = {
  lane: Lane;
  turn: TraceSpan;
  queue?: Event;
  prepare?: Event;
  running?: Event;
  end?: Event;
  request?: Interval;
};

function eventEvidence(event: Event, lane: string, turn?: string): TraceTimeEvidence {
  return {
    id: event.event_id,
    lane_key: lane,
    turn_id: turn,
    at: event.created_at,
    source: 'daemon',
  };
}

/** Each lane's share of events, in order: allocationOf of one lane reads only these. */
export function laneEvents(lanes: Lane[], events: Event[]): Map<string, Event[]> {
  const byLane = new Map(lanes.map((entry) => [entry.lane.key, [] as Event[]]));
  const owned = (owners: Map<string, Set<Event[]>>, id: string, lane: Event[]) =>
    owners.set(id, (owners.get(id) ?? new Set()).add(lane));
  const turnLanes = new Map<string, Set<Event[]>>();
  for (const entry of lanes)
    for (const turn of entry.turns) owned(turnLanes, turn.id, byLane.get(entry.lane.key)!);
  // An approval belongs to every lane any of its requests names.
  const approvalLanes = new Map<string, Set<Event[]>>();
  for (const event of events) {
    const lane = byLane.get(string(payload(event).session_id) ?? '');
    if (event.kind === 'approval.requested' && lane) owned(approvalLanes, event.aggregate_id, lane);
  }
  for (const event of events) {
    const { kind, aggregate_id: id } = event;
    if (kind.startsWith('turn.')) for (const lane of turnLanes.get(id) ?? []) lane.push(event);
    else if (kind.startsWith('approval.'))
      for (const lane of approvalLanes.get(id) ?? []) lane.push(event);
    else if (kind.startsWith('session.gate_')) byLane.get(id)?.push(event);
  }
  return byLane;
}

export function allocationOf(
  lanes: Lane[],
  events: Event[],
  from: number,
  to: number,
  native: TraceTimeAllocation['native'],
  partial: boolean,
): TraceTimeAllocation {
  const requests: Interval[] = [];
  const operations: Operation[] = [];
  const work = new Map<TraceTimeKind, TraceTimeSlice>();
  const bounds = new Map<string, TurnBounds>();
  const byLane = new Map(lanes.map((entry) => [entry.lane.key, entry]));
  const byTurn = new Map<string, TurnBounds>();
  for (const lane of lanes)
    for (const turn of lane.turns) {
      const item = { lane, turn };
      bounds.set(operationKey(lane.lane.key, turn.id), item);
      if (turn.timing === 'daemon') byTurn.set(turn.id, item);
    }

  const approvals = new Map<string, EventPair & { decision?: Event }>();
  const gates = new Map<string, EventPair>();
  for (const event of events) {
    const { kind, aggregate_id: id } = event;
    const p = payload(event);
    const turn = byTurn.get(id);
    if (turn && kind === 'turn.queued') turn.queue ??= event;
    if (turn && kind === 'turn.prepare_started') turn.prepare ??= event;
    if (turn && kind === 'turn.running') turn.running ??= event;
    if (turn && terminal.has(kind)) turn.end ??= event;
    if (kind === 'approval.requested') approvals.set(id, { start: event });
    const approval = approvals.get(id);
    if (approval) {
      if ((kind === 'approval.approved' || kind === 'approval.rejected') && p.decided_by)
        approval.decision ??= event;
      if (kind === 'approval.void' || kind === 'approval.resolved' || kind === 'approval.delivered')
        approval.end ??= event;
    }
    if (kind.startsWith('session.gate_')) {
      const key = operationKey(id, string(p.run_id) ?? string(p.commit) ?? '');
      if (kind === 'session.gate_started') gates.set(key, { start: event });
      else if (gates.has(key)) gates.get(key)!.end ??= event;
    }
  }

  let turns = 0,
    live = false;
  const turnWindows = new Map<string, TurnBounds[]>();
  for (const item of bounds.values()) {
    const { turn, queue, prepare, running, end, lane } = item;
    if (turn.status === 'running' && turn.end === null && end === undefined) live = true;
    const start = queue?.created_at ?? turn.start ?? prepare?.created_at ?? null;
    const last = end?.created_at ?? turn.end ?? (turn.status === 'running' ? to : null);
    const request = clip(start, last, from, to);
    if (!request) continue;
    item.request = request;
    requests.push(request);
    turns++;
    const windows = turnWindows.get(lane.lane.key) ?? [];
    windows.push(item);
    turnWindows.set(lane.lane.key, windows);
    const phase = queue ?? prepare;
    if (phase) {
      const queuedOrPreparing = clip(
        phase.created_at,
        running?.created_at ?? last,
        request.start,
        request.end,
      );
      if (queuedOrPreparing)
        operations.push({
          ...queuedOrPreparing,
          kind: 'queue',
          evidence: eventEvidence(phase, lane.lane.key, turn.id),
        });
    }
  }

  const approvalCuts = new Map<string, Interval[]>();
  for (const { start, decision, end } of approvals.values()) {
    const lane = string(payload(start).session_id);
    if (!lane || !byLane.has(lane)) continue;
    const turnId = string(payload(start).turn_id);
    const owner = turnId
      ? bounds.get(operationKey(lane, turnId))
      : turnWindows
          .get(lane)
          ?.find(
            (entry) =>
              start.created_at >= (entry.queue?.created_at ?? entry.turn.start ?? Infinity) &&
              start.created_at < (entry.end?.created_at ?? entry.turn.end ?? entry.request!.end),
          );
    if (!owner?.request) continue;
    const { start: a, end: b } = owner.request;
    const observedEnd =
      decision?.created_at ?? end?.created_at ?? (owner.turn.status === 'running' ? b : null);
    const wait = clip(start.created_at, observedEnd, a, b);
    if (wait)
      operations.push({
        ...wait,
        kind: 'approval',
        evidence: eventEvidence(start, lane, owner.turn.id),
      });
    const delivery =
      decision && end && end.kind !== 'approval.void'
        ? clip(decision.created_at, end.created_at, a, b)
        : undefined;
    if (delivery)
      operations.push({
        ...delivery,
        kind: 'delivery',
        evidence: eventEvidence(decision!, lane, owner.turn.id),
      });
    const toolId = string(payload(start).tool_call_id);
    if (toolId) {
      const key = operationKey(lane, toolId);
      approvalCuts.set(key, [
        ...(approvalCuts.get(key) ?? []),
        ...[wait, delivery].flatMap((item) => item ?? []),
      ]);
    }
  }

  let operationCount = 0,
    untimed = 0,
    unplaced = 0;
  for (const entry of lanes) {
    const lane = entry.lane.key;
    const spanOf = new Map(entry.spans.map((span) => [span.id, span]));
    const candidates = new Map<string, Operation>();
    const parents = new Map<string, Interval[]>();
    const durationOnly: { span: TraceSpan; kind: Kind; evidence: TraceTimeEvidence }[] = [];
    for (const span of entry.spans) {
      if (span.kind === 'turn') continue;
      let turn = bounds.get(operationKey(lane, span.turn));
      let ancestor: string | null = span.parent ?? span.turn;
      const visited = new Set<string>();
      while (!turn && ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        const parent = spanOf.get(ancestor);
        if (parent) turn = bounds.get(operationKey(lane, parent.turn));
        ancestor = parent?.parent ?? null;
      }
      if (!turn?.request) continue;
      const request = turn.request;
      const point = span.start === span.end && span.start !== null;
      if (
        (span.start !== null &&
          (span.start > request.end || (!point && span.start === request.end))) ||
        (span.end !== null && (span.end < request.start || (!point && span.end === request.start)))
      )
        continue;
      const kind = spanKinds[span.kind];
      const evidence: TraceTimeEvidence = {
        id: span.id,
        span_id: span.id,
        ...(span.name && { operation: span.name.slice(0, 96) }),
        lane_key: lane,
        turn_id: turn.turn.id,
        at: Math.max(request.start, span.start ?? span.end ?? request.start),
        source: span.timing,
      };
      const interval =
        span.native_interval === false
          ? undefined
          : clip(
              span.start,
              span.end ?? (span.status === 'running' ? request.end : null),
              request.start,
              request.end,
            );
      const isReported = Number.isFinite(span.duration_ms) && span.duration_ms! >= 0;
      if (!interval) {
        if (
          isReported &&
          span.end !== null &&
          span.end > request.start &&
          span.end <= request.end
        ) {
          durationOnly.push({
            span,
            kind,
            evidence: { ...evidence, at: span.end, source: 'runtime_reported' },
          });
        } else {
          operationCount++;
          untimed++;
        }
        continue;
      }
      candidates.set(span.id, { ...interval, kind, evidence });
    }
    for (const { span, kind, evidence } of durationOnly) {
      operationCount++;
      unplaced++;
      // Codex associates inner executions by time. An enclosing measured call can
      // already include an unplaced child's duration; leave it out of the sum.
      const parent = span.parent ? candidates.get(span.parent) : undefined;
      if (
        entry.lane.runtime === 'codex' &&
        parent &&
        parent.evidence.turn_id === evidence.turn_id &&
        evidence.at >= parent.start &&
        evidence.at <= parent.end
      )
        continue;
      addSlice(work, kind, span.duration_ms!, [evidence]);
    }
    for (const [id, interval] of candidates) {
      const span = spanOf.get(id)!;
      // Native subagent turns are containers between the spawning call and their operations.
      const direct = span.parent ? spanOf.get(span.parent) : undefined;
      const parentId = direct?.kind === 'turn' ? direct.parent : span.parent;
      const parent = parentId ? candidates.get(parentId) : undefined;
      if (!parent || interval.evidence.turn_id !== parent.evidence.turn_id) continue;
      const overlap = clip(interval.start, interval.end, parent.start, parent.end);
      if (!overlap) continue;
      const cuts = parents.get(parentId!) ?? [];
      cuts.push(overlap);
      parents.set(parentId!, cuts);
    }
    for (const [id, operation] of candidates) {
      const waits = (approvalCuts.get(operationKey(lane, id)) ?? []).flatMap(
        ({ start, end }) => clip(start, end, operation.start, operation.end) ?? [],
      );
      const pieces = subtract(operation, [...(parents.get(id) ?? []), ...waits]);
      if (pieces.length || !parents.has(id)) operationCount++;
      if (!pieces.length) continue;
      for (const piece of pieces) {
        operations.push({ ...operation, ...piece });
        addSlice(work, operation.kind, piece.end - piece.start, [operation.evidence]);
      }
    }
  }
  let gateMs = 0,
    gateCount = 0;
  for (const { start, end } of gates.values()) {
    if (!byLane.has(start.aggregate_id)) continue;
    const interval = clip(start.created_at, end?.created_at ?? null, from, to);
    if (interval) {
      gateMs += interval.end - interval.start;
      gateCount++;
    }
  }
  const wall = wallSlices(requests, operations);
  const countedWork = [...work.values()].filter(({ ms }) => ms > 0).sort((a, b) => b.ms - a.ms);
  return {
    from,
    to,
    wall_ms: wall.reduce((sum, row) => sum + row.ms, 0),
    wall,
    work_ms: countedWork.reduce((sum, row) => sum + row.ms, 0),
    work: countedWork,
    turns,
    operations: operationCount,
    untimed_operations: untimed,
    unplaced_operations: unplaced,
    gate_ms: gateMs,
    gates: gateCount,
    live,
    partial: partial || native === 'indexing',
    native,
  };
}
