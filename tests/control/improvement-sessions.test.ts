import { afterEach, expect, it } from 'vitest';
import type { Improvement, Session } from '@pantheon/domain';
import { prepareMemoryDelivery, finishMemoryDelivery } from '../../packages/control/dist/memory.js';
import { fixture, user } from '../helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

it('lists scoped sessions using instruction matching and acknowledged experience delivery', () => {
  const f = fixture();
  fixtures.push(f);
  const improvement = f.store.insert<Improvement>('improvements', {
    id: 'scoped-rule',
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    lead_session_id: 'lead',
    retrospective_ids: [],
    status: 'trial',
    proposed_at: 1,
    trial_started_at: 1,
    change: {
      type: 'experience',
      domain: 'backend-logic',
      tier: 't2',
      runtime: f.adapter.name,
      procedure: 'Inspect the schema before changing storage',
    },
  });
  f.store.insert('board_plans', {
    id: 'lead',
    revision: 1,
    project_id: f.project.id,
    tasks: [
      { id: 'storage', kind: { domain: 'backend-logic', tier: 't2' } },
      { id: 'interface', kind: { domain: 'frontend-ui', tier: 't2' } },
      { id: 'small', kind: { domain: 'backend-logic', tier: 't1' } },
    ],
  } as any);
  const session = (id: string, taskId: string, fields: Partial<Session> = {}) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      title: id + ' title',
      state: 'open',
      turn_count: 0,
      task: { lead_session_id: 'lead', id: taskId },
      ...fields,
    });
  const delivered = session('delivered', 'storage');
  const pending = session('pending', 'storage');
  session('different-domain', 'interface');
  session('different-tier', 'small');
  session('different-runtime', 'storage', { runtime: 'other-runtime' });
  session('other-project', 'storage', { project_id: 'other-project' });
  session('diagnostic', 'storage', { runtime_review: {} as any });
  session('archived', 'storage', { archived_at: '2026-11-01T00:00:00Z' });
  const ctx = (f.control as any).ctx;
  const packet = prepareMemoryDelivery(ctx, delivered, 'delivered-turn')!;
  expect(packet.experiences.map((i) => i.id)).toEqual([improvement.id]);
  finishMemoryDelivery(ctx, delivered.id, 'delivered-turn', packet, true);
  const pendingPacket = prepareMemoryDelivery(ctx, pending, 'pending-turn')!;
  finishMemoryDelivery(ctx, pending.id, 'pending-turn', pendingPacket, false);
  const read = () => f.control.improvementSessions(user, f.project.id, improvement.id);
  expect(read()).toEqual([
    { session_id: delivered.id, title: delivered.title, delivered: true },
    { session_id: pending.id, title: pending.title, delivered: false },
  ]);
  // The same signature does not prove a rule omitted by the byte budget was sent.
  finishMemoryDelivery(
    ctx,
    pending.id,
    'pending-turn',
    { ...pendingPacket, experiences: [] },
    true,
  );
  expect(read()[1]!.delivered).toBe(false);
  expect(() => f.control.improvementSessions(user, 'other-project', improvement.id)).toThrow();
  const policy = f.store.insert<Improvement>('improvements', {
    ...improvement,
    id: 'workflow-policy',
    change: { type: 'policy_change', param: 'path', tier: 't2', from: 'dispatch', to: 'direct' },
  });
  expect(f.control.improvementSessions(user, f.project.id, policy.id)).toEqual([]);
});
