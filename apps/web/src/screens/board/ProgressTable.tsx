import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Ellipsis } from 'lucide-react';
import type { BoardModel, BoardTaskState, BoardTaskStatus } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { useNow } from '../../data/needs-you';
import { editPlan, moveTaskOp, planVersion } from '../../data/plan-edit';
import { planTaskIds } from '../../data/task-trace';
import { t } from '../../i18n';
import { activityLine, repeatsState, taskBadges } from './activity';
import {
  Empty,
  NumText,
  Panel,
  runtimeColor,
  useFloatTip,
  useSize,
  type TipContent,
} from './Charts';
import {
  doneMedian,
  durationText,
  ganttBars,
  groupTasks,
  modelLabel,
  nextSort,
  runtimeName,
  taskDuration,
  tickLabels,
  timeTicks,
  tokenText,
  whenText,
  type BoardTask,
  type GanttBar,
  type TaskSort,
  type TaskSortKey,
} from './panels-model';
import {
  OrderLockedMark,
  PullLink,
  StatusIcon,
  TaskBadges,
  TaskStateIcon,
  taskStateLabel,
} from './status';
import './progress.css';

/** The segment colour of a one-part plan task: that of its state's glyph in the status cell. */
const STATE_SEGMENT: Record<BoardTaskState, BoardTaskStatus> = {
  todo: 'todo',
  waiting_upstream: 'idle',
  claimed: 'running',
  running: 'running',
  waiting_approval: 'waiting',
  blocked: 'failed',
  needs_attention: 'idle',
  gating: 'ready',
  awaiting_acceptance: 'waiting',
  awaiting_merge: 'ready',
  merged: 'done',
  failed: 'failed',
};

// Getters, so each label is read in the language loaded by then.
const CHECKS: Record<BoardTask['checks'], string> = {
  get pass() {
    return t({ id: 'board.progress.checks.pass', defaultMessage: 'Checks passed' });
  },
  get fail() {
    return t({ id: 'board.progress.checks.fail', defaultMessage: 'Checks failed' });
  },
  get running() {
    return t({ id: 'board.progress.checks.running', defaultMessage: 'Checks running' });
  },
  get none() {
    return t({ id: 'board.progress.checks.none', defaultMessage: 'No checks' });
  },
};
const CHECK_ICON = { pass: 'done', fail: 'failed', running: 'running' } as const;

const UpIcon = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path
      d="M2 6.5 5 3.5l3 3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const DownIcon = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true">
    <path
      d="M2 3.5 5 6.5l3-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function Diff({ task }: { task: BoardTask }) {
  if (task.additions == null) return <span className="bp-mu">—</span>;
  return (
    <span className="bp-dfx">
      <span className="bp-add" data-zero={task.additions === 0 || undefined}>
        +{task.additions}
      </span>{' '}
      <span className="bp-del" data-zero={!task.deletions || undefined}>
        −{task.deletions ?? 0}
      </span>
    </span>
  );
}

function Checks({ checks }: { checks: BoardTask['checks'] }) {
  return (
    <Tip content={CHECKS[checks]}>
      <span className="bp-chk" aria-label={CHECKS[checks]}>
        {checks === 'none' ? (
          <span className="bp-mu">—</span>
        ) : (
          <StatusIcon status={CHECK_ICON[checks]} />
        )}
      </span>
    </Tip>
  );
}

function segmentLabel(bar: GanttBar, now: number): string {
  const s = bar.segment;
  const end =
    s.ended_at == null
      ? t({ id: 'board.progress.inProgress', defaultMessage: 'In progress' })
      : whenText(s.ended_at, now);
  return t(
    {
      id: 'board.progress.segmentLabel',
      defaultMessage: 'Start {start}, end {end}, tokens {tokens}',
    },
    { start: whenText(s.started_at ?? bar.from, now), end, tokens: tokenText(s.tokens) },
  );
}

function segmentTip(bar: GanttBar, now: number): TipContent {
  const s = bar.segment;
  const started = s.started_at ?? bar.from;
  return {
    rows: [
      {
        label: t({ id: 'board.progress.tip.runtime', defaultMessage: 'Runtime' }),
        value: s.runtime ? runtimeName(s.runtime) : '—',
      },
      {
        label: t({ id: 'board.progress.tip.model', defaultMessage: 'Model' }),
        value: s.runtime ? modelLabel(s.runtime, s.model) : (s.model ?? '—'),
      },
      {
        label: t({ id: 'board.progress.tip.start', defaultMessage: 'Start' }),
        value: whenText(started, now),
      },
      {
        label: t({ id: 'board.progress.tip.end', defaultMessage: 'End' }),
        value:
          s.ended_at == null
            ? t({ id: 'board.progress.inProgress', defaultMessage: 'In progress' })
            : whenText(s.ended_at, now),
      },
      {
        label: t({ id: 'board.progress.tip.duration', defaultMessage: 'Duration' }),
        value: durationText((s.ended_at ?? now) - started),
      },
      { label: 'token', value: tokenText(s.tokens) },
    ],
  };
}

const planned = (task: BoardTask) => !!task.owner_session_id && task.order !== undefined;

/** Each lead's plan tasks in plan order, in the places the status order gave them. */
function inPlanOrder(tasks: BoardTask[]): BoardTask[] {
  const queues = new Map<string, BoardTask[]>();
  for (const task of tasks.filter(planned))
    queues.set(task.owner_session_id!, [...(queues.get(task.owner_session_id!) ?? []), task]);
  for (const queue of queues.values()) queue.sort((a, b) => a.order! - b.order!);
  return tasks.map((task) => (planned(task) ? queues.get(task.owner_session_id!)!.shift()! : task));
}

export function ProgressTable({
  model,
  onOpenTask,
  tools,
  projectId,
  children,
}: {
  model: BoardModel;
  onOpenTask: (taskId: string) => void;
  tools?: ReactNode;
  /** The project whose plans the rows reorder; absent, the rows do not move. */
  projectId?: string;
  /** Shown in place of the table when given. */
  children?: ReactNode;
}) {
  const [sort, setSort] = useState<TaskSort | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const [setTicksBox, ticksBox] = useSize();
  const tip = useFloatTip();

  const { since } = model;
  // Live segments and durations keep growing between board reads.
  const now = Math.max(model.now, useNow(15_000));
  const groups = groupTasks(model, sort, now).map((group) =>
    sort ? group : { ...group, tasks: inPlanOrder(group.tasks) },
  );
  const ordered = (task: BoardTask) => !!projectId && !sort && planned(task);
  // A locked task keeps its place but still takes a task moved beside it.
  const movable = (task: BoardTask) => ordered(task) && !task.order_locked;
  const accepts = (to: BoardTask) =>
    !!drag &&
    drag.id !== to.id &&
    ordered(to) &&
    model.tasks.find((task) => task.id === drag.id)?.owner_session_id === to.owner_session_id;
  const move = (taskId: string, toId: string) => {
    const op = moveTaskOp(model, taskId, toId);
    const leadId = planTaskIds(taskId).lead;
    if (!op || !projectId) return;
    void editPlan(
      { projectId, leadId, planId: planTaskIds(taskId).task, taskId },
      [op],
      planVersion(model, leadId),
    );
  };
  const dragProps = (task: BoardTask) =>
    ordered(task)
      ? {
          ...(movable(task) && {
            draggable: true,
            onDragStart: (e: DragEvent) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', task.id);
              setDrag({ id: task.id, over: null });
            },
            onDragEnd: () => setDrag(null),
          }),
          'data-drag': drag?.id === task.id || undefined,
          'data-drop': drag?.over === task.id || undefined,
          onDragOver: (e: DragEvent) => {
            if (!accepts(task)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (drag?.over !== task.id) setDrag({ id: drag!.id, over: task.id });
          },
          onDrop: (e: DragEvent) => {
            if (!accepts(task)) return;
            e.preventDefault();
            move(drag!.id, task.id);
            setDrag(null);
          },
        }
      : {};
  /** Move up and move down to the neighbouring rows of the same lead, for the keyboard. */
  const moveMenu = (task: BoardTask, rows: BoardTask[]) => {
    const mates = rows.filter(
      (row) => planned(row) && row.owner_session_id === task.owner_session_id,
    );
    const at = mates.indexOf(task);
    const up = mates[at - 1];
    const down = mates[at + 1];
    return (
      // Clicks and keys inside the menu, its portal included, stay out of the row.
      <span
        className="bp-tmv"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Menu.Root>
          <Menu.Trigger
            className="ib"
            aria-label={t(
              { id: 'board.progress.order.menu', defaultMessage: 'Order of {task}' },
              { task: task.title },
            )}
          >
            <Ellipsis aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
              <Menu.Popup className="wmenu pop">
                <Menu.Item disabled={!up} onClick={() => up && move(task.id, up.id)}>
                  {t({ id: 'board.progress.order.up', defaultMessage: 'Move up' })}
                </Menu.Item>
                <Menu.Item disabled={!down} onClick={() => down && move(task.id, down.id)}>
                  {t({ id: 'board.progress.order.down', defaultMessage: 'Move down' })}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </span>
    );
  };
  const median = doneMedian(model.tasks);
  // A little room after the now line keeps live segments visible.
  const span = Math.max(1, (now - since) * 1.03);
  const pct = (t: number) => `${(((t - since) / span) * 100).toFixed(3)}%`;
  const ticks = timeTicks(since, now);
  const gridLines = ticks.map((tk) => (
    <i key={tk.at} className="bp-gl" style={{ left: pct(tk.at) }} />
  ));
  const nowLine = <i className="bp-gnow" style={{ left: pct(now) }} />;

  const header = (key: TaskSortKey, label: string, cls: string) => {
    const on = sort?.key === key;
    return (
      <div
        className={`bp-cell ${cls}`}
        role="columnheader"
        aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      >
        <button
          className={`bp-sortb${on ? ' on' : ''}`}
          type="button"
          aria-label={t(
            { id: 'board.progress.sortBy', defaultMessage: 'Sort by {column}' },
            { column: label },
          )}
          onClick={() => setSort(nextSort(sort, key))}
        >
          {label}
          {on && (sort.dir === 1 ? <UpIcon /> : <DownIcon />)}
        </button>
      </div>
    );
  };

  const onRowKey = (e: KeyboardEvent, id: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // A link or button in the row keeps its own Enter and Space.
    if ((e.target as Element).closest('a, button')) return;
    e.preventDefault();
    onOpenTask(id);
  };

  const gantt = (task: BoardTask) => {
    const { bars, tracks } = ganttBars(task, since, now);
    const bh = tracks > 1 ? 7 : 10;
    const total = tracks * bh + (tracks - 1) * 2;
    return (
      <>
        {gridLines}
        {bars.map((bar) => {
          const width = `${(((bar.to - bar.from) / span) * 100).toFixed(3)}%`;
          // Live segments anchor at the now line so the minimum width grows them leftwards.
          const at = bar.live
            ? { right: `${(100 - ((now - since) / span) * 100).toFixed(3)}%` }
            : { left: pct(bar.from) };
          return (
            <span
              key={bar.segment.id}
              className="bp-gseg"
              tabIndex={0}
              role="img"
              aria-label={segmentLabel(bar, now)}
              aria-describedby={tip.describedBy(bar.segment.id)}
              style={{ ...at, width }}
              onPointerMove={(e) => tip.show(e, segmentTip(bar, now), bar.segment.id)}
              onPointerLeave={tip.hide}
              onFocus={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                tip.show({ clientX: r.left, clientY: r.top }, segmentTip(bar, now), bar.segment.id);
              }}
              onBlur={tip.hide}
            >
              <i
                className={`bp-gb${bar.live ? ' live' : ''}${bar.segment.status === 'discarded' ? ' dim' : ''}`}
                style={{
                  top: `calc(50% + ${-total / 2 + bar.track * (bh + 2)}px)`,
                  height: bh,
                  backgroundColor: runtimeColor(bar.segment.runtime),
                }}
              />
            </span>
          );
        })}
        {nowLine}
      </>
    );
  };

  return (
    <Panel
      title={t({ id: 'board.progress.title', defaultMessage: 'Progress table' })}
      className="bp-tblp"
      num={
        <span className="bp-hn">
          {t({ id: 'board.progress.median', defaultMessage: 'Median time' })}{' '}
          <NumText text={median == null ? '—' : durationText(median)} />
        </span>
      }
      tools={tools}
    >
      {children ? (
        children
      ) : model.tasks.length === 0 ? (
        <Empty text={t({ id: 'board.progress.empty', defaultMessage: 'No tasks yet' })} />
      ) : (
        <div className="bp-tscroll">
          <div
            className="bp-tin"
            role="table"
            aria-label={t({ id: 'board.progress.title', defaultMessage: 'Progress table' })}
          >
            <div className="bp-tr th" role="row">
              {header(
                'task',
                t({ id: 'board.progress.columns.task', defaultMessage: 'Task' }),
                'c-task',
              )}
              {header(
                'status',
                t({ id: 'board.progress.columns.status', defaultMessage: 'Status' }),
                'c-status',
              )}
              <div className="bp-cell c-prog" role="columnheader">
                {t({ id: 'board.progress.columns.progress', defaultMessage: 'Progress' })}
              </div>
              <div className="bp-cell c-diff" role="columnheader">
                {t({ id: 'board.progress.columns.changes', defaultMessage: 'Changes' })}
              </div>
              <div className="bp-cell c-chk" role="columnheader">
                {t({ id: 'board.progress.columns.checks', defaultMessage: 'Checks' })}
              </div>
              {header(
                'duration',
                t({ id: 'board.progress.columns.duration', defaultMessage: 'Time' }),
                'c-dur',
              )}
              <div
                className="bp-cell c-tl bp-gtk"
                role="columnheader"
                aria-label={t({
                  id: 'board.progress.columns.timeline',
                  defaultMessage: 'Timeline',
                })}
                ref={setTicksBox}
              >
                {/* A share of the axis, so the labels follow it in the frame it resizes. */}
                {tickLabels(ticks, since, span, ticksBox.w).map((tk) => (
                  <span
                    key={tk.at}
                    className="bp-tk"
                    style={{ left: `${((tk.x / ticksBox.w) * 100).toFixed(3)}%` }}
                  >
                    {tk.label}
                  </span>
                ))}
                {nowLine}
              </div>
            </div>
            {groups.map((group) => (
              <div role="rowgroup" key={group.id ?? ''}>
                <div className="bp-tg" role="row">
                  <span role="cell">{group.title}</span>
                  <span className="bp-mu">
                    {group.done}/{group.total}
                  </span>
                </div>
                {group.tasks.map((task) => {
                  const segments =
                    task.state && task.segments.length === 1
                      ? [{ ...task.segments[0]!, status: STATE_SEGMENT[task.state] }]
                      : task.segments;
                  const doneN = segments.filter((s) => s.status === 'done').length;
                  const dur = taskDuration(task, now);
                  const badges = taskBadges(task);
                  // Where the state's glyph stands for the wait, the line is the command alone.
                  const line =
                    (badges.some(
                      (b) => b.kind === 'waiting' && repeatsState(b, task.state ?? task.status),
                    ) &&
                      task.activity?.waiting?.summary) ||
                    activityLine(task, now);
                  const blocked = badges.find(
                    (b) => b.kind === 'blocked' && repeatsState(b, task.state ?? task.status),
                  );
                  return (
                    <div
                      key={task.id}
                      className="bp-tr bp-trw"
                      role="row"
                      tabIndex={0}
                      aria-label={t(
                        { id: 'board.progress.rowLabel', defaultMessage: '{task}, {status}' },
                        { task: task.title, status: taskStateLabel(task) },
                      )}
                      onClick={() => onOpenTask(task.id)}
                      onKeyDown={(e) => onRowKey(e, task.id)}
                      {...dragProps(task)}
                    >
                      <div className="bp-cell c-task" role="cell">
                        <span className="bp-tt">
                          <span className="bp-tn">{task.title}</span>
                          <TaskBadges
                            badges={badges.filter(
                              (b) => !repeatsState(b, task.state ?? task.status),
                            )}
                          />
                          {task.order_locked && <OrderLockedMark />}
                          {task.pr && <PullLink pr={task.pr} />}
                          {task.estimate_ms !== undefined && (
                            <span className="bp-test">
                              {t(
                                {
                                  id: 'board.progress.estimate',
                                  defaultMessage: 'est. {duration}',
                                },
                                { duration: durationText(task.estimate_ms) },
                              )}
                            </span>
                          )}
                          {movable(task) && moveMenu(task, group.tasks)}
                        </span>
                        {line && (
                          <span className="bp-tact" title={line}>
                            {line}
                          </span>
                        )}
                      </div>
                      <div className="bp-cell c-status" role="cell">
                        <span className="bp-stc" title={blocked?.label}>
                          <TaskStateIcon task={task} />
                          <span className="bp-stw">{taskStateLabel(task)}</span>
                        </span>
                      </div>
                      <div className="bp-cell c-prog" role="cell">
                        <span className="bp-pg">
                          <span className="bp-pbar">
                            {segments.map((s) => (
                              <i key={s.id} className={`bp-b-${s.status}`} />
                            ))}
                          </span>
                          <span className="n">
                            {doneN}/{segments.length}
                          </span>
                        </span>
                      </div>
                      <div className="bp-cell c-diff" role="cell">
                        <Diff task={task} />
                      </div>
                      <div className="bp-cell c-chk" role="cell">
                        <Checks checks={task.checks} />
                      </div>
                      <div className="bp-cell c-dur" role="cell">
                        {dur == null ? <span className="bp-mu">—</span> : durationText(dur)}
                      </div>
                      <div className="bp-cell c-tl" role="cell">
                        {gantt(task)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {tip.node}
        </div>
      )}
    </Panel>
  );
}
