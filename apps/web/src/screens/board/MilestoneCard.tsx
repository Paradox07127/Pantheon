import { useId, useState, type CSSProperties } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Clock, Flag } from 'lucide-react';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { milestoneDueOp, planVersion } from '../../data/plan-edit';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { AcceptDialog, acceptEvidence, type MilestoneActions } from './Charts';
import {
  milestoneCounts,
  milestoneFinished,
  type BoardMilestone,
  type SnapshotMilestone,
} from './panels-model';
import { taskStateLabel } from './status';
import { useDialogContent } from './TellLead';
import './overview.css';

/** The first milestone not yet accepted; null when there is none. */
export const currentMilestone = (milestones: readonly BoardMilestone[]): BoardMilestone | null =>
  milestones.find((m) => !milestoneFinished(m)) ?? null;

/** Calendar days from the local day of `now` to the due day `dueOn`; negative once it has passed. */
export function daysLeft(dueOn: string, now: number): number {
  const [year, month, day] = dueOn.split('-').map(Number) as [number, number, number];
  const today = new Date(now);
  const from = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(year, month - 1, day) - from) / 86_400_000);
}

export function dueText(days: number): string {
  if (days > 0)
    return t(
      {
        id: 'board.plan.milestone.daysLeft',
        defaultMessage: '{count, plural, one {# day left} other {# days left}}',
      },
      { count: days },
    );
  if (days === 0) return t({ id: 'board.plan.milestone.dueToday', defaultMessage: 'Due today' });
  return t(
    {
      id: 'board.plan.milestone.overdue',
      defaultMessage: '{count, plural, one {# day overdue} other {# days overdue}}',
    },
    { count: -days },
  );
}

type Totals = BoardModel['task_progress']['totals'];

const TOTAL: Record<BoardTaskStatus, keyof Totals> = {
  done: 'done',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  ready: 'ready',
  failed: 'failed',
  todo: 'not_started',
  discarded: 'discarded',
};

/** The milestone's tasks by state; merged is its own count, which holds tasks merged before the board's window. */
function milestoneTotals(done: number, cells: BoardModel['tasks']): Totals {
  const totals: Totals = {
    done,
    running: 0,
    waiting: 0,
    idle: 0,
    ready: 0,
    failed: 0,
    discarded: 0,
    not_started: 0,
  };
  for (const cell of cells) if (cell.status !== 'done') totals[TOTAL[cell.status]]++;
  return totals;
}

// Functions, so each label is read in the language loaded by then.
const PARTS: {
  key: string;
  count: (totals: Totals) => number;
  label: (count: number) => string;
}[] = [
  {
    key: 'merged',
    count: (x) => x.done,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.merged', defaultMessage: '{count} merged' }, { count }),
  },
  {
    key: 'running',
    count: (x) => x.running,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.running', defaultMessage: '{count} running' }, { count }),
  },
  {
    key: 'waiting',
    count: (x) => x.waiting,
    label: (count) =>
      t(
        { id: 'board.plan.milestone.bar.waiting', defaultMessage: '{count} waiting on you' },
        { count },
      ),
  },
  {
    key: 'review',
    count: (x) => x.ready,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.review', defaultMessage: '{count} to review' }, { count }),
  },
  {
    key: 'failed',
    count: (x) => x.failed,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.failed', defaultMessage: '{count} failed' }, { count }),
  },
  {
    key: 'queued',
    count: (x) => x.not_started + x.idle,
    label: (count) =>
      t({ id: 'board.plan.milestone.bar.queued', defaultMessage: '{count} queued' }, { count }),
  },
  {
    key: 'discarded',
    count: (x) => x.discarded,
    label: (count) =>
      t(
        { id: 'board.plan.milestone.bar.discarded', defaultMessage: '{count} discarded' },
        { count },
      ),
  },
];

/**
 * The current milestone on one line: merged over planned tasks, the milestone's tasks by state and
 * the days left; its acceptance, criteria, task cells and due day open from the button that ends it.
 */
export function MilestoneCard({
  model,
  milestone,
  actions,
  onOpenTask,
}: {
  model: BoardModel;
  milestone: BoardMilestone;
  actions?: MilestoneActions;
  onOpenTask: (taskId: string) => void;
}) {
  const id = useId();
  const accepting = useDialogContent<{ stored: SnapshotMilestone }>();
  const { done, total } = milestoneCounts(milestone);
  const cells = model.tasks.filter((t) => t.milestone_id === milestone.id);
  const stored = actions?.milestones.find((m) => m.id === milestone.id);
  const ready = !!stored && milestone.status === 'ready_for_acceptance';
  const [failure, setFailure] = useState<string | null>(null);
  // Only a lead's milestone has a plan key to edit it by.
  const lead = stored?.owner_session_id;
  const key = stored?.key;
  const setDue = async (dueOn: string | null) => {
    if (!actions || !lead || !key) return;
    setFailure(null);
    setFailure(
      await actions.run(
        'board.plan.edit',
        {
          project_id: actions.projectId,
          lead_session_id: lead,
          base_version: planVersion(model, lead),
          ops: [milestoneDueOp(key, dueOn)],
        },
        null,
      ),
    );
  };
  const days = milestone.due_on === undefined ? null : daysLeft(milestone.due_on, model.now);
  const totals = milestoneTotals(done, cells);
  const parts = PARTS.map((p) => ({ ...p, n: p.count(totals) })).filter((p) => p.n > 0);
  return (
    <section className="bms" aria-labelledby={id} data-debug-region="board.milestone">
      <Flag className="bms-ic" aria-hidden="true" />
      <h2 id={id} className="bms-h" title={milestone.title}>
        {milestone.title}
      </h2>
      <span
        className="bms-frac"
        role="img"
        aria-label={t(
          {
            id: 'board.plan.milestone.merged',
            defaultMessage:
              '{total, plural, one {{done} of # planned task merged} other {{done} of # planned tasks merged}}',
          },
          { done, total },
        )}
      >
        {done} / {total}
      </span>
      {parts.length > 0 && (
        <span
          className="bms-bar"
          data-debug-region="board.progress"
          role="img"
          aria-label={t(
            {
              id: 'board.plan.milestone.bar',
              defaultMessage: '{count, plural, one {# task} other {# tasks}}: {parts}',
            },
            {
              count: parts.reduce((sum, p) => sum + p.n, 0),
              parts: listText(...parts.map((p) => p.label(p.n))),
            },
          )}
        >
          {parts.map((p) => (
            <i key={p.key} data-part={p.key} style={{ flexGrow: p.n }} />
          ))}
        </span>
      )}
      {days !== null && (
        <span className="bms-due" data-late={days < 0 || undefined}>
          <Clock aria-hidden="true" />
          {dueText(days)}
        </span>
      )}
      <Popover.Root>
        <Popover.Trigger
          className="ib bms-more"
          aria-label={t({
            id: 'board.plan.milestone.details',
            defaultMessage: 'Milestone details',
          })}
        >
          <ChevronDown aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
            <Popover.Popup className="pop bms-pop">
              <div className="bms-hd">
                <Popover.Title className="bms-pt">{milestone.title}</Popover.Title>
                {actions && (
                  <button
                    type="button"
                    className="btn"
                    aria-label={t(
                      { id: 'board.plan.milestone.acceptLabel', defaultMessage: 'Accept {title}' },
                      { title: milestone.title },
                    )}
                    disabled={!ready}
                    onClick={() => stored && accepting.show({ stored })}
                  >
                    {t({ id: 'board.plan.milestone.accept', defaultMessage: 'Accept' })}
                  </button>
                )}
              </div>
              {milestone.criteria.length > 0 && (
                <ul
                  className="bms-crit"
                  aria-label={t({
                    id: 'board.plan.milestone.criteria',
                    defaultMessage: 'Acceptance criteria',
                  })}
                >
                  {milestone.criteria.map((criterion, index) => (
                    <li key={index}>{criterion.text}</li>
                  ))}
                </ul>
              )}
              {cells.length > 0 && (
                <div className="bms-cells" style={{ '--n': cells.length } as CSSProperties}>
                  {cells.map((cell) => (
                    <Tip key={cell.id} content={cell.title}>
                      <button
                        type="button"
                        className="bms-cell"
                        data-state={cell.state ?? cell.status}
                        aria-label={t(
                          { id: 'board.task.link.label', defaultMessage: '{title}, {status}' },
                          { title: cell.title, status: taskStateLabel(cell) },
                        )}
                        onClick={() => onOpenTask(cell.id)}
                      />
                    </Tip>
                  ))}
                </div>
              )}
              {lead && key && (
                <input
                  type="date"
                  className="bd-fsel bms-date"
                  aria-label={t({ id: 'board.plan.milestone.dueOn', defaultMessage: 'Due date' })}
                  value={milestone.due_on ?? ''}
                  onChange={(e) => void setDue(e.target.value || null)}
                />
              )}
              {failure && (
                <div className="tr-fail" role="alert">
                  <span title={failure}>{failure}</span>
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {actions && (
        <Dialog.Root {...accepting.root}>
          {accepting.content && (
            <AcceptDialog
              key={accepting.content.stored.id}
              // A dialog stays open across snapshot refreshes; it gets the row as it is now.
              stored={
                stored?.id === accepting.content.stored.id ? stored : accepting.content.stored
              }
              evidence={acceptEvidence(milestone, model, actions.sessions)}
              run={actions.run}
              onClose={accepting.close}
            />
          )}
        </Dialog.Root>
      )}
    </section>
  );
}
