import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'card', layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import { decisionRow } from '../../apps/web/src/data/decisions-for-user.js';
import type { BoardNeed, NeedItem } from '../../apps/web/src/data/need-actions.js';
import { durationText } from '../../apps/web/src/lib/time-text.js';
import {
  type RunBoardCommand,
  type SnapshotSession,
} from '../../apps/web/src/lib/snapshot-types.js';

const NOW = Date.UTC(2026, 10, 19, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;

const reassessed: NeedItem = {
  source: { table: 'board_plans', id: 'lead-1', revision: 3 },
  kind: 'board.plan.reassessment',
  project_id: 'project-a',
  session_id: 'lead-1',
  status: 'paused',
  created_at: NOW - 14 * MIN,
  reason: 'plan_reassessment_ready',
  decision: 'plan_change',
  blocks: 0,
  primary: 'board.plan.resume',
  actions: [{ command: 'board.plan.resume', allowed: true }],
  reassessment: {
    done: 'The refund endpoint and its idempotency keys are merged.',
    blocked: 'The reconcile report fails 3 unit tests after 2 retries.',
    change: 'Move the report after the rollout switch.',
    at: NOW - 14 * MIN,
  },
};

const question = (id: string, extra: Partial<NeedItem> = {}): BoardNeed =>
  ({
    source: { table: 'board_plans', id: 'lead-1', revision: 6 },
    kind: 'lead.question',
    project_id: 'project-a',
    session_id: 'lead-1',
    request_id: id,
    status: 'pending',
    created_at: NOW - 30 * MIN,
    reason: 'lead_question',
    decision: 'question',
    blocks: 1,
    unblocks: 1,
    plan_title: 'Refunds v2',
    question: {
      id,
      at: NOW - 30 * MIN,
      question: `Which way for ${id}?`,
      options: ['Own endpoint', 'Flag', 'Neither'],
      recommended: 'Flag',
      assumption: 'a flag',
      blocks: [`lead-1:${id}-a`, 'lead-1:shared'],
    },
    actions: [{ command: 'lead.question.answer', allowed: true }],
    ...extra,
  }) as BoardNeed;

const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
  title: 'Refunds lead',
} as SnapshotSession;

type Props = Parameters<typeof RequestCard>[0];

function card(item: NeedItem, who: string, run: RunBoardCommand = vi.fn(async () => null)) {
  const h = mount(() =>
    RequestCard({ item, size: 'compact', who, now: NOW, run, onOpenSession() {} } as Props),
  );
  return { h, run };
}

const button = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('a paused plan with the lead reassessment', () => {
  it('shows what is done, blocked and would change, and resumes the plan', async () => {
    const { h, run } = card(reassessed, 'Refunds lead');
    expect(h.value.props['aria-label']).toBe(
      zhf('components.requestCard.pausedLabel', { plan: 'Refunds lead' }),
    );
    const group = find(
      h.value,
      (n) =>
        n.props.role === 'group' &&
        n.props['aria-label'] === zh('components.requestCard.reassessment'),
    );
    expect(text(group)).toBe(
      [
        zh('components.requestCard.reassessment.done'),
        reassessed.reassessment!.done,
        zh('components.requestCard.reassessment.blocked'),
        reassessed.reassessment!.blocked,
        zh('components.requestCard.reassessment.change'),
        reassessed.reassessment!.change,
      ].join(''),
    );
    button(h.value, zh('board.needs.actions.resumePlan')).props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith(
      'board.plan.resume',
      { project_id: 'project-a', lead_session_id: 'lead-1' },
      null,
    );
  });
});

describe('a lead question with a default deadline', () => {
  it('says when the recommended answer takes effect and keeps the question open', async () => {
    const item = question('q1', { default_at: NOW + 2 * HOUR }) as NeedItem;
    const { h, run } = card(item, 'Refunds lead');
    expect(text(h.value)).toContain(
      zhf('components.requestCard.defaultAt', { duration: durationText(2 * HOUR) }),
    );
    button(h.value, zh('components.requestCard.keepOpen')).props.onClick();
    await h.flush();
    expect(run).toHaveBeenCalledWith(
      'lead.question.keep_open',
      { project_id: 'project-a', lead_session_id: 'lead-1', question_id: 'q1' },
      null,
    );
  });
});

describe('a decision made for the user', () => {
  it('shows a recommendation applied at its deadline as such, and keeps it open to overrule', () => {
    const row = decisionRow({
      kind: 'question_answered',
      at: NOW,
      lead_session_id: 'lead-1',
      question_id: 'q1',
      question: 'Which way for q1?',
      answer: 'Flag',
      citations: [],
      answered_by: 'default',
    });
    expect(row.rule).toBe(zh('trace.approved.rule.defaultAnswer'));
    expect(row.answer).toEqual({
      text: 'Flag',
      overruled: false,
      leadSessionId: 'lead-1',
      questionId: 'q1',
    });
  });
});
