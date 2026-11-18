import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { Milestones } from '../../apps/web/src/screens/board/Charts.js';
import { TaskDrawer } from '../../apps/web/src/screens/board/TaskDrawer.js';
import {
  tellLead,
  tellLeadDraft,
  type SnapshotMilestone,
  type SnapshotSession,
} from '../../apps/web/src/screens/board/panels-model.js';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 1, 12);
const noop = () => {};
const run = async () => null;

const lead = (
  state: SnapshotSession['state'],
  extra: Partial<SnapshotSession> = {},
): SnapshotSession => ({
  id: 'lead-1',
  revision: 4,
  project_id: 'project-a',
  runtime: 'fixture',
  state,
  turn_count: 1,
  ...extra,
});

const board = (): BoardModel => ({
  since: NOW - 86_400_000,
  now: NOW,
  headline: null,
  counts: {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    cost_usd: null,
  },
  lanes: [],
  tasks: [
    {
      id: 'lead-1:importer',
      title: 'ship the importer',
      goal: '',
      scope: [],
      lane_id: null,
      milestone_id: null,
      status: 'todo',
      blockers: [],
      segments: [],
      additions: null,
      deletions: null,
      checks: 'none',
      started_at: null,
      ended_at: null,
      last_progress_at: null,
      blocked_since: null,
      turn_running: false,
      owner_session_id: 'lead-1',
    },
  ],
  edges: [],
  milestones: [],
  burnup: [],
  goals: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  usage: [],
  models: [],
  merges: [],
  findings: [],
  risks: [],
});

describe('tell the lead', () => {
  it('sends to an open lead and steers a running one', () => {
    expect(tellLead(lead('open'))).toEqual({
      type: 'session.send',
      enabled: true,
      reason: null,
    });
    expect(tellLead(lead('running'))).toEqual({
      type: 'session.steer',
      enabled: true,
      reason: null,
    });
  });

  it('is off for a closed lead, a lead whose stop is pending, and a missing lead', () => {
    expect(tellLead(lead('closed'))).toEqual({
      type: 'session.send',
      enabled: false,
      reason: zh('data.transcript.compose.closedSend'),
    });
    expect(tellLead(lead('open', { stop_pending: true }))).toEqual({
      type: 'session.send',
      enabled: false,
      reason: zh('data.transcript.busy.stopPending'),
    });
    const missing = tellLead(undefined);
    expect(missing.enabled).toBe(false);
    expect(missing.reason).toBe(zh('board.tellLead.leadGone'));
  });

  it('drafts a line naming the task or milestone with its plan id', () => {
    expect(tellLeadDraft('task', 'ship the importer', 'lead-1:importer')).toBe(
      '关于任务「ship the importer」（importer）：\n',
    );
    expect(tellLeadDraft('milestone', 'first release', 'release-1')).toBe(
      '关于里程碑「first release」（release-1）：\n',
    );
  });

  it('puts the message box in the drawer of a lead task and the button on a lead milestone row', () => {
    const drawer = renderToStaticMarkup(
      createElement(TaskDrawer, {
        model: board(),
        taskId: 'lead-1:importer',
        onSelect: noop,
        onOpenSession: noop,
        onOpenStory: noop,
        tell: { sessions: [lead('open')], run },
      }),
    );
    expect(drawer).toContain('<textarea rows="2" aria-label="告诉主会话">');

    const stored: SnapshotMilestone = {
      id: 'ms-1',
      revision: 2,
      project_id: 'project-a',
      title: 'first release',
      required_sessions: [],
      criteria: [],
      created_at: NOW,
      updated_by: 'lead-1',
      owner_session_id: 'lead-1',
      key: 'release-1',
    } as SnapshotMilestone;
    const html = renderToStaticMarkup(
      createElement(Milestones, {
        model: {
          ...board(),
          milestones: [
            {
              id: 'ms-1',
              title: 'first release',
              session_ids: [],
              merged: 0,
              status: 'active',
              criteria: [],
              owner_session_id: 'lead-1',
              tasks: { done: 0, total: 1 },
            },
          ],
        },
        actions: {
          projectId: 'project-a',
          milestones: [stored],
          sessions: [lead('closed')],
          run,
        },
      }),
    );
    expect(html).toContain('aria-label="告诉主会话 first release"');
    expect(html).toContain('aria-disabled="true"');
  });
});
