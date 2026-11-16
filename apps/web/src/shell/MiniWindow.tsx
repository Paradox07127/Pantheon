import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import type { PaletteItem } from '../components/palette';
import { SessionStateIcon, sessionStateLabel, StateGlyph } from '../components/SessionStateIcon';
import { useBoard } from '../data/board';
import { runCommand } from '../data/commands';
import { failureText, useNeedsYou, type NeedsYouItem } from '../data/needs-you';
import { visibleProjects } from '../data/projects';
import { sessionTitle } from '../data/transcript';
import { t } from '../i18n';
import { resolveTheme, useShell } from '../store';
import { runningSince, useProjectSessions, WAITING } from './TrayPopover';
import { readyAfterPaint } from './window-kind';
import './mini-window.css';

const NO_PROJECTS: readonly never[] = [];

/** The palette's switch of the mini window; shown says which way it switches. */
export function miniWindowPaletteItem(shown: boolean): PaletteItem {
  return {
    id: 'mini-window',
    group: 'action',
    label: shown
      ? t({ id: 'shell.miniWindow.hide', defaultMessage: 'Hide mini window' })
      : t({ id: 'shell.miniWindow.show', defaultMessage: 'Show mini window' }),
    run: () => void window.pantheon?.setMiniWindow(!shown).catch(() => {}),
  };
}

/** The mini window's palette item, read each time the palette opens; none outside the desktop app. */
export function useMiniWindowPaletteItems(open: boolean): PaletteItem[] {
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || !window.pantheon) return;
    let current = true;
    void window.pantheon.miniWindowShown().then(
      (result) => {
        if (current && result.ok) setShown(result.value);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [open]);
  return useMemo(() => (shown === null ? [] : [miniWindowPaletteItem(shown)]), [shown]);
}

/** The mini window: one bar above other windows with the request, or else the session, to watch. */
export function MiniWindow() {
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const theme = useShell((s) => s.theme);
  const needs = useNeedsYou(null);
  const projects = visibleProjects(board?.projects ?? NO_PROJECTS);
  const listed = useProjectSessions(projects.map((p) => p.id));
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [listedOnce, setListedOnce] = useState(false);
  if (!listedOnce && (needs.items || needs.error)) setListedOnce(true);
  useEffect(() => (listedOnce ? readyAfterPaint() : undefined), [listedOnce]);
  // A read without a request drops what the bar kept for it.
  useEffect(() => {
    if (!needs.items || needs.error !== null) return;
    const ids = new Set(needs.items.map((item) => item.source.id));
    setAnswered((all) =>
      [...all].every((id) => ids.has(id)) ? all : new Set([...all].filter((id) => ids.has(id))),
    );
    setFailures((all) =>
      Object.keys(all).every((id) => ids.has(id))
        ? all
        : Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))),
    );
  }, [needs.items, needs.error]);

  useEffect(() => {
    useBoard.getState().start();
    return () => useBoard.getState().stop();
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        resolveTheme(theme, query.matches) === 'dark',
      );
    apply();
    if (theme !== 'system') return;
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme]);

  async function answer(item: NeedsYouItem, decision: 'approve' | 'reject') {
    const id = item.source.id;
    if (busy.has(id)) return;
    setBusy((all) => new Set(all).add(id));
    setFailures(({ [id]: _, ...rest }) => rest);
    const result = await runCommand(
      'approval.respond',
      { approval_id: id, decision },
      item.source.revision,
    );
    setBusy((all) => {
      const next = new Set(all);
      next.delete(id);
      return next;
    });
    if (result.ok) setAnswered((all) => new Set(all).add(id));
    else setFailures((all) => ({ ...all, [id]: failureText(result.error) }));
  }

  const listedById = new Map(listed.map(({ session }) => [session.id, session]));
  const nameOf = (project_id: string, session_id?: string): string => {
    const session = session_id ? board?.sessions.find((s) => s.id === session_id) : undefined;
    if (session && board) return sessionTitle(session, board);
    const row = session_id ? listedById.get(session_id) : undefined;
    return row?.title || (board?.projects.find((p) => p.id === project_id)?.name ?? '');
  };
  const expand = (project_id?: string, session_id?: string) => {
    const opened = project_id
      ? window.pantheon?.showInMainWindow(session_id ? { project_id, session_id } : { project_id })
      : window.pantheon?.revealMain();
    void opened?.catch(() => {});
  };

  const waiting = (needs.items ?? []).filter(
    (item) => WAITING.includes(item.reason) && !answered.has(item.source.id),
  );
  const request = waiting
    .filter(
      (item) =>
        item.reason === 'permission_requested' &&
        !item.questions?.length &&
        item.actions.find((a) => a.command === 'approval.respond')?.allowed === true,
    )
    .reduce<NeedsYouItem | undefined>(
      (oldest, item) => (oldest && oldest.created_at <= item.created_at ? oldest : item),
      undefined,
    );
  const live = listed.filter(({ session }) => !session.archived_at);
  const activity = (session: WorkbenchSession) => Date.parse(session.last_activity_at);
  const running = live
    .filter(({ session }) => session.state === 'running')
    .map((row) => ({
      ...row,
      at: board
        ? (runningSince(row.session.id, board, events, row.session) ?? activity(row.session))
        : activity(row.session),
    }))
    .reduce<{ project_id: string; session: WorkbenchSession; at: number } | undefined>(
      (newest, row) => (newest && newest.at >= row.at ? newest : row),
      undefined,
    );
  const recent = live.reduce<{ project_id: string; session: WorkbenchSession } | undefined>(
    (newest, row) => (newest && activity(newest.session) >= activity(row.session) ? newest : row),
    undefined,
  );

  const expandButton = (project_id?: string, session_id?: string) => (
    <button
      type="button"
      className="ib mw-ex"
      aria-label={t({ id: 'shell.miniWindow.expand', defaultMessage: 'Open in main window' })}
      onClick={() => expand(project_id, session_id)}
    >
      <ExternalLink aria-hidden="true" />
    </button>
  );
  const count = waiting.length > 0 && (
    <>
      <span className="mw-sep" />
      <span
        className="mw-wait"
        role="img"
        aria-label={t(
          {
            id: 'shell.miniWindow.waiting',
            defaultMessage: '{count, plural, one {# waiting for you} other {# waiting for you}}',
          },
          { count: waiting.length },
        )}
      >
        <span className="mw-dot" />
        <span className="mw-n">{waiting.length}</span>
      </span>
    </>
  );
  const retry = needs.error !== null && (
    <button type="button" className="btn sm" onClick={needs.reload}>
      {t({ id: 'shell.miniWindow.retry', defaultMessage: 'Retry' })}
    </button>
  );
  const listFailed = needs.error !== null && (
    <>
      <span className="mw-err" role="alert">
        {needs.error}
      </span>
      {retry}
    </>
  );

  if (request) {
    const id = request.source.id;
    const off = needs.error !== null || busy.has(id);
    const what = request.binding?.input_summary ?? request.binding?.action;
    const error = failures[id] ?? needs.error;
    return (
      <div className="mw">
        <span className="mw-ic">
          <StateGlyph name="approval" />
        </span>
        <span className="mw-nm">{nameOf(request.project_id, request.session_id)}</span>
        {what && (
          <code className="mw-cmd" title={what}>
            {what}
          </code>
        )}
        {error && (
          <span className="mw-err" role="alert">
            {error}
          </span>
        )}
        {retry}
        <span className="mw-acts">
          <button
            type="button"
            className="btn sm pri"
            disabled={off}
            onClick={() => void answer(request, 'approve')}
          >
            {t({ id: 'shell.miniWindow.allow', defaultMessage: 'Allow' })}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={off}
            onClick={() => void answer(request, 'reject')}
          >
            {t({ id: 'shell.miniWindow.deny', defaultMessage: 'Deny' })}
          </button>
        </span>
        {expandButton(request.project_id, request.session_id)}
      </div>
    );
  }
  const shown = running ?? recent;
  if (shown)
    return (
      <div className="mw">
        <span className="mw-ic">
          <SessionStateIcon session={shown.session} place="list" />
        </span>
        <span className="mw-nm">{nameOf(shown.project_id, shown.session.id)}</span>
        {!running && <span className="mw-state">{sessionStateLabel(shown.session)}</span>}
        {listFailed}
        {count}
        {expandButton(shown.project_id, shown.session.id)}
      </div>
    );
  const project = projects[0];
  return (
    <div className="mw">
      <span className="mw-nm">{project?.name ?? ''}</span>
      {listFailed}
      {expandButton(project?.id)}
    </div>
  );
}
