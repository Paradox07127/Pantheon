import {
  id,
  type AgentMessage,
  type AgentProfile,
  type Session,
  type SignalIssue,
} from '@pantheon/domain';
import { wakeAgent } from './agent-always-on.js';
import { urgentIssue } from './agent-contract.js';
import { ensureAgents } from './agents.js';
import type { ControlContext } from './context.js';

type Sender = { profile: AgentProfile; session: Session };
type MessageInput = Pick<AgentMessage, 'text' | 'urgency'> & { signal_issue_id?: string };

const insertMessage = (ctx: ControlContext, from: Sender, input: MessageInput, routedTo?: string) =>
  ctx.store.insert<AgentMessage>('agent_messages', {
    id: id(),
    revision: 1,
    project_id: from.session.project_id,
    agent_id: from.profile.id,
    session_id: from.session.id,
    text: input.text,
    urgency: input.urgency,
    at: ctx.store.now(),
    ...(routedTo && { routed_to: routedTo }),
  });

/** Leaves the user the agent's message and notifies them; the only producer of agent_message.created. */
export function deliverToUser(
  ctx: ControlContext,
  from: Sender,
  input: MessageInput,
  cause: string,
): AgentMessage {
  const message = insertMessage(ctx, from, input);
  ctx.store.event(
    'agent_message.created',
    message,
    message.project_id,
    { ...message, agent_name: from.profile.name },
    cause,
  );
  return message;
}

/** True when the message cites a signal issue of the project that the project's urgent list names. */
function urgent(ctx: ControlContext, projectId: string, input: MessageInput): boolean {
  const issue =
    input.signal_issue_id !== undefined
      ? ctx.store.get<SignalIssue>('signal_issues', input.signal_issue_id)
      : undefined;
  return urgentIssue(ctx, projectId, issue);
}

/**
 * Delivers the main agent's message, or an urgent one, to the user; the message of any other
 * agent goes to the main agent, which decides what the user hears.
 */
export function tellUser(
  ctx: ControlContext,
  from: Sender,
  input: MessageInput,
  cause: string,
): AgentMessage {
  const projectId = from.session.project_id;
  if (from.profile.template === 'assistant' || urgent(ctx, projectId, input))
    return deliverToUser(ctx, from, input, cause);
  const assistant = ensureAgents(ctx, projectId).find((agent) => agent.template === 'assistant')!;
  const message = insertMessage(ctx, from, input, assistant.id);
  ctx.store.event(
    'agent_message.routed',
    message,
    message.project_id,
    { ...message, agent_name: from.profile.name },
    cause,
  );
  wakeAgent(
    ctx,
    assistant,
    'agent_report',
    `${from.profile.name} (message ${message.id}): ${message.text}`,
    cause,
    { session_id: from.session.id },
  );
  return message;
}
