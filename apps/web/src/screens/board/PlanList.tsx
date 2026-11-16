import { useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { GripVertical } from 'lucide-react';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { editPlan, moveTaskOp, planVersion } from '../../data/plan-edit';
import { planTaskIds } from '../../data/task-trace';
import { t } from '../../i18n';
import { OrderLockedMark, TaskStateIcon, taskStateLabel } from './status';
import './drawer.css';

type Task = BoardModel['tasks'][number];

/** One milestone of a lead's plan and its tasks in plan order; a null id holds the tasks of none. */
export interface PlanPhase {
  id: string | null;
  title: string;
  tasks: Task[];
}

/** The lead's plan tasks grouped by milestone, in the board's milestone order, then the tasks of none. */
export function planPhases(model: Pick<BoardModel, 'tasks' | 'milestones'>, leadId: string) {
  const tasks = model.tasks
    .filter((task) => task.owner_session_id === leadId)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  const ids = [...new Set(tasks.map((task) => task.milestone_id))];
  const known = model.milestones.filter((m) => ids.includes(m.id));
  const unknown = ids.filter((id) => id !== null && !known.some((m) => m.id === id));
  const of = (id: string | null) => tasks.filter((task) => task.milestone_id === id);
  return [
    ...known.map((m, i) => ({
      id: m.id,
      title: t(
        { id: 'board.drawer.plan.phase', defaultMessage: 'Phase {n} {title}' },
        { n: i + 1, title: m.title },
      ),
      tasks: of(m.id),
    })),
    ...unknown.map((id) => ({ id, title: id!, tasks: of(id) })),
    ...(ids.includes(null)
      ? [
          {
            id: null,
            title: t({ id: 'board.drawer.plan.none', defaultMessage: 'No milestone' }),
            tasks: of(null),
          },
        ]
      : []),
  ] satisfies PlanPhase[];
}

// The status bar's parts, left to right; statuses not named fill the rest.
const PARTS: { color: string; statuses: BoardTaskStatus[] }[] = [
  { color: 'var(--ok)', statuses: ['done'] },
  { color: 'var(--run)', statuses: ['running', 'waiting', 'idle', 'ready'] },
  { color: 'var(--bad)', statuses: ['failed'] },
];

function PhaseBar({ tasks }: { tasks: Task[] }) {
  const parts = [
    ...PARTS.map((part) => ({
      color: part.color,
      n: tasks.filter((task) => part.statuses.includes(task.status)).length,
    })),
    {
      color: 'var(--track)',
      n: tasks.filter((task) => !PARTS.some((part) => part.statuses.includes(task.status))).length,
    },
  ].filter((part) => part.n > 0);
  return (
    <span className="bd-pls" aria-hidden="true">
      {parts.map((part) => (
        <i key={part.color} style={{ '--n': part.n, '--c': part.color } as CSSProperties} />
      ))}
    </span>
  );
}

export interface PlanListProps {
  model: BoardModel;
  /** The lead whose plan the list shows. */
  leadId: string;
  /** The task whose row is marked current. */
  currentId: string;
  onSelect: (taskId: string) => void;
  /** The project of the lead's plan; absent, the rows do not move. */
  projectId?: string;
}

/**
 * The lead's plan by milestone. A row drags before another row of its milestone, or moves past its
 * neighbour with the arrow keys on its handle.
 */
export function PlanList({ model, leadId, currentId, onSelect, projectId }: PlanListProps) {
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null);
  const phases = planPhases(model, leadId);
  const planned = (task: Task) => !!projectId && task.order !== undefined;
  // A locked task keeps its place but still takes a task moved beside it.
  const movable = (task: Task) => planned(task) && !task.order_locked;
  const phaseOf = (id: string) => model.tasks.find((task) => task.id === id)?.milestone_id;
  const accepts = (to: Task) =>
    !!drag && drag.id !== to.id && planned(to) && phaseOf(drag.id) === to.milestone_id;
  const move = (taskId: string, toId: string) => {
    const op = moveTaskOp(model, taskId, toId);
    if (!op || !projectId) return;
    void editPlan(
      { projectId, leadId, planId: planTaskIds(taskId).task, taskId },
      [op],
      planVersion(model, leadId),
    );
  };
  const onKey = (e: KeyboardEvent, task: Task, mates: Task[]) => {
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    const to = step && mates[mates.indexOf(task) + step];
    if (!to) return;
    e.preventDefault();
    move(task.id, to.id);
  };
  const dragProps = (task: Task) =>
    planned(task)
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
  return (
    <div className="bd-plan">
      {phases.map((phase) => {
        const done = phase.tasks.filter((task) => task.status === 'done').length;
        const mates = phase.tasks.filter(planned);
        return (
          <section key={phase.id ?? ''} className="bd-plg">
            <div className="bd-plh">
              <h3>{phase.title}</h3>
              <span className="bd-plc">
                {t(
                  { id: 'board.drawer.plan.count', defaultMessage: '{done} / {total}' },
                  { done, total: phase.tasks.length },
                )}
              </span>
              <PhaseBar tasks={phase.tasks} />
            </div>
            <ul className="bd-pl">
              {phase.tasks.map((task) => (
                <li key={task.id} className="bd-plr" {...dragProps(task)}>
                  {movable(task) && (
                    <button
                      type="button"
                      className="ib bd-plgrip"
                      aria-label={t(
                        { id: 'board.drawer.plan.move', defaultMessage: 'Move {title}' },
                        { title: task.title },
                      )}
                      aria-keyshortcuts="ArrowUp ArrowDown"
                      onKeyDown={(e) => onKey(e, task, mates)}
                    >
                      <GripVertical aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="bd-plb"
                    aria-current={task.id === currentId ? 'true' : undefined}
                    onClick={() => onSelect(task.id)}
                  >
                    <TaskStateIcon task={task} />
                    <span className="nm">{task.title}</span>
                    {task.order_locked && <OrderLockedMark />}
                    <span className="bd-plst">{taskStateLabel(task)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
