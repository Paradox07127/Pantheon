import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { t } from '../../i18n';
import { boardNeeds } from './frame-model';
import type { BoardTask } from './panels-model';

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
