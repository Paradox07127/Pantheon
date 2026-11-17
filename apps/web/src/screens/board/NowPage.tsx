import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { t } from '../../i18n';
import { NeedsStrip, useNeedImprovements } from './BoardFrame';
import { PanelBoundary, type BoardViewProps } from './BoardScreen';
import { BriefCard } from './BriefCard';
import { DraftTaskForm, EditMode, OrderLock } from './EditMode';
import { LeadPanel } from './LeadPanel';
import { MainView } from './MainView';
import { MilestoneCard, type currentMilestone } from './MilestoneCard';
import { NowSummary } from './NowSummary';
import { PlanProposals } from './PlanProposals';
import { TaskProgressStrip } from './ProgressCharts';
import { UnsentEdits } from './UnsentEdits';

/** The needs-you list with the proposals its items point at; the hooks sit here, as the page holds none. */
function ProjectNeeds(props: Omit<ComponentProps<typeof NeedsStrip>, 'improvements'>) {
  const improvements = useNeedImprovements(props.model);
  return <NeedsStrip {...props} improvements={improvements.read} />;
}

/** The now view's body: what needs the user, what happened since the user left, milestone and lead, plan proposals, the main view and the summary. */
export function NowPage({
  model,
  shown,
  current,
  projectId,
  actions,
  scoped,
  stale,
  onRetry,
  onOpenSession,
  onOpenEvidence,
  onStartTask,
  selectedIn,
  selectFlow,
  editing,
  taskTitle,
  setFocusTask,
  setupPanel,
  empty,
  loadingPanel,
}: {
  model: BoardModel | null;
  shown: BoardModel | null;
  current: ReturnType<typeof currentMilestone> | null;
  projectId?: string;
  actions: BoardViewProps['actions'];
  scoped: (NonNullable<BoardViewProps['actions']> & { projectId: string }) | undefined;
  stale?: boolean;
  onRetry: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenEvidence: BoardViewProps['onOpenEvidence'];
  onStartTask: BoardViewProps['onStartTask'];
  selectedIn: (panel: 'flow') => string | null;
  selectFlow: (taskId: string | null) => void;
  editing: boolean;
  taskTitle: RefObject<HTMLInputElement | null>;
  setFocusTask: Dispatch<SetStateAction<number>>;
  setupPanel: ReactNode;
  empty: boolean;
  loadingPanel: ReactNode;
}) {
  return (
    <>
      {model && projectId && actions && !!model.needs?.length && (
        <div className="bd-needs">
          <ProjectNeeds
            model={model}
            sessions={actions.sessions}
            run={actions.run}
            onOpenSession={onOpenSession}
            stale={stale}
          />
        </div>
      )}
      {model && projectId && (
        <BriefCard
          projectId={projectId}
          model={model}
          sessions={actions?.sessions ?? []}
          onOpenTask={selectFlow}
        />
      )}
      {model && shown && (
        <section
          className="bov"
          aria-label={t({ id: 'board.strip.label', defaultMessage: 'Milestone and lead' })}
        >
          {current ? (
            <PanelBoundary
              title={t({
                id: 'board.panels.currentMilestone',
                defaultMessage: 'Current milestone',
              })}
              model={model}
              onRetry={onRetry}
            >
              <MilestoneCard
                model={model}
                milestone={current}
                actions={scoped}
                onOpenTask={selectFlow}
              />
            </PanelBoundary>
          ) : (
            <TaskProgressStrip totals={model.task_progress.totals} />
          )}
          {!!model.leads?.length && (
            <PanelBoundary title="lead" model={model} onRetry={onRetry}>
              <LeadPanel
                model={shown}
                sessions={actions?.sessions ?? []}
                onOpenSession={onOpenSession}
                onOpenTask={selectFlow}
                run={actions?.run}
                stale={stale}
              />
            </PanelBoundary>
          )}
        </section>
      )}
      {model && projectId && (
        <PlanProposals model={model} projectId={projectId} sessions={actions?.sessions ?? []} />
      )}
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
                />
              </PanelBoundary>
            ))}
        </div>
      </EditMode>
      {model && <NowSummary model={model} onOpenSession={onOpenSession} />}
    </>
  );
}
