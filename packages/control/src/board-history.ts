import {
  canonical,
  type Approval,
  type BoardPlan,
  type Milestone,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type StepRun,
  type Workspace,
} from '@pantheon/domain';
import type { BoardHistory, PendingReplan } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { awaitingChange, boardTaskId, currentBinding, taskGeneration } from './board-plan.js';
import { dayKey, midnight, planTaskState, type MergedPayload } from './board-view.js';
import { dispatchQueue } from './task-dispatch.js';
import { milestoneView } from './project-facts.js';
import { DECISIONS } from './retrospective.js';
import { INBOX_HEADER } from './lead-inbox.js';
import { cachedReady, TURN_ENDS } from './workbench-session.js';
import { triggerText, type ReplanFired } from './replan.js';

/** Every event kind the history reads; agent output, the bulk of the log, is none of them. */
const HISTORY_KINDS = [
  ...DECISIONS,
  ...TURN_ENDS,
  'board.plan_transferred',
  'session.opened',
  'session.closed',
  'session.contract_notified',
  'session.deleted',
  'session.discarded',
  'session.merged',
  'session.gate_checked',
  'session.merge_blocked',
  'session.merge_skipped',
  'turn.queued',
  'turn.running',
  'approval.requested',
  'lead.question_asked',
  'workflow.step_changed',
  'task.dispatched',
  'task.claimed',
  'task.released',
  'task.handed_back',
  'milestone.accepted',
  'board.replan_triggered',
];

export function boardHistory(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): BoardHistory {
  projectAccess(ctx, principal, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  // The project's rows alone; listing the table would read every project's.
  const projectRows = <T>(
    table: 'session_turns' | 'workflow_step_runs' | 'approvals' | 'milestones',
  ) =>
    (
      ctx.store.db
        .prepare(
          `SELECT data FROM ${table} WHERE json_extract(data,'$.project_id')=? ORDER BY rowid`,
        )
        .all(projectId) as { data: string }[]
    ).map((row) => JSON.parse(row.data) as T);
  const events = ctx.store.kindEvents(projectId, HISTORY_KINDS),
    now = ctx.store.now(),
    startedAt = ctx.store.events(0, projectId, 1)[0]!.created_at;
  const transfers = new Map<string, string>();
  for (const event of events)
    if (event.kind === 'board.plan_transferred')
      transfers.set((event.payload as { from: string }).from, event.aggregate_id);
  const owner = (id: string) => {
    while (transfers.has(id)) id = transfers.get(id)!;
    return id;
  };
  const plans = new Map(
    ctx.store
      .list<BoardPlan>('board_plans')
      .filter((plan) => plan.project_id === projectId)
      .map((plan) => [plan.id, plan]),
  );
  const archive = new Map<
      string,
      { plan: BoardPlan; task: BoardPlan['tasks'][number]; created_at: number }
    >(),
    contracts = new Map<string, BoardPlan['tasks'][number]>(),
    completed = new Map<string, number>();
  const snapshots = events
    .filter((event) => event.kind === 'board.plan_updated')
    .map((event) => ({ plan: event.payload as BoardPlan, at: event.created_at }));
  for (const plan of plans.values()) snapshots.push({ plan, at: plan.updated_at });
  for (const { plan, at } of snapshots) {
    const leadId = owner(plan.id);
    for (const task of plan.tasks) {
      const key = boardTaskId(leadId, task.id),
        generation = taskGeneration(plan, task.id);
      archive.set(key, {
        plan: { ...plan, id: leadId },
        task,
        created_at: archive.get(key)?.created_at ?? at,
      });
      contracts.set(`${key}:${generation}`, task);
    }
    for (const [taskId, accepted] of Object.entries(plan.accepted ?? {}))
      completed.set(`${boardTaskId(leadId, taskId)}:${accepted.generation ?? 1}`, accepted.at);
    for (const [taskId, merged] of Object.entries(plan.direct_merged ?? {}))
      completed.set(`${boardTaskId(leadId, taskId)}:${merged.generation}`, merged.at);
  }
  const sessionOf = new Map<string, Session>(),
    turnOf = new Map<string, SessionTurn>();
  for (const event of events) {
    if (event.kind === 'session.opened')
      sessionOf.set(event.aggregate_id, event.payload as Session);
    else if (event.kind === 'turn.queued')
      turnOf.set(event.aggregate_id, event.payload as SessionTurn);
    else if (event.kind === 'turn.running' || TURN_ENDS.includes(event.kind)) {
      const turn = turnOf.get(event.aggregate_id)!;
      turnOf.set(event.aggregate_id, {
        ...turn,
        state: event.kind.slice(5) as SessionTurn['state'],
      });
    } else if (
      event.kind === 'session.closed' ||
      event.kind === 'session.deleted' ||
      event.kind === 'session.discarded' ||
      (event.kind === 'session.merged' && !(event.payload as { direct?: boolean }).direct)
    ) {
      const session = sessionOf.get(event.aggregate_id)!;
      sessionOf.set(event.aggregate_id, {
        ...session,
        state: 'closed',
        ...(event.kind === 'session.merged'
          ? { outcome: 'merged' as const }
          : event.kind === 'session.discarded'
            ? { outcome: 'discarded' as const }
            : {}),
      });
    }
  }
  for (const session of ctx.store.list<Session>('sessions'))
    if (session.project_id === projectId) sessionOf.set(session.id, session);
  for (const turn of projectRows<SessionTurn>('session_turns')) turnOf.set(turn.id, turn);
  const taskSessions = new Map<string, Session[]>(),
    generations = new Map<string, Session[]>(),
    turns = new Map<string, SessionTurn[]>([...sessionOf.keys()].map((id) => [id, []]));
  for (const session of sessionOf.values()) {
    if (!session.task || !session.workspace_id) continue;
    const key = boardTaskId(owner(session.task.lead_session_id), session.task.id),
      generation = `${key}:${session.task.generation ?? 1}`;
    taskSessions.set(key, [...(taskSessions.get(key) ?? []), session]);
    generations.set(generation, [...(generations.get(generation) ?? []), session]);
  }
  for (const turn of turnOf.values()) turns.get(turn.session_id)?.push(turn);
  const days = new Map<string, BoardHistory['days'][number]>();
  // The wall clock can step back, so a time may fall outside the days from the start to now.
  const dayOf = (at: number) => {
    const date = dayKey(at);
    if (!days.has(date))
      days.set(date, { date, merged: 0, handbacks: 0, decisions: 0, failed: 0, waited: 0 });
    return days.get(date)!;
  };
  for (let day = midnight(startedAt); day <= now; day = midnight(day, 1)) dayOf(day);
  const decisions: BoardHistory['decisions'] = [],
    decisionTasks = new Map<string, BoardPlan['tasks'][number]>(),
    stepRuns = new Map(projectRows<StepRun>('workflow_step_runs').map((run) => [run.id, run]));
  const mergedSessions = new Map<string, number>(),
    // By session id, or by `<task key>:<generation>` for a lead's direct merge.
    merges = new Map<string, { at: number; payload: MergedPayload }>(),
    opened = new Map<string, number>(),
    claims = new Map<string, string>(),
    claimGenerations = new Map<string, number>(),
    claimTimes = new Map<string, number[]>(),
    claimants = new Map<string, string>(),
    // By session, the dispatch that opened it; the parts of one dispatch are one attempt.
    dispatches = new Map<string, number>(),
    discardedAt = new Map<string, number>(),
    handbacks = new Map<string, NonNullable<BoardHistory['tasks'][number]['handback_reasons']>>(),
    repairReason = new Map<string, 'gate' | 'other'>(),
    stepHandbacks = new Map<string, 'review' | 'other'>(),
    gateRuns = new Map<string, number>(),
    gatePassedOn = new Map<string, number>(),
    reached = new Map<string, number>(),
    dispatched = new Set<string>(),
    running = new Map<string, number>(),
    allRunning = new Map<string, number>(),
    intervals: { from: number; to: number }[] = [],
    planVersions = new Map<string, { sequence: number; plan: BoardPlan }[]>(),
    // The generation each session worked on as of the event being read.
    sessionGenerations = new Map<string, number>();
  // Fired re-plan conditions no plan change answered yet, by event id; when each session's newest turn began.
  const triggers = new Map<
      string,
      { sequence: number; leadId: string; text: string } & Omit<PendingReplan, 'event_id'>
    >(),
    turnStarted = new Map<string, number>();
  for (const event of events) {
    const p = event.payload as Record<string, unknown>,
      day = dayOf(event.created_at);
    let replan: BoardHistory['decisions'][number]['replan'];
    if (event.kind === 'board.plan_updated') {
      for (const task of (event.payload as BoardPlan).tasks)
        decisionTasks.set(boardTaskId(owner(event.aggregate_id), task.id), task);
      const versions = planVersions.get(owner(event.aggregate_id)) ?? [];
      const explicit = p.trigger_event as string | undefined;
      // Without an explicit event, the lead's own change in a turn begun after the condition fired answers it.
      const own = () =>
        ctx.store.receipt(`session:${event.aggregate_id}:command:${event.causation_id}`) !==
        undefined;
      const answered = [...triggers].filter(
        ([eventId, trigger]) =>
          trigger.leadId === owner(event.aggregate_id) &&
          (explicit
            ? eventId === explicit
            : (turnStarted.get(event.aggregate_id) ?? 0) > trigger.sequence && own()),
      );
      if (answered.length) {
        const before = new Map((versions.at(-1)?.plan.tasks ?? []).map((task) => [task.id, task])),
          after = (event.payload as BoardPlan).tasks;
        replan = {
          triggers: answered.map(([eventId, { sequence, leadId, at, ...trigger }]) => ({
            event_id: eventId,
            ...trigger,
          })),
          added: after.filter((task) => !before.has(task.id)).map((task) => task.title),
          removed: [...before.values()]
            .filter((task) => !after.some((each) => each.id === task.id))
            .map((task) => task.title),
          changed: after
            .filter(
              (task) => before.has(task.id) && canonical(before.get(task.id)) !== canonical(task),
            )
            .map((task) => task.title),
        };
        for (const [eventId] of answered) triggers.delete(eventId);
      }
      versions.push({ sequence: event.sequence, plan: event.payload as BoardPlan });
      planVersions.set(owner(event.aggregate_id), versions);
    }
    // A lead's claim of its direct task starts it without a start request.
    if (DECISIONS.includes(event.kind) || event.kind === 'task.claimed') {
      day.decisions++;
      const leadId = owner(event.aggregate_id),
        taskId =
          event.kind === 'task.start_requested'
            ? (p.task_ids as string[]).length === 1
              ? (p.task_ids as string[])[0]
              : undefined
            : (p.task_id as string | undefined),
        task = taskId
          ? (decisionTasks.get(boardTaskId(leadId, taskId)) ??
            archive.get(boardTaskId(leadId, taskId))?.task)
          : undefined,
        title =
          event.kind === 'board.plan_updated' ? (event.payload as BoardPlan).headline : task?.title;
      if (decisions.length < 2000)
        decisions.push({
          at: event.created_at,
          lane_id: task ? boardTaskId(leadId, task.lane) : null,
          kind:
            event.kind === 'board.plan_updated'
              ? replan
                ? 'replan'
                : 'plan'
              : event.kind === 'task.start_requested' || event.kind === 'task.claimed'
                ? 'start'
                : event.kind === 'task.stop_requested'
                  ? 'stop'
                  : 'accept',
          ...(title ? { title: title.slice(0, 140) } : {}),
          ...(replan ? { replan, lead_session_id: leadId } : {}),
        });
    }
    if (event.kind === 'approval.requested' || event.kind === 'lead.question_asked') day.waited++;
    if (event.kind === 'workflow.step_changed') {
      const run = stepRuns.get(event.aggregate_id)!;
      if (p.state === 'failed')
        stepHandbacks.set(
          boardTaskId(owner(run.lead_session_id), run.task_id),
          run.step.kind.type === 'review' ? 'review' : 'other',
        );
    }
    if (event.kind === 'session.gate_checked') {
      const session = sessionOf.get(event.aggregate_id),
        claim = claims.get(event.aggregate_id),
        // Attempts count per task generation, as in the retrospective.
        key = session?.task
          ? `${boardTaskId(owner(session.task.lead_session_id), session.task.id)}:${sessionGenerations.get(event.aggregate_id) ?? session.task.generation ?? 1}`
          : claim && `${claim}:${claimGenerations.get(event.aggregate_id)}`,
        results = p.results as { exit_code: number | null; timed_out?: boolean; state?: string }[],
        failed = results.some(
          (result) => result.state !== 'skipped' && (result.exit_code !== 0 || result.timed_out),
        );
      repairReason.set(event.aggregate_id, failed ? 'gate' : 'other');
      if (key) {
        const attempt = (gateRuns.get(key) ?? 0) + 1;
        gateRuns.set(key, attempt);
        if (!failed && !gatePassedOn.has(key)) gatePassedOn.set(key, attempt);
      }
    } else if (event.kind === 'session.merge_blocked' || event.kind === 'session.merge_skipped')
      repairReason.set(event.aggregate_id, p.reason === 'gate_failed' ? 'gate' : 'other');
    if (event.kind === 'session.opened') {
      opened.set(event.aggregate_id, event.created_at);
      const task = (p as Partial<Session>).task;
      if (task) sessionGenerations.set(event.aggregate_id, task.generation ?? 1);
    } else if (event.kind === 'task.dispatched') {
      for (const id of (p.session_ids as string[] | undefined) ?? [p.session_id as string]) {
        dispatched.add(id);
        dispatches.set(id, event.sequence);
      }
      const plan = planVersions.get(owner(event.aggregate_id))?.at(-1)?.plan;
      if (plan)
        for (const id of (p.session_ids as string[] | undefined) ?? [p.session_id as string])
          sessionGenerations.set(id, taskGeneration(plan, p.task_id as string));
    } else if (event.kind === 'session.contract_notified') {
      // The session moves to the generation of the plan its delivered notice was taken from.
      const task = sessionOf.get(event.aggregate_id)?.task,
        prepared =
          task &&
          planVersions
            .get(owner(task.lead_session_id))
            ?.findLast((version) => version.sequence <= (p.plan_sequence as number))?.plan;
      if (prepared) {
        const generation = taskGeneration(prepared, task.id);
        if (generation > (sessionGenerations.get(event.aggregate_id) ?? 1))
          sessionGenerations.set(event.aggregate_id, generation);
      }
    } else if (event.kind === 'task.claimed') {
      const key = boardTaskId(owner(event.aggregate_id), p.task_id as string);
      claims.set(event.aggregate_id, key);
      claimants.set(key, event.aggregate_id);
      claimGenerations.set(event.aggregate_id, (p.generation as number | undefined) ?? 1);
      claimTimes.set(key, [...(claimTimes.get(key) ?? []), event.created_at]);
      for (const turnId of allRunning.keys())
        if (turnOf.get(turnId)!.session_id === event.aggregate_id)
          running.set(turnId, event.created_at);
    } else if (event.kind === 'task.released') claims.delete(event.aggregate_id);
    else if (event.kind === 'session.discarded')
      discardedAt.set(event.aggregate_id, event.created_at);
    else if (event.kind === 'milestone.accepted') reached.set(event.aggregate_id, event.created_at);
    else if (event.kind === 'board.replan_triggered') {
      const fired = p as unknown as ReplanFired,
        key = boardTaskId(owner(event.aggregate_id), fired.task_id);
      triggers.set(event.event_id, {
        sequence: event.sequence,
        leadId: owner(event.aggregate_id),
        milestone_id: fired.milestone_id,
        text: triggerText(fired),
        at: event.created_at,
        type: fired.trigger.type,
        ...(fired.value === undefined ? {} : { value: fired.value }),
        task_id: key,
        task_title: (decisionTasks.get(key) ?? archive.get(key)!.task).title,
      });
    } else if (event.kind === 'task.accepted')
      completed.set(
        `${boardTaskId(owner(event.aggregate_id), p.task_id as string)}:${(p.generation as number | undefined) ?? 1}`,
        event.created_at,
      );
    else if (event.kind === 'session.merged') {
      const merge = { at: event.created_at, payload: p as unknown as MergedPayload };
      if (p.direct === true) {
        const generation = `${boardTaskId(owner(event.aggregate_id), p.task_id as string)}:${p.generation as number}`;
        completed.set(generation, event.created_at);
        merges.set(generation, merge);
        claims.delete(event.aggregate_id);
      } else {
        mergedSessions.set(event.aggregate_id, event.created_at);
        merges.set(event.aggregate_id, merge);
      }
    } else if (event.kind === 'task.handed_back') {
      const key = boardTaskId(owner(event.aggregate_id), p.task_id as string),
        reasons = handbacks.get(key) ?? { gate: 0, review: 0, other: 0 };
      reasons[stepHandbacks.get(key) ?? 'review']++;
      stepHandbacks.delete(key);
      handbacks.set(key, reasons);
      day.handbacks++;
    } else if (event.kind === 'turn.queued') {
      const turn = event.payload as SessionTurn,
        session = sessionOf.get(turn.session_id),
        key = session?.task
          ? boardTaskId(owner(session.task.lead_session_id), session.task.id)
          : claims.get(turn.session_id);
      if (key && turn.origin === 'tracker' && !turn.input.startsWith(INBOX_HEADER)) {
        const reasons = handbacks.get(key) ?? { gate: 0, review: 0, other: 0 },
          reason = turn.input.startsWith('[Pantheon] The workflow review “')
            ? 'review'
            : (repairReason.get(turn.session_id) ?? 'other');
        reasons[reason]++;
        stepHandbacks.delete(key);
        handbacks.set(key, reasons);
        day.handbacks++;
      }
    } else if (event.kind === 'turn.running') {
      // A system turn whose row is gone has only its purpose logged, with no id.
      const turn = turnOf.get(event.aggregate_id)!;
      turnStarted.set(turn.session_id, event.sequence);
      allRunning.set(event.aggregate_id, event.created_at);
      if (sessionOf.get(turn.session_id)?.task || claims.has(turn.session_id))
        running.set(event.aggregate_id, event.created_at);
    } else if (TURN_ENDS.includes(event.kind)) {
      const turn = turnOf.get(event.aggregate_id)!,
        session = sessionOf.get(turn.session_id);
      if (event.kind === 'turn.failed' && (session?.task || claims.has(turn.session_id)))
        day.failed++;
      allRunning.delete(event.aggregate_id);
      const from = running.get(event.aggregate_id);
      if (from !== undefined) {
        intervals.push({ from, to: event.created_at });
        running.delete(event.aggregate_id);
      }
    }
    if (event.kind === 'task.released' || (event.kind === 'session.merged' && p.direct === true))
      for (const [turnId, from] of running)
        if (turnOf.get(turnId)!.session_id === event.aggregate_id) {
          intervals.push({ from, to: event.created_at });
          running.delete(turnId);
        }
  }
  for (const from of running.values()) intervals.push({ from, to: now });
  for (const [generation, bound] of generations) {
    const live = bound.filter((session) => session.outcome !== 'discarded');
    if (
      contracts.get(generation)?.done_when === 'report' ||
      !live.length ||
      !live.every((session) => mergedSessions.has(session.id))
    )
      continue;
    // The task is done once its last live part merged or its last other part was discarded.
    completed.set(
      generation,
      Math.max(
        ...live.map((session) => mergedSessions.get(session.id)!),
        ...bound.flatMap((session) =>
          discardedAt.has(session.id) ? [discardedAt.get(session.id)!] : [],
        ),
      ),
    );
  }
  for (const at of completed.values()) dayOf(at).merged++;
  const milestones = projectRows<Milestone>('milestones'),
    milestoneIds = new Map(
      milestones
        .filter((row) => row.owner_session_id)
        .map((row) => [boardTaskId(owner(row.owner_session_id!), row.key!), row.id]),
    ),
    waiting = new Set(
      projectRows<Approval>('approvals')
        .filter((row) => row.kind === 'permission' && row.state === 'pending')
        .map((row) => row.session_id!),
    ),
    queue = new Map(
      dispatchQueue(ctx, projectId).map(({ plan, task, wait }) => [
        boardTaskId(plan.id, task.id),
        wait,
      ]),
    );
  const tasks = [...archive].map(([key, entry]): BoardHistory['tasks'][number] => {
    const plan = plans.get(entry.plan.id),
      current = plan?.tasks.find((task) => task.id === entry.task.id),
      task = current ?? entry.task,
      bound = taskSessions.get(key) ?? [],
      claims = claimTimes.get(key) ?? [],
      starts = [
        ...claims,
        ...bound.flatMap((session) => (opened.has(session.id) ? [opened.get(session.id)!] : [])),
      ],
      active =
        current && plan
          ? bound.filter(
              (session) =>
                currentBinding(plan, session.task!) ||
                (!session.outcome && awaitingChange(plan, session)),
            )
          : [],
      lead = sessionOf.get(entry.plan.id);
    if (
      lead?.direct_task?.id === task.id &&
      lead.direct_task.generation === taskGeneration(plan, task.id)
    )
      active.push(lead);
    const ready = new Map<string, boolean>();
    for (const session of active) {
      const workspace =
        session.workspace_id && ctx.store.get<Workspace>('workspaces', session.workspace_id);
      const known = workspace && cachedReady(ctx, session, workspace, waiting.has(session.id));
      if (typeof known === 'boolean') ready.set(session.id, known);
    }
    const state =
      current && plan
        ? planTaskState(ctx, plan, task, active, waiting, turns, dispatched, queue.get(key), ready)
        : 'removed';
    // A direct task has no worker; its lead's claim names the session that did it.
    const newest =
        bound.findLast((session) => session.outcome !== 'discarded') ??
        (claimants.has(key) ? sessionOf.get(claimants.get(key)!) : undefined),
      model = newest?.reported_model ?? newest?.requested_model,
      reasons = handbacks.get(key),
      generation = `${key}:${taskGeneration(current ? plan : entry.plan, task.id)}`,
      mergedAt =
        state === 'merged' || state === 'removed' ? (completed.get(generation) ?? null) : null,
      landed =
        mergedAt === null
          ? []
          : [
              merges.get(generation),
              ...(generations.get(generation) ?? []).map((session) => merges.get(session.id)),
            ]
              .filter((merge) => merge !== undefined)
              .sort((a, b) => a.at - b.at);
    return {
      id: key,
      owner_session_id: entry.plan.id,
      session_id: (newest ?? bound.at(-1))?.id ?? null,
      title: task.title,
      depends_on: task.depends_on,
      ...(task.task_type ? { task_type: task.task_type } : {}),
      ...(newest?.runtime ? { runtime: newest.runtime } : {}),
      ...(model ? { model } : {}),
      lane_id: boardTaskId(entry.plan.id, task.lane),
      milestone_id: task.milestone
        ? (milestoneIds.get(boardTaskId(entry.plan.id, task.milestone)) ?? null)
        : null,
      state,
      created_at: entry.created_at,
      started_at: starts.length ? Math.min(...starts) : null,
      merged_at: mergedAt,
      commit: landed.at(-1)?.payload.to_sha ?? null,
      additions: landed.length
        ? landed.reduce((sum, merge) => sum + (merge.payload.additions ?? 0), 0)
        : null,
      deletions: landed.length
        ? landed.reduce((sum, merge) => sum + (merge.payload.deletions ?? 0), 0)
        : null,
      attempts:
        new Set(bound.map((session) => dispatches.get(session.id) ?? session.id)).size +
        claims.length,
      handbacks: reasons ? reasons.gate + reasons.review + reasons.other : 0,
      ...(reasons ? { handback_reasons: reasons } : {}),
      ...(gatePassedOn.has(generation)
        ? { gate_passed_on_attempt: gatePassedOn.get(generation)! }
        : {}),
    };
  });
  const idle: BoardHistory['idle'] = [];
  let cursor = startedAt;
  for (const interval of intervals.sort((a, b) => a.from - b.from)) {
    if (interval.from - cursor > 86_400_000) idle.push({ from: cursor, to: interval.from });
    cursor = Math.max(cursor, interval.to);
  }
  if (now - cursor > 86_400_000) idle.push({ from: cursor, to: now });
  return {
    started_at: startedAt,
    tasks: tasks.slice(0, 2000),
    truncated:
      tasks.length > 2000 || [...days.values()].reduce((sum, day) => sum + day.decisions, 0) > 2000,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    decisions,
    ...(triggers.size
      ? {
          pending_replans: [...triggers].map(
            ([eventId, { sequence, leadId, text, ...trigger }]) => ({
              event_id: eventId,
              ...trigger,
            }),
          ),
        }
      : {}),
    idle,
    milestones: milestones.map((row) => {
      const state = row.removed_at ? 'removed' : milestoneView(ctx, row).status;
      return {
        id: row.id,
        title: row.title,
        state,
        // A revised or changed milestone is reached again only by a new acceptance.
        reached_at:
          state === 'completed' || state === 'removed' ? (reached.get(row.id) ?? null) : null,
      };
    }),
  };
}
