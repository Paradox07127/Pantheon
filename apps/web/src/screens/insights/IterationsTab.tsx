import { useState, type ComponentType, type DragEvent } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  ArrowUp,
  Bot,
  CalendarPlus,
  Check,
  Ellipsis,
  Eye,
  FileText,
  Flag,
  PanelsTopLeft,
  Server,
  Wrench,
  type LucideProps,
} from 'lucide-react';
import type { TaskKind } from '@pantheon/domain';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import {
  compareRuntimes,
  RuntimeGlyph,
  runtimeColor,
  runtimeName,
} from '../../components/RuntimeGlyph';
import { Select } from '../../components/Select';
import { useBoard } from '../../data/board';
import { pickBoardPage } from '../../data/board-page';
import { planVersion, type PlanOp } from '../../data/plan-edit';
import { DOMAIN_LABEL } from '../../data/workflow-policy';
import { planTaskIds } from '../../data/task-trace';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { useShell } from '../../store';
import { Empty } from '../board/Charts';
import { setBoardEditing } from '../board/EditMode';
import { NewTask } from '../board/NewTask';
import { dayText } from '../../lib/time-text';
import { durationText, type RunBoardCommand } from '../board/panels-model';
import { TaskStateIcon } from '../board/status';
import { TellLead, useDialogContent } from '../board/TellLead';
import { isPlanTask } from '../board/view-rules';
import { BarSlot } from './BarSlot';
import { IterationsGantt } from './IterationsGantt';
import { ESTIMATE_SQUARES } from './iterations-gantt-model';
import './iterations.css';

type Task = BoardModel['tasks'][number];
type Iteration = NonNullable<BoardModel['iterations']>[number];
type PlanIterations = Extract<PlanOp, { type: 'set_iterations' }>['iterations'];
type PlanIteration = PlanIterations[number];

/** The estimates a task's points menu offers; the protocol takes any whole number from 1 to 13. */
const ESTIMATES = [1, 2, 3, 5, 8, 13];
/** A new iteration's length in days, its first day included. */
const NEW_LENGTH = 14;
const CHART_W = 120;
const CHART_H = 32;
const UP_W = 320;
const UP_H = 64;

/** The iteration's tasks by where they stand, in the order its progress bar draws them. */
const PROGRESS: { group: string; states: BoardTaskState[]; text: (count: number) => string }[] = [
  {
    group: 'merged',
    states: ['merged'],
    text: (count) =>
      t({ id: 'insights.iterations.progress.merged', defaultMessage: '{count} merged' }, { count }),
  },
  {
    group: 'running',
    states: ['claimed', 'running'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.running', defaultMessage: '{count} running' },
        { count },
      ),
  },
  {
    group: 'gating',
    states: ['gating'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.gating', defaultMessage: '{count} running checks' },
        { count },
      ),
  },
  {
    group: 'merging',
    states: ['awaiting_merge'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.merging', defaultMessage: '{count} awaiting merge' },
        { count },
      ),
  },
  {
    group: 'waiting',
    states: ['waiting_approval'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.waiting', defaultMessage: '{count} waiting for you' },
        { count },
      ),
  },
  {
    group: 'accepting',
    states: ['awaiting_acceptance'],
    text: (count) =>
      t(
        {
          id: 'insights.iterations.progress.accepting',
          defaultMessage: '{count} awaiting acceptance',
        },
        { count },
      ),
  },
  {
    group: 'blocked',
    states: ['blocked'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.blocked', defaultMessage: '{count} blocked' },
        { count },
      ),
  },
  {
    group: 'attention',
    states: ['needs_attention'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.attention', defaultMessage: '{count} need attention' },
        { count },
      ),
  },
  {
    group: 'failed',
    states: ['failed'],
    text: (count) =>
      t({ id: 'insights.iterations.progress.failed', defaultMessage: '{count} failed' }, { count }),
  },
  {
    group: 'todo',
    states: ['todo', 'waiting_upstream'],
    text: (count) =>
      t(
        { id: 'insights.iterations.progress.todo', defaultMessage: '{count} not started' },
        { count },
      ),
  },
];

export interface IterationColumn {
  /** The iteration's board id; null for the unscheduled tasks. */
  id: string | null;
  /** The lead whose plan holds the iteration; null for the unscheduled tasks. */
  leadId: string | null;
  iteration: Iteration | null;
  tasks: Task[];
  points: number;
}

export interface DragProps {
  'data-drag': true | undefined;
  draggable: boolean;
  onDragStart: ((e: DragEvent) => void) | undefined;
  onDragEnd: (() => void) | undefined;
}

export interface DropProps {
  'data-iteration': string;
  'data-drop': true | undefined;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
}

const pointsOf = (task: Task) => task.estimate ?? 1;

/** The unscheduled plan tasks, then each iteration's, in board order, with their points added up. */
export function iterationColumns(
  model: Pick<BoardModel, 'tasks' | 'iterations'>,
): IterationColumn[] {
  const iterations = model.iterations ?? [];
  const plan = model.tasks.filter((task) => isPlanTask(task) && task.owner_session_id);
  const column = (iteration: Iteration | null, tasks: Task[]): IterationColumn => ({
    id: iteration?.id ?? null,
    leadId: iteration ? planTaskIds(iteration.id).lead : null,
    iteration,
    tasks,
    points: tasks.reduce((sum, task) => sum + pointsOf(task), 0),
  });
  return [
    column(
      null,
      plan.filter((task) => !iterations.some((i) => i.id === task.iteration_id)),
    ),
    ...iterations.map((iteration) =>
      column(
        iteration,
        plan.filter((task) => task.iteration_id === iteration.id),
      ),
    ),
  ];
}

/** The lead's iterations as its plan holds them, the shape set_iterations sends back. */
export function leadIterations(
  model: Pick<BoardModel, 'iterations'>,
  leadId: string,
): PlanIteration[] {
  return (model.iterations ?? []).flatMap(({ id, title, starts_on, ends_on }) => {
    const ids = planTaskIds(id);
    return ids.lead === leadId ? [{ id: ids.task, title, starts_on, ends_on }] : [];
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dateOf = (day: string, plus = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d! + plus);
};
const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && dayOf(dateOf(day)) === day;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

function rangeText(iteration: Iteration) {
  const format = new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' });
  return format.formatRange(dateOf(iteration.starts_on), dateOf(iteration.ends_on));
}

/** Points left on each day so far against the straight line from the first day's scope to none. */
function burndown(iteration: Iteration) {
  const span = Math.max(1, daysBetween(iteration.starts_on, iteration.ends_on));
  const top = Math.max(1, ...iteration.days.map((d) => d.scope));
  const x = (date: string) => (daysBetween(iteration.starts_on, date) / span) * CHART_W;
  const y = (left: number) => CHART_H - (left / top) * CHART_H;
  const first = iteration.days[0];
  const last = iteration.days.at(-1);
  const left = last ? last.scope - last.done : iteration.planned - iteration.done;
  return (
    <svg
      className="itr-burn"
      role="img"
      aria-label={t(
        {
          id: 'insights.iterations.burndown',
          defaultMessage: 'Burndown: {left} of {scope} points left',
        },
        { left, scope: last?.scope ?? iteration.planned },
      )}
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      width="100%"
      height={CHART_H}
      preserveAspectRatio="none"
    >
      {first && (
        <line
          className="itr-ideal"
          x1={0}
          y1={y(first.scope)}
          x2={CHART_W}
          y2={CHART_H}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {iteration.days.length > 0 && (
        <polyline
          className="itr-left"
          points={iteration.days.map((d) => `${x(d.date)},${y(d.scope - d.done)}`).join(' ')}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** The iteration's dates and day, its tasks by state, the slot limit and how its scope moved. */
function iterationHeader(
  iteration: Iteration,
  tasks: Task[],
  model: Pick<BoardModel, 'now' | 'slots'>,
) {
  const today = dayOf(new Date(model.now));
  const day =
    iteration.starts_on <= today && today <= iteration.ends_on
      ? daysBetween(iteration.starts_on, today) + 1
      : null;
  const groups = PROGRESS.map((p) => ({
    ...p,
    count: tasks.filter((task) => task.state && p.states.includes(task.state)).length,
  })).filter((g) => g.count > 0);
  const merged = tasks.filter((task) => task.state === 'merged').length;
  let added = 0;
  let removed = 0;
  iteration.days.forEach((d, i) => {
    const moved = i > 0 ? d.scope - iteration.days[i - 1]!.scope : 0;
    if (moved > 0) added += moved;
    else removed -= moved;
  });
  return (
    <section
      className="itr-head"
      aria-label={t({ id: 'insights.iterations.progress', defaultMessage: 'Iteration progress' })}
    >
      <h3>{iteration.title}</h3>
      <span className="itr-dates">{rangeText(iteration)}</span>
      {day !== null && (
        <span className="itr-dates">
          {t({ id: 'insights.iterations.day', defaultMessage: 'Day {day}' }, { day })}
        </span>
      )}
      <span
        className="itr-ratio"
        aria-label={t(
          {
            id: 'insights.iterations.mergedTasks',
            defaultMessage: '{merged} of {total, plural, one {# task} other {# tasks}} merged',
          },
          { merged, total: tasks.length },
        )}
      >
        {merged} / {tasks.length}
      </span>
      {groups.length > 0 && (
        <span
          className="itr-prog"
          role="img"
          aria-label={t(
            {
              id: 'insights.iterations.states',
              defaultMessage: '{count, plural, one {# task} other {# tasks}}: {groups}',
            },
            { count: tasks.length, groups: listText(...groups.map((g) => g.text(g.count))) },
          )}
        >
          {groups.map((g) => (
            <i key={g.group} data-group={g.group} style={{ flexGrow: g.count }} />
          ))}
        </span>
      )}
      {model.slots && (
        <span className="chip">
          <Bot className="ic-sm" aria-hidden="true" />
          {t(
            { id: 'insights.iterations.concurrency', defaultMessage: 'Concurrency {n}' },
            { n: model.slots.limit },
          )}
        </span>
      )}
      {added + removed > 0 && (
        <span className="chip">
          {t(
            { id: 'insights.iterations.scope', defaultMessage: 'Scope +{added} −{removed}' },
            { added, removed },
          )}
        </span>
      )}
      {iteration.capacity !== undefined && (
        <span className="chip">
          {t(
            {
              id: 'insights.iterations.capacity',
              defaultMessage:
                '{count, plural, one {Room for # more task} other {Room for # more tasks}}',
            },
            { count: iteration.capacity },
          )}
        </span>
      )}
      {iteration.forecast_done_at !== undefined && (
        <span className="chip">
          <Flag className="ic-sm" aria-hidden="true" />
          {t(
            { id: 'insights.iterations.forecast', defaultMessage: 'Done by {time}' },
            { time: dayText(iteration.forecast_done_at, model.now, { time: true }) },
          )}
        </span>
      )}
    </section>
  );
}

/** Points done on each day so far against the dashed straight line from none to the scope. */
function burnup(iteration: Iteration, now: number, id: string) {
  const span = Math.max(1, daysBetween(iteration.starts_on, iteration.ends_on));
  const last = iteration.days.at(-1);
  const scope = last?.scope ?? iteration.planned;
  const done = last?.done ?? iteration.done;
  const top = Math.max(1, scope, ...iteration.days.map((d) => d.scope));
  const x = (date: string) => (daysBetween(iteration.starts_on, date) / span) * UP_W;
  const y = (points: number) => UP_H - (points / top) * UP_H;
  const points = iteration.days.map((d) => `${x(d.date)},${y(d.done)}`);
  const today = dayOf(new Date(now));
  return (
    <section className="cell itr-cell" aria-labelledby={id}>
      <div className="itr-cht">
        <h3 id={id}>{t({ id: 'insights.iterations.done', defaultMessage: 'Done' })}</h3>
        <span
          className="itr-pts"
          aria-label={t(
            {
              id: 'insights.iterations.donePoints',
              defaultMessage: '{done} of {planned} points done',
            },
            { done, planned: scope },
          )}
        >
          {done}/{scope}
        </span>
      </div>
      <svg
        className="itr-up"
        role="img"
        aria-label={t(
          {
            id: 'insights.iterations.burnup',
            defaultMessage: 'Done: {done} of {scope} points',
          },
          { done, scope },
        )}
        viewBox={`0 0 ${UP_W} ${UP_H}`}
        width="100%"
        height={UP_H}
        preserveAspectRatio="none"
      >
        <line
          className="itr-plan"
          x1={0}
          y1={UP_H}
          x2={UP_W}
          y2={y(scope)}
          vectorEffect="non-scaling-stroke"
        />
        {points.length > 0 && (
          <>
            <polygon
              className="itr-area"
              points={[
                ...points,
                `${x(iteration.days.at(-1)!.date)},${UP_H}`,
                `${x(iteration.days[0]!.date)},${UP_H}`,
              ].join(' ')}
            />
            <polyline
              className="itr-done"
              points={points.join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
        {iteration.starts_on <= today && today <= iteration.ends_on && (
          <line
            className="itr-now"
            x1={x(today)}
            y1={0}
            x2={x(today)}
            y2={UP_H}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </section>
  );
}

/** How many of the iteration's tasks each runtime takes, by claim, else by the plan's routing. */
function runtimeCounts(tasks: Task[], id: string) {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const runtime = (task.claim ?? task.planned)?.runtime;
    if (runtime) counts.set(runtime, (counts.get(runtime) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const label = t({ id: 'insights.iterations.byRuntime', defaultMessage: 'Tasks per runtime' });
  return (
    <section className="cell itr-cell" aria-labelledby={id}>
      <div className="itr-cht">
        <h3 id={id}>{label}</h3>
      </div>
      <ul className="itr-rts" aria-label={label}>
        {[...counts]
          .sort(([a], [b]) => compareRuntimes(a, b))
          .map(([runtime, count]) => (
            <li key={runtime} className="itr-rtr">
              <span className="itr-rtg" role="img" aria-label={runtimeName(runtime)}>
                <RuntimeGlyph runtime={runtime} size={14} />
              </span>
              <span className="itr-mtr" aria-hidden>
                <i
                  style={{
                    width: `${(count / tasks.length) * 100}%`,
                    background: runtimeColor(runtime),
                  }}
                />
              </span>
              <span className="itr-n">
                {t(
                  {
                    id: 'insights.iterations.taskCount',
                    defaultMessage: '{count, plural, one {# task} other {# tasks}}',
                  },
                  { count },
                )}
              </span>
            </li>
          ))}
      </ul>
    </section>
  );
}

/** The iteration's tasks that failed or wait for the user, each with why. */
function atRisk(tasks: Task[], now: number, id: string, onOpenTask: (taskId: string) => void) {
  const rows = tasks.flatMap((task) => {
    if (task.state === 'failed')
      return [
        {
          task,
          why: t(
            {
              id: 'insights.iterations.atRisk.failed',
              defaultMessage: '{count, plural, one {Failed once} other {Failed # times}}',
            },
            { count: Math.max(1, task.segments.filter((s) => s.status === 'failed').length) },
          ),
        },
      ];
    const waiting = task.activity?.waiting;
    if (waiting)
      return [
        {
          task,
          why: t(
            { id: 'insights.iterations.atRisk.waiting', defaultMessage: 'Waiting for you {time}' },
            { time: durationText(now - waiting.since) },
          ),
        },
      ];
    return [];
  });
  if (!rows.length) return null;
  return (
    <section className="cell itr-cell" aria-labelledby={id}>
      <div className="itr-cht">
        <h3 id={id}>{t({ id: 'insights.iterations.atRisk', defaultMessage: 'At risk' })}</h3>
      </div>
      <ul className="itr-risk" aria-labelledby={id}>
        {rows.map(({ task, why }) => (
          <li key={task.id}>
            <TaskStateIcon task={task} />
            <button
              type="button"
              className="itr-riskt"
              title={task.title}
              onClick={() => onOpenTask(task.id)}
            >
              {task.title}
            </button>
            <span className="itr-n">{why}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const KIND_ICON: Record<TaskKind['domain'], ComponentType<LucideProps>> = {
  review: Eye,
  'frontend-ui': PanelsTopLeft,
  'script-infra': Wrench,
  'backend-logic': Server,
  'docs-chore': FileText,
};

export type IterationsMode = 'columns' | 'gantt';

export interface IterationsBarControlsProps {
  /** The shown iteration's title; null when the board has no iteration. */
  title: string | null;
  /** Null at the first iteration. */
  onPrevious: (() => void) | null;
  /** Null at the last iteration. */
  onNext: (() => void) | null;
  mode: IterationsMode;
  onMode: (mode: IterationsMode) => void;
  /** Absent on a board it cannot edit. */
  onNewIteration?: () => void;
  /** The board and project a new task joins; absent on a board it cannot edit. */
  newTask?: { model: BoardModel; projectId: string };
}

/** The iteration stepper, the view switch and the new iteration and new task buttons. */
export function IterationsBarControls({
  title,
  onPrevious,
  onNext,
  mode,
  onMode,
  onNewIteration,
  newTask,
}: IterationsBarControlsProps) {
  return (
    <div className="itr-bar">
      {title !== null && (
        <div
          className="tb-seg itr-pick"
          role="group"
          aria-label={t({ id: 'insights.iterations.shown', defaultMessage: 'Iteration' })}
        >
          <button
            type="button"
            aria-label={t({
              id: 'insights.iterations.previous',
              defaultMessage: 'Previous iteration',
            })}
            disabled={!onPrevious}
            onClick={onPrevious ?? undefined}
          >
            {t({ id: 'insights.iterations.previousShort', defaultMessage: 'Previous' })}
          </button>
          <span className="itr-pickt">{title}</span>
          <button
            type="button"
            aria-label={t({ id: 'insights.iterations.next', defaultMessage: 'Next iteration' })}
            disabled={!onNext}
            onClick={onNext ?? undefined}
          >
            {t({ id: 'insights.iterations.nextShort', defaultMessage: 'Next' })}
          </button>
        </div>
      )}
      <RadioGroup<IterationsMode>
        className="tb-seg"
        aria-label={t({ id: 'insights.iterations.view', defaultMessage: 'Iterations view' })}
        value={mode}
        onValueChange={onMode}
      >
        <Radio.Root value="columns">
          {t({ id: 'insights.iterations.columns', defaultMessage: 'Columns' })}
        </Radio.Root>
        <Radio.Root value="gantt">
          {t({ id: 'insights.iterations.gantt', defaultMessage: 'Gantt' })}
        </Radio.Root>
      </RadioGroup>
      {onNewIteration && (
        <button
          type="button"
          className="btn"
          aria-label={t({ id: 'insights.iterations.new', defaultMessage: 'New iteration' })}
          title={t({ id: 'insights.iterations.new', defaultMessage: 'New iteration' })}
          onClick={onNewIteration}
        >
          <CalendarPlus className="ic-sm" aria-hidden="true" />
          <span className="tb-lbl">
            {t({ id: 'insights.iterations.new', defaultMessage: 'New iteration' })}
          </span>
        </button>
      )}
      {newTask && (
        <NewTask
          model={newTask.model}
          disabled={false}
          onNew={() => {
            // The new task form is in the board's edit mode, on its now page.
            pickBoardPage(newTask.projectId, 'now');
            setBoardEditing(newTask.projectId, true);
            useShell.getState().setScreen('board');
          }}
        />
      )}
    </div>
  );
}

interface Draft {
  lead: string;
  title: string;
  starts_on: string;
  ends_on: string;
}

type DialogTarget =
  { mode: 'new'; draft: Draft } | { mode: 'title' | 'dates'; draft: Draft; id: string };

function IterationDialog({
  target,
  leads,
  onSave,
  onDone,
}: {
  target: DialogTarget;
  leads: { id: string; title: string }[];
  onSave: (draft: Draft) => Promise<string | null>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(target.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mode } = target;
  const title = draft.title.trim();
  const datesOk =
    validDay(draft.starts_on) && validDay(draft.ends_on) && draft.starts_on <= draft.ends_on;
  const ok = (mode === 'dates' || title !== '') && (mode === 'title' || datesOk);
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onSave({ ...draft, title });
    setBusy(false);
    if (failure) setError(failure);
    else onDone();
  };
  const heading =
    mode === 'new'
      ? t({ id: 'insights.iterations.new', defaultMessage: 'New iteration' })
      : mode === 'title'
        ? t({ id: 'insights.iterations.rename', defaultMessage: 'Rename' })
        : t({ id: 'insights.iterations.redate', defaultMessage: 'Change dates' });
  const leadText = t({ id: 'insights.iterations.lead', defaultMessage: 'Lead' });
  const titleText = t({ id: 'insights.iterations.title', defaultMessage: 'Title' });
  const startText = t({ id: 'insights.iterations.start', defaultMessage: 'Start date' });
  const endText = t({ id: 'insights.iterations.end', defaultMessage: 'End date' });
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="pj-scrim" />
      <Dialog.Popup className="pj-dlg pj-rm pop">
        <div className="pj-dh">
          <Dialog.Title className="pj-dt">{heading}</Dialog.Title>
        </div>
        <div className="bp-dlb itr-form">
          {mode === 'new' && leads.length > 1 && (
            <Select
              aria-label={leadText}
              value={draft.lead}
              disabled={busy}
              onChange={(lead) => setDraft({ ...draft, lead })}
              options={leads.map((lead) => ({ value: lead.id, label: lead.title || lead.id }))}
            />
          )}
          {mode !== 'dates' && (
            <input
              className="bd-fsel"
              aria-label={titleText}
              value={draft.title}
              readOnly={busy}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          )}
          {mode !== 'title' && (
            <span className="itr-dts">
              <input
                type="date"
                className="bd-fsel"
                aria-label={startText}
                value={draft.starts_on}
                readOnly={busy}
                aria-invalid={!datesOk || undefined}
                onChange={(e) => setDraft({ ...draft, starts_on: e.target.value })}
              />
              <input
                type="date"
                className="bd-fsel"
                aria-label={endText}
                value={draft.ends_on}
                min={draft.starts_on}
                readOnly={busy}
                aria-invalid={!datesOk || undefined}
                onChange={(e) => setDraft({ ...draft, ends_on: e.target.value })}
              />
            </span>
          )}
        </div>
        {error && (
          <div className="pj-err" role="alert">
            <b>{error}</b>
          </div>
        )}
        <div className="pj-df">
          <span style={{ flex: 1 }} />
          <Dialog.Close className="btn ghost">
            {t({ id: 'insights.iterations.cancel', defaultMessage: 'Cancel' })}
          </Dialog.Close>
          <button
            type="button"
            className="btn pri"
            aria-busy={busy || undefined}
            disabled={busy || !ok}
            onClick={() => void save()}
          >
            {t({ id: 'insights.iterations.save', defaultMessage: 'Save' })}
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

const modeKey = (projectId: string) => `pantheon.insights.iterations.${projectId}`;

function storedMode(projectId: string | undefined): IterationsMode {
  try {
    return projectId && localStorage.getItem(modeKey(projectId)) === 'columns'
      ? 'columns'
      : 'gantt';
  } catch {
    return 'gantt';
  }
}

export interface IterationsTabProps {
  model: BoardModel;
  /** Where the chosen view is remembered; absent, the gantt chart shows. */
  projectId?: string;
  /** The project and command runner behind the plan edits; absent, nothing moves. */
  edit?: { projectId: string; run: RunBoardCommand };
  onOpenTask: (taskId: string) => void;
  /** The top bar's place for the iteration controls, once it is in. */
  bar?: HTMLElement | null;
}

/** One iteration's progress over its plan tasks on a gantt chart beside the unscheduled ones, or every iteration in a column; tasks move by dragging or from each card's menu. */
export function IterationsTab({ model, projectId, edit, onOpenTask, bar }: IterationsTabProps) {
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ projectId?: string; mode: IterationsMode } | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const dialog = useDialogContent<DialogTarget>();
  const sessions = useBoard((s) => s.board?.sessions) ?? [];
  const headingId = 'itr-h';
  const leads = (model.leads ?? []).map((l) => ({ id: l.session_id, title: l.title }));
  const heading = t({ id: 'insights.sections.iterations', defaultMessage: 'Iterations' });
  const mode = picked && picked.projectId === projectId ? picked.mode : storedMode(projectId);
  const pickMode = (next: IterationsMode) => {
    setPicked({ projectId, mode: next });
    try {
      if (projectId) localStorage.setItem(modeKey(projectId), next);
    } catch {
      // The choice still holds while the tab stays open.
    }
  };
  if (!leads.length)
    return (
      <section className="itr" aria-label={heading}>
        <Empty text={t({ id: 'board.newTask.noPlan', defaultMessage: 'No lead plan yet' })} />
      </section>
    );

  const columns = iterationColumns(model);
  const columnOf = (task: Task) => columns.find((c) => c.tasks.includes(task))!;
  const send = async (leadId: string, ops: PlanOp[]) =>
    edit
      ? edit.run(
          'board.plan.edit',
          {
            project_id: edit.projectId,
            lead_session_id: leadId,
            base_version: planVersion(model, leadId),
            ops,
          },
          null,
        )
      : null;
  const report = async (sent: Promise<string | null>) => {
    setFailure(null);
    setFailure(await sent);
  };
  const setTask = (task: Task, patch: Extract<PlanOp, { type: 'set_task' }>['patch']) => {
    const { lead, task: planId } = planTaskIds(task.id);
    void report(send(lead, [{ type: 'set_task', task_id: planId, patch }]));
  };
  const fits = (task: Task, to: IterationColumn) =>
    columnOf(task) !== to && (to.leadId === null || to.leadId === task.owner_session_id);
  const moveTo = (task: Task, to: IterationColumn) => {
    if (fits(task, to)) setTask(task, { iteration: to.id && planTaskIds(to.id).task });
  };
  const dragged = drag && model.tasks.find((task) => task.id === drag.id);
  const accepts = (to: IterationColumn) => !!edit && !!dragged && fits(dragged, to);
  const setIterations = (leadId: string, iterations: PlanIterations) =>
    send(leadId, [{ type: 'set_iterations', iterations }]);

  const today = dayOf(new Date(model.now));
  const byStart = [...(model.iterations ?? [])].sort((a, b) =>
    a.starts_on.localeCompare(b.starts_on),
  );
  // Without a pick: the iteration holding today, else the next to start, else the last.
  const shown =
    byStart.find((i) => i.id === shownId) ??
    byStart.find((i) => i.starts_on <= today && today <= i.ends_on) ??
    byStart.find((i) => i.starts_on > today) ??
    byStart.at(-1) ??
    null;
  const shownAt = shown ? byStart.indexOf(shown) : -1;
  const shownTasks = shown ? columns.find((c) => c.id === shown.id)!.tasks : [];
  const newDraft = (lead: string): Draft => ({
    lead,
    title: t(
      { id: 'insights.iterations.defaultTitle', defaultMessage: 'Iteration {n}' },
      { n: leadIterations(model, lead).length + 1 },
    ),
    starts_on: today,
    ends_on: dayOf(dateOf(today, NEW_LENGTH - 1)),
  });
  const save = (target: DialogTarget) => (draft: Draft) => {
    const list = leadIterations(model, draft.lead);
    if (target.mode === 'new') {
      let n = list.length + 1;
      while (list.some((i) => i.id === `iteration-${n}`)) n++;
      const { title, starts_on, ends_on } = draft;
      return setIterations(draft.lead, [
        ...list,
        { id: `iteration-${n}`, title, starts_on, ends_on },
      ]);
    }
    const id = planTaskIds(target.id).task;
    return setIterations(
      draft.lead,
      list.map((i) =>
        i.id !== id
          ? i
          : target.mode === 'title'
            ? { ...i, title: draft.title }
            : { ...i, starts_on: draft.starts_on, ends_on: draft.ends_on },
      ),
    );
  };

  const columnMenu = (column: IterationColumn & { iteration: Iteration; leadId: string }) => {
    const { iteration, leadId } = column;
    const draft: Draft = {
      lead: leadId,
      title: iteration.title,
      starts_on: iteration.starts_on,
      ends_on: iteration.ends_on,
    };
    const remove = () =>
      void report(
        setIterations(
          leadId,
          leadIterations(model, leadId).filter((i) => i.id !== planTaskIds(iteration.id).task),
        ),
      );
    return (
      <Menu.Root>
        <Menu.Trigger
          className="ib"
          aria-label={t(
            { id: 'insights.iterations.menu', defaultMessage: '{title} options' },
            { title: iteration.title },
          )}
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
            <Menu.Popup className="wmenu pop">
              <Menu.Item onClick={() => dialog.show({ mode: 'title', draft, id: iteration.id })}>
                {t({ id: 'insights.iterations.rename', defaultMessage: 'Rename' })}
              </Menu.Item>
              <Menu.Item onClick={() => dialog.show({ mode: 'dates', draft, id: iteration.id })}>
                {t({ id: 'insights.iterations.redate', defaultMessage: 'Change dates' })}
              </Menu.Item>
              <Menu.Separator className="pjm-sep" />
              <Menu.Item onClick={remove}>
                {t({ id: 'insights.iterations.delete', defaultMessage: 'Delete' })}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  };

  const pointsMenu = (task: Task) => {
    const points = pointsOf(task);
    const label = t(
      { id: 'insights.iterations.points', defaultMessage: 'Points of {task}: {points}' },
      { task: task.title, points },
    );
    const squares = (
      <span className="itr-acc" aria-hidden="true">
        {Array.from({ length: Math.min(points, ESTIMATE_SQUARES) }, (_, i) => (
          <i key={i} />
        ))}
        {points > ESTIMATE_SQUARES && <span>+{points - ESTIMATE_SQUARES}</span>}
      </span>
    );
    if (!edit)
      return (
        <span className="itr-est" role="img" aria-label={label}>
          {squares}
        </span>
      );
    return (
      <Menu.Root>
        <Menu.Trigger className="itr-est" aria-label={label}>
          {squares}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
            <Menu.Popup className="wmenu pjm pop">
              <Menu.RadioGroup value={String(points)} aria-label={label}>
                {ESTIMATES.map((n) => (
                  <Menu.RadioItem
                    key={n}
                    value={String(n)}
                    closeOnClick
                    onClick={() => {
                      if (n !== points) setTask(task, { estimate: n });
                    }}
                  >
                    <span className="pjm-ck">
                      <Menu.RadioItemIndicator>
                        <Check className="ic-sm" aria-hidden="true" />
                      </Menu.RadioItemIndicator>
                    </span>
                    {n}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  };

  const moveMenu = (task: Task) => {
    const targets = columns.filter((c) => fits(task, c));
    if (!edit || !targets.length) return null;
    return (
      <Menu.Root>
        <Menu.Trigger
          className="ib"
          aria-label={t(
            { id: 'insights.iterations.move', defaultMessage: 'Move {task}' },
            { task: task.title },
          )}
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
            <Menu.Popup className="wmenu pop">
              {targets.map((to) => (
                <Menu.Item key={to.id ?? 'none'} onClick={() => moveTo(task, to)}>
                  {to.iteration
                    ? t(
                        { id: 'insights.iterations.moveTo', defaultMessage: 'Move to {title}' },
                        { title: to.iteration.title },
                      )
                    : t({
                        id: 'insights.iterations.moveOut',
                        defaultMessage: 'Move to unscheduled',
                      })}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  };

  const dragProps = (task: Task): DragProps => ({
    'data-drag': drag?.id === task.id || undefined,
    draggable: !!edit,
    onDragStart:
      edit &&
      ((e: DragEvent) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        setDrag({ id: task.id, over: null });
      }),
    onDragEnd: edit && (() => setDrag(null)),
  });

  const dropProps = (c: IterationColumn): DropProps => {
    const key = c.id ?? 'none';
    return {
      'data-iteration': key,
      'data-drop': drag?.over === key || undefined,
      onDragOver: (e: DragEvent) => {
        if (!accepts(c)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (drag?.over !== key) setDrag({ id: drag!.id, over: key });
      },
      onDragLeave: () => {
        if (drag?.over === key) setDrag({ id: drag.id, over: null });
      },
      onDrop: (e: DragEvent) => {
        if (!accepts(c)) return;
        e.preventDefault();
        moveTo(dragged!, c);
        setDrag(null);
      },
    };
  };

  const controls = (task: Task) => (
    <>
      {pointsMenu(task)}
      {moveMenu(task)}
    </>
  );

  const card = (task: Task) => {
    const kind = task.kind?.domain;
    const Kind = kind && KIND_ICON[kind];
    return (
      <li key={task.id} className="itr-card" data-task-card={task.id} {...dragProps(task)}>
        <TaskStateIcon task={task} />
        {Kind && (
          <span className="itr-kind" role="img" aria-label={DOMAIN_LABEL[kind]}>
            <Kind aria-hidden="true" />
          </span>
        )}
        <button type="button" className="itr-ct" onClick={() => onOpenTask(task.id)}>
          {task.title}
        </button>
        {task.priority === 'high' && (
          <span
            className="itr-pri"
            role="img"
            aria-label={t({
              id: 'insights.iterations.highPriority',
              defaultMessage: 'High priority',
            })}
          >
            <ArrowUp aria-hidden="true" />
          </span>
        )}
        {controls(task)}
      </li>
    );
  };

  const column = (c: IterationColumn) => {
    const key = c.id ?? 'none';
    const titleId = `${headingId}-${key}`;
    return (
      <section key={key} className="itr-col" aria-labelledby={titleId} {...dropProps(c)}>
        <div className="itr-ch">
          <div className="itr-cht">
            <h3 id={titleId}>
              {c.iteration
                ? c.iteration.title
                : t({ id: 'insights.iterations.unscheduled', defaultMessage: 'Unscheduled' })}
            </h3>
            {c.iteration ? (
              <span
                className="itr-pts"
                aria-label={t(
                  {
                    id: 'insights.iterations.donePoints',
                    defaultMessage: '{done} of {planned} points done',
                  },
                  { done: c.iteration.done, planned: c.iteration.planned },
                )}
              >
                {c.iteration.done}/{c.iteration.planned}
              </span>
            ) : (
              <span
                className="itr-pts"
                aria-label={t(
                  {
                    id: 'insights.iterations.totalPoints',
                    defaultMessage: '{points, plural, one {# point} other {# points}}',
                  },
                  { points: c.points },
                )}
              >
                {c.points}
              </span>
            )}
            {edit &&
              c.iteration &&
              c.leadId &&
              columnMenu({ ...c, iteration: c.iteration, leadId: c.leadId })}
          </div>
          {c.iteration && <span className="itr-dates">{rangeText(c.iteration)}</span>}
          {c.iteration && burndown(c.iteration)}
        </div>
        <ul className="itr-cards" aria-labelledby={titleId}>
          {c.tasks.map(card)}
        </ul>
      </section>
    );
  };

  const foot = shown && (
    <div className="panel itr-foot">
      {burnup(shown, model.now, `${headingId}-up`)}
      {runtimeCounts(shownTasks, `${headingId}-rt`)}
      {atRisk(shownTasks, model.now, `${headingId}-risk`, onOpenTask)}
    </div>
  );

  return (
    <section className="itr" aria-label={heading}>
      <BarSlot bar={bar}>
        {IterationsBarControls({
          title: shown?.title ?? null,
          onPrevious: shownAt > 0 ? () => setShownId(byStart[shownAt - 1]!.id) : null,
          onNext:
            shown && shownAt < byStart.length - 1
              ? () => setShownId(byStart[shownAt + 1]!.id)
              : null,
          mode,
          onMode: pickMode,
          onNewIteration:
            edit && (() => dialog.show({ mode: 'new', draft: newDraft(leads[0]!.id) })),
          newTask: edit && { model, projectId: edit.projectId },
        })}
      </BarSlot>
      {failure && (
        <p className="bd-perr" role="alert">
          {failure}
        </p>
      )}
      {shown && iterationHeader(shown, shownTasks, model)}
      {mode === 'gantt' ? (
        <IterationsGantt
          model={model}
          iteration={shown}
          columns={columns}
          headingId={headingId}
          dragging={!!drag}
          dragProps={dragProps}
          dropProps={dropProps}
          controls={controls}
          card={card}
          onOpenTask={onOpenTask}
          actions={
            edit &&
            shown && (
              <TellLead
                className="btn sm"
                lead={sessions.find((s) => s.id === planTaskIds(shown.id).lead)}
                draft={t(
                  {
                    id: 'insights.iterations.rescheduleDraft',
                    defaultMessage: 'Reschedule the tasks of iteration “{title}” ({id}):\n',
                  },
                  { title: shown.title, id: planTaskIds(shown.id).task },
                )}
                label={shown.title}
                run={edit.run}
                text={t({
                  id: 'insights.iterations.reschedule',
                  defaultMessage: 'Ask the lead to reschedule',
                })}
              />
            )
          }
          foot={foot}
        />
      ) : (
        <div className="itr-main">
          <div className="itr-cols">{columns.map(column)}</div>
          {foot}
        </div>
      )}
      <Dialog.Root {...dialog.root}>
        {dialog.content && (
          <IterationDialog
            key={`${dialog.content.mode}:${'id' in dialog.content ? dialog.content.id : ''}`}
            target={dialog.content}
            leads={leads}
            onSave={save(dialog.content)}
            onDone={dialog.close}
          />
        )}
      </Dialog.Root>
    </section>
  );
}
