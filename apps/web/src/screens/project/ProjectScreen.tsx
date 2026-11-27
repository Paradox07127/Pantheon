import { useEffect, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Failure } from '../../components/PanelBoundary';
import { TopBar } from '../../components/TopBar';
import { draftKey, useDrafts } from '../../data/drafts';
import { useIntroRead } from '../../data/intro-read';
import { useProjectOverlap } from '../../data/project-overlap';
import { useProjectPlan } from '../../data/project-plan';
import { useProjectResident } from '../../data/project-resident';
import { useProjectsSummary } from '../../data/projects-summary';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import { IntroView } from '../memory/IntroView';
import { AgentList } from './AgentList';
import { ConductorComposer } from './ConductorComposer';
import { ItemInspector } from './ItemInspector';
import { hasDependencies } from './plan-flow';
import { PlanHistory } from './PlanHistory';
import { PlanList } from './PlanList';
import { mainAgent, type ShownPlanItem } from './project-model';
import { ResidentCard } from './ResidentCard';
import { RoutinesCard } from './RoutinesCard';
import { SignalsCard } from './SignalsCard';
import { StatusPanel } from './StatusPanel';
import { UnplannedList } from './UnplannedList';
import { UsagePanel } from './UsagePanel';
import './project.css';

/** The project introduction's first paragraph, or all of it in place once expanded. */
function IntroCard({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const summary = useIntroRead(projectId).read?.intro?.summary;
  const first = summary?.split(/\n\s*\n/)[0]?.trim();
  const title = t({ id: 'memory.intro.title', defaultMessage: 'Project introduction' });
  return (
    <section className="pj-card" aria-label={title}>
      <div className="pj-ch">
        <h2 className="pj-h2">{title}</h2>
        <button
          type="button"
          className="btn ghost sm pj-end"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open
            ? t({ id: 'project.intro.collapse', defaultMessage: 'Collapse' })
            : t({ id: 'project.intro.expand', defaultMessage: 'Expand' })}
        </button>
      </div>
      {open ? <IntroView projectId={projectId} /> : first && <p className="pj-intro">{first}</p>}
    </section>
  );
}

/** Starts the new-session composer with the main agent switch on. */
function startMainAgent(projectId: string) {
  useDrafts.getState().update(draftKey(projectId, null), () => ({ conductor: true }));
  useShell.getState().startNewSession();
}

type PlanView = 'list' | 'flow' | 'history';

const VIEW_KEY = 'pantheon.planView.';

function loadPlanView(projectId: string | null): PlanView {
  try {
    const stored = projectId ? localStorage.getItem(VIEW_KEY + projectId) : null;
    return stored === 'flow' || stored === 'history' ? stored : 'list';
  } catch {
    return 'list';
  }
}

/** The plan's list, graph or history, chosen per project. */
function usePlanView(projectId: string | null) {
  const [stored, setStored] = useState(() => ({ projectId, view: loadPlanView(projectId) }));
  if (stored.projectId !== projectId) setStored({ projectId, view: loadPlanView(projectId) });
  const choose = (view: PlanView) => {
    setStored({ projectId, view });
    try {
      if (projectId) localStorage.setItem(VIEW_KEY + projectId, view);
    } catch {
      // The choice holds in this window only.
    }
  };
  return [stored.view, choose] as const;
}

/**
 * The project at a glance: its state, the changes outside the plan, the agents at work and the
 * introduction; a message box talks to the main agent.
 */
export function ProjectScreen({
  projectId,
  sessions,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
}) {
  const plan = useProjectPlan(projectId);
  const overlap = useProjectOverlap(projectId);
  // A failed read shows no overlap rather than an older one.
  const shared = overlap.error ? null : overlap.read;
  const summaries = useProjectsSummary();
  const summary = summaries.data?.find((s) => s.project_id === projectId);
  const resident = useProjectResident(projectId);
  // Until the resident is read, the main agent is unknown: a fallback would take the composer.
  const mainKnown = !!resident.read || !!resident.error;
  const main = mainKnown ? mainAgent(sessions, resident.read?.session_id) : null;
  // The screen stays mounted across projects, so a selection belongs to the project it was made in.
  const [selection, setSelection] = useState<{ projectId: string; itemId: string } | null>(null);
  const selected = selection?.projectId === projectId ? selection.itemId : null;
  const setSelected = (itemId: string | null) =>
    setSelection(itemId && projectId ? { projectId, itemId } : null);
  const shown = plan.read?.plan;
  const chosen = shown?.items.find(
    (item): item is ShownPlanItem => item.id === selected && !item.dropped,
  );
  const gone = selected !== null && !!plan.read && !chosen;
  useEffect(() => {
    if (gone) setSelected(null);
  }, [gone]);
  const [chosenView, chooseView] = usePlanView(projectId);
  const flowable = hasDependencies(shown);
  const view = chosenView === 'flow' && !flowable ? 'list' : chosenView;
  return (
    <div className="tb-pg">
      <TopBar title={SCREEN_NAMES.project}>
        {shown && (
          <div className="tb-end">
            <RadioGroup<PlanView>
              className="tb-seg"
              aria-label={t({ id: 'project.plan.view', defaultMessage: 'Plan view' })}
              value={view}
              onValueChange={chooseView}
            >
              <Radio.Root value="list">
                {t({ id: 'project.plan.view.list', defaultMessage: 'List' })}
              </Radio.Root>
              {flowable && (
                <Radio.Root value="flow">
                  {t({ id: 'project.plan.view.flow', defaultMessage: 'Flow' })}
                </Radio.Root>
              )}
              <Radio.Root value="history">
                {t({ id: 'project.plan.view.history', defaultMessage: 'History' })}
              </Radio.Root>
            </RadioGroup>
          </div>
        )}
      </TopBar>
      <div className="pj">
        <StatusPanel summary={summary} main={main} latest={plan.read?.latest_landing} />
        <div className="pj-grid" data-inspector={chosen ? '' : undefined}>
          <div className="pj-pane">
            {sessions && mainKnown && !main && projectId && (
              <div className="pj-empty">
                <p className="pj-et">
                  {t({
                    id: 'project.empty.text',
                    defaultMessage: 'This project has no main agent yet.',
                  })}
                </p>
                <button type="button" className="btn pri" onClick={() => startMainAgent(projectId)}>
                  {t({ id: 'project.empty.start', defaultMessage: 'Start a main agent' })}
                </button>
              </div>
            )}
            {summaries.error && <Failure error={summaries.error} onRetry={summaries.reload} />}
            {plan.error && <Failure error={plan.error} onRetry={plan.reload} />}
            {view === 'history' && shown && projectId ? (
              <PlanHistory
                projectId={projectId}
                plan={shown}
                selected={chosen ? chosen.id : null}
                onSelect={setSelected}
              />
            ) : (
              <PlanList
                plan={shown}
                sessions={sessions}
                selected={chosen ? chosen.id : null}
                onSelect={setSelected}
                view={view === 'flow' ? 'flow' : 'list'}
                overlap={shared}
              />
            )}
            {projectId && <UsagePanel projectId={projectId} />}
            <UnplannedList
              rows={plan.read?.unplanned ?? null}
              sessions={sessions}
              overlap={shared}
            />
            {main && <ConductorComposer key={main.id} main={main} />}
          </div>
          <div className="pj-pane">
            {chosen && shown && projectId ? (
              <ItemInspector
                key={chosen.id}
                item={chosen}
                plan={shown}
                projectId={projectId}
                sessions={sessions}
                overlap={overlap}
                onClose={() => setSelected(null)}
              />
            ) : (
              <>
                {main && <AgentList main={main} sessions={sessions} overlap={shared} />}
                {main && projectId && (
                  <ResidentCard
                    key={`resident-${projectId}`}
                    projectId={projectId}
                    main={main}
                    sessions={sessions}
                    resident={resident}
                  />
                )}
                {main && projectId && (
                  <RoutinesCard key={`routines-${projectId}`} projectId={projectId} />
                )}
                {projectId && <SignalsCard key={`signals-${projectId}`} projectId={projectId} />}
                {projectId && <IntroCard projectId={projectId} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
