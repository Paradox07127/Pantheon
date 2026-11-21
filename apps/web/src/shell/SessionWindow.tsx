import { useEffect, useState } from 'react';
import { PanelLeft, Pin } from 'lucide-react';
import type { BridgeResult } from '@pantheon/protocol';
import { ProjectMonogram } from '../components/ProjectMonogram';
import { SessionStateIcon, sessionStateLabel } from '../components/SessionStateIcon';
import { Toasts } from '../components/Toast';
import { useBoard } from '../data/board';
import { useEventHistory } from '../data/logs';
import { failureText, useNeedsYou } from '../data/needs-you';
import { WATCH_CHANNEL, type WatchWord } from '../data/notice-tiers';
import { useSessionList } from '../data/workbench-sessions';
import { t } from '../i18n';
import { groupWorkbenchSessions, referableSessions, sessionRow } from '../screens/sessions/model';
import { parentLink } from '../screens/sessions/SessionHeader';
import { parentOf } from '../screens/sessions/session-groups';
import { Thread } from '../screens/sessions/Thread';
import { useShell } from '../store';
import { readyAfterPaint } from './window-kind';
import './shell-window.css';

const NO_PANELS: readonly never[] = [];
const nothing = () => {};
const noEvents = () => false;

/** A window of one session at a time: its bar, its conversation and its composer. */
export function SessionWindow({
  project_id,
  session_id: opened,
}: {
  project_id: string;
  session_id: string;
}) {
  // The session this window's back and forward are on; it opens on the one it was opened for.
  const session_id = useShell((s) => s.history[s.historyIndex]?.sessionId || opened);
  const board = useBoard((s) => s.board);
  const list = useSessionList(project_id);
  const needs = useNeedsYou(project_id);
  const [onTop, setOnTop] = useState(false);
  const [whole, setWhole] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Fills the history cache the thread starts from; the thread reads on by itself after that.
  const history = useEventHistory({
    key: whole ? null : session_id,
    project_id,
    after: 0,
    keep: noEvents,
  });
  if (
    !whole &&
    board &&
    (list.data || list.error) &&
    (needs.items || needs.error) &&
    (history.events || history.error)
  )
    setWhole(true);
  useEffect(() => (whole ? readyAfterPaint() : undefined), [whole]);
  // Tells the main window the session this one shows while it has focus, so it gives that no cards.
  useEffect(() => {
    const channel = new BroadcastChannel(WATCH_CHANNEL);
    const id = crypto.randomUUID();
    const tell = (front: boolean) =>
      channel.postMessage({
        window: id,
        session_id: front ? session_id : null,
      } satisfies WatchWord);
    const focus = () => tell(true);
    const blur = () => tell(false);
    tell(document.hasFocus());
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    window.addEventListener('pagehide', blur);
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pagehide', blur);
      blur();
      channel.close();
    };
  }, [session_id]);
  const project = board?.projects.find((p) => p.id === project_id);
  const listed = list.data?.find((s) => s.id === session_id) ?? null;
  const title = listed
    ? sessionRow(listed).title
    : (board?.sessions.find((s) => s.id === session_id)?.title ?? '');
  const parent = listed
    ? (list.data?.find((s) => s.id === parentOf(listed) && s.id !== listed.id) ?? null)
    : null;
  // Changes nothing until the desktop app answers; a refusal shows beside the buttons.
  const act = async (call: Promise<BridgeResult<null>> | undefined, done = nothing) => {
    setFailure(null);
    const result = await call;
    if (!result) return;
    if (result.ok) done();
    else setFailure(failureText(result.error));
  };
  const pin = () => {
    const next = !onTop;
    void act(window.pantheon?.setAlwaysOnTop(next), () => setOnTop(next));
  };
  if (!whole) return <div className="sw" aria-busy="true" />;
  return (
    <div className="sw">
      <header className="sw-bar">
        {project && (
          <span className="chip sw-chip">
            <ProjectMonogram id={project.id} name={project.name} />
            {project.name}
          </span>
        )}
        {parent && parentLink(parent)}
        <h1 className="sw-title">{title}</h1>
        {listed && (
          <span className="sw-state">
            <SessionStateIcon session={listed} place="header" />
            {sessionStateLabel(listed)}
          </span>
        )}
        <span className="sw-end">
          {failure && (
            <span className="sw-err" role="alert">
              {failure}
            </span>
          )}
          <button
            type="button"
            className="ib"
            aria-pressed={onTop}
            aria-label={t({ id: 'shell.sessionWindow.keepOnTop', defaultMessage: 'Keep on top' })}
            onClick={pin}
          >
            <Pin aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => void act(window.pantheon?.showInMainWindow({ project_id, session_id }))}
          >
            <PanelLeft aria-hidden="true" />
            {t({ id: 'shell.sessionWindow.showInMain', defaultMessage: 'Show in main window' })}
          </button>
        </span>
      </header>
      <main
        className="ss-convo sw-body"
        aria-label={t({ id: 'sessions.screen.conversation', defaultMessage: 'Conversation' })}
      >
        {board ? (
          <Thread
            key={session_id}
            board={board}
            sessionId={session_id}
            listed={listed}
            sessions={referableSessions(groupWorkbenchSessions(list.data ?? []))}
            needs={needs}
            parent={null}
            panels={NO_PANELS}
            onPanel={nothing}
            overview={false}
            onDiscarded={nothing}
            ownBar
          />
        ) : (
          <div className="ss-fill" aria-busy="true" />
        )}
      </main>
      <Toasts />
    </div>
  );
}
