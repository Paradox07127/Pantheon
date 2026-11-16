import { useState, type DragEvent } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight, Folder } from 'lucide-react';
import type {
  BridgeResult,
  DesktopBridge,
  ImportCandidate,
  RuntimeStatus,
} from '@pantheon/protocol';
import { compareRuntimes, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { Tip } from '../../components/Tip';
import { useImportCandidates } from '../../data/import';
import { failureText, useNow } from '../../data/needs-you';
import { nameFromPath } from '../../data/projects';
import { offeredRuntimes, unavailableReason, useRuntimeStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { keyText, shortcutKeys } from '../../lib/shortcuts';
import {
  candidateCells,
  EXCLUDED_TEXT,
  importButton,
  importFailures,
  useFolderImport,
} from './ImportFolders';
import './welcome.css';

const LOGINS = ['claude', 'codex'] as const;

const INSTALL_GUIDES: Readonly<Record<string, string>> = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'https://github.com/openai/codex',
};

interface WelcomeProps {
  onOpenFolder: () => void;
  /** The first project the import opened, once every checked folder opened. */
  onOpened: (projectId: string) => void;
  /** True while an import runs or its failures are shown. */
  onHold: (held: boolean) => void;
}

/** What the projects screen shows with no project: the runtimes and the folders found in their history. */
export function Welcome({ onOpenFolder, onOpened, onHold }: WelcomeProps) {
  const candidates = useImportCandidates();
  const now = useNow(30_000);

  const all = candidates.data?.candidates ?? [];
  const offered = all
    .filter((c) => !c.excluded)
    .sort((a, b) => Number(b.preselected) - Number(a.preselected));
  const excluded = all.filter((c) => c.excluded);
  const picker = useFolderImport(offered, onOpened, onHold);
  const [over, setOver] = useState(false);
  const indexing = candidates.data?.indexing ?? null;

  const takesFiles = (e: DragEvent) =>
    e.dataTransfer.types.includes('Files') && !!window.pantheon?.pathForFile;

  function dragOver(e: DragEvent) {
    if (!takesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
  }

  function drop(e: DragEvent) {
    setOver(false);
    if (!takesFiles(e)) return;
    e.preventDefault();
    const roots = Array.from(e.dataTransfer.files, (file) => window.pantheon!.pathForFile(file));
    void picker.openFolders(
      roots.filter(Boolean).map((root) => ({ root, name: nameFromPath(root) })),
    );
  }

  const row = (c: ImportCandidate) => candidateCells(c, picker, now);

  const openLabel = t({ id: 'projects.import.openFolder', defaultMessage: 'Open folder' });
  const openKeys = shortcutKeys('open-project');

  return (
    <div className="wel">
      <div className="wel-intro">
        <h2 className="wel-hd">
          {t({ id: 'projects.welcome.title', defaultMessage: 'Open a project' })}
        </h2>
        <p className="wel-sub">
          {t({
            id: 'welcome.intro',
            defaultMessage:
              'Pick a git repository. Each session makes its changes in its own worktree, and they merge only after the gates pass.',
          })}
        </p>
      </div>
      <button
        type="button"
        className="wel-drop"
        data-over={over ? '' : undefined}
        aria-label={openLabel}
        aria-keyshortcuts={openKeys || undefined}
        onClick={onOpenFolder}
        onDragOver={dragOver}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <Folder className="wel-drop-ic" aria-hidden="true" />
        <b>{t({ id: 'welcome.drop', defaultMessage: 'Drop a folder here' })}</b>
        {openKeys && (
          <span className="wel-keys">
            {t({ id: 'welcome.orPress', defaultMessage: 'or press' })}
            <kbd className="kbd">{keyText(openKeys)}</kbd>
          </span>
        )}
      </button>
      <section className="wel-cands" aria-labelledby="wel-found">
        {(!candidates.data || all.length > 0) && (
          <h3 className="wel-cap" id="wel-found">
            {t({
              id: 'projects.import.label',
              defaultMessage: 'Repositories found on this computer',
            })}
          </h3>
        )}
        {indexing && (
          <div
            className="wel-idx"
            role="progressbar"
            aria-label={t({ id: 'projects.import.indexing', defaultMessage: 'Indexing progress' })}
            aria-valuemin={0}
            aria-valuemax={indexing.total_files}
            aria-valuenow={indexing.done_files}
          >
            <i
              style={{
                transform: `scaleX(${indexing.total_files ? indexing.done_files / indexing.total_files : 0})`,
              }}
            />
          </div>
        )}
        {!candidates.data && candidates.error ? (
          <p className="wel-err" role="alert">
            {candidates.error}
          </p>
        ) : !candidates.data ? (
          <div className="sk wel-sk" aria-busy="true" />
        ) : (
          offered.length > 0 && (
            <ul className="wel-list">
              {offered.map((c) => (
                <li key={c.root}>
                  <label className="wel-c">{row(c)}</label>
                </li>
              ))}
            </ul>
          )
        )}
        {excluded.length > 0 && (
          <Collapsible.Root className="wel-other" defaultOpen={false}>
            <Collapsible.Trigger className="wel-tg">
              <ChevronRight className="wel-chev" aria-hidden="true" />
              {t({ id: 'projects.import.other', defaultMessage: 'Other' })}
              <span className="wel-cnt">{excluded.length}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel className="wel-fold">
              <ul className="wel-list">
                {excluded.map((c) => (
                  <li key={c.root}>
                    <Tip content={EXCLUDED_TEXT[c.excluded!]}>
                      <div className="wel-c" data-off="" tabIndex={0}>
                        {row(c)}
                      </div>
                    </Tip>
                  </li>
                ))}
              </ul>
            </Collapsible.Panel>
          </Collapsible.Root>
        )}
        {importFailures(picker)}
        {offered.length > 0 && <div className="wel-act">{importButton(picker)}</div>}
      </section>
      <RuntimeRows />
    </div>
  );
}

function RuntimeRows() {
  const { read, refresh } = useRuntimeStatus();
  const [actionError, setActionError] = useState<string | null>(null);

  async function viaBridge(call: (bridge: DesktopBridge) => Promise<BridgeResult<unknown>>) {
    setActionError(null);
    const bridge = window.pantheon;
    const result: BridgeResult<unknown> = bridge
      ? await call(bridge).catch((reason: unknown): BridgeResult<unknown> => ({
          ok: false,
          error: { code: 'ipc_failed', message: String(reason) },
        }))
      : { ok: false, error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' } };
    if (!result.ok) setActionError(failureText(result.error));
  }

  async function login(runtime: (typeof LOGINS)[number]) {
    await viaBridge((bridge) => bridge.runtimeLogin(runtime));
    refresh();
  }

  if (read.state === 'failed')
    return (
      <p className="wel-err" role="alert">
        {read.text}
      </p>
    );
  if (read.state === 'loading') return <div className="sk wel-sk" aria-busy="true" />;
  // A runtime with an install guide shows while it is missing, so the guide can be reached.
  const shown = offeredRuntimes(read, Object.keys(INSTALL_GUIDES));
  const statuses = read.statuses
    .filter((s) => shown.includes(s.runtime))
    .sort((a, b) => compareRuntimes(a.runtime, b.runtime));
  return (
    <section
      className="wel-rt-sec"
      aria-label={t({ id: 'projects.runtimes.label', defaultMessage: 'Runtimes' })}
    >
      <ul className="wel-rtg">
        {statuses.map((s) => (
          <li key={s.runtime} className="wel-rt">
            <span className="wel-rt-hd">
              <RuntimeGlyph runtime={s.runtime} />
              <b>{runtimeName(s.runtime)}</b>
              <i
                className="wel-dot"
                data-ok={unavailableReason(s) === null || undefined}
                aria-hidden="true"
              />
            </span>
            {runtimeState(s, login, (url) => void viaBridge((bridge) => bridge.openLink(url)))}
          </li>
        ))}
      </ul>
      {actionError && (
        <p className="wel-err" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}

/** Its version, then its account when usable, else why not; a logged-out runtime gets its login, a missing one its install guide. */
function runtimeState(
  status: RuntimeStatus,
  onLogin: (runtime: (typeof LOGINS)[number]) => void,
  onGuide: (url: string) => void,
) {
  const why = unavailableReason(status);
  const login =
    status.installed &&
    status.auth.state === 'logged_out' &&
    LOGINS.find((r) => r === status.runtime);
  const guide = !status.installed && INSTALL_GUIDES[status.runtime];
  return (
    <span className="wel-st">
      {status.version && <span className="mono">{status.version}</span>}
      {why === null ? (
        <>
          {status.auth.state === 'ok' && (
            <span>{t({ id: 'projects.runtimes.signedIn', defaultMessage: 'Signed in' })}</span>
          )}
          {status.auth.email && <span className="mono">{status.auth.email}</span>}
          {status.auth.plan && <span>{status.auth.plan}</span>}
        </>
      ) : (
        <span>{why}</span>
      )}
      {login && (
        <button type="button" className="btn" onClick={() => onLogin(login)}>
          {t({ id: 'projects.runtimes.login', defaultMessage: 'Sign in' })}
        </button>
      )}
      {guide && (
        <button type="button" className="btn sm" onClick={() => onGuide(guide)}>
          {t({ id: 'welcome.installGuide', defaultMessage: 'Install guide' })}
        </button>
      )}
    </span>
  );
}
