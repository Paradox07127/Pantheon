import { useState, useSyncExternalStore } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { useBoardView } from '../../data/board-view';
import { useFactsRead } from '../../data/facts-read';
import { useNow } from '../../data/needs-you';
import { useProjectHead } from '../../data/runtime-models';
import { useProjectHeatmap } from '../../data/trace';
import { useSessionList } from '../../data/workbench-sessions';
import { useStaleWorkspaces } from '../../data/worktree-setup';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { Failure, Skeleton, useBaselineStart } from '../board/BoardScreen';
import { Panel } from '../board/Charts';
import { MergesPanel } from '../board/Lists';
import {
  BranchPanel,
  CommitPanel,
  DocsPanel,
  HotspotPanel,
  MergeHeat,
  RepoKpis,
  RepoPanels,
} from '../board/RepoCharts';
import { QueryBody } from '../board/Tables';
import { workstreamRows } from '../projects/facts';
import { WorkstreamBars } from '../projects/WorkstreamBars';
import { WorkstreamDetails } from '../projects/WorkstreamDetails';

const repoTitle = () => t({ id: 'board.repo.title', defaultMessage: 'Repository' });

export type OverviewRange = '7d' | '30d' | '12w';

// Each range's name and the board and heatmap windows that cover it; the board reads no twelve
// week window, so that range reads all of it.
const RANGES = {
  '7d': {
    days: 7,
    board: 7,
    heat: '7',
    label: () => t({ id: 'repo.overview.range.week', defaultMessage: '7 days' }),
  },
  '30d': {
    days: 30,
    board: 30,
    heat: '30',
    label: () => t({ id: 'repo.overview.range.month', defaultMessage: '30 days' }),
  },
  '12w': {
    days: 84,
    board: 'all',
    heat: '90',
    label: () => t({ id: 'repo.overview.range.quarter', defaultMessage: '12 weeks' }),
  },
} as const satisfies Record<OverviewRange, unknown>;

/** The stored overview range; anything else shows 30 days. */
export const readOverviewRange = (raw: string | null): OverviewRange =>
  raw === '7d' || raw === '12w' ? raw : '30d';

const rangeKey = (projectId: string) => `pantheon.repo.overview.${projectId}`;

function storedRange(projectId: string): OverviewRange {
  try {
    return readOverviewRange(localStorage.getItem(rangeKey(projectId)));
  } catch {
    return '30d';
  }
}

// The range picked on each project's overview while the app runs.
let picked: Readonly<Record<string, OverviewRange>> = {};
const pickListeners = new Set<() => void>();
const subscribePicked = (listener: () => void) => {
  pickListeners.add(listener);
  return () => void pickListeners.delete(listener);
};

export function pickOverviewRange(projectId: string, range: OverviewRange) {
  picked = { ...picked, [projectId]: range };
  pickListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(rangeKey(projectId), range);
  } catch {
    // The choice still holds until the app closes.
  }
}

function useOverviewRange(projectId: string): OverviewRange {
  const read = () => picked[projectId];
  return useSyncExternalStore(subscribePicked, read, read) ?? storedRange(projectId);
}

/** The overview's controls in the page's top bar. */
export function OverviewControls({ projectId }: { projectId: string }) {
  const range = useOverviewRange(projectId);
  return (
    <div className="tb-end">
      <RadioGroup<OverviewRange>
        className="tb-seg"
        aria-label={t({ id: 'repo.overview.range', defaultMessage: 'Time range' })}
        value={range}
        onValueChange={(value) => pickOverviewRange(projectId, value)}
      >
        {(Object.keys(RANGES) as OverviewRange[]).map((key) => (
          <Radio.Root key={key} value={key}>
            {RANGES[key].label()}
          </Radio.Root>
        ))}
      </RadioGroup>
    </div>
  );
}

/**
 * The repository's figures, branches, merges, workstreams, commits and docs. It draws once the
 * merge heat and the facts have landed or failed; later reads update the panels in place.
 */
export function OverviewTab({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const range = RANGES[useOverviewRange(projectId)];
  const heat = useProjectHeatmap(projectId, range.heat);
  const facts = useFactsRead(projectId);
  const stale = useStaleWorkspaces(projectId);
  const head = useProjectHead(projectId);
  const sessions = useSessionList(projectId);
  const board = useBoardView(projectId, range.board);
  const baseline = useBaselineStart(projectId);
  const openSession = useShell((s) => s.openSession);
  const now = useNow(60_000);
  const [drawn, setDrawn] = useState(false);
  const waiting = heat.loading || facts.loading;
  if (!drawn && !waiting) setDrawn(true);
  if (!drawn && waiting)
    return (
      <section className="bd-pn bd-s12" aria-labelledby="bd-repo-h">
        <div className="bd-ph">
          <h2 id="bd-repo-h">{repoTitle()}</h2>
        </div>
        <Skeleton />
      </section>
    );
  const measured = facts.read?.facts;
  const workstreams = facts.read?.workstreams ?? [];
  return (
    <>
      {baseline?.error && (
        <div className="bd-s12">
          <Failure error={baseline.error} onRetry={() => baseline.onStart()} />
        </div>
      )}
      {facts.read && facts.error && (
        <div className="bd-s12">
          <Failure error={facts.error} onRetry={facts.reload} />
        </div>
      )}
      {stale.error && !stale.unavailable && (
        <div className="bd-s12">
          <Failure error={stale.error} onRetry={stale.reload} />
        </div>
      )}
      <div className="bd-s12">
        <RepoKpis head={head.read} sessions={sessions.data} stale={stale.read} now={now} />
      </div>
      <div className="ro-wide">
        <BranchPanel
          projectId={projectId}
          sessions={sessions.data}
          stale={stale}
          base={head.read?.branch}
        />
      </div>
      <div className="ro-narrow">
        {heat.data ? (
          <MergeHeat
            heatmap={heat.data}
            shared={stale.read?.shared_files}
            days={range.days}
            span={range.label()}
          />
        ) : (
          <Panel title={t({ id: 'insights.mergeHeat.title', defaultMessage: 'Merges' })}>
            <QueryBody query={heat}>{() => null}</QueryBody>
          </Panel>
        )}
      </div>
      {measured ? (
        <>
          {workstreams.length > 0 && (
            <div className="ro-wide">
              <Panel
                title={t({ id: 'board.repo.workstreams', defaultMessage: 'Workstream status' })}
              >
                <WorkstreamBars rows={workstreamRows(workstreams)} />
                <WorkstreamDetails rows={workstreams} />
              </Panel>
            </div>
          )}
          <div className={workstreams.length > 0 ? 'ro-narrow ro-stack' : 'bd-s12 ro-stack'}>
            <CommitPanel facts={measured} />
            <HotspotPanel facts={measured} />
          </div>
          <div className="ro-narrow">
            <DocsPanel facts={measured} now={now} />
          </div>
        </>
      ) : facts.read ? (
        <RepoPanels read={facts.read} now={now} baseline={baseline} onOpenSession={onOpenSession} />
      ) : (
        <section className="bd-pn bd-s12" aria-labelledby="bd-repo-h">
          <div className="bd-ph">
            <h2 id="bd-repo-h">{repoTitle()}</h2>
          </div>
          {facts.error ? <Failure error={facts.error} onRetry={facts.reload} /> : <Skeleton />}
        </section>
      )}
      <div className={measured ? 'ro-wide' : 'bd-s12'}>
        {board.data ? (
          <MergesPanel
            model={board.data}
            onOpenSession={onOpenSession}
            onOpenStory={(sessionId) => openSession(sessionId, 'story')}
          />
        ) : (
          <Panel title={t({ id: 'board.merges.title', defaultMessage: 'Local merge history' })}>
            <QueryBody query={board}>{() => null}</QueryBody>
          </Panel>
        )}
      </div>
    </>
  );
}
