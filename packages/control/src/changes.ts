import type {
  Landing,
  LandingItem,
  NeedsYouItem,
  Principal,
  Review,
  Session,
} from '@pantheon/domain';
import type { ChangeRow, ProjectChanges, WorkbenchSession } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { gateFailed } from './landing.js';
import { needsYou } from './needs-you.js';
import { sessionList } from './workbench-session.js';

export type { ChangeRow };

const DAY_MS = 24 * 60 * 60_000;

type GateResults = NonNullable<LandingItem['gate_results']>;

const resultsGate = (results: GateResults | undefined): ChangeRow['gate'] => {
  const failed = (results ?? []).filter(gateFailed).map((result) => result.name);
  return !results?.length
    ? { state: 'none' }
    : failed.length
      ? { state: 'failed', failed }
      : { state: 'passed' };
};

function sessionStatus(
  listed: WorkbenchSession,
  todo: Set<string>,
  landed: Set<string>,
): ChangeRow['status'] | undefined {
  const { state } = listed;
  if (state === 'failed' || listed.merge?.state === 'blocked') return 'failed';
  if (state === 'merged') return 'merged';
  if (state === 'starting' || state === 'running') return 'running';
  if (state === 'waiting' || todo.has(listed.id)) return 'needs_you';
  if (state === 'ready' || state === 'merging' || (state === 'idle' && (listed.ahead ?? 0) > 0))
    return 'ready';
  // A session that stays open after it lands, as a conductor does, with no commit since.
  if (state === 'idle' && landed.has(listed.id)) return 'merged';
  return undefined;
}

/**
 * The project's changes: its worktree sessions with work to show and the branch landings no session
 * owns. Reads the session list from its cache, so worktree facts not read yet show as unknown.
 */
export function projectChanges(
  ctx: ControlContext,
  reader: Principal,
  projectId: string,
  todo: NeedsYouItem[],
): ChangeRow[] {
  const waiting = new Set(
    todo.map((item) =>
      item.source.table === 'sessions' ? item.source.id : (item.session_id ?? ''),
    ),
  );
  const reviews = ctx.store
    .list<Review>('reviews')
    .filter((review) => review.project_id === projectId && review.session_id);
  const checked = ctx.store.kindEvents(projectId, ['session.gate_checked']);
  const landed = new Set(
    ctx.store.kindEvents(projectId, ['session.merged']).map((event) => event.aggregate_id),
  );
  const rows: ChangeRow[] = [];
  for (const listed of sessionList(ctx, reader, projectId, 'cached')) {
    const session = ctx.store.must<Session>('sessions', listed.id);
    if (!listed.workspace_id || session.review_id || session.runtime_review) continue;
    const status = sessionStatus(listed, waiting, landed);
    if (!status) continue;
    const review = reviews.findLast((each) => each.session_id === listed.id);
    const gateFailedMerge = listed.merge?.state === 'blocked' && listed.merge.gate;
    rows.push({
      id: `session:${listed.id}`,
      kind: 'session',
      title: listed.title,
      ...(listed.branch !== undefined ? { branch: listed.branch } : {}),
      runtime: listed.runtime,
      ...(session.spawned_by ? { spawned_by: session.spawned_by.session_id } : {}),
      status,
      ...(listed.ahead !== undefined ? { ahead: listed.ahead } : {}),
      ...(listed.behind !== undefined ? { behind: listed.behind } : {}),
      gate: gateFailedMerge
        ? { state: 'failed', failed: [gateFailedMerge.name] }
        : listed.gate?.state === 'failed'
          ? resultsGate(
              (
                checked.findLast((event) => event.aggregate_id === listed.id)?.payload as
                  { results?: GateResults } | undefined
              )?.results,
            )
          : {
              state:
                listed.gate?.state === 'passed' || listed.gate?.state === 'stale'
                  ? listed.gate.state
                  : listed.gate?.state === 'running' || listed.gate?.state === 'cancelling'
                    ? 'running'
                    : 'none',
            },
      ...(review
        ? {
            review: {
              id: review.id,
              state: review.state,
              ...(review.incomplete ? { incomplete: true as const } : {}),
              verdicts: (review.verdicts ?? []).map(({ runtime, verdict }) => ({
                runtime,
                verdict,
              })),
              blocking_open: review.findings.filter(
                (finding) =>
                  (finding.status === 'open' || finding.status === 'stale') &&
                  finding.blocking &&
                  !finding.resolution,
              ).length,
              ...(review.range ? { to_sha: review.range.to_sha } : {}),
            },
          }
        : {}),
      ...(listed.merge?.state === 'running' || listed.state === 'merging'
        ? { landing: 'running' as const }
        : {}),
      updated_at: listed.last_activity_at,
    });
  }
  const since = ctx.store.now() - DAY_MS;
  for (const landing of ctx.store
    .list<Landing>('landings')
    .filter(
      (each) =>
        each.project_id === projectId &&
        (each.finished_at === undefined || each.finished_at >= since),
    ))
    rows.push({
      id: `landing:${landing.id}`,
      kind: 'branch',
      title: landing.branch,
      branch: landing.branch,
      status:
        landing.state === 'blocked'
          ? 'failed'
          : landing.state === 'landed' || landing.state === 'no_changes'
            ? 'merged'
            : 'ready',
      gate: resultsGate(landing.gate_results),
      ...(landing.state === 'queued' || landing.state === 'running'
        ? { landing: landing.state }
        : {}),
      // A queued landing has no time of its own yet.
      updated_at: new Date(
        landing.finished_at ?? landing.started_at ?? ctx.store.now(),
      ).toISOString(),
    });
  return rows;
}

/** project.changes: the rows read_state lists, to whoever project.read admits. */
export function changesRead(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): ProjectChanges {
  projectAccess(ctx, principal, projectId, 'project.read');
  ctx.store.must('projects', projectId);
  // As read_state, the shared reads run as for the user once access is checked.
  const reader: Principal = { id: principal.id, role: 'user' };
  return {
    changes: projectChanges(ctx, reader, projectId, needsYou(ctx, reader, projectId).items),
  };
}
