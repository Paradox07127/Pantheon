import { expect, it } from 'vitest';
import type { Principal, Project } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  receiveExternalEvent,
  type ExternalEventInput,
} from '../../packages/control/dist/external-events.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const MINUTE = 60_000,
  SUBJECT = 'github:acme/reports#12',
  OWN = {
    author: 'taylor',
    own: true,
    text: 'Totals are wrong\n\nThe weekly total counts refunds twice.',
  };

/** A project that takes external events in the given mode. */
async function intakeFixture(mode: 'approve' | 'auto') {
  const f = await workbenchFixture({ externalSources: [{ id: 'stub', poll: async () => MINUTE }] }),
    ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  f.call(
    'project.externalEvents.set',
    { project_id: f.project.id, mode },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  let reported = 0;
  const report = (fields: Partial<ExternalEventInput> = {}) =>
    receiveExternalEvent(ctx, {
      project_id: f.project.id,
      source: 'github',
      subject_key: SUBJECT,
      dedup_key: `github:501:${reported++}`,
      kind: 'issue_assigned',
      actor: 'taylor',
      actor_trust: 'self',
      title: 'Totals are wrong',
      url: 'https://github.com/acme/reports/issues/12',
      texts: [OWN],
      ...fields,
    });
  const as = (sessionId: string): Principal => ({
    id: `session:${sessionId}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: sessionId,
    expires_at: f.store.now() + 60000,
  });
  return { ...f, report, as };
}

it('shows the user how the project takes events, each source and the events newest first', async () => {
  const f = await intakeFixture('approve');
  f.report({ kind: 'issue_assigned' });
  f.report({ kind: 'mention', actor: 'spam-bot', actor_trust: 'bot' });
  const read = f.control.externalRead(user, f.project.id);
  expect(read.mode).toBe('approve');
  expect(read.sources).toEqual([{ id: 'stub' }]);
  expect(read.held).toEqual([]);
  expect(read.events.map((event) => [event.kind, event.state])).toEqual([
    ['mention', 'dropped'],
    ['issue_assigned', 'pending'],
  ]);
  const session = (await f.create('Explain the answer file')).id;
  expect(() => f.control.externalRead(f.as(session), f.project.id)).toThrow(
    'Authenticated user required',
  );
});
