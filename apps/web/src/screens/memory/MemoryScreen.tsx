import { Tabs } from '@base-ui/react/tabs';
import { ProjectReadStatus } from '../../components/ReadStatus';
import { TopBar } from '../../components/TopBar';
import { useLearned } from '../../data/learned';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { useShell, type MemoryTab } from '../../store';
import { openRetrospective } from '../settings/settings-jump';
import { DiagramsPage } from './DiagramsPage';
import { EntriesTopControls } from './EntriesBar';
import { EntriesPage } from './EntriesPage';
import { LearnedPage } from './LearnedPage';
import { GraphTopControls, MemoryGraphView } from './MemoryGraphView';
import { MemoryOverview } from './MemoryOverview';
import { OverviewMemory } from './OverviewMemory';
import '../board/board.css';

// Labels are getters, so each is read in the language loaded by then.
const TABS: { key: MemoryTab; label: string }[] = [
  {
    key: 'overview',
    get label() {
      return t({ id: 'memory.tab.overview', defaultMessage: 'Overview' });
    },
  },
  {
    key: 'entries',
    get label() {
      return t({ id: 'memory.tab.entries', defaultMessage: 'Entries' });
    },
  },
  {
    key: 'graph',
    get label() {
      return t({ id: 'memory.tab.graph', defaultMessage: 'Graph' });
    },
  },
  {
    key: 'diagrams',
    get label() {
      return t({ id: 'memory.tab.diagrams', defaultMessage: 'Diagrams' });
    },
  },
  {
    key: 'learned',
    get label() {
      return t({ id: 'memory.tab.learned', defaultMessage: 'Learned' });
    },
  },
];

export function MemoryScreen({ projectId }: { projectId: string | null }) {
  const tab = useShell((s) => s.memoryTab);
  const setTab = useShell((s) => s.setMemoryTab);
  const needsYou = (useLearned(projectId).read ?? []).filter((i) => i.group === 'needs_you').length;
  return (
    <Tabs.Root className="tb-pg" value={tab} onValueChange={(value) => setTab(value as MemoryTab)}>
      <TopBar title={SCREEN_NAMES.memory}>
        <Tabs.List className="tb-tabs" aria-label={SCREEN_NAMES.memory}>
          {TABS.map((s) => {
            const count = s.key === 'learned' && needsYou > 0;
            return (
              <Tabs.Tab
                key={s.key}
                className="tb-tab"
                value={s.key}
                aria-label={
                  count
                    ? t(
                        {
                          id: 'memory.tab.learnedCount',
                          defaultMessage:
                            'Learned, {count, plural, one {# needs you} other {# need you}}',
                        },
                        { count: needsYou },
                      )
                    : undefined
                }
              >
                {s.label}
                {count && <span className="tb-ct">{needsYou}</span>}
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
        {projectId && tab === 'entries' && <EntriesTopControls projectId={projectId} />}
        {projectId && tab === 'graph' && <GraphTopControls projectId={projectId} />}
      </TopBar>
      <main className="bd bd-paged">
        {projectId && <ProjectReadStatus label={SCREEN_NAMES.memory} projectId={projectId} />}
        <Tabs.Panel className="bd-body" value="overview">
          {projectId && (
            <MemoryOverview
              key={projectId}
              projectId={projectId}
              memory={(onHold) => <OverviewMemory projectId={projectId} onHold={onHold} />}
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel className="bd-body" value="entries">
          {projectId && <EntriesPage key={projectId} projectId={projectId} />}
        </Tabs.Panel>
        <Tabs.Panel className="bd-body" value="graph">
          {projectId && <MemoryGraphView key={projectId} projectId={projectId} />}
        </Tabs.Panel>
        <Tabs.Panel className="bd-body" value="diagrams">
          {projectId && <DiagramsPage key={projectId} projectId={projectId} />}
        </Tabs.Panel>
        <Tabs.Panel className="bd-body" value="learned">
          {projectId && (
            <LearnedPage key={projectId} projectId={projectId} onOpenRetros={openRetrospective} />
          )}
        </Tabs.Panel>
      </main>
    </Tabs.Root>
  );
}
