import {
  id,
  requireThat,
  type LandingItem,
  type LandingRecord,
  type Principal,
  type Session,
  type SettingProposal,
} from '@pantheon/domain';
import type {
  LandingStatistics,
  ProjectLandingsCompare,
  ProjectLandingsRead,
  querySchemas,
} from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { gateFailed } from './landing.js';
import { SETTING_PROPOSALS } from './needs-you-settings.js';

export const gateRunPassed = (results: NonNullable<LandingItem['gate_results']>) =>
  !results.some(gateFailed);

// The event cursor at the record's end separates attempts that end and start in one millisecond.
export const recordEndSequence = "r.data->>'$.end_sequence'";

export function insertLandingRecord(ctx: ControlContext, record: LandingRecord) {
  ctx.store.insert('landing_records', {
    ...record,
    first_gate_passed: record.gate_runs ? record.first_gate_passed : null,
    end_sequence: ctx.store.cursor(),
  });
}

/** Called in the receipt transaction, before session.merged starts the next interval. */
export function recordSessionLanding(
  ctx: ControlContext,
  session: Session,
  state: LandingRecord['state'],
  reason: string | null,
  landedSha: string | null = null,
) {
  const ended_at = ctx.store.now();
  const { cutoff } = ctx.store
    .statement(
      `SELECT max(
        coalesce((SELECT ${recordEndSequence} FROM landing_records r
          WHERE r.data->>'$.project_id'=? AND r.data->>'$.session_id'=?
          ORDER BY r.rowid DESC LIMIT 1), 0),
        coalesce((SELECT max(sequence) FROM events
          WHERE aggregate_id=? AND kind='session.merged'), 0)
      ) AS cutoff`,
    )
    .get(session.project_id, session.id, session.id) as { cutoff: number };
  const gates = ctx.store
    .statement(
      `
    SELECT kind, payload->'$.results' AS results FROM events
    WHERE aggregate_id=? AND kind IN ('session.gate_started', 'session.gate_checked')
      AND sequence > ?
    ORDER BY sequence
  `,
    )
    .all(session.id, cutoff);
  let gate_runs = 0,
    first_gate_passed = false,
    running = false;
  for (const gate of gates) {
    if (gate.kind === 'session.gate_started') {
      gate_runs++;
      running = true;
    } else {
      if (!running) gate_runs++;
      if (gate_runs === 1) first_gate_passed = gateRunPassed(JSON.parse(gate.results as string));
      running = false;
    }
  }
  const reviews = ctx.store
    .statement(
      `SELECT count(*) AS rounds FROM reviews r
        WHERE json_extract(r.data,'$.project_id')=? AND r.data->>'$.session_id'=?
        AND (?=0 OR EXISTS (SELECT 1 FROM events WHERE aggregate_id=r.id
          AND kind='review.requested' AND sequence>?))`,
    )
    .get(session.project_id, session.id, cutoff, cutoff);
  const usage = ctx.store
    .statement(
      `
    SELECT count(*) AS turns,
      coalesce(sum(data->>'$.usage.input_tokens'), 0) AS input_tokens,
      coalesce(sum(data->>'$.usage.output_tokens'), 0) AS output_tokens,
      min(e.created_at) AS first_turn
    FROM session_turns t JOIN events e ON e.aggregate_id=t.id AND e.kind='turn.queued'
    WHERE t.data->>'$.project_id'=? AND t.data->>'$.session_id'=? AND e.sequence>?
  `,
    )
    .get(session.project_id, session.id, cutoff) as {
    turns: number;
    input_tokens: number;
    output_tokens: number;
    first_turn: number | null;
  };
  insertLandingRecord(ctx, {
    id: id(),
    revision: 1,
    project_id: session.project_id,
    session_id: session.id,
    state,
    reason,
    ended_at,
    landed_sha: landedSha,
    gate_runs,
    first_gate_passed,
    review_rounds: Number(reviews!.rounds),
    turns: usage.turns,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    wall_ms: usage.first_turn === null ? null : ended_at - usage.first_turn,
  });
}

type ReadInput = ReturnType<(typeof querySchemas)['project.landings.read']['parse']>;

export function landingRecords(
  ctx: ControlContext,
  { project_id, from, to, limit }: ReadInput,
  oldestFirst = false,
): LandingRecord[] {
  const bounds: number[] = [];
  let where = "data->>'$.project_id'=?";
  if (from !== undefined) {
    where += " AND data->>'$.ended_at'>=?";
    bounds.push(from);
  }
  if (to !== undefined) {
    where += " AND data->>'$.ended_at'<=?";
    bounds.push(to);
  }
  const order = oldestFirst ? 'ASC' : 'DESC';
  const rows = ctx.store
    .statement(
      `SELECT json_remove(data,'$.end_sequence') AS data FROM landing_records WHERE ${where}
    ORDER BY data->>'$.ended_at' ${order}, rowid ${order} LIMIT ?`,
    )
    .all(project_id, ...bounds, limit ?? -1);
  return rows.map((row) => JSON.parse(row.data as string) as LandingRecord);
}

export function projectLandingsRead(
  ctx: ControlContext,
  p: Principal,
  input: ReadInput,
): ProjectLandingsRead {
  projectAccess(ctx, p, input.project_id, 'project.read');
  ctx.store.must('projects', input.project_id);
  return { landings: landingRecords(ctx, input) };
}

export function landingStatistics(landings: LandingRecord[]): LandingStatistics {
  const count = landings.length;
  const mean = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const gated = landings.filter((r) => r.gate_runs > 0);
  const rounds = landings.map((r) => r.review_rounds).filter((value) => value !== null);
  const walls = landings
    .flatMap((r) => (r.wall_ms === null ? [] : [r.wall_ms]))
    .sort((a, b) => a - b);
  const ended = (state: LandingRecord['state']) => landings.filter((r) => r.state === state).length;
  return {
    count,
    landed: ended('landed'),
    blocked: ended('blocked'),
    no_changes: ended('no_changes'),
    first_gate_pass_rate: gated.length
      ? gated.filter((r) => r.first_gate_passed).length / gated.length
      : null,
    mean_review_rounds: mean(rounds),
    median_wall_ms: walls.length
      ? (walls[Math.floor((walls.length - 1) / 2)]! + walls[Math.floor(walls.length / 2)]!) / 2
      : null,
    mean_tokens: mean(landings.map((r) => r.input_tokens + r.output_tokens)),
  };
}

export function projectLandingsCompare(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  proposalId: string,
  count: number,
): ProjectLandingsCompare {
  projectAccess(ctx, p, projectId, 'project.read');
  const proposal = ctx.store.get<SettingProposal>(SETTING_PROPOSALS, proposalId);
  requireThat(
    proposal?.project_id === projectId,
    'not_found',
    'No such setting proposal in this project',
  );
  requireThat(
    proposal.state === 'approved',
    'invalid_state',
    'The setting proposal was not approved',
  );
  const approval = proposal.decided_at!;
  return {
    before: landingStatistics(
      landingRecords(ctx, { project_id: projectId, to: approval - 1, limit: count }),
    ),
    after: landingStatistics(
      landingRecords(ctx, { project_id: projectId, from: approval + 1, limit: count }, true),
    ),
  };
}
