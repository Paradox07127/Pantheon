import type { WorkbenchSession } from '@pantheon/protocol';
import type { NeedsYouItem } from '../data/needs-you';
import { currentLocale, t } from '../i18n';

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
  usage_limit_reached: () =>
    t({
      id: 'daemon.nextStep.usageLimitReached',
      defaultMessage: 'Continue the session after the limit resets, or fork it to another runtime.',
    }),
  session_turn_stalled: () =>
    t({
      id: 'daemon.nextStep.sessionTurnStalled',
      defaultMessage: 'Open the session to see where it stopped.',
    }),
  background_task_long: () =>
    t({
      id: 'daemon.nextStep.backgroundTaskLong',
      defaultMessage:
        'A background command or agent of the session has run for 30 minutes; the user stops it, or waits for it to end.',
    }),
};

/** Who acts next on a needs-you item, by its reason; the daemon's English for a reason not known here. */
export function nextStepText(item: Pick<NeedsYouItem, 'reason' | 'next_step'>): string | undefined {
  if (!item.next_step) return undefined;
  return NEXT_STEP[item.reason]?.() ?? item.next_step;
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
