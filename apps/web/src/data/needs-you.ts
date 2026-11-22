import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalQuestion, GateFailureClass } from '@pantheon/domain';
import type { BridgeResult, DesktopBridge } from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import type { DaemonEvent } from './sync';

/** One item of GET /v1/needs_you.list, as the daemon's domain package defines it. */
export interface NeedsYouItem {
  source: {
    table:
      | 'approvals'
      | 'sessions'
      | 'workflow_policies'
      | 'memory_records'
      | 'setting_change_proposals';
    id: string;
    revision: number;
  };
  kind:
    | 'permission'
    | 'session.reconciling'
    | 'session.failed'
    | 'session.gate_failed'
    | 'session.merge_blocked'
    | 'project.over_budget'
    | 'memory.decision_budget'
    | 'setting.proposed';
  project_id: string;
  /** The approval's session; absent on session items, whose source is the session. */
  session_id?: string;
  /** The turn and native request of a lost request or an undelivered answer. */
  turn_id?: string;
  request_id?: string;
  status: string;
  created_at: number;
  reason:
    | 'permission_requested'
    | 'permission_voided'
    | 'answer_undelivered'
    | 'reconciliation_required'
    | 'session_failed'
    | 'non_writer_write_detected'
    | 'outside_worktree_write_detected'
    | 'gate_failed'
    | 'merge_blocked'
    | 'merge_stuck'
    | 'workspace_reconciling'
    | 'stop_unconfirmed'
    | 'usage_limit_reached'
    | 'session_turn_stalled'
    | 'background_task_long'
    | 'project_over_budget'
    | 'plan_decisions_over_budget'
    | 'setting_proposed';
  /** What the user decides. */
  decision?: 'question' | 'permission' | 'budget' | 'other';
  /** The command of the item's one primary action. */
  primary?: string;
  actions: {
    command: string;
    allowed: boolean;
    disabled_reason?: string;
    decision?: 'approve' | 'reject' | 'keep' | 'revert';
  }[];
  /** When a session that used up its usage limit can go on, in Unix milliseconds. */
  resets_at?: number;
  /** The background task that has run too long; session.background.stop takes its id. */
  background?: {
    id: string;
    kind: 'shell' | 'agent' | 'other';
    description: string;
    started_at: number;
  };
  /** How long a permission request has waited for an answer, in milliseconds; set once it is escalated. */
  waited_ms?: number;
  /** Set on a permission request that stayed unanswered past the escalation window. */
  escalated?: true;
  /** Why the gate of a failed gate or a merge blocked by its gate failed, when that is known. */
  failure_class?: GateFailureClass;
  /** The protected files whose change holds the session's merge for the user's leave. */
  files?: string[];
  /** The questions of a pending AskUserQuestion request, as it asked them. */
  questions?: ApprovalQuestion[];
  binding?: {
    action?: string;
    input_hash?: string;
    /** Request input as one line of at most 300 characters; absent when the request has no input. */
    input_summary?: string;
    /** What an allow for the session adds; absent when the request cannot be allowed for the session. */
    rule?: string;
    /** The request can be allowed for every session of the project. */
    project_rule_supported?: boolean;
  };
  /** Who acts next and how. */
  next_step?: string;
}

export interface Availability {
  enabled: boolean;
  reason: string | null;
}

export interface NeedsYouState {
  /**
   * null until a read succeeds; never an empty stand-in for a failure. A failed read keeps the
   * last items, which are no authority for an answer while `error` is set.
   */
  items: NeedsYouItem[] | null;
  /** A read is out and no items show yet. */
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Event kinds after which the list may have changed. */
export function touchesNeedsYou(kind: string): boolean {
  return (
    kind.startsWith('approval.') ||
    [
      'session.reconciling',
      'session.resume_failed',
      'session.resumed',
      'session.recovered',
      'session.closed',
      'workspace.provisioning',
      'workspace.repository_changed',
      'project.gate_set',
      'project.baseline_failed',
      'project.removed',
      'project.restored',
      'session.gate_started',
      'session.gate_checked',
      'session.gate_run_failed',
      'session.gate_run_cancel_requested',
      'session.gate_run_cancelled',
      'session.gate_run_completed',
      'session.merge_blocked',
      'session.merge_started',
      'session.merge_cancel_requested',
      'session.merge_cancelled',
      'session.merge_stuck',
      'session.discard_failed',
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
      'session.turn_stalled',
      'workflow.policy_changed',
      'setting.proposed',
      'setting.proposal_decided',
    ].includes(kind)
  );
}

/** Sequence of the newest event that may change the list; 0 when there is none. */
export function needsYouTrigger(events: readonly DaemonEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--)
    if (touchesNeedsYou(events[i]!.kind)) return events[i]!.sequence;
  return 0;
}

/** The text of a known code; null for any other. */
function knownReason(code: string): string | null {
  switch (code) {
    case 'daemon_restart':
      return t({
        id: 'data.reason.daemonRestart',
        defaultMessage: 'A daemon restart interrupted it',
      });
    case 'gate_required':
      return t({
        id: 'data.reason.gateRequired',
        defaultMessage: 'The gates have not passed on this commit',
      });
    case 'approval_not_pending':
      return t({
        id: 'data.reason.approvalNotPending',
        defaultMessage: 'This approval was already handled',
      });
    case 'gate_retry_unavailable':
      return t({
        id: 'data.reason.gateRetryUnavailable',
        defaultMessage:
          'The failed commands cannot be rerun alone: there are changes since the last gate run, or it had no failed command',
      });
    case 'revision_conflict':
      return t({
        id: 'data.reason.revisionConflict',
        defaultMessage: 'The item changed: its input or version no longer matches',
      });
    case 'permission_denied':
      return t({
        id: 'data.reason.permissionDenied',
        defaultMessage: "You don't have permission to answer this item",
      });
    case 'unsupported_command':
      return t({
        id: 'data.reason.unsupportedCommand',
        defaultMessage: "The backend doesn't support this command yet",
      });
    case 'unknown_route':
      return t({
        id: 'data.reason.unknownRoute',
        defaultMessage: 'The backend has no such endpoint',
      });
    case 'uncommitted_changes':
      return t({
        id: 'data.reason.uncommittedChanges',
        defaultMessage: 'The worktree has uncommitted changes that this merge does not commit',
      });
    case 'no_changes':
      return t({ id: 'data.reason.noChanges', defaultMessage: 'No commits to merge' });
    case 'scope_violation':
      return t({
        id: 'data.reason.scopeViolation',
        defaultMessage: 'Outside the project or a protected path',
      });
    case 'invalid_input':
      return t({ id: 'data.reason.invalidInput', defaultMessage: 'Invalid input' });
    case 'resource_busy':
      return t({
        id: 'data.reason.resourceBusy',
        defaultMessage: "The session's previous turn hasn't ended yet",
      });
    case 'bridge_unavailable':
      return t({
        id: 'data.reason.bridgeUnavailable',
        defaultMessage: 'Desktop bridge unavailable',
      });
    case 'ipc_failed':
      return t({
        id: 'data.reason.ipcFailed',
        defaultMessage: 'Could not reach the desktop process',
      });
    case 'permission_requested':
      return t({
        id: 'data.reason.permissionRequested',
        defaultMessage: 'The model is asking for permission',
      });
    case 'reconciliation_required':
      return t({
        id: 'data.reason.reconciliationRequired',
        defaultMessage: 'Stop not confirmed; needs reconciliation',
      });
    case 'session_failed':
      return t({ id: 'data.reason.sessionFailed', defaultMessage: 'Session failed' });
    case 'non_writer_write_detected':
      return t({
        id: 'data.reason.nonWriterWrite',
        defaultMessage: 'A read-only session wrote files',
      });
    case 'outside_worktree_write_detected':
      return t({
        id: 'data.reason.outsideWorktreeWrite',
        defaultMessage: 'A session wrote outside its worktree',
      });
    case 'merge_blocked':
      return t({ id: 'data.reason.mergeBlocked', defaultMessage: 'Merge blocked' });
    case 'permission_voided':
      return t({
        id: 'data.reason.permissionVoided',
        defaultMessage:
          'The request was voided when the session was interrupted; waiting for the session to ask again',
      });
    case 'answer_undelivered':
      return t({
        id: 'data.reason.answerUndelivered',
        defaultMessage: "The answer didn't reach the session",
      });
    case 'merge_stuck':
      return t({ id: 'data.reason.mergeStuck', defaultMessage: 'Merge stuck' });
    case 'workspace_read_failed':
      return t({
        id: 'data.reason.workspaceReadFailed',
        defaultMessage: "Couldn't read the worktree",
      });
    case 'workspace_reconciling':
      return t({
        id: 'data.reason.workspaceReconciling',
        defaultMessage: 'Workspace setup was interrupted; needs reconciliation',
      });
    case 'stop_unconfirmed':
      return t({
        id: 'data.reason.stopUnconfirmed',
        defaultMessage: 'The process never confirmed it stopped',
      });
    case 'termination_unconfirmed':
      return t({
        id: 'data.reason.terminationUnconfirmed',
        defaultMessage: "Can't confirm the old process has ended",
      });
    // usage_limit is the error code of the turn that hit the limit.
    case 'usage_limit_reached':
    case 'usage_limit':
      return t({ id: 'data.reason.usageLimitReached', defaultMessage: 'Usage limit reached' });
    case 'session_turn_stalled':
      return t({
        id: 'data.reason.sessionTurnStalled',
        defaultMessage: 'No progress for 10 minutes',
      });
    case 'background_task_long':
      return t({
        id: 'data.reason.backgroundTaskLong',
        defaultMessage: 'A background task has run for 30 minutes',
      });
    case 'project_over_budget':
      return t({
        id: 'data.reason.projectOverBudget',
        defaultMessage: 'The project used up its token budget',
      });
    case 'setting_proposed':
      return t({
        id: 'data.reason.settingProposed',
        defaultMessage: 'The main agent proposes a settings change',
      });
    case 'plan_decisions_over_budget':
      return t({
        id: 'data.reason.planDecisionsOverBudget',
        defaultMessage: 'Plan decisions did not fit the memory budget and were kept as notes',
      });
    case 'artifact_commit_missing':
      return t({
        id: 'data.reason.artifactCommitMissing',
        defaultMessage: 'The session recorded no commit to merge',
      });
    case 'clone_dirty':
      return t({
        id: 'data.reason.cloneDirty',
        defaultMessage: 'The worktree has uncommitted changes',
      });
    case 'detached_head':
      return t({
        id: 'data.reason.detachedHead',
        defaultMessage: 'The source repository is not on a branch',
      });
    case 'gate_failed':
      return t({ id: 'data.reason.gateFailed', defaultMessage: 'Merge gates failed' });
    case 'local_changes':
      return t({
        id: 'data.reason.localChanges',
        defaultMessage: 'The source repository has local changes that would be overwritten',
      });
    case 'rebase_conflict':
      return t({
        id: 'data.reason.rebaseConflict',
        defaultMessage: 'Conflicts rebasing onto the source branch',
      });
    case 'rebase_interrupted':
      return t({
        id: 'data.reason.rebaseInterrupted',
        defaultMessage: 'The worktree has an unfinished rebase',
      });
    case 'conflict':
      return t({ id: 'data.reason.conflict', defaultMessage: 'Changes conflict' });
    case 'source_dirty':
      return t({
        id: 'data.reason.sourceDirty',
        defaultMessage: 'The source repository has uncommitted changes',
      });
    case 'source_detached':
      return t({
        id: 'data.reason.sourceDetached',
        defaultMessage: 'The source repository is not on a branch',
      });
    case 'target_branch_changed':
      return t({
        id: 'data.reason.targetBranchChanged',
        defaultMessage: 'The source repository is on another branch than the session started from',
      });
    case 'workspace_owned':
      return t({
        id: 'data.reason.workspaceOwned',
        defaultMessage: 'Another operation is using the worktree',
      });
    case 'merge_commits':
      return t({
        id: 'data.reason.mergeCommits',
        defaultMessage:
          'The worktree has merge commits; a rebase would drop the changes made in the merges themselves',
      });
    case 'protected_paths':
      return t({
        id: 'data.reason.protectedPaths',
        defaultMessage: 'Changes touch protected agent configuration files',
      });
    case 'gate_files_changed':
      return t({
        id: 'data.reason.gateFilesChanged',
        defaultMessage: 'Changes touch files that protect the gate',
      });
    case 'dependency_folder_skipped':
      return t({
        id: 'data.reason.dependencyFolderSkipped',
        defaultMessage: 'A dependency folder was skipped and not copied into the worktree',
      });
    case 'source_metadata_unsupported':
      return t({
        id: 'data.reason.sourceMetadataUnsupported',
        defaultMessage: "The source repository's .git is not a folder",
      });
    case 'root_in_use':
      return t({
        id: 'data.reason.rootInUse',
        defaultMessage: 'The folder still has session work that is not merged',
      });
    case 'committer_unknown':
      return t({
        id: 'data.reason.committerUnknown',
        defaultMessage: 'No Git committer identity set (user.name / user.email)',
      });
    case 'invalid_state':
      return t({
        id: 'data.reason.invalidState',
        defaultMessage: "Can't do this in the current state",
      });
    case 'invalid_workspace':
      return t({ id: 'data.reason.invalidWorkspace', defaultMessage: 'Workspace unavailable' });
    case 'daemon_unavailable':
      return t({ id: 'data.reason.daemonUnavailable', defaultMessage: 'Daemon unavailable' });
    case 'command_timeout':
      return t({
        id: 'data.reason.commandTimeout',
        defaultMessage: 'The command is still running in the background; trust the board',
      });
    case 'query_timeout':
      return t({
        id: 'data.reason.queryTimeout',
        defaultMessage: 'The daemon is slow to answer; still loading',
      });
    case 'daemon_busy':
      return t({ id: 'data.reason.daemonBusy', defaultMessage: 'The daemon is busy; retrying' });
    case 'billing_channel_mismatch':
      return t({
        id: 'data.reason.billingChannelMismatch',
        defaultMessage:
          'Not signed in with a subscription account (claude.ai or ChatGPT); Pantheon does not use API billing',
      });
    case 'account_check_timeout':
      return t({
        id: 'data.reason.accountCheckTimeout',
        defaultMessage:
          'Checking the signed-in account timed out; make sure the CLI is signed in and retry',
      });
    case 'native_session_busy':
      return t({
        id: 'data.reason.nativeSessionBusy',
        defaultMessage: 'This native session is running in a terminal; close it there to continue',
      });
    case 'git_required':
      return t({
        id: 'data.reason.gitRequired',
        defaultMessage:
          "This folder isn't a Git repository or has no commits yet; turn on automatic git init in settings, or initialize it yourself",
      });
    case 'protocol_mismatch':
      return t({
        id: 'data.reason.protocolMismatch',
        defaultMessage: "The app and daemon versions don't match; restart Pantheon",
      });
    case 'not_implemented':
      return t({
        id: 'data.reason.notImplemented',
        defaultMessage: 'This feature is not implemented yet',
      });
    default:
      return null;
  }
}

/** A key unique to the item in a list of needs; a session's items share their source and differ by reason or request. */
export const needRowKey = (item: Pick<NeedsYouItem, 'source' | 'reason' | 'request_id'>): string =>
  `${item.source.table}:${item.source.id}:${item.reason}:${item.request_id ?? ''}`;

const GIT_FAILED = 'git_failed:';
const TESTS_DROPPED = /^tests_dropped: (.+): passed (\d+)→(\d+), skipped (\d+)→(\d+)$/;

/** Interface text for an error code, disabled reason or item reason; unknown codes show as they are. */
export function reasonText(code: string): string {
  if (code.startsWith(GIT_FAILED))
    return t(
      { id: 'data.reason.gitFailed', defaultMessage: 'Git failed: {detail}' },
      { detail: code.slice(GIT_FAILED.length).trim() },
    );
  const dropped = TESTS_DROPPED.exec(code);
  if (dropped)
    return t(
      {
        id: 'data.reason.testsDropped',
        defaultMessage:
          'The test counts of gate {gate} differ from the last landing: passed {passedBefore}→{passed}, skipped {skippedBefore}→{skipped}',
      },
      {
        gate: dropped[1]!,
        passedBefore: dropped[2]!,
        passed: dropped[3]!,
        skippedBefore: dropped[4]!,
        skipped: dropped[5]!,
      },
    );
  return knownReason(code) ?? code;
}

/** Interface reason of a failed command, followed by the daemon's message. */
export function failureText(error: { code: string; message: string }): string {
  // runCommand refreshes the board after a revision conflict, so the next click sends current revisions.
  const text =
    error.code === 'revision_conflict'
      ? t({
          id: 'data.failure.refreshed',
          defaultMessage: 'The data was refreshed; click again',
        })
      : reasonText(error.code);
  return text === error.code
    ? t(
        { id: 'data.failure.codeMessage', defaultMessage: '{code}: {message}' },
        { code: error.code, message: error.message },
      )
    : t(
        { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
        { reason: text, message: error.message },
      );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Hand-written short forms; Intl.RelativeTimeFormat words them differently.
export function ageText(created_at: number, now: number): string {
  const ms = Math.max(0, now - created_at);
  if (ms < MINUTE) return t({ id: 'data.age.justNow', defaultMessage: 'just now' });
  if (ms < HOUR)
    return t(
      { id: 'data.age.minutes', defaultMessage: '{count}min' },
      { count: Math.floor(ms / MINUTE) },
    );
  if (ms < 24 * HOUR)
    return t(
      { id: 'data.age.hours', defaultMessage: '{count}h' },
      { count: Math.floor(ms / HOUR) },
    );
  if (ms < 30 * DAY)
    return t({ id: 'data.age.days', defaultMessage: '{count}d' }, { count: Math.floor(ms / DAY) });
  return t(
    { id: 'data.age.months', defaultMessage: '{count}mo' },
    { count: Math.floor(ms / (30 * DAY)) },
  );
}

async function readNeedsYou(
  bridge: Pick<DesktopBridge, 'query'>,
  project_id: string | null,
): Promise<BridgeResult<NeedsYouItem[]>> {
  const result = await bridge
    .query('needs_you.list', project_id ? { project_id } : undefined)
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  const items = (result.value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items))
    return { ok: false, error: { code: 'bad_response', message: 'items is not a list' } };
  return { ok: true, value: items as NeedsYouItem[] };
}

/** The needs-you list of a project, or of every project when project_id is null. */
export function useNeedsYou(project_id: string | null): NeedsYouState {
  const trigger = useBoard((s) => needsYouTrigger(s.events));
  const live = useBoard((s) => s.status.state === 'live');
  const resync = useBoard((s) => s.resync);
  const [attempt, setAttempt] = useState(0);
  // `of`: the project the items were read for; another project's items are never shown.
  const [state, setState] = useState<Omit<NeedsYouState, 'reload'> & { of: string | null }>({
    items: null,
    loading: true,
    error: null,
    of: project_id,
  });
  const wanted = useRef(project_id);
  wanted.current = project_id;
  // Numbers of the last read started and of the newest read whose answer was taken.
  const runs = useRef({ started: 0, taken: 0 });
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;
  // Long background work, unconfirmed stops and stuck merges come due with time, without an event.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setClock((n) => n + 1), MINUTE);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    const bridge = window.pantheon;
    const run = ++runs.current.started;
    setState((s) => (s.items !== null && s.of === project_id ? s : { ...s, loading: true }));
    void (
      bridge
        ? readNeedsYou(bridge, project_id)
        : Promise.resolve<BridgeResult<NeedsYouItem[]>>({
            ok: false,
            error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
          })
    ).then((result) => {
      // A slow read of the same project still lands unless a newer answer was already taken.
      if (wanted.current !== project_id || run < runs.current.taken) return;
      runs.current.taken = run;
      const newer = run !== runs.current.started;
      setState((s) => {
        const items = s.of === project_id ? s.items : null;
        return result.ok
          ? { items: result.value, loading: false, error: null, of: project_id }
          : {
              items,
              loading: newer && items === null,
              error: t(
                { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
                { reason: reasonText(result.error.code), message: result.error.message },
              ),
              of: project_id,
            };
      });
    });
  }, [project_id, trigger, reconnected, resync, attempt, clock]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const { of, ...shown } = state;
  return of === project_id
    ? { ...shown, reload }
    : { items: null, loading: true, error: null, reload };
}

/** The current time, updated every interval milliseconds. */
export function useNow(interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

/** Counts the local midnights passed while mounted. */
export function useMidnights(): number {
  const [midnights, setMidnights] = useState(0);
  useEffect(() => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setMidnights((n) => n + 1), next.getTime() - now.getTime());
    return () => clearTimeout(timer);
  }, [midnights]);
  return midnights;
}
