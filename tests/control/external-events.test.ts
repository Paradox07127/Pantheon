import { expect, it } from 'vitest';
import type { ExternalEvent } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  receiveExternalEvent,
  settledExternalEvents,
  type ExternalEventInput,
} from '../../packages/control/dist/external-events.js';
import { fixture } from '../helpers.js';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';

const MINUTE = 60_000;

function eventFixture() {
  const clock = createVirtualClock(1700000000000),
    f = fixture({ now: clock.now }),
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
  const settled = () =>
    settledExternalEvents(ctx).map((events) => events.map((event) => event.kind));
  return { ...f, clock, report, stored, settled };
}

it('stores one event when a source reports the same occurrence twice', async () => {
  const f = eventFixture();
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

it.each(['other', 'bot'] as const)(
  'drops an event whose actor is %s and never hands it on',
  async (actor_trust) => {
    const f = eventFixture();
    try {
      expect(f.report({ actor_trust })).toMatchObject({ state: 'dropped' });
      f.clock.advance(10 * MINUTE);
      expect(f.settled()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it.each(['self', 'write'] as const)('keeps an event whose actor is %s', async (actor_trust) => {
  const f = eventFixture();
  try {
    expect(f.report({ actor_trust })).toMatchObject({ state: 'pending' });
  } finally {
    await f.close();
  }
});

it('hands on the events about one subject together once the subject was quiet for two minutes', async () => {
  const f = eventFixture();
  try {
    f.report({ dedup_key: 'assigned', kind: 'issue_assigned' });
    f.report({
      subject_key: 'github:acme/reports#40',
      dedup_key: 'review',
      kind: 'review_requested',
    });
    expect(f.settled()).toEqual([]);
    f.clock.advance(MINUTE);
    f.report({ dedup_key: 'comment-1', kind: 'issue_comment' });
    f.clock.advance(MINUTE / 2);
    f.report({ dedup_key: 'comment-2', kind: 'issue_labeled' });
    f.clock.advance(MINUTE / 2);
    expect(f.settled()).toEqual([['review_requested']]);
    f.clock.advance(MINUTE + MINUTE / 2);
    expect(f.settled()).toEqual([
      ['issue_assigned', 'issue_comment', 'issue_labeled'],
      ['review_requested'],
    ]);
  } finally {
    await f.close();
  }
});
