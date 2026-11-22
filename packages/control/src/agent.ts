import {
  hash,
  type CancelReceipt,
  type Session,
  type SessionTurn,
  type SessionHandle,
  type AgentEvent,
  type HarnessAdapter,
  type Usage,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { inputSchemas, type VisualDrawingPayload } from '@pantheon/protocol';
import { requestApproval, loseSessionApprovals, resolvePermission } from './approvals.js';
import { markStaleFindings, recordFinding } from './review.js';
import { unsnooze } from './session.js';
import { isRuntimeHeld } from './runtime-status.js';
import { recapSession } from './session-recap.js';
import { afterSpawnedRequest } from './conductor.js';

export function saveSessionHandle(ctx: ControlContext, handle: SessionHandle): void {
  ctx.store.transaction(() => {
    const session = ctx.store.must<Session>('sessions', handle.platform_session_id);
    if (!acceptNativeId(ctx, session, handle.native_session_id)) return;
    let identity = handle.process_identity;
    if (identity && identity.start_time_us === undefined) {
      if (
        session.process_identity?.pid === identity.pid &&
        session.process_identity.start_time_us !== undefined
      )
        identity = session.process_identity;
      else {
        try {
          identity = ctx.readProcess(identity.pid) ?? identity;
        } catch {
          /* Keep an unverified identity fail-closed. */
        }
      }
    }
    if (
      (handle.native_session_id || session.native_id) === session.native_id &&
      JSON.stringify(identity) === JSON.stringify(session.process_identity) &&
      handle.adapter_version === session.adapter_version &&
      (handle.requested_model ?? session.requested_model) === session.requested_model &&
      handle.reported_model === session.reported_model &&
      (handle.native_state_dir ?? session.native_state_dir) === session.native_state_dir &&
      (handle.native_title ?? session.native_title) === session.native_title &&
      handle.device_id === session.device_id
    )
      return;
    const next = ctx.store.update(
      'sessions',
      {
        ...session,
        native_id: handle.native_session_id || session.native_id,
        process_identity: identity,
        adapter_version: handle.adapter_version,
        requested_model: handle.requested_model ?? session.requested_model,
        reported_model: handle.reported_model,
        native_state_dir: handle.native_state_dir ?? session.native_state_dir,
        native_title: handle.native_title ?? session.native_title,
        device_id: handle.device_id,
      },
      session.revision,
    );
    ctx.store.event('session.handle_changed', next, next.project_id, {
      reported_model: next.reported_model,
      native_title: next.native_title,
      device_id: next.device_id,
    });
  });
}

function rejectNativeId(
  ctx: ControlContext,
  session: Session,
  nativeId: string | undefined,
  reason: string,
): void {
  const next = ctx.store.update('sessions', { ...session, native_id: undefined }, session.revision);
  ctx.store.event('agent.native_id_rejected', next, session.project_id, {
    native_session_id: nativeId,
    reason,
  });
}

function acceptNativeId(ctx: ControlContext, session: Session, nativeId: string): boolean {
  if (
    nativeId &&
    ctx.store
      .list<Session>('sessions')
      .some((other) => other.id !== session.id && other.native_id === nativeId)
  ) {
    // Adapters report the same handle many times per launch; record each refused id once.
    if (
      !session.native_id &&
      (
        ctx.store
          .kindEvents(session.project_id, ['agent.native_id_rejected'])
          .filter((event) => event.aggregate_id === session.id)
          .at(-1)?.payload as { native_session_id?: string } | undefined
      )?.native_session_id === nativeId
    )
      return false;
    rejectNativeId(ctx, session, nativeId, 'Native session id belongs to another session');
    return false;
  }
  return true;
}

/** Called inside the transaction that changes the turn's execution state. */
export function turnDelivery(
  ctx: ControlContext,
  turn: SessionTurn,
  delivery: SessionTurn['delivery'],
  reason?: string,
  state = turn.state,
): SessionTurn {
  if (turn.delivery === delivery && turn.state === state) return turn;
  const next = ctx.store.update(
    'session_turns',
    { ...turn, delivery, delivery_reason: reason, state },
    turn.revision,
  );
  if (turn.delivery !== delivery)
    ctx.store.event('session.turn.delivery', next, turn.project_id, { delivery, reason });
  return next;
}

/** The event as recorded: a returned image's bytes go to the artifact files and it keeps their hash. */
function recordedEvent(ctx: ControlContext, event: AgentEvent): unknown {
  if (event.kind !== 'tool.completed' || !event.images?.length) return event;
  return {
    ...event,
    images: event.images.map(({ mime, data }) => {
      const bytes = Buffer.from(data, 'base64');
      return { mime, hash: ctx.files.put(bytes).hash, size: bytes.length };
    }),
  };
}

export function agentEvent(ctx: ControlContext, sessionId: string, event: AgentEvent): boolean {
  if (event.kind === 'turn.started') ctx.failpoint('before_native_running_receipt');
  const payload = recordedEvent(ctx, event);
  const recorded = ctx.store.transaction(() => {
    let s = ctx.store.must<Session>('sessions', sessionId);
    const key = `native:${sessionId}:${event.key}`;
    if (ctx.store.receipt(key)) return false;
    ctx.store.remember(key, hash(event), {});
    if (event.kind === 'fast_mode.changed')
      s = ctx.store.update(
        'sessions',
        {
          ...s,
          fast_mode: { state: event.state, ...(event.reason ? { reason: event.reason } : {}) },
        },
        s.revision,
      );
    if (event.kind === 'turn.completed' && event.native_history_end && event.turn_id) {
      const turn = ctx.store.must<SessionTurn>('session_turns', event.turn_id);
      ctx.store.update(
        'session_turns',
        { ...turn, native_history_end: event.native_history_end },
        turn.revision,
      );
    }
    if (event.kind === 'usage.updated') {
      const turn = event.turn_id
        ? ctx.store.get<SessionTurn>('session_turns', event.turn_id)
        : undefined;
      if (turn?.session_id === s.id) {
        const tokensReported =
          event.input_tokens !== undefined ||
          event.output_tokens !== undefined ||
          (turn.usage !== undefined && !turn.usage.tokens_unreported);
        ctx.store.update<SessionTurn>(
          'session_turns',
          {
            ...turn,
            usage: {
              input_tokens: event.input_tokens ?? turn.usage?.input_tokens ?? 0,
              cached_input_tokens: event.cached_input_tokens ?? turn.usage?.cached_input_tokens,
              cache_write_input_tokens:
                event.cache_write_input_tokens ?? turn.usage?.cache_write_input_tokens,
              output_tokens: event.output_tokens ?? turn.usage?.output_tokens ?? 0,
              reasoning_output_tokens:
                event.reasoning_output_tokens ?? turn.usage?.reasoning_output_tokens,
              cost_usd: event.cost_usd ?? turn.usage?.cost_usd,
              cost_source: event.cost_source ?? turn.usage?.cost_source,
              context_tokens: event.context_tokens ?? turn.usage?.context_tokens,
              context_window: event.context_window ?? turn.usage?.context_window,
              context_breakdown: event.context_breakdown ?? turn.usage?.context_breakdown,
              ...(tokensReported ? {} : { tokens_unreported: true as const }),
            },
          },
          turn.revision,
        );
        const usage: Usage = {
          input_tokens: 0,
          output_tokens: 0,
          cost_source: event.cost_source ?? s.usage?.cost_source,
          tokens_unreported: true,
        };
        for (const t of ctx.store.list<SessionTurn>('session_turns')) {
          if (t.session_id !== s.id || !t.usage) continue;
          if (!t.usage.tokens_unreported) delete usage.tokens_unreported;
          usage.input_tokens += t.usage.input_tokens;
          usage.output_tokens += t.usage.output_tokens;
          if (t.usage.cost_usd !== undefined)
            usage.cost_usd = (usage.cost_usd ?? 0) + t.usage.cost_usd;
          if (t.usage.cached_input_tokens !== undefined)
            usage.cached_input_tokens =
              (usage.cached_input_tokens ?? 0) + t.usage.cached_input_tokens;
          if (t.usage.cache_write_input_tokens !== undefined)
            usage.cache_write_input_tokens =
              (usage.cache_write_input_tokens ?? 0) + t.usage.cache_write_input_tokens;
          if (t.usage.reasoning_output_tokens !== undefined)
            usage.reasoning_output_tokens =
              (usage.reasoning_output_tokens ?? 0) + t.usage.reasoning_output_tokens;
          usage.context_tokens = t.usage.context_tokens;
          usage.context_window = t.usage.context_window;
        }
        s = ctx.store.update(
          'sessions',
          { ...s, usage, auto_compact_at_tokens: event.auto_compact_at_tokens },
          s.revision,
        );
      }
    }
    if (event.kind === 'session.started') {
      if (!acceptNativeId(ctx, s, event.native_session_id)) return false;
      s = ctx.store.update(
        'sessions',
        {
          ...s,
          native_id: event.native_session_id,
          native_fork: undefined,
          auto_compact_at_tokens: undefined,
          event_namespace: event.key.includes(':') ? event.key.split(':')[0] : s.event_namespace,
          requested_model: event.requested_model ?? s.requested_model,
          // An absent vendor report is unknown, including after a resumed query.
          reported_model: event.reported_model,
        },
        s.revision,
      );
      const turn = event.turn_id
        ? ctx.store.get<SessionTurn>('session_turns', event.turn_id)
        : undefined;
      if (event.reported_model && turn?.session_id === s.id)
        ctx.store.update<SessionTurn>(
          'session_turns',
          { ...turn, reported_model: event.reported_model },
          turn.revision,
        );
    }
    if (event.kind === 'title.generated') {
      const title = event.title.replace(/\s*[\r\n]+\s*/g, ' ').trim();
      // A task session keeps its task's name; a user's name always wins over a generated one.
      if (title && s.title_source !== 'user' && !s.task && s.runtime !== 'fixture') {
        s = ctx.store.update('sessions', { ...s, title }, s.revision);
        ctx.store.event('session.renamed', s, s.project_id, { title, source: 'auto' });
      }
    }
    if (event.kind === 'permission.requested') requestApproval(ctx, s, event);
    if (event.kind === 'permission.resolved') resolvePermission(ctx, s, event);
    if (event.kind === 'tool.started' && event.name === 'review.finding') {
      const input = inputSchemas['review.finding'].safeParse(event.input);
      recordFinding(ctx, s, input.success ? input.data : undefined);
    }
    if (event.kind === 'session.exited' && !isRuntimeHeld(ctx, s.runtime)) {
      ctx.revokeSessionCredential?.(s.id);
      s = ctx.store.update(
        'sessions',
        { ...s, state: 'closed' as const, stop_pending: false },
        s.revision,
      );
    }
    if (event.kind === 'session.exited' || event.kind === 'turn.completed')
      loseSessionApprovals(ctx, s.id);
    if (event.kind === 'turn.completed') markStaleFindings(ctx, s);
    if (event.kind === 'visual.drawing')
      ctx.store.event('visual.drawing', s, s.project_id, {
        tool_call_id: event.tool_call_id,
        received_bytes: event.received_bytes,
      } satisfies VisualDrawingPayload);
    else ctx.store.event(`agent.${event.kind}`, s, s.project_id, payload);
    if (event.kind === 'turn.completed') unsnooze(ctx, s.id, 'turn_ended');
    if (event.kind === 'session.exited') unsnooze(ctx, s.id, 'session_ended');
    return true;
  });
  if (recorded) {
    ctx.changed();
    if (event.kind === 'turn.completed' && event.turn_id)
      recapSession(ctx, sessionId, event.turn_id, {
        kind: 'turn_ended',
        status: event.status,
        ...(event.error ? { error: event.error } : {}),
      });
    if (event.kind === 'permission.requested' && event.turn_id)
      recapSession(ctx, sessionId, event.turn_id, {
        kind: 'waiting',
        request_id: event.request_id,
      });
    if (event.kind === 'permission.requested') afterSpawnedRequest(ctx, sessionId);
  }
  return recorded;
}

export async function stopSession(
  ctx: ControlContext,
  adapter: HarnessAdapter,
  handle: SessionHandle,
  method: 'close' | 'cancel',
): Promise<{ receipt?: CancelReceipt; error?: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const receipt = await Promise.race([
      // Adapters wait in real time; the store clock may be virtual.
      Promise.resolve().then(() => adapter[method](handle, Date.now() + 10000)),
      new Promise<CancelReceipt>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out after 10000 ms`)), 10000);
      }),
    ]);
    return { receipt };
  } catch (error) {
    return { error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}
