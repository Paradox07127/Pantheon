import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ChangeStory } from '@pantheon/domain';
import type { RepoCommit, WorkbenchSession } from '@pantheon/protocol';
import { Copy } from 'lucide-react';
import { DiffCounts } from '../../../components/DiffCounts';
import { DiffStat } from '../../../components/DiffReview';
import { SessionStateIcon, sessionStateTone } from '../../../components/SessionStateIcon';
import { useChangeStories } from '../../../data/change-story';
import { ageText, useNow } from '../../../data/needs-you';
import { useRepoCommitDiff, useRepoLog, type RepoLog } from '../../../data/repo';
import { useSessionList } from '../../../data/workbench-sessions';
import { t } from '../../../i18n';
import { shortcutMatches } from '../../../lib/shortcuts';
import { useShell } from '../../../store';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { Empty } from '../../board/Charts';
import { sessionStory } from '../../sessions/inspector-model';
import { openRepoView } from '../route';
import { layoutCommitGraph, type CommitGraphLayout } from './commit-graph';
import './history.css';

/** Commits read per page of the log. */
export const LOG_PAGE = 200;

const ROW = 30;
const STEP = 14;
const PAD = 12;
const BEND = 14;

export const shortSha = (sha: string) => sha.slice(0, 7);

/** The ready interpretation of the session that landed a commit, or null. */
export function landedStory(
  stories: readonly ChangeStory[] | null,
  sessionId: string | undefined,
): ChangeStory | null {
  if (!stories || !sessionId) return null;
  const story = sessionStory(stories, sessionId);
  return story?.state === 'ready' && story.result ? story : null;
}

export const sessionName = (session: WorkbenchSession) =>
  session.title || session.goal?.text || session.id;

type LogPages = {
  /** The first page's newest commit when the pages after it were read. */
  under: string | null;
  /** The pages after the first that landed, in order. */
  older: readonly RepoLog[];
  /** Pages after the first asked for; the last of them is the one being read. */
  asked: number;
  /** Pages after the first to read again once the first page moved under them. */
  restore: number;
  /** The read the asked page has not replaced yet. */
  stale: RepoLog | null;
};

const NO_PAGES: LogPages = { under: null, older: [], asked: 0, restore: 0, stale: null };

/** The log's first page, kept live, then the pages asked for after it. */
function useLogPages(projectId: string) {
  const head = useRepoLog(projectId, LOG_PAGE, 0);
  const [pages, setPages] = useState(NO_PAGES);
  const { older, asked } = pages;
  const next = useRepoLog(asked > 0 ? projectId : null, LOG_PAGE, asked * LOG_PAGE);
  const landed = asked > 0 && next.read && next.read !== pages.stale ? next.read : null;
  const restoring = !!landed && asked < pages.restore && landed.has_more;
  const top = head.read?.commits[0]?.sha ?? null;
  if (top !== pages.under) {
    if (asked === 0) setPages({ ...pages, under: top });
    else {
      // New commits shift every later page's offset, so read those pages again from the second.
      setPages({
        under: top,
        older: [],
        asked: 1,
        restore: Math.max(asked, pages.restore),
        stale: next.read,
      });
      next.reload();
    }
  } else if (restoring)
    setPages({ ...pages, older: [...older, landed], asked: asked + 1, stale: landed });
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
    more: asked > 0 && (!landed || restoring) ? ('busy' as const) : !!last?.has_more,
    error: asked > 0 ? next.error : null,
    retry: next.reload,
    loadMore: () => {
      if (asked > 0 && !landed) return;
      setPages({
        ...pages,
        older: landed ? [...older, landed] : older,
        asked: asked + 1,
        stale: landed,
      });
    },
  };
}

const x = (column: number) => PAD + column * STEP;
const y = (row: number) => ROW / 2 + row * ROW;

function GraphLines({
  layout,
  tones,
  filled,
}: {
  layout: CommitGraphLayout;
  /** Each row's colour. */
  tones: string[];
  /** Rows whose dot is solid: a branch or tag points there. */
  filled: boolean[];
}) {
  const rows = layout.columns.length;
  const width = 2 * PAD + (layout.width - 1) * STEP;
  const height = rows * ROW;
  return (
    <svg
      className="rh-lines"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={t(
        {
          id: 'repo.history.graphLabel',
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
        const tone = e.parent === null ? 'var(--mu)' : tones[e.parent]!;
        return <path key={i} d={d} style={{ stroke: tone }} />;
      })}
      {layout.columns.map((column, row) => (
        <circle
          key={row}
          cx={x(column)}
          cy={y(row)}
          r={4}
          style={{ stroke: tones[row], fill: filled[row] ? tones[row] : 'var(--sf)' }}
        />
      ))}
    </svg>
  );
}

/** The whole project's commit graph with the picked commit's summary beside it. */
export function CommitGraph({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const pages = useLogPages(projectId);
  const sessions = useSessionList(projectId);
  const stories = useChangeStories(projectId);
  const now = useNow(60_000);
  const [picked, setPicked] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const id = useId();
  const { commits } = pages;
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  const byId = new Map((sessions.data ?? []).map((s) => [s.id, s]));
  const tones = commits.map((c) => {
    const session = c.session_id ? byId.get(c.session_id) : undefined;
    return session ? `var(${sessionStateTone(session)})` : 'var(--mu)';
  });
  const at = Math.max(
    0,
    commits.findIndex((c) => c.sha === picked),
  );
  const selected = commits[at] ?? null;
  const open = (sha: string) => openRepoView(projectId, { kind: 'commit', sha });
  const rowId = (sha: string) => `${id}-${sha}`;

  if (!pages.head.read)
    return pages.head.error ? (
      <Failure error={pages.head.error} onRetry={pages.head.reload} />
    ) : (
      <Skeleton />
    );
  if (commits.length === 0)
    return <Empty text={t({ id: 'repo.history.empty', defaultMessage: 'No commits yet' })} />;

  const move = (to: number) => {
    const commit = commits[Math.min(commits.length - 1, Math.max(0, to))]!;
    setPicked(commit.sha);
    rowEls.current.get(commit.sha)?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (shortcutMatches('list-down', e) || shortcutMatches('list-next', e)) move(at + 1);
    else if (shortcutMatches('list-up', e) || shortcutMatches('list-previous', e)) move(at - 1);
    else if (shortcutMatches('list-open', e) && selected) open(selected.sha);
    else return;
    e.preventDefault();
  };

  return (
    <div className="rh-graph">
      <section
        className="rh-list"
        aria-label={t({ id: 'repo.history.graph', defaultMessage: 'Commit graph' })}
        style={{ '--rh-gw': `${2 * PAD + (layout.width - 1) * STEP}px` } as CSSProperties}
      >
        <div className="rh-rows">
          <GraphLines
            layout={layout}
            tones={tones}
            filled={commits.map((c) => c.refs.length > 0)}
          />
          <div
            role="listbox"
            tabIndex={0}
            aria-label={t({ id: 'repo.history.commits', defaultMessage: 'Commits' })}
            aria-activedescendant={selected ? rowId(selected.sha) : undefined}
            onKeyDown={onKey}
          >
            {commits.map((c) => {
              const story = landedStory(stories.read, c.session_id);
              return (
                <div
                  key={c.sha}
                  id={rowId(c.sha)}
                  role="option"
                  aria-selected={c === selected}
                  className="rh-row"
                  ref={(el) => {
                    if (el) rowEls.current.set(c.sha, el);
                    else rowEls.current.delete(c.sha);
                  }}
                  onClick={() => setPicked(c.sha)}
                  onDoubleClick={() => open(c.sha)}
                >
                  <span className="rh-subj">
                    {c.refs.map((ref) => (
                      <span key={ref} className="chip mono">
                        {ref}
                      </span>
                    ))}
                    <span className="rh-cut" title={c.subject}>
                      {c.subject}
                    </span>
                    {story && (
                      <span className="chip">
                        {t({ id: 'repo.history.explained', defaultMessage: 'Explained' })}
                      </span>
                    )}
                  </span>
                  <span className="rh-cut mu" title={c.author}>
                    {c.author}
                  </span>
                  <time className="mu" dateTime={new Date(c.committed_at).toISOString()}>
                    {ageText(c.committed_at, now)}
                  </time>
                  <span className="mono mu rh-sha">
                    {shortSha(c.sha)}
                    <button
                      type="button"
                      className="rh-copy"
                      tabIndex={c === selected ? 0 : -1}
                      aria-label={t(
                        { id: 'repo.history.copySha', defaultMessage: 'Copy {sha}' },
                        { sha: c.sha },
                      )}
                      onClick={() => void navigator.clipboard.writeText(c.sha)}
                    >
                      <Copy aria-hidden="true" />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {pages.error && <Failure error={pages.error} onRetry={pages.retry} />}
        {pages.more && (
          <div className="rh-more">
            <button
              type="button"
              className="btn ghost sm"
              disabled={pages.more === 'busy'}
              aria-busy={pages.more === 'busy' || undefined}
              onClick={pages.loadMore}
            >
              {t({ id: 'repo.history.loadMore', defaultMessage: 'Load more' })}
            </button>
          </div>
        )}
      </section>
      {selected && (
        <CommitSummary
          key={selected.sha}
          projectId={projectId}
          commit={selected}
          session={selected.session_id ? (byId.get(selected.session_id) ?? null) : null}
          story={landedStory(stories.read, selected.session_id)}
          now={now}
          onOpen={() => open(selected.sha)}
          onOpenSession={onOpenSession}
        />
      )}
    </div>
  );
}

function CommitSummary({
  projectId,
  commit,
  session,
  story,
  now,
  onOpen,
  onOpenSession,
}: {
  projectId: string;
  commit: RepoCommit;
  session: WorkbenchSession | null;
  story: ChangeStory | null;
  now: number;
  onOpen: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const diff = useRepoCommitDiff(projectId, commit.sha);
  const openSession = useShell((s) => s.openSession);
  const files = diff.read?.files ?? [];
  const sum = (key: 'additions' | 'deletions') => files.reduce((n, f) => n + (f[key] ?? 0), 0);
  const result = story?.result;
  return (
    <aside
      className="rh-side"
      aria-label={t({ id: 'repo.history.summary', defaultMessage: 'Commit summary' })}
    >
      <div className="rh-sh">
        <span className="mono rh-b">{shortSha(commit.sha)}</span>
        <button type="button" className="btn sm" onClick={onOpen}>
          {t({ id: 'repo.history.openCommit', defaultMessage: 'Open commit' })}
        </button>
      </div>
      <h2 className="rh-title">{commit.subject}</h2>
      <dl className="rh-kv">
        {commit.parents.length > 0 && (
          <>
            <dt>
              {t(
                {
                  id: 'repo.history.parents',
                  defaultMessage: '{count, plural, one {Parent} other {Parents}}',
                },
                { count: commit.parents.length },
              )}
            </dt>
            <dd className="rh-line">
              {commit.parents.map((p) => (
                <span key={p} className="mono">
                  {shortSha(p)}
                </span>
              ))}
            </dd>
          </>
        )}
        {session && (
          <>
            <dt>{t({ id: 'repo.history.session', defaultMessage: 'Session' })}</dt>
            <dd>
              <button type="button" className="rh-link" onClick={() => onOpenSession(session.id)}>
                <SessionStateIcon session={session} place="card" />
                <span className="rh-cut">{sessionName(session)}</span>
              </button>
            </dd>
          </>
        )}
        <dt>{t({ id: 'repo.history.author', defaultMessage: 'Author' })}</dt>
        <dd>{commit.author}</dd>
        <dt>{t({ id: 'repo.history.time', defaultMessage: 'Committed' })}</dt>
        <dd>
          <time dateTime={new Date(commit.committed_at).toISOString()}>
            {ageText(commit.committed_at, now)}
          </time>
        </dd>
      </dl>
      {story && result && (
        <section className="rh-card" aria-labelledby={`${commit.sha}-story`}>
          <h3 id={`${commit.sha}-story`}>
            {t({ id: 'repo.history.story', defaultMessage: 'Change story' })}
          </h3>
          <dl className="rh-kv">
            <dt>{t({ id: 'repo.history.before', defaultMessage: 'Before' })}</dt>
            <dd className="rh-tx2">
              {result.overall.before.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </dd>
            <dt>{t({ id: 'repo.history.after', defaultMessage: 'After' })}</dt>
            <dd>
              {result.overall.after.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </dd>
          </dl>
          <ul className="rh-cards">
            {result.cards.map((card, i) => (
              <li key={i} className="rh-cut">
                {card.title}
              </li>
            ))}
          </ul>
          {story.workbench_session_id && (
            <button
              type="button"
              className="btn sm"
              onClick={() => openSession(story.workbench_session_id!, 'story')}
            >
              {t({ id: 'repo.history.openStory', defaultMessage: 'Open change story' })}
            </button>
          )}
        </section>
      )}
      {diff.read && (
        <section className="rh-files" aria-labelledby={`${commit.sha}-files`}>
          <h3 id={`${commit.sha}-files`}>
            {t(
              {
                id: 'repo.history.files',
                defaultMessage: '{count, plural, one {# file} other {# files}}',
              },
              { count: files.length },
            )}
            <DiffStat additions={sum('additions')} deletions={sum('deletions')} />
          </h3>
          <ul>
            {files.map((f) => (
              <li key={f.path} className="rh-file">
                <span className="mono mu">{f.status[0]!.toUpperCase()}</span>
                <span className="mono rh-cut" title={f.path}>
                  {f.path}
                </span>
                {f.additions !== null && (
                  <span className="mono rh-n">
                    <DiffCounts additions={f.additions} deletions={f.deletions} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.error && <Failure error={diff.error} onRetry={diff.reload} />}
    </aside>
  );
}
