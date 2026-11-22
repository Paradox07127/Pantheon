import { useCallback, useEffect, useState } from 'react';
import type { MemoryDirectory, MemoryItem, MemorySummary } from '@pantheon/domain';
import {
  command,
  USER_PRINCIPAL_ID,
  type BridgeResult,
  type CommandType,
  type MemoryArchiveResult,
} from '@pantheon/protocol';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useMemoryQuery } from '../../data/memory';
import { budgetRefusal, maintainMemory, type BudgetRefusal } from '../../data/memory-context';
import { useMemoryView } from '../../data/memory-view';
import { failureText } from '../../data/needs-you';
import { STREAM_KINDS } from '../../data/sync';
import { sessionTitle } from '../../data/transcript';
import { readQuery, useFocusTick, useRefetchTick } from '../../data/workbench-sessions';
import { useShell } from '../../store';
import { EntriesBar, ENTRIES_SEARCH_ID, saveAndSelect, type EntriesFilters } from './EntriesBar';
import { EntriesFooter } from './EntriesFooter';
import { EntryActions, retractedToast } from './EntryActions';
import { EntryDetail, type EntryItem } from './EntryDetail';
import { EntryList } from './EntryList';
import { EntriesEmpty, EntriesError, EntriesLoading } from './EntryStates';
import { keyVersions } from './memory-versions';
import { NewMemoryDialog } from './NewMemoryDialog';
import { readHistory } from './OverviewMemory';
import { PendingCard } from './PendingCard';
import './entries-page.css';

const PAGE = 20;

type Read = 'memory.history' | 'memory.related';

const inTextField = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      !!el.isContentEditable)
  );
};

/** Keeps the last answer for the same key on screen while a fresh read of it is out. */
function useHeld<T>(key: string | null, data: T | null): T | null {
  const [held, setHeld] = useState<{ key: string | null; data: T | null }>({
    key: null,
    data: null,
  });
  useEffect(() => {
    if (data !== null) setHeld({ key, data });
  }, [key, data]);
  return data ?? (held.key === key ? held.data : null);
}

/** A user-only memory read sent as a command, read again when the project's events move. */
function useMemoryRead<T>(type: Read, projectId: string, input: Record<string, unknown> | null) {
  const sequence = useBoard(
    (s) =>
      s.events.findLast((e) => e.project_id === projectId && !STREAM_KINDS.has(e.kind))?.sequence ??
      0,
  );
  const tick = useRefetchTick(sequence, false) + useFocusTick();
  const [attempt, setAttempt] = useState(0);
  const key = input === null ? null : JSON.stringify({ project_id: projectId, ...input });
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
    key: null,
    data: null,
    error: null,
  });
  useEffect(() => {
    if (!key) return;
    let current = true;
    const bridge = window.pantheon;
    void (
      bridge
        ? bridge.command(command(USER_PRINCIPAL_ID, type, JSON.parse(key)))
        : Promise.resolve<BridgeResult<unknown>>({
            ok: false,
            error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
          })
    )
      .catch((error: unknown): BridgeResult<unknown> => ({
        ok: false,
        error: { code: 'ipc_failed', message: String(error) },
      }))
      .then((result) => {
        if (!current) return;
        setState(
          result.ok
            ? { key, data: result.value as T, error: null }
            : { key, data: null, error: failureText(result.error) },
        );
      });
    return () => {
      current = false;
    };
  }, [key, tick, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const mine = state.key === key;
  return { data: mine ? state.data : null, error: mine ? state.error : null, reload };
}

/** The entries tab: filters, the list, the selected entry's details and the bottom bar. */
export function EntriesPage({ projectId }: { projectId: string }) {
  const selectedId = useMemoryView((s) => s.selectedId);
  const query = useMemoryView((s) => s.query);
  const select = useMemoryView((s) => s.select);
  const shown = useShell((s) => s.screen === 'memory');
  const board = useBoard((s) => s.board);
  const [filters, setFilters] = useState<EntriesFilters>({ state: 'active', tag: [] });
  const params = {
    state: filters.state,
    kind: filters.kind,
    tag: filters.tag.length > 0 ? filters.tag : undefined,
    q: query.trim() || undefined,
    limit: PAGE,
  };
  const listKey = JSON.stringify(params);
  const first = useMemoryQuery<MemoryDirectory>('memory.read', projectId, params);
  const directory = useHeld(listKey, first.data);
  // Counts, facets, delivery and jobs do not depend on the filters, so the last read of any serves.
  const base = useHeld('directory', first.data);
  // Pages read after the first, for the filters in `key`, following the first page whose cursor is `from`.
  const [more, setMore] = useState<{
    key: string;
    from?: string;
    records: MemorySummary[];
    next?: string;
    loading: boolean;
    stale: boolean;
    error: string | null;
  }>({ key: listKey, records: [], loading: false, stale: false, error: null });
  // A first page read again with another cursor stamp no longer leads to the pages read after it.
  const pages = more.key === listKey && more.from === directory?.next_cursor ? more : null;
  const next = pages?.records.length ? pages.next : directory?.next_cursor;
  const seen = new Set<string>();
  const records = [...(directory?.records ?? []), ...(pages?.records ?? [])].filter(
    (r) => !seen.has(r.id) && !!seen.add(r.id),
  );

  const itemQuery = useMemoryQuery<EntryItem>(
    'memory.item',
    projectId,
    selectedId ? { memory_id: selectedId } : null,
  );
  // The entry shown before stays until the next one is read, so moving the selection does not blink.
  const item = useHeld(selectedId === null ? null : 'item', itemQuery.data);
  const history = useMemoryRead<{ items: MemoryItem[] }>(
    'memory.history',
    projectId,
    item ? { key: item.key } : null,
  );
  const related = (relation: 'dependency' | 'dependent') =>
    selectedId ? { memory_id: selectedId, state: 'all', relation, limit: 30 } : null;
  const dependencies = useMemoryRead<{ items: MemorySummary[] }>(
    'memory.related',
    projectId,
    related('dependency'),
  );
  const dependents = useMemoryRead<{ items: MemorySummary[] }>(
    'memory.related',
    projectId,
    related('dependent'),
  );
  const versions = item ? keyVersions(item, history.data?.items ?? []) : [];

  const [creating, setCreating] = useState(false);
  const [rewriting, setRewriting] = useState<MemoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [overBudget, setOverBudget] = useState<{ id: string; refusal: BudgetRefusal } | null>(null);
  useEffect(() => setFailure(null), [selectedId]);

  const reloadAll = () => {
    first.reload();
    itemQuery.reload();
    history.reload();
    dependencies.reload();
    dependents.reload();
  };
  const filter = (nextFilters: EntriesFilters) => {
    setFilters(nextFilters);
    select(null);
  };
  const loadMore = () => {
    if (!next || pages?.loading) return;
    const key = listKey;
    setMore({
      key,
      from: directory?.next_cursor,
      records: pages?.records ?? [],
      next,
      loading: true,
      stale: false,
      error: null,
    });
    const input: Record<string, string | string[]> = { project_id: projectId, cursor: next };
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) input[k] = Array.isArray(v) ? v : String(v);
    void readQuery('memory.read', input).then((result) => {
      setMore((m) => {
        if (m.key !== key) return m;
        if (result.ok) {
          const page = result.value as MemoryDirectory;
          return {
            ...m,
            records: [...m.records, ...page.records],
            next: page.next_cursor,
            loading: false,
          };
        }
        return result.error.code === 'revision_conflict'
          ? { ...m, loading: false, stale: true }
          : { ...m, loading: false, error: failureText(result.error) };
      });
    });
  };
  const firstPage = () => {
    setMore({ key: listKey, records: [], loading: false, stale: false, error: null });
    first.reload();
  };

  const run = async (
    type: CommandType,
    memoryId: string,
    revision: number,
    done?: (value: unknown) => void,
    key?: string,
  ) => {
    setBusy(true);
    setFailure(null);
    const result = await runCommand(type, { memory_id: memoryId }, revision);
    if (result.ok) done?.(result.value);
    else if (type === 'memory.commit' && result.error.code === 'memory_budget_exceeded') {
      setRejected(null);
      setOverBudget({ id: memoryId, refusal: budgetRefusal(result.error) });
    } else if (type === 'memory.commit' && result.error.code === 'revision_conflict' && key) {
      // A draft's revision moves only when it leaves draft state, so only a draft still at its
      // revision was refused for its sources; otherwise another window confirmed or discarded it.
      const fresh = await readHistory(projectId, key);
      const now = fresh.ok ? fresh.value.items.find((r) => r.id === memoryId) : undefined;
      if (!fresh.ok) setFailure(failureText(fresh.error));
      else if (now?.state === 'draft' && now.revision === revision) {
        setOverBudget(null);
        setRejected(memoryId);
      }
    } else setFailure(failureText(result.error));
    setBusy(false);
    reloadAll();
  };
  const restore = (memoryId: string, revision: number) =>
    void run('memory.restore', memoryId, revision, (value) => {
      const id = (value as { id?: string } | null)?.id;
      if (id) select(id);
    });

  const dialogOpen = creating || rewriting !== null;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      // The top bar's New memory dialog is not the page's own, so `dialogOpen` misses it.
      if (dialogOpen || inTextField(e.target)) return;
      if ((e.target as Element | null)?.closest?.('[role=dialog]')) return;
      const key = e.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        if (!records.length) return;
        e.preventDefault();
        const at = records.findIndex((r) => r.id === selectedId);
        const to =
          at < 0 ? 0 : Math.min(records.length - 1, Math.max(0, at + (key === 'j' ? 1 : -1)));
        select(records[to]!.id);
      } else if (key === '/') {
        e.preventDefault();
        document.getElementById(ENTRIES_SEARCH_ID)?.focus();
      } else if (key === 'n') {
        e.preventDefault();
        setCreating(true);
      } else if (key === 'escape' && selectedId) {
        e.preventDefault();
        select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, dialogOpen, records.map((r) => r.id).join('\n'), selectedId]);

  const sessions = board?.sessions ?? [];
  const authorSession = item?.author_session_id
    ? sessions.find((s) => s.id === item.author_session_id)
    : undefined;
  const author = authorSession && {
    title: sessionTitle(authorSession, board ?? {}),
    runtime: authorSession.runtime,
  };
  const empty =
    !!base && !query.trim() && base.counts.active + base.counts.draft + base.counts.archived === 0;
  const waiting = busy || itemQuery.loading || itemQuery.refreshing === true;

  let side = null;
  if (selectedId && item && !itemQuery.error) {
    const draft = item.state === 'draft';
    const footer =
      draft && (rejected === item.id || overBudget?.id === item.id) ? (
        <PendingCard
          item={item}
          versions={versions}
          signature={directory?.signature}
          author={author}
          rejected={rejected === item.id}
          {...(overBudget?.id === item.id && { overBudget: overBudget.refusal })}
          busy={waiting}
          onCommit={() => void run('memory.commit', item.id, item.revision, undefined, item.key)}
          onDiscard={() => void run('memory.archive', item.id, item.revision)}
          onOpen={() => setRejected(null)}
          onRewrite={() => setRewriting(item)}
          onOpenSession={() => useShell.getState().openSession(item.author_session_id!)}
          onRecord={select}
        />
      ) : (
        <EntryActions
          item={item}
          versions={versions}
          busy={waiting}
          onCommit={() => void run('memory.commit', item.id, item.revision, undefined, item.key)}
          onDiscard={() => void run('memory.archive', item.id, item.revision)}
          onRewrite={() => setRewriting(item)}
          onRetract={() =>
            void run('memory.archive', item.id, item.revision, (value) => {
              const archived = value as MemoryArchiveResult;
              retractedToast(
                item.title ?? item.key,
                archived.archived_ids.length - 1,
                () => void run('memory.undo_retraction', item.id, archived.revision),
              );
            })
          }
          onRestore={() => restore(item.id, item.revision)}
          onOpen={select}
        />
      );
    side = (
      <EntryDetail
        item={item}
        versions={versions}
        dependencies={dependencies.data?.items ?? []}
        dependents={dependents.data?.items ?? []}
        signature={directory?.signature}
        author={author}
        footer={
          <div className="mep-foot">
            {(failure || history.error || dependencies.error || dependents.error) && (
              <p className="mep-err" role="alert">
                {failure ?? history.error ?? dependencies.error ?? dependents.error}
              </p>
            )}
            {footer}
          </div>
        }
        onOpen={select}
        // The entry carries the tag, so it stays in the list and stays open.
        onTag={(tag) => setFilters({ ...filters, tag: [tag] })}
        onClose={() => select(null)}
      />
    );
  } else if (selectedId && itemQuery.error)
    side = (
      <aside className="mep-side">
        <p className="mep-err" role="alert">
          {itemQuery.error}
        </p>
      </aside>
    );

  return (
    <div className="mep" data-detail={side ? '' : undefined}>
      <section className="mep-main">
        {empty ? (
          <EntriesEmpty onCreate={() => setCreating(true)} />
        ) : (
          <>
            {base && (
              <EntriesBar
                filters={filters}
                counts={base.counts}
                facets={base.facets}
                total={directory?.total ?? null}
                onChange={filter}
              />
            )}
            {first.error ? (
              <EntriesError message={first.error} onRetry={first.reload} />
            ) : !directory ? (
              <EntriesLoading />
            ) : (
              <EntryList
                state={filters.state}
                records={records}
                query={query}
                total={directory.total}
                pageSize={PAGE}
                indexPending={directory.index_pending}
                selectedId={selectedId}
                onSelect={select}
                hasMore={!!next}
                loadingMore={!!pages?.loading}
                onLoadMore={loadMore}
                stale={!!pages?.stale}
                onFirstPage={firstPage}
                onRestore={(id) => {
                  const r = records.find((x) => x.id === id);
                  if (r) restore(r.id, r.revision);
                }}
                busy={busy}
                authorTitle={(id) => {
                  const session = sessions.find((s) => s.id === id);
                  return session && sessionTitle(session, board ?? {});
                }}
              />
            )}
            {pages?.error && (
              <p className="mep-err" role="alert">
                {pages.error}
              </p>
            )}
            {base && (
              <EntriesFooter
                directory={base}
                sessions={base.sessions.map((s) => ({
                  ...s,
                  runtime: sessions.find((x) => x.id === s.id)?.runtime,
                }))}
                onOpenSession={(id) => useShell.getState().openSession(id)}
                onOpenOverview={() => useShell.getState().setMemoryTab('overview')}
                onRetryDocument={() =>
                  void maintainMemory(projectId).then((result) => {
                    if (!result.ok) toast({ title: result.error, kind: 'failure' });
                    first.reload();
                  })
                }
              />
            )}
          </>
        )}
      </section>
      {side}
      <NewMemoryDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          setRewriting(null);
        }}
        projectId={projectId}
        original={rewriting}
        onSubmit={async (input, confirm, options) => {
          const outcome = await saveAndSelect(input, confirm, options);
          if (outcome.ok) {
            setRejected(null);
            setOverBudget(null);
          }
          reloadAll();
          return outcome;
        }}
      />
    </div>
  );
}
