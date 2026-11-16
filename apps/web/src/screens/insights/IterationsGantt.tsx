import type { CSSProperties, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { TASK_STATE_TONE, TaskStateIcon } from '../board/status';
import { DAY_PX, ganttLayout } from './iterations-gantt-model';
import type { DragProps, DropProps, IterationColumn } from './IterationsTab';

type Task = BoardModel['tasks'][number];
type Iteration = NonNullable<BoardModel['iterations']>[number];

export interface IterationsGanttProps {
  model: BoardModel;
  /** The iteration on the axis; null when the board has none. */
  iteration: Iteration | null;
  columns: IterationColumn[];
  headingId: string;
  /** A bar is being dragged, so the schedule under the bars takes the drop. */
  dragging: boolean;
  dragProps: (task: Task) => DragProps;
  dropProps: (column: IterationColumn) => DropProps;
  /** The task's points and move menu, as on its card. */
  controls: (task: Task) => ReactNode;
  card: (task: Task) => ReactNode;
  onOpenTask: (taskId: string) => void;
  /** Buttons at the end of the schedule's head. */
  actions?: ReactNode;
  /** The summary under the schedule. */
  foot?: ReactNode;
}

const pct = (share: number) => `${share * 100}%`;
const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
/** Horizontal pull of a dependency line's ends, as a share of the axis. */
const PULL = 0.02;

/** The workflow steps the task's runs reached, in run order, each at its newest run. */
const stagesOf = (task: Task) => {
  const newest = new Map<string, NonNullable<Task['step_runs']>[number]>();
  // A rerun replaces the step's run but keeps the place where the step first ran.
  for (const run of task.step_runs ?? []) newest.set(`${run.slot}:${run.step_id}`, run);
  return [...newest.values()];
};

/** The unscheduled tasks beside the iteration's days, one row per slot, with dependency lines. */
export function IterationsGantt({
  model,
  iteration,
  columns,
  headingId,
  dragging,
  dragProps,
  dropProps,
  controls,
  card,
  onOpenTask,
  actions,
  foot,
}: IterationsGanttProps) {
  const layout = ganttLayout(model, iteration);
  const columnOf = (id: string | null) => columns.find((c) => c.id === id)!;
  const dayText = new Intl.DateTimeFormat(currentLocale(), { weekday: 'short', day: 'numeric' });
  const now = new Date(model.now);
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const unscheduledId = `${headingId}-gantt-none`;
  const scheduleId = `${headingId}-gantt-plan`;
  return (
    <div className="itg" data-dragging={dragging || undefined}>
      <aside className="itg-un" aria-labelledby={unscheduledId} {...dropProps(columnOf(null))}>
        <div className="itr-cht">
          <h3 id={unscheduledId}>
            {t({ id: 'insights.iterations.unscheduled', defaultMessage: 'Unscheduled' })}
          </h3>
          <span
            className="itr-pts"
            aria-label={t(
              {
                id: 'insights.iterations.taskCount',
                defaultMessage: '{count, plural, one {# task} other {# tasks}}',
              },
              { count: layout.unscheduled.length },
            )}
          >
            {layout.unscheduled.length}
          </span>
        </div>
        <ul className="itr-cards" aria-labelledby={unscheduledId}>
          {layout.unscheduled.map(card)}
        </ul>
      </aside>
      <div className="itg-main">
        <div className="itr-cht itg-ph">
          <h3 id={scheduleId}>
            {t({ id: 'insights.iterations.schedule', defaultMessage: 'Schedule' })}
          </h3>
          {actions}
        </div>
        <section
          className="itg-plan"
          aria-labelledby={scheduleId}
          {...(iteration ? dropProps(columnOf(iteration.id)) : {})}
        >
          <div className="itg-scroll">
            <div
              className="itg-chart"
              style={
                { '--itg-days': layout.days.length, '--itg-day': `${DAY_PX}px` } as CSSProperties
              }
            >
              <div className="itg-plot" aria-hidden>
                {layout.days.slice(1).map((day) => (
                  <span key={day.date} className="itg-day" style={{ left: pct(day.x) }} />
                ))}
                {layout.today !== null && (
                  <span className="itg-today" style={{ left: pct(layout.today) }} />
                )}
              </div>
              <div className="itg-axis" aria-hidden>
                {layout.days.map((day, i) => (
                  <span
                    key={day.date}
                    data-today={day.date === today || undefined}
                    style={{ left: pct(day.x), width: pct((layout.days[i + 1]?.x ?? 1) - day.x) }}
                  >
                    {dayText.format(dateOf(day.date))}
                  </span>
                ))}
              </div>
              {layout.links.length > 0 && (
                <svg
                  className="itg-links"
                  role="img"
                  aria-label={listText(
                    ...layout.links.map(({ from, to }) =>
                      t(
                        {
                          id: 'insights.iterations.dependsOn',
                          defaultMessage: '{task} waits for {upstream}',
                        },
                        { task: to.task.title, upstream: from.task.title },
                      ),
                    ),
                  )}
                  viewBox={`0 0 1 ${layout.rows}`}
                  preserveAspectRatio="none"
                >
                  {layout.links.map(({ from, to }) => {
                    const y1 = from.slot + 0.5;
                    const y2 = to.slot + 0.5;
                    return (
                      <path
                        key={`${from.task.id}>${to.task.id}`}
                        data-met={from.task.state === 'merged' || undefined}
                        d={`M${from.x2} ${y1}C${from.x2 + PULL} ${y1} ${to.x1 - PULL} ${y2} ${to.x1} ${y2}`}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
                </svg>
              )}
              <ol
                className="itg-rows"
                aria-label={t({ id: 'insights.iterations.slots', defaultMessage: 'Slots' })}
              >
                {Array.from({ length: layout.rows }, (_, slot) => (
                  <li key={slot} className="itg-row">
                    <span className="itg-slot">
                      {t(
                        { id: 'insights.iterations.slot', defaultMessage: 'Slot {n}' },
                        { n: slot + 1 },
                      )}
                    </span>
                    <div className="itg-track">
                      {layout.bars
                        .filter((bar) => bar.slot === slot)
                        .map(({ task, x1, x2, planned }) => {
                          const runtime = (task.claim ?? task.planned)?.runtime;
                          const stages = stagesOf(task);
                          const done = stages.filter((s) => s.state === 'passed').length;
                          return (
                            <div
                              key={task.id}
                              className="itg-bar"
                              data-task-bar={task.id}
                              data-state={task.state}
                              data-planned={planned || undefined}
                              style={
                                {
                                  left: pct(x1),
                                  width: `calc(${pct(x2 - x1)} - 2px)`,
                                  ...(task.state && {
                                    '--itg-c': `var(${TASK_STATE_TONE[task.state]})`,
                                  }),
                                } as CSSProperties
                              }
                              {...dragProps(task)}
                            >
                              <span className="itg-bh">
                                <TaskStateIcon task={task} />
                                <button
                                  type="button"
                                  className="itr-ct"
                                  onClick={() => onOpenTask(task.id)}
                                >
                                  {task.title}
                                </button>
                                {runtime && (
                                  <span
                                    className="itg-rt"
                                    role="img"
                                    aria-label={runtimeName(runtime)}
                                  >
                                    <RuntimeGlyph runtime={runtime} size={14} />
                                  </span>
                                )}
                                {controls(task)}
                              </span>
                              {stages.length > 0 && (
                                <span
                                  className="itg-stg"
                                  role="img"
                                  aria-label={t(
                                    {
                                      id: 'insights.iterations.stages',
                                      defaultMessage: 'Stage progress: {done} of {total} done',
                                    },
                                    { done, total: stages.length },
                                  )}
                                >
                                  {stages.map((s) => (
                                    <i key={s.id} data-state={s.state} />
                                  ))}
                                </span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
        {foot}
      </div>
    </div>
  );
}
