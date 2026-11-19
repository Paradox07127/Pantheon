import { useRef, type ComponentProps, type MouseEvent, type ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { useProjectBrief } from '../../data/project-brief';
import { t } from '../../i18n';
import { reducedMotion } from '../../lib/motion';
import { NeedsStrip, useNeedImprovements } from './BoardFrame';
import { PanelBoundary, type BoardViewProps } from './BoardScreen';
import { BoardDevices } from './BoardDevices';
import { BriefCard } from './BriefCard';
import { GoalsHead, GoalsSection } from './GoalsSection';
import { LeadPanel, residentSessions } from './LeadPanel';
import type { currentMilestone } from './MilestoneCard';
import { TaskProgressStrip } from './ProgressCharts';

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

/** Scrolls a fold the click opened in the page fully into its view once its height has grown, keeping its button in view. */
function revealOpened(e: MouseEvent<HTMLDivElement>) {
  const page = e.currentTarget;
  const trigger = (e.target as Element).closest('[aria-expanded]');
  if (!trigger || !page.contains(trigger)) return;
  const reveal = () => {
    if (!trigger.isConnected || trigger.getAttribute('aria-expanded') !== 'true') return;
    const fold =
      document.getElementById(trigger.getAttribute('aria-controls') ?? '') ??
      trigger.closest('li') ??
      trigger;
    const view = page.getBoundingClientRect();
    const by = Math.min(
      fold.getBoundingClientRect().bottom - view.bottom,
      trigger.getBoundingClientRect().top - view.top,
    );
    if (by > 0) page.scrollBy({ top: by, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  // A fold starts growing a frame or two after the click; wait until a frame passes with nothing
  // growing. Loops never finish, so only finite animations count.
  const settle = () =>
    requestAnimationFrame(() => {
      const growing = page
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Infinity);
      if (!growing.length) return reveal();
      void Promise.allSettled(growing.map((a) => a.finished)).then(settle);
    });
  settle();
}

/** The overview's body, one column: since you left, needs you, the agents and the goals. */
export function OverviewPage({
  model,
  current,
  projectId,
  actions,
  scoped,
  stale,
  onRetry,
  onOpenSession,
  selectFlow,
  drawerOpen,
  setupPanel,
  loadingPanel,
  goalsBar,
  onGoalsBar,
  sync,
  planVersion,
  onOpenNeeds,
  onOpenTasks,
  needsAsked,
  onNeedsAsked,
}: {
  model: BoardModel | null;
  current: ReturnType<typeof currentMilestone> | null;
  projectId?: string;
  actions: BoardViewProps['actions'];
  scoped: (NonNullable<BoardViewProps['actions']> & { projectId: string }) | undefined;
  stale?: boolean;
  onRetry: () => void;
  onOpenSession: (sessionId: string) => void;
  selectFlow: (taskId: string | null) => void;
  /** The task drawer is open beside the page. */
  drawerOpen: boolean;
  setupPanel: ReactNode;
  loadingPanel: ReactNode;
  /** The goals heading's element the goals put their Add goal button in; `onGoalsBar` takes it. */
  goalsBar: HTMLElement | null;
  onGoalsBar: (el: HTMLElement | null) => void;
  sync?: BoardViewProps['sync'];
  /** The version of the plan the board shows; absent without a lead's plan. */
  planVersion?: number;
  onOpenNeeds: () => void;
  /** Shows the tasks view on the milestone, or on the current one for null. */
  onOpenTasks: (milestoneId: string | null) => void;
  /** The goals asked for the needs-you strip; `onNeedsAsked` once it took the focus. */
  needsAsked: boolean;
  onNeedsAsked: () => void;
}) {
  return (
    <div className="bd-body" onClick={revealOpened}>
      <div className="bd-ov">
        {setupPanel}
        {!model && loadingPanel}
        {model && projectId && (
          <BriefCard
            projectId={projectId}
            model={model}
            sessions={actions?.sessions ?? []}
            onOpenTask={selectFlow}
            run={actions?.run}
          />
        )}
        {/* Side by side once both fit; one alone takes the whole row. */}
        <div className="bd-ov-row">
          {model && projectId && actions && !!model.needs?.length && (
            <ProjectNeeds
              projectId={projectId}
              model={model}
              sessions={actions.sessions}
              run={actions.run}
              onOpenSession={onOpenSession}
              stale={stale}
              drawer={drawerOpen}
              asked={needsAsked}
              onAsked={onNeedsAsked}
            />
          )}
          {model &&
            (!!model.leads?.length ||
              residentSessions(actions?.sessions ?? [], projectId, model).length > 0) && (
              <section aria-labelledby="bd-ov-agents">
                <div className="bd-ph">
                  <h2 id="bd-ov-agents">
                    {t({ id: 'board.overview.agents', defaultMessage: 'Agents' })}
                  </h2>
                  <span className="bd-tools">
                    <BoardDevices />
                  </span>
                </div>
                <PanelBoundary title="lead" model={model} onRetry={onRetry}>
                  <LeadPanel
                    model={model}
                    sessions={actions?.sessions ?? []}
                    projectId={projectId}
                    onOpenSession={onOpenSession}
                    onOpenTask={selectFlow}
                    run={actions?.run}
                  />
                </PanelBoundary>
              </section>
            )}
        </div>
        {model && (
          <section aria-labelledby="bd-ov-goals">
            <div className="bd-ph">
              <h2 id="bd-ov-goals">{t({ id: 'board.overview.goals', defaultMessage: 'Goals' })}</h2>
              <GoalsHead version={planVersion} sync={sync} stale={stale} slot={onGoalsBar} />
            </div>
            <div className="bd-ov-goals">
              {!current && <TaskProgressStrip totals={model.task_progress.totals} />}
              {projectId && (
                <PanelBoundary
                  title={t({ id: 'board.overview.goals', defaultMessage: 'Goals' })}
                  model={model}
                  onRetry={onRetry}
                >
                  <GoalsSection
                    key={projectId}
                    model={model}
                    projectId={projectId}
                    bar={goalsBar}
                    current={current}
                    actions={scoped}
                    onOpenNeeds={onOpenNeeds}
                    onOpenTasks={onOpenTasks}
                    onOpenTask={selectFlow}
                    onOpenSession={onOpenSession}
                  />
                </PanelBoundary>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
