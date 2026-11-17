import { expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { releaseIdleConversation } from '../../packages/control/dist/session.js';
import { eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it('records an idle conversation as closed after its adapter stops reporting the exited process', async () => {
  const f = await workbenchFixture();
  const session = await f.create('Start the export');
  await settle(f, session);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const idle = f.store.must<Session>('sessions', session.id);
  const handle = [...ctx.handles.values()].find((h) => h.platform_session_id === session.id);
  expect(handle).toBeDefined();
  expect(handle!.process_identity).toBeUndefined();
  expect(idle.process_identity).toBeUndefined();
  releaseIdleConversation(ctx, idle);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.process_closed'])
        .some((event) => event.aggregate_id === session.id),
    () => f.control.tick(),
  );
  expect(f.store.must<Session>('sessions', session.id).state).toBe('open');
});
