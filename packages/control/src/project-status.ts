import { requireThat, type Approval, type Principal } from '@pantheon/domain';
import { USER_PRINCIPAL_ID, type ProjectStatusRead, type querySchemas } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { landingRecords, landingStatistics } from './project-landings.js';
import { projectUsageWindow } from './usage-report.js';

type StatusWindow = ReturnType<(typeof querySchemas)['project.status.read']['parse']>;

function userWaits(ctx: ControlContext, window: StatusWindow): ProjectStatusRead['waiting'] {
  const waits = ctx.store
    .statement(
      `
      WITH waits AS (
        SELECT request.aggregate_id AS id, request.payload->>'$.session_id' AS session_id,
          request.payload->>'$.kind' AS kind, request.created_at AS start, terminal.created_at AS end
        FROM events request INDEXED BY events_diagnostic_window
        LEFT JOIN events terminal ON terminal.sequence=(
          SELECT sequence FROM events INDEXED BY events_aggregate
          WHERE aggregate_id=request.aggregate_id AND project_id=$project_id
            AND kind IN ('approval.approved','approval.rejected','approval.void','approval.resolved')
            -- A refused answer reopens the request for another decision.
            AND sequence>coalesce((
              SELECT max(sequence) FROM events INDEXED BY events_aggregate
              WHERE aggregate_id=request.aggregate_id AND project_id=$project_id AND kind='approval.refused'
            ),request.sequence)
          ORDER BY sequence LIMIT 1
        )
        WHERE request.project_id=$project_id AND request.kind='approval.requested'
          AND request.created_at<$live_end
          AND ((terminal.sequence IS NULL AND request.payload->>'$.decider'='user')
            OR (terminal.kind IN ('approval.approved','approval.rejected')
              AND terminal.payload->>'$.decided_by'=$user))
      ), clipped AS (
        SELECT id, session_id, kind, end IS NULL OR end>$to AS open,
          min(coalesce(end,$live_end),$to) - max(start,$from) AS wait_ms
        FROM waits
      )
      SELECT session_id, kind, open, wait_ms, count(*) OVER () AS count,
        sum(wait_ms) OVER () AS total_ms FROM clipped WHERE wait_ms>0
      ORDER BY wait_ms DESC, id LIMIT 5
    `,
    )
    .all({
      ...window,
      live_end: Math.min(window.to, ctx.store.now()),
      user: USER_PRINCIPAL_ID,
    }) as {
    session_id: string | null;
    kind: Approval['kind'];
    open: number;
    wait_ms: number;
    count: number;
    total_ms: number;
  }[];
  return {
    count: waits[0]?.count ?? 0,
    total_ms: waits[0]?.total_ms ?? 0,
    longest: waits.map(({ session_id, kind, open, wait_ms }) => ({
      session_id,
      kind,
      open: !!open,
      wait_ms,
    })),
  };
}

function gateTime(ctx: ControlContext, window: StatusWindow): number {
  const boundaries = `'session.gate_started','session.gate_checked','session.gate_run_cancelled',
    'session.gate_run_failed','session.merge_cancelled','session.merge_blocked'`;
  // Only the last boundary before the window can carry a session gate into it.
  // Older gate verdicts have only step durations. Anchor those durations to the verdict.
  const row = ctx.store
    .statement(
      `
      WITH boundaries AS (
        SELECT aggregate_id, max(sequence) AS sequence, kind, $from AS at
        FROM events INDEXED BY events_diagnostic_window
        WHERE project_id=$project_id AND kind IN (${boundaries}) AND created_at<$from
        GROUP BY aggregate_id HAVING kind='session.gate_started'
        UNION ALL
        SELECT aggregate_id, sequence, kind, created_at AS at
        FROM events INDEXED BY events_diagnostic_window
        WHERE project_id=$project_id AND kind IN (${boundaries}) AND created_at BETWEEN $from AND $to
      ), session_intervals AS (
        SELECT kind, at, lead(at,1,$live_end) OVER (PARTITION BY aggregate_id ORDER BY sequence) AS end
        FROM boundaries
      ), intervals AS (
        SELECT at AS start, end FROM session_intervals WHERE kind='session.gate_started'
        UNION ALL
        SELECT e.created_at - (SELECT sum(value->>'$.duration_ms') FROM json_each(e.payload,'$.results')),
          e.created_at FROM events e INDEXED BY events_diagnostic_window
        WHERE e.project_id=$project_id AND e.kind='session.gate_checked' AND e.created_at>$from
          AND (SELECT kind FROM events INDEXED BY events_aggregate WHERE aggregate_id=e.aggregate_id
            AND project_id=$project_id AND sequence<e.sequence AND kind IN (${boundaries}) ORDER BY sequence DESC LIMIT 1) IS NOT 'session.gate_started'
        UNION ALL
        SELECT coalesce(data->>'$.gate_started_at', data->>'$.finished_at' -
            (SELECT sum(value->>'$.duration_ms') FROM json_each(data,'$.gate_results'))) AS start,
          coalesce(data->>'$.gate_finished_at',data->>'$.finished_at',$live_end) AS end
        FROM landings WHERE data->>'$.project_id'=$project_id
          AND coalesce(data->>'$.gate_finished_at',data->>'$.finished_at',$live_end)>$from
      )
      SELECT coalesce(sum(min(end,$to)-max(start,$from)),0) AS gate_ms
      FROM intervals WHERE min(end,$to)>max(start,$from)
    `,
    )
    .get({ ...window, live_end: Math.min(window.to, ctx.store.now()) }) as { gate_ms: number };
  return row.gate_ms;
}

export function projectStatusRead(
  ctx: ControlContext,
  principal: Principal,
  window: StatusWindow,
): ProjectStatusRead {
  const { project_id, from, to } = window;
  projectAccess(ctx, principal, project_id, 'project.read');
  ctx.store.must('projects', project_id);
  requireThat(to > from, 'invalid_input', 'to must be after from');
  requireThat(to - from <= 92 * 86400000, 'invalid_input', 'The window cannot exceed 92 days');

  const records = landingRecords(ctx, { project_id, from, to: to - 1 });
  const { first_gate_pass_rate, mean_review_rounds, median_wall_ms } = landingStatistics(records);
  const roles = projectUsageWindow(ctx, project_id, from, to);
  return {
    landings: {
      records,
      landed: records.filter((r) => r.state === 'landed').length,
      blocked: records.filter((r) => r.state === 'blocked').length,
      no_changes: records.filter((r) => r.state === 'no_changes').length,
      first_gate_pass_rate,
      mean_review_rounds,
      median_wall_ms,
    },
    waiting: userWaits(ctx, window),
    time: {
      roles: roles.map(({ role, turn_ms }) => ({ role, turn_ms })),
      gate_ms: gateTime(ctx, window),
      review_ms: roles.find((row) => row.role === 'reviewer')!.turn_ms,
    },
    usage: roles.map(({ role, turns, input_tokens, cached_input_tokens, output_tokens }) => ({
      role,
      turns,
      input_tokens,
      cached_input_tokens,
      output_tokens,
    })),
  };
}
