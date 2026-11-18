import { requireThat, type LeadQuestion, type Principal } from '@pantheon/domain';
import type { Command, CommandType, PersonalAnswerKind, QueryMethod } from '@pantheon/protocol';
import { readAppSettings } from './app-settings.js';
import type { ControlContext } from './context.js';
import { projectOverBudget } from './workflow-policy.js';

/** The queries a personal principal may make, for every project. */
export const PERSONAL_QUERIES = [
  'projects.summary',
  'needs_you.list',
  'project.brief',
  'project.decisions',
] as const satisfies readonly QueryMethod[];

/** The commands a personal principal may send. */
export const PERSONAL_COMMANDS = [
  'project.seen',
  'request.send',
  'lead.question.answer',
  'board.plan.proposal.resolve',
  'board.lane.approve',
  'milestone.accept',
] as const satisfies readonly CommandType[];

export const OUTSIDE_PERSONAL_SCOPE = "Outside the personal agent's scope";

const ANSWER_KINDS = {
  'lead.question.answer': 'question',
  'board.plan.proposal.resolve': 'plan_change',
  'board.lane.approve': 'plan_change',
  'milestone.accept': 'milestone_accept',
} as const satisfies Partial<Record<CommandType, PersonalAnswerKind>>;

type AnswerCommand = keyof typeof ANSWER_KINDS;

/** The id of the personal key the principal holds. */
export const personalKeyId = (p: Principal) => p.id.slice('personal:'.length);

/** Refuses a personal principal a query not on its list. */
export function personalQuery(p: Principal, method: string): void {
  requireThat(
    p.role !== 'personal' || (PERSONAL_QUERIES as readonly string[]).includes(method),
    'permission_denied',
    OUTSIDE_PERSONAL_SCOPE,
  );
}

/** Refuses a personal principal a command not on its list. */
export function personalCommand(p: Principal, command: Command): void {
  requireThat(
    p.role !== 'personal' || (PERSONAL_COMMANDS as readonly string[]).includes(command.type),
    'permission_denied',
    OUTSIDE_PERSONAL_SCOPE,
  );
}

/**
 * Refuses a personal principal an answer of a kind the user did not turn on, a relayed worker
 * question, which answers a permission prompt, and a plan change that must reach the user.
 */
export function personalAnswer(
  ctx: ControlContext,
  p: Principal,
  type: AnswerCommand,
  projectId: string,
  question?: LeadQuestion,
): void {
  if (p.role !== 'personal') return;
  requireThat(
    readAppSettings(ctx).personal_answers.includes(ANSWER_KINDS[type]),
    'permission_denied',
    'The user has not let the personal agent answer this kind of decision',
  );
  requireThat(
    !question?.source,
    'permission_denied',
    "Only the user answers a task session's question",
  );
  // mustAsk's plan_change rule; importing must-ask.ts here loops back through context.ts at load.
  requireThat(
    ANSWER_KINDS[type] !== 'plan_change' || !projectOverBudget(ctx, projectId),
    'permission_denied',
    'Over budget, only the user decides a plan change',
  );
}

/** Records a write a personal principal made; the caller owns the transaction. */
export function personalCalled(
  ctx: ControlContext,
  p: Principal,
  command: Command,
  projectId: string,
): void {
  if (p.role !== 'personal') return;
  const keyId = personalKeyId(p);
  ctx.store.event(
    'personal.called',
    { id: keyId, revision: 1 },
    projectId,
    { key_id: keyId, type: command.type, project_id: projectId },
    command.command_id,
  );
}
