import type { LandingRecord } from '@pantheon/domain';
import type { PlanRevision } from '@pantheon/protocol';
import { BREAK_SHARE, timeAxis } from '../../lib/time-axis';

/** Quiet stretches shorter than this stay on the axis at their length. */
const QUIET_MS = 6 * 3_600_000;
/** The axis share each revision and landing keeps around itself before quiet stretches fold. */
const EVENT_SHARE = 0.02;
/** Milestones brought in closer than this share of the axis are named on one label. */
const MILESTONE_GAP = 0.05;

type SpanEnd = { at: number; kind: 'removed' | 'dropped' };

export interface TimelineRow {
  id: string;
  /** Its title in the newest revision that has it. */
  title: string;
  /** Each stretch it was in the plan and not dropped, oldest first; x1 and x2 are axis shares. */
  spans: { added: number; ended: SpanEnd | null; x1: number; x2: number }[];
  /** How its last span ended; null while it is in the plan. */
  ended: SpanEnd | null;
  landings: { at: number; x: number; state: LandingRecord['state'] }[];
}

export interface PlanTimeline {
  rows: TimelineRow[];
  /** A line where milestones first appear, with their newest titles. */
  milestones: { revision: number; at: number; x: number; titles: string[] }[];
  /** Revisions that removed or moved items; titles as the revision before had them. */
  replans: {
    revision: number;
    at: number;
    x: number;
    removed: string[];
    moved: { title: string; from: string | null; to: string | null }[];
  }[];
  /** Folded quiet stretches, as shares of the axis. */
  breaks: { x: number; width: number }[];
  /** The axis start, the end of each fold and the axis end. */
  ticks: { at: number; x: number }[];
}

/** Milestone names, close ones joined on one label at the first one's place. */
export function milestoneLabels(milestones: PlanTimeline['milestones']) {
  const labels: { x: number; titles: string[] }[] = [];
  for (const m of milestones) {
    const last = labels.at(-1);
    if (last && m.x - last.x < MILESTONE_GAP) last.titles.push(...m.titles);
    else labels.push({ x: m.x, titles: [...m.titles] });
  }
  return labels;
}

/**
 * The plan over time: a row per item from the revision that added it to the one that removed or
 * dropped it, a mark per landing of a session the item named in the revision in force when it
 * ended, and the revisions that brought milestones in or replanned. The axis runs from the first
 * revision to `now`.
 */
export function planTimeline(
  revisions: readonly PlanRevision[],
  landings: readonly LandingRecord[],
  now: number,
): PlanTimeline {
  const ordered = [...revisions]
    .map((revision) => ({ revision, at: Date.parse(revision.updated_at) }))
    .sort((a, b) => a.revision.revision - b.revision.revision);
  if (!ordered.length) return { rows: [], milestones: [], replans: [], breaks: [], ticks: [] };
  const from = ordered[0]!.at;
  const counted = landings.filter(
    (landing): landing is LandingRecord & { session_id: string } =>
      !!landing.session_id && landing.ended_at >= from,
  );
  const to = Math.max(
    now,
    ...ordered.map((each) => each.at),
    ...counted.map((landing) => landing.ended_at),
  );
  const pad = (to - from) * EVENT_SHARE;
  const busy = [...ordered.map((each) => each.at), ...counted.map((l) => l.ended_at), to].map(
    (at): [number, number] => [at - pad, at + pad],
  );
  const axis = timeAxis(busy, from, to, QUIET_MS);
  const x = (at: number) => Math.min(1, Math.max(0, axis.position(at)));

  type Row = Omit<TimelineRow, 'spans' | 'ended'> & {
    spans: { added: number; ended: SpanEnd | null }[];
  };
  const rows = new Map<string, Row>();
  const milestoneTitles = new Map<string, string>();
  const milestones: PlanTimeline['milestones'] = [];
  const replans: PlanTimeline['replans'] = [];
  let before: PlanRevision | null = null;
  for (const { revision, at } of ordered) {
    const fresh = revision.milestones.filter((m) => !milestoneTitles.has(m.id)).map((m) => m.id);
    for (const m of revision.milestones) milestoneTitles.set(m.id, m.title);
    if (fresh.length) milestones.push({ revision: revision.revision, at, x: x(at), titles: fresh });
    const present = new Set<string>();
    for (const item of revision.items) {
      present.add(item.id);
      const row = rows.get(item.id);
      if (!row) {
        rows.set(item.id, {
          id: item.id,
          title: item.title,
          spans: [{ added: at, ended: item.dropped ? { at, kind: 'dropped' } : null }],
          landings: [],
        });
        continue;
      }
      row.title = item.title;
      const last = row.spans.at(-1)!;
      if (item.dropped) last.ended ??= { at, kind: 'dropped' };
      else if (last.ended) row.spans.push({ added: at, ended: null });
    }
    for (const row of rows.values())
      if (!present.has(row.id)) row.spans.at(-1)!.ended ??= { at, kind: 'removed' };
    if (revision.replan) {
      const earlier = new Map(before?.items.map((item) => [item.id, item.title]));
      const titleIn = (milestones: PlanRevision['milestones'] | undefined, id: string | null) =>
        id === null ? null : (milestones?.find((m) => m.id === id)?.title ?? id);
      replans.push({
        revision: revision.revision,
        at,
        x: x(at),
        removed: revision.changes.removed.map((id) => earlier.get(id) ?? id),
        moved: revision.changes.moved.map((move) => ({
          title: revision.items.find((item) => item.id === move.id)?.title ?? move.id,
          from: titleIn(before?.milestones, move.from),
          to: titleIn(revision.milestones, move.to),
        })),
      });
    }
    before = revision;
  }
  for (const landing of counted) {
    const inForce = ordered.findLast((each) => each.at <= landing.ended_at)!.revision;
    for (const item of inForce.items)
      if (item.session_ids?.includes(landing.session_id))
        rows.get(item.id)!.landings.push({
          at: landing.ended_at,
          x: x(landing.ended_at),
          state: landing.state,
        });
  }

  return {
    rows: [...rows.values()].map((row) => ({
      ...row,
      spans: row.spans.map((span) => ({
        ...span,
        x1: x(span.added),
        x2: x(span.ended?.at ?? to),
      })),
      ended: row.spans.at(-1)!.ended,
      landings: row.landings.sort((a, b) => a.at - b.at),
    })),
    milestones: milestones.map((m) => ({
      ...m,
      titles: m.titles.map((id) => milestoneTitles.get(id)!),
    })),
    replans,
    breaks: axis.breaks.map((b) => ({ x: b.at, width: BREAK_SHARE })),
    ticks: [
      { at: from, x: 0 },
      ...axis.breaks.map((b) => ({ at: axis.time(b.at + BREAK_SHARE), x: b.at + BREAK_SHARE })),
      { at: to, x: 1 },
    ],
  };
}
