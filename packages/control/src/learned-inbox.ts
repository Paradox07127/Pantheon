import type {
  AgentProfile,
  AgentProposal,
  MemoryRecord,
  Principal,
  Project,
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
  ctx.store.must<Project>('projects', projectId);
  const items: LearnedItem[] = [];

  for (const row of improvementList(ctx, principal, projectId)) {
    const change = row.change;
    const decide = (...decisions: string[]) =>
      decisions.map((decision) => ({ command: 'improvement.decide', decision }));
    items.push({
      kind: change.type,
      id: row.id,
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
          : { from: text(change.from), to: text(change.to) },
      evidence: [
        ...row.retrospective_ids.map((id) => ({ kind: 'retrospective', id })),
        ...(row.evidence ?? []),
      ],
      ...(row.trial?.verdict && { verdict: row.trial.verdict }),
      ...(row.trial && { n: row.trial.tasks_seen }),
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
    const target = ctx.store.must<AgentProfile>('agents', proposal.agent_id) as unknown as Record<
      string,
      unknown
    >;
    const shown = (of: Record<string, unknown>) =>
      text(names.length === 1 ? of[names[0]!] : Object.fromEntries(names.map((n) => [n, of[n]])));
    items.push({
      kind: 'agent_change',
      id: proposal.id,
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
      grade: 'confirm',
      status: r.state,
      group: memoryGroup[r.state],
      diff: { from: '', to: body(ctx, r).text },
      evidence: [{ kind: 'session', id: session.id }],
      actions: memoryActions(r.state),
      at: r.created_at,
    });
  }

  return items.sort((a, b) => b.at - a.at);
}
