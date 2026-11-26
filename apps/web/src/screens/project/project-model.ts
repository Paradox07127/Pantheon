import type {
  PlanItemView,
  ProjectPlanView,
  ProjectSummary,
  WorkbenchSession,
} from '@pantheon/protocol';
import type { GlyphName } from '../../components/SessionStateIcon';
import { changeSessionId } from '../../data/changes';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { STATUS_GLYPH } from '../changes/ChangesScreen';
import { spawnedOf } from '../sessions/RunMap';

// A listed session in one of these states no longer takes messages.
const CLOSED: readonly WorkbenchSession['state'][] = ['failed', 'merged', 'discarded', 'done'];

/** The project's main agent: of its open, unarchived main agents, the one active last; null when none. */
export function mainAgent(sessions: readonly WorkbenchSession[] | null): WorkbenchSession | null {
  let best: WorkbenchSession | null = null;
  for (const s of sessions ?? []) {
    if (!s.conductor || s.archived_at || CLOSED.includes(s.state)) continue;
    if (!best || Date.parse(s.last_activity_at) > Date.parse(best.last_activity_at)) best = s;
  }
  return best;
}

/** The agent list: the main agent, then the sessions it spawned. */
export const agentRows = (
  main: WorkbenchSession,
  sessions: readonly WorkbenchSession[] | null,
): readonly WorkbenchSession[] => [main, ...spawnedOf(main, sessions)];

// A steer turn is not last_turn; a session in these states holds a queued or running turn.
const TAKING: readonly WorkbenchSession['state'][] = ['starting', 'running', 'waiting'];

/** How many of the sessions hold a queued or running turn, as the spawned-session limit counts them. */
export const takingTurns = (sessions: readonly WorkbenchSession[]): number =>
  sessions.filter(
    (s) =>
      TAKING.includes(s.state) ||
      s.last_turn?.state === 'queued' ||
      s.last_turn?.state === 'running',
  ).length;

export interface StatusCount {
  key: 'running' | 'waiting' | 'ready' | 'failed' | 'today';
  label: string;
  /** null until the summary is read. */
  count: number | null;
  /** How long the oldest item has waited, in ms; only on waiting, while something waits. */
  longest?: number;
}

/** The status head's counts, in order, from the project's summary. */
export function statusCounts(summary: ProjectSummary | undefined): StatusCount[] {
  const counts = summary?.counts;
  return [
    {
      key: 'running',
      label: t({ id: 'project.status.running', defaultMessage: 'Running' }),
      count: counts?.running ?? null,
    },
    {
      key: 'waiting',
      label: t({ id: 'project.status.waiting', defaultMessage: 'Waiting for you' }),
      count: summary ? summary.needs_you : null,
      ...(summary?.waiting ? { longest: summary.waiting.longest_wait_ms } : {}),
    },
    {
      key: 'ready',
      label: t({ id: 'project.status.ready', defaultMessage: 'Can land' }),
      count: counts?.ready ?? null,
    },
    {
      key: 'failed',
      label: t({ id: 'project.status.failed', defaultMessage: 'Failed' }),
      count: counts?.failed ?? null,
    },
    {
      key: 'today',
      label: t({ id: 'project.status.landedToday', defaultMessage: 'Landed today' }),
      count: summary ? summary.merged_today : null,
    },
  ];
}

/** A commit's short form. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

type Plan = NonNullable<ProjectPlanView['plan']>;

/** A plan item the list shows: one the main agent did not drop. */
export type ShownPlanItem = PlanItemView & { stage: Exclude<PlanItemView['stage'], 'dropped'> };

export interface PlanGroup {
  /** null for the items outside every milestone. */
  id: string | null;
  title: string;
  items: ShownPlanItem[];
}

/** The items by milestone in the plan's order, the items outside every milestone last; dropped items and empty groups are left out. */
export function planGroups(plan: Plan): PlanGroup[] {
  const shown = plan.items.filter((item): item is ShownPlanItem => !item.dropped);
  const known = new Set(plan.milestones.map((m) => m.id));
  return [
    ...plan.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      items: shown.filter((item) => item.milestone === m.id),
    })),
    {
      id: null,
      title: t({ id: 'project.plan.other', defaultMessage: 'Other' }),
      items: shown.filter((item) => !item.milestone || !known.has(item.milestone)),
    },
  ].filter((group) => group.items.length > 0);
}

export type PlanBucket = 'landed' | 'active' | 'needs_you' | 'failed' | 'not_started' | 'abandoned';

const BUCKETS: readonly PlanBucket[] = [
  'landed',
  'active',
  'needs_you',
  'failed',
  'not_started',
  'abandoned',
];

const BUCKET_TEXT: Record<PlanBucket, (count: number) => string> = {
  landed: (count) =>
    t({ id: 'project.plan.count.landed', defaultMessage: '{count} landed' }, { count }),
  active: (count) =>
    t({ id: 'project.plan.count.active', defaultMessage: '{count} in progress' }, { count }),
  needs_you: (count) =>
    t({ id: 'project.plan.count.needsYou', defaultMessage: '{count} waiting for you' }, { count }),
  failed: (count) =>
    t({ id: 'project.plan.count.failed', defaultMessage: '{count} failed' }, { count }),
  not_started: (count) =>
    t({ id: 'project.plan.count.notStarted', defaultMessage: '{count} not started' }, { count }),
  abandoned: (count) =>
    t({ id: 'project.plan.count.abandoned', defaultMessage: '{count} abandoned' }, { count }),
};

/** Which part of its milestone's bar an item fills. */
export function planBucket(item: ShownPlanItem): PlanBucket {
  if (item.stage === 'landed') return 'landed';
  if (
    item.status === 'needs_you' ||
    item.status === 'failed' ||
    item.status === 'not_started' ||
    item.status === 'abandoned'
  )
    return item.status;
  return 'active';
}

export interface MilestoneCount {
  landed: number;
  total: number;
  /** The non-zero parts of the bar, in bar order. */
  parts: { bucket: PlanBucket; count: number }[];
  label: string;
}

/** A milestone head's counts and the name of its bar. */
export function milestoneCount(items: readonly ShownPlanItem[]): MilestoneCount {
  const parts = BUCKETS.map((bucket) => ({
    bucket,
    count: items.filter((item) => planBucket(item) === bucket).length,
  })).filter((part) => part.count > 0);
  return {
    landed: items.filter((item) => item.stage === 'landed').length,
    total: items.length,
    parts,
    label: t(
      {
        id: 'project.plan.milestoneLabel',
        defaultMessage: '{count, plural, one {# item} other {# items}}: {parts}',
      },
      {
        count: items.length,
        parts: listText(...parts.map((part) => BUCKET_TEXT[part.bucket](part.count))),
      },
    ),
  };
}

export type PlanReason =
  | { kind: 'failure'; text: string; handledBy: 'main_agent' | 'you'; stuckSince?: string }
  | { kind: 'stuck'; stuckSince: string }
  | { kind: 'needs_you'; text: string; sessionId: string }
  | { kind: 'waiting'; text: string };

/** Said of a failure left to the user, and of a wait whose session gives no recap. */
export const forYouText = (): string =>
  t({ id: 'project.plan.forYou', defaultMessage: 'Up to you' });

/** An item's state glyph: landed and abandoned first, as a landed item's change can be ready again. */
export function planGlyph(item: ShownPlanItem): GlyphName {
  if (item.stage === 'landed') return 'merged';
  if (item.stage === 'abandoned') return 'discarded';
  if (item.change) return STATUS_GLYPH[item.change.status];
  return item.status === 'running' ? 'running' : 'idle';
}

/** The one line under an item's title: its failure, how long it is stuck, what it asks, or what it waits for. */
export function planReason(
  item: ShownPlanItem,
  items: readonly PlanItemView[],
  sessions: readonly WorkbenchSession[] | null,
): PlanReason | null {
  if (item.failure)
    return {
      kind: 'failure',
      text: item.failure.reason,
      handledBy: item.failure.handled_by,
      ...(item.stuck_since ? { stuckSince: item.stuck_since } : {}),
    };
  if (item.stuck_since) return { kind: 'stuck', stuckSince: item.stuck_since };
  const sessionId = item.change ? changeSessionId(item.change) : null;
  if (item.status === 'needs_you' && sessionId) {
    const asks = sessions?.find((s) => s.id === sessionId)?.recap?.needs_you;
    return { kind: 'needs_you', text: asks || forYouText(), sessionId };
  }
  if (item.status !== 'not_started') return null;
  const upstream = (item.depends_on ?? [])
    .map((id) => items.find((other) => other.id === id))
    .filter((other): other is PlanItemView => !!other && other.stage !== 'landed');
  if (upstream.length === 0) return null;
  return {
    kind: 'waiting',
    text: t(
      { id: 'project.plan.waitingOn', defaultMessage: 'Waiting for {titles} to land' },
      {
        titles: upstream
          .map((other) => other.title)
          .join(t({ id: 'project.plan.titleJoin', defaultMessage: ', ' })),
      },
    ),
  };
}

const STAGE_CELLS = ['plan', 'write', 'checks', 'review', 'merge'] as const;

const STAGE_NAME: Record<ShownPlanItem['stage'], () => string> = {
  plan: () => t({ id: 'project.plan.stage.plan', defaultMessage: 'Plan' }),
  write: () => t({ id: 'project.plan.stage.write', defaultMessage: 'Write' }),
  checks: () => t({ id: 'project.plan.stage.checks', defaultMessage: 'Checks' }),
  review: () => t({ id: 'project.plan.stage.review', defaultMessage: 'Review' }),
  merge: () => t({ id: 'project.plan.stage.merge', defaultMessage: 'Merge' }),
  landed: () => t({ id: 'project.plan.stage.landed', defaultMessage: 'Landed' }),
  abandoned: () => t({ id: 'project.plan.stage.abandoned', defaultMessage: 'Abandoned' }),
};

export type StageCell = 'done' | 'current' | 'empty';

export interface PlanStage {
  name: string;
  label: string;
  /** One per stage from plan to merge. */
  cells: StageCell[];
}

/** An item's stage as five cells: the stages behind it done, its own current; all done once landed. */
export function planStage(item: ShownPlanItem): PlanStage {
  const name =
    item.stage === 'plan'
      ? t({ id: 'project.plan.stage.notStarted', defaultMessage: 'Not started' })
      : STAGE_NAME[item.stage]();
  const idle = item.stage === 'plan' || item.stage === 'abandoned';
  const at =
    item.stage === 'landed'
      ? STAGE_CELLS.length
      : (STAGE_CELLS as readonly string[]).indexOf(item.stage);
  return {
    name,
    label: t({ id: 'project.plan.stageLabel', defaultMessage: 'Stage: {stage}' }, { stage: name }),
    cells: STAGE_CELLS.map((_, k) => (idle || k > at ? 'empty' : k < at ? 'done' : 'current')),
  };
}

const GATE_RUN_TEXT: Record<PlanItemView['gate_runs'][number], () => string> = {
  passed: () => t({ id: 'project.plan.gate.passed', defaultMessage: 'passed' }),
  failed: () => t({ id: 'project.plan.gate.failed', defaultMessage: 'failed' }),
  skipped: () => t({ id: 'project.plan.gate.skipped', defaultMessage: 'skipped' }),
};

/** The name of an item's gate cells: how many runs, and each run's result, oldest first. */
export const gateRunsLabel = (runs: PlanItemView['gate_runs']): string =>
  t(
    {
      id: 'project.plan.gateLabel',
      defaultMessage: '{count, plural, one {Gate ran once} other {Gate ran # times}}: {results}',
    },
    { count: runs.length, results: listText(...runs.map((run) => GATE_RUN_TEXT[run]())) },
  );

export interface Upstream {
  id: string;
  title: string;
  landed: boolean;
}

/** The items an item depends on that the plan knows, in its order, each with whether it landed. */
export const upstreamOf = (item: PlanItemView, items: readonly PlanItemView[]): Upstream[] =>
  (item.depends_on ?? []).flatMap((id) => {
    const other = items.find((each) => each.id === id);
    return other ? [{ id, title: other.title, landed: other.stage === 'landed' }] : [];
  });

/** The name of an item's dependency graph: each upstream item and whether it landed, then the item. */
export const dependencyLabel = (ups: readonly Upstream[]): string =>
  t(
    {
      id: 'project.inspector.deps.label',
      defaultMessage: 'Depends on: {upstream}, then this item',
    },
    {
      upstream: listText(
        ...ups.map((up) =>
          up.landed
            ? t(
                { id: 'project.inspector.deps.landed', defaultMessage: '{title} landed' },
                { title: up.title },
              )
            : t(
                { id: 'project.inspector.deps.notLanded', defaultMessage: '{title} not landed' },
                { title: up.title },
              ),
        ),
      ),
    },
  );

export interface AcceptAction {
  /** What the button sends as accepted. */
  accepted: boolean;
  label: string;
  /** Why the button is off; null while it can be pressed. */
  blocked: string | null;
}

/** The accept button of an item: take back an accepted item, else accept it once no failure stands. */
export function acceptAction(item: PlanItemView): AcceptAction {
  if (item.accepted)
    return {
      accepted: false,
      label: t({ id: 'project.inspector.unaccept', defaultMessage: 'Take back acceptance' }),
      blocked: null,
    };
  return {
    accepted: true,
    label: t({ id: 'project.inspector.accept', defaultMessage: 'Accept' }),
    blocked: item.failure
      ? t({
          id: 'project.inspector.acceptBlocked',
          defaultMessage: 'The failure is not resolved yet, so it cannot be accepted',
        })
      : null,
  };
}
