import {
  canonical,
  DomainError,
  id,
  requireThat,
  type Principal,
  type Project,
  type SettingProposal,
  type WorkflowPolicy,
} from '@pantheon/domain';
import {
  inputSchemas,
  prettifyError,
  type Command,
  type ProjectSettingProposals,
} from '@pantheon/protocol';
import { tellAnswers } from './conductor.js';
import {
  insert,
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handler,
  type Preparers,
} from './context.js';
import {
  gateRoot,
  SETTING_PROPOSALS as TABLE,
  type ProposedSetting as Proposed,
} from './needs-you-settings.js';
import { projectHandlers, projectPreparers } from './project.js';
import { sessionDefaults } from './user-config.js';
import { workflowPolicy, workflowPolicyHandlers } from './workflow-policy.js';

/** The most proposals of one project that wait for the user at a time. */
const PENDING_LIMIT = 5;

/** The schema a proposed input must fit; a budget is the one workflow setting a main agent proposes. */
const proposedInput = (command: SettingProposal['command']) =>
  command === 'workflow.policy.set'
    ? inputSchemas[command]
        .pick({ project_id: true, project_budget: true })
        .required({ project_budget: true })
    : inputSchemas[command];

/** The current value of what the input changes. */
function settingNow(ctx: ControlContext, proposed: Proposed): Record<string, unknown> {
  const { command, input } = proposed;
  const project = ctx.store.must<Project>('projects', input.project_id as string);
  if (command === 'project.gate.set') {
    const root = gateRoot(proposed)!;
    return {
      commands: project.gates?.[root] ?? [],
      ...(input.protected_paths === undefined
        ? {}
        : { protected_paths: project.protected_paths?.[root] ?? [] }),
    };
  }
  if (command === 'workflow.policy.set') {
    const budget = workflowPolicy(ctx, project.id).project_budget;
    return { project_budget: budget ? { input_tokens: budget.input_tokens } : null };
  }
  if (command === 'project.sessionDefaults.set')
    return { session_defaults: project.session_defaults ?? null };
  return { overrides: project.extension_overrides?.[input.runtime as string] ?? null };
}

/** A value of the input that only the user picks, named for the refusal. */
function userOnlyValue({ command, input }: Proposed): string | undefined {
  if (
    command === 'project.sessionDefaults.set' &&
    ['auto', 'full_access'].includes(input.permission_mode as string)
  )
    return `the permission mode ${input.permission_mode as string}`;
  // The model writes no numbers, so a gate timeout comes only from the user.
  if (
    command === 'project.gate.set' &&
    (input.commands as { timeout_ms?: number }[]).some((each) => each.timeout_ms !== undefined)
  )
    return 'the timeout_ms of a gate command';
}

/** conductor.propose_setting */
const proposeSetting: Handler = (ctx, p, command) => {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const projectId = p.project_id ?? '';
  projectAccess(ctx, p, projectId, command.type);
  revision(ctx, command);
  const proposal = inputSchemas['conductor.propose_setting'].parse(command.input);
  const parsed = proposedInput(proposal.command).safeParse({
    ...proposal.input,
    project_id: projectId,
  });
  if (!parsed.success) throw new DomainError('invalid_input', prettifyError(parsed.error));
  let proposed: Proposed = { command: proposal.command, input: parsed.data };
  const userValue = userOnlyValue(proposed);
  requireThat(!userValue, 'invalid_input', `Only the user sets ${userValue}`);
  const project = ctx.store.must<Project>('projects', projectId);
  const root = gateRoot(proposed);
  requireThat(
    root === undefined || project.roots.includes(root),
    'invalid_input',
    'Gate root is not a project root',
  );
  if (root !== undefined) {
    // A command the user gave a timeout keeps it.
    const now = project.gates?.[root] ?? [];
    const commands = (proposed.input.commands as { name: string; argv: string[] }[]).map((each) => {
      const timeout = now.find(
        (c) => c.name === each.name && canonical(c.argv) === canonical(each.argv),
      )?.timeout_ms;
      return timeout === undefined ? each : { ...each, timeout_ms: timeout };
    });
    proposed = { ...proposed, input: { ...proposed.input, commands } };
  }
  const pending = ctx.store
    .list<SettingProposal>(TABLE)
    .filter((row) => row.project_id === projectId && row.state === 'pending');
  const same = pending.find((row) => row.command === proposed.command && gateRoot(row) === root);
  requireThat(
    !same,
    'resource_busy',
    `Proposal ${same?.id} of ${proposed.command}${root ? ` for ${root}` : ''} waits for the user; propose again once the user answers it`,
  );
  requireThat(
    pending.length < PENDING_LIMIT,
    'resource_busy',
    `At most ${PENDING_LIMIT} proposals wait for the user at a time; these wait: ${pending
      .map((row) => `${row.id} (${row.command})`)
      .join(', ')}`,
  );
  const row = insert<SettingProposal>(
    ctx,
    TABLE,
    {
      id: id(),
      revision: 1,
      project_id: projectId,
      session_id: p.session_id!,
      ...proposed,
      reason: proposal.reason,
      state: 'pending',
      before: {
        ...settingNow(ctx, proposed),
        // What applies while the project has no session defaults of its own; approval does not compare it.
        ...(proposed.command === 'project.sessionDefaults.set' && {
          inherited: project.session_defaults ? null : (sessionDefaults(ctx, project) ?? null),
        }),
      },
      created_at: ctx.store.now(),
    },
    'setting.proposed',
    projectId,
    command.command_id,
  );
  return { proposal_id: row.id };
};

/** The pending proposal the command answers, at the revision it names. */
function answered(ctx: ControlContext, p: Principal, command: Command) {
  userOnly(p);
  const input = inputSchemas['setting.proposal.respond'].parse(command.input);
  const proposal = ctx.store.must<SettingProposal>(TABLE, input.proposal_id);
  projectAccess(ctx, p, proposal.project_id, command.type);
  revision(ctx, command, proposal);
  requireThat(proposal.state === 'pending', 'invalid_state', 'The user already answered it');
  return { proposal, decision: input.decision };
}

/** The proposed command as the user sends it, at the current revision of what it changes. */
function userCommand(ctx: ControlContext, proposal: SettingProposal, command: Command): Command {
  return {
    ...command,
    type: proposal.command,
    input: proposal.input,
    expected_revision:
      proposal.command === 'workflow.policy.set'
        ? (ctx.store.get<WorkflowPolicy>('workflow_policies', proposal.project_id)?.revision ??
          null)
        : ctx.store.must<Project>('projects', proposal.project_id).revision,
  };
}

/** Records the answer and tells the main agent that proposed it. */
function decide(
  ctx: ControlContext,
  proposal: SettingProposal,
  state: 'approved' | 'rejected' | 'failed',
  command: Command,
  error?: string,
) {
  const next = ctx.store.update<SettingProposal>(
    TABLE,
    { ...proposal, state, decided_at: ctx.store.now(), ...(error ? { error } : {}) },
    proposal.revision,
  );
  ctx.store.event(
    'setting.proposal_decided',
    next,
    next.project_id,
    { state, ...(error ? { error } : {}) },
    command.command_id,
  );
  tellAnswers(ctx, proposal.session_id, command.command_id);
  return { proposal_id: next.id, state };
}

/** A refusal that commits the failed row; execute raises it once the transaction ends. */
function fail(ctx: ControlContext, proposal: SettingProposal, command: Command, error: unknown) {
  if (!(error instanceof DomainError)) throw error;
  decide(ctx, proposal, 'failed', command, error.message);
  return { error: error.code, message: error.message };
}

/** setting.proposal.respond; an approved gate change reads its root's git before the transaction. */
function prepareRespond(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Handler | Promise<Handler> {
  const { proposal, decision } = answered(ctx, p, command);
  if (decision === 'reject')
    return (ctx, p, command) =>
      decide(ctx, answered(ctx, p, command).proposal, 'rejected', command);
  const approve =
    (run: Handler): Handler =>
    (ctx, p, command) => {
      const { proposal } = answered(ctx, p, command);
      const { inherited: _inherited, ...before } = proposal.before;
      if (canonical(settingNow(ctx, proposal)) !== canonical(before))
        return fail(
          ctx,
          proposal,
          command,
          new DomainError('invalid_state', 'The setting changed since it was proposed'),
        );
      try {
        run(ctx, p, userCommand(ctx, proposal, command));
      } catch (error) {
        return fail(ctx, proposal, command, error);
      }
      return decide(ctx, proposal, 'approved', command);
    };
  if (proposal.command === 'workflow.policy.set')
    return approve(workflowPolicyHandlers[proposal.command]!);
  if (proposal.command !== 'project.gate.set') return approve(projectHandlers[proposal.command]!);
  let prepared: Handler | Promise<Handler>;
  try {
    prepared = projectPreparers[proposal.command]!(ctx, p, userCommand(ctx, proposal, command));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    prepared = () => {
      throw error;
    };
  }
  return prepared instanceof Promise ? prepared.then(approve) : approve(prepared);
}

/** project.setting_proposals */
export function projectSettingProposals(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectSettingProposals {
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must('projects', projectId);
  return {
    proposals: ctx.store
      .list<SettingProposal>(TABLE)
      .filter((row) => row.project_id === projectId && row.state === 'approved')
      .sort((a, b) => b.decided_at! - a.decided_at!),
  };
}

export const settingProposalPreparers: Preparers = {
  'conductor.propose_setting': () => proposeSetting,
  'setting.proposal.respond': prepareRespond,
};
