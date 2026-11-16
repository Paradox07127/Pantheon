import { useEffect, useState } from 'react';
import { RefreshCw, SquarePen, SquareTerminal } from 'lucide-react';
import type { RuntimeStatus } from '@pantheon/protocol';
import { Equalizer } from '../../components/Equalizer';
import { compareRuntimes, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { KeyHint } from '../../components/Shortcuts';
import { TopBar } from '../../components/TopBar';
import { useNow } from '../../data/needs-you';
import { finishSetup, useSetupDone } from '../../data/personal-settings';
import {
  unavailableReason,
  useConnectionsStatus,
  useRuntimeStatus,
  versionNumber,
} from '../../data/runtime-status';
import { t } from '../../i18n';
import { shortcutKeys, useShortcut } from '../../lib/shortcuts';
import { useProjectsView } from '../projects/view';
import { GithubRow, ServiceRow } from '../settings/ConnectionsPage';
import { EditorPicker } from '../settings/EditorPicker';
import './setup.css';

/** The command that installs a runtime, for those that have one. */
const INSTALL: Readonly<Record<string, string>> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};

/** Whether the window shows first-time setup: the board is loaded, lists no project, and setup never finished. */
export function useShowsSetup(loaded: boolean, projectCount: number): boolean {
  const done = useSetupDone();
  // Someone who already has a project is past setup, even after removing every project.
  useEffect(() => {
    if (loaded && projectCount > 0 && !done) finishSetup();
  }, [loaded, projectCount, done]);
  return loaded && projectCount === 0 && !done;
}

/** The first page of a new install, with no sidebar: the runtimes, then where files and terminals open. */
export function SetupScreen() {
  const { read, refresh } = useRuntimeStatus();
  const github = useConnectionsStatus();
  // When the check that has not answered yet started; null once its read lands.
  const [since, setSince] = useState<number | null>(() => Date.now());
  // Every read that lands is a new object.
  useEffect(() => {
    if (read.state !== 'loading') setSince(null);
  }, [read]);
  const busy = since !== null;
  const statuses = read.state === 'ready' ? read.statuses : [];
  const installed = statuses.some((s) => s.installed);
  // As the runtimes page lists them: installed first, each part in the runtimes' order.
  const sorted = [...statuses].sort((a, b) => compareRuntimes(a.runtime, b.runtime));
  // A runtime that is not installed shows only when setup can name its install command.
  const listed =
    statuses.length > 0
      ? [
          ...sorted.filter((s) => s.installed),
          ...sorted.filter((s) => !s.installed && s.runtime in INSTALL),
        ].map((s) => s.runtime)
      : Object.keys(INSTALL);
  const blocked = busy || (read.state === 'ready' && !installed);

  const recheck = () => {
    if (busy) return;
    setSince(Date.now());
    refresh();
  };
  const open = () => {
    if (blocked) return;
    finishSetup();
    useProjectsView.getState().setOpening(true);
  };
  useShortcut('dialog-next', open, !blocked);

  const title = t({ id: 'setup.title', defaultMessage: 'First-time setup' });
  const openKeys = shortcutKeys('dialog-next');
  return (
    <div className="tb-pg">
      <TopBar title={title} />
      <main className="su-body">
        <div className="su-col">
          <div className="panel" aria-busy={busy}>
            <section className="cell su-grp" aria-labelledby="su-g-rt">
              <h3 className="cap su-gh" id="su-g-rt">
                {t({ id: 'setup.runtimes', defaultMessage: 'Runtimes' })}
              </h3>
              {!busy && read.state === 'failed' ? (
                <p className="su-err" role="alert">
                  {read.text}
                </p>
              ) : (
                listed.map((runtime) => (
                  <RuntimeRow
                    key={runtime}
                    runtime={runtime}
                    command={INSTALL[runtime]}
                    status={statuses.find((s) => s.runtime === runtime)}
                    since={since}
                  />
                ))
              )}
            </section>
            <section className="cell su-grp" aria-labelledby="su-g-cn">
              <h3 className="cap su-gh" id="su-g-cn">
                {t({ id: 'settings.pages.connections', defaultMessage: 'Connections' })}
              </h3>
              <GithubRow github={github} />
              <ServiceRow connections={github} service="huggingface" />
              <ServiceRow connections={github} service="cloudflare" />
            </section>
            <section className="cell su-grp" aria-labelledby="su-g-op">
              <h3 className="cap su-gh" id="su-g-op">
                {t({ id: 'setup.openWith', defaultMessage: 'Open with' })}
              </h3>
              <div className="su-row">
                <SquarePen className="su-ic" aria-hidden="true" />
                <span className="su-nm">
                  {t({ id: 'settings.editor.editor', defaultMessage: 'Editor' })}
                </span>
                <span />
                <EditorPicker
                  label={t({ id: 'settings.editor.editor', defaultMessage: 'Editor' })}
                  list="editors"
                  choose="chooseEditor"
                  unavailable="editor_unavailable"
                />
              </div>
              <div className="su-row">
                <SquareTerminal className="su-ic" aria-hidden="true" />
                <span className="su-nm">
                  {t({ id: 'settings.editor.terminal', defaultMessage: 'Terminal' })}
                </span>
                <span />
                <EditorPicker
                  label={t({ id: 'settings.editor.terminal', defaultMessage: 'Terminal' })}
                  list="terminals"
                  choose="chooseTerminal"
                  unavailable="terminal_unavailable"
                />
              </div>
            </section>
          </div>
          <div className="su-acts">
            <button
              type="button"
              className="btn"
              aria-disabled={busy || undefined}
              onClick={recheck}
            >
              <RefreshCw className="su-ic" aria-hidden="true" />
              {t({ id: 'setup.recheck', defaultMessage: 'Check again' })}
            </button>
            <button
              type="button"
              className="btn pri su-go"
              aria-keyshortcuts={openKeys || undefined}
              aria-disabled={blocked || undefined}
              onClick={open}
            >
              {t({ id: 'projects.open.title', defaultMessage: 'Open project' })}
              <KeyHint id="dialog-next" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** One runtime: checking with its seconds, usable with its plan and version, or what is missing. */
function RuntimeRow({
  runtime,
  command,
  status,
  since,
}: {
  runtime: string;
  command: string | undefined;
  status: RuntimeStatus | undefined;
  since: number | null;
}) {
  const head = (
    <>
      <RuntimeGlyph runtime={runtime} />
      <span className="su-nm">{runtimeName(runtime)}</span>
    </>
  );
  if (since !== null)
    return (
      <div className="su-row">
        {head}
        <span className="su-st">
          <span className="hp-st">
            <span className="su-run">
              <Equalizer />
            </span>
            <span>{t({ id: 'setup.checking', defaultMessage: 'Checking' })}</span>
          </span>
          <Elapsed since={since} />
        </span>
        <span />
      </div>
    );
  if (!status?.installed)
    return (
      <>
        <div className="su-row">
          {head}
          <span className="su-st">
            <span className="hp-st">
              <span className="hp-dot" data-s="idle" aria-hidden="true" />
              <span>
                {t(
                  { id: 'setup.notFound', defaultMessage: '{command} not found' },
                  { command: runtime },
                )}
              </span>
            </span>
          </span>
          <span />
        </div>
        {command !== undefined && (
          <div className="su-row su-sub">
            <span />
            <code className="su-cmd">{command}</code>
            <button
              type="button"
              className="btn ghost sm"
              aria-label={t(
                { id: 'setup.copyCommand', defaultMessage: 'Copy {command}' },
                { command },
              )}
              onClick={() => void navigator.clipboard.writeText(command)}
            >
              {t({ id: 'setup.copy', defaultMessage: 'Copy' })}
            </button>
          </div>
        )}
      </>
    );
  const why = unavailableReason(status);
  return (
    <div className="su-row">
      {head}
      <span className="su-st">
        <span className="hp-st">
          <span className="hp-dot" data-s={why === null ? 'ok' : 'bad'} aria-hidden="true" />
          <span>
            {why ??
              (status.auth.state === 'ok'
                ? t({ id: 'settings.runtimes.signedIn', defaultMessage: 'Signed in' })
                : t({ id: 'setup.installed', defaultMessage: 'Installed' }))}
          </span>
        </span>
        {why === null && status.auth.plan && <span className="su-via">{status.auth.plan}</span>}
      </span>
      <span className="mono su-val">{status.version && versionNumber(status.version)}</span>
    </div>
  );
}

/** Whole seconds since the check started, at least one. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <span className="su-via">
      {t(
        {
          id: 'setup.seconds',
          defaultMessage: '{count, plural, one {# second} other {# seconds}}',
        },
        { count: Math.max(1, Math.round((now - since) / 1000)) },
      )}
    </span>
  );
}
