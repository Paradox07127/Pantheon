import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import type { TaskView } from '../../data/board-page';
import { runCommand } from '../../data/commands';
import { t } from '../../i18n';
import { HistoryTab, PanelBoundary, type BoardViewProps } from './BoardScreen';
import { DraftTaskForm, EditMode, OrderLock } from './EditMode';
import { MainView, hasPlanTasks } from './MainView';
import { PublishBar } from './PublishBar';
import { TaskList } from './TaskList';
import { TaskTimelineView } from './TaskTimelineView';
import { UnsentEdits } from './UnsentEdits';

/** The tasks view's body: the flow chart, the task lists or the whole history. */
export function TasksPage({
  view,
  model,
  shown,
  projectId,
  scoped,
  onRetry,
  onOpenSession,
  onOpenEvidence,
  onStartTask,
  selectedIn,
  selectFlow,
  onAskNeed,
  onOpenTask,
  editing,
  taskTitle,
  setFocusTask,
  setupPanel,
  empty,
  loadingPanel,
  graphFull,
  onGraphFull,
  historyBar,
}: {
  view: TaskView;
  model: BoardModel | null;
  /** The board's read cut to the chosen scope. */
  shown: BoardModel | null;
  projectId?: string;
  scoped: (NonNullable<BoardViewProps['actions']> & { projectId: string }) | undefined;
  onRetry: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenEvidence: BoardViewProps['onOpenEvidence'];
  onStartTask: BoardViewProps['onStartTask'];
  selectedIn: (panel: 'flow') => string | null;
  selectFlow: (taskId: string | null) => void;
  /** Jumps to a row of the needs-you strip; absent without the strip. */
  onAskNeed?: (key: string) => void;
  /** Shows the task in the flow chart with its drawer open. */
  onOpenTask: (taskId: string) => void;
  editing: boolean;
  taskTitle: RefObject<HTMLInputElement | null>;
  setFocusTask: Dispatch<SetStateAction<number>>;
  setupPanel: ReactNode;
  empty: boolean;
  loadingPanel: ReactNode;
  /** The user expanded the chart over the requirement bar. */
  graphFull: boolean;
  onGraphFull: () => void;
  /** The board bar's element the whole history and the list put their controls in. */
  historyBar: HTMLElement | null;
}) {
  if (view === 'timeline')
    return (
      <div className="bd-body">
        {!model ? (
          loadingPanel
        ) : !projectId ? null : shown !== model ? (
          // The board cuts the read to the current milestone only in that scope.
          setupPanel || (empty ? null : <TaskTimelineView model={shown!} projectId={projectId} />)
        ) : (
          <HistoryTab
            projectId={projectId}
            empty={setupPanel}
            lanes={model.lanes}
            now={model.now}
            milestones={model.milestones}
            onOpenSession={onOpenSession}
            onOpenTask={onOpenTask}
            bar={historyBar}
          />
        )}
      </div>
    );
  if (view === 'list')
    return (
      <div className="bd-body">
        {setupPanel ||
          (empty ? null : !shown ? (
            loadingPanel
          ) : (
            <PanelBoundary
              title={t({ id: 'board.panels.tasks', defaultMessage: 'Tasks' })}
              model={model}
              onRetry={onRetry}
            >
              <TaskList model={shown} onOpenTask={selectFlow} bar={historyBar} />
            </PanelBoundary>
          ))}
      </div>
    );
  // Only a chart with nodes to draw takes the requirement bar's place.
  const full = graphFull && !setupPanel && !empty && !!shown && hasPlanTasks(shown);
  return (
    <>
      <EditMode
        on={editing}
        projectId={projectId ?? ''}
        connecting={!!scoped}
        onTask={() => setFocusTask((n) => n + 1)}
        side={
          editing &&
          model &&
          projectId && (
            <>
              <DraftTaskForm model={model} projectId={projectId} titleRef={taskTitle} />
              <UnsentEdits model={model} projectId={projectId} />
              <OrderLock model={model} projectId={projectId} />
            </>
          )
        }
      >
        <div className="bd-cv">
          {setupPanel ||
            (empty ? null : !shown ? (
              loadingPanel
            ) : (
              <PanelBoundary
                title={t({ id: 'board.panels.main', defaultMessage: 'Main view' })}
                model={model}
                onRetry={onRetry}
              >
                <MainView
                  model={shown}
                  projectId={projectId}
                  selected={selectedIn('flow')}
                  onSelect={selectFlow}
                  onOpenSession={onOpenSession}
                  onOpenEvidence={onOpenEvidence}
                  onStartTask={onStartTask}
                  tell={scoped && { sessions: scoped.sessions, run: scoped.run }}
                  editing={editing}
                  onAskNeed={onAskNeed}
                  expand={{ on: full, onToggle: onGraphFull }}
                />
              </PanelBoundary>
            ))}
        </div>
      </EditMode>
      {scoped && !setupPanel && !full && (
        <div className="bd-pub">
          <PublishBar
            projectId={scoped.projectId}
            leads={model?.leads}
            sessions={scoped.sessions}
            tasks={model?.tasks}
            defaults={scoped.defaults}
            run={runCommand}
            // Without the board read the newest lead is unknown.
            disabled={!model}
          />
        </div>
      )}
    </>
  );
}
