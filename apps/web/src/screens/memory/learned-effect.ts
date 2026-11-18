import type { FlowPath, Improvement, WorkflowParam } from '@pantheon/domain';
import { runtimeName } from '../../components/RuntimeGlyph';
import {
  changeText,
  DOMAIN_LABEL,
  PATH_LABEL,
  tierText,
  WAKE_LABEL,
} from '../../data/workflow-policy';
import { t } from '../../i18n';

export interface LearnedEffect {
  /** The caption over the sentence: where an experience goes, or how a policy change applies. */
  label: string;
  text: string;
}

/** One value of a workflow parameter as the user reads it. */
export function changeValueText(param: WorkflowParam, value: unknown): string {
  if (value === undefined || value === null)
    return t({ id: 'data.workflowPolicy.noLimit', defaultMessage: 'No limit' });
  if (param === 'path' && typeof value === 'string' && value in PATH_LABEL)
    return PATH_LABEL[value as FlowPath];
  if (param === 'acceptance_wake' && (value === 'each_merge' || value === 'milestone'))
    return WAKE_LABEL[value];
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

type Experience = Extract<Improvement['change'], { type: 'experience' }>;
type Policy = Extract<Improvement['change'], { type: 'policy_change' }>;

/** The sessions an experience goes to, as a noun phrase. */
function sessionsText(change: Experience): string {
  const kind = [change.domain && DOMAIN_LABEL[change.domain], change.tier && tierText(change.tier)]
    .filter(Boolean)
    .join(' ');
  const runtime = change.runtime && runtimeName(change.runtime);
  if (kind && runtime)
    return t(
      {
        id: 'memory.learnedDetail.sessions.kindRuntime',
        defaultMessage: '{runtime} sessions on {kind} tasks',
      },
      { kind, runtime },
    );
  if (kind)
    return t(
      { id: 'memory.learnedDetail.sessions.kind', defaultMessage: 'sessions on {kind} tasks' },
      { kind },
    );
  if (runtime)
    return t(
      { id: 'memory.learnedDetail.sessions.runtime', defaultMessage: '{runtime} sessions' },
      { runtime },
    );
  return t({ id: 'memory.learnedDetail.sessions.all', defaultMessage: 'every session' });
}

function experienceText(status: Improvement['status'], change: Experience): string {
  const who = sessionsText(change);
  if (status === 'candidate')
    return t(
      {
        id: 'memory.learnedDetail.effect.experienceCandidate',
        defaultMessage:
          'Once the trial starts, this goes to {who} before every turn while the context budget has room for it, marked as on trial.',
      },
      { who },
    );
  if (status === 'trial')
    return t(
      {
        id: 'memory.learnedDetail.effect.experienceTrial',
        defaultMessage:
          'This goes to {who} before every turn while the context budget has room for it, marked as on trial.',
      },
      { who },
    );
  if (status === 'active')
    return t(
      {
        id: 'memory.learnedDetail.effect.experienceActive',
        defaultMessage:
          'This goes to {who} before every turn while the context budget has room for it.',
      },
      { who },
    );
  return t({
    id: 'memory.learnedDetail.effect.experienceEnded',
    defaultMessage: 'This goes to no session now.',
  });
}

function policyText(status: Improvement['status'], change: Policy): string {
  if (status === 'reverted' || status === 'rejected')
    return t({
      id: 'memory.learnedDetail.effect.policyEnded',
      defaultMessage: 'Changes a workflow setting and goes to no session; it has no effect now.',
    });
  const pending = status === 'candidate' ? 'yes' : 'no';
  const count = change.to;
  if (change.param === 'max_parallel' && typeof count === 'number')
    return t(
      {
        id: 'memory.learnedDetail.effect.maxParallel',
        defaultMessage:
          'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}new task sessions are dispatched {count} at a time.',
      },
      { pending, count },
    );
  if (change.param === 'handback_limit' && typeof count === 'number')
    return t(
      {
        id: 'memory.learnedDetail.effect.handbackLimit',
        defaultMessage:
          'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}one problem is handed back at most {count} times.',
      },
      { pending, count },
    );
  if (change.param === 'task_size_hint' && typeof count === 'number')
    return t(
      {
        id: 'memory.learnedDetail.effect.taskSizeHint',
        defaultMessage:
          'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}the lead is told to change at most {count} files per task.',
      },
      { pending, count },
    );
  if (change.param === 'runtime_quota_threshold' && typeof count === 'number')
    return t(
      {
        id: 'memory.learnedDetail.effect.quotaThreshold',
        defaultMessage:
          'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}new task sessions wait once a runtime has used {count}% of its quota.',
      },
      { pending, count },
    );
  if (change.param === 'path' && change.tier && typeof change.to === 'string')
    return t(
      {
        id: 'memory.learnedDetail.effect.path',
        defaultMessage:
          'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}{tier} tasks go the “{path}” way.',
      },
      { pending, tier: tierText(change.tier), path: changeValueText('path', change.to) },
    );
  if (change.param === 'acceptance_wake' && typeof change.to === 'string')
    return t(
      {
        id: 'memory.learnedDetail.effect.acceptanceWake',
        defaultMessage:
          'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}acceptance moves to “{wake}”.',
      },
      { pending, wake: changeValueText('acceptance_wake', change.to) },
    );
  return t(
    {
      id: 'memory.learnedDetail.effect.policy',
      defaultMessage:
        'Changes a workflow setting and goes to no session: {pending, select, yes {once the trial starts, } other {}}{change}.',
    },
    { pending, change: changeText(change) },
  );
}

/** Where an improvement takes effect once it is in use, in one sentence under its caption. */
export function learnedEffect(item: Pick<Improvement, 'status' | 'change'>): LearnedEffect {
  if (item.change.type === 'experience')
    return {
      label: t({ id: 'memory.learnedDetail.effect.injectLabel', defaultMessage: 'Goes to' }),
      text: experienceText(item.status, item.change),
    };
  return {
    label: t({ id: 'memory.learnedDetail.effect.applyLabel', defaultMessage: 'How it applies' }),
    text:
      item.change.type === 'policy_change'
        ? policyText(item.status, item.change)
        : changeText(item.change),
  };
}
