import type {
  Principal,
  Project,
  RoleUsage,
  Session,
  SessionRole,
  SessionTurn,
  Usage,
} from '@pantheon/domain';
import { sessionRole } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';

const turnEnds: ReadonlySet<string> = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);

export function projectUsageRead(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): RoleUsage[] {
  projectAccess(ctx, principal, projectId, 'project.usage.read');
  ctx.store.must<Project>('projects', projectId);
  const rows = new Map<SessionRole, RoleUsage>();
  const roleOf = new Map<string, RoleUsage>();
  const rowOf = (role: SessionRole) => {
    let row = rows.get(role);
    if (!row)
      rows.set(
        role,
        (row = {
          role,
          sessions: 0,
          turns: 0,
          tool_calls: 0,
          input_tokens: 0,
          cached_input_tokens: null,
          output_tokens: 0,
          turn_ms: 0,
          turns_without_usage: 0,
        }),
      );
    return row;
  };
  const addUsage = (row: RoleUsage, usage: Usage | undefined) => {
    if (!usage || usage.tokens_unreported) {
      row.turns_without_usage++;
      return;
    }
    row.input_tokens += usage.input_tokens;
    row.output_tokens += usage.output_tokens;
    if (usage.cached_input_tokens !== undefined)
      row.cached_input_tokens = (row.cached_input_tokens ?? 0) + usage.cached_input_tokens;
  };
  for (const session of ctx.store.list<Session>('sessions')) {
    if (session.project_id !== projectId) continue;
    const row = rowOf(sessionRole(session));
    row.sessions++;
    roleOf.set(session.id, row);
  }
  const rowOfTurn = new Map<string, RoleUsage>();
  for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
    const row = roleOf.get(turn.session_id);
    if (!row) continue;
    rowOfTurn.set(turn.id, row);
    row.turns++;
    addUsage(row, turn.usage);
  }
  // A deleted session's rows are gone; its events still tell its role, turns and usage.
  const deleted = new Set<string>();
  const deletedUsage = new Map<string, Usage | undefined>();
  const deletedTurn = (turnId: string | undefined, sessionId: string | undefined) => {
    const row = deleted.has(sessionId ?? '') ? roleOf.get(sessionId!) : undefined;
    if (!turnId || !row || rowOfTurn.has(turnId)) return;
    rowOfTurn.set(turnId, row);
    row.turns++;
    deletedUsage.set(turnId, undefined);
  };
  const started = new Map<string, number>();
  const ended = new Map<string, number>();
  for (let after = 0; ;) {
    const events = ctx.store.events(after, projectId, 256);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.kind === 'session.opened' && !roleOf.has(event.aggregate_id)) {
        // Baseline and change story sessions record only their purpose here.
        const opened = event.payload as Partial<Session> & { purpose?: string };
        const row = rowOf(
          opened.purpose === 'baseline'
            ? 'baseline'
            : opened.purpose === 'change_story' || opened.purpose === 'range_story'
              ? 'story'
              : sessionRole(opened),
        );
        row.sessions++;
        roleOf.set(event.aggregate_id, row);
        deleted.add(event.aggregate_id);
      } else if (event.kind === 'turn.queued') {
        deletedTurn(event.aggregate_id, (event.payload as Partial<SessionTurn>).session_id);
      }
      if (event.kind.startsWith('agent.')) {
        const payload = event.payload as Partial<Usage> & { turn_id?: string };
        deletedTurn(payload.turn_id, event.aggregate_id);
        if (event.kind === 'agent.usage.updated' && deletedUsage.has(payload.turn_id ?? '')) {
          const usage = deletedUsage.get(payload.turn_id!);
          // As agentEvent folds a report into the turn row.
          deletedUsage.set(payload.turn_id!, {
            input_tokens: payload.input_tokens ?? usage?.input_tokens ?? 0,
            cached_input_tokens: payload.cached_input_tokens ?? usage?.cached_input_tokens,
            output_tokens: payload.output_tokens ?? usage?.output_tokens ?? 0,
            ...(payload.input_tokens === undefined &&
            payload.output_tokens === undefined &&
            (!usage || usage.tokens_unreported)
              ? { tokens_unreported: true as const }
              : {}),
          });
        }
      }
      if (event.kind === 'agent.tool.started') {
        const row = roleOf.get(event.aggregate_id);
        if (row) row.tool_calls++;
      } else if (event.kind === 'turn.running') {
        if (!started.has(event.aggregate_id)) started.set(event.aggregate_id, event.created_at);
      } else if (turnEnds.has(event.kind)) {
        ended.set(event.aggregate_id, event.created_at);
      }
    }
    after = events[events.length - 1]!.sequence;
  }
  for (const [turnId, usage] of deletedUsage) addUsage(rowOfTurn.get(turnId)!, usage);
  for (const [turnId, start] of started) {
    const end = ended.get(turnId);
    const row = rowOfTurn.get(turnId);
    if (end !== undefined && row) row.turn_ms += end - start;
  }
  return [...rows.values()].sort((a, b) => a.role.localeCompare(b.role));
}
