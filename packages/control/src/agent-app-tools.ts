import { requireThat, type Principal, type Session, type SessionTurn } from '@pantheon/domain';
import { inputSchemas, type WorkbenchSession } from '@pantheon/protocol';
import { appHelp } from './app-help.js';
import { projectAccess, sessionPrincipal, type ControlContext, type Preparers } from './context.js';
import { githubItems, githubPullDetail } from './github.js';
import { sessionList } from './workbench-session.js';

const TEXT_LIMIT = 1500;
const READ_LIMIT = 12000;

export interface AgentSessionListItem {
  id: string;
  title: string;
  type: 'resident' | 'worker' | 'direct' | 'review';
  state: WorkbenchSession['state'];
  runtime: string;
  task?: { id: string; title: string };
  changes: WorkbenchSession['changes'];
  last_activity_at: string;
}

export interface AgentSessionRead {
  session_id: string;
  title: string;
  state: WorkbenchSession['state'] | Session['state'];
  /** Oldest first. */
  turns: { turn_id: string; state: SessionTurn['state']; input: string; output: string }[];
  /** The oldest of the requested turns left out to keep the answer within its size. */
  cut_turns: number;
}

/** Refuses all but a resident lead of the project whose profile has the action's tool. */
function residentAccess(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  action: string,
): void {
  requireThat(p.role === 'lead' && p.session_id, 'permission_denied', 'Resident lead required');
  projectAccess(ctx, p, projectId, action);
  requireThat(sessionPrincipal(ctx, p).resident, 'permission_denied', 'Resident lead required');
}

// The resident's access is checked first; the shared reads then run as for the user.
const reader = (p: Principal): Principal => ({ id: p.id, role: 'user' });

const sessionType = (session: Session): AgentSessionListItem['type'] =>
  session.resident
    ? 'resident'
    : session.review_id || session.runtime_review
      ? 'review'
      : session.task
        ? 'worker'
        : 'direct';

const cut = (text: string) =>
  text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;

/** The text the agent wrote after its last tool call in the turn. */
function finalOutput(ctx: ControlContext, sessionId: string, turnId: string): string {
  const rows = ctx.store.db
    .prepare(
      "SELECT kind, payload ->> '$.text' AS text FROM events WHERE aggregate_id=? AND kind IN ('agent.message.delta', 'agent.tool.started') AND payload ->> '$.turn_id'=? ORDER BY sequence",
    )
    .all(sessionId, turnId) as { kind: string; text: string | null }[];
  let reply = '';
  for (const row of rows) reply = row.kind === 'agent.tool.started' ? '' : reply + (row.text ?? '');
  return reply.trim();
}

export const agentAppToolPreparers: Preparers = {
  'agent.app_help': (ctx, p, c) => {
    const { topic } = inputSchemas['agent.app_help'].parse(c.input);
    residentAccess(ctx, p, p.project_id ?? '', c.type);
    const help = appHelp(topic);
    return () => help;
  },
  'agent.sessions': (ctx, p, c) => {
    const { state } = inputSchemas['agent.sessions'].parse(c.input);
    const projectId = p.project_id ?? '';
    residentAccess(ctx, p, projectId, c.type);
    const sessions = sessionList(ctx, reader(p), projectId)
      .filter((listed) => state === undefined || listed.state === state)
      .map((listed): AgentSessionListItem => {
        const session = ctx.store.must<Session>('sessions', listed.id);
        return {
          id: listed.id,
          title: listed.title,
          type: sessionType(session),
          state: listed.state,
          runtime: listed.runtime,
          ...(listed.task ? { task: { id: listed.task.id, title: listed.task.title } } : {}),
          changes: listed.changes,
          last_activity_at: listed.last_activity_at,
        };
      });
    return () => ({ sessions });
  },
  'agent.session_read': (ctx, p, c) => {
    const input = inputSchemas['agent.session_read'].parse(c.input);
    const projectId = p.project_id ?? '';
    residentAccess(ctx, p, projectId, c.type);
    const session = ctx.store.must<Session>('sessions', input.session_id);
    requireThat(
      session.project_id === projectId,
      'permission_denied',
      'Session of another project',
    );
    const listed = sessionList(ctx, reader(p), projectId).find((s) => s.id === session.id);
    const turns = ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === session.id && turn.kind === 'send' && !turn.rolled_back)
      .slice(-input.turns)
      .map((turn) => ({
        turn_id: turn.id,
        state: turn.state,
        input: cut(turn.input),
        output: cut(finalOutput(ctx, session.id, turn.id)),
      }));
    const read: AgentSessionRead = {
      session_id: session.id,
      title: listed?.title ?? session.title ?? '',
      state: listed?.state ?? session.state,
      turns,
      cut_turns: 0,
    };
    while (read.turns.length && JSON.stringify(read).length > READ_LIMIT) {
      read.turns.shift();
      read.cut_turns += 1;
    }
    return () => read;
  },
  'agent.github_items': async (ctx, p, c) => {
    const input = inputSchemas['agent.github_items'].parse(c.input);
    residentAccess(ctx, p, input.project_id, c.type);
    const items = await githubItems(ctx, reader(p), input.project_id, input.kind);
    return () => items;
  },
  'agent.github_pr': async (ctx, p, c) => {
    const input = inputSchemas['agent.github_pr'].parse(c.input);
    residentAccess(ctx, p, input.project_id, c.type);
    const detail = await githubPullDetail(ctx, reader(p), input.project_id, input.number);
    return () => detail;
  },
};
