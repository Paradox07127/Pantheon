import { requireThat, type BoardPlan, type ExternalEvent, type LeadNote } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { ownEntry, projectAccess, type ControlContext, type Handlers } from './context.js';
import { appendNote } from './lead-inbox.js';
import { wakeLead } from './task-tracking.js';

export type ExternalEventInput = Omit<
  ExternalEvent,
  'id' | 'revision' | 'received_at' | 'state' | 'session_id'
> & {
  /** The source's key for this one occurrence, such as github:owner/repo#123:comment:9911. */
  dedup_key: string;
};

/** Stores an event a source reports; a second report of the same occurrence returns the stored one. */
export function receiveExternalEvent(
  ctx: ControlContext,
  input: ExternalEventInput,
): ExternalEvent {
  const { dedup_key, ...fields } = input;
  const id = `${input.project_id}:${dedup_key}`;
  return (
    ctx.store.get<ExternalEvent>('external_events', id) ??
    ctx.store.insert<ExternalEvent>('external_events', {
      ...fields,
      id,
      revision: 1,
      received_at: ctx.store.now(),
      state: input.actor_trust === 'self' || input.actor_trust === 'write' ? 'pending' : 'dropped',
    })
  );
}

// What a held or approved subject asks of the lead, the note's wake template says.
const APPROVED_TEXT = 'The user approved this request.';

/** Stores the plan's holds, leaves its lead the note and wakes the lead. */
function noteTriage(
  ctx: ControlContext,
  plan: BoardPlan,
  holds: BoardPlan['external_holds'],
  text: string,
  cause: string,
  subject: Pick<LeadNote, 'subject_key' | 'source'>,
): void {
  const { external_holds: _holds, ...rest } = plan;
  const next = appendNote(
    ctx,
    ctx.store.update(
      'board_plans',
      holds && Object.keys(holds).length ? { ...rest, external_holds: holds } : rest,
      plan.revision,
    ),
    { at: ctx.store.now(), session_id: '', task_id: '', kind: 'external', text, ...subject },
    cause,
  );
  wakeLead(ctx, next, cause);
}

export const externalEventHandlers: Handlers = {
  'external.approve': (ctx, p, c) => {
    requireThat(
      p.role === 'user',
      'permission_denied',
      'Only user can approve an external request',
    );
    const { project_id, subject_key } = inputSchemas['external.approve'].parse(c.input);
    projectAccess(ctx, p, project_id, c.type);
    const plan = ctx.store
      .list<BoardPlan>('board_plans')
      .find(
        (candidate) =>
          candidate.project_id === project_id &&
          ownEntry(candidate.external_holds, subject_key) !== undefined,
      );
    requireThat(plan, 'invalid_state', 'This request does not wait for approval');
    const { [subject_key]: _held, ...holds } = plan.external_holds!;
    ctx.store.event('board.external_approved', plan, project_id, { subject_key }, c.command_id);
    noteTriage(ctx, plan, holds, `${APPROVED_TEXT}\nSubject: ${subject_key}`, c.command_id, {
      subject_key,
    });
    return ctx.store.must<BoardPlan>('board_plans', plan.id);
  },
};
