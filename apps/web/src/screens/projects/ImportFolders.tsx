import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { BridgeResult, ImportCandidate } from '@pantheon/protocol';
import { compareRuntimes, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { runCommand } from '../../data/commands';
import { ageText, useNow } from '../../data/needs-you';
import { openRejectText } from '../../data/projects';
import { t } from '../../i18n';
import './welcome.css';

// Labels are getters, so each is read in the language loaded by then.
export const EXCLUDED_TEXT: Record<NonNullable<ImportCandidate['excluded']>, string> = {
  get nested_project() {
    return t({
      id: 'projects.import.excluded.nestedProject',
      defaultMessage: 'Inside the folder of another project',
    });
  },
  get pantheon_data() {
    return t({
      id: 'projects.import.excluded.pantheonData',
      defaultMessage: "Pantheon's data folder",
    });
  },
  get temporary() {
    return t({ id: 'projects.import.excluded.temporary', defaultMessage: 'Temporary folder' });
  },
  get nested_repo() {
    return t({
      id: 'projects.import.excluded.nestedRepo',
      defaultMessage: 'Inside another repository',
    });
  },
  get missing() {
    return t({
      id: 'projects.import.excluded.missing',
      defaultMessage: "The folder doesn't exist",
    });
  },
};

export type FolderImport = ReturnType<typeof useFolderImport>;

/** Which found folders are checked, and opening folders as projects one at a time. */
export function useFolderImport(
  offered: readonly ImportCandidate[],
  /** The first project the import opened, once every folder opened. */
  onOpened: (projectId: string) => void,
  /** True while an import runs or its failures are shown. */
  onHold: (held: boolean) => void,
) {
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<{ root: string; name: string; text: string }[]>([]);
  const isChecked = (c: ImportCandidate) => toggled[c.root] ?? c.preselected;

  async function openFolders(folders: readonly { root: string; name: string }[]) {
    if (busy || folders.length === 0) return;
    setBusy(true);
    setFailures([]);
    onHold(true);
    const opened: { root: string; id: string }[] = [];
    const failed: typeof failures = [];
    // One at a time, so each open sees the projects the ones before it made.
    for (const c of folders) {
      const result = await runCommand(
        'project.open',
        { name: c.name, roots: [c.root] },
        null,
      ).catch((reason: unknown): BridgeResult<unknown> => ({
        ok: false,
        error: { code: 'ipc_failed', message: String(reason) },
      }));
      if (result.ok) opened.push({ root: c.root, id: (result.value as { id: string }).id });
      else
        failed.push({
          root: c.root,
          name: c.name,
          text: openRejectText(result.error.code, result.error.message),
        });
    }
    setBusy(false);
    setFailures(failed);
    setToggled((t) => ({ ...t, ...Object.fromEntries(opened.map((o) => [o.root, false])) }));
    onHold(failed.length > 0);
    if (failed.length === 0 && opened[0]) onOpened(opened[0].id);
  }

  return {
    busy,
    failures,
    isChecked,
    chosen: offered.filter(isChecked),
    toggle: (root: string, on: boolean) => setToggled((t) => ({ ...t, [root]: on })),
    openFolders,
  };
}

/** The cells of one found folder; `why` takes the place of its counts when it cannot be imported. */
export function candidateCells(
  c: ImportCandidate,
  picker: FolderImport,
  now: number,
  why?: string,
) {
  return (
    <>
      <input
        type="checkbox"
        value={c.root}
        checked={!c.excluded && picker.isChecked(c)}
        disabled={!!c.excluded || picker.busy}
        onChange={(e) => picker.toggle(c.root, e.target.checked)}
      />
      <b className="wel-nm">{c.name}</b>
      <span className="wel-path mono">{c.root}</span>
      <span
        className="wel-rts"
        aria-label={c.runtimes
          .map(runtimeName)
          .join(t({ id: 'projects.import.runtimeSeparator', defaultMessage: ', ' }))}
      >
        {[...c.runtimes].sort(compareRuntimes).map((r) => (
          <RuntimeGlyph key={r} runtime={r} />
        ))}
      </span>
      {why ? (
        <span className="wel-why">{why}</span>
      ) : (
        <>
          <span className="wel-n">
            {t(
              {
                id: 'projects.import.sessions',
                defaultMessage: '{count, plural, one {# session} other {# sessions}}',
              },
              { count: c.sessions },
            )}
          </span>
          <span className="wel-age">
            {c.last_active_at ? ageText(Date.parse(c.last_active_at), now) : '—'}
          </span>
        </>
      )}
    </>
  );
}

/** The folders that failed to open, each with why; nothing when none did. */
export function importFailures(picker: FolderImport) {
  if (picker.failures.length === 0) return null;
  return (
    <ul className="wel-err" role="alert">
      {picker.failures.map((f) => (
        <li key={f.root}>
          <b>{f.name}</b>
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Opens the checked folders; counts them. */
export function importButton(picker: FolderImport) {
  const off = picker.busy || picker.chosen.length === 0;
  return (
    <button
      type="button"
      className="btn pri"
      disabled={off}
      aria-disabled={off || undefined}
      onClick={() => void picker.openFolders(picker.chosen)}
    >
      {t(
        {
          id: 'projects.import.submit',
          defaultMessage: '{count, plural, one {Import # project} other {Import # projects}}',
        },
        { count: picker.chosen.length },
      )}
    </button>
  );
}

const noHold = () => {};

/** The folders other agents worked in that are no project yet, to check and open as projects. */
export function ImportDialog({
  open,
  candidates,
  onClose,
}: {
  open: boolean;
  candidates: readonly ImportCandidate[];
  onClose: () => void;
}) {
  const now = useNow(30_000);
  const offered = candidates
    .filter((c) => !c.excluded)
    .sort((a, b) => Number(b.preselected) - Number(a.preselected));
  const excluded = candidates.filter((c) => c.excluded);
  const picker = useFolderImport(offered, onClose, noHold);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" />
        <Dialog.Popup className="pj-dlg pop">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {t({ id: 'projects.import.title', defaultMessage: 'Import from other agents' })}
            </Dialog.Title>
          </div>
          <ul className="wel-list pj-imp-l">
            {offered.map((c) => (
              <li key={c.root}>
                <label className="wel-c">{candidateCells(c, picker, now)}</label>
              </li>
            ))}
            {excluded.map((c) => (
              <li key={c.root}>
                <div className="wel-c" data-off="">
                  {candidateCells(c, picker, now, EXCLUDED_TEXT[c.excluded!])}
                </div>
              </li>
            ))}
          </ul>
          {importFailures(picker)}
          <div className="pj-df">
            <Dialog.Close className="btn ghost">
              {t({ id: 'projects.cancel', defaultMessage: 'Cancel' })}
            </Dialog.Close>
            {importButton(picker)}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
