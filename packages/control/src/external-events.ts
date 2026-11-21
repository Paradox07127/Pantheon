import type { ExternalEvent } from '@pantheon/domain';
import type { ControlContext } from './context.js';

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
