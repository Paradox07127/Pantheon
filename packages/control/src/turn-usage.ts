import type { ControlContext } from './context.js';

/** One ended turn's input tokens and when it ended; a turn whose tokens went unreported counts 0. */
export interface TurnInputTokens {
  input_tokens: number;
  ended_at: number;
}

/**
 * The input tokens of the project's turns that ended after `since` (and before `until`, when given),
 * oldest first. A running turn counts once it ends; its usage then holds the whole turn.
 */
export function turnInputTokens(
  ctx: ControlContext,
  query: { project_id: string; session_ids?: string[]; since: number; until?: number },
): TurnInputTokens[] {
  const params: (string | number)[] = [query.project_id, query.since];
  let filter = '';
  if (query.until !== undefined) {
    filter += ' AND e.created_at<?';
    params.push(query.until);
  }
  if (query.session_ids) {
    filter += ` AND t.data->>'$.session_id' IN (${query.session_ids.map(() => '?').join(',')})`;
    params.push(...query.session_ids);
  }
  const rows = ctx.store.db
    .prepare(
      `SELECT json_extract(t.data,'$.usage.input_tokens') AS input_tokens, json_extract(t.data,'$.usage.tokens_unreported') AS unreported, min(e.created_at) AS ended_at FROM events e JOIN session_turns t ON t.id=e.aggregate_id WHERE e.project_id=? AND e.kind IN ('turn.completed','turn.failed','turn.cancelled') AND e.created_at>?${filter} GROUP BY t.id ORDER BY ended_at`,
    )
    .all(...params) as {
    input_tokens: number | null;
    unreported: number | null;
    ended_at: number;
  }[];
  return rows.map((row) => ({
    input_tokens: row.unreported ? 0 : (row.input_tokens ?? 0),
    ended_at: row.ended_at,
  }));
}
