import { useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ChevronUp, ListFilter } from 'lucide-react';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { DiffCounts } from '../../components/DiffCounts';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { blockerTexts } from '../../lib/daemon-text';
import { listText } from '../../lib/list-text';
import { STAGES, STAGE_NAME, stageOf } from './FlowNode';
import {
  durationText,
  nextSort,
  sortTasks,
  taskDuration,
  type BoardTask,
  type TaskSort,
  type TaskSortKey,
} from './panels-model';
import { stallRows } from './progress-model';
import {
  StateIcon,
  TASK_STATE_TONE,
  TASK_STATUS_TONE,
  TaskStateIcon,
  taskStateLabel,
} from './status';
import { taskGroups } from './TaskGroups';
import './task-list.css';

/** Rows a group shows before the rest fold behind a switch. */
const FOLDED_ROWS = 8;

interface ListGroup {
  key: string;
  label: string;
  /** The state whose icon and colour stand for the group; absent for sessions without a plan task. */
  icon?: BoardTaskState;
  tasks: BoardTask[];
}

const toneOf = (group: ListGroup) => (group.icon ? TASK_STATE_TONE[group.icon] : '--mu');

/** The plan tasks by what they wait for, then the sessions that belong to no plan task. */
function listGroups(model: Pick<BoardModel, 'tasks' | 'needs'>): ListGroup[] {
  const groups: ListGroup[] = taskGroups(model);
  const sessions = model.tasks.filter((task) => !task.state);
  if (sessions.length)
    groups.push({
      key: 'sessions',
      label: t({ id: 'board.tasks.list.sessions', defaultMessage: 'Other sessions' }),
      tasks: sessions,
    });
  return groups;
}

/** The ids of the blocked and stalled tasks, as the stall rule judges them. */
export function stuckTasks(tasks: BoardModel['tasks'], now: number): Set<string> {
  return new Set(stallRows({ tasks, now }).map((row) => row.task.id));
}

/** The dispatch waits whose reason the row says after the title. */
const HELD = new Set<BoardTask['dispatch_wait']>([
  'paused',
  'runtime_capacity',
  'device_offline',
  'device_capacity',
  'device_resource',
]);

const toneVar = (task: BoardTask) =>
  `var(${task.state ? TASK_STATE_TONE[task.state] : TASK_STATUS_TONE[task.status]})`;

function Stage({ task }: { task: BoardTask }) {
  const stage = stageOf(task);
  if (!stage) return null;
  const done = stage.done ? STAGES.length : stage.at;
  return (
    <>
      <span
        className="btk-stg"
        role="img"
        aria-label={t(
          {
            id: 'board.tasks.list.stage',
            defaultMessage: 'Stages: {done} of {count} done, now {stage}',
          },
          { done, count: STAGES.length, stage: STAGE_NAME[STAGES[stage.at]!]() },
        )}
        style={{ '--c': toneVar(task) } as CSSProperties}
      >
        {STAGES.map((_, i) => (
          <i key={i} data-at={i < done ? 'done' : i === stage.at ? 'now' : undefined} />
        ))}
      </span>
      <span className="btk-n">{`${done} / ${STAGES.length}`}</span>
    </>
  );
}

const STEP_ORDER = ['failed', 'passed', 'skipped', 'running', 'pending'] as const;

function Checks({ task }: { task: BoardTask }) {
  const steps = (task.gate_steps ?? [])
    .slice()
    .sort((a, b) => STEP_ORDER.indexOf(a.state) - STEP_ORDER.indexOf(b.state));
  const ran = steps.some((s) => s.state !== 'pending');
  const passed = steps.filter((s) => s.state === 'passed').length;
  const failed = steps.filter((s) => s.state === 'failed').length;
  return (
    <>
      <span
        className="btk-gm"
        role="img"
        aria-label={
          ran
            ? t(
                {
                  id: 'board.tasks.list.checks',
                  defaultMessage: 'Checks: {count} steps, {failed} failed, {passed} passed',
                },
                { count: steps.length, failed, passed },
              )
            : t({ id: 'board.tasks.list.checksNotRun', defaultMessage: 'Checks not run yet' })
        }
      >
        {steps.map((s, i) => (
          <i key={i} data-state={s.state} />
        ))}
      </span>
      {ran ? (
        <span className="btk-n">{`${passed} / ${steps.length}`}</span>
      ) : (
        <span className="btk-n" data-faint="">
          {t({ id: 'board.tasks.list.notRun', defaultMessage: 'Not run' })}
        </span>
      )}
    </>
  );
}

const DIFF_CELLS = 5;

function Changes({ task }: { task: BoardTask }) {
  const additions = task.additions ?? 0;
  const deletions = task.deletions ?? 0;
  const total = additions + deletions;
  const added = total ? Math.round((DIFF_CELLS * additions) / total) : 0;
  return (
    <>
      <span
        className="btk-df"
        role="img"
        aria-label={
          total
            ? t(
                {
                  id: 'board.tasks.list.changes',
                  defaultMessage: '{additions} lines added, {deletions} deleted',
                },
                { additions, deletions },
              )
            : t({ id: 'board.tasks.list.noChanges', defaultMessage: 'No changes yet' })
        }
      >
        {Array.from({ length: DIFF_CELLS }, (_, i) => (
          <i key={i} data-diff={!total ? undefined : i < added ? 'add' : 'del'} />
        ))}
      </span>
      <span className="btk-dn">
        <DiffCounts additions={additions} deletions={deletions} />
      </span>
    </>
  );
}

/** The tasks in scope as one table read through graphics, grouped by what they wait for. */
export function TaskList({
  model,
  onOpenTask,
  bar,
}: {
  model: Pick<BoardModel, 'tasks' | 'needs' | 'now'>;
  onOpenTask: (taskId: string) => void;
  /** The board bar's element the stuck filter goes in, once it is in. */
  bar: HTMLElement | null;
}) {
  const [sort, setSort] = useState<TaskSort | null>(null);
  const [closed, setClosed] = useState<readonly string[]>(['merged']);
  const [opened, setOpened] = useState<readonly string[]>([]);
  const [stuckOnly, setStuckOnly] = useState(false);
  // Durations and stalls grow with time alone, while the model is read again only on events.
  const now = Math.max(model.now, useNow(15_000));
  const stuck = stuckTasks(model.tasks, now);
  const shown = stuckOnly ? model.tasks.filter((task) => stuck.has(task.id)) : model.tasks;
  const groups = listGroups({ tasks: shown, needs: model.needs });
  const counts = listGroups(model);
  const scale = Math.max(0, ...model.tasks.map((task) => taskDuration(task, now) ?? 0));
  const flat = sort?.key === 'duration';
  const sections: ListGroup[] = flat
    ? [{ key: 'all', label: '', tasks: sortTasks(shown, sort, now) }]
    : groups.map((group) =>
        sort ? { ...group, tasks: sortTasks(group.tasks, sort, now) } : group,
      );
  const toggle = (list: readonly string[], key: string) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

  const header = (key: TaskSortKey, label: string, extra?: ReactNode) => {
    const on = sort?.key === key;
    return (
      <span
        className="btk-th"
        role="columnheader"
        aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          className="btk-sb"
          data-on={on || undefined}
          aria-label={t(
            { id: 'board.tasks.list.sortBy', defaultMessage: 'Sort by {column}' },
            { column: label },
          )}
          onClick={() => setSort(nextSort(sort, key))}
        >
          {label}
          {on &&
            (sort.dir === 1 ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            ))}
        </button>
        {extra}
      </span>
    );
  };

  const onRowKey = (e: KeyboardEvent, id: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onOpenTask(id);
  };

  const row = (task: BoardTask) => {
    const dur = taskDuration(task, now);
    const status = taskStateLabel(task);
    return (
      <div
        key={task.id}
        className="btk-r"
        role="row"
        tabIndex={0}
        aria-label={t(
          { id: 'board.tasks.list.rowLabel', defaultMessage: '{task}, {status}' },
          { task: task.title, status },
        )}
        onClick={() => onOpenTask(task.id)}
        onKeyDown={(e) => onRowKey(e, task.id)}
      >
        <span className="btk-c" role="cell">
          <span className="btk-st" role="img" aria-label={status}>
            <TaskStateIcon task={task} />
          </span>
        </span>
        <span className="btk-c btk-tt" role="cell">
          <Clip text={task.title} />
          {HELD.has(task.dispatch_wait) && <span className="btk-why">{blockerTexts(task)[0]}</span>}
          {stuck.has(task.id) && (
            <span className="chip btk-stk" style={{ '--c': toneVar(task) } as CSSProperties}>
              {t({ id: 'board.tasks.list.stuck', defaultMessage: 'Stuck' })}
            </span>
          )}
        </span>
        <span className="btk-c" role="cell">
          <Stage task={task} />
        </span>
        <span className="btk-c" role="cell">
          {dur != null && (
            <>
              <span
                className="meter btk-age"
                role="img"
                aria-label={t(
                  {
                    id: 'board.tasks.list.time',
                    defaultMessage: 'Time {duration}, scale {scale}',
                  },
                  { duration: durationText(dur), scale: durationText(scale) },
                )}
                style={{ '--v': `${scale ? (dur / scale) * 100 : 0}%` } as CSSProperties}
              >
                <i />
              </span>
              <span className="btk-n">{durationText(dur)}</span>
            </>
          )}
        </span>
        <span className="btk-c" role="cell">
          <Checks task={task} />
        </span>
        <span className="btk-c" role="cell">
          <Changes task={task} />
        </span>
      </div>
    );
  };

  const total = counts.reduce((n, g) => n + g.tasks.length, 0);
  return (
    <section className="btk" data-debug-region="board.task-groups">
      {bar &&
        createPortal(
          <button
            type="button"
            className="btn btk-flt"
            aria-pressed={stuckOnly}
            aria-label={t(
              { id: 'board.tasks.list.stuckFilter', defaultMessage: 'Stuck {count}' },
              { count: stuck.size },
            )}
            onClick={() => setStuckOnly((on) => !on)}
          >
            <ListFilter className="ic-sm" aria-hidden="true" />
            <span className="tb-lbl">
              {t({ id: 'board.tasks.list.stuckOnly', defaultMessage: 'Stuck' })}
            </span>
            <span className="btk-fn">{stuck.size}</span>
          </button>,
          bar,
        )}
      {total > 0 && (
        <div className="btk-top">
          <div
            className="btk-share"
            role="img"
            aria-label={t(
              {
                id: 'board.tasks.list.share',
                defaultMessage: '{count, plural, one {# task} other {# tasks}}: {parts}',
              },
              {
                count: total,
                parts: listText(...counts.map((g) => `${g.label} ${g.tasks.length}`)),
              },
            )}
          >
            {counts.map((g) => (
              <i
                key={g.key}
                style={{ flexGrow: g.tasks.length, background: `var(${toneOf(g)})` }}
              />
            ))}
          </div>
          <div className="legend btk-lg" aria-hidden="true">
            {counts.map((g) => (
              <span key={g.key}>
                {g.icon && <StateIcon state={g.icon} />}
                {g.label}
                <span className="btk-ln">{g.tasks.length}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <div
        className="btk-tb"
        role="table"
        aria-label={t({ id: 'board.tasks.list.table', defaultMessage: 'Task list' })}
      >
        <div className="btk-r btk-hr" role="row">
          {header('status', t({ id: 'board.tasks.list.columns.status', defaultMessage: 'Status' }))}
          {header('task', t({ id: 'board.tasks.list.columns.task', defaultMessage: 'Task' }))}
          <span className="btk-th" role="columnheader">
            {t({ id: 'board.tasks.list.columns.progress', defaultMessage: 'Progress' })}
          </span>
          {header(
            'duration',
            t({ id: 'board.tasks.list.columns.time', defaultMessage: 'Time' }),
            scale > 0 && <span className="btk-n">{durationText(scale)}</span>,
          )}
          <span className="btk-th" role="columnheader">
            {t({ id: 'board.tasks.list.columns.checks', defaultMessage: 'Checks' })}
          </span>
          <span className="btk-th" role="columnheader">
            {t({ id: 'board.tasks.list.columns.changes', defaultMessage: 'Changes' })}
          </span>
        </div>
        {sections.map((group) => {
          const open = flat || !closed.includes(group.key);
          const all = opened.includes(group.key);
          const rows = all ? group.tasks : group.tasks.slice(0, FOLDED_ROWS);
          return (
            <div key={group.key} role="rowgroup" aria-label={group.label || undefined}>
              {!flat && (
                <div className="btk-gh" role="row">
                  <span role="cell">
                    <button
                      type="button"
                      className="btk-gb"
                      aria-expanded={open}
                      aria-label={
                        open
                          ? t(
                              {
                                id: 'board.tasks.list.collapse',
                                defaultMessage: 'Collapse {group}',
                              },
                              { group: group.label },
                            )
                          : t(
                              { id: 'board.tasks.list.expand', defaultMessage: 'Expand {group}' },
                              { group: group.label },
                            )
                      }
                      onClick={() => setClosed(toggle(closed, group.key))}
                    >
                      {open ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                      <b>{group.label}</b>
                      <span className="btk-ln">{group.tasks.length}</span>
                    </button>
                  </span>
                </div>
              )}
              {open && rows.map(row)}
              {open && group.tasks.length > FOLDED_ROWS && (
                <div className="btk-more" role="row">
                  <span role="cell">
                    <button
                      type="button"
                      className="bd-lnk bf-more"
                      aria-expanded={all}
                      onClick={() => setOpened(toggle(opened, group.key))}
                    >
                      {all
                        ? t({ id: 'board.rows.less', defaultMessage: 'Show less' })
                        : t(
                            { id: 'board.rows.all', defaultMessage: 'Show all {count} rows' },
                            { count: group.tasks.length },
                          )}
                    </button>
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
