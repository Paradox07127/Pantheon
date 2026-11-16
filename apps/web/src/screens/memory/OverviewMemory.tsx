import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Archive,
  Check,
  Circle,
  Clock,
  Eye,
  FilePen,
  RefreshCw,
  Undo2,
  Unlink,
  X,
} from 'lucide-react';
import type { MemoryItem, MemorySummary } from '@pantheon/domain';
import { command, USER_PRINCIPAL_ID, type BridgeResult } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { Skeleton } from '../../components/Skeleton';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useMemoryQuery } from '../../data/memory';
import {
  budgetRefusal,
  contextCounts,
  maintainMemory,
  useMemoryContext,
  useMemoryDrafts,
  useMemoryRecent,
  waitingSince,
  type BudgetRefusal,
  type ContextError,
  type MemoryContext,
  type MemoryDirectory,
  type MemoryRecentItem,
  type Waiting,
} from '../../data/memory-context';
import { useMemoryView } from '../../data/memory-view';
import { ageText, failureText } from '../../data/needs-you';
import { cachedQuery, storeQuery } from '../../data/query-cache';
import { useImprovements } from '../../data/workflow-policy';
import { shortId } from '../../data/format';
import { sessionTitle } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { useShell } from '../../store';
import {
  AgentContextDialog,
  experiencesText,
  KIND_LABEL,
  numberText,
  versionText,
} from './AgentContextDialog';
import { keyVersions } from './memory-versions';
import { NewMemoryDialog, saveMemory } from './NewMemoryDialog';
import { kindText, PendingCard } from './PendingCard';
import './agent-context.css';
import './memory-overview.css';

export interface PendingDraft {
  item: MemoryItem;
  /** Every record with the draft's key and task. */
  versions: MemoryItem[];
  /** The session that proposed the draft. */
  author?: { title: string; runtime: string };
  /** Confirming was refused because the sources changed after the draft was proposed. */
  rejected: boolean;
  /** Confirming was refused because the confirmed decisions would not fit the context budget. */
  overBudget?: BudgetRefusal;
  busy: boolean;
}

export interface OverviewMemoryData {
  directory: MemoryDirectory | null;
  context: MemoryContext | null;
  contextError: ContextError | null;
  /** Why the directory could not be read, while there is none to show. */
  directoryError: string | null;
  /** Why the recent changes could not be read, while there are none to show. */
  recentError: string | null;
  /** Why the drafts, their records or the experience candidates could not be read. */
  pendingError: string | null;
  recent: MemoryRecentItem[] | null;
  drafts: Waiting;
  candidates: Waiting;
  /** Runtime of each open session, by session id. */
  runtimes: Record<string, string>;
  /** Title of each open session as the board names it, by session id. */
  titles: Record<string, string>;
  /** The drafts whose records are read, one card each. */
  pending: PendingDraft[];
  now: number;
  /** A retry of the progress document is out. */
  maintaining?: boolean;
}

export interface OverviewMemoryActions {
  onPreview: () => void;
  onEntries: () => void;
  /** Opens the entries tab with `memoryId` selected, or with nothing selected. */
  onEntry: (memoryId: string | null) => void;
  onLearned: () => void;
  onSession: (sessionId: string) => void;
  onMaintain: () => void;
  onCommit: (item: MemoryItem) => void;
  onDiscard: (item: MemoryItem) => void;
  /** Opens the draft in the rewrite dialog. */
  onRewrite: (item: MemoryItem) => void;
  /** Reads again what failed to read. */
  onRetry: () => void;
}

type Tone = 'ok' | 'bad' | 'wait' | 'idle';

function Status({ tone }: { tone: Tone }) {
  return (
    <span className="acx-st" data-tone={tone} aria-hidden>
      {tone === 'ok' && <Check />}
      {tone === 'bad' && <X />}
    </span>
  );
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="acx-alert" role="alert">
      <Status tone="bad" />
      <span className="acx-err">{message}</span>
      <button type="button" className="btn sm" onClick={onRetry}>
        <RefreshCw aria-hidden />
        {t({ id: 'memory.agent.retry', defaultMessage: 'Retry' })}
      </button>
    </div>
  );
}

function clockText(at: number, now: number): string {
  const today = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(today
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { month: '2-digit', day: '2-digit' }),
  }).format(at);
}

const CHANGE = {
  proposed: {
    icon: <FilePen aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.proposed', defaultMessage: 'Proposed' });
    },
  },
  committed: {
    icon: <Check aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.committed', defaultMessage: 'Confirmed' });
    },
  },
  archived: {
    icon: <Archive aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.archived', defaultMessage: 'Archived' });
    },
  },
  restored: {
    icon: <Undo2 aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.restored', defaultMessage: 'Restored as draft' });
    },
  },
  retraction_undone: {
    icon: <Undo2 aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.retractionUndone', defaultMessage: 'Retraction undone' });
    },
  },
} satisfies Record<MemoryRecentItem['kind'], { icon: ReactNode; label: string }>;

const ARCHIVED = {
  superseded: {
    icon: <RefreshCw aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.superseded', defaultMessage: 'Superseded' });
    },
  },
  retracted: {
    icon: <X aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.retracted', defaultMessage: 'Retracted' });
    },
  },
  expired: {
    icon: <Clock aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.expired', defaultMessage: 'Expired' });
    },
  },
  stale: {
    icon: <Unlink aria-hidden />,
    get label() {
      return t({ id: 'memory.agent.change.stale', defaultMessage: 'Basis gone' });
    },
  },
} satisfies Record<NonNullable<MemoryRecentItem['reason']>, { icon: ReactNode; label: string }>;

/** An archive names its reason; a kind the daemon added after this build gets a plain word. */
const changeOf = (change: MemoryRecentItem): { icon: ReactNode; label: string } =>
  (change.kind === 'archived' && change.reason && ARCHIVED[change.reason]) ||
  (CHANGE as Record<string, { icon: ReactNode; label: string }>)[change.kind] || {
    icon: <Circle aria-hidden />,
    label: t({ id: 'memory.agent.change.other', defaultMessage: 'Other change' }),
  };

function Usage({
  directory,
  context,
  contextError,
  directoryError,
  onEntries,
  onRetry,
}: Pick<OverviewMemoryData, 'directory' | 'context' | 'contextError' | 'directoryError'> & {
  onEntries: () => void;
  onRetry: () => void;
}) {
  const limit = directory?.budget.limit_bytes ?? 0;
  if (contextError?.code === 'memory_budget_exceeded')
    return (
      <div className="acx-alert" role="alert">
        <Status tone="bad" />
        <span className="acx-err">
          {t(
            {
              id: 'memory.agent.over',
              defaultMessage:
                'Confirmed decisions exceed the {limit} byte budget, so agents get no memory this turn',
            },
            { limit: numberText(limit) },
          )}
        </span>
        <button type="button" className="btn sm" onClick={onEntries}>
          {t({ id: 'memory.agent.shorten', defaultMessage: 'Shorten decisions' })}
        </button>
      </div>
    );
  if (contextError)
    return (
      <div className="acx-alert" role="alert">
        <Status tone="bad" />
        <span className="acx-err">{contextError.message}</span>
      </div>
    );
  if (!directory && directoryError) return <Failed message={directoryError} onRetry={onRetry} />;
  if (!context || !directory)
    return (
      <div className="acx-use" aria-busy="true">
        <Skeleton style={{ width: 160, height: 20 }} />
        <Skeleton style={{ height: 8 }} />
      </div>
    );
  const counts = contextCounts(context);
  const percent = limit ? Math.round((context.bytes / limit) * 100) : 0;
  const used = numberText(context.bytes),
    budget = numberText(limit);
  const stat = (label: string, value: number, extra?: ReactNode) => (
    <div>
      <span className="cap">{label}</span>
      <span className="acx-line">
        <span className="acx-stat">{value}</span>
        {extra}
      </span>
    </div>
  );
  return (
    <>
      <div className="acx-use">
        <div className="acx-line">
          <span className="kpi">{used}</span>
          <span className="mu acx-num">
            {t(
              { id: 'memory.agent.budgetOf', defaultMessage: '/ {limit} bytes' },
              { limit: budget },
            )}
          </span>
          <span className="mu acx-num acx-end">{percent}%</span>
        </div>
        <div
          className="meter"
          role="img"
          aria-label={t(
            {
              id: 'memory.agent.meter',
              defaultMessage: '{used} bytes used of a {limit} byte budget, {percent}%',
            },
            { used, limit: budget, percent },
          )}
          style={{ '--v': `${Math.min(percent, 100)}%` } as CSSProperties}
        >
          <i />
        </div>
      </div>
      <div className="acx-stats">
        {stat(KIND_LABEL.decision, counts.decision)}
        {stat(KIND_LABEL.report, counts.report)}
        {stat(KIND_LABEL.note, counts.note)}
        {stat(
          experiencesText(),
          counts.experiences,
          <>
            <span className="acx-delta">
              {t(
                { id: 'memory.agent.active', defaultMessage: '{count} active' },
                { count: counts.active },
              )}
            </span>
            <span className="acx-delta">
              {t(
                { id: 'memory.agent.trial', defaultMessage: '{count} on trial' },
                { count: counts.trial },
              )}
            </span>
          </>,
        )}
        {stat(t({ id: 'memory.agent.omitted', defaultMessage: 'Left out' }), counts.omitted)}
      </div>
    </>
  );
}

function DocumentState({
  directory,
  now,
  maintaining,
  onMaintain,
}: {
  directory: MemoryDirectory;
  now: number;
  maintaining?: boolean;
  onMaintain: () => void;
}) {
  const label = (
    <span className="mu">
      {t({ id: 'memory.agent.document', defaultMessage: 'Progress document' })}
    </span>
  );
  // Jobs come newest first.
  const latest = directory.jobs[0];
  if (directory.document_ready) {
    const done = directory.jobs.find(
      (j) => j.signature === directory.signature && j.state === 'done',
    );
    return (
      <span className="acx-meta">
        {label}
        <span className="chip">
          <span className="acx-dot" data-tone="ok" />
          {t({ id: 'memory.agent.documentReady', defaultMessage: 'Updated' })}
        </span>
        {done?.completed_at && <span className="acx-num">{clockText(done.completed_at, now)}</span>}
      </span>
    );
  }
  if (latest?.state === 'failed')
    return (
      <span className="acx-meta" role="alert">
        {label}
        <Status tone="bad" />
        <span className="acx-err">
          {t(
            {
              id: 'memory.agent.documentFailed',
              defaultMessage:
                '{count, plural, one {Not written after # try: {error}} other {Not written after # tries: {error}}}',
            },
            { count: latest.attempts, error: latest.error ?? '' },
          )}
        </span>
        <button type="button" className="btn sm" disabled={maintaining} onClick={onMaintain}>
          <RefreshCw aria-hidden />
          {t({ id: 'memory.agent.retry', defaultMessage: 'Retry' })}
        </button>
      </span>
    );
  return null;
}

function Recent({ data, actions }: { data: OverviewMemoryData; actions: OverviewMemoryActions }) {
  const title = t({ id: 'memory.agent.recent', defaultMessage: 'Recent changes' });
  return (
    <section className="acx-cell" aria-label={title}>
      <div className="acx-h">
        <span className="acx-ht">{title}</span>
        <span className="acx-tail">
          {data.directory && (
            <DocumentState
              directory={data.directory}
              now={data.now}
              maintaining={data.maintaining}
              onMaintain={actions.onMaintain}
            />
          )}
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => actions.onEntry(data.recent?.[0]?.memory_id ?? null)}
          >
            {t({ id: 'memory.agent.history', defaultMessage: 'History' })}
          </button>
        </span>
      </div>
      <div
        className="acx-rows acx-chs"
        aria-busy={data.recent || data.recentError ? undefined : true}
      >
        {!data.recent && data.recentError ? (
          <Failed message={data.recentError} onRetry={actions.onRetry} />
        ) : data.recent?.length === 0 ? (
          <span className="acx-none">
            {t({ id: 'memory.agent.noRecent', defaultMessage: 'No changes yet' })}
          </span>
        ) : data.recent ? (
          data.recent.map((r) => (
            <button
              type="button"
              key={`${r.at}:${r.kind}:${r.memory_id}`}
              className="acx-ch"
              onClick={() => actions.onEntry(r.memory_id)}
            >
              <span className="mu acx-num">{clockText(r.at, data.now)}</span>
              {changeOf(r).icon}
              <span className="acx-lbl">{changeOf(r).label}</span>
              <span className={r.kind === 'archived' ? 'acx-cut mu' : 'acx-cut'}>{r.title}</span>
              <span className="chip">{kindText(r.memory_kind)}</span>
            </button>
          ))
        ) : (
          [0, 1, 2].map((i) => (
            <span key={i} className="acx-ch">
              <Skeleton />
              <Skeleton />
              <Skeleton style={{ width: 56 }} />
              <Skeleton />
            </span>
          ))
        )}
      </div>
    </section>
  );
}

function Pending({
  drafts,
  candidates,
  pending,
  pendingError,
  signature,
  now,
  actions,
}: Pick<OverviewMemoryData, 'drafts' | 'candidates' | 'pending' | 'pendingError' | 'now'> & {
  signature?: string;
  actions: OverviewMemoryActions;
}) {
  if (drafts.count === 0 && candidates.count === 0 && !pendingError) return null;
  const title = t({ id: 'memory.agent.pending', defaultMessage: 'Waiting for you' });
  const row = (label: string, waiting: Waiting, onClick: () => void) =>
    waiting.count > 0 && (
      <button type="button" className="acx-row" onClick={onClick}>
        <Status tone="wait" />
        <span>{label}</span>
        {waiting.oldest !== null && (
          <span className="mu acx-sm">
            {t(
              { id: 'memory.agent.oldest', defaultMessage: 'waiting {age}' },
              { age: ageText(waiting.oldest, now) },
            )}
          </span>
        )}
        <span className="acx-ct">{waiting.count}</span>
      </button>
    );
  return (
    <section className="acx-cell" aria-label={title}>
      <div className="acx-h">
        <span className="acx-ht">{title}</span>
      </div>
      <div className="acx-rows">
        {row(
          t({ id: 'memory.agent.drafts', defaultMessage: 'Memory drafts' }),
          drafts,
          actions.onEntries,
        )}
        {row(experiencesText(), candidates, actions.onLearned)}
      </div>
      {pendingError && <Failed message={pendingError} onRetry={actions.onRetry} />}
      {pending.length > 0 && (
        <div className="mo-pend">
          {pending.map(({ item, versions, author, rejected, overBudget, busy }) => (
            <PendingCard
              key={item.id}
              item={item}
              versions={versions}
              signature={signature}
              author={author}
              rejected={rejected}
              overBudget={overBudget}
              busy={busy}
              onCommit={() => actions.onCommit(item)}
              onDiscard={() => actions.onDiscard(item)}
              onOpen={() => actions.onEntry(item.id)}
              onRewrite={() => actions.onRewrite(item)}
              onOpenSession={() => actions.onSession(item.author_session_id!)}
              onRecord={actions.onEntry}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Delivery({
  directory,
  runtimes,
  titles,
  onSession,
}: {
  directory: MemoryDirectory | null;
  runtimes: Record<string, string>;
  titles: Record<string, string>;
  onSession: (id: string) => void;
}) {
  const title = t({ id: 'memory.agent.delivery', defaultMessage: 'Delivery' });
  const sessions = directory?.sessions ?? [];
  const groups = [
    {
      tone: 'ok' as const,
      label: t({ id: 'memory.agent.delivered', defaultMessage: 'Delivered' }),
      rows: sessions.filter((s) => s.delivered),
    },
    {
      tone: 'idle' as const,
      label: t({ id: 'memory.agent.nextTurn', defaultMessage: 'Next turn' }),
      rows: sessions.filter((s) => !s.delivered && s.memory_tool),
    },
    {
      tone: 'idle' as const,
      label: t({ id: 'memory.agent.noTool', defaultMessage: 'No memory tool' }),
      rows: sessions.filter((s) => !s.delivered && !s.memory_tool),
    },
  ].filter((g) => g.rows.length > 0);
  const name = (s: MemoryDirectory['sessions'][number]) =>
    s.title ||
    titles[s.id] ||
    t({ id: 'memory.agent.session', defaultMessage: 'Session {id}' }, { id: shortId(s.id) });
  return (
    <section className="acx-cell" aria-label={title}>
      <div className="acx-h">
        <span className="acx-ht">{title}</span>
        {directory && (
          <span className="acx-meta acx-num acx-end">
            {t(
              { id: 'memory.agent.deliveredOf', defaultMessage: '{delivered} / {total} delivered' },
              { delivered: sessions.filter((s) => s.delivered).length, total: sessions.length },
            )}
          </span>
        )}
      </div>
      <div className="acx-rows">
        {groups.map((g) => (
          <div key={g.label} className="acx-grp" role="group" aria-label={g.label}>
            <span className="acx-sh" aria-hidden="true">
              <Status tone={g.tone} />
              {g.label}
            </span>
            {g.rows.map((s) => (
              <button key={s.id} type="button" className="acx-row" onClick={() => onSession(s.id)}>
                <RuntimeGlyph runtime={runtimes[s.id] ?? ''} size={14} />
                <span className="acx-cut" title={name(s)}>
                  {name(s)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The memory panel of the overview: what agents get, recent changes, what waits, and delivery. */
export function OverviewMemoryView({
  data,
  actions,
}: {
  data: OverviewMemoryData;
  actions: OverviewMemoryActions;
}) {
  const title = t({ id: 'memory.agent.title', defaultMessage: 'What agents get now' });
  return (
    <div className="panel acx-panel">
      <div className="acx-col">
        <section className="acx-cell" aria-label={title}>
          <div className="acx-h">
            <span className="acx-ht">{title}</span>
            {data.directory && (
              <span className="acx-meta">
                <span>{versionText()}</span>
                <span className="acx-num">{data.directory.epoch}</span>
              </span>
            )}
            <button
              type="button"
              className="btn sm acx-end"
              disabled={!data.context}
              onClick={actions.onPreview}
            >
              <Eye aria-hidden />
              {t({ id: 'memory.agent.viewAll', defaultMessage: 'View full content' })}
            </button>
          </div>
          <Usage
            directory={data.directory}
            context={data.context}
            contextError={data.contextError}
            directoryError={data.directoryError}
            onEntries={() => actions.onEntry(null)}
            onRetry={actions.onRetry}
          />
        </section>
        <Recent data={data} actions={actions} />
      </div>
      <div className="acx-col">
        <Pending
          drafts={data.drafts}
          candidates={data.candidates}
          pending={data.pending}
          pendingError={data.pendingError}
          signature={data.directory?.signature}
          now={data.now}
          actions={actions}
        />
        <Delivery
          directory={data.directory}
          runtimes={data.runtimes}
          titles={data.titles}
          onSession={actions.onSession}
        />
      </div>
    </div>
  );
}

const oldest = (records: readonly { created_at: number }[]) =>
  records.length ? Math.min(...records.map((r) => r.created_at)) : null;

export async function readHistory(
  projectId: string,
  key: string,
): Promise<BridgeResult<{ items: MemoryItem[] }>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  return bridge
    .command(command(USER_PRINCIPAL_ID, 'memory.history', { project_id: projectId, key }))
    .then((result) => result as BridgeResult<{ items: MemoryItem[] }>)
    .catch((error: unknown) => ({
      ok: false as const,
      error: { code: 'ipc_failed', message: String(error) },
    }));
}

/**
 * The records of each draft's key, read again when memory moves; the last read stays meanwhile.
 * A key whose read fails keeps its last records, and the next read of the drafts reads it again.
 */
function useDraftHistories(
  projectId: string,
  drafts: readonly MemorySummary[] | null,
  epoch: number | undefined,
) {
  const keys = [...new Set((drafts ?? []).map((d) => d.key))].sort();
  const want = drafts
    ? JSON.stringify([projectId, epoch, drafts.map((d) => `${d.id}:${d.revision}`)])
    : null;
  type Read = { projectId: string; items: Record<string, MemoryItem[]>; error?: string };
  // The last read of this project stays on a new mount, so the panel draws on its first frame.
  const [read, setRead] = useState<Read | null>(
    () => (cachedQuery('memory.history', `drafts:${projectId}`)?.data ?? null) as Read | null,
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (want === null) return;
    let current = true;
    void Promise.all(
      keys.map(async (key) => [key, await readHistory(projectId, key)] as const),
    ).then((entries) => {
      if (!current) return;
      const failed = entries.find(([, result]) => !result.ok)?.[1];
      if (failed && !failed.ok) {
        setRead((last) => {
          const kept = last?.projectId === projectId ? last.items : {};
          const items = Object.fromEntries(
            entries.flatMap(([key, result]) =>
              result.ok ? [[key, result.value.items]] : key in kept ? [[key, kept[key]!]] : [],
            ),
          );
          return { projectId, items, error: failureText(failed.error) };
        });
        return;
      }
      const next = {
        projectId,
        items: Object.fromEntries(
          entries.map(([key, result]) => [key, result.ok ? result.value.items : []]),
        ),
      };
      setRead(next);
      storeQuery('memory.history', `drafts:${projectId}`, next, Date.now());
    });
    return () => {
      current = false;
    };
  }, [want, attempt]);
  const mine = read?.projectId === projectId ? read : null;
  useEffect(() => {
    if (mine?.error) setAttempt((n) => n + 1);
  }, [drafts]);
  return {
    items: mine?.items ?? {},
    error: mine?.error ?? null,
    loading: keys.length > 0 && mine === null,
    reload: () => setAttempt((n) => n + 1),
  };
}

export function OverviewMemory({
  projectId,
  onHold,
}: {
  projectId: string;
  /** Called with true while a first read of the panel is out, and false once all are in. */
  onHold: (held: boolean) => void;
}) {
  const directory = useMemoryQuery<MemoryDirectory>('memory.read', projectId, { limit: 1 });
  const read = useMemoryContext(projectId);
  // memory.context keeps no cache of its own; until this mount's read lands, show the last one.
  const last = read.loading
    ? ((cachedQuery('memory.context', projectId)?.data ?? null) as MemoryContext | null)
    : null;
  const context = { data: read.data ?? last, error: read.error, loading: read.loading && !last };
  useEffect(() => {
    if (read.data) storeQuery('memory.context', projectId, read.data, Date.now());
  }, [projectId, read.data]);
  const recent = useMemoryRecent(projectId);
  const drafts = useMemoryDrafts(projectId);
  const histories = useDraftHistories(
    projectId,
    drafts.data?.records ?? null,
    directory.data?.epoch,
  );
  const improvements = useImprovements(projectId);
  const candidates = waitingSince(improvements.read ?? []);
  const holding =
    directory.loading ||
    context.loading ||
    recent.loading ||
    drafts.loading ||
    histories.loading ||
    improvements.loading;
  // Before paint, so the page never shows a frame of this panel half read.
  useLayoutEffect(() => onHold(holding), [onHold, holding]);
  const board = useBoard((s) => s.board);
  const sessions = board?.sessions;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [maintaining, setMaintaining] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const [overBudget, setOverBudget] = useState<{ id: string; refusal: BudgetRefusal } | null>(null);
  const [rewriting, setRewriting] = useState<MemoryItem | null>(null);
  const runtimes = Object.fromEntries((sessions ?? []).map((s) => [s.id, s.runtime]));
  const titles = Object.fromEntries(
    (sessions ?? []).map((s) => [s.id, sessionTitle(s, board ?? {})]),
  );
  const shell = useShell.getState;
  const limit = directory.data?.budget.limit_bytes ?? 0;
  const pending = (drafts.data?.records ?? []).flatMap((draft): PendingDraft[] => {
    const records = histories.items[draft.key] ?? [];
    const item = records.find((r) => r.id === draft.id && r.state === 'draft');
    if (!item) return [];
    const session = item.author_session_id
      ? sessions?.find((s) => s.id === item.author_session_id)
      : undefined;
    return [
      {
        item,
        versions: keyVersions(item, records),
        author: session && { title: sessionTitle(session, board ?? {}), runtime: session.runtime },
        rejected: rejected === item.id,
        ...(overBudget?.id === item.id && { overBudget: overBudget.refusal }),
        busy: busy === item.id,
      },
    ];
  });
  const run = async (type: 'memory.commit' | 'memory.archive', item: MemoryItem) => {
    setBusy(item.id);
    const result = await runCommand(type, { memory_id: item.id }, item.revision);
    setBusy(null);
    if (result.ok) return;
    if (type === 'memory.commit' && result.error.code === 'memory_budget_exceeded') {
      setRejected(null);
      setOverBudget({ id: item.id, refusal: budgetRefusal(result.error) });
    } else if (type === 'memory.commit' && result.error.code === 'revision_conflict') {
      // A draft's revision moves only when it leaves draft state, so only a draft still at its
      // revision was refused for its sources; otherwise another window confirmed or discarded it.
      const fresh = await readHistory(projectId, item.key);
      const now = fresh.ok ? fresh.value.items.find((r) => r.id === item.id) : undefined;
      if (!fresh.ok) toast({ title: failureText(fresh.error), kind: 'failure' });
      else if (now?.state === 'draft' && now.revision === item.revision) {
        setOverBudget(null);
        setRejected(item.id);
      } else histories.reload();
    } else toast({ title: failureText(result.error), kind: 'failure' });
  };
  const maintain = async () => {
    setMaintaining(true);
    const result = await maintainMemory(projectId);
    setMaintaining(false);
    if (!result.ok) toast({ title: result.error, kind: 'failure' });
  };
  return (
    <>
      <OverviewMemoryView
        data={{
          directory: directory.data,
          context: context.data,
          contextError: context.error,
          directoryError: directory.data ? null : directory.error,
          recentError: recent.data ? null : recent.error,
          pendingError:
            (drafts.data ? null : drafts.error) ??
            (improvements.read ? null : improvements.error) ??
            histories.error,
          recent: recent.data?.items ?? null,
          drafts: {
            count: directory.data?.counts.draft ?? 0,
            oldest: oldest(drafts.data?.records ?? []),
          },
          candidates,
          runtimes,
          titles,
          pending,
          now: Date.now(),
          maintaining,
        }}
        actions={{
          onPreview: () => setOpen(true),
          onEntries: () => shell().setMemoryTab('entries'),
          onEntry: (id) => {
            useMemoryView.getState().select(id);
            shell().setMemoryTab('entries');
          },
          onLearned: () => shell().setMemoryTab('learned'),
          onSession: (id) => shell().openSession(id),
          onMaintain: () => {
            if (!maintaining) void maintain();
          },
          onCommit: (item) => void run('memory.commit', item),
          onDiscard: (item) => void run('memory.archive', item),
          onRewrite: setRewriting,
          onRetry: () => {
            directory.reload();
            read.reload();
            recent.reload();
            drafts.reload();
            improvements.reload();
            histories.reload();
          },
        }}
      />
      <AgentContextDialog open={open} onOpenChange={setOpen} context={context.data} limit={limit} />
      <NewMemoryDialog
        open={rewriting !== null}
        onOpenChange={(next) => {
          if (!next) setRewriting(null);
        }}
        projectId={projectId}
        original={rewriting}
        onSubmit={async (input, confirm) => {
          const outcome = await saveMemory(input, confirm);
          if (outcome.ok) {
            setRejected(null);
            setOverBudget(null);
          }
          return outcome;
        }}
      />
    </>
  );
}
