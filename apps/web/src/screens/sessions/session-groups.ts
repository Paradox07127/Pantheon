import type { WorkbenchSession } from '@pantheon/protocol';
import { shortId } from '../../data/format';
import { listedTitle } from '../../lib/daemon-text';
import { shortcutKeys } from '../../lib/shortcuts';
import { t } from '../../i18n';

// The projects page also asks for 'inbox': the sessions that need the user, which the list filters to.
export type SessionGroupKey =
  'inbox' | 'waiting' | 'working' | 'review' | 'snoozed' | 'merged' | 'ended' | 'archived';

export interface SessionListGroup {
  key: SessionGroupKey;
  label: string;
  sessions: WorkbenchSession[];
  /** Shown folded until the user opens it. */
  folded: boolean;
}

// Labels are getters, so each is read in the language loaded by then.
const GROUPS: readonly { key: SessionGroupKey; label: string; folded: boolean }[] = [
  {
    key: 'waiting',
    get label() {
      return t({ id: 'sessions.model.group.waiting', defaultMessage: 'Needs you' });
    },
    folded: false,
  },
  {
    key: 'working',
    get label() {
      return t({ id: 'sessions.model.group.working', defaultMessage: 'Working' });
    },
    folded: false,
  },
  {
    key: 'review',
    get label() {
      return t({ id: 'sessions.model.group.review', defaultMessage: 'To review' });
    },
    folded: false,
  },
  {
    key: 'snoozed',
    get label() {
      return t({ id: 'sessions.model.group.snoozed', defaultMessage: 'Snoozed' });
    },
    folded: false,
  },
  {
    key: 'merged',
    get label() {
      return t({ id: 'sessions.model.group.merged', defaultMessage: 'Merged' });
    },
    folded: true,
  },
  {
    key: 'ended',
    get label() {
      return endedLabel();
    },
    folded: true,
  },
  {
    key: 'archived',
    get label() {
      return archivedLabel();
    },
    folded: true,
  },
];

const endedLabel = () => t({ id: 'sessions.model.group.ended', defaultMessage: 'Ended' });
const archivedLabel = () => t({ id: 'sessions.model.group.archived', defaultMessage: 'Archived' });

const troubled = (s: WorkbenchSession): boolean =>
  s.reconciling ||
  s.state === 'failed' ||
  (s.gate?.state === 'failed' && !ENDED_STATES.has(s.state)) ||
  s.merge?.state === 'blocked';

export const needsAttention = (s: WorkbenchSession): boolean =>
  s.state === 'waiting' || troubled(s);

/**
 * By priority archived > snoozed > waiting > working > review > merged > ended; an unread idle
 * session is to review.
 */
function groupOf(s: WorkbenchSession, unread: (s: WorkbenchSession) => boolean): SessionGroupKey {
  if (s.archived_at) return 'archived';
  if (s.snoozed_at) return 'snoozed';
  if (needsAttention(s)) return 'waiting';
  if (s.stopping || ['starting', 'running', 'merging'].includes(s.state)) return 'working';
  if (s.state === 'ready' || (s.state === 'idle' && unread(s))) return 'review';
  if (s.state === 'merged') return 'merged';
  return 'ended';
}

export type SessionSort = 'activity' | 'created' | 'title';

/** What a listed session is to the list's type filter: one a session spawned, a runtime analysis, or one the user opened. */
export type SessionType = 'worker' | 'direct' | 'review';

export const SESSION_TYPES: readonly SessionType[] = ['worker', 'direct', 'review'];

export const sessionType = (s: WorkbenchSession): SessionType =>
  s.spawned_by ? 'worker' : s.runtime_review ? 'review' : 'direct';

export interface SessionListView {
  /** lead: by who opened or forked each session; time: by day of the sorted time. */
  grouping: 'lead' | 'state' | 'time';
  sort: SessionSort;
  /** Whether the archived sessions are listed. */
  archived: boolean;
  /** The types the list leaves out; absent leaves none out. */
  hiddenTypes?: readonly SessionType[];
  /** The runtimes the list leaves out, so a runtime first seen later still shows. */
  hiddenRuntimes?: readonly string[];
}

/** Whether the view's type and runtime filters keep the session. */
export const keptByView = (s: WorkbenchSession, view: SessionListView): boolean =>
  !view.hiddenTypes?.includes(sessionType(s)) && !view.hiddenRuntimes?.includes(s.runtime);

export const DEFAULT_SESSION_VIEW: SessionListView = {
  grouping: 'lead',
  sort: 'activity',
  archived: false,
};

/** The stored list view of a project; anything unreadable falls back to the default. */
export function readSessionView(raw: string | null): SessionListView {
  try {
    const value = JSON.parse(raw ?? '{}') as {
      grouping?: unknown;
      sort?: unknown;
      archived?: unknown;
      hiddenTypes?: unknown;
      hiddenRuntimes?: unknown;
    } | null;
    const strings = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((each): each is string => typeof each === 'string') : [];
    const types = strings(value?.hiddenTypes).filter((each): each is SessionType =>
      SESSION_TYPES.includes(each as SessionType),
    );
    const runtimes = strings(value?.hiddenRuntimes);
    return {
      grouping: value?.grouping === 'state' || value?.grouping === 'time' ? value.grouping : 'lead',
      sort: value?.sort === 'created' || value?.sort === 'title' ? value.sort : 'activity',
      archived: value?.archived === true,
      ...(types.length > 0 ? { hiddenTypes: types } : {}),
      ...(runtimes.length > 0 ? { hiddenRuntimes: runtimes } : {}),
    };
  } catch {
    return DEFAULT_SESSION_VIEW;
  }
}

type Compare = (a: WorkbenchSession, b: WorkbenchSession) => number;

const newest =
  (key: 'last_activity_at' | 'created_at'): Compare =>
  (a, b) =>
    a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0;

const COMPARE: Record<SessionSort, Compare> = {
  activity: newest('last_activity_at'),
  created: newest('created_at'),
  title: (a, b) => sessionRow(a).title.localeCompare(sessionRow(b).title),
};

/** Newest activity or creation first, or by title; ties keep the list order. */
const sorted = (list: readonly WorkbenchSession[], sort: SessionSort): WorkbenchSession[] =>
  [...list].sort(COMPARE[sort]);

/**
 * The sessions by group in waiting, working, review, snoozed, merged, ended, archived order, pinned
 * ones first inside each; empty groups are left out. Without `unread` every session counts as read.
 */
export function groupWorkbenchSessions(
  list: readonly WorkbenchSession[],
  sort: SessionSort = 'activity',
  unread: (s: WorkbenchSession) => boolean = () => false,
): SessionListGroup[] {
  const ordered = sorted(list, sort);
  ordered.sort((a, b) => Number(!a.pinned_at) - Number(!b.pinned_at));
  return GROUPS.map((group) => ({
    ...group,
    sessions: ordered.filter((s) => groupOf(s, unread) === group.key),
  })).filter((group) => group.sessions.length > 0);
}

const ENDED_STATES: ReadonlySet<WorkbenchSession['state']> = new Set([
  'merged',
  'discarded',
  'failed',
  'done',
]);

export interface SessionMenuItem {
  label: string;
  command:
    | 'session.pin'
    | 'session.snooze'
    | 'session.archive'
    | 'session.unarchive'
    | 'session.delete'
    | 'session.rename'
    | 'session.discard'
    | 'session.interrupt'
    | 'session.gates.run'
    | 'session.merge'
    // Run in this window, never sent.
    | 'session.open'
    | 'session.open_window'
    | 'session.open_beside'
    | 'session.mark_unread'
    | 'session.mark_read'
    | 'open.editor'
    | 'open.terminal'
    | 'open.finder'
    | 'copy'
    | 'session.copy_markdown'
    | 'session.export_markdown';
  input: Record<string, unknown>;
  /** Starts a new group of its submenu, after a separator. */
  separated?: true;
  /** The item's shortcut, in aria-keyshortcuts notation. */
  keys?: string;
  /** The modifier that does the item on a click of the row, in aria-keyshortcuts notation. */
  click?: string;
  danger?: true;
  /** Why the item is turned off; absent when it can be chosen. */
  reason?: string;
}

export interface SessionSubmenu {
  label: string;
  items: SessionMenuItem[];
}

export type SessionMenuEntry = SessionMenuItem | SessionSubmenu;

export interface SessionMenuContext {
  unread?: boolean;
  /** The session's worktree on the board; null when the board names none. */
  workspace?: { id: string; path: string; base_sha?: string; removed_at?: number } | null;
  /** Whether the worktree's project folder has gate commands; absent until the preflight is read. */
  gated?: boolean;
  /** The merge target and why the preflight blocks it; null until the preflight is read. */
  merge?: { target: string | null; reason: string | null } | null;
  /** Whether the session's worktree or baseline can be discarded. */
  discardable?: boolean;
  /** Whether the app can open the session in a window of its own. */
  newWindow?: boolean;
  /** Whether the session can open beside the shown one, and why not now; absent when it cannot. */
  beside?: { reason?: string };
}

const optional = (reason: string | null | undefined) => (reason ? { reason } : {});

/** Listed sessions without a workspace are baseline and runtime analysis ones. */
export const baselineRow = (s: WorkbenchSession): boolean =>
  s.workspace_id === null && !s.runtime_review;

/** A worktree session that has not ended; it can run checks and merge. */
export const liveWorktree = (s: WorkbenchSession): boolean =>
  s.workspace_id !== null && s.workspace_kind !== 'in_place' && !ENDED_STATES.has(s.state);

/** A live worktree session, or one the user opened in the project folder, which lands there. */
export const liveGated = (s: WorkbenchSession): boolean =>
  liveWorktree(s) || (!!s.lands && !ENDED_STATES.has(s.state));

/** The session's menu in groups; empty groups are left out. */
export function sessionMenu(
  s: WorkbenchSession,
  context: SessionMenuContext = {},
): SessionMenuEntry[][] {
  const session_id = s.id;
  const { workspace = null, merge = null } = context;
  const keys = shortcutKeys('session-pin') || undefined;
  const noWorktree = worktreeReason(s, workspace) ?? (workspace ? null : noWorktreeText());
  const at = { workspace_id: workspace?.id, path: workspace?.path };
  const merging = s.state === 'merging' || s.merge?.state === 'running';
  const mergingText = () => t({ id: 'sessions.model.menu.merging', defaultMessage: 'Merging' });
  const groups: SessionMenuEntry[][] = [
    [
      {
        label: t({ id: 'sessions.rowMenu.open', defaultMessage: 'Open' }),
        command: 'session.open',
        input: { session_id },
      },
      ...(context.newWindow
        ? [
            {
              label: t({ id: 'sessions.rowMenu.openWindow', defaultMessage: 'Open in new window' }),
              command: 'session.open_window',
              input: { session_id },
              click: 'Meta',
            } as const,
          ]
        : []),
      ...(context.beside
        ? [
            {
              label: t({ id: 'sessions.split.openBeside', defaultMessage: 'Open beside' }),
              command: 'session.open_beside',
              input: { session_id },
              click: 'Alt',
              ...optional(context.beside.reason),
            } as const,
          ]
        : []),
    ],
    [
      {
        label: t({ id: 'sessions.model.menu.rename', defaultMessage: 'Rename…' }),
        command: 'session.rename',
        input: { session_id },
        keys: shortcutKeys('session-rename') || undefined,
        ...optional(
          baselineRow(s)
            ? t({
                id: 'sessions.model.menu.baselineNoRename',
                defaultMessage: 'A baseline session cannot be renamed',
              })
            : null,
        ),
      },
      s.pinned_at
        ? {
            label: t({ id: 'sessions.model.menu.unpin', defaultMessage: 'Unpin' }),
            command: 'session.pin',
            input: { session_id, pinned: false },
            keys,
          }
        : {
            label: t({ id: 'sessions.model.menu.pin', defaultMessage: 'Pin' }),
            command: 'session.pin',
            input: { session_id, pinned: true },
            keys,
          },
      ...(s.archived_at
        ? []
        : [
            {
              label: s.snoozed_at
                ? t({ id: 'sessions.model.menu.unsnooze', defaultMessage: 'Unsnooze' })
                : t({ id: 'sessions.model.menu.snooze', defaultMessage: 'Snooze' }),
              command: 'session.snooze',
              input: { session_id, snoozed: !s.snoozed_at },
            } as const,
          ]),
      {
        label: context.unread
          ? t({ id: 'sessions.model.menu.markRead', defaultMessage: 'Mark as read' })
          : t({ id: 'sessions.model.menu.markUnread', defaultMessage: 'Mark as unread' }),
        command: context.unread ? 'session.mark_read' : 'session.mark_unread',
        input: { session_id },
        keys: shortcutKeys('session-unread') || undefined,
      },
    ],
    [
      ...(s.state === 'running'
        ? [
            {
              label: t({ id: 'sessions.model.menu.stopTurn', defaultMessage: 'Stop turn' }),
              command: 'session.interrupt',
              input: { session_id },
              keys: shortcutKeys('stop-turn') || undefined,
              ...optional(
                s.stopping
                  ? t({ id: 'sessions.model.menu.stopping', defaultMessage: 'Stopping' })
                  : null,
              ),
            } as const,
          ]
        : []),
      ...(liveGated(s)
        ? [
            {
              label: t({ id: 'sessions.model.menu.runChecks', defaultMessage: 'Run checks' }),
              command: 'session.gates.run',
              input: { session_id },
              ...optional(
                worktreeReason(s, workspace) ??
                  (s.gate?.state === 'running'
                    ? t({
                        id: 'sessions.model.menu.checksRunning',
                        defaultMessage: 'Checks are running',
                      })
                    : merging
                      ? mergingText()
                      : context.gated === false
                        ? t({
                            id: 'sessions.model.menu.noGates',
                            defaultMessage: 'The project has no gate commands',
                          })
                        : null),
              ),
            } as const,
            {
              label: s.lands
                ? t({ id: 'sessions.model.menu.land', defaultMessage: 'Land…' })
                : merge?.target
                  ? t(
                      {
                        id: 'sessions.model.menu.mergeInto',
                        defaultMessage: 'Merge into {target}…',
                      },
                      { target: merge.target },
                    )
                  : t({ id: 'sessions.model.menu.merge', defaultMessage: 'Merge…' }),
              command: 'session.merge',
              input: { session_id },
              ...optional(
                worktreeReason(s, workspace) ??
                  (merging
                    ? mergingText()
                    : merge
                      ? merge.reason
                      : t({
                          id: 'sessions.model.menu.readingMerge',
                          defaultMessage: 'Reading the merge conditions',
                        })),
              ),
            } as const,
          ]
        : []),
    ],
    [
      {
        label: t({ id: 'sessions.rowMenu.openIn', defaultMessage: 'Open in' }),
        items: [
          {
            label: t({ id: 'sessions.rowMenu.editor', defaultMessage: 'Editor' }),
            command: 'open.editor',
            input: at,
            ...optional(noWorktree),
          },
          {
            label: t({ id: 'sessions.rowMenu.terminal', defaultMessage: 'Terminal' }),
            command: 'open.terminal',
            input: at,
            ...optional(noWorktree),
          },
          {
            label: fileManagerText(),
            command: 'open.finder',
            input: at,
            ...optional(noWorktree),
          },
        ],
      },
      {
        label: t({ id: 'sessions.model.menu.copy', defaultMessage: 'Copy' }),
        items: [
          {
            label:
              s.workspace_kind === 'in_place'
                ? t({ id: 'sessions.model.menu.copyFolder', defaultMessage: 'Folder' })
                : t({
                    id: 'sessions.model.menu.copyWorktreePath',
                    defaultMessage: 'Worktree path',
                  }),
            command: 'copy',
            input: { text: workspace?.path },
            ...optional(noWorktree),
          },
          {
            label: t({ id: 'sessions.model.menu.copySessionId', defaultMessage: 'Session ID' }),
            command: 'copy',
            input: { text: session_id },
          },
          {
            label: t({ id: 'sessions.model.menu.copyBaseCommit', defaultMessage: 'Base commit' }),
            command: 'copy',
            input: { text: workspace?.base_sha },
            ...optional(
              noWorktree ??
                (workspace?.base_sha
                  ? null
                  : t({
                      id: 'sessions.model.menu.noBaseCommit',
                      defaultMessage: 'No base commit',
                    })),
            ),
          },
          {
            label: t({ id: 'sessions.export.copyMarkdown', defaultMessage: 'Copy as Markdown' }),
            command: 'session.copy_markdown',
            input: { session_id },
            separated: true,
          },
          {
            label: t({
              id: 'sessions.export.exportMarkdown',
              defaultMessage: 'Export as Markdown…',
            }),
            command: 'session.export_markdown',
            input: { session_id },
          },
        ],
      },
    ],
    [
      ...(s.archived_at
        ? [
            {
              label: t({ id: 'sessions.model.menu.unarchive', defaultMessage: 'Restore' }),
              command: 'session.unarchive',
              input: { session_id },
            } as const,
          ]
        : ENDED_STATES.has(s.state) || s.state === 'idle' || s.state === 'ready'
          ? [
              {
                label: t({ id: 'sessions.model.menu.archive', defaultMessage: 'Archive' }),
                command: 'session.archive',
                input: { session_id },
                keys: shortcutKeys('session-archive') || undefined,
              } as const,
            ]
          : []),
      ...(context.discardable
        ? [
            {
              label: t({ id: 'sessions.model.menu.discard', defaultMessage: 'Discard changes…' }),
              command: 'session.discard',
              input: { session_id },
              danger: true,
            } as const,
          ]
        : []),
      {
        label: t({ id: 'sessions.model.menu.delete', defaultMessage: 'Delete…' }),
        command: 'session.delete',
        input: { session_id },
        danger: true,
        ...optional(
          s.state === 'merged'
            ? t({
                id: 'sessions.model.menu.mergedArchiveOnly',
                defaultMessage: 'A merged session can only be archived',
              })
            : merging || s.gate?.state === 'running'
              ? t({
                  id: 'sessions.model.menu.mergingOrChecking',
                  defaultMessage: 'Merging or running checks',
                })
              : null,
        ),
      },
    ],
  ];
  return groups.filter((group) => group.length > 0);
}

const noWorktreeText = () =>
  t({ id: 'sessions.model.worktree.none', defaultMessage: 'This session has no worktree' });

const noWorkspaceText = () =>
  t({
    id: 'sessions.model.workspace.none',
    defaultMessage: 'This session has no folder of its own',
  });

/** The system file manager's name. */
function fileManagerText(): string {
  const agent = globalThis.navigator?.userAgent ?? '';
  if (/Mac/.test(agent)) return t({ id: 'sessions.rowMenu.finder', defaultMessage: 'Finder' });
  if (/Windows/.test(agent))
    return t({ id: 'sessions.rowMenu.explorer', defaultMessage: 'File Explorer' });
  return t({ id: 'sessions.rowMenu.fileManager', defaultMessage: 'File manager' });
}

/** Why the session's folder cannot be opened; null while it exists, ended or not. */
export function worktreeReason(
  s: WorkbenchSession,
  workspace: { removed_at?: number } | null = null,
): string | null {
  if (s.workspace_id === null) return noWorkspaceText();
  if (s.state === 'starting')
    return t({
      id: 'sessions.model.worktree.creating',
      defaultMessage: 'The worktree is still being created',
    });
  if (s.state === 'discarded' || workspace?.removed_at !== undefined)
    return t({ id: 'sessions.model.worktree.removed', defaultMessage: 'The worktree was deleted' });
  return null;
}

export interface SidebarRow {
  session: WorkbenchSession;
  /** The sessions opened or forked from this one and from those, depth first, siblings sorted. */
  children: WorkbenchSession[];
}

export type SidebarGroupKey =
  SessionGroupKey | 'pinned' | 'tree' | 'today' | 'yesterday' | 'week' | 'earlier';

export interface SidebarGroup {
  key: SidebarGroupKey;
  label: string;
  folded: boolean;
  /** Listed without a group header, so it never folds. */
  bare?: true;
  rows: SidebarRow[];
}

const DAY = 86_400_000;

const TIME_GROUPS = [
  {
    key: 'today',
    get label() {
      return t({ id: 'sessions.model.group.today', defaultMessage: 'Today' });
    },
  },
  {
    key: 'yesterday',
    get label() {
      return t({ id: 'sessions.model.group.yesterday', defaultMessage: 'Yesterday' });
    },
  },
  {
    key: 'week',
    get label() {
      return t({ id: 'sessions.model.group.week', defaultMessage: 'Past 7 days' });
    },
  },
  {
    key: 'earlier',
    get label() {
      return t({ id: 'sessions.model.group.earlier', defaultMessage: 'Earlier' });
    },
  },
] as const;

/** The session this one was forked from, or the one that spawned it. */
export const parentOf = (s: WorkbenchSession): string | undefined =>
  s.forked_from?.session_id ?? s.spawned_by?.session_id;

const FINISHED: ReadonlySet<WorkbenchSession['state']> = new Set(['merged', 'discarded', 'done']);

/**
 * By state, pinned first; by lead, as trees of who opened or forked whom; by time, per local day.
 * Lead and time put the finished last; the archived come after all, only when the view lists them.
 */
export function sidebarGroups(
  list: readonly WorkbenchSession[],
  view: SessionListView = DEFAULT_SESSION_VIEW,
  unread?: (s: WorkbenchSession) => boolean,
  now = Date.now(),
): SidebarGroup[] {
  const shown = view.archived ? list : list.filter((s) => !s.archived_at);
  const flat = (sessions: WorkbenchSession[]) =>
    sessions.map((session) => ({ session, children: [] }));
  if (view.grouping === 'state') {
    const pinned = sorted(
      shown.filter((s) => s.pinned_at && !s.archived_at),
      view.sort,
    );
    return [
      ...(pinned.length > 0
        ? [
            {
              key: 'pinned' as const,
              label: t({ id: 'sessions.model.group.pinned', defaultMessage: 'Pinned' }),
              folded: false,
              sessions: pinned,
            },
          ]
        : []),
      ...groupWorkbenchSessions(
        shown.filter((s) => !pinned.includes(s)),
        view.sort,
        unread,
      ),
    ].map(({ sessions, ...group }) => ({ ...group, rows: flat(sessions) }));
  }
  const live = new Set(shown.filter((s) => !s.archived_at).map((s) => s.id));
  const nested = (s: WorkbenchSession) =>
    view.grouping === 'lead' && !s.archived_at && live.has(parentOf(s) ?? '');
  const descendants = (root: WorkbenchSession): WorkbenchSession[] =>
    sorted(
      shown.filter((s) => nested(s) && parentOf(s) === root.id),
      view.sort,
    ).flatMap((child) => [child, ...descendants(child)]);
  const top = sorted(
    shown.filter((s) => !nested(s)),
    view.sort,
  );
  // A baseline session ends once confirmed but stays with the open ones until archived.
  const finished = (s: WorkbenchSession) => FINISHED.has(s.state) && !baselineRow(s);
  const going = top.filter((s) => !s.archived_at && !finished(s));
  const rows = (sessions: WorkbenchSession[]) =>
    sessions.map((session) => ({ session, children: descendants(session) }));
  const today = new Date(now).setHours(0, 0, 0, 0);
  const day = (s: WorkbenchSession) => {
    const at = Date.parse(view.sort === 'created' ? s.created_at : s.last_activity_at);
    return at >= today ? 0 : at >= today - DAY ? 1 : at >= today - 6 * DAY ? 2 : 3;
  };
  const groups: SidebarGroup[] = [
    ...(view.grouping === 'lead'
      ? [{ key: 'tree' as const, label: '', folded: false, bare: true as const, rows: rows(going) }]
      : TIME_GROUPS.map((group, i) => ({
          ...group,
          folded: false,
          rows: flat(going.filter((s) => day(s) === i)),
        }))),
    {
      key: 'ended',
      label: endedLabel(),
      folded: true,
      rows: rows(top.filter((s) => !s.archived_at && finished(s))),
    },
    {
      key: 'archived',
      label: archivedLabel(),
      folded: true,
      rows: rows(top.filter((s) => s.archived_at)),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** How deep each child of the row sits under the row's session, from 1. */
export function treeDepths(row: SidebarRow): number[] {
  const depths = new Map([[row.session.id, 0]]);
  return row.children.map((child) => {
    const depth = (depths.get(parentOf(child) ?? '') ?? 0) + 1;
    depths.set(child.id, depth);
    return depth;
  });
}

/** A tree line column: a line passing down, an empty column, or an elbow that goes on or ends. */
export type TreeLine = 'pass' | 'gap' | 'more' | 'end';

/** The columns drawn before each child at these depths: one per ancestor level, then its elbow. */
export function treeLines(depths: readonly number[]): TreeLine[][] {
  // Whether a later child sits at `level` before the tree climbs above it.
  const goesOn = (i: number, level: number) => {
    for (const depth of depths.slice(i + 1)) {
      if (depth < level) return false;
      if (depth === level) return true;
    }
    return false;
  };
  return depths.map((depth, i) => [
    ...Array.from({ length: depth - 1 }, (_, k): TreeLine => (goesOn(i, k + 1) ? 'pass' : 'gap')),
    goesOn(i, depth) ? 'more' : 'end',
  ]);
}

/** The groups with only the sessions that need the user; a session stays while one under it does. */
export function onlyWaiting(groups: readonly SidebarGroup[]): SidebarGroup[] {
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.flatMap(({ session, children }) => {
        const kept = children.filter(needsAttention);
        return needsAttention(session) || kept.length > 0 ? [{ session, children: kept }] : [];
      }),
    }))
    .filter((group) => group.rows.length > 0);
}

const sessionIds = (groups: readonly SidebarGroup[] | null, key: SidebarGroupKey) =>
  new Set(
    groups
      ?.find((g) => g.key === key)
      ?.rows.flatMap((r) => [r.session.id, ...r.children.map((c) => c.id)]) ?? [],
  );

/**
 * The toggled groups after the list went from `before` (null on first load) to `after`: a folded
 * waiting or review group opens when a session enters it. Unchanged returns the same set.
 */
export function unfoldEntered(
  toggled: ReadonlySet<string>,
  before: readonly SidebarGroup[] | null,
  after: readonly SidebarGroup[],
): ReadonlySet<string> {
  if (!before) return toggled;
  const entered = (['waiting', 'review'] as const).filter((key) => {
    const was = sessionIds(before, key);
    return toggled.has(key) && [...sessionIds(after, key)].some((id) => !was.has(id));
  });
  if (entered.length === 0) return toggled;
  const next = new Set(toggled);
  for (const key of entered) next.delete(key);
  return next;
}

/**
 * Current group membership with the previously shown order inside each group. State changes
 * still move rows while focus or a menu holds the ordering stable.
 */
export function keepOrder(
  shown: readonly SidebarGroup[],
  next: readonly SidebarGroup[],
): SidebarGroup[] {
  return next.map((group) => {
    const previous = shown.find((item) => item.key === group.key)?.rows ?? [];
    const fresh = new Map(group.rows.map((row) => [row.session.id, row]));
    const known = previous.flatMap((row) => fresh.get(row.session.id) ?? []);
    return {
      ...group,
      rows: [...known, ...group.rows.filter((row) => !known.includes(row))].map((row) => {
        const children = previous.find((old) => old.session.id === row.session.id)?.children ?? [];
        const kept = children.flatMap((old) => row.children.filter((child) => child.id === old.id));
        return {
          ...row,
          children: [...kept, ...row.children.filter((child) => !kept.includes(child))],
        };
      }),
    };
  });
}

/** `+a −d` of the worktree's changes; empty when nothing changed or the worktree is not in use. */
export function changesText(changes: WorkbenchSession['changes']): string {
  return changes && changes.files > 0 ? `+${changes.additions} −${changes.deletions}` : '';
}

export interface SessionRow {
  title: string;
  runtime: string;
  changes: string;
}

export function sessionRow(session: WorkbenchSession): SessionRow {
  return {
    title:
      listedTitle(session).trim() ||
      t(
        { id: 'sessions.model.row.untitled', defaultMessage: 'Session {id}' },
        { id: shortId(session.id) },
      ),
    runtime: session.runtime,
    changes: changesText(session.changes),
  };
}
