import type {
  AgentProfile,
  AgentProposal,
  BoardPlan,
  MemoryRecord,
  Principal,
  Project,
  Retrospective,
  Session,
  StoredWorkflowDefinition,
} from '@pantheon/domain';
import type { LearnedItem } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { improvementList } from './improvements.js';
import { body, records } from './memory-access.js';
import { workflowDefinition } from './workflow-engine.js';

/** How far back agent-written notes are listed, in milliseconds. */
const NOTE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const text = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const memoryGroup = { draft: 'needs_you', active: 'in_force', archived: 'reverted' } as const;
const memoryActions = (state: MemoryRecord['state']) =>
  state === 'draft'
    ? [{ command: 'memory.commit' }, { command: 'memory.archive' }]
    : state === 'active'
      ? [{ command: 'memory.archive' }]
      : [];

/** Every learned change of the project, newest first. */
export function learnedList(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): LearnedItem[] {
  projectAccess(ctx, principal, projectId, 'learned.list');
  const project = ctx.store.must<Project>('projects', projectId);
  const items: LearnedItem[] = [];

  for (const row of improvementList(ctx, principal, projectId)) {
    const change = row.change;
    const decide = (...decisions: string[]) =>
      decisions.map((decision) => ({ command: 'improvement.decide', decision }));
    items.push({
      kind: change.type,
      id: row.id,
      ...((change.type === 'policy_change' && { title: change.param }) ||
        (change.type === 'experience' && {
          title: change.procedure.split(/(?<=[.!?])\s/)[0]!,
        }) ||
        (change.type === 'gate_command' && { title: change.root }) ||
        (change.type === 'agent_instructions' && {
          title: ctx.store.get<AgentProfile>('agents', change.agent_id)?.name,
        }) ||
        (change.type === 'playbook' && { title: change.runtime ?? 'default' })),
      ...((change.type === 'gate_command' && { scope: { root: change.root } }) ||
        (change.type === 'policy_change' && change.tier && { scope: { tier: change.tier } }) ||
        (change.type === 'experience' &&
          (change.domain || change.tier || change.runtime) && {
            scope: {
              ...(change.domain && { domain: change.domain }),
              ...(change.tier && { tier: change.tier }),
              ...(change.runtime && { runtime: change.runtime }),
            },
          })),
      grade: row.grade,
      status: row.status,
      group:
        row.status === 'candidate'
          ? 'needs_you'
          : row.status === 'trial'
            ? 'on_trial'
            : row.status === 'active'
              ? 'in_force'
              : 'reverted',
      diff:
        change.type === 'experience'
          ? {
              from: '',
              to: [change.procedure, change.countercondition].filter(Boolean).join('\n'),
            }
          : {
              // A change records what it replaced only once confirmed; until then that is today's value.
              from: text(
                row.status !== 'candidate'
                  ? change.from
                  : change.type === 'gate_command'
                    ? project.gates?.[change.root]
                    : change.type === 'worktree_setup'
                      ? project.worktree
                      : change.type === 'agent_instructions'
                        ? ctx.store.get<AgentProfile>('agents', change.agent_id)?.instructions
                        : change.from,
              ),
              to: text(change.to),
            },
      evidence: [
        ...row.retrospective_ids.map((id) => ({ kind: 'retrospective', id })),
        ...(row.evidence ?? []).map((entry) =>
          entry.kind === 'eval_receipt'
            ? { kind: entry.kind, id: entry.path, title: entry.verdict }
            : entry,
        ),
      ],
      ...(row.trial?.verdict && { verdict: row.trial.verdict }),
      ...(row.trial && { n: row.trial.tasks_seen }),
      ...(row.status === 'trial' && row.trial && { tasks_required: row.trial.tasks_required }),
      actions:
        row.status === 'candidate'
          ? decide('confirm', 'reject')
          : row.status === 'trial' || row.status === 'active'
            ? decide('revert', ...(change.type === 'policy_change' ? ['pin'] : []))
            : [],
      at: row.proposed_at,
    });
  }

  for (const proposal of ctx.store.list<AgentProposal>('agent_proposals')) {
    if (proposal.project_id !== projectId || !proposal.agent_id) continue;
    const fields: Record<string, unknown> = { ...proposal.fields, ...proposal.edited_fields };
    const names = Object.keys(fields);
    const target = ctx.store.get<AgentProfile>('agents', proposal.agent_id) as unknown as
      Record<string, unknown> | undefined;
    if (!target) continue;
    const shown = (of: Record<string, unknown>) =>
      text(names.length === 1 ? of[names[0]!] : Object.fromEntries(names.map((n) => [n, of[n]])));
    items.push({
      kind:
        names.length === 1 && names[0] === 'instructions' ? 'agent_instructions' : 'agent_change',
      id: proposal.id,
      title: target.name as string,
      grade: 'confirm',
      status: proposal.state,
      group:
        proposal.state === 'pending'
          ? 'needs_you'
          : proposal.state === 'changed'
            ? 'in_force'
            : 'reverted',
      // A changed agent no longer holds the values the change replaced.
      diff: { from: proposal.state === 'changed' ? '' : shown(target), to: shown(fields) },
      evidence: [{ kind: 'session', id: proposal.session_id }],
      actions:
        proposal.state === 'pending'
          ? (['create', 'decline'] as const).map((decision) => ({
              command: 'agent.proposal.resolve',
              decision,
            }))
          : [],
      at: proposal.at,
    });
  }

  for (const row of ctx.store.list<StoredWorkflowDefinition>('workflow_definitions')) {
    if (row.project_id !== projectId || !row.trial) continue;
    const done = row.trial.done === row.trial.tasks;
    items.push({
      kind: 'workflow_definition',
      id: row.id,
      grade: 'trial',
      status: 'trial',
      group: done ? 'needs_you' : 'on_trial',
      diff: {
        from: text(
          workflowDefinition(ctx, projectId, row.trial.previous_version, row.id).definition,
        ),
        to: text(row.definition),
      },
      evidence: [],
      n: row.trial.done,
      ...(!done && { tasks_required: row.trial.tasks }),
      actions: done
        ? (['keep', 'revert'] as const).map((decision) => ({
            command: 'workflow.definition.trial.decide',
            decision,
          }))
        : [],
      at: row.trial.started_at,
    });
  }

  const memory = records(ctx, projectId);
  const replaced = (r: MemoryRecord) => memory.find((other) => other.superseded_by === r.id);
  const since = ctx.store.now() - NOTE_DAYS_MS;
  for (const r of memory) {
    if (
      r.authority !== 'agent_reported' ||
      r.kind !== 'note' ||
      !r.author_session_id ||
      r.superseded_by ||
      r.created_at < since
    )
      continue;
    const before = replaced(r);
    items.push({
      kind: 'memory_note',
      id: r.id,
      title: r.title ?? r.key,
      revision: r.revision,
      grade: 'auto',
      status: r.state,
      group: memoryGroup[r.state],
      diff: { from: before ? body(ctx, before).text : '', to: body(ctx, r).text },
      evidence: [{ kind: 'session', id: r.author_session_id }],
      actions: memoryActions(r.state),
      at: r.created_at,
    });
  }

  for (const session of ctx.store.list<Session>('sessions')) {
    const memoryId = session.runtime_review?.memory_id;
    if (session.project_id !== projectId || !memoryId) continue;
    const r = ctx.store.must<MemoryRecord>('memory_records', memoryId);
    items.push({
      kind: 'runtime_review',
      id: r.id,
      title: r.title ?? r.key,
      revision: r.revision,
      grade: 'confirm',
      status: r.state,
      group: memoryGroup[r.state],
      diff: { from: '', to: body(ctx, r).text },
      evidence: [{ kind: 'session', id: session.id }],
      actions: memoryActions(r.state),
      at: r.created_at,
    });
  }

  const evidenceTitle = ({ kind, id }: LearnedItem['evidence'][number]) => {
    if (kind === 'session') return ctx.store.get<Session>('sessions', id)?.title;
    if (kind !== 'retrospective') return undefined;
    const row = ctx.store.get<Retrospective>('retrospectives', id);
    return (
      row &&
      ctx.store
        .get<BoardPlan>('board_plans', row.lead_session_id)
        ?.tasks.find((task) => task.id === row.task_id)?.title
    );
  };
  for (const item of items)
    item.evidence = item.evidence.map((entry) => {
      const title = evidenceTitle(entry);
      return title === undefined ? entry : { ...entry, title };
    });
  return items.sort((a, b) => b.at - a.at);
}
