import { useEffect, useState } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Failure } from '../../components/PanelBoundary';
import { TopBar } from '../../components/TopBar';
import { draftKey, useDrafts } from '../../data/drafts';
import { useIntroRead } from '../../data/intro-read';
import { useProjectPlan } from '../../data/project-plan';
import { useProjectsSummary } from '../../data/projects-summary';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import { IntroView } from '../memory/IntroView';
import { AgentList } from './AgentList';
import { ConductorComposer } from './ConductorComposer';
import { ItemInspector } from './ItemInspector';
import { PlanList } from './PlanList';
import { mainAgent, type ShownPlanItem } from './project-model';
import { StatusPanel } from './StatusPanel';
import { UnplannedList } from './UnplannedList';
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
  const summaries = useProjectsSummary();
  const summary = summaries.data?.find((s) => s.project_id === projectId);
  const main = mainAgent(sessions);
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
  return (
    <div className="tb-pg">
      <TopBar title={SCREEN_NAMES.project} />
      <div className="pj">
        <StatusPanel summary={summary} main={main} latest={plan.read?.latest_landing} />
        <div className="pj-grid" data-inspector={chosen ? '' : undefined}>
          <div className="pj-pane">
            {sessions && !main && projectId && (
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
            <PlanList
              plan={shown}
              sessions={sessions}
              selected={chosen ? chosen.id : null}
              onSelect={setSelected}
            />
            <UnplannedList rows={plan.read?.unplanned ?? null} />
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
                onClose={() => setSelected(null)}
              />
            ) : (
              <>
                {main && <AgentList main={main} sessions={sessions} />}
                {projectId && <IntroCard projectId={projectId} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
