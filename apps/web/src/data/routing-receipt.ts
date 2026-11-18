import type { AgentProfile, Session, SessionTurn } from '@pantheon/domain';
import { t } from '../i18n';
import { listText } from '../lib/list-text';
import { agentName, shownAgents } from './agents';

export type Routing = NonNullable<SessionTurn['routing']>;

/** Where `request.reroute` sends a request again. */
export type RerouteTo = 'answer_here' | 'new_plan' | { lane_id: string } | { agent_id: string };

/** The board's lanes and tasks, whose ids are `<plan session id>:<id in the plan>`, and the project's agents. */
export interface RoutingNames {
  lanes: readonly { id: string; title: string }[];
  tasks: readonly { id: string; title: string }[];
  agents: readonly AgentProfile[];
}

export interface RerouteChoice {
  key: string;
  to: RerouteTo;
  name: string;
}

/** What the resident did with the user's turn, with its lane, tasks and agent named. */
export function routingText(
  turn: Pick<SessionTurn, 'session_id'>,
  routing: Routing,
  names: RoutingNames,
): string {
  const lane = () => {
    const id = `${turn.session_id}:${routing.lane_id}`;
    return (
      names.lanes.find((each) => each.id === id)?.title ??
      routing.lane_title ??
      routing.lane_id ??
      ''
    );
  };
  switch (routing.kind) {
    case 'answered':
      return t({ id: 'data.routingReceipt.answered', defaultMessage: 'Answered here' });
    case 'new_plan':
      return t(
        { id: 'data.routingReceipt.newPlan', defaultMessage: 'New plan {lane}' },
        { lane: lane() },
      );
    case 'added': {
      const ids = routing.task_ids ?? [];
      const titles = ids.map(
        (id, i) =>
          names.tasks.find((task) => task.id === `${turn.session_id}:${id}`)?.title ??
          routing.task_titles?.[i] ??
          id,
      );
      return t(
        {
          id: 'data.routingReceipt.added',
          defaultMessage: 'Added to {lane}, {count, plural, one {task} other {tasks}} {tasks}',
        },
        { lane: lane(), count: ids.length, tasks: listText(...titles) },
      );
    }
    case 'sent': {
      const agent = names.agents.find((each) => each.id === routing.agent_id);
      return t(
        { id: 'data.routingReceipt.sent', defaultMessage: 'Sent to {agent}' },
        { agent: agent ? agentName(agent) : (routing.agent_id ?? '') },
      );
    }
    case 'asked':
      return t({ id: 'data.routingReceipt.asked', defaultMessage: 'Asked you' });
  }
}

/**
 * The routes the user can pick instead, in menu order: answer here, a new plan, each lane of the
 * resident's plan, then each other resident agent; the route the turn took is left out.
 */
export function rerouteChoices(
  turn: Pick<SessionTurn, 'session_id'>,
  routing: Routing,
  resident: Session['resident'],
  names: RoutingNames,
): RerouteChoice[] {
  const plan = `${turn.session_id}:`;
  const choices: RerouteChoice[] = [
    {
      key: 'answer_here',
      to: 'answer_here',
      name: t({ id: 'data.routingReceipt.answerHere', defaultMessage: 'Answer here' }),
    },
    {
      key: 'new_plan',
      to: 'new_plan',
      name: t({ id: 'data.routingReceipt.toNewPlan', defaultMessage: 'New plan' }),
    },
    ...names.lanes
      .filter((lane) => lane.id.startsWith(plan))
      .map((lane): RerouteChoice => {
        const id = lane.id.slice(plan.length);
        return { key: `lane:${id}`, to: { lane_id: id }, name: lane.title };
      }),
    ...shownAgents(names.agents)
      .filter((agent) =>
        resident?.agent_id ? agent.id !== resident.agent_id : agent.template !== resident?.kind,
      )
      .map((agent): RerouteChoice => ({
        key: `agent:${agent.id}`,
        to: { agent_id: agent.id },
        name: t(
          { id: 'data.routingReceipt.sendTo', defaultMessage: 'Send to {agent}' },
          { agent: agentName(agent) },
        ),
      })),
  ];
  const taken =
    routing.kind === 'answered'
      ? 'answer_here'
      : routing.kind === 'new_plan'
        ? 'new_plan'
        : routing.kind === 'added'
          ? `lane:${routing.lane_id}`
          : routing.kind === 'sent'
            ? `agent:${routing.agent_id}`
            : null;
  return choices.filter((choice) => choice.key !== taken);
}
