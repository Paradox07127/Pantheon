import type {
  Approval,
  LandingItem,
  Principal,
  Review,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import type { DecisionForUser, SessionThread, SessionThreadEntry } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { gateFailed } from './landing.js';
import { reviewTimeReader } from './review.js';

const threadEvents = [
  'session.opened',
  'session.main_agent_decided',
  'session.conductor_messaged',
  'session.spawner_notified',
  'agent.turn.completed',
  'session.turn.delivery',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.gate_checked',
  'session.gate_run_failed',
  'session.gate_run_cancelled',
  'session.merged',
  'session.merge_blocked',
  'session.merge_cancelled',
];

export function sessionThread(
  ctx: ControlContext,
  principal: Principal,
  sessionId: string,
): SessionThread {
  const session = ctx.store.must<Session>('sessions', sessionId);
  projectAccess(ctx, principal, session.project_id, 'session.thread');
  const personal = principal.role === 'personal';
  const entries: SessionThreadEntry[] = [];
  const runtimeErrors = new Map<string, { error?: string; error_code?: string }>();
  const delivered = new Map<string, number>();
  const ended = new Set<string>();
  let opened: SessionThreadEntry | undefined;
  for (let after = 0; ;) {
    const events = ctx.store.events(after, session.project_id, 256, threadEvents, sessionId);
    if (!events.length) break;
    for (const event of events) {
      const record = { id: event.event_id, at: event.created_at };
      switch (event.kind) {
        case 'session.opened': {
          const caller = session.review_id
            ? ctx.store.must<Review>('reviews', session.review_id).notify_session_id
            : session.spawned_by?.session_id;
          opened = caller
            ? {
                ...record,
                kind: 'started',
                by: 'main_agent',
                main_agent_session_id: caller,
              }
            : { ...record, kind: 'started', by: 'user' };
          break;
        }
        case 'session.main_agent_decided': {
          const { action, main_agent_session_id, reason } = event.payload as Extract<
            DecisionForUser,
            { kind: 'main_agent_action' }
          >;
          const decision = {
            ...record,
            main_agent_session_id,
            ...(!personal && reason !== undefined ? { reason } : {}),
          };
          if (action === 'spawn') opened = { ...decision, kind: 'started', by: 'main_agent' };
          else entries.push({ ...decision, kind: 'main_agent_action', action });
          break;
        }
        case 'session.conductor_messaged': {
          const { turn_id, session_id } = event.payload as { turn_id: string; session_id: string };
          entries.push({
            ...record,
            kind: 'message',
            main_agent_session_id: session_id,
            turn_id,
            ...(personal
              ? {}
              : { text: ctx.store.get<SessionTurn>('session_turns', turn_id)?.input }),
          });
          break;
        }
        case 'session.turn.delivery': {
          const { delivery } = event.payload as Pick<SessionTurn, 'delivery'>;
          if (delivery === 'failed' || delivery === 'delivered')
            delivered.set(event.aggregate_id, event.created_at);
          break;
        }
        case 'agent.turn.completed': {
          const completion = event.payload as {
            turn_id?: string;
            error?: string;
            error_code?: string;
          };
          if (completion.turn_id && (completion.error || completion.error_code))
            runtimeErrors.set(completion.turn_id, completion);
          break;
        }
        case 'turn.completed':
        case 'turn.failed':
        case 'turn.cancelled': {
          const { error, error_code } = event.payload as { error?: string; error_code?: string };
          ended.add(event.aggregate_id);
          const runtime = runtimeErrors.get(event.aggregate_id);
          const reason =
            runtime?.error_code ??
            error_code ??
            (personal ? undefined : (error ?? runtime?.error)?.split(/\r?\n/, 1)[0]);
          const state =
            event.kind === 'turn.completed'
              ? 'completed'
              : event.kind === 'turn.failed'
                ? 'failed'
                : 'cancelled';
          entries.push({
            ...record,
            kind: 'turn_ended',
            turn_id: event.aggregate_id,
            state,
            ...(state === 'failed' && reason ? { error: reason } : {}),
          });
          break;
        }
        case 'session.spawner_notified': {
          const { session_id, turn_id, approval_id } = event.payload as {
            session_id: string;
            turn_id?: string;
            approval_id?: string;
          };
          entries.push({
            ...record,
            kind: 'spawner_notified',
            main_agent_session_id: session_id,
            turn_id,
            approval_id,
          });
          break;
        }
        case 'session.gate_checked': {
          const { results } = event.payload as {
            results: NonNullable<LandingItem['gate_results']>;
          };
          const failed_steps = results.filter(gateFailed).map((result) => result.name);
          entries.push({
            ...record,
            kind: 'gate',
            state: failed_steps.length ? 'failed' : 'passed',
            failed_steps,
          });
          break;
        }
        case 'session.gate_run_failed':
        case 'session.gate_run_cancelled':
          entries.push({
            ...record,
            kind: 'gate',
            state: event.kind === 'session.gate_run_failed' ? 'failed' : 'cancelled',
            failed_steps: [],
          });
          break;
        case 'session.merged':
          entries.push({
            ...record,
            kind: 'landing',
            state: 'landed',
            commit: (event.payload as { to_sha: string }).to_sha,
          });
          break;
        case 'session.merge_blocked':
        case 'session.merge_cancelled':
          entries.push({
            ...record,
            kind: 'landing',
            state: 'blocked',
            ...(personal ? {} : { reason: (event.payload as { reason: string }).reason }),
          });
          break;
      }
    }
    after = events.at(-1)!.sequence;
  }
  // An injected steer and a turn whose delivery failed can finish at delivery itself.
  for (const [turnId, at] of delivered) {
    if (ended.has(turnId)) continue;
    const turn = ctx.store.must<SessionTurn>('session_turns', turnId);
    if (turn.state !== 'completed' && turn.state !== 'failed') continue;
    const error =
      !personal && turn.state === 'failed' && turn.delivery_reason?.split(/\r?\n/, 1)[0];
    entries.push({
      id: turn.id,
      at,
      kind: 'turn_ended',
      turn_id: turn.id,
      state: turn.state,
      ...(error ? { error } : {}),
    });
  }
  if (opened) entries.unshift(opened);
  for (const approval of ctx.store.list<Approval>('approvals')) {
    if (
      approval.session_id !== sessionId ||
      (!approval.questions?.length && approval.tool !== 'AskUserQuestion')
    )
      continue;
    const answered =
      (approval.state === 'approved' || approval.state === 'rejected') &&
      !approval.reason &&
      approval.decided_by;
    entries.push({
      id: approval.id,
      at: approval.created_at,
      kind: 'question',
      state: approval.state,
      ...(answered ? { answered_by: answered.startsWith('session:') ? 'main_agent' : 'user' } : {}),
      ...(personal
        ? {}
        : { questions: approval.questions?.map((q) => q.question), answers: approval.answers }),
    });
  }
  const reviews = ctx.store
    .list<Review>('reviews')
    .filter((review) => review.session_id === sessionId);
  if (reviews.length) {
    const timeOf = reviewTimeReader(ctx, session.project_id);
    for (const review of reviews) {
      const time = timeOf(review);
      const at = time.ended_at ?? time.started_at;
      if (at === undefined) continue;
      entries.push({
        id: review.id,
        at,
        kind: 'review',
        round: review.round,
        state: review.state,
        verdicts: (review.verdicts ?? []).map(({ runtime, verdict }) => ({ runtime, verdict })),
        blocking: review.findings
          .filter((f) => f.blocking && f.status !== 'rejected')
          .map((f) => ({
            id: f.id,
            ...(personal ? {} : { location: f.location, impact: f.impact.split(/\r?\n/, 1)[0] }),
          })),
      });
    }
  }
  return { entries: entries.sort((a, b) => a.at - b.at) };
}
