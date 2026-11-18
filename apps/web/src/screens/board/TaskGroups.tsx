import { useId, useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ArrowRight, ChevronDown } from 'lucide-react';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { ModelMark, RuntimeGlyph } from '../../components/RuntimeGlyph';
import { t } from '../../i18n';
import { blockerTexts } from '../../lib/daemon-text';
import { boardNeeds } from './frame-model';
import type { BoardTask } from './panels-model';
import { StateIcon } from './status';
import { BudgetShare, RungLabel } from './TaskRecovery';
import './overview.css';

type Board = Pick<BoardModel, 'tasks' | 'needs'>;

interface GroupRule {
  key: 'you' | 'blocked' | 'attention' | 'running' | 'acceptance' | 'merging' | 'todo' | 'merged';
  label: string;
  /** The state whose icon heads the group. */
  icon: BoardTaskState;
  states: readonly BoardTaskState[];
}

const GROUPS: readonly GroupRule[] = [
  {
    key: 'you',
    get label() {
      return t({ id: 'board.task.group.you', defaultMessage: 'Waiting for you' });
    },
    icon: 'waiting_approval',
    states: ['waiting_approval'],
  },
  {
    key: 'blocked',
    get label() {
      return t({ id: 'board.task.group.blocked', defaultMessage: 'Merge blocked or failed' });
    },
    icon: 'blocked',
    states: ['blocked', 'failed'],
  },
  {
    key: 'attention',
    get label() {
      return t({ id: 'board.task.group.attention', defaultMessage: 'Needs attention' });
    },
    icon: 'needs_attention',
    states: ['needs_attention'],
  },
  {
    key: 'running',
    get label() {
      return t({ id: 'board.task.group.running', defaultMessage: 'Running' });
    },
    icon: 'running',
    states: ['running', 'gating', 'claimed'],
  },
  {
    key: 'acceptance',
    get label() {
      return t({ id: 'board.task.group.acceptance', defaultMessage: 'Awaiting acceptance' });
    },
    icon: 'awaiting_acceptance',
    states: ['awaiting_acceptance'],
  },
  {
    key: 'merging',
    get label() {
      return t({ id: 'board.task.group.merging', defaultMessage: 'Awaiting merge' });
    },
    icon: 'awaiting_merge',
    states: ['awaiting_merge'],
  },
  {
    key: 'todo',
    get label() {
      return t({ id: 'board.task.group.todo', defaultMessage: 'To do or waiting on dependencies' });
    },
    icon: 'todo',
    states: ['todo', 'waiting_upstream'],
  },
  {
    key: 'merged',
    get label() {
      return t({ id: 'board.task.group.merged', defaultMessage: 'Merged' });
    },
    icon: 'merged',
    states: ['merged'],
  },
];

/** Rows a group shows before the rest fold behind a switch; the merged group folds whole instead. */
const FOLDED_ROWS = 8;

export interface TaskGroup extends GroupRule {
  tasks: BoardTask[];
}

/** The plan tasks by what they wait for, in board order; a task with an item for the user is the user's. Empty groups are left out. */
export function taskGroups(model: Board): TaskGroup[] {
  const asked = new Set(boardNeeds(model).flatMap((need) => need.task_id ?? []));
  const groupOf = (task: BoardTask) =>
    asked.has(task.id) ? GROUPS[0] : GROUPS.find((g) => g.states.includes(task.state!));
  return GROUPS.map((group) => ({
    ...group,
    tasks: model.tasks.filter((t) => t.state && groupOf(t) === group),
  })).filter((group) => group.tasks.length > 0);
}

function TaskRow({ task, onOpenTask }: { task: BoardTask; onOpenTask: (taskId: string) => void }) {
  const runtime = task.claim?.runtime ?? task.planned?.runtime;
  const model = task.claim?.model ?? task.planned?.model;
  const planned = task.planned?.model;
  const moved = !!planned && !!task.claim?.model && planned !== task.claim.model;
  const device = task.planned?.device;
  const held =
    task.dispatch_wait === 'paused' ||
    task.dispatch_wait === 'runtime_capacity' ||
    task.dispatch_wait === 'device_offline' ||
    task.dispatch_wait === 'device_capacity' ||
    task.dispatch_wait === 'device_resource' ||
    task.dispatch_wait === 'step';
  return (
    <li>
      <button type="button" className="btl-r" onClick={() => onOpenTask(task.id)}>
        <StateIcon state={task.state!} />
        <Clip text={task.title} />
        <span className="btl-rx">
          {device && device !== 'local' && <span className="chip mono">{device}</span>}
          {held && <span className="btl-why">{blockerTexts(task)[0]}</span>}
          {moved && (
            <>
              <ModelMark model={planned} size={14} />
              <s>{planned}</s>
              <ArrowRight aria-hidden="true" />
            </>
          )}
        </span>
        <span>{task.rung && <RungLabel rung={task.rung} />}</span>
        <span>{task.budget && <BudgetShare budget={task.budget} />}</span>
        <span className="btl-who">
          {runtime && <RuntimeGlyph runtime={runtime} size={14} />}
          <ModelMark model={model} beside={runtime} size={14} />
          {model && <span className="btl-m">{model}</span>}
        </span>
      </button>
    </li>
  );
}

function GroupHead({ group }: { group: TaskGroup }) {
  return (
    <>
      <StateIcon state={group.icon} />
      <span>{group.label}</span>
      <b>{group.tasks.length}</b>
    </>
  );
}

/** The plan tasks grouped by state, the merged ones folded away. */
export function TaskGroups({
  model,
  onOpenTask,
}: {
  model: Board;
  onOpenTask: (taskId: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState<readonly TaskGroup['key'][]>([]);
  const groups = taskGroups(model);
  return (
    <section className="bd-pn" aria-labelledby={id} data-debug-region="board.task-groups">
      <div className="bd-ph">
        <h2 id={id}>{t({ id: 'board.task.group.heading', defaultMessage: 'Tasks' })}</h2>
      </div>
      {groups.map((group) => {
        const all = group.key === 'merged' || open.includes(group.key);
        const rows = (
          <ul className="btl-l" aria-label={group.label}>
            {(all ? group.tasks : group.tasks.slice(0, FOLDED_ROWS)).map((task) => (
              <TaskRow key={task.id} task={task} onOpenTask={onOpenTask} />
            ))}
          </ul>
        );
        if (group.key !== 'merged')
          return (
            <div key={group.key} className="btl-g">
              <div className="btl-gh">
                <GroupHead group={group} />
              </div>
              {rows}
              {group.tasks.length > FOLDED_ROWS && (
                <button
                  type="button"
                  className="bd-lnk bf-more"
                  aria-expanded={all}
                  onClick={() =>
                    setOpen(all ? open.filter((key) => key !== group.key) : [...open, group.key])
                  }
                >
                  {all
                    ? t({ id: 'board.rows.less', defaultMessage: 'Show less' })
                    : t(
                        { id: 'board.rows.all', defaultMessage: 'Show all {count} rows' },
                        { count: group.tasks.length },
                      )}
                </button>
              )}
            </div>
          );
        return (
          <Collapsible.Root key={group.key} className="btl-g" defaultOpen={false}>
            <Collapsible.Trigger className="btl-gh btl-tg">
              <GroupHead group={group} />
              <ChevronDown className="btl-chev" aria-hidden="true" />
            </Collapsible.Trigger>
            <Collapsible.Panel className="btl-fold">{rows}</Collapsible.Panel>
          </Collapsible.Root>
        );
      })}
    </section>
  );
}
