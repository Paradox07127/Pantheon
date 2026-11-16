import { useEffect, useState } from 'react';
import { Copy, Folder } from 'lucide-react';
import { PROTOCOL_VERSION, type AppInfo, type DaemonInfo } from '@pantheon/protocol';
import { useBoard } from '../../data/board';
import { readStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { revealText } from '../../lib/platform-text';
import { diagnosticsText } from './diagnostics';
import { ipcFailure } from './editors';
import './about-page.css';

/** The diagnostics as the desktop app and the daemon answer them now. */
export async function gatherDiagnostics(): Promise<string> {
  const bridge = window.pantheon;
  const quiet = <T,>(read: () => Promise<T>) =>
    bridge
      ? Promise.resolve()
          .then(read)
          .catch(() => undefined)
      : undefined;
  const [app, daemon, logs, runtimes] = await Promise.all([
    quiet(() => bridge!.appInfo()),
    quiet(() => bridge!.daemon()),
    quiet(() => bridge!.logsDir()),
    readStatus(false),
  ]);
  return diagnosticsText({
    app,
    daemon: daemon?.ok ? daemon.value : undefined,
    protocol: PROTOCOL_VERSION,
    logs_dir: logs,
    runtimes: runtimes.state === 'ready' ? runtimes.statuses : undefined,
  });
}

/** Copies the diagnostics; false when the clipboard refused. */
export async function copyDiagnostics(): Promise<boolean> {
  const text = await gatherDiagnostics();
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The versions, the folders on this computer and the diagnostics to copy. */
export function AboutPage() {
  const bridge = window.pantheon;
  const [app, setApp] = useState<AppInfo | null>(null);
  const [daemon, setDaemon] = useState<DaemonInfo | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const live = useBoard((s) => s.status.state === 'live');

  useEffect(() => {
    const bridge = window.pantheon;
    if (!bridge) return;
    void bridge.appInfo().then(setApp, () => {});
    void bridge
      .daemon()
      .catch(ipcFailure)
      .then((result) => result.ok && setDaemon(result.value));
    void bridge.logsDir().then(setLogs, () => {});
  }, []);

  const reveal = (path: string) => {
    setError(null);
    void window.pantheon
      ?.revealPath(path)
      .catch(ipcFailure)
      .then((result) => {
        if (!result.ok)
          setError(
            t(
              {
                id: 'settings.data.revealFailed',
                defaultMessage: 'Could not show the folder: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  };

  const folder = (
    id: string,
    label: string,
    path: string | null,
    action: string,
    shown: boolean,
  ) => (
    <div className="ps-row" data-setting-id={id}>
      <span className="ps-row-nm">
        {label}
        {path !== null && (
          <span className="ps-row-hint ab-path" title={path}>
            {path}
          </span>
        )}
      </span>
      <div className="ps-row-ct">
        {shown && (
          <button
            type="button"
            className="btn"
            disabled={path === null}
            onClick={() => path !== null && reveal(path)}
          >
            <Folder size={14} aria-hidden="true" />
            {action}
          </button>
        )}
      </div>
    </div>
  );

  const state = live
    ? { s: 'ok', text: t({ id: 'settings.about.running', defaultMessage: 'Running' }) }
    : {
        s: 'idle',
        text: t({ id: 'settings.about.notConnected', defaultMessage: 'Not connected' }),
      };

  return (
    <>
      <div className="panel ab-vers" data-setting-id="about.versions">
        {bridge && (
          <div className="cell">
            <span className="cap">{t({ id: 'settings.about.app', defaultMessage: 'App' })}</span>
            <span className="ab-ver">{app?.version ?? '—'}</span>
          </div>
        )}
        <div className="cell">
          <span className="cap">
            {t({ id: 'settings.about.daemon', defaultMessage: 'daemon' })}
          </span>
          <span className="ab-st">
            <span className="ab-ver">{daemon?.version ?? '—'}</span>
            <span className="hp-dot" data-s={state.s} role="img" aria-label={state.text} />
          </span>
        </div>
        <div className="cell">
          <span className="cap">
            {t({ id: 'settings.about.protocol', defaultMessage: 'Protocol' })}
          </span>
          <span className="ab-ver">{daemon?.protocol_version ?? PROTOCOL_VERSION}</span>
        </div>
      </div>
      <div className="ps-grp">
        <div className="ps-rows">
          {folder(
            'about.dataFolder',
            t({ id: 'settings.data.title', defaultMessage: 'Data folder' }),
            daemon?.data_dir ?? null,
            revealText(),
            bridge !== undefined,
          )}
          {bridge &&
            folder(
              'about.logs',
              t({ id: 'settings.about.logs', defaultMessage: 'Logs' }),
              logs,
              t({ id: 'settings.about.openLogs', defaultMessage: 'Open logs folder' }),
              true,
            )}
          <div className="ps-row" data-setting-id="about.diagnostics">
            <span className="ps-row-nm">
              {t({ id: 'settings.about.diagnostics', defaultMessage: 'Diagnostics' })}
            </span>
            <div className="ps-row-ct">
              <button
                type="button"
                className="btn"
                onClick={() => void copyDiagnostics().then(setCopied)}
                onPointerLeave={() => setCopied(null)}
                onBlur={() => setCopied(null)}
              >
                <Copy size={14} aria-hidden="true" />
                {copied === true
                  ? t({ id: 'settings.about.copied', defaultMessage: 'Copied' })
                  : copied === false
                    ? t({ id: 'settings.about.copyFailed', defaultMessage: "Couldn't copy" })
                    : t({
                        id: 'settings.about.copyDiagnostics',
                        defaultMessage: 'Copy diagnostics',
                      })}
              </button>
            </div>
          </div>
          {error !== null && (
            <div className="ps-err ab-err" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
