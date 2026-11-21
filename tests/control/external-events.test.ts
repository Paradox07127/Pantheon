import { expect, it } from 'vitest';
import type { ExternalEvent } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  receiveExternalEvent,
  type ExternalEventInput,
} from '../../packages/control/dist/external-events.js';
import { fixture } from '../helpers.js';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';

const MINUTE = 60_000;

async function eventFixture() {
  const clock = createVirtualClock(1700000000000),
    f = await fixture({ now: clock.now }),
    ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const report = (fields: Partial<ExternalEventInput> = {}) =>
    receiveExternalEvent(ctx, {
      project_id: f.project.id,
      source: 'github',
      subject_key: 'github:acme/reports#12',
      dedup_key: 'github:acme/reports#12:assigned:501',
      kind: 'issue_assigned',
      actor: 'taylor',
      actor_trust: 'self',
      title: 'Totals are wrong',
      url: 'https://github.com/acme/reports/issues/12',
      texts: [],
      ...fields,
    });
  const stored = () => f.store.list<ExternalEvent>('external_events');
  return { ...f, clock, report, stored };
}

it('stores one event when a source reports the same occurrence twice', async () => {
  const f = await eventFixture();
  try {
    const first = f.report();
    f.clock.advance(MINUTE);
    expect(f.report()).toEqual(first);
    expect(f.stored()).toEqual([first]);
    f.report({ dedup_key: 'github:acme/reports#12:comment:9911', kind: 'issue_comment' });
    expect(f.stored()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it.each(['other', 'bot'] as const)('drops an event whose actor is %s', async (actor_trust) => {
  const f = await eventFixture();
  try {
    expect(f.report({ actor_trust })).toMatchObject({ state: 'dropped' });
  } finally {
    await f.close();
  }
});

it.each(['self', 'write'] as const)('keeps an event whose actor is %s', async (actor_trust) => {
  const f = await eventFixture();
  try {
    expect(f.report({ actor_trust })).toMatchObject({ state: 'pending' });
  } finally {
    await f.close();
  }
});
