import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@/data/sync';
import {
  ageText,
  failureText,
  needsYouTrigger,
  reasonText,
  touchesNeedsYou,
} from '@/data/needs-you';
import { nextStepText } from '@/lib/daemon-text';
import { setLocaleSync } from '@/i18n';
import { zh, zhCatalog, zhf } from './i18n-setup.js';

const NOW = 10_000_000;
const reason = (id: string) => zh(`data.reason.${id}`);

const event = (sequence: number, kind: string): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'aggregate',
  aggregate_revision: 1,
  project_id: 'project',
  causation_id: 'command',
  created_at: sequence,
  payload: {},
});

describe('refetch trigger', () => {
  it('reacts to approval and reconciling session events', () => {
    expect(touchesNeedsYou('approval.requested')).toBe(true);
    expect(touchesNeedsYou('approval.void')).toBe(true);
    expect(touchesNeedsYou('session.reconciling')).toBe(true);
    expect(touchesNeedsYou('session.resumed')).toBe(true);
    expect(touchesNeedsYou('session.closed')).toBe(true);
    expect(touchesNeedsYou('session.turn.delivery')).toBe(false);
  });

  it.each([
    'lead.question_asked',
    'lead.question_answered',
    'task.reported',
    'workspace.provisioning',
    'session.gate_checked',
    'project.gate_set',
    'session.gate_run_failed',
    'session.merge_blocked',
    'session.merge_started',
    'session.merged',
    'session.discarded',
    'session.archived',
    'session.unarchived',
    'session.deleted',
    'turn.queued',
    'turn.running',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
    'session.gate_started',
    'session.resume_failed',
    'session.recovered',
    'project.baseline_failed',
    'project.removed',
    'project.restored',
    'task.stop_requested',
    'session.merge_stuck',
    'session.discard_failed',
    'workflow.step_created',
    'workflow.step_changed',
    'workflow.definition_trial_completed',
    'workflow.definition_trial_decided',
    'milestone.created',
    'milestone.revised',
    'milestone.removed',
    'task.accepted',
  ])('refreshes attention after %s', (kind) => {
    expect(touchesNeedsYou(kind)).toBe(true);
  });

  it('is the sequence of the newest relevant event, and 0 without one', () => {
    expect(needsYouTrigger([])).toBe(0);
    expect(needsYouTrigger([event(1, 'session.turn.delivery')])).toBe(0);
    const events = [
      event(1, 'approval.requested'),
      event(2, 'session.reconciling'),
      event(3, 'session.turn.delivery'),
    ];
    expect(needsYouTrigger(events)).toBe(2);
    expect(needsYouTrigger([...events, event(4, 'session.turn.delivery')])).toBe(2);
    expect(needsYouTrigger([...events, event(4, 'approval.approved')])).toBe(4);
  });
});

describe('time text', () => {
  it('shows how long ago an item arrived', () => {
    expect(ageText(NOW - 30_000, NOW)).toBe('刚刚');
    expect(ageText(NOW - 8 * 60_000, NOW)).toBe('8 分钟');
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe('3 小时');
    expect(ageText(NOW - 50 * 3_600_000, NOW)).toBe('2 天');
    expect(ageText(NOW - 65 * 24 * 3_600_000, NOW)).toBe('2 个月');
  });

  it.each(['en', 'zh-CN'] as const)(
    'gives minutes, hours, days and months each their own unit and no "ago" in %s',
    (locale) => {
      setLocaleSync(locale, locale === 'en' ? {} : zhCatalog());
      try {
        const texts = [60_000, 3_600_000, 24 * 3_600_000, 30 * 24 * 3_600_000].map((unit) =>
          ageText(NOW - 5 * unit, NOW),
        );
        expect(new Set(texts.map((text) => text.replace('5', ''))).size).toBe(4);
        for (const text of texts) expect(text).not.toMatch(/ago|前/);
      } finally {
        setLocaleSync('zh-CN', zhCatalog());
      }
    },
  );

  it('reads an item exactly a day old in days, not hours', () => {
    expect(ageText(NOW - 24 * 3_600_000, NOW)).toBe(zhf('data.age.days', { count: 1 }));
  });
});

describe('reason text', () => {
  it.each([
    [
      'turns the approval.respond error codes into Chinese reasons',
      {
        approval_not_pending: 'approvalNotPending',
        gate_retry_unavailable: 'gateRetryUnavailable',
        revision_conflict: 'revisionConflict',
        artifact_commit_missing: 'artifactCommitMissing',
        daemon_restart: 'daemonRestart',
        acceptance_pending: 'acceptancePending',
      },
    ],
    [
      'turns the runtime, git and protocol error codes into Chinese reasons',
      {
        billing_channel_mismatch: 'billingChannelMismatch',
        account_check_timeout: 'accountCheckTimeout',
        native_session_busy: 'nativeSessionBusy',
        git_required: 'gitRequired',
        protocol_mismatch: 'protocolMismatch',
        not_implemented: 'notImplemented',
      },
    ],
  ])('%s', (_, ids) => {
    for (const [code, id] of Object.entries(ids)) expect(reasonText(code), code).toBe(reason(id));
  });

  it.each([
    [
      'adds the daemon message to a failure whose code has no Chinese reason',
      'mystery_code',
      'Run still has missing artifacts',
      'mystery_code：Run still has missing artifacts',
    ],
    [
      'keeps the daemon message after the Chinese reason of a failure',
      'resource_busy',
      'Existing progression must complete before a new goal',
      `${reason('resourceBusy')}（Existing progression must complete before a new goal）`,
    ],
    [
      'asks for another click after a revision conflict, since the board was refreshed',
      'revision_conflict',
      'Supply the current revision',
      `${zh('data.failure.refreshed')}（Supply the current revision）`,
    ],
  ])('%s', (_, code, message, expected) => {
    expect(failureText({ code, message })).toBe(expected);
  });

  it('explains the landing, session and bridge codes the daemon can return', () => {
    for (const code of [
      'rebase_conflict',
      'committer_unknown',
      'invalid_state',
      'invalid_workspace',
      'daemon_unavailable',
      'command_timeout',
      'dependency_folder_skipped',
      'source_metadata_unsupported',
      'root_in_use',
      'merge_commits',
      'protected_paths',
    ])
      expect(reasonText(code), code).not.toBe(code);
    expect(reasonText('command_timeout')).toBe(reason('commandTimeout'));
  });

  it('keeps an unknown code as it is', () => {
    expect(reasonText('daemon_exploded')).toBe('daemon_exploded');
  });

  it('explains landing reasons, keeping the first line of a git failure', () => {
    expect(['clone_dirty', 'detached_head', 'local_changes'].map(reasonText)).toEqual(
      ['cloneDirty', 'detachedHead', 'localChanges'].map(reason),
    );
    expect(reasonText('git_failed: fatal: not a git repository')).toBe(
      'git 失败：fatal: not a git repository',
    );
  });
});

describe('attention kept by the backend', () => {
  it.each([
    'permission_voided',
    'answer_undelivered',
    'task_dispatch_failed',
    'lead_turn_failed',
    'lead_closed',
    'merge_stuck',
    'continuation_limit_reached',
    'workspace_reconciling',
    'stop_unconfirmed',
    'out_of_scope',
    'rebase_interrupted',
    'task_retired',
  ])('explains %s in Chinese', (code) => {
    expect(reasonText(code)).not.toBe(code);
  });

  it.each([
    'session.continuation_skipped',
    'approval.delivery_failed',
    'approval.delivered',
    'board.plan_updated',
    'board.plan_transferred',
    'board.lead_wake_failed',
    'task.start_requested',
    'task.dispatched',
    'task.dispatch_failed',
  ])('refreshes attention after %s', (kind) => {
    expect(touchesNeedsYou(kind)).toBe(true);
  });
});

describe('a lead plan proposal awaiting the user', () => {
  it('names its reason and its next step in Chinese', () => {
    expect(reasonText('plan_proposal_awaiting_decision')).toBe(
      reason('planProposalAwaitingDecision'),
    );
    expect(
      nextStepText({ reason: 'plan_proposal_awaiting_decision', next_step: 'daemon text' }),
    ).toBe(zh('daemon.nextStep.planProposalAwaitingDecision'));
  });

  it.each(['board.plan_proposed', 'board.plan_proposal_resolved', 'board.plan_proposal_withdrawn'])(
    'refreshes attention after %s',
    (kind) => {
      expect(touchesNeedsYou(kind)).toBe(true);
    },
  );
});
