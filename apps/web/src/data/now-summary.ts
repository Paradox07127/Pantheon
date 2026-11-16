import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';

export interface EndedSession {
  session_id: string;
  title: string;
  status: BoardTaskStatus;
  ended_at: number;
  ms: number;
}

/** The now view's summary strip; a part is null when the board has nothing for it. */
export interface NowSummaryData {
  /** Sessions that ended today, oldest end first. */
  ended: EndedSession[] | null;
  gate: { first: number; total: number } | null;
  /** Today's tokens per runtime and each one's share of the day's total. */
  usage: { runtime: string; tokens: number; share: number }[] | null;
  /** Merges per local day, oldest first, back at most a week and never before the range starts. */
  merged: { today: number; days: { day: string; count: number }[] } | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const midnight = (at: number, days = 0) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

/** The summary's four parts from one board read; null when none has anything to show. */
export function nowSummary(model: BoardModel): NowSummaryData | null {
  const today = midnight(model.now);
  const isToday = (at: number | null): at is number => at !== null && at >= today;

  const ended = new Map<string, EndedSession>();
  for (const segment of model.tasks.flatMap((task) => task.segments))
    if (segment.session_id && segment.started_at !== null && isToday(segment.ended_at))
      ended.set(segment.session_id, {
        session_id: segment.session_id,
        title: segment.title,
        status: segment.status,
        ended_at: segment.ended_at,
        ms: Math.max(0, segment.ended_at - segment.started_at),
      });

  // Tasks ended today whose gate passed on some attempt; one that never passed is left out, as the
  // board cannot tell a failed gate from one that never ran.
  const gated = model.tasks.filter(
    (task) => isToday(task.ended_at) && task.retrospective?.gate_passed_on_attempt !== undefined,
  );

  const day = dayKey(model.now);
  const tokens = new Map<string, number>();
  for (const row of model.usage)
    if (row.day === day && row.tokens > 0)
      tokens.set(row.runtime, (tokens.get(row.runtime) ?? 0) + row.tokens);
  const total = [...tokens.values()].reduce((sum, n) => sum + n, 0);

  const days: { day: string; count: number }[] = [];
  for (
    let at = Math.max(midnight(model.since), midnight(model.now, -6));
    at <= today;
    at = midnight(at, 1)
  )
    days.push({ day: dayKey(at), count: 0 });
  for (const merge of model.merges) {
    const bucket = days.find((d) => d.day === dayKey(merge.merged_at));
    if (bucket) bucket.count++;
  }

  const summary: NowSummaryData = {
    ended: ended.size ? [...ended.values()].sort((a, b) => a.ended_at - b.ended_at) : null,
    gate: gated.length
      ? {
          first: gated.filter((task) => task.retrospective!.gate_passed_on_attempt === 1).length,
          total: gated.length,
        }
      : null,
    usage: total
      ? [...tokens].map(([runtime, n]) => ({ runtime, tokens: n, share: n / total }))
      : null,
    merged: days.some((d) => d.count) ? { today: days.at(-1)!.count, days } : null,
  };
  return summary.ended || summary.gate || summary.usage || summary.merged ? summary : null;
}
