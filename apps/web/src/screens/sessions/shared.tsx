import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import { LoadError } from '../../components/LoadError';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import {
  AppWindow,
  ArchiveRestore,
  Check,
  CircleStop,
  Code,
  Columns2,
  Copy,
  ExternalLink,
  FileDown,
  FileText,
  FolderClosed,
  FolderOpen,
  GitCommitHorizontal,
  GitMerge,
  Hash,
  ListChecks,
  Mail,
  MailOpen,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Clock,
  SquareTerminal,
  Trash,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { BridgeResult, PopupMenuItem, WorkbenchSession } from '@pantheon/protocol';
import { MenuItem, MenuSeparator, SubMenu } from '../../components/Menu';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import type { FeedbackItem } from '../../data/feedback';
import { mergeEvents, readEventHistory } from '../../data/logs';
import { failureText } from '../../data/needs-you';
import type { DaemonEvent } from '../../data/sync';
import { buildTranscript, isSessionEvent, type Session } from '../../data/transcript';
import { useSessionPreflight } from '../../data/session-panel';
import { isUnread, markRead, markUnread, useSeenRecords } from '../../data/unread';
import { t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { scrimFlag } from '../../lib/root-flag';
import { useShell } from '../../store';
import { lineCount } from './attachments';
import { markdownFileName, sessionMarkdown } from './export-markdown';
import {
  endedText,
  isSessionApproval,
  liveGated,
  sessionMenu,
  sessionRow,
  type SessionMenuEntry,
  type SessionMenuItem,
} from './model';
import { blockedText, MergeDialog } from './panel';
import { DiscardDialog } from './parts';
import { shownTurns } from './trace';
import './row-menu.css';

export const fail = (reason: unknown): BridgeResult<unknown> => ({
  ok: false,
  error: { code: 'ipc_failed', message: String(reason) },
});

/** The newest session this screen created and opened; it may open before the list or board has it. */
export let createdHere: string | null = null;

export const setCreatedHere = (id: string) => {
  createdHere = id;
};

let splitRoom = true;
const splitRoomReaders = new Set<() => void>();

export const setSplitRoom = (room: boolean) => {
  if (room === splitRoom) return;
  splitRoom = room;
  for (const read of splitRoomReaders) read();
};

/** Calls `read` whenever the room for two sessions changes; returns the call that stops it. */
export const subscribeSplitRoom = (read: () => void) => {
  splitRoomReaders.add(read);
  return () => void splitRoomReaders.delete(read);
};

const splitRoomNow = () => splitRoom;

/** Whether the sessions screen, as last measured, has room for two sessions side by side. */
export const useSplitRoom = (): boolean =>
  useSyncExternalStore(subscribeSplitRoom, splitRoomNow, splitRoomNow);

export const noSplitRoom = () =>
  t({
    id: 'sessions.split.noRoom',
    defaultMessage: 'The window is too narrow for two sessions side by side',
  });

/** Why a read failed, with a button that reads it again; nothing while it has not failed. */
export function readFailed(read: { error: string | null; reload: () => void }) {
  return read.error && <LoadError message={read.error} onRetry={read.reload} />;
}

/** The session menu stays within the room its positioner leaves, scrolling the rest. */
export const FIT_MENU = { maxHeight: 'var(--available-height)', overflowY: 'auto' } as const;

/** A disabled menu entry carries its reason as a tooltip and, given `reasonId`, as its description. */
export function menuEntry(
  item: Pick<SessionMenuItem, 'label' | 'danger' | 'reason' | 'keys' | 'click'>,
  onClick: () => void,
  reasonId?: string,
  icon?: ReactNode,
) {
  const describedBy = item.reason ? reasonId : undefined;
  const disabled = item.reason !== undefined;
  // The shared item ends only in key caps; a modifier click ends in a key cap and a word.
  const entry = item.click ? (
    <Menu.Item
      key={item.label}
      className="mn-row"
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="mn-ic" aria-hidden="true">
        {icon}
      </span>
      <span className="mn-tx">{item.label}</span>
      <span className="mn-ct sm-click" aria-hidden="true">
        <kbd className="kbd">{keyText(item.click)}</kbd>
        {t({ id: 'sessions.rowMenu.click', defaultMessage: 'click' })}
      </span>
    </Menu.Item>
  ) : (
    <MenuItem
      key={item.label}
      icon={icon}
      keys={item.keys}
      danger={item.danger}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
    >
      {item.label}
    </MenuItem>
  );
  if (!item.reason) return entry;
  return [
    <Tip key={item.label} content={item.reason}>
      {entry}
    </Tip>,
    reasonId && (
      <span key={reasonId} id={reasonId} hidden>
        {item.reason}
      </span>
    ),
  ];
}

const ICONS: Record<SessionMenuItem['command'], LucideIcon> = {
  'session.open': MessageSquare,
  'session.open_window': ExternalLink,
  'session.open_beside': Columns2,
  'session.rename': Pencil,
  'session.pin': Pin,
  'session.snooze': Clock,
  'session.mark_read': MailOpen,
  'session.mark_unread': Mail,
  'session.interrupt': CircleStop,
  'session.gates.run': ListChecks,
  'session.merge': GitMerge,
  'open.editor': Code,
  'open.terminal': SquareTerminal,
  'open.finder': FolderOpen,
  copy: Copy,
  'session.copy_markdown': FileText,
  'session.export_markdown': FileDown,
  'session.archive': Check,
  'session.unarchive': ArchiveRestore,
  'session.discard': X,
  'session.delete': Trash,
};

// In the order sessionMenu lists the copy items: the path, the session id, the base commit.
const COPY_ICONS: readonly LucideIcon[] = [FolderClosed, Hash, GitCommitHorizontal];

function iconOf(item: SessionMenuItem, Icon: LucideIcon = ICONS[item.command]) {
  const Shown = item.command === 'session.pin' && item.input.pinned === false ? PinOff : Icon;
  return <Shown aria-hidden="true" />;
}

/** What discarding the session removes: a baseline whose process is gone, or a live linked worktree; null when neither. */
export function discardKind(
  session: Session | null,
  listed: WorkbenchSession | null,
): 'baseline' | 'worktree' | 'folder' | null {
  if (
    session?.baseline &&
    !session.outcome &&
    session.merge?.state !== 'running' &&
    !['running', 'reconciling'].includes(session.state) &&
    !session.stop_pending &&
    !session.process_identity
  )
    return 'baseline';
  if (!listed?.workspace_id || endedText(listed)) return null;
  if (listed.workspace_kind !== 'in_place') return 'worktree';
  return listed.lands ? 'folder' : null;
}

export const baselineDiscard = () =>
  t({
    id: 'sessions.screen.baselineDiscard',
    defaultMessage:
      "Deletes this baseline session's record and its worktree, if any, and keeps the baseline results. This can't be undone.",
  });

export const folderDiscard = () =>
  t({
    id: 'sessions.screen.folderDiscard',
    defaultMessage: 'Closes the session. Its files stay in the project folder.',
  });

/** What the discard confirmation says beyond the default, by discardKind. */
export const discardDescription = (kind: ReturnType<typeof discardKind>) =>
  kind === 'baseline'
    ? { description: baselineDiscard() }
    : kind === 'folder'
      ? { description: folderDiscard() }
      : {};

const done = (): BridgeResult<null> => ({ ok: true, value: null });

/** Opens the worktree in another app, or copies the item's text. */
async function sessionAction(
  command: 'open.editor' | 'open.terminal' | 'open.finder' | 'copy',
  input: Record<string, unknown>,
): Promise<BridgeResult<unknown>> {
  if (command === 'copy') {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(String(input.text));
    return done();
  }
  const bridge = window.pantheon;
  if (!bridge) return done();
  const { workspace_id, path } = input as { workspace_id: string; path: string };
  if (command === 'open.editor') return bridge.openInEditor(workspace_id);
  if (command === 'open.terminal') return bridge.openInTerminal(workspace_id);
  return bridge.revealPath(path);
}

/** The session as Markdown: from its thread while one shows it, else from its events read now. */
async function sessionExport(session: WorkbenchSession): Promise<BridgeResult<string>> {
  const { board, events: live } = useBoard.getState();
  const known = board?.sessions.find((s) => s.id === session.id);
  let turns = shownTurns(session.id);
  if (!turns) {
    const bridge = window.pantheon;
    if (!bridge)
      return {
        ok: false,
        error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
      };
    const own = board?.session_turns.filter((turn) => turn.session_id === session.id) ?? [];
    const ids = new Set(own.map((turn) => turn.id));
    const keep = (e: DaemonEvent) =>
      isSessionEvent(e, session.id, ids) || isSessionApproval(e, session.id);
    const read = await readEventHistory(bridge, {
      project_id: known?.project_id ?? null,
      after: 0,
      keep,
    });
    if (!read.ok) return read;
    turns = buildTranscript(own, mergeEvents(read.value.events, live.filter(keep))).turns;
  }
  const project = board?.projects.find((p) => p.id === known?.project_id);
  const workspace = board?.workspaces.find((w) => w.id === session.workspace_id);
  return {
    ok: true,
    value: sessionMarkdown({
      title: sessionRow(session).title,
      project: project?.name,
      branch: session.branch,
      runtime: session.runtime,
      model: session.model,
      created_at: session.created_at,
      turns,
      folders: [...(workspace ? [workspace.path] : []), ...(project?.roots ?? [])],
    }),
  };
}

/** Saves the text through a download link; the bridge has no save dialog. */
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

/**
 * The session's menu entries and the dialogs they open; `local` runs the thread header's rename and
 * discard instead. The merge preflight is read only while the menu or its merge confirmation is open.
 */
export function useSessionMenu(
  session: WorkbenchSession,
  local: { rename?: () => void; discard?: () => void; discardable?: boolean } = {},
) {
  const known = useBoard((s) => s.board?.sessions.find((k) => k.id === session.id) ?? null);
  const revision = known?.revision ?? null;
  const projectId = known?.project_id ?? null;
  const workspace = useBoard(
    (s) => s.board?.workspaces.find((w) => w.id === session.workspace_id) ?? null,
  );
  const unread = isUnread(useSeenRecords(projectId)?.[session.id], session);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'delete' | 'merge' | 'rename' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = globalThis.window?.pantheon;
  const openWindow =
    bridge && projectId
      ? () =>
          void bridge
            .openWindow({ kind: 'session', project_id: projectId, session_id: session.id })
            .catch(fail)
            .then((result) => result.ok || setError(failureText(result.error)))
      : null;
  const preflightRead = useSessionPreflight(
    (open || dialog === 'merge') && liveGated(session) ? session.id : null,
  );
  const preflight = preflightRead.data;
  const discard = discardKind(known, session);
  // Beside the shown session on the sessions screen, unless it is one of the two shown.
  const besides = useShell(
    (s) =>
      s.screen === 'sessions' &&
      !!(s.sessionId || s.followed) &&
      (s.sessionId || s.followed) !== session.id &&
      s.splitId !== session.id,
  );
  const splitRoom = useSplitRoom();
  const openBeside = besides && splitRoom ? () => useShell.getState().openSplit(session.id) : null;
  const menu = sessionMenu(session, {
    unread,
    workspace,
    merge: preflight
      ? {
          target: preflight.target_branch,
          reason: preflight.can_merge ? null : blockedText(preflight.blocked_reason),
        }
      : preflightRead.error
        ? { target: null, reason: preflightRead.error }
        : null,
    ...(preflight ? { gated: preflight.gate.configured_total > 0 } : {}),
    discardable: local.discardable ?? discard !== null,
    newWindow: openWindow !== null,
    ...(besides ? { beside: splitRoom ? {} : { reason: noSplitRoom() } } : {}),
  });
  const title = sessionRow(session).title;
  const close = () => setDialog(null);
  const followShown = () => {
    const shell = useShell.getState();
    if (shell.sessionId === session.id) shell.followFirstSession();
  };

  const choose = async (item: SessionMenuItem) => {
    setError(null);
    if (item.command === 'session.delete') return setDialog('delete');
    if (item.command === 'session.merge') {
      preflightRead.reload();
      return setDialog('merge');
    }
    if (item.command === 'session.rename')
      return local.rename ? local.rename() : setDialog('rename');
    if (item.command === 'session.discard')
      return local.discard ? local.discard() : setDialog('discard');
    if (item.command === 'session.open') return useShell.getState().openSession(session.id);
    if (item.command === 'session.open_window') return openWindow?.();
    if (item.command === 'session.open_beside') return openBeside?.();
    if (item.command === 'session.mark_unread') return markUnread(projectId, session);
    if (item.command === 'session.mark_read') return markRead(projectId, session);
    if (item.command === 'session.copy_markdown' || item.command === 'session.export_markdown') {
      const read = await sessionExport(session).catch(fail);
      if (!read.ok) return void toast({ title: failureText(read.error), kind: 'failure' });
      if (item.command === 'session.export_markdown')
        return download(String(read.value), markdownFileName(title));
      const copied = await sessionAction('copy', { text: read.value }).catch(fail);
      return void toast(
        copied.ok
          ? { title: t({ id: 'sessions.export.copied', defaultMessage: 'Copied as Markdown' }) }
          : { title: failureText(copied.error), kind: 'failure' },
      );
    }
    const result = await (
      item.command === 'open.editor' ||
      item.command === 'open.terminal' ||
      item.command === 'open.finder' ||
      item.command === 'copy'
        ? sessionAction(item.command, item.input)
        : runCommand(item.command, item.input, revision)
    ).catch(fail);
    if (!result.ok) return setError(failureText(result.error));
    if (item.command === 'session.archive') {
      const shown = useShell.getState().sessionId === session.id;
      followShown();
      toast({
        title: t({ id: 'sessions.screen.archived', defaultMessage: 'Session archived' }),
        action: {
          label: t({ id: 'sessions.screen.undo', defaultMessage: 'Undo' }),
          run: () =>
            void runCommand('session.unarchive', item.input, (result.value as Session).revision)
              .catch(fail)
              .then((undone) => {
                if (!undone.ok) return toast({ title: failureText(undone.error), kind: 'failure' });
                if (shown) useShell.getState().openSession(session.id);
              }),
        },
      });
    }
  };
  /**
   * The menu as data for the page's menus and the native one. The header's menu leaves out opening
   * the session here; the sheet's also leaves out opening the worktree, which its Open menu does.
   */
  const menuData = (place: string) => {
    const kept = (one: SessionMenuEntry) =>
      'command' in one
        ? !['session.open', 'session.open_beside'].includes(one.command)
        : place !== 'sheet' || !one.items.some((item) => item.command.startsWith('open.'));
    const chosen = new Map<string, { item: SessionMenuItem; icon: ReactNode }>();
    const leaf = (item: SessionMenuItem, icon: ReactNode = iconOf(item)): PopupMenuItem => {
      const id = String(chosen.size);
      chosen.set(id, { item, icon });
      return {
        id,
        label: item.label,
        enabled: item.reason === undefined,
        ...(item.danger ? { danger: true } : {}),
      };
    };
    const entries = menu
      .map((group) => (place === 'header' || place === 'sheet' ? group.filter(kept) : group))
      .filter((group) => group.length > 0)
      .flatMap((group, i): PopupMenuItem[] => [
        ...(i > 0 ? [{ separator: true } as const] : []),
        ...group.map((one) => {
          if (!('items' in one)) return leaf(one);
          const copies = one.items[0]?.command === 'copy';
          return {
            id: one.label,
            label: one.label,
            enabled: true,
            items: one.items.flatMap((item, k): PopupMenuItem[] => [
              ...(item.separated ? [{ separator: true } as const] : []),
              leaf(item, copies ? iconOf(item, COPY_ICONS[k]) : iconOf(item)),
            ]),
          };
        }),
      ]);
    return { entries, chosen };
  };
  const items = (place: string) => {
    const { entries, chosen } = menuData(place);
    let reasons = 0;
    const shown = (list: PopupMenuItem[]): ReactNode[] =>
      list.flatMap((one, i) => {
        if ('separator' in one) return [<MenuSeparator key={`separator-${i}`} />];
        if (one.items) {
          // A submenu starts with an item, never a separator.
          const first = one.items[0] as { id: string };
          const copies = chosen.get(first.id)?.item.command === 'copy';
          return [
            <SubMenu
              key={one.label}
              label={one.label}
              icon={copies ? <Copy aria-hidden="true" /> : <AppWindow aria-hidden="true" />}
            >
              {shown(one.items)}
            </SubMenu>,
          ];
        }
        const { item, icon } = chosen.get(one.id)!;
        return [
          menuEntry(
            item,
            () => void choose(item),
            `${place}-reason-${session.id}-${reasons++}`,
            icon,
          ),
        ];
      });
    return shown(entries);
  };
  // In the desktop app a right-click opens the same menu natively.
  const popupMenu = bridge
    ? async (place: string) => {
        const { entries, chosen } = menuData(place);
        const picked = await bridge.popupMenu(entries).catch(() => null);
        const found = picked === null ? undefined : chosen.get(picked);
        if (found) await choose(found.item);
      }
    : null;
  // ⌘⌫ asks only when the menu's delete could be chosen.
  const askDelete = () => {
    const remove = menu.flat().find((one) => 'command' in one && one.command === 'session.delete');
    if (remove && !('reason' in remove)) setDialog('delete');
  };
  const dialogs = (
    <>
      <DeleteDialog
        open={dialog === 'delete'}
        title={title}
        sessionId={session.id}
        revision={revision}
        onClose={close}
        onDeleted={followShown}
      />
      {(preflight || dialog === 'merge') && (
        <MergeDialog
          open={dialog === 'merge'}
          sessionId={session.id}
          revision={revision}
          preflight={preflight}
          error={preflightRead.error}
          source={title}
          lands={!!session.lands}
          onClose={close}
        />
      )}
      {dialog === 'rename' && (
        <RenameDialog title={title} sessionId={session.id} revision={revision} onClose={close} />
      )}
      {!local.discard && discard && (
        <DiscardDialog
          open={dialog === 'discard'}
          title={title}
          sessionId={session.id}
          revision={revision}
          {...discardDescription(discard)}
          listed={session}
          onClose={close}
          onDiscarded={followShown}
        />
      )}
    </>
  );
  const askRename = () => setDialog('rename');
  // The row's preview archives as the menu would, only when the menu offers it.
  const archiving = menu
    .flat()
    .find((one): one is SessionMenuItem => 'command' in one && one.command === 'session.archive');
  const archive = archiving ? () => void choose(archiving) : null;
  return {
    items,
    popupMenu,
    error,
    clearError: () => setError(null),
    dialog: dialogs,
    askDelete,
    askRename,
    archive,
    openWindow,
    openBeside,
    onOpenChange: setOpen,
  };
}

/** Re-renders the caller every second while `on`. */
export function useSecondTick(on: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
}

export const NO_FEEDBACK: readonly FeedbackItem[] = [];

/** Pasted text longer than this, in characters or lines, becomes an attachment. */
const PASTE_CHARS = 4000;
const PASTE_LINES = 80;

/**
 * Pasted and dropped files become attachments, and so does pasted text alone that is too long;
 * other pasted text stays with the textarea.
 */
export function useFileInput(
  attachments: {
    addFiles: (files: File[]) => Promise<void>;
    addText: (text: string) => Promise<void>;
  },
  enabled = true,
) {
  const [over, setOver] = useState(false);
  const take = (e: { preventDefault: () => void }, list: FileList, text = '') => {
    if (!enabled || list.length === 0) return;
    if (!text) e.preventDefault();
    void attachments.addFiles(Array.from(list));
  };
  return {
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData('text/plain');
      if (
        enabled &&
        e.clipboardData.files.length === 0 &&
        (text.length > PASTE_CHARS || lineCount(text) > PASTE_LINES)
      ) {
        e.preventDefault();
        void attachments.addText(text);
        return;
      }
      take(e, e.clipboardData.files, text);
    },
    box: {
      'data-drop': over || undefined,
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        if (!enabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        setOver(false);
        take(e, e.dataTransfer.files);
      },
    },
  };
}

export const ON = { enabled: true, reason: null };

function RenameDialog(props: {
  title: string;
  sessionId: string;
  revision: number | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.rename',
      { session_id: props.sessionId, title: draft },
      props.revision,
    ).catch(fail);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    props.onClose();
  };

  return (
    <Dialog.Root open onOpenChange={(next) => !next && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <Dialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {t(
                { id: 'sessions.screen.renameTitle', defaultMessage: 'Rename “{title}”' },
                { title: props.title },
              )}
            </Dialog.Title>
          </div>
          <div className="pj-rm-body">
            <div className="pj-inp">
              <input
                aria-label={t({
                  id: 'sessions.screen.sessionTitle',
                  defaultMessage: 'Session title',
                })}
                type="text"
                value={draft}
                disabled={busy}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  void save();
                }}
              />
            </div>
          </div>
          {error && (
            <div className="pj-err" role="alert">
              <b>{error}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <Dialog.Close className="btn ghost">
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </Dialog.Close>
            <button
              type="button"
              className="btn pri"
              disabled={busy || !draft.trim()}
              onClick={() => void save()}
            >
              {t({ id: 'sessions.screen.save', defaultMessage: 'Save' })}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeleteDialog(props: {
  open: boolean;
  title: string;
  sessionId: string;
  revision: number | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.delete',
      { session_id: props.sessionId },
      props.revision,
    ).catch(fail);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    props.onClose();
    props.onDeleted();
    toast({ title: t({ id: 'sessions.screen.deleted', defaultMessage: 'Session deleted' }) });
  };

  return (
    <AlertDialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        props.onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <AlertDialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <AlertDialog.Title className="pj-dt">
              {t(
                { id: 'overlays.confirm.deleteTitle', defaultMessage: 'Delete “{title}”?' },
                { title: props.title },
              )}
            </AlertDialog.Title>
          </div>
          <AlertDialog.Description className="pj-rm-body">
            {t({
              id: 'sessions.screen.deleteBody',
              defaultMessage:
                "Deletes the session's record, turns, reviews and native history, and removes its worktree. This can't be undone.",
            })}
          </AlertDialog.Description>
          {error && (
            <div className="pj-err" role="alert">
              <b>{error}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <AlertDialog.Close className="btn">
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </AlertDialog.Close>
            <button
              type="button"
              className="btn dng"
              disabled={busy}
              aria-disabled={busy || undefined}
              onClick={() => void remove()}
            >
              {t({ id: 'sessions.screen.delete', defaultMessage: 'Delete' })}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
