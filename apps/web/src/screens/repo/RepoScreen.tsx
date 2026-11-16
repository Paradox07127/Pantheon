import { Activity, useState, useSyncExternalStore } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { ArrowLeft } from 'lucide-react';
import { TopBar } from '../../components/TopBar';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { ChangesTab } from './ChangesTab';
import { CompareTab } from './CompareTab';
import { FileHistory } from './file/FileHistory';
import { CommitDetail } from './history/CommitDetail';
import { OverviewControls, OverviewTab } from './OverviewTab';
import { SessionPassage } from './passage/SessionPassage';
import { PullRequestsTab } from './PullRequestsTab';
import { openRepoView, useRepoView } from './route';
import { TimelineControls, TimelineTab } from './TimelineTab';
import '../board/board.css';
import './repo-screen.css';

export type RepoTab = 'timeline' | 'changes' | 'compare' | 'overview' | 'pulls';

// Labels are getters, so each is read in the language loaded by then.
const TABS: { key: RepoTab; label: string }[] = [
  {
    key: 'timeline',
    get label() {
      return t({ id: 'repo.tabs.timeline', defaultMessage: 'Timeline' });
    },
  },
  {
    key: 'changes',
    get label() {
      return t({ id: 'repo.tabs.changes', defaultMessage: 'Changes' });
    },
  },
  {
    key: 'compare',
    get label() {
      return t({ id: 'repo.tabs.compare', defaultMessage: 'Compare' });
    },
  },
  {
    key: 'overview',
    get label() {
      return t({ id: 'repo.tabs.overview', defaultMessage: 'Overview' });
    },
  },
  {
    key: 'pulls',
    get label() {
      return t({ id: 'repo.tabs.pulls', defaultMessage: 'Pull requests' });
    },
  },
];

const TAB_BODIES = {
  timeline: TimelineTab,
  changes: ChangesTab,
  compare: CompareTab,
  overview: OverviewTab,
  pulls: PullRequestsTab,
} satisfies Record<RepoTab, unknown>;

/** The stored repository tab; anything else opens the timeline. */
export function readRepoTab(raw: string | null): RepoTab {
  return TABS.find((s) => s.key === raw)?.key ?? 'timeline';
}

const tabKey = (projectId: string) => `pantheon.repo.${projectId}`;

function storedTab(projectId: string): RepoTab {
  try {
    return readRepoTab(localStorage.getItem(tabKey(projectId)));
  } catch {
    return 'timeline';
  }
}

// The tab picked on each project's repository page while the app runs.
let picked: Readonly<Record<string, RepoTab>> = {};
const pickListeners = new Set<() => void>();
const subscribePicked = (listener: () => void) => {
  pickListeners.add(listener);
  return () => void pickListeners.delete(listener);
};

export function pickRepoTab(projectId: string, tab: RepoTab) {
  picked = { ...picked, [projectId]: tab };
  pickListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(tabKey(projectId), tab);
  } catch {
    // The choice still holds until the app closes.
  }
}

/** The tab the project's repository page shows. */
export function useRepoTab(projectId: string | null): RepoTab {
  const read = () => (projectId ? picked[projectId] : undefined);
  const chosen = useSyncExternalStore(subscribePicked, read, read);
  return projectId ? (chosen ?? storedTab(projectId)) : 'timeline';
}

export function RepoScreen({
  projectId,
  onOpenSession,
}: {
  projectId: string | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const tab = useRepoTab(projectId);
  const view = useRepoView(projectId);
  const [seenProject, setSeenProject] = useState(projectId);
  const [seen, setSeen] = useState<readonly RepoTab[]>([tab]);
  if (seenProject !== projectId) {
    setSeenProject(projectId);
    setSeen([tab]);
  } else if (!seen.includes(tab)) setSeen([...seen, tab]);
  const tabLabel = TABS.find((s) => s.key === tab)!.label;
  return (
    <Tabs.Root
      className="tb-pg"
      value={tab}
      onValueChange={(value) => {
        if (!projectId) return;
        pickRepoTab(projectId, value as RepoTab);
        openRepoView(projectId, { kind: 'tabs' });
      }}
    >
      <TopBar title={SCREEN_NAMES.repo}>
        <Tabs.List
          className="tb-tabs"
          aria-label={t({ id: 'repo.tabs.label', defaultMessage: 'Repository views' })}
        >
          {TABS.map((s) => (
            <Tabs.Tab key={s.key} className="tb-tab" value={s.key}>
              {s.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {projectId && view.kind !== 'tabs' && (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => openRepoView(projectId, { kind: 'tabs' })}
          >
            <ArrowLeft className="ic-sm" aria-hidden="true" />
            {t({ id: 'repo.view.back', defaultMessage: 'Back to {tab}' }, { tab: tabLabel })}
          </button>
        )}
        {projectId && view.kind === 'tabs' && tab === 'timeline' && (
          <TimelineControls projectId={projectId} />
        )}
        {projectId && view.kind === 'tabs' && tab === 'overview' && (
          <OverviewControls projectId={projectId} />
        )}
      </TopBar>
      <main className="bd">
        <div className="bd-grid">
          {projectId &&
            (view.kind === 'commit' ? (
              <CommitDetail
                key={`${projectId} ${view.sha}`}
                projectId={projectId}
                sha={view.sha}
                onOpenSession={onOpenSession}
              />
            ) : view.kind === 'session' ? (
              <SessionPassage
                key={`${projectId} ${view.sessionId}`}
                projectId={projectId}
                sessionId={view.sessionId}
                onOpenSession={onOpenSession}
              />
            ) : view.kind === 'file' ? (
              <FileHistory
                key={`${projectId} ${view.path}`}
                projectId={projectId}
                path={view.path}
                onOpenSession={onOpenSession}
              />
            ) : (
              // A seen tab stays mounted and is hidden in the switch's own commit.
              TABS.filter((s) => seen.includes(s.key)).map(({ key }) => {
                const Body = TAB_BODIES[key];
                return (
                  <Activity key={key} mode={key === tab ? 'visible' : 'hidden'}>
                    <Tabs.Panel className="bd-s12 bd-sub" value={key} keepMounted>
                      <Body key={projectId} projectId={projectId} onOpenSession={onOpenSession} />
                    </Tabs.Panel>
                  </Activity>
                );
              })
            ))}
        </div>
      </main>
    </Tabs.Root>
  );
}
