import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  FileText,
  GitMergeConflict,
  GitPullRequest,
  ImageIcon,
  Link,
  MessageSquare,
  MessagesSquare,
  RotateCw,
  X,
} from 'lucide-react';
import { create } from 'zustand';
import {
  type AttachmentMeta,
  type BridgeResult,
  type WindowSnapshotSource,
  type WorkbenchSession,
} from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { SessionStateIcon, sessionStateLabel } from '../../components/SessionStateIcon';
import { Skeleton } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import { listGithubItems, type GithubItem } from '../../data/code-refs';
import {
  EMPTY_DRAFT,
  githubRefKey,
  useDrafts,
  type Draft,
  type DraftAttachment,
  type GithubRef,
} from '../../data/drafts';
import { type FeedbackItem } from '../../data/feedback';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { sessionRow } from './model';
import './attachments.css';

const MAX_ATTACHMENTS = 10;
// Main refuses a bigger file with this error; checked first, the renderer never reads its bytes.
const MAX_BYTES = 20 * 1024 * 1024;
const TOO_LARGE = {
  code: 'invalid_input',
  message: 'bytes must be a Uint8Array of at most 20 MiB',
};
const tooMany = () =>
  t(
    {
      id: 'sessions.composer.tooManyAttachments',
      defaultMessage: 'Attach up to {max} files; the rest were not added',
    },
    { max: MAX_ATTACHMENTS },
  );
export const NO_BRIDGE = { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' };
export const ipcFailed = (reason: unknown): BridgeResult<never> => ({
  ok: false,
  error: { code: 'ipc_failed', message: String(reason) },
});

/** A pasted or dropped file that is uploading or whose upload failed. */
export interface PendingFile {
  id: string;
  file: File;
  state: 'uploading' | 'failed';
  error: string | null;
}

const NO_PENDING: readonly PendingFile[] = [];

/** The line count of each text pasted as a file. */
const pastedLines = new WeakMap<File, number>();

const PASTED_NAME = 'pasted-text';

/** The number of lines of a text; a final line break starts no line. */
export const lineCount = (text: string): number =>
  text.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).length;

/** Each draft's files not uploaded yet, by draft key; kept only while the window is open. */
const usePending = create<{ files: Readonly<Record<string, readonly PendingFile[]>> }>()(() => ({
  files: {},
}));

let pendingCount = 0;

/** Numbers each piece of attaching work as it begins, so a send knows which came before it. */
let begun = 0;
/** The number of the work that is uploading or failed each pending file, by pending id. */
const pendingAt = new Map<string, number>();
/** The number of this window's work that attached each file, by attachment id. */
const attachedAt = new Map<string, number>();
/** Window snapshots being taken, by draft key; each holds a place among the draft's files. */
const snapping = new Map<string, number>();
/** The file dialogs and window snapshots under way, by draft key; one that fails keeps why. */
const working = new Map<string, Set<{ failed: string | null }>>();

function beginWork(key: string) {
  const work = { failed: null as string | null };
  working.set(key, (working.get(key) ?? new Set()).add(work));
  return work;
}

function endWork(key: string, work: { failed: string | null }, failed: string | null) {
  work.failed = failed;
  const left = working.get(key)!;
  left.delete(work);
  if (!left.size) working.delete(key);
}

// A file sent or taken off its draft needs no place among the draft's files any more.
useDrafts.subscribe((s) => {
  if (!attachedAt.size) return;
  const kept = new Set(Object.values(s.drafts).flatMap((d) => d.attachments.map((a) => a.id)));
  for (const id of attachedAt.keys()) if (!kept.has(id)) attachedAt.delete(id);
});

const failedText = (name: string) =>
  t(
    { id: 'sessions.composer.attachmentFailed', defaultMessage: '{name}, upload failed' },
    { name },
  );

/**
 * Marks a message of the draft as sent now. Once its uploads are done, `failure` says why it cannot
 * go: a file of it failed to upload, or a file dialog or snapshot under way at the mark failed; `ids`
 * lists its files: those the draft held at the mark and those this window's work begun before the
 * mark attached since.
 */
export function markSend(key: string) {
  const mark = ++begun;
  const before = (at: number | undefined) => (at ?? 0) < mark;
  const held = new Set(
    (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).attachments.map((a) => a.id),
  );
  const waited = [...(working.get(key) ?? [])];
  return {
    failure: (): string | null => {
      const refused = waited.find((work) => work.failed !== null);
      if (refused) return refused.failed;
      const failed = (usePending.getState().files[key] ?? NO_PENDING).find(
        (p) => p.state === 'failed' && before(pendingAt.get(p.id)),
      );
      return failed ? failedText(failed.file.name) : null;
    },
    ids: (): string[] =>
      (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).attachments
        .filter((a) => held.has(a.id) || (attachedAt.has(a.id) && before(attachedAt.get(a.id))))
        .map((a) => a.id),
  };
}

/** Object URLs of the images the renderer holds the bytes of, by pending or attachment id. */
const thumbs = new Map<string, { key: string; url: string }>();

function changePending(key: string, change: (files: readonly PendingFile[]) => PendingFile[]) {
  usePending.setState((s) => ({
    files: { ...s.files, [key]: change(s.files[key] ?? NO_PENDING) },
  }));
}

function dropThumb(id: string) {
  const thumb = thumbs.get(id);
  if (!thumb) return;
  URL.revokeObjectURL(thumb.url);
  thumbs.delete(id);
}

/**
 * The files attached to the next message, kept in the draft under key so an upload that finishes
 * after the composer moved on still lands; a failed upload is retried on its own.
 */
export function useAttachments(project_id: string, key: string) {
  const { attachments: items } = useDrafts((s) => s.drafts[key]) ?? EMPTY_DRAFT;
  const pending = usePending((s) => s.files[key]) ?? NO_PENDING;
  const [error, setError] = useState<string | null>(null);
  const update = (change: (draft: Draft) => Partial<Draft>) =>
    useDrafts.getState().update(key, change);
  const pendingNow = () => usePending.getState().files[key] ?? NO_PENDING;
  const room = () => {
    const draft = useDrafts.getState().drafts[key] ?? EMPTY_DRAFT;
    const taken = draft.attachments.length + pendingNow().length + (snapping.get(key) ?? 0);
    return Math.max(MAX_ATTACHMENTS - taken, 0);
  };

  // A sent or removed image lets its thumbnail go.
  useEffect(() => {
    for (const [id, thumb] of thumbs)
      if (thumb.key === key && !items.some((a) => a.id === id) && !pending.some((p) => p.id === id))
        dropThumb(id);
  }, [items, pending]);

  // The dialog and a snapshot count as uploading, so a send waits for the files they bring.
  async function choose() {
    setError(null);
    const at = ++begun;
    const work = beginWork(key);
    update((draft) => ({ uploading: draft.uploading + 1 }));
    const bridge = window.pantheon;
    const result: BridgeResult<AttachmentMeta[]> = bridge
      ? await bridge.chooseFiles(project_id).catch(ipcFailed)
      : { ok: false as const, error: NO_BRIDGE };
    const failed = result.ok ? null : failureText(result.error);
    endWork(key, work, failed);
    // A refused file leaves the ones uploaded before it attached.
    const chosen = result.ok
      ? result.value
      : ((result.error.details?.attached as AttachmentMeta[] | undefined) ?? []);
    const kept = chosen.slice(0, room());
    if (failed) setError(failed);
    else if (kept.length < chosen.length) setError(tooMany());
    for (const a of kept) attachedAt.set(a.id, at);
    update((draft) => ({
      uploading: draft.uploading - 1,
      attachments: [...draft.attachments, ...kept],
    }));
  }

  /** Attaches a snapshot of the window of another app with this id. */
  async function snapshot(id: string) {
    setError(null);
    if (room() === 0) {
      setError(tooMany());
      return;
    }
    const at = ++begun;
    const work = beginWork(key);
    snapping.set(key, (snapping.get(key) ?? 0) + 1);
    update((draft) => ({ uploading: draft.uploading + 1 }));
    const bridge = window.pantheon;
    const result = bridge
      ? await bridge.snapshotWindow(project_id, id).catch(ipcFailed)
      : { ok: false as const, error: NO_BRIDGE };
    const left = snapping.get(key)! - 1;
    if (left) snapping.set(key, left);
    else snapping.delete(key);
    endWork(key, work, result.ok ? null : failureText(result.error));
    if (!result.ok) {
      update((draft) => ({ uploading: draft.uploading - 1 }));
      setError(failureText(result.error));
      return;
    }
    attachedAt.set(result.value.id, at);
    update((draft) => ({
      uploading: draft.uploading - 1,
      attachments: [...draft.attachments, result.value],
    }));
  }

  async function upload(file: File): Promise<BridgeResult<AttachmentMeta>> {
    const bridge = window.pantheon;
    if (!bridge) return { ok: false, error: NO_BRIDGE };
    if (file.size > MAX_BYTES) return { ok: false, error: TOO_LARGE };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await bridge.attachFile(project_id, file.name, file.type, bytes);
    } catch (reason) {
      return ipcFailed(reason);
    }
  }

  async function send(entry: PendingFile) {
    const result = await upload(entry.file);
    // Removed while it uploaded: remove released it, and the uploaded file is left out.
    if (!pendingNow().some((p) => p.id === entry.id)) return;
    update((draft) => ({ uploading: draft.uploading - 1 }));
    if (!result.ok) {
      const failed = failureText(result.error);
      changePending(key, (files) =>
        files.map((p) => (p.id === entry.id ? { ...p, state: 'failed', error: failed } : p)),
      );
      return;
    }
    const thumb = thumbs.get(entry.id);
    if (thumb) {
      thumbs.delete(entry.id);
      thumbs.set(result.value.id, thumb);
    }
    changePending(key, (files) => files.filter((p) => p.id !== entry.id));
    attachedAt.set(result.value.id, pendingAt.get(entry.id)!);
    pendingAt.delete(entry.id);
    const lines = pastedLines.get(entry.file);
    const added = lines === undefined ? result.value : { ...result.value, lines };
    update((draft) => ({ attachments: [...draft.attachments, added] }));
  }

  async function addFiles(files: File[]) {
    setError(null);
    const taken = files.slice(0, room());
    if (taken.length < files.length) setError(tooMany());
    const entries = taken.map((file): PendingFile => ({
      id: `upload-${++pendingCount}`,
      file,
      state: 'uploading',
      error: null,
    }));
    const at = ++begun;
    for (const entry of entries) pendingAt.set(entry.id, at);
    for (const entry of entries)
      if (entry.file.type.startsWith('image/'))
        thumbs.set(entry.id, { key, url: URL.createObjectURL(entry.file) });
    changePending(key, (now) => [...now, ...entries]);
    update((draft) => ({ uploading: draft.uploading + entries.length }));
    for (const entry of entries) if (pendingNow().some((p) => p.id === entry.id)) await send(entry);
  }

  /** Uploads the text as a file, numbered after the draft's other files of that name. */
  async function addText(text: string) {
    const draft = useDrafts.getState().drafts[key] ?? EMPTY_DRAFT;
    const names = [
      ...draft.attachments.map((a) => a.name),
      ...pendingNow().map((p) => p.file.name),
    ];
    const nameAt = (n: number) => (n === 1 ? `${PASTED_NAME}.txt` : `${PASTED_NAME}-${n}.txt`);
    let n = 1;
    while (names.includes(nameAt(n))) n++;
    const file = new File([text], nameAt(n), { type: 'text/plain' });
    pastedLines.set(file, lineCount(text));
    await addFiles([file]);
  }

  async function retry(id: string) {
    const entry = pendingNow().find((p) => p.id === id);
    if (entry?.state !== 'failed') return;
    const again: PendingFile = { ...entry, state: 'uploading', error: null };
    // It keeps its number, so a message sent before its first try still waits for it.
    changePending(key, (files) => files.map((p) => (p.id === id ? again : p)));
    update((draft) => ({ uploading: draft.uploading + 1 }));
    await send(again);
  }

  const remove = (id: string) => {
    if (pendingNow().find((p) => p.id === id)?.state === 'uploading')
      update((draft) => ({ uploading: draft.uploading - 1 }));
    dropThumb(id);
    pendingAt.delete(id);
    changePending(key, (files) => files.filter((p) => p.id !== id));
    update((draft) => ({ attachments: draft.attachments.filter((a) => a.id !== id) }));
  };

  return { items, pending, error, choose, snapshot, addFiles, addText, retry, remove };
}

type WindowList = BridgeResult<{
  permission: 'granted' | 'denied';
  windows: WindowSnapshotSource[];
}>;

/** The windows of other apps as thumbnails above the composer; picking one hands its id to onPick. */
export function WindowSnapshots({
  open,
  anchor,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string) => void;
}) {
  const [list, setList] = useState<WindowList | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setList(null);
    setSettingsError(null);
    const bridge = window.pantheon;
    void (
      bridge
        ? bridge.listWindowSnapshots().catch(ipcFailed)
        : Promise.resolve<WindowList>({ ok: false, error: NO_BRIDGE })
    ).then((result) => {
      if (live) setList(result);
    });
    return () => {
      live = false;
    };
  }, [open]);
  async function openSettings() {
    const bridge = window.pantheon;
    const result = bridge
      ? await bridge.openPrivacySettings('screen').catch(ipcFailed)
      : { ok: false as const, error: NO_BRIDGE };
    if (!result.ok) setSettingsError(failureText(result.error));
  }
  const title = t({ id: 'sessions.composer.windowSnapshots', defaultMessage: 'App windows' });
  return (
    <Popover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="top"
          align="start"
          sideOffset={6}
          style={{ zIndex: 40 }}
        >
          <Popover.Popup className="pop cp-wsp" aria-label={title}>
            {list === null ? (
              <div className="cp-wsg" aria-busy="true">
                {[0, 1, 2].map((n) => (
                  <Skeleton key={n} className="cp-wsk" />
                ))}
              </div>
            ) : !list.ok ? (
              <p className="cp-wsn" role="alert">
                {failureText(list.error)}
              </p>
            ) : list.value.permission === 'denied' ? (
              <div className="cp-wsa">
                <p className="cp-wsn">
                  {t({
                    id: 'sessions.composer.windowSnapshotDenied',
                    defaultMessage:
                      'Allow Pantheon to record the screen to capture other apps’ windows',
                  })}
                </p>
                <button type="button" className="btn" onClick={() => void openSettings()}>
                  {t({
                    id: 'sessions.composer.windowSnapshotSettings',
                    defaultMessage: 'Open System Settings',
                  })}
                </button>
                {settingsError && (
                  <p className="cp-wsn" role="alert">
                    {settingsError}
                  </p>
                )}
              </div>
            ) : list.value.windows.length === 0 ? (
              <p className="cp-wsn">
                {t({
                  id: 'sessions.composer.windowSnapshotNone',
                  defaultMessage: 'No windows of other apps',
                })}
              </p>
            ) : (
              <div className="cp-wsg">
                {list.value.windows.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    className="cp-wsw"
                    aria-label={w.name}
                    onClick={() => onPick(w.id)}
                  >
                    <img className="cp-wsi" src={w.thumbnail} alt="" draggable={false} />
                    <span className="cp-wsl">{w.name}</span>
                  </button>
                ))}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const FEEDBACK_KIND = {
  comment: {
    Icon: MessageSquare,
    color: 'var(--ac)',
    get label() {
      return t({ id: 'sessions.composer.feedbackComment', defaultMessage: 'Comment' });
    },
  },
  finding: {
    Icon: CircleAlert,
    color: 'var(--wait)',
    get label() {
      return t({ id: 'sessions.composer.feedbackFinding', defaultMessage: 'Review finding' });
    },
  },
  check: {
    Icon: CircleX,
    color: 'var(--bad)',
    get label() {
      return t({ id: 'sessions.composer.feedbackCheck', defaultMessage: 'Failed check' });
    },
  },
  conflict: {
    Icon: GitMergeConflict,
    color: 'var(--bad)',
    get label() {
      return t({ id: 'sessions.composer.feedbackConflict', defaultMessage: 'Merge conflict' });
    },
  },
} as const;

/** The file's type as its tile names it: the extension, else the subtype of its mime type. */
const typeTag = (name: string, mime: string): string =>
  (/\.(\w{1,6})$/.exec(name)?.[1] ?? mime.split('/')[1] ?? '').toUpperCase();

/** A 72×72 tile of a file: an image's thumbnail, else its type and name; pasted text by its lines. */
function AttachmentTile(props: {
  id: string;
  name: string;
  mime: string;
  /** The line count of pasted text, shown in place of the file name. */
  lines?: number | undefined;
  state: 'done' | 'uploading' | 'failed';
  error?: string | null;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const { lines, state } = props;
  const name =
    lines === undefined
      ? props.name
      : t(
          {
            id: 'sessions.composer.pastedTextName',
            defaultMessage: 'Pasted text, {count, plural, one {# line} other {# lines}}',
          },
          { count: lines },
        );
  const thumb = thumbs.get(props.id)?.url;
  const tag = typeTag(props.name, props.mime);
  const tile = (
    <div
      className="cp-att"
      role="listitem"
      tabIndex={0}
      data-bad={state === 'failed' || undefined}
      aria-label={
        state === 'uploading'
          ? t(
              { id: 'sessions.composer.attachmentUploading', defaultMessage: '{name}, uploading' },
              { name },
            )
          : state === 'failed'
            ? failedText(name)
            : name
      }
    >
      {thumb ? (
        <>
          <img className="cp-th" src={thumb} alt="" />
          {tag && <span className="cp-tag mono">{tag}</span>}
        </>
      ) : (
        <>
          <span className="cp-ft">
            {state === 'uploading' ? (
              <span className="sk cp-sk" aria-hidden="true" />
            ) : props.mime.startsWith('image/') ? (
              <ImageIcon className="ic-sm" aria-hidden="true" />
            ) : (
              <FileText className="ic-sm" aria-hidden="true" />
            )}
            {tag && <span className="mono">{tag}</span>}
          </span>
          {lines === undefined ? (
            <span className="cp-fn">{name}</span>
          ) : (
            <span className="cp-fn">
              {t({ id: 'sessions.composer.pastedText', defaultMessage: 'Pasted text' })}{' '}
              <span className="cp-fln">
                {t(
                  {
                    id: 'sessions.composer.pastedLines',
                    defaultMessage: '{count, plural, one {# line} other {# lines}}',
                  },
                  { count: lines },
                )}
              </span>
            </span>
          )}
        </>
      )}
      {state === 'failed' && (
        <button
          type="button"
          className="ib cp-retry"
          aria-label={t({ id: 'sessions.composer.retryUpload', defaultMessage: 'Retry upload' })}
          onClick={() => props.onRetry?.(props.id)}
        >
          <RotateCw aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="ib cp-x"
        aria-label={t(
          {
            id: 'sessions.composer.removeAttachment',
            defaultMessage: 'Remove attachment {name}',
          },
          { name },
        )}
        onClick={() => props.onRemove(props.id)}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
  return props.error ? <Tip content={props.error}>{tile}</Tip> : tile;
}

/** The most sessions one message refers to. */
export const MAX_REFS = 8;

/**
 * The add menu's submenu of sessions to refer to, each off once referred or at the limit; nothing
 * without sessions.
 */
export function sessionRefMenu(props: {
  sessions: readonly WorkbenchSession[];
  refs: readonly WorkbenchSession[];
  /** Whether the message refers to MAX_REFS sessions, pull requests and issues together. */
  full: boolean;
  onRefer: (session: WorkbenchSession) => void;
  finalFocus: RefObject<HTMLTextAreaElement | null>;
}): ReactNode {
  if (props.sessions.length === 0) return null;
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="cp-mi">
        <MessagesSquare className="cp-mic" aria-hidden="true" />
        <span className="cp-mil">
          {t({
            id: 'sessions.newWorkspace.referAnother',
            defaultMessage: 'Another session',
          })}
        </span>
        <ChevronRight className="cp-mic" aria-hidden="true" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="pop cp-am" finalFocus={props.finalFocus}>
            {props.sessions.map((s) => (
              <Menu.Item
                key={s.id}
                className="cp-mi"
                disabled={props.refs.some((r) => r.id === s.id) || props.full}
                onClick={() => props.onRefer(s)}
              >
                <span className="cr-gl" aria-hidden="true">
                  <SessionStateIcon session={s} place="list" />
                </span>
                <span className="cp-mil">{sessionRow(s).title}</span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

/** A referenced session: its runtime with its state, title, state, diff size and remove. */
export function sessionRefCard(s: WorkbenchSession, onRemove: (id: string) => void): ReactNode {
  const title = sessionRow(s).title;
  return (
    <div key={s.id} className="cr-card cr-ref" role="group" aria-label={title}>
      <span className="cr-av" aria-hidden="true">
        <RuntimeGlyph runtime={s.runtime} />
        <span className="cr-avs">
          <SessionStateIcon session={s} place="list" />
        </span>
      </span>
      <span className="cr-cdt">{title}</span>
      <span className="cr-rst">{sessionStateLabel(s)}</span>
      {s.changes && (
        <>
          <span className="cr-dif df-add" data-zero={s.changes.additions === 0 || undefined}>
            +{s.changes.additions}
          </span>
          <span className="cr-dif df-del" data-zero={s.changes.deletions === 0 || undefined}>
            −{s.changes.deletions}
          </span>
        </>
      )}
      <button
        type="button"
        className="ib cr-rx"
        aria-label={t(
          { id: 'sessions.newWorkspace.removeRef', defaultMessage: 'Remove {title}' },
          { title },
        )}
        onClick={() => onRemove(s.id)}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

const CHECKS = {
  passing: {
    Icon: CircleCheck,
    color: 'var(--ok)',
    get label() {
      return t({ id: 'sessions.composeRefs.checksPassing', defaultMessage: 'Checks passing' });
    },
  },
  failing: {
    Icon: CircleX,
    color: 'var(--bad)',
    get label() {
      return t({ id: 'sessions.composeRefs.checksFailing', defaultMessage: 'Checks failing' });
    },
  },
  pending: {
    Icon: Clock,
    color: 'var(--wait)',
    get label() {
      return t({ id: 'sessions.composeRefs.checksPending', defaultMessage: 'Checks running' });
    },
  },
} as const;

/** What a pull request's checks state is, in words. */
export const checksLabel = (checks: NonNullable<GithubRef['checks']>): string =>
  CHECKS[checks].label;

/** A pull request's checks: a shape per state, named for screen readers. */
function checksIcon(checks: NonNullable<GithubRef['checks']>): ReactNode {
  const { Icon, color, label } = CHECKS[checks];
  return <Icon style={{ color }} role="img" aria-label={label} />;
}

type ItemsRead =
  | { state: 'loading' }
  | { state: 'ready'; items: readonly GithubItem[] }
  | { state: 'failed'; error: string };

/**
 * The add menu's submenu of the project's open pull requests or issues, read when it opens; each
 * is off once referred or at the limit. A failed read says why and offers the connections page.
 */
export function GithubRefMenu(props: {
  kind: 'pr' | 'issue';
  project_id: string;
  refs: readonly GithubRef[];
  /** The message refers to as many things as it can. */
  full: boolean;
  onRefer: (ref: GithubRef) => void;
  onConnect: () => void;
  finalFocus: RefObject<HTMLTextAreaElement | null>;
}) {
  const { kind } = props;
  const [read, setRead] = useState<ItemsRead>({ state: 'loading' });
  function load(open: boolean) {
    if (!open) return;
    void listGithubItems(props.project_id, kind).then((result) =>
      setRead(
        result.ok
          ? { state: 'ready', items: result.value }
          : { state: 'failed', error: failureText(result.error) },
      ),
    );
  }
  const KindIcon = kind === 'pr' ? GitPullRequest : CircleDot;
  return (
    <Menu.SubmenuRoot onOpenChange={load}>
      <Menu.SubmenuTrigger className="cp-mi">
        <KindIcon className="cp-mic" aria-hidden="true" />
        <span className="cp-mil">
          {kind === 'pr'
            ? t({ id: 'sessions.composeRefs.pullRequest', defaultMessage: 'Pull request' })
            : t({ id: 'sessions.composeRefs.issue', defaultMessage: 'Issue' })}
        </span>
        <ChevronRight className="cp-mic" aria-hidden="true" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="pop cp-am" finalFocus={props.finalFocus}>
            {read.state === 'loading' ? (
              <div className="cp-mi" aria-busy="true">
                <Skeleton className="cp-ghs" />
              </div>
            ) : read.state === 'failed' ? (
              <>
                <div className="cp-ghe" role="alert">
                  {read.error}
                </div>
                <Menu.Item className="cp-mi" onClick={props.onConnect}>
                  <Link className="cp-mic" aria-hidden="true" />
                  <span className="cp-mil">
                    {t({ id: 'sessions.composeRefs.connect', defaultMessage: 'Connect' })}
                  </span>
                </Menu.Item>
              </>
            ) : read.items.length === 0 ? (
              <div className="cp-ghn">
                {t(
                  {
                    id: 'sessions.composeRefs.none',
                    defaultMessage:
                      '{kind, select, pr {No open pull requests} other {No open issues}}',
                  },
                  { kind },
                )}
              </div>
            ) : (
              read.items.map((item) => (
                <Menu.Item
                  key={item.number}
                  className="cp-mi"
                  title={item.title}
                  disabled={
                    props.full ||
                    props.refs.some((r) => githubRefKey(r) === githubRefKey({ kind, ...item }))
                  }
                  onClick={() =>
                    props.onRefer({
                      kind,
                      number: item.number,
                      title: item.title,
                      ...(item.checks ? { checks: item.checks } : {}),
                    })
                  }
                >
                  <span className="cp-ct mono">#{item.number}</span>
                  <span className="cp-mil">{item.title}</span>
                  {kind === 'pr' && item.checks && checksIcon(item.checks)}
                </Menu.Item>
              ))
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

/** A referenced pull request or issue: its kind, number, title, checks and remove. */
export function githubRefCard(ref: GithubRef, onRemove: (ref: GithubRef) => void): ReactNode {
  const KindIcon = ref.kind === 'pr' ? GitPullRequest : CircleDot;
  return (
    <div
      key={githubRefKey(ref)}
      className="cr-card cr-ref"
      role="group"
      aria-label={t(
        {
          id: 'sessions.composeRefs.card',
          defaultMessage: '{kind, select, pr {Pull request} other {Issue}} #{number} {title}',
        },
        { kind: ref.kind, number: ref.number, title: ref.title },
      )}
    >
      <span className="cr-av" aria-hidden="true">
        <KindIcon />
      </span>
      <span className="cr-rst mono">#{ref.number}</span>
      <span className="cr-cdt">{ref.title}</span>
      {ref.checks && checksIcon(ref.checks)}
      <button
        type="button"
        className="ib cr-rx"
        aria-label={t(
          { id: 'sessions.newWorkspace.removeRef', defaultMessage: 'Remove {title}' },
          { title: ref.title || `#${ref.number}` },
        )}
        onClick={() => onRemove(ref)}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * A card per referenced session, pull request and issue, a tile per attachment and pending file,
 * and a removable chip per feedback item and reference.
 */
export function AttachmentStrip(props: {
  items: readonly DraftAttachment[];
  pending: readonly PendingFile[];
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
  feedback?: readonly FeedbackItem[];
  onRemoveFeedback?: (id: string) => void;
  refs?: readonly WorkbenchSession[];
  onRemoveRef?: (id: string) => void;
  github?: readonly GithubRef[];
  onRemoveGithub?: (ref: GithubRef) => void;
}) {
  const references = (props.feedback ?? []).filter((item) => item.kind === 'reference');
  const feedback = (props.feedback ?? []).filter((item) => item.kind !== 'reference');
  const refs = props.refs ?? [];
  const github = props.github ?? [];
  const files = props.items.length + props.pending.length;
  if (
    files === 0 &&
    feedback.length === 0 &&
    references.length === 0 &&
    refs.length === 0 &&
    github.length === 0
  )
    return null;
  return (
    <>
      {refs.map((s) => sessionRefCard(s, (id) => props.onRemoveRef?.(id)))}
      {github.map((r) => githubRefCard(r, (ref) => props.onRemoveGithub?.(ref)))}
      {files > 0 && (
        <div
          className="ss-q"
          role="list"
          aria-label={t({ id: 'sessions.composer.attachments', defaultMessage: 'Attachments' })}
        >
          {props.items.map((a) => (
            <AttachmentTile
              key={a.id}
              id={a.id}
              name={a.name}
              mime={a.mime}
              lines={a.lines}
              state="done"
              onRemove={props.onRemove}
            />
          ))}
          {props.pending.map((p) => (
            <AttachmentTile
              key={p.id}
              id={p.id}
              name={p.file.name}
              mime={p.file.type}
              lines={pastedLines.get(p.file)}
              state={p.state}
              error={p.error}
              onRemove={props.onRemove}
              {...(props.onRetry ? { onRetry: props.onRetry } : {})}
            />
          ))}
        </div>
      )}
      {feedback.length > 0 && (
        <div className="ss-q">
          {feedback.map((item) => {
            const kind = FEEDBACK_KIND[item.kind as keyof typeof FEEDBACK_KIND];
            return (
              <span key={item.id} className="ss-qi">
                <span className="ss-qt" title={item.text}>
                  <kind.Icon
                    className="ic-sm"
                    style={{ color: kind.color }}
                    role="img"
                    aria-label={kind.label}
                  />{' '}
                  {item.label}
                </span>
                <button
                  type="button"
                  className="ss-qx"
                  aria-label={t(
                    {
                      id: 'sessions.composer.removeFeedback',
                      defaultMessage:
                        '{kind, select, comment {Remove comment {label}} finding {Remove review finding {label}} check {Remove failed check {label}} conflict {Remove merge conflict {label}} other {Remove {label}}}',
                    },
                    { kind: item.kind, label: item.label },
                  )}
                  onClick={() => props.onRemoveFeedback?.(item.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {references.length > 0 && (
        <div
          className="cp-refs"
          role="list"
          aria-label={t({ id: 'sessions.completion.references', defaultMessage: 'References' })}
        >
          {references.map((item) => (
            <span key={item.id} className="chip mono cp-ref" role="listitem" title={item.label}>
              <FileText aria-hidden="true" />
              <span className="cp-rft">{item.label}</span>
              <button
                type="button"
                className="cp-rx"
                aria-label={t(
                  {
                    id: 'sessions.completion.removeReference',
                    defaultMessage: 'Remove reference {path}',
                  },
                  { path: item.label },
                )}
                onClick={() => props.onRemoveFeedback?.(item.id)}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
