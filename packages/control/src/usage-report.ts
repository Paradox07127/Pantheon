/// <reference lib="esnext.temporal" />
import type { Principal, RoleUsage, Session, SessionRole, SessionTurn } from '@pantheon/domain';
import { sessionRole, type ProjectUsageDaily } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';

function emptyRow(role: SessionRole): RoleUsage {
  return {
    role,
    sessions: 0,
    turns: 0,
    tool_calls: 0,
    input_tokens: 0,
    cached_input_tokens: null,
    output_tokens: 0,
    turn_ms: 0,
    turns_without_usage: 0,
  };
}

function emptyRoleRows() {
  const rows = new Map<SessionRole, RoleUsage>();
  for (const role of ['baseline', 'conductor', 'reviewer', 'spawned', 'story', 'user'] as const)
    rows.set(role, emptyRow(role));
  return rows;
}

const lifecycle =
  "'turn.queued','turn.prepare_started','turn.running','turn.completed','turn.cancelled','turn.failed','session.turn.delivery'";
const agentActivity =
  "'agent.turn.started','agent.turn.completed','agent.usage.updated','agent.tool.started'";

function foldUsage(
  ctx: ControlContext,
  projectId: string,
  rowOf: (role: SessionRole, at?: number) => RoleUsage | undefined,
  period?: { from: number; until: number; clipTurnTime?: boolean },
): void {
  const dates = period ? 'AND created_at >= $from AND created_at < $until' : '';
  const params = { project: projectId, ...(period && { from: period.from, until: period.until }) };
  // A turn spanning both edges has no required event inside the window.
  const carryIn = period?.clipTurnTime
    ? `UNION SELECT id FROM (
        SELECT aggregate_id AS id FROM events INDEXED BY events_diagnostic_window
        WHERE project_id=$project AND kind IN ('turn.completed','turn.cancelled','turn.failed','session.turn.delivery')
          AND created_at >= $until
        UNION ALL
        SELECT id FROM session_turns WHERE json_extract(data,'$.state') IN ('queued','running')
          AND data->>'$.project_id'=$project
      ) AS later WHERE EXISTS (
        SELECT 1 FROM events INDEXED BY events_aggregate WHERE aggregate_id=later.id
          AND project_id=$project AND kind='turn.running' AND created_at<$from
      )`
    : '';
  // Select turns by activity, then recover their timing across both edges of the window.
  const turns = ctx.store
    .statement(
      `
    WITH candidates(id) AS (
      SELECT aggregate_id FROM events INDEXED BY events_diagnostic_window
      WHERE project_id=$project AND kind IN (${lifecycle}) ${dates}
      UNION
      SELECT payload->>'$.turn_id' FROM events INDEXED BY events_diagnostic_window
      WHERE project_id=$project AND kind IN (${agentActivity}) ${dates} AND payload->>'$.turn_id' IS NOT NULL
      ${carryIn}
      ${period ? '' : "UNION SELECT id FROM session_turns WHERE data->>'$.project_id'=$project"}
    )
    SELECT c.id, t.data->>'$.state' AS state,
      coalesce(t.data->>'$.session_id', max(CASE WHEN e.kind IN ('turn.queued','turn.prepare_started') THEN e.payload->>'$.session_id' END)) AS session_id,
      t.data->>'$.usage.input_tokens' AS input, t.data->>'$.usage.cached_input_tokens' AS cached,
      t.data->>'$.usage.output_tokens' AS output, t.data->>'$.usage.tokens_unreported' AS unreported,
      max(CASE WHEN e.kind='turn.queued' THEN e.payload->>'$.kind' END) AS queued_kind,
      min(CASE WHEN e.kind='turn.queued' THEN e.created_at END) AS queued,
      min(CASE WHEN e.kind='turn.running' THEN e.created_at END) AS start,
      max(CASE WHEN e.kind IN ('turn.completed','turn.failed','turn.cancelled') THEN e.created_at END) AS end,
      max(CASE WHEN e.kind='session.turn.delivery' AND e.payload->>'$.delivery'='delivered' THEN e.created_at END) AS delivered,
      max(CASE WHEN e.kind='session.turn.delivery' AND e.payload->>'$.delivery'='failed' THEN e.created_at END) AS failed
    FROM candidates c LEFT JOIN session_turns t ON t.id=c.id
    LEFT JOIN events e INDEXED BY events_aggregate ON e.aggregate_id=c.id AND e.project_id=$project AND e.kind IN (${lifecycle})
    GROUP BY c.id
  `,
    )
    .all(params) as {
    id: string;
    session_id: string | null;
    state: SessionTurn['state'] | null;
    input: number | null;
    cached: number | null;
    output: number | null;
    unreported: number | null;
    queued_kind: SessionTurn['kind'] | null;
    queued: number | null;
    start: number | null;
    end: number | null;
    delivered: number | null;
    failed: number | null;
  }[];
  const toolCalls = ctx.store
    .statement(
      `
    SELECT aggregate_id AS session, ${period ? 'created_at AS at, 1 AS calls' : 'NULL AS at, count(*) AS calls'}
    FROM events INDEXED BY events_diagnostic_window
    WHERE project_id=$project AND kind='agent.tool.started' ${dates}
    ${period ? '' : 'GROUP BY aggregate_id'}
  `,
    )
    .all(params) as { session: string; at: number | null; calls: number }[];

  const sessionIds = new Set(toolCalls.map((call) => call.session));
  for (const turn of turns) {
    if (!turn.session_id) {
      // A helper's queue record names its purpose. Its runtime records name both turn and session.
      const agent = ctx.store
        .statement(
          `
        SELECT aggregate_id, created_at FROM events INDEXED BY events_agent_turn
        WHERE project_id=? AND payload->>'$.turn_id'=? AND kind GLOB 'agent.*'
        ${turn.queued === null ? 'ORDER BY sequence' : ''} LIMIT 1
      `,
        )
        .get(projectId, turn.id) as { aggregate_id: string; created_at: number } | undefined;
      if (agent) {
        turn.session_id = agent.aggregate_id;
        turn.queued ??= agent.created_at;
      }
    }
    if (turn.session_id) sessionIds.add(turn.session_id);
  }

  const roles = new Map<string, { role: SessionRole; deleted: boolean }>();
  const roleKeys = [
    'review_id',
    'baseline',
    'change_story',
    'range_story',
    'conductor',
    'spawned_by',
    'purpose',
  ];
  const sessions = ctx.store
    .statement(
      `
    WITH candidates(id) AS (
      SELECT value FROM json_each($owners)
      UNION SELECT aggregate_id FROM events INDEXED BY events_diagnostic_window
        WHERE project_id=$project AND kind='session.opened' ${dates}
      ${period ? '' : "UNION SELECT id FROM sessions WHERE data->>'$.project_id'=$project"}
    ), metadata AS (
      SELECT c.id, s.id IS NULL AS deleted, e.created_at AS opened, coalesce(s.data,e.payload) AS tags
      FROM candidates c LEFT JOIN sessions s ON s.id=c.id
      LEFT JOIN events e INDEXED BY events_session_role
        ON e.aggregate_id=c.id AND e.kind='session.opened' AND e.project_id=$project
      WHERE s.id IS NOT NULL OR e.sequence IS NOT NULL
    )
    SELECT id, deleted, opened, json_object(${roleKeys.map((k) => `'${k}',tags->'$.${k}'`).join(',')}) AS tags,
      CASE WHEN deleted THEN EXISTS (
        SELECT 1 FROM events WHERE aggregate_id=metadata.id AND kind='session.spawner_notified'
        UNION ALL
        SELECT 1 FROM events WHERE aggregate_id=metadata.id AND kind='session.main_agent_decided'
          AND payload->>'$.action'='spawn'
      ) END AS spawned
    FROM metadata
  `,
    )
    .iterate({ ...params, owners: JSON.stringify([...sessionIds]) }) as Iterable<{
    id: string;
    opened: number | null;
    tags: string;
    spawned: number | null;
    deleted: number;
  }>;
  for (const session of sessions) {
    const tags = JSON.parse(session.tags) as Partial<Session> & { purpose?: string };
    const role =
      tags.purpose === 'baseline'
        ? 'baseline'
        : tags.purpose === 'change_story' || tags.purpose === 'range_story'
          ? 'story'
          : session.spawned
            ? 'spawned'
            : sessionRole(tags);
    roles.set(session.id, { role, deleted: !!session.deleted });
    const row = rowOf(role, session.opened ?? undefined);
    if (row) row.sessions++;
  }
  for (const call of toolCalls) {
    const session = roles.get(call.session);
    const row = session && rowOf(session.role, call.at ?? undefined);
    if (row) row.tool_calls += call.calls;
  }
  for (const turn of turns) {
    const session = turn.session_id && roles.get(turn.session_id);
    if (!session || (turn.state === null && !session.deleted)) continue;
    // Delivery can end a steer without a turn.completed. For a running send it is only a receipt.
    const deliveryEnd = turn.state === 'failed' || session.deleted ? turn.failed : null;
    const delivered =
      turn.state === 'completed' ||
      (session.deleted && turn.queued_kind === 'steer' && turn.start === null)
        ? turn.delivered
        : null;
    const end = turn.end ?? deliveryEnd ?? delivered;
    if (period?.clipTurnTime && turn.start !== null) {
      const start = Math.max(turn.start, period.from);
      const stop = Math.min(end ?? ctx.store.now(), period.until);
      if (stop > start) rowOf(session.role, start)!.turn_ms += stop - start;
    }
    const row = rowOf(session.role, end ?? turn.start ?? turn.queued ?? undefined);
    if (!row) continue;
    row.turns++;
    if (!period?.clipTurnTime && end !== null && turn.start !== null)
      row.turn_ms += end - turn.start;
    if (session.deleted) {
      const reports = ctx.store
        .statement(
          `
        SELECT payload->>'$.input_tokens' AS input, payload->>'$.cached_input_tokens' AS cached,
          payload->>'$.output_tokens' AS output
        FROM events INDEXED BY events_agent_turn WHERE project_id=? AND payload->>'$.turn_id'=? AND
          kind GLOB 'agent.*' AND kind='agent.usage.updated' ORDER BY sequence
      `,
        )
        .iterate(projectId, turn.id) as Iterable<{
        input: number | null;
        cached: number | null;
        output: number | null;
      }>;
      for (const report of reports) {
        turn.input = report.input ?? turn.input;
        turn.cached = report.cached ?? turn.cached;
        turn.output = report.output ?? turn.output;
      }
    }
    if (turn.unreported || (turn.input === null && turn.output === null)) row.turns_without_usage++;
    else {
      row.input_tokens += turn.input ?? 0;
      row.output_tokens += turn.output ?? 0;
      if (turn.cached !== null)
        row.cached_input_tokens = (row.cached_input_tokens ?? 0) + turn.cached;
    }
  }
}

export function projectUsageWindow(
  ctx: ControlContext,
  projectId: string,
  from: number,
  until: number,
): RoleUsage[] {
  const rows = emptyRoleRows();
  foldUsage(
    ctx,
    projectId,
    (role, at) => (at !== undefined && at >= from && at < until ? rows.get(role) : undefined),
    { from, until, clipTurnTime: true },
  );
  return [...rows.values()];
}

export function projectUsageRead(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): RoleUsage[] {
  projectAccess(ctx, principal, projectId, 'project.usage.read');
  ctx.store.must('projects', projectId);
  const rows = new Map<SessionRole, RoleUsage>();
  foldUsage(ctx, projectId, (role) => {
    let row = rows.get(role);
    if (!row) rows.set(role, (row = emptyRow(role)));
    return row;
  });
  return [...rows.values()].sort((a, b) => a.role.localeCompare(b.role));
}

export function projectUsageDaily(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  days: number,
  timezone: string,
): ProjectUsageDaily {
  projectAccess(ctx, principal, projectId, 'project.usage.daily');
  ctx.store.must('projects', projectId);
  const today = Temporal.Instant.fromEpochMilliseconds(ctx.store.now())
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  const first = today.subtract({ days: days - 1 });
  const byDate = new Map<string, Map<SessionRole, RoleUsage>>();
  for (let i = 0; i < days; i++) byDate.set(first.add({ days: i }).toString(), emptyRoleRows());
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  foldUsage(
    ctx,
    projectId,
    (role, at) => (at === undefined ? undefined : byDate.get(calendar.format(at))?.get(role)),
    {
      from: first.toZonedDateTime(timezone).epochMilliseconds,
      until: today.add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
    },
  );
  return { days: [...byDate].map(([date, roles]) => ({ date, roles: [...roles.values()] })) };
}
