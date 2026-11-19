import type { BoardBlocker, BoardModel, WorkbenchSession } from '@pantheon/protocol';
import { reasonText, type NeedsYouItem } from '../data/needs-you';
import { currentLocale, t } from '../i18n';
import { listText } from './list-text';

type Wait = NonNullable<BoardModel['tasks'][number]['dispatch_wait']>;

// Getters, so each is read in the language loaded by then.
const NEXT_STEP: Partial<Record<NeedsYouItem['reason'], () => string>> = {
  merge_stuck: () =>
    t({
      id: 'daemon.nextStep.mergeStuck',
      defaultMessage: 'The user checks the stuck merge and cancels it if needed.',
    }),
  stop_unconfirmed: () =>
    t({
      id: 'daemon.nextStep.stopUnconfirmed',
      defaultMessage:
        "The session's process has not confirmed it stopped; the user confirms the process stopped, or retries the stop.",
    }),
  workspace_reconciling: () =>
    t({
      id: 'daemon.nextStep.workspaceReconciling',
      defaultMessage:
        'A daemon restart interrupted the workspace setup, so whether its Git processes stopped is unknown; the user reconciles: once no Git process is still running in the workspace, discard this session.',
    }),
  continuation_limit_reached: () =>
    t({
      id: 'daemon.nextStep.continuationLimitReached',
      defaultMessage:
        'The automatic continuations are used up; the user sends the session a message to go on.',
    }),
  lead_turn_failed: () =>
    t({
      id: 'daemon.nextStep.leadTurnFailed',
      defaultMessage: 'The user retries, or sends the lead a message to go on.',
    }),
  lead_closed: () =>
    t({
      id: 'daemon.nextStep.leadClosed',
      defaultMessage:
        'The lead is closed; the user reopens it, or hands the plan to a new lead with a board sync.',
    }),
  lead_wake_limited: () =>
    t({
      id: 'daemon.nextStep.leadWakeLimited',
      defaultMessage:
        'Board updates woke the lead too often in a short time, so Pantheon stopped waking it; the updates stay in its inbox and waking resumes in a few minutes. The user checks whether the lead is spinning and, if needed, sends it a message to correct course.',
    }),
  usage_limit_waiting: () =>
    t({
      id: 'daemon.nextStep.usageLimitWaiting',
      defaultMessage:
        'The session used up its subscription limit; Pantheon has it go on once the limit resets and opens no new turn until then. The user waits for the reset, or moves it to another runtime.',
    }),
  task_dispatch_failed: () =>
    t({
      id: 'daemon.nextStep.taskDispatchFailed',
      defaultMessage:
        "Pantheon retries with backoff; the lead can change the task's runtime, and the user can check why this runtime is unavailable.",
    }),
  task_upstream_stuck: () =>
    t({
      id: 'daemon.nextStep.taskUpstreamStuck',
      defaultMessage:
        'The queued task waits on a dependency nobody moves forward, and the lead was reminded; the user checks why the dependency stopped and has the lead restart or change it, or stops the queued task.',
    }),
  task_retired: () =>
    t({
      id: 'daemon.nextStep.taskRetired',
      defaultMessage:
        "The lead removed the session's task from the plan (the same id may now be a new task), so its changes no longer merge; the user checks the changes, then discards this session.",
    }),
  task_turn_looping: () =>
    t({
      id: 'daemon.nextStep.taskTurnLooping',
      defaultMessage:
        "The task session's turn still repeats the same tool call after the lead was reminded; the user interrupts the turn, or sends the lead a message to correct course.",
    }),
  task_turn_stalled: () =>
    t({
      id: 'daemon.nextStep.taskTurnStalled',
      defaultMessage:
        "The task session's turn stalled and the lead has not handled it since it was reminded; the user interrupts the turn, or sends the lead a message to handle it.",
    }),
  lead_turn_looping: () =>
    t({
      id: 'daemon.nextStep.leadTurnLooping',
      defaultMessage:
        "The lead's turn repeats the same tool call; the user interrupts the turn, then sends the lead a message to correct course.",
    }),
  lead_turn_stalled: () =>
    t({
      id: 'daemon.nextStep.leadTurnStalled',
      defaultMessage:
        "The lead's turn has made no progress for a long time, or a tool call never ended; the user interrupts the turn, then sends the lead a message to go on.",
    }),
  // The daemon gives a permission request a next step only when it is the lead's own.
  permission_requested: () =>
    t({
      id: 'daemon.nextStep.leadPermission',
      defaultMessage:
        "This is the lead's own permission request; its turn waits for the answer and gets no task session reports meanwhile. The lead goes on once the user allows or denies it.",
    }),
  milestone_ready_for_acceptance: () =>
    t({
      id: 'daemon.nextStep.milestoneReadyForAcceptance',
      defaultMessage:
        "The milestone's tasks are all done; the user checks its acceptance criteria and accepts it, or tells the lead what is still missing.",
    }),
  improvement_awaiting_decision: () =>
    t({
      id: 'daemon.nextStep.improvementAwaitingDecision',
      defaultMessage:
        'The improvement proposal awaits the user; the user confirms it to start a trial, or rejects it.',
    }),
  plan_proposal_awaiting_decision: () =>
    t({
      id: 'daemon.nextStep.planProposalAwaitingDecision',
      defaultMessage:
        'The plan proposal awaits the user; the user accepts it, changes its ops before accepting, or rejects it.',
    }),
  lane_plan_awaiting_approval: () =>
    t({
      id: 'daemon.nextStep.lanePlanAwaitingApproval',
      defaultMessage: 'Approve the plan to let its tasks start, or tell the lead what to change.',
    }),
  background_task_long: () =>
    t({
      id: 'daemon.nextStep.backgroundTaskLong',
      defaultMessage:
        'A background command or agent of the session has run for 30 minutes; the user stops it, or waits for it to end.',
    }),
};

/** Who acts next on a needs-you item, by its reason; the daemon's English for a reason not known here. */
export function nextStepText(
  item: Pick<NeedsYouItem, 'reason' | 'next_step' | 'project_budget' | 'memory_notes'>,
): string | undefined {
  if (!item.next_step) return undefined;
  if (item.reason === 'project_over_budget' && item.project_budget)
    return t(
      {
        id: 'daemon.nextStep.projectOverBudget',
        defaultMessage:
          'The project used {used} input tokens since its budget was set, against a budget of {budget}; Pantheon opens no new task session and wakes no lead, and running turns finish. Work resumes once the user raises or clears the project budget.',
      },
      { used: item.project_budget.used_input_tokens, budget: item.project_budget.input_tokens },
    );
  if (item.reason === 'plan_decisions_over_budget' && item.memory_notes)
    return t(
      {
        id: 'daemon.nextStep.planDecisionsOverBudget',
        defaultMessage:
          '{count, plural, one {# decision from the plan did not fit the memory budget for decisions, so Pantheon kept it as a note} other {# decisions from the plan did not fit the memory budget for decisions, so Pantheon kept them as notes}}; the user reads them in project memory, shortens or archives decisions to make room, and archives each note once it is handled.',
      },
      { count: item.memory_notes.count },
    );
  return NEXT_STEP[item.reason]?.() ?? item.next_step;
}

type Planned = BoardModel['tasks'][number]['planned'];

const deviceName = (planned: Planned) =>
  planned?.device && planned.device !== 'local'
    ? planned.device
    : t({ id: 'daemon.blocker.queued.thisComputer', defaultMessage: 'this computer' });

const QUEUED: Record<Wait, (planned: Planned) => string> = {
  step: () => t({ id: 'daemon.blocker.queued.none', defaultMessage: 'Queued' }),
  paused: () =>
    t({ id: 'daemon.blocker.queued.paused', defaultMessage: 'Queued: dispatch is paused' }),
  runtime_capacity: () =>
    t({
      id: 'daemon.blocker.queued.runtimeCapacity',
      defaultMessage: 'Queued: waiting for runtime capacity',
    }),
  // A device wait already says what it waits for, so it goes without the queued prefix.
  device_offline: (planned) =>
    t(
      {
        id: 'daemon.blocker.queued.deviceOffline',
        defaultMessage: 'Waiting for {device} to connect',
      },
      { device: deviceName(planned) },
    ),
  device_capacity: (planned) =>
    t(
      {
        id: 'daemon.blocker.queued.deviceCapacity',
        defaultMessage: 'Waiting for a free session on {device}',
      },
      { device: deviceName(planned) },
    ),
  device_resource: (planned) => {
    const resources = Object.keys(planned?.uses ?? {});
    return resources.length
      ? t(
          {
            id: 'daemon.blocker.queued.deviceResources',
            defaultMessage: 'Waiting for {resources} on {device}',
          },
          { resources: listText(...resources), device: deviceName(planned) },
        )
      : t({
          id: 'daemon.blocker.queued.deviceResource',
          defaultMessage: 'Waiting for a device resource',
        });
  },
  answer: () =>
    t({ id: 'daemon.blocker.queued.answer', defaultMessage: 'Queued: waiting for an answer' }),
  approval: () =>
    t({
      id: 'daemon.blocker.queued.approval',
      defaultMessage: 'Queued: waiting for your approval',
    }),
  plan_approval: () =>
    t({
      id: 'daemon.blocker.queued.planApproval',
      defaultMessage: 'Queued: waiting for your plan approval',
    }),
  runtime_limited: () =>
    t({
      id: 'daemon.blocker.queued.runtimeLimited',
      defaultMessage: 'Queued: waiting for runtime quota',
    }),
  upstream: () =>
    t({ id: 'daemon.blocker.queued.upstream', defaultMessage: 'Queued: waiting for dependencies' }),
  scope: () =>
    t({
      id: 'daemon.blocker.queued.scope',
      defaultMessage: 'Queued: waiting for the scope to free up',
    }),
  plan_review: () =>
    t({
      id: 'daemon.blocker.queued.planReview',
      defaultMessage: 'Queued: waiting for plan review',
    }),
  retry: () => t({ id: 'daemon.blocker.queued.retry', defaultMessage: 'Queued: waiting to retry' }),
  budget: () =>
    t({ id: 'daemon.blocker.queued.budget', defaultMessage: 'Queued: project over budget' }),
  capacity: () =>
    t({ id: 'daemon.blocker.queued.capacity', defaultMessage: 'Queued: waiting for a free slot' }),
};

function blockerText(
  blocker: BoardBlocker,
  wait: Wait | undefined,
  step: { title: string } | undefined,
  planned: Planned,
): string | null {
  switch (blocker.code) {
    case 'queued': {
      const queued =
        wait === 'step' && step
          ? t(
              { id: 'daemon.blocker.queued.step', defaultMessage: 'Queued: waiting for “{title}”' },
              { title: step.title },
            )
          : wait
            ? QUEUED[wait](planned)
            : t({ id: 'daemon.blocker.queued.none', defaultMessage: 'Queued' });
      return blocker.error === undefined
        ? queued
        : t(
            {
              id: 'daemon.blocker.queued.openFailed',
              defaultMessage: '{queued} (the session could not open: {error})',
            },
            { queued, error: blocker.error },
          );
    }
    case 'upstream':
      return t(
        { id: 'daemon.blocker.upstream', defaultMessage: 'Dependency “{title}” is not finished' },
        { title: blocker.title },
      );
    case 'merge_blocked':
      return blocker.reason
        ? t(
            {
              id: 'daemon.blocker.mergeBlockedFor',
              defaultMessage:
                '{count, plural, =0 {Merge blocked: {reason}} one {Merge blocked: {reason}, # conflicting file} other {Merge blocked: {reason}, # conflicting files}}',
            },
            { reason: reasonText(blocker.reason), count: blocker.conflicts },
          )
        : t(
            {
              id: 'daemon.blocker.mergeBlocked',
              defaultMessage:
                '{count, plural, =0 {Merge blocked} one {Merge blocked, # conflicting file} other {Merge blocked, # conflicting files}}',
            },
            { count: blocker.conflicts },
          );
    case 'turn_failed':
      return blocker.error
        ? t(
            { id: 'daemon.blocker.turnFailedWith', defaultMessage: 'Turn failed: {error}' },
            { error: blocker.error },
          )
        : t({ id: 'daemon.blocker.turnFailed', defaultMessage: 'Turn failed' });
    default:
      return null;
  }
}

/** The task's blockers in the interface language; the daemon's English for a code not known here. */
export function blockerTexts(
  task: Pick<
    BoardModel['tasks'][number],
    'blockers' | 'blocker_codes' | 'dispatch_wait' | 'waiting_step' | 'planned'
  >,
): string[] {
  const codes = task.blocker_codes;
  if (codes?.length !== task.blockers.length) return task.blockers;
  return task.blockers.map(
    (text, i) =>
      blockerText(codes[i]!, task.dispatch_wait, task.waiting_step, task.planned) ?? text,
  );
}

/** A listed session's title; a baseline session without one is named by its start time. */
export function listedTitle(row: Pick<WorkbenchSession, 'title' | 'baseline_started_at'>): string {
  if (row.title || row.baseline_started_at === undefined) return row.title;
  const time = new Intl.DateTimeFormat(currentLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(row.baseline_started_at);
  return t({ id: 'daemon.session.baselineTitle', defaultMessage: 'Baseline {time}' }, { time });
}

/** Why fast mode runs at another speed than chosen; null while the runtime is still checking. */
export function fastModeText(state: 'off' | 'cooldown', reason?: string): string | null {
  if (state === 'cooldown')
    return t({
      id: 'daemon.fastMode.cooldown',
      defaultMessage: 'Cooling down; standard speed for now',
    });
  switch (reason) {
    case 'pending':
      return null;
    case 'free':
      return t({ id: 'daemon.fastMode.free', defaultMessage: 'Not available on the free plan' });
    case 'extra_usage_disabled':
      return t({
        id: 'daemon.fastMode.extraUsageDisabled',
        defaultMessage: 'Extra usage is off for this account',
      });
    case 'not_first_party':
      return t({
        id: 'daemon.fastMode.notFirstParty',
        defaultMessage: "Only on Anthropic's own API",
      });
    case 'model_not_allowed':
      return t({
        id: 'daemon.fastMode.modelNotAllowed',
        defaultMessage: 'This model has no fast mode',
      });
    case 'preference':
    case 'disabled_by_env':
    case 'sdk_opt_in_required':
      return t({
        id: 'daemon.fastMode.turnedOff',
        defaultMessage: 'Turned off in the Claude settings',
      });
    case 'network_error':
      return t({
        id: 'daemon.fastMode.networkError',
        defaultMessage: 'Could not check fast mode: network error',
      });
    default:
      return t({ id: 'daemon.fastMode.unavailable', defaultMessage: 'Fast mode is unavailable' });
  }
}
