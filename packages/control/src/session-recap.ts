import type { Approval, Session, SessionRecap, SessionTurn } from '@pantheon/domain';
import type { SessionRecappedPayload } from '@pantheon/protocol';
import { readAppSettings } from './app-settings.js';
import type { ControlContext } from './context.js';
import { onDevice } from './remote-workspace.js';
import { projectOverBudget } from './workflow-policy.js';

/** One prompt to a model that uses no tools; resolves to its reply and stops once aborted. */
export type TurnSummarizer = (
  prompt: string,
  signal: AbortSignal,
) => Promise<{
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
}>;

/** Why the session is recapped now: its turn ended, or it waits on the user for a request. */
export type RecapMoment =
  | { kind: 'turn_ended'; status: 'completed' | 'failed' | 'interrupted'; error?: string }
  | { kind: 'waiting'; request_id: string };

const RECAP_TIMEOUT_MS = 20_000;

export function sessionRecapPrompt(input: string, reply: string, facts: string): string {
  return [
    'Write a recap of where a session between a user and a coding agent stands, so the user can pick it up at a glance.',
    'Reply with one JSON object alone: {"headline": string, "needs_you": string, "happened": string}.',
    'headline: where the session stands, at most 64 characters.',
    'needs_you: what the user must answer or approve for the session to go on, at most 140 characters; an empty string when the session waits on nothing.',
    'happened: what the turn got done or decided, at most 140 characters. Do not restate the user message.',
    'Write in the language of the user message.',
    '',
    '<facts>',
    facts,
    '</facts>',
    '<user_message>',
    input.slice(0, 2000),
    '</user_message>',
    '<agent_reply>',
    reply.slice(0, 4000),
    '</agent_reply>',
  ].join('\n');
}

/** The text the agent wrote after its last tool call in the turn. */
function lastReply(ctx: ControlContext, sessionId: string, turnId: string): string {
  const rows = ctx.store.db
    .prepare(
      "SELECT kind, payload ->> '$.text' AS text FROM events WHERE aggregate_id=? AND kind IN ('agent.message.delta', 'agent.tool.started') AND payload ->> '$.turn_id'=? ORDER BY sequence",
    )
    .all(sessionId, turnId) as { kind: string; text: string | null }[];
  let reply = '';
  for (const row of rows) reply = row.kind === 'agent.tool.started' ? '' : reply + (row.text ?? '');
  return reply.trim();
}

function waitingFacts(approval: Approval): string {
  if (approval.questions?.length)
    return [
      'The session waits for the user to answer:',
      ...approval.questions.map(
        (q) => `- ${q.question} (${q.options.map((option) => option.label).join(' / ')})`,
      ),
    ].join('\n');
  return `The session waits for the user to approve the tool ${approval.tool ?? 'call'}${approval.input_summary ? `: ${approval.input_summary}` : ''}`;
}

const cut = (text: string, max: number) => [...text.trim()].slice(0, max).join('');

/** The recap fields of the reply, cut to their lengths; undefined when the reply is no such JSON. */
function parseRecap(
  text: string,
): Pick<SessionRecap, 'headline' | 'needs_you' | 'happened'> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    return;
  }
  if (!value || typeof value !== 'object') return;
  const { headline, needs_you, happened } = value as Record<string, unknown>;
  if (typeof headline !== 'string' || typeof happened !== 'string') return;
  if (needs_you !== undefined && typeof needs_you !== 'string') return;
  const recap = { headline: cut(headline, 64), happened: cut(happened, 140) };
  if (!recap.headline || !recap.happened) return;
  const needs = cut(needs_you ?? '', 140);
  return needs ? { ...recap, needs_you: needs } : recap;
}

/** Whether the session has a turn or permission event after this sequence. */
function overtaken(ctx: ControlContext, sessionId: string, sequence: number): boolean {
  return !!ctx.store.db
    .prepare(
      "SELECT 1 FROM events WHERE aggregate_id=? AND sequence>? AND (kind LIKE 'agent.turn.%' OR kind='agent.permission.requested') LIMIT 1",
    )
    .get(sessionId, sequence);
}

/**
 * Asks the summarizer for a recap of the session and keeps it on the session; the turn and the
 * next one do not wait for it, and a failure or a newer turn or request records nothing.
 */
export function recapSession(
  ctx: ControlContext,
  sessionId: string,
  turnId: string,
  moment: RecapMoment,
): void {
  const summarizer = ctx.turnSummarizer;
  const session = ctx.store.must<Session>('sessions', sessionId);
  const turn = ctx.store.get<SessionTurn>('session_turns', turnId);
  // A compaction turn's input is instructions, not the user's words.
  if (!summarizer || !turn || turn.origin === 'compaction' || onDevice(session)) return;
  const approval =
    moment.kind === 'waiting'
      ? ctx.store
          .list<Approval>('approvals')
          .find(
            (a) =>
              a.session_id === sessionId &&
              a.request_id === moment.request_id &&
              a.state === 'pending',
          )
      : undefined;
  if (moment.kind === 'waiting' && !approval) return;
  if (readAppSettings(ctx).session_recap === false || projectOverBudget(ctx, session.project_id))
    return;
  const facts =
    moment.kind === 'waiting'
      ? waitingFacts(approval!)
      : `The turn ended: ${moment.status}${moment.error ? ` (${moment.error})` : ''}`;
  const prompt = sessionRecapPrompt(turn.input, lastReply(ctx, session.id, turn.id), facts);
  const { since } = ctx.store.db
    .prepare('SELECT coalesce(max(sequence), 0) AS since FROM events WHERE aggregate_id=?')
    .get(session.id) as { since: number };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  void Promise.race([
    Promise.resolve().then(() => summarizer(prompt, controller.signal)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${RECAP_TIMEOUT_MS} ms`));
      }, RECAP_TIMEOUT_MS);
    }),
  ])
    .then((reply) => {
      const fields = parseRecap(reply.text);
      if (!fields) throw new Error('the reply was no recap JSON');
      if (ctx.closing || overtaken(ctx, session.id, since)) return;
      ctx.store.transaction(() => {
        const recap: SessionRecap = {
          ...fields,
          turn_id: turn.id,
          at: ctx.store.now(),
          ...(reply.model ? { model: reply.model } : {}),
        };
        const latest = ctx.store.must<Session>('sessions', session.id);
        const next = ctx.store.update('sessions', { ...latest, recap }, latest.revision);
        ctx.store.event('agent.session.recapped', next, next.project_id, {
          ...recap,
          ...(reply.usage ? { usage: reply.usage } : {}),
        } satisfies SessionRecappedPayload);
      });
      ctx.changed();
    })
    .catch((error: unknown) =>
      console.error(
        `No recap for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    .finally(() => clearTimeout(timer));
}
