import { useSyncExternalStore } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { t } from '../../i18n';
import { CommitGraph } from './history/CommitGraph';
import { RepoLanes } from './timeline/RepoLanes';

export type TimelineView = 'lanes' | 'graph';

/** The stored timeline view; anything else shows the lanes. */
export const readTimelineView = (raw: string | null): TimelineView =>
  raw === 'graph' ? 'graph' : 'lanes';

const viewKey = (projectId: string) => `pantheon.repo.timeline.${projectId}`;

function storedView(projectId: string): TimelineView {
  try {
    return readTimelineView(localStorage.getItem(viewKey(projectId)));
  } catch {
    return 'lanes';
  }
}

// The view picked on each project's timeline while the app runs.
let picked: Readonly<Record<string, TimelineView>> = {};
const pickListeners = new Set<() => void>();
const subscribePicked = (listener: () => void) => {
  pickListeners.add(listener);
  return () => void pickListeners.delete(listener);
};

export function pickTimelineView(projectId: string, view: TimelineView) {
  picked = { ...picked, [projectId]: view };
  pickListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(viewKey(projectId), view);
  } catch {
    // The choice still holds until the app closes.
  }
}

function useTimelineView(projectId: string): TimelineView {
  const read = () => picked[projectId];
  return useSyncExternalStore(subscribePicked, read, read) ?? storedView(projectId);
}

/** The timeline's controls in the page's top bar. */
export function TimelineControls({ projectId }: { projectId: string }) {
  const view = useTimelineView(projectId);
  return (
    <div className="tb-end">
      <RadioGroup<TimelineView>
        className="tb-seg"
        aria-label={t({ id: 'repo.history.views', defaultMessage: 'Timeline view' })}
        value={view}
        onValueChange={(value) => pickTimelineView(projectId, value)}
      >
        <Radio.Root value="lanes">
          {t({ id: 'repo.history.lanes', defaultMessage: 'Lanes' })}
        </Radio.Root>
        <Radio.Root value="graph">
          {t({ id: 'repo.history.graph', defaultMessage: 'Commit graph' })}
        </Radio.Root>
      </RadioGroup>
    </div>
  );
}

export function TimelineTab({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const view = useTimelineView(projectId);
  return (
    <div className="bd-s12">
      {view === 'graph' ? (
        <CommitGraph projectId={projectId} onOpenSession={onOpenSession} />
      ) : (
        <RepoLanes projectId={projectId} onOpenSession={onOpenSession} />
      )}
    </div>
  );
}
