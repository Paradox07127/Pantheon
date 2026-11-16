import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { Bot, Copy, Folder, RefreshCw } from 'lucide-react';
import { StateGlyph, type GlyphName } from '../components/SessionStateIcon';
import { toast } from '../components/Toast';
import { askDebugAgent } from '../data/ask-debug';
import { useBoard } from '../data/board';
import { failureText } from '../data/needs-you';
import type { SyncStatus } from '../data/sync';
import { t } from '../i18n';
import { holdModifier } from '../lib/held-keys';
import { keyText, pressedKeys } from '../lib/shortcuts';
import './recover.css';

const RELOAD_KEYS = 'Meta+R';

/** The whole window's surface with one centred message on it. */
function RecoverPage({
  glyph,
  role,
  children,
}: {
  glyph: GlyphName;
  role: 'alert' | 'status';
  children: ReactNode;
}) {
  return (
    <div className="rc-page">
      <main className="rc-pane">
        <div className="rc" role={role}>
          <span className="rc-mark" aria-hidden="true">
            <StateGlyph name={glyph} />
          </span>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Shows the folder of the daemon log; only the desktop app has one. */
export function openLogs(): void {
  const bridge = window.pantheon;
  if (!bridge) return;
  void bridge
    .logsDir()
    .then((dir) => bridge.revealPath(dir))
    .then((result) => {
      if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
    })
    .catch(() => {});
}

const logsButton = () =>
  window.pantheon && (
    <button type="button" className="btn ghost" onClick={openLogs}>
      <Folder aria-hidden="true" />
      {t({ id: 'recover.logs', defaultMessage: 'Open logs' })}
    </button>
  );

/** What the crash page copies: the error's name and message, its stack and the component stack. */
const crashText = (error: Error, componentStack: string | null): string =>
  [String(error), error.stack, componentStack?.trim()].filter(Boolean).join('\n\n');

/** The page drawn in place of the interface after it threw while rendering. */
export function CrashScreen({
  error,
  componentStack,
}: {
  error: Error;
  componentStack: string | null;
}) {
  // The interface that held these watches is gone.
  useEffect(holdModifier, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (pressedKeys(e) !== RELOAD_KEYS) return;
      e.preventDefault();
      location.reload();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);
  return (
    <RecoverPage glyph="failed" role="alert">
      <span className="rc-t">
        {t({
          id: 'recover.crash.title',
          defaultMessage: 'The interface hit an error; reload to carry on',
        })}
      </span>
      <span className="rc-e">{String(error).split('\n')[0]}</span>
      <div className="rc-acts">
        <button type="button" className="btn pri" onClick={() => location.reload()}>
          <RefreshCw aria-hidden="true" />
          {t({ id: 'recover.crash.reload', defaultMessage: 'Reload' })}
          <span className="kbd hk">{keyText(RELOAD_KEYS)}</span>
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void navigator.clipboard?.writeText(crashText(error, componentStack))}
        >
          <Copy aria-hidden="true" />
          {t({ id: 'recover.crash.copy', defaultMessage: 'Copy error details' })}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() =>
            void askDebugAgent({
              title: String(error).split('\n')[0]!,
              detail: crashText(error, componentStack),
            })
          }
        >
          <Bot aria-hidden="true" />
          {t({ id: 'recover.crash.ask', defaultMessage: 'Ask agent' })}
        </button>
        {logsButton()}
      </div>
      <span className="rc-n">
        {t({
          id: 'recover.crash.drafts',
          defaultMessage: 'Unsent drafts are kept and will be back in their boxes after reloading',
        })}
      </span>
    </RecoverPage>
  );
}

/** The renderer crash the desktop app reloaded this page for, as an error with no name or stack. */
function rendererCrash(): Error | null {
  const crash = window.pantheon?.crashPage;
  if (!crash) return null;
  const error = new Error(
    t(
      {
        id: 'recover.crash.renderer',
        defaultMessage:
          'The interface process crashed twice within 10 seconds: {reason} (exit code {code})',
      },
      { reason: crash.reason, code: String(crash.exit_code) },
    ),
  );
  error.name = '';
  error.stack = undefined;
  return error;
}

/**
 * Draws the crash page in place of its children once they throw while rendering, or from the start
 * when the desktop app reloaded the page after repeated renderer crashes.
 */
export class RecoverBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; componentStack: string | null }
> {
  state: { error: Error | null; componentStack: string | null } = {
    error: rendererCrash(),
    componentStack: null,
  };
  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(_error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
  }
  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return <CrashScreen error={error} componentStack={componentStack} />;
  }
}

/** The page over the interface while the daemon cannot be reached; connecting counts the wait. */
export function DaemonDown({ status }: { status: SyncStatus }) {
  const retrying = status.state === 'connecting';
  const [reason, setReason] = useState(status.state === 'offline' ? status.reason : '');
  if (status.state === 'offline' && status.reason !== reason) setReason(status.reason);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  if (retrying && since === null) {
    const start = Date.now();
    setSince(start);
    setNow(start);
  }
  // Whether the desktop app is starting the daemon, rather than connecting to a running one.
  const [starting, setStarting] = useState(false);
  if (!retrying && since !== null) {
    setSince(null);
    setStarting(false);
  }
  useEffect(() => {
    if (!retrying) return;
    const check = () => void window.pantheon?.daemonStarting().then(setStarting, () => {});
    check();
    const timer = setInterval(() => {
      setNow(Date.now());
      check();
    }, 1000);
    return () => clearInterval(timer);
  }, [retrying]);
  const seconds = since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return (
    <RecoverPage glyph="idle" role={retrying ? 'status' : 'alert'}>
      <span className="rc-t">
        {t({
          id: 'recover.daemon.title',
          defaultMessage:
            'Cannot reach the daemon; sessions and changes are still on this computer',
        })}
      </span>
      {reason && <span className="rc-e">{reason}</span>}
      <div className="rc-acts">
        <button
          type="button"
          className="btn pri"
          disabled={retrying}
          onClick={() => useBoard.getState().reconnect()}
        >
          {retrying ? (
            <span className="rc-run" aria-hidden="true">
              <StateGlyph name="running" />
            </span>
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          {t({ id: 'recover.daemon.retry', defaultMessage: 'Retry' })}
        </button>
        {logsButton()}
      </div>
      {retrying && (
        <span className="rc-n rc-wait">
          {starting
            ? t(
                {
                  id: 'recover.daemon.starting',
                  defaultMessage:
                    'Starting the daemon, waited {seconds, plural, one {# second} other {# seconds}}',
                },
                { seconds },
              )
            : t(
                {
                  id: 'recover.daemon.waiting',
                  defaultMessage:
                    'Connecting to the daemon, waited {seconds, plural, one {# second} other {# seconds}}',
                },
                { seconds },
              )}
        </span>
      )}
    </RecoverPage>
  );
}

/**
 * Covers its children with the daemon page while no board has arrived and the daemon cannot be
 * reached; the children stay mounted underneath, since they run the connection.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const loaded = useBoard((s) => s.board !== null);
  const status = useBoard((s) => s.status);
  const [down, setDown] = useState(false);
  const shown = !loaded && (status.state === 'offline' || down);
  if (shown !== down) setDown(shown);
  return (
    <>
      <div className="rc-host" hidden={shown} inert={shown}>
        {children}
      </div>
      {shown && <DaemonDown status={status} />}
    </>
  );
}
