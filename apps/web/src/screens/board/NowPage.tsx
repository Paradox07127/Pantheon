import {
  useRef,
  type ComponentProps,
  type Dispatch,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { useProjectBrief } from '../../data/project-brief';
import { t } from '../../i18n';
import { reducedMotion } from '../../lib/motion';
import { NeedsStrip, useNeedImprovements } from './BoardFrame';
import { PanelBoundary, type BoardViewProps } from './BoardScreen';
import { BriefCard } from './BriefCard';
import { DraftTaskForm, EditMode, OrderLock } from './EditMode';
import { LeadPanel } from './LeadPanel';
import { MainView, hasPlanTasks } from './MainView';
import { MilestoneCard, type currentMilestone } from './MilestoneCard';
import { NowSummary } from './NowSummary';
import { PlanProposals } from './PlanProposals';
import { TaskProgressStrip } from './ProgressCharts';
import { UnsentEdits } from './UnsentEdits';

/** The needs-you list with the proposals its items point at; the hooks sit here, as the page holds none. */
export function ProjectNeeds({
  projectId,
  drawer,
  ...props
}: Omit<ComponentProps<typeof NeedsStrip>, 'improvements'> & {
  projectId: string;
  /** The task drawer is open beside the list. */
  drawer?: boolean;
}) {
  const improvements = useNeedImprovements(props.model);
  const brief = useProjectBrief(projectId);
  // The since-you-left card above lands with its own read; shown before it, the list would move down.
  const landed = useRef<string | null>(null);
  if (brief.read !== null || !brief.loading) landed.current = projectId;
  if (landed.current !== projectId) return null;
  return (
    <div className="bd-needs" data-drawer={drawer ? '' : undefined}>
      <NeedsStrip {...props} improvements={improvements.read} />
    </div>
  );
}

/** Scrolls a fold the click opened in the strips fully into their view once its height has grown, keeping its button in view. */
function revealOpened(e: MouseEvent<HTMLDivElement>) {
  const strips = e.currentTarget;
  const trigger = (e.target as Element).closest('[aria-expanded]');
  if (!trigger || !strips.contains(trigger)) return;
  const reveal = () => {
    if (!trigger.isConnected || trigger.getAttribute('aria-expanded') !== 'true') return;
    const fold =
      document.getElementById(trigger.getAttribute('aria-controls') ?? '') ??
      trigger.closest('li') ??
      trigger;
    const view = strips.getBoundingClientRect();
    const by = Math.min(
      fold.getBoundingClientRect().bottom - view.bottom,
      trigger.getBoundingClientRect().top - view.top,
    );
    if (by > 0) strips.scrollBy({ top: by, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  // A fold starts growing a frame or two after the click; wait until a frame passes with nothing
  // growing. Loops never finish, so only finite animations count.
  const settle = () =>
    requestAnimationFrame(() => {
      const growing = strips
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Infinity);
      if (!growing.length) return reveal();
      void Promise.allSettled(growing.map((a) => a.finished)).then(settle);
    });
  settle();
}

/** The now view's body: what happened since the user left, what needs the user, milestone and lead, plan proposals, the main view and the summary. */
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
  onAskNeed,
  editing,
  taskTitle,
  setFocusTask,
  setupPanel,
  empty,
  loadingPanel,
  graphFull,
  onGraphFull,
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
  /** Jumps to a row of the needs-you strip; absent without the strip. */
  onAskNeed?: (key: string) => void;
  editing: boolean;
  taskTitle: RefObject<HTMLInputElement | null>;
  setFocusTask: Dispatch<SetStateAction<number>>;
  setupPanel: ReactNode;
  empty: boolean;
  loadingPanel: ReactNode;
  /** The user expanded the chart over the strips. */
  graphFull: boolean;
  onGraphFull: () => void;
}) {
  // Only a chart with nodes to draw holds its share of the height or takes the strips' place.
  const graph = !setupPanel && !empty && !!shown && hasPlanTasks(shown);
  const full = graphFull && graph;
  return (
    <>
      <div className="bd-now-body" data-graph={graph ? '' : undefined}>
        <div className="bd-now-top" hidden={full} onClick={revealOpened}>
          {model && projectId && (
            <BriefCard
              projectId={projectId}
              model={model}
              sessions={actions?.sessions ?? []}
              onOpenTask={selectFlow}
              run={actions?.run}
            />
          )}
          {model && projectId && actions && !!model.needs?.length && (
            <ProjectNeeds
              projectId={projectId}
              model={model}
              sessions={actions.sessions}
              run={actions.run}
              onOpenSession={onOpenSession}
              stale={stale}
              drawer={selectedIn('flow') !== null}
              hidden={full}
              onShow={onGraphFull}
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
                  />
                </PanelBoundary>
              )}
            </section>
          )}
          {model && projectId && (
            <PlanProposals model={model} projectId={projectId} sessions={actions?.sessions ?? []} />
          )}
        </div>
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
      </div>
      {model && <NowSummary model={model} onOpenSession={onOpenSession} />}
    </>
  );
}
