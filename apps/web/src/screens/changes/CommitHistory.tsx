import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Tabs } from '@base-ui/react/tabs';
import type { RepoLog, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { ageText, useNow } from '../../data/needs-you';
import { useRepoLog } from '../../data/repo';
import { t } from '../../i18n';
import { shortcutMatches } from '../../lib/shortcuts';
import { BranchCompare } from './BranchCompare';
import { CommitAttribution, CommitDetail, shortSha } from './CommitDetail';
import { layoutCommitGraph, type CommitGraphLayout } from './commit-graph';
import './commit-history.css';

/** Commits read per page of the log. */
export const LOG_PAGE = 50;

const ROW = 30;
const STEP = 14;
const PAD = 12;
const BEND = 14;

const PICKED_KEY = 'pantheon.changes.commit.';

function loadPicked(projectId: string | null): string | null {
  if (!projectId) return null;
  try {
    return localStorage.getItem(PICKED_KEY + projectId);
  } catch {
    return null;
  }
}

/** The opened commit, kept per project. */
function usePickedCommit(projectId: string | null) {
  const [stored, setStored] = useState(() => ({ projectId, sha: loadPicked(projectId) }));
  if (stored.projectId !== projectId) setStored({ projectId, sha: loadPicked(projectId) });
  const choose = (sha: string | null) => {
    setStored({ projectId, sha });
    if (!projectId) return;
    try {
      if (sha) localStorage.setItem(PICKED_KEY + projectId, sha);
      else localStorage.removeItem(PICKED_KEY + projectId);
    } catch {
      // The choice holds in this window only.
    }
  };
  return [stored.sha, choose] as const;
}

/** The log's first page, kept live, then the pages asked for after it. */
function useLogPages(projectId: string | null) {
  const head = useRepoLog(projectId, LOG_PAGE, 0);
  const [pages, setPages] = useState<{ under: string | null; older: RepoLog[]; asked: number }>({
    under: null,
    older: [],
    asked: 0,
  });
  const { older, asked } = pages;
  const top = head.read?.commits[0]?.sha ?? null;
  // Later pages count from the first page's top commit, so a moved HEAD cannot shift them.
  const next = useRepoLog(
    asked > 0 ? projectId : null,
    LOG_PAGE,
    asked * LOG_PAGE,
    top ?? undefined,
  );
  const landed = asked > 0 ? next.read : null;
  // Clones of one repository share commits but not their attribution.
  const under = projectId && top ? `${projectId} ${top}` : null;
  if (under !== pages.under) setPages({ under, older: [], asked: 0 });
  const commits = useMemo(() => {
    const seen = new Set<string>();
    return [head.read, ...older, landed]
      .flatMap((log) => log?.commits ?? [])
      .filter((c) => !seen.has(c.sha) && !!seen.add(c.sha));
  }, [head.read, older, landed]);
  const last = asked === 0 ? head.read : landed;
  return {
    head,
    commits,
    more: asked > 0 && !landed ? ('busy' as const) : !!last?.has_more,
    error: asked > 0 ? next.error : null,
    retry: next.reload,
    loadMore: () => {
      if (asked > 0 && !landed) return;
      setPages({ ...pages, older: landed ? [...older, landed] : older, asked: asked + 1 });
    },
  };
}

const x = (column: number) => PAD + column * STEP;
const y = (row: number) => ROW / 2 + row * ROW;
const graphWidth = (layout: CommitGraphLayout) => 2 * PAD + Math.max(0, layout.width - 1) * STEP;

function GraphLines({ layout, filled }: { layout: CommitGraphLayout; filled: boolean[] }) {
  const rows = layout.columns.length;
  const width = graphWidth(layout);
  const height = rows * ROW;
  return (
    <svg
      className="chc-lines"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={t(
        {
          id: 'changes.commits.graphLabel',
          defaultMessage:
            'Commit graph: {count, plural, one {# commit} other {# commits}} on {lines, plural, one {# line} other {# lines}}',
        },
        { count: rows, lines: layout.width },
      )}
    >
      {layout.edges.map((e, i) => {
        const top = y(e.child);
        const bottom = e.parent === null ? height : y(e.parent);
        let d = `M${x(e.from)} ${top}`;
        if (e.lane !== e.from) d += ` Q${x(e.lane)} ${top} ${x(e.lane)} ${top + BEND}`;
        d +=
          e.parent !== null && e.to !== e.lane
            ? ` V${bottom - BEND} Q${x(e.lane)} ${bottom} ${x(e.to)} ${bottom}`
            : ` V${bottom}`;
        return <path key={i} d={d} />;
      })}
      {layout.columns.map((column, row) => (
        <circle key={row} cx={x(column)} cy={y(row)} r={4} data-filled={filled[row] || undefined} />
      ))}
    </svg>
  );
}

/** The project's commits as a graph, newest first; the opened one shows beside the list. */
export function CommitHistory({
  projectId,
  sessions,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
}) {
  const pages = useLogPages(projectId);
  const now = useNow(60_000);
  const [picked, pick] = usePickedCommit(projectId);
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<'graph' | 'compare'>('graph');
  const listRef = useRef<HTMLDivElement>(null);
  const { commits } = pages;
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  const highlighted =
    commits.find((c) => c.sha === active) ?? commits.find((c) => c.sha === picked) ?? commits[0];
  const name = t({ id: 'changes.commits.list', defaultMessage: 'Commits' });

  const panel = (body: ReactNode) => (
    <Tabs.Panel
      className="chg"
      value="commits"
      data-inspector={picked && view === 'graph' ? '' : undefined}
    >
      {body}
    </Tabs.Panel>
  );
  const views = (
    <RadioGroup<'graph' | 'compare'>
      className="tb-seg chc-view"
      aria-label={t({ id: 'changes.commits.view', defaultMessage: 'View' })}
      value={view}
      onValueChange={setView}
    >
      <Radio.Root value="graph">
        {t({ id: 'changes.commits.viewGraph', defaultMessage: 'Graph' })}
      </Radio.Root>
      <Radio.Root value="compare">
        {t({ id: 'changes.commits.viewCompare', defaultMessage: 'Compare' })}
      </Radio.Root>
    </RadioGroup>
  );
  if (view === 'compare')
    return panel(
      <div className="chg-main">
        {views}
        <BranchCompare projectId={projectId} />
      </div>,
    );
  const detail = picked && (
    <CommitDetail
      key={picked}
      projectId={projectId}
      sha={picked}
      commit={commits.find((c) => c.sha === picked) ?? null}
      sessions={sessions}
      onOpen={pick}
      onClose={() => {
        setActive(picked);
        pick(null);
        listRef.current?.focus();
      }}
    />
  );
  if (!pages.head.read)
    return panel(
      <>
        <div className="chg-main">
          {views}
          {pages.head.error ? (
            <Failure error={pages.head.error} onRetry={pages.head.reload} />
          ) : (
            <Skeleton />
          )}
        </div>
        {detail}
      </>,
    );
  if (commits.length === 0)
    return panel(
      <div className="chg-main">
        {views}
        <EmptyState
          inline
          title={t({ id: 'changes.commits.empty', defaultMessage: 'No commits yet' })}
        />
      </div>,
    );

  const at = highlighted ? commits.indexOf(highlighted) : 0;
  const move = (to: number) => {
    const sha = commits[Math.max(0, Math.min(commits.length - 1, to))]!.sha;
    setActive(sha);
    globalThis.document?.getElementById(`chc-${sha}`)?.scrollIntoView({ block: 'nearest' });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A key on a button in a row belongs to that button.
    if (e.target !== e.currentTarget) return;
    if (shortcutMatches('list-down', e) || shortcutMatches('list-next', e)) move(at + 1);
    else if (shortcutMatches('list-up', e) || shortcutMatches('list-previous', e)) move(at - 1);
    else if (shortcutMatches('list-first', e)) move(0);
    else if (shortcutMatches('list-last', e)) move(commits.length - 1);
    else if (shortcutMatches('list-open', e) && highlighted) pick(highlighted.sha);
    else if (e.key === 'Escape' && picked) pick(null);
    else return;
    e.preventDefault();
  };

  return panel(
    <>
      <div className="chg-main">
        {views}
        <div
          className="chc-rows"
          style={{ '--chc-gw': `${graphWidth(layout)}px` } as CSSProperties}
        >
          <GraphLines layout={layout} filled={commits.map((c) => c.refs.length > 0)} />
          <div
            ref={listRef}
            className="chc-list"
            role="listbox"
            tabIndex={0}
            aria-label={name}
            aria-activedescendant={highlighted ? `chc-${highlighted.sha}` : undefined}
            onKeyDown={onKeyDown}
          >
            {commits.map((c) => (
              <div
                key={c.sha}
                id={`chc-${c.sha}`}
                role="option"
                className="chc-row"
                aria-selected={c.sha === picked}
                data-active={c.sha === highlighted?.sha || undefined}
                onClick={() => {
                  setActive(c.sha);
                  pick(c.sha);
                }}
              >
                <span className="chc-subj">
                  {c.refs.map((ref) => (
                    <span key={ref} className="chip mono">
                      {ref}
                    </span>
                  ))}
                  <Clip text={c.subject} />
                  <CommitAttribution commit={c} sessions={sessions} place="list" />
                </span>
                <Clip text={c.author} className="chg-mu" />
                <time className="chg-mu" dateTime={new Date(c.committed_at).toISOString()}>
                  {ageText(c.committed_at, now)}
                </time>
                <span className="mono chg-mu">{shortSha(c.sha)}</span>
              </div>
            ))}
          </div>
        </div>
        {pages.error && <Failure error={pages.error} onRetry={pages.retry} />}
        {pages.more && (
          <div className="chc-more">
            <button
              type="button"
              className="btn ghost sm"
              disabled={pages.more === 'busy'}
              aria-busy={pages.more === 'busy' || undefined}
              onClick={pages.loadMore}
            >
              {t({ id: 'changes.commits.loadMore', defaultMessage: 'More' })}
            </button>
          </div>
        )}
      </div>
      {detail}
    </>,
  );
}
