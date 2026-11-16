import { expect, it, vi } from 'vitest';
import { workbenchFixture } from './workbench-fixture.js';

it('rechecks each pending job by id instead of listing every pending job again', async () => {
  const f = workbenchFixture();
  await f.control.tick();
  const pending = vi.spyOn(f.store, 'pending');
  await f.control.tick();
  const idle = pending.mock.calls.length;
  for (let i = 0; i < 20; i++) f.store.enqueue('test.ignored', {});
  pending.mockClear();
  await f.control.tick();
  expect(pending.mock.calls.length).toBe(idle);
});
