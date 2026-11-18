import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Network } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { Tip } from '../../components/Tip';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { activityLine, displayStatus, phaseText, taskBadges } from './activity';
import { runtimeColor } from './Charts';
import { boardColumns, pendingUpstream, type BoardColumn, type BoardTask } from './panels-model';
import { STATUS, StatusIcon, TaskBadges, segmentText } from './status';
import { TaskDrawer, type TaskDrawerProps } from './TaskDrawer';
import { RungLabel } from './TaskRecovery';

interface ColumnsPanelProps {
  model: BoardModel;
  /** The task whose drawer is open; null when none is. */
  selected: string | null;
  onSelect: (taskId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenStory: (sessionId: string) => void;
  onStartTask?: (task: BoardModel['tasks'][number]) => void;
  tell?: TaskDrawerProps['tell'];
}

function TaskCard({
  task,
  upstream,
  selected,
  now,
  onSelect,
  refocus,
}: {
  task: BoardTask;
  upstream: number;
  selected: boolean;
  now: number;
  onSelect: (taskId: string) => void;
  /** The task whose focused card left its column in this commit. */
  refocus: { current: string | null };
}) {
  const changed = task.additions != null;
  const shown = displayStatus(task);
  const line = activityLine(task, now);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  // A status change remounts the card in another column; focus follows it there.
  useLayoutEffect(() => {
    const el = button.current;
    if (refocus.current === task.id) {
      refocus.current = null;
      el?.focus({ preventScroll: true });
    }
    return () => {
      if (el && document.activeElement === el) refocus.current = task.id;
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      className="bd-col-card"
      data-task-card
      data-status={shown}
      data-health={task.activity?.health}
      aria-pressed={selected}
      aria-labelledby={`${id}-t`}
      aria-describedby={line ? `${id}-s ${id}-a` : `${id}-s`}
      onClick={() => onSelect(task.id)}
    >
      {/* The status line, not the focusable button, remounts to replay the pop on a status change. */}
      <span key={shown} className="bd-col-s bd-pop" id={`${id}-s`}>
        <StatusIcon status={shown} />
        <span className="bd-stw">{phaseText(task, now)}</span>
        <TaskBadges badges={taskBadges(task)} />
      </span>
      <span className="bd-col-t" id={`${id}-t`}>
        {task.title}
      </span>
      {line && (
        <span className="bd-col-a" id={`${id}-a`} title={line}>
          {line}
        </span>
      )}
      {(task.segments.length > 0 || upstream > 0 || changed) && (
        <span className="bd-col-m">
          {task.segments.length > 0 && (
            <span className="bd-col-rts">
              {task.segments.map((s) => (
                <Tip key={s.id} content={segmentText(s)}>
                  <i className="bd-col-rt" style={{ backgroundColor: runtimeColor(s.runtime) }} />
                </Tip>
              ))}
            </span>
          )}
          {upstream > 0 && (
            <span
              className="bd-col-up"
              role="img"
              aria-label={t(
                {
                  id: 'board.columns.pendingUpstream',
                  defaultMessage:
                    '{count, plural, one {# unfinished dependency} other {# unfinished dependencies}}',
                },
                { count: upstream },
              )}
            >
              <Network aria-hidden="true" />
              {upstream}
            </span>
          )}
          {changed && (
            <span className="bd-col-fx">
              <DiffCounts additions={task.additions} deletions={task.deletions} />
            </span>
          )}
        </span>
      )}
      {task.rung && <RungLabel rung={task.rung} />}
    </button>
  );
}

function ColumnHead({ column }: { column: BoardColumn }) {
  return (
    <>
      <StatusIcon status={column.status} />
      <span>{STATUS[column.status].label}</span>
      <span className="bd-col-n">{column.tasks.length}</span>
    </>
  );
}

/** Tasks in one column per status; the discarded column starts folded to its header. */
export function ColumnsPanel({
  model,
  selected,
  onSelect,
  onOpenSession,
  onOpenStory,
  onStartTask,
  tell,
}: ColumnsPanelProps) {
  const [discardedOpen, setDiscardedOpen] = useState(false);
  const now = Math.max(model.now, useNow(15_000));
  const refocus = useRef<string | null>(null);
  // Runs after the cards' own effects: a card that landed in a folded column takes no focus later.
  useLayoutEffect(() => {
    refocus.current = null;
  });
  return (
    <div
      className="bd-cols"
      role="group"
      aria-label={t({ id: 'board.columns.label', defaultMessage: 'Task columns' })}
    >
      <div className="bd-col-row">
        {boardColumns(model).map((column) => {
          const folds = column.status === 'discarded';
          const shut = folds && !discardedOpen;
          return (
            <div key={column.status} className={`bd-col${shut ? ' shut' : ''}`}>
              {folds ? (
                <button
                  type="button"
                  className="bd-col-h"
                  aria-expanded={!shut}
                  aria-label={`${STATUS[column.status].label} ${column.tasks.length}`}
                  onClick={() => setDiscardedOpen(shut)}
                >
                  {shut ? (
                    <>
                      <StatusIcon status={column.status} />
                      <span className="bd-col-n">{column.tasks.length}</span>
                    </>
                  ) : (
                    <ColumnHead column={column} />
                  )}
                </button>
              ) : (
                <div className="bd-col-h">
                  <ColumnHead column={column} />
                </div>
              )}
              {!shut && (
                <div className="bd-col-b">
                  {column.tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      upstream={pendingUpstream(model, task.id)}
                      selected={task.id === selected}
                      now={now}
                      onSelect={onSelect}
                      refocus={refocus}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <TaskDrawer
        model={model}
        taskId={selected}
        onSelect={onSelect}
        onOpenSession={onOpenSession}
        onOpenStory={onOpenStory}
        onStartTask={onStartTask}
        tell={tell}
      />
    </div>
  );
}
