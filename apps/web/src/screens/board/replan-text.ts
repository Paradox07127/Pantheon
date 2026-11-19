import type { BoardHistory, ReplanFiredRef } from '@pantheon/protocol';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import type { SnapshotMilestone } from './panels-model';

/** A condition on which a milestone's lead re-plans it, as the lead declared it. */
export type ReplanCondition = NonNullable<SnapshotMilestone['replan_if']>[number];

const percentText = (ratio: number) =>
  new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(
    ratio,
  );

/** What the task did that met a condition, in words. */
export function firedText({ type, value, task_title: task }: ReplanFiredRef): string {
  if (type === 'handbacks')
    return t(
      {
        id: 'board.replan.fired.handbacks',
        defaultMessage: '{task} was handed back {count, plural, one {# time} other {# times}}',
      },
      { task, count: value! },
    );
  if (type === 'budget_ratio')
    return t(
      { id: 'board.replan.fired.budget', defaultMessage: '{task} spent {percent} of its budget' },
      { task, percent: percentText(value!) },
    );
  if (type === 'stall')
    return t({ id: 'board.replan.fired.stall', defaultMessage: '{task} stalled' }, { task });
  return t(
    {
      id: 'board.replan.fired.assumption',
      defaultMessage: 'An assumption behind {task} turned out false',
    },
    { task },
  );
}

/** A declared condition in words. */
export function conditionText(condition: ReplanCondition): string {
  if (condition.type === 'handbacks')
    return t(
      {
        id: 'board.replan.if.handbacks',
        defaultMessage: 'A task is handed back {count, plural, one {# time} other {# times}}',
      },
      { count: condition.count },
    );
  if (condition.type === 'budget_ratio')
    return t(
      { id: 'board.replan.if.budget', defaultMessage: 'A task spends {percent} of its budget' },
      { percent: percentText(condition.at) },
    );
  if (condition.type === 'stall')
    return t({ id: 'board.replan.if.stall', defaultMessage: 'A task stalls' });
  return t({ id: 'board.replan.if.assumption', defaultMessage: 'An assumption turns out false' });
}

/** The counts of tasks a re-plan added, removed and changed, the zero ones left out. */
export function changesText({
  added,
  removed,
  changed,
}: NonNullable<BoardHistory['decisions'][number]['replan']>): string {
  return listText(
    added.length > 0 &&
      t({ id: 'board.replan.added', defaultMessage: '{count} added' }, { count: added.length }),
    removed.length > 0 &&
      t(
        { id: 'board.replan.removed', defaultMessage: '{count} removed' },
        { count: removed.length },
      ),
    changed.length > 0 &&
      t(
        { id: 'board.replan.changed', defaultMessage: '{count} changed' },
        { count: changed.length },
      ),
  );
}

export const unansweredText = () =>
  t({ id: 'board.replan.unanswered', defaultMessage: 'The lead has not changed the plan' });

export const openLeadText = () =>
  t({ id: 'board.replan.openLead', defaultMessage: 'Open lead session' });
