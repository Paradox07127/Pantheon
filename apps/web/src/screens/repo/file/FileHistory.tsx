import { useMemo, type CSSProperties } from 'react';
import { FileText } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { RuntimeGlyph, runtimeColor, runtimeName } from '../../../components/RuntimeGlyph';
import { SessionStateIcon } from '../../../components/SessionStateIcon';
import { useChangeStories } from '../../../data/change-story';
import { ageText, useNow } from '../../../data/needs-you';
import {
  useRepoBlame,
  useRepoFileHistory,
  type RepoBlame,
  type RepoFileHistory,
} from '../../../data/repo';
import { useProjectHead } from '../../../data/runtime-models';
import { useSessionList } from '../../../data/workbench-sessions';
import { t } from '../../../i18n';
import { listText } from '../../../lib/list-text';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { Empty } from '../../board/Charts';
import { landedStory, sessionName, shortSha } from '../history/CommitGraph';
import { openRepoView } from '../route';
import './file.css';

/** Lines drawn in the line origins; there is no virtual scroll to draw the rest on demand. */
const SHOWN_LINES = 400;
const DAY = 86_400_000;
/** Upper ages of the stripe's tiers, newest first; older lines take the last tier. */
const AGE_TIERS = [DAY, 7 * DAY, 30 * DAY, 180 * DAY];
/** Writers named in the ownership bar before the rest join "Other". */
const OWNER_KINDS = 5;

type Range = RepoBlame['pending'][number]['ranges'][number];

interface Pending {
  sessionId: string;
  name: string;
  session: WorkbenchSession | undefined;
  ranges: Range[];
  conflict: boolean;
}

interface Share {
  key: string;
  runtime: string | null;
  name: string;
  lines: number;
  color: string;
}

/** The lines a range touches; an insertion touches the line it follows. */
const span = (r: Range) => [r.start, r.start + Math.max(r.count, 1) - 1] as const;
const overlaps = (a: Range, b: Range) => {
  const [a0, a1] = span(a);
  const [b0, b1] = span(b);
  return a0 <= b1 && b0 <= a1;
};
const rangeText = (r: Range) => {
  const [lo, hi] = span(r);
  return lo === hi
    ? `${lo}`
    : t({ id: 'repo.file.lineRange', defaultMessage: '{from} to {to}' }, { from: lo, to: hi });
};

const nameOf = (sessionId: string, session: WorkbenchSession | undefined) =>
  session ? sessionName(session) : sessionId;

function pendingOf(blame: RepoBlame, byId: Map<string, WorkbenchSession>): Pending[] {
  return blame.pending.map((p, i) => ({
    sessionId: p.session_id,
    name: nameOf(p.session_id, byId.get(p.session_id)),
    session: byId.get(p.session_id),
    ranges: p.ranges,
    conflict: blame.pending.some(
      (q, j) => j !== i && p.ranges.some((a) => q.ranges.some((b) => overlaps(a, b))),
    ),
  }));
}

/** Lines of the blamed file by runtime, the user's own apart; past five kinds the rest is "Other". */
function sharesOf(blame: RepoBlame, byId: Map<string, WorkbenchSession>): Share[] {
  const lines = new Map<string, { runtime: string | null; lines: number }>();
  let unknown = 0;
  for (const c of blame.chunks) {
    const runtime = c.session_id ? byId.get(c.session_id)?.runtime : null;
    if (runtime === undefined) {
      unknown += c.count;
      continue;
    }
    const key = runtime === null ? 'you' : `rt ${runtime}`;
    lines.set(key, { runtime, lines: (lines.get(key)?.lines ?? 0) + c.count });
  }
  const sorted = [...lines].sort((a, b) => b[1].lines - a[1].lines);
  const shares: Share[] = sorted.slice(0, OWNER_KINDS).map(([key, v]) => ({
    key,
    runtime: v.runtime,
    lines: v.lines,
    name:
      v.runtime === null
        ? t({ id: 'repo.file.you', defaultMessage: 'You' })
        : runtimeName(v.runtime),
    color: v.runtime === null ? 'var(--series-5)' : runtimeColor(v.runtime),
  }));
  const rest = sorted.slice(OWNER_KINDS).reduce((n, [, v]) => n + v.lines, unknown);
  if (rest > 0)
    shares.push({
      key: 'other',
      runtime: null,
      lines: rest,
      name: t({ id: 'repo.file.other', defaultMessage: 'Other' }),
      color: 'var(--track)',
    });
  return shares;
}

const ageTier = (at: number, now: number) => {
  const tier = AGE_TIERS.findIndex((upper) => now - at < upper);
  return tier < 0 ? AGE_TIERS.length : tier;
};

/** One file: who wrote each line, what running branches change in it, and its history. */
export function FileHistory({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const blame = useRepoBlame(projectId, path);
  const history = useRepoFileHistory(projectId, path);
  const head = useProjectHead(projectId);
  const sessions = useSessionList(projectId);
  const now = useNow(60_000);
  const list = sessions.data;
  const byId = useMemo(() => new Map((list ?? []).map((s) => [s.id, s])), [list]);
  const pending = useMemo(
    () => (blame.read ? pendingOf(blame.read, byId) : []),
    [blame.read, byId],
  );
  const branch = head.read ? (head.read.branch ?? shortSha(head.read.sha)) : null;

  return (
    <section
      className="bd-s12 fh"
      aria-label={t({ id: 'repo.file.label', defaultMessage: 'History of {path}' }, { path })}
    >
      <header className="fh-h">
        <FileText className="ic-sm" aria-hidden="true" />
        <h2 className="mono fh-path fh-cut">{path}</h2>
        {branch && <span className="mono mu">{branch}</span>}
        {pending.length > 0 && (
          <span className="chip fh-chip" data-dot="run">
            {t(
              {
                id: 'repo.file.editing',
                defaultMessage:
                  '{count, plural, one {# session changing it} other {# sessions changing it}}',
              },
              { count: pending.length },
            )}
          </span>
        )}
      </header>
      <div className="fh-cols">
        <section
          className="fh-main"
          aria-label={t({ id: 'repo.file.blame', defaultMessage: 'Line origins' })}
        >
          {blame.read ? (
            <LineOrigins blame={blame.read} pending={pending} byId={byId} now={now} />
          ) : blame.error ? (
            <Failure error={blame.error} onRetry={blame.reload} />
          ) : (
            <Skeleton />
          )}
        </section>
        <aside
          className="fh-side"
          aria-label={t({ id: 'repo.file.overview', defaultMessage: 'File overview' })}
        >
          {history.read ? (
            <Frequency weekly={history.read.weekly} />
          ) : history.error ? (
            <Failure error={history.error} onRetry={history.reload} />
          ) : (
            <Skeleton />
          )}
          {blame.read && <Owners shares={sharesOf(blame.read, byId)} />}
          {pending.length > 0 && <Running projectId={projectId} pending={pending} />}
          {history.read && (
            <>
              <Cochange projectId={projectId} cochange={history.read.cochange} />
              <Recent projectId={projectId} changes={history.read.changes} now={now} />
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function LineOrigins({
  blame,
  pending,
  byId,
  now,
}: {
  blame: RepoBlame;
  pending: Pending[];
  byId: Map<string, WorkbenchSession>;
  now: number;
}) {
  if (blame.text === undefined)
    return <Empty text={t({ id: 'repo.file.noText', defaultMessage: 'No text to show' })} />;
  const lines = blame.text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const owner: (RepoBlame['chunks'][number] | undefined)[] = [];
  for (const c of blame.chunks) for (let n = c.start; n < c.start + c.count; n++) owner[n] = c;
  const marks = new Map<number, Pending[]>();
  for (const p of pending)
    for (const r of p.ranges) {
      const [lo, hi] = span(r);
      for (let n = lo; n <= hi; n++) {
        const at = marks.get(n) ?? [];
        if (!at.includes(p)) marks.set(n, [...at, p]);
      }
    }
  const you = t({ id: 'repo.file.you', defaultMessage: 'You' });

  return (
    <div
      className="fh-lines"
      role="table"
      aria-label={t({ id: 'repo.file.blame', defaultMessage: 'Line origins' })}
    >
      {lines.slice(0, SHOWN_LINES).map((code, i) => {
        const n = i + 1;
        const chunk = owner[n];
        const first = !!chunk && owner[n - 1] !== chunk;
        const session = chunk?.session_id ? byId.get(chunk.session_id) : undefined;
        const age = chunk ? ageText(chunk.at, now) : '';
        return (
          <div key={n} role="row" className="fh-row" data-top={(first && n > 1) || undefined}>
            <span role="cell" className="fh-who">
              {first && (
                <>
                  {session && <RuntimeGlyph runtime={session.runtime} size={14} />}
                  <span className="fh-cut">
                    {chunk.session_id ? nameOf(chunk.session_id, session) : you}
                  </span>
                  <span className="mu">{age}</span>
                </>
              )}
            </span>
            <span
              role="cell"
              className="fh-age"
              data-age={chunk ? ageTier(chunk.at, now) : undefined}
              aria-label={age || undefined}
            />
            <span role="cell" className="fh-n">
              {n}
            </span>
            <span role="cell" className="fh-code">
              {code}
            </span>
            <span role="cell" className="fh-pend">
              {(marks.get(n) ?? []).map((p) => (
                <span
                  key={p.sessionId}
                  role="img"
                  className="fh-mark"
                  aria-label={
                    p.conflict
                      ? t(
                          {
                            id: 'repo.file.changesLineConflict',
                            defaultMessage: '{name} changes this line and will conflict',
                          },
                          { name: p.name },
                        )
                      : t(
                          {
                            id: 'repo.file.changesLine',
                            defaultMessage: '{name} changes this line',
                          },
                          { name: p.name },
                        )
                  }
                >
                  {p.session ? <RuntimeGlyph runtime={p.session.runtime} size={14} /> : null}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SideHead({ title, value }: { title: string; value?: string }) {
  return (
    <div className="fh-sh">
      <h3>{title}</h3>
      {value && <span className="mu fh-num">{value}</span>}
    </div>
  );
}

function Frequency({ weekly }: { weekly: RepoFileHistory['weekly'] }) {
  const total = weekly.reduce((n, w) => n + w.count, 0);
  const max = Math.max(1, ...weekly.map((w) => w.count));
  const title = t({ id: 'repo.file.frequency', defaultMessage: 'Change frequency' });
  return (
    <section className="fh-sec" aria-label={title}>
      <SideHead
        title={title}
        value={t(
          {
            id: 'repo.file.frequencyTotal',
            defaultMessage:
              '{weeks, plural, one {# week} other {# weeks}}: {count, plural, one {# change} other {# changes}}',
          },
          { weeks: weekly.length, count: total },
        )}
      />
      <div
        className="fh-bars"
        role="img"
        aria-label={t(
          {
            id: 'repo.file.frequencyLabel',
            defaultMessage: 'Changes in each of the last {weeks} weeks: {counts}',
          },
          { weeks: weekly.length, counts: listText(...weekly.map((w) => String(w.count))) },
        )}
      >
        {weekly.map((w) => (
          <i key={w.start} style={{ '--v': `${(w.count / max) * 100}%` } as CSSProperties} />
        ))}
      </div>
    </section>
  );
}

function Owners({ shares }: { shares: Share[] }) {
  const total = shares.reduce((n, s) => n + s.lines, 0);
  if (total === 0) return null;
  const title = t({ id: 'repo.file.owners', defaultMessage: 'Who wrote the current lines' });
  const label = (s: Share) =>
    t(
      { id: 'repo.file.share', defaultMessage: '{name} {percent}%' },
      { name: s.name, percent: Math.round((s.lines / total) * 100) },
    );
  return (
    <section className="fh-sec" aria-label={title}>
      <SideHead
        title={title}
        value={t(
          {
            id: 'repo.file.lines',
            defaultMessage: '{count, plural, one {# line} other {# lines}}',
          },
          { count: total },
        )}
      />
      <div className="fh-own" role="img" aria-label={listText(...shares.map(label))}>
        {shares.map((s) => (
          <i key={s.key} style={{ flexGrow: s.lines, background: s.color }} />
        ))}
      </div>
      <div className="legend">
        {shares.map((s) => (
          <span key={s.key}>
            {s.runtime ? (
              <RuntimeGlyph runtime={s.runtime} size={12} />
            ) : (
              <i className="fh-dot" style={{ background: s.color }} />
            )}
            {label(s)}
          </span>
        ))}
      </div>
    </section>
  );
}

function Running({ projectId, pending }: { projectId: string; pending: Pending[] }) {
  const title = t({ id: 'repo.file.running', defaultMessage: 'Running branches' });
  return (
    <section className="fh-sec" aria-label={title}>
      <SideHead title={title} />
      <div className="fh-list">
        {pending.map((p) => (
          <button
            key={p.sessionId}
            type="button"
            className="fh-lrow"
            onClick={() => openRepoView(projectId, { kind: 'session', sessionId: p.sessionId })}
          >
            {p.session && <SessionStateIcon session={p.session} place="card" />}
            <span className="fh-cut fh-grow">{p.name}</span>
            <span className="mono mu">{listText(...p.ranges.map(rangeText))}</span>
            {p.conflict && (
              <span className="chip fh-chip" data-dot="bad">
                {t({ id: 'repo.file.conflict', defaultMessage: 'Will conflict' })}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

function Cochange({
  projectId,
  cochange,
}: {
  projectId: string;
  cochange: RepoFileHistory['cochange'];
}) {
  if (cochange.length === 0) return null;
  const title = t({ id: 'repo.file.cochange', defaultMessage: 'Often changed together' });
  return (
    <section className="fh-sec" aria-label={title}>
      <SideHead title={title} />
      <div className="fh-list">
        {cochange.slice(0, 5).map((c) => (
          <button
            key={c.path}
            type="button"
            className="fh-lrow"
            title={c.path}
            onClick={() => openRepoView(projectId, { kind: 'file', path: c.path })}
          >
            <FileText className="ic-sm mu" aria-hidden="true" />
            <span className="mono fh-cut fh-grow">{c.path}</span>
            <span className="mu fh-num">
              {t(
                {
                  id: 'repo.file.together',
                  defaultMessage: '{count, plural, one {# time} other {# times}}',
                },
                { count: c.together },
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Recent({
  projectId,
  changes,
  now,
}: {
  projectId: string;
  changes: RepoFileHistory['changes'];
  now: number;
}) {
  const stories = useChangeStories(projectId);
  if (changes.length === 0) return null;
  const title = t({ id: 'repo.file.recent', defaultMessage: 'Recent changes' });
  return (
    <section className="fh-sec" aria-label={title}>
      <SideHead title={title} />
      <div className="fh-list">
        {changes.slice(0, 10).map((c) => (
          <button
            key={c.sha}
            type="button"
            className="fh-lrow"
            onClick={() => openRepoView(projectId, { kind: 'commit', sha: c.sha })}
          >
            <span className="mono mu">{shortSha(c.sha)}</span>
            <span className="fh-cut fh-grow">{c.subject}</span>
            {landedStory(stories.read, c.session_id) && (
              <span className="chip">
                {t({ id: 'repo.history.explained', defaultMessage: 'Explained' })}
              </span>
            )}
            <time className="mu fh-num" dateTime={new Date(c.committed_at).toISOString()}>
              {ageText(c.committed_at, now)}
            </time>
          </button>
        ))}
      </div>
    </section>
  );
}
