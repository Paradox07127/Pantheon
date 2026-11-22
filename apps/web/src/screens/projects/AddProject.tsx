import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowUp, CircleAlert, Folder } from 'lucide-react';
import type { BoardSnapshot, BridgeResult, ImportCandidate } from '@pantheon/protocol';
import { ProjectMonogram } from '../../components/ProjectMonogram';
import { compareRuntimes, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useImportCandidates } from '../../data/import';
import { ageText, failureText, reasonText, useNow } from '../../data/needs-you';
import { nameFromPath, openRejectText } from '../../data/projects';
import { t } from '../../i18n';
import { useShortcut } from '../../lib/shortcuts';
import { scrimFlag } from '../../lib/root-flag';
import { Result } from './BaselineBlocks';
import { briefRequest } from './brief';
import { Button, useSend } from './parts';
import { useProjectsView } from './view';
import './project-setup.css';
import './add-project.css';

type Project = BoardSnapshot['projects'][number];
type Listing = {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; hidden: boolean }[];
};
type DirRead = { ok: true; listing: Listing } | { ok: false; missing: boolean; text: string };

interface Row {
  key: string;
  kind: 'up' | 'folder' | 'recent' | 'place';
  /** Absolute, or `~` for the home place. */
  path: string;
  /** What Tab writes into the field. */
  complete: string;
  name: string;
  project: Project | null;
  hidden?: boolean;
  /** Where the filter matched in the name. */
  match?: number;
  candidate?: ImportCandidate;
}

const BROWSE_DELAY_MS = 120;
const RECENT = 5;
const PLACES = 3;

// Stands for the path, which the error sets in mono.
const PATH_MARK = '\u0000';

const trimRoot = (root: string): string => (root === '/' ? root : root.replace(/[\\/]+$/, ''));
const slashed = (path: string): string => (path.endsWith('/') ? path : `${path}/`);
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';

/** The folder the field names and the filter on its folders; `~/work/pa` browses `~/work` for `pa`. */
export function parseFolderInput(
  input: string,
): { dir: string; prefix: string; filter: string } | null {
  if (input.trim() === '') return null;
  const at = input.lastIndexOf('/');
  if (at < 0)
    return input === '~'
      ? { dir: '~', prefix: '~/', filter: '' }
      : { dir: '~', prefix: '~/', filter: input };
  return {
    dir: input.slice(0, at) || '/',
    prefix: input.slice(0, at + 1),
    filter: input.slice(at + 1),
  };
}

async function browse(dir: string): Promise<DirRead> {
  const bridge = window.pantheon;
  if (!bridge) return { ok: false, missing: false, text: reasonText('bridge_unavailable') };
  const result = await bridge
    .browseDirectory(dir)
    .catch((reason: unknown): BridgeResult<Listing> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(reason) },
    }));
  if (result.ok) return { ok: true, listing: result.value };
  return {
    ok: false,
    missing: result.error.code === 'not_a_directory',
    text: failureText(result.error),
  };
}

interface AddProjectProps {
  projects: readonly Project[];
  /** The added project, or the one already at that folder. */
  onOpened: (project_id: string) => void;
}

/** ⌘O anywhere: type or pick a folder, open it as a project, then set its goal. */
export function AddProject({ projects, onOpened }: AddProjectProps) {
  const { opening: open, setOpening } = useProjectsView();
  const id = useId();
  const [input, setInput] = useState('');
  // A row key; null lets the first row that can be added stand in.
  const [active, setActive] = useState<string | null>(null);
  const [reads, setReads] = useState<Readonly<Record<string, DirRead>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; path: string } | null>(null);
  const candidates = useImportCandidates();
  const now = useNow(30_000);
  const popup = useRef<HTMLDivElement>(null);
  // Opened by a shortcut or a menu there may be no trigger, so focus goes back to what had it before.
  const before = useRef<HTMLElement | null>(null);
  // Each opening reads folders afresh and drops the answers of the one before.
  const opening = useRef(0);
  const requested = useRef(new Set<string>());
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    opening.current++;
    if (open) {
      before.current = (globalThis.document?.activeElement as HTMLElement | null) ?? null;
      requested.current = new Set();
      setInput('');
      setActive(null);
      setReads({});
      setBusy(false);
      setError(null);
      setCreated(null);
    }
  }

  useShortcut('open-project', () => setOpening(true));

  const read = (dir: string) => {
    if (requested.current.has(dir)) return;
    requested.current.add(dir);
    const mine = opening.current;
    void browse(dir).then((result) => {
      if (mine === opening.current) setReads((all) => ({ ...all, [dir]: result }));
    });
  };

  const live = projects.filter((p) => p.removed_at === undefined);
  const projectAt = (path: string) =>
    live.find((p) => p.roots.some((root) => trimRoot(root) === trimRoot(path))) ?? null;
  const home = reads['~']?.ok ? reads['~'].listing.path : null;
  const tilde = (path: string) =>
    home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

  const recent = (candidates.data?.candidates ?? [])
    .filter((c) => !c.excluded)
    .sort((a, b) => (b.last_active_at ?? '').localeCompare(a.last_active_at ?? ''))
    .slice(0, RECENT);
  const places = [
    ...new Set(recent.map((c) => parentOf(c.root)).filter((dir) => dir !== home)),
  ].slice(0, PLACES);
  places.push('~');
  const placeKey = places.join('\n');
  // The history read only repeats while indexing, so one that failed at start would stay empty.
  useEffect(() => {
    if (open) candidates.reload();
  }, [open]);
  useEffect(() => {
    if (open) places.forEach(read);
  }, [open, placeKey]);

  const parsed = parseFolderInput(input);
  const dir = parsed?.dir ?? null;
  useEffect(() => {
    if (!open || dir === null || requested.current.has(dir)) return;
    const timer = setTimeout(() => read(dir), BROWSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, dir]);

  const shown = dir === null ? undefined : reads[dir];
  const listing = shown?.ok ? shown.listing : null;
  const rows: Row[] = [];
  if (parsed === null) {
    for (const c of recent)
      rows.push({
        key: `recent:${c.root}`,
        kind: 'recent',
        path: c.root,
        complete: slashed(tilde(c.root)),
        name: c.name,
        project: projectAt(c.root),
        candidate: c,
      });
    for (const place of places)
      rows.push({
        key: `place:${place}`,
        kind: 'place',
        path: place,
        complete: slashed(place === '~' ? place : tilde(place)),
        name: place === '~' ? place : tilde(place),
        project: null,
      });
  } else if (listing) {
    const { filter, prefix } = parsed;
    if (filter === '' && listing.parent !== null)
      rows.push({
        key: `up:${listing.parent}`,
        kind: 'up',
        path: listing.parent,
        complete: slashed(tilde(listing.parent)),
        name: '..',
        project: null,
      });
    const lower = filter.toLowerCase();
    const entries = [...listing.entries].sort((a, b) => Number(a.hidden) - Number(b.hidden));
    const byPrefix = entries.filter((e) => e.name.toLowerCase().startsWith(lower));
    const found = (
      byPrefix.length > 0 ? byPrefix : entries.filter((e) => e.name.toLowerCase().includes(lower))
    ).map((e) => ({ e, at: e.name.toLowerCase().indexOf(lower) }));
    for (const { e, at } of found)
      rows.push({
        key: `folder:${e.path}`,
        kind: 'folder',
        path: e.path,
        complete: `${prefix}${e.name}/`,
        name: e.name,
        project: projectAt(e.path),
        hidden: e.hidden,
        match: filter === '' ? undefined : at,
      });
  }

  const pos = rows.findIndex((r) => r.key === active);
  const current = pos >= 0 ? pos : rows.findIndex((r) => r.kind !== 'up' && !r.project);
  const lit = rows[current];
  const ghost =
    lit?.kind === 'folder' && parsed && parsed.filter !== '' && lit.match === 0
      ? `${lit.name.slice(parsed.filter.length)}/`
      : '';
  const optionId = (i: number) => `${id}-${i}`;

  useEffect(() => {
    if (current >= 0)
      globalThis.document?.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  }, [current, lit?.key]);

  const enter = (project_id: string) => {
    if (!useProjectsView.getState().opening) return;
    opening.current++;
    setOpening(false);
    onOpened(project_id);
  };

  async function add(path: string) {
    if (busy) return;
    const existing = projectAt(path);
    if (existing) return enter(existing.id);
    const mine = opening.current;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'project.open',
      { name: nameFromPath(path), roots: [path] },
      null,
    ).catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(reason) },
    }));
    if (mine !== opening.current) return;
    setBusy(false);
    if (!result.ok) {
      setError(openRejectText(result.error.code, result.error.message));
      return;
    }
    const opened = result.value as Project;
    if (live.some((p) => p.id === opened.id)) return enter(opened.id);
    setCreated({ id: opened.id, path });
  }

  async function choose() {
    const bridge = window.pantheon;
    if (!bridge) {
      setError(reasonText('bridge_unavailable'));
      return;
    }
    const mine = opening.current;
    const result = await bridge
      .chooseDirectories()
      .catch((reason: unknown): BridgeResult<string[]> => ({
        ok: false,
        error: { code: 'ipc_failed', message: String(reason) },
      }));
    if (mine !== opening.current) return;
    if (!result.ok) setError(failureText(result.error));
    else if (result.value[0]) void add(result.value[0]);
  }

  const complete = (row: Row) => {
    setInput(row.complete);
    setActive(null);
    setError(null);
  };

  const pick = (row: Row) => {
    if (row.kind === 'up' || row.kind === 'place') complete(row);
    else if (!row.project) void add(row.path);
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return;
      e.preventDefault();
      const down = e.key === 'ArrowDown';
      const next =
        current < 0
          ? down
            ? 0
            : rows.length - 1
          : (current + (down ? 1 : rows.length - 1)) % rows.length;
      setActive(rows[next]!.key);
    } else if (e.key === 'Tab' && !e.shiftKey && lit) {
      e.preventDefault();
      complete(lit);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (lit) pick(lit);
      else if (listing && parsed?.filter === '') void add(listing.path);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (created === null && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void choose();
    } else if (created !== null && e.key === 'Enter') {
      e.preventDefault();
      popup.current
        ?.querySelector<HTMLButtonElement>(
          'button.btn.pri:not([disabled]):not([aria-disabled="true"])',
        )
        ?.click();
    }
  };

  const missing =
    shown && !shown.ok
      ? shown.missing
        ? t(
            { id: 'projects.add.notFolder', defaultMessage: '{path} is not a folder' },
            { path: PATH_MARK },
          ).split(PATH_MARK)
        : [shown.text]
      : null;
  const alert = error ? [error] : missing;

  const sessionsText = (c: ImportCandidate) =>
    t(
      {
        id: 'projects.import.sessions',
        defaultMessage: '{count, plural, one {# session} other {# sessions}}',
      },
      { count: c.sessions },
    );

  const row = (r: Row): ReactNode => {
    const i = rows.indexOf(r);
    const name =
      r.match === undefined ? (
        r.name
      ) : (
        <>
          {r.name.slice(0, r.match)}
          <span className="ap-m">
            {r.name.slice(r.match, r.match + (parsed?.filter.length ?? 0))}
          </span>
          {r.name.slice(r.match + (parsed?.filter.length ?? 0))}
        </>
      );
    const c = r.candidate;
    const count = r.kind === 'place' && reads[r.path]?.ok ? reads[r.path] : null;
    return (
      <div
        key={r.key}
        id={optionId(i)}
        role="option"
        className="ap-row"
        aria-selected={i === current}
        aria-disabled={r.project ? true : undefined}
        data-hl={i === current}
        data-hidden={r.hidden || undefined}
        onMouseMove={() => i !== current && setActive(r.key)}
        onClick={() => pick(r)}
      >
        <span className="ap-gl" aria-hidden="true">
          {r.kind === 'up' ? <ArrowUp className="ap-up" /> : <Folder />}
        </span>
        <span
          className={
            r.kind === 'up' ? 'ap-nm mono ap-up' : r.kind === 'place' ? 'ap-nm mono' : 'ap-nm'
          }
        >
          {name}
        </span>
        {c && <span className="ap-path mono">{tilde(c.root)}</span>}
        <span className="ap-end">
          {r.project ? (
            <>
              <span className="chip">
                <ProjectMonogram id={r.project.id} name={r.project.name} />
                {r.project.name}
              </span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={(e) => {
                  e.stopPropagation();
                  enter(r.project!.id);
                }}
              >
                {t({ id: 'projects.open.title', defaultMessage: 'Open project' })}
              </button>
            </>
          ) : (
            <>
              {c && (
                <>
                  <span
                    className="ap-rts"
                    role="img"
                    aria-label={c.runtimes
                      .map(runtimeName)
                      .join(t({ id: 'projects.import.runtimeSeparator', defaultMessage: ', ' }))}
                  >
                    {[...c.runtimes].sort(compareRuntimes).map((rt) => (
                      <RuntimeGlyph key={rt} runtime={rt} />
                    ))}
                  </span>
                  <span className="ap-meta">{sessionsText(c)}</span>
                  <span className="ap-meta ap-age">
                    {c.last_active_at ? ageText(Date.parse(c.last_active_at), now) : '—'}
                  </span>
                </>
              )}
              {count?.ok && (
                <span className="ap-meta">
                  {t(
                    {
                      id: 'projects.add.folderCount',
                      defaultMessage: '{count, plural, one {# folder} other {# folders}}',
                    },
                    { count: count.listing.entries.length },
                  )}
                </span>
              )}
              {r.kind !== 'up' && (
                <span className="ap-k" aria-hidden="true">
                  {r.kind !== 'recent' && <span className="kbd">Tab</span>}
                  {r.kind !== 'place' && <span className="kbd">↵</span>}
                </span>
              )}
            </>
          )}
        </span>
      </div>
    );
  };

  const group = (key: string, label: string, members: Row[]) =>
    members.length > 0 && (
      <div key={key} className="ap-grp" role="group" aria-labelledby={`${id}-${key}`}>
        <span id={`${id}-${key}`} role="presentation" className="ap-gh cap">
          {label}
        </span>
        {members.map(row)}
      </div>
    );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) opening.current++;
        setOpening(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="ap-scrim" ref={scrimFlag} />
        <Dialog.Popup
          ref={popup}
          className="ap"
          aria-label={t({ id: 'projects.add.title', defaultMessage: 'Add project' })}
          finalFocus={() => before.current ?? true}
          onKeyDown={onKeyDown}
        >
          {created === null ? (
            <>
              <div className="ap-in">
                <Folder className="ic-sm" aria-hidden="true" />
                <span className="ap-fld">
                  <input
                    role="combobox"
                    aria-label={t({
                      id: 'projects.add.path',
                      defaultMessage: 'Project folder path',
                    })}
                    aria-expanded={rows.length > 0}
                    aria-controls={id}
                    aria-autocomplete="list"
                    aria-activedescendant={current >= 0 ? optionId(current) : undefined}
                    aria-busy={busy || undefined}
                    placeholder={t({
                      id: 'projects.add.placeholder',
                      defaultMessage: '~/work/my-app',
                    })}
                    spellCheck={false}
                    autoComplete="off"
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      setActive(null);
                      setError(null);
                    }}
                    onKeyDown={onInputKey}
                  />
                  {ghost && (
                    <span className="ap-ghost" aria-hidden="true">
                      <span>{input}</span>
                      {ghost}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-keyshortcuts="Meta+Shift+O"
                  onClick={() => void choose()}
                >
                  {t({ id: 'projects.add.browse', defaultMessage: 'Browse…' })}
                </button>
              </div>
              {alert && (
                <div className="ap-err" role="alert">
                  <CircleAlert aria-hidden="true" />
                  {alert.length > 1 ? (
                    <>
                      {alert[0]?.trim() && <span>{alert[0].trim()}</span>}
                      <span className="mono">{dir === '/' ? dir : trimRoot(dir ?? '')}</span>
                      {alert[1]?.trim() && <span>{alert[1].trim()}</span>}
                    </>
                  ) : (
                    <span>{alert[0]}</span>
                  )}
                </div>
              )}
              <div
                id={id}
                role="listbox"
                className="ap-list"
                aria-label={t({ id: 'projects.folders.label', defaultMessage: 'Folders' })}
                aria-busy={(dir !== null && shown === undefined) || undefined}
              >
                {parsed === null
                  ? [
                      group(
                        'recent',
                        t({
                          id: 'projects.add.recent',
                          defaultMessage: 'Folders in your conversation history',
                        }),
                        rows.filter((r) => r.kind === 'recent'),
                      ),
                      group(
                        'places',
                        t({ id: 'projects.add.places', defaultMessage: 'Locations' }),
                        rows.filter((r) => r.kind === 'place'),
                      ),
                    ]
                  : rows.map(row)}
              </div>
              <div className="ap-foot">
                <span>
                  <kbd className="kbd">↑</kbd>
                  <kbd className="kbd">↓</kbd>
                  {t({ id: 'projects.add.footSelect', defaultMessage: 'Select' })}
                </span>
                <span>
                  <kbd className="kbd">Tab</kbd>
                  {t({ id: 'projects.add.footComplete', defaultMessage: 'Complete' })}
                </span>
                <span>
                  <kbd className="kbd">↵</kbd>
                  {t({ id: 'projects.add.footAdd', defaultMessage: 'Add' })}
                </span>
                <span className="ap-close">
                  <kbd className="kbd">esc</kbd>
                  {t({ id: 'projects.add.footClose', defaultMessage: 'Close' })}
                </span>
              </div>
            </>
          ) : (
            <Setup
              key={created.id}
              project_id={created.id}
              path={tilde(created.path)}
              onEnter={() => enter(created.id)}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The goal of the folder just added. */
export function Setup({
  project_id,
  path,
  onEnter,
}: {
  project_id: string;
  path: string;
  onEnter: () => void;
}) {
  const goal = useSend();
  // The folder may already carry a brief, or the restored project kept one.
  const brief = useBoard((s) => s.board?.project_briefs?.find((b) => b.project_id === project_id));
  const [edited, setText] = useState<string | null>(null);
  const text = edited ?? brief?.goal ?? '';

  const request = briefRequest(project_id, brief, {
    goal: text,
    goals: brief?.goals.join('\n') ?? '',
    non_goals: brief?.non_goals.join('\n') ?? '',
  });
  const kept = brief !== undefined && text.trim() === brief.goal;
  return (
    <>
      <div className="ap-steps">
        <span className="ap-at">
          <Folder aria-hidden="true" />
          <span className="mono">{path}</span>
        </span>
      </div>
      <div className="pj-stp">
        <label className="ev-goal">
          <span className="pj-lb">
            {t({ id: 'projects.open.step.goal', defaultMessage: 'Goal' })}
          </span>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <Result send={goal} />
      </div>
      <div className="pj-df">
        <span style={{ flex: 1 }} />
        <Button
          label={t({ id: 'projects.open.later', defaultMessage: 'Later' })}
          tone="ghost"
          onPress={onEnter}
        />
        <Button
          label={t({ id: 'projects.open.enter', defaultMessage: 'Enter project' })}
          tone="pri"
          busy={goal.busy}
          state={{ enabled: request.ok || kept, reason: null }}
          onPress={() => (kept ? onEnter() : void goal.send(request, onEnter))}
        />
      </div>
    </>
  );
}
