import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Menu } from '@base-ui/react/menu';
import type { WorkbenchSession } from '@pantheon/protocol';
import {
  BookOpen,
  ChartGantt,
  ChartLine,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  GitBranch,
  LayoutDashboard,
  LayoutGrid,
  ListFilter,
  Pin,
  Plus,
  Search,
  Settings2,
  SquarePen,
} from 'lucide-react';
import { useBoard } from '../data/board';
import { runCommand } from '../data/commands';
import { saveLayout, setLayout, SIDEBAR, sidebarDrag, useLayout } from '../data/layout';
import { failureText, useNow, type NeedsYouState } from '../data/needs-you';
import { projectIdle, sortProjects, useProjectsSummary } from '../data/projects-summary';
import { markRead, markUnread, useUnread } from '../data/unread';
import type { useSessionList } from '../data/workbench-sessions';
import { t } from '../i18n';
import { keyText, shortcutKeys, shortcutMatches, useShortcut } from '../lib/shortcuts';
import { SCREEN_NAMES } from '../screens';
import { useProjectsView } from '../screens/projects/view';
import {
  baselineRow,
  keepOrder,
  keptByView,
  needsAttention,
  onlyWaiting,
  readSessionView,
  SESSION_TYPES,
  sessionRow,
  sidebarGroups,
  treeDepths,
  treeLines,
  unfoldEntered,
  workerCounts,
  type SessionListView,
  type SessionType,
  type SidebarGroup,
  type SidebarGroupKey,
  type TreeLine,
} from '../screens/sessions/model';
import { SessionListRow, shownSessionId } from '../screens/sessions/SessionsScreen';
import { setCreatedHere, useSplitRoom } from '../screens/sessions/shared';
import { RESIDENTS, workerCountMarks, workerCountsText } from '../screens/sessions/WorkerStrip';
import { useShell } from '../store';
import { Clip } from './Clip';
import { LoadError } from './LoadError';
import { compareRuntimes, RuntimeGlyph, runtimeName } from './RuntimeGlyph';
import { SessionStateIcon, sessionStateLabel, StateGlyph } from './SessionStateIcon';
import { ProjectMonogram } from './ProjectMonogram';
import { KeyHint } from './Shortcuts';
import { Skeleton } from './Skeleton';
import { Splitter } from './Splitter';
import { Tip } from './Tip';
import { toast } from './Toast';
import './sidebar-projects.css';
import './sidebar-window.css';

/** The sidebar's width and ⌘B folding from the stored layout; App needs it for the title bar's room. */
export function useSidebarLayout() {
  const { sidebar } = useLayout();

  const toggle = () => {
    setLayout((now) => ({ sidebar: { ...now.sidebar, collapsed: !now.sidebar.collapsed } }));
    saveLayout();
  };

  useShortcut('sidebar', toggle);

  return {
    ...sidebar,
    resize: (width: number) => setLayout((now) => ({ sidebar: sidebarDrag(width, now.sidebar) })),
    commit: saveLayout,
    reset: () => {
      setLayout({ sidebar: { collapsed: false, width: SIDEBAR.initial } });
      saveLayout();
    },
    toggle,
  };
}

const VIEW_KEY = 'pantheon.sessionView.';

function loadView(projectId: string | null): SessionListView {
  try {
    return readSessionView(projectId ? localStorage.getItem(VIEW_KEY + projectId) : null);
  } catch {
    return readSessionView(null);
  }
}

/** The session list's grouping and sort, stored per project. */
function useSessionView(projectId: string | null) {
  const [stored, setStored] = useState(() => ({ projectId, view: loadView(projectId) }));
  if (stored.projectId !== projectId) setStored({ projectId, view: loadView(projectId) });
  // Another window stored a view of the project: this one follows it.
  useEffect(() => {
    if (!projectId) return;
    const follow = (e: StorageEvent) => {
      if (e.key === VIEW_KEY + projectId)
        setStored({ projectId, view: readSessionView(e.newValue) });
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, [projectId]);
  const change = (view: SessionListView) => {
    setStored({ projectId, view });
    if (!projectId) return;
    try {
      localStorage.setItem(VIEW_KEY + projectId, JSON.stringify(view));
    } catch {
      // The view still applies for this session.
    }
  };
  return [stored.view, change] as const;
}

// Labels are getters, so each is read in the language loaded by then.
const GROUPINGS = [
  {
    value: 'lead',
    get label() {
      return t({ id: 'components.sidebar.groupByOrigin', defaultMessage: 'Origin' });
    },
  },
  {
    value: 'state',
    get label() {
      return t({ id: 'components.sidebar.groupByState', defaultMessage: 'State' });
    },
  },
  {
    value: 'time',
    get label() {
      return t({ id: 'components.sidebar.groupByTime', defaultMessage: 'Time' });
    },
  },
] as const;

const SORTS = [
  {
    value: 'activity',
    get label() {
      return t({ id: 'components.sidebar.sortByActivity', defaultMessage: 'Recent activity' });
    },
  },
  {
    value: 'created',
    get label() {
      return t({ id: 'components.sidebar.sortByCreated', defaultMessage: 'Created' });
    },
  },
  {
    value: 'title',
    get label() {
      return t({ id: 'components.sidebar.sortByTitle', defaultMessage: 'Title' });
    },
  },
] as const;

const TYPES: Record<SessionType, { readonly label: string }> = {
  resident: {
    get label() {
      return t({ id: 'components.sidebar.typeResident', defaultMessage: 'Resident' });
    },
  },
  worker: {
    get label() {
      return t({ id: 'components.sidebar.typeWorker', defaultMessage: 'Worker' });
    },
  },
  direct: {
    get label() {
      return t({ id: 'components.sidebar.typeDirect', defaultMessage: 'Direct' });
    },
  },
  review: {
    get label() {
      return t({ id: 'components.sidebar.typeReview', defaultMessage: 'Review' });
    },
  },
};

/** The list without one entry, or with it again. */
const flip = <T,>(list: readonly T[] | undefined, value: T, keep: boolean): T[] =>
  keep ? (list ?? []).filter((each) => each !== value) : [...(list ?? []), value];

function ViewMenu({
  view,
  runtimes,
  onChange,
}: {
  view: SessionListView;
  /** The runtimes of the project's sessions and those the view leaves out. */
  runtimes: readonly string[];
  onChange: (view: SessionListView) => void;
}) {
  const check = (key: string, label: ReactNode, checked: boolean, pick: (on: boolean) => void) => (
    <Menu.CheckboxItem key={key} checked={checked} onCheckedChange={pick}>
      <span className="pjm-ck">
        <Menu.CheckboxItemIndicator>
          <Check className="ic-sm" aria-hidden="true" />
        </Menu.CheckboxItemIndicator>
      </span>
      {label}
    </Menu.CheckboxItem>
  );
  const radio = (value: string, label: string, pick: () => void) => (
    <Menu.RadioItem key={value} value={value} closeOnClick onClick={pick}>
      <span className="pjm-ck">
        <Menu.RadioItemIndicator>
          <Check className="ic-sm" aria-hidden="true" />
        </Menu.RadioItemIndicator>
      </span>
      {label}
    </Menu.RadioItem>
  );
  const label = t({ id: 'components.sidebar.viewMenu', defaultMessage: 'Group, sort and filter' });
  return (
    <Menu.Root>
      <Tip content={label}>
        <Menu.Trigger className="ib" aria-label={label}>
          <ListFilter aria-hidden="true" />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="wmenu pjm sb-vm pop">
            <Menu.Group>
              <Menu.GroupLabel className="sb-vm-h">
                {t({ id: 'components.sidebar.grouping', defaultMessage: 'Group by' })}
              </Menu.GroupLabel>
              <Menu.RadioGroup value={view.grouping}>
                {GROUPINGS.map((g) =>
                  radio(g.value, g.label, () => onChange({ ...view, grouping: g.value })),
                )}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="pjm-sep" />
            <Menu.Group>
              <Menu.GroupLabel className="sb-vm-h">
                {t({ id: 'components.sidebar.sorting', defaultMessage: 'Sort by' })}
              </Menu.GroupLabel>
              <Menu.RadioGroup value={view.sort}>
                {SORTS.map((o) =>
                  radio(o.value, o.label, () => onChange({ ...view, sort: o.value })),
                )}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="pjm-sep" />
            <Menu.Group>
              <Menu.GroupLabel className="sb-vm-h">
                {t({ id: 'components.sidebar.types', defaultMessage: 'Type' })}
              </Menu.GroupLabel>
              {SESSION_TYPES.map((type) =>
                check(type, TYPES[type].label, !view.hiddenTypes?.includes(type), (on) =>
                  onChange({ ...view, hiddenTypes: flip(view.hiddenTypes, type, on) }),
                ),
              )}
            </Menu.Group>
            {runtimes.length > 0 && (
              <>
                <Menu.Separator className="pjm-sep" />
                <Menu.Group>
                  <Menu.GroupLabel className="sb-vm-h">
                    {t({ id: 'components.sidebar.runtimes', defaultMessage: 'Runtime' })}
                  </Menu.GroupLabel>
                  {runtimes.map((runtime) =>
                    check(
                      runtime,
                      <>
                        <RuntimeGlyph runtime={runtime} />
                        {runtimeName(runtime)}
                      </>,
                      !view.hiddenRuntimes?.includes(runtime),
                      (on) =>
                        onChange({
                          ...view,
                          hiddenRuntimes: flip(view.hiddenRuntimes, runtime, on),
                        }),
                    ),
                  )}
                </Menu.Group>
              </>
            )}
            <Menu.Separator className="pjm-sep" />
            <Menu.CheckboxItem
              checked={view.archived}
              onCheckedChange={(archived) => onChange({ ...view, archived })}
            >
              <span className="pjm-ck" />
              {t({ id: 'components.sidebar.showArchived', defaultMessage: 'Show archived' })}
              <span className="ps-sw" aria-hidden="true" />
            </Menu.CheckboxItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

interface Project {
  id: string;
  name: string;
}

/** The projects whose name holds the query, case aside. */
export function matchProjects<P extends Project>(projects: readonly P[], query: string): P[] {
  const q = query.trim().toLowerCase();
  return projects.filter((p) => p.name.toLowerCase().includes(q));
}

/** One of the six series colours, the same for a project every time. */
export function projectColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `var(--series-${(hash % 6) + 1})`;
}

const CONNECTION = {
  get live() {
    return t({ id: 'components.sidebar.connectionLive', defaultMessage: 'Connected' });
  },
  get connecting() {
    return t({ id: 'components.sidebar.connectionConnecting', defaultMessage: 'Connecting' });
  },
  get offline() {
    return t({ id: 'components.sidebar.connectionOffline', defaultMessage: 'Disconnected' });
  },
};

/** The list stop an element is: a session row or a group header. */
const stopOf = (el: HTMLElement): string | undefined => el.dataset?.session ?? el.dataset?.stop;

function Connection({ side }: { side: 'top' | 'right' }) {
  const status = useBoard((s) => s.status);
  if (status.state === 'live') return null;
  const label = CONNECTION[status.state];
  return (
    <Tip content={status.state === 'offline' ? status.reason : label} side={side}>
      <span
        className="sb-conn"
        role="img"
        aria-label={label}
        tabIndex={0}
        data-state={status.state}
      />
    </Tip>
  );
}

interface ProjectMenuProps {
  projects: readonly Project[];
  currentProjectId: string | null;
  onChooseProject: (project_id: string) => void;
  attention: number | null;
  className: string;
  current?: 'page';
  children: ReactNode;
}

function ProjectMenu({
  projects,
  currentProjectId,
  onChooseProject,
  attention,
  className,
  current,
  children,
}: ProjectMenuProps) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const { openSettings, setScreen } = useShell.getState();
  const shown = matchProjects(projects, query);
  return (
    <Menu.Root onOpenChangeComplete={(open) => (open ? input.current?.focus() : setQuery(''))}>
      <Menu.Trigger
        className={className}
        aria-current={current}
        aria-label={t({ id: 'components.sidebar.switchProject', defaultMessage: 'Switch project' })}
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="wmenu pjm pop">
            <label className="pjm-q">
              <Search className="ic-sm" aria-hidden="true" />
              <input
                ref={input}
                type="search"
                aria-label={t({
                  id: 'components.sidebar.searchProjects',
                  defaultMessage: 'Search projects',
                })}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // The menu's typeahead would take the typed letters; arrows and Escape still reach it.
                onKeyDown={(e) => {
                  if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(e.key))
                    e.stopPropagation();
                }}
              />
            </label>
            <Menu.RadioGroup value={currentProjectId}>
              {shown.map((p) => (
                <Menu.RadioItem
                  key={p.id}
                  value={p.id}
                  closeOnClick
                  onClick={() => onChooseProject(p.id)}
                >
                  <span className="pjm-ck">
                    <Menu.RadioItemIndicator>
                      <Check className="ic-sm" aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <ProjectMonogram id={p.id} name={p.name} />
                  {p.name}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="pjm-sep" />
            <Menu.Item onClick={() => useProjectsView.getState().setOpening(true)}>
              {t({ id: 'components.sidebar.openFolder', defaultMessage: 'Open folder…' })}
            </Menu.Item>
            {currentProjectId && (
              <Menu.Item onClick={() => openSettings(currentProjectId)}>
                {t({
                  id: 'components.sidebar.projectSettings',
                  defaultMessage: 'Project settings',
                })}
              </Menu.Item>
            )}
            {currentProjectId && globalThis.window?.pantheon && (
              <Menu.Item
                onClick={() =>
                  void window.pantheon
                    ?.openWindow({ kind: 'project', project_id: currentProjectId })
                    .then(
                      (result) =>
                        result.ok || toast({ title: failureText(result.error), kind: 'failure' }),
                    )
                }
              >
                {t({ id: 'shell.projectWindow.open', defaultMessage: 'Open in new window' })}
              </Menu.Item>
            )}
            <Menu.Item
              data-keys={attention === null ? '—' : attention > 0 ? attention : undefined}
              onClick={() => setScreen('projects')}
            >
              {SCREEN_NAMES.projects}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Every project as a row with what needs you, else what runs, on the all projects screen. */
function ProjectList({
  projects,
  currentProjectId,
  onChooseProject,
}: {
  projects: readonly Project[];
  currentProjectId: string | null;
  onChooseProject: (project_id: string) => void;
}) {
  const summary = useProjectsSummary();
  const summaries = summary.data ?? [];
  // The summary decides the order, so until it lands each row only holds its place.
  const sorted = summary.loading ? [] : sortProjects(projects, summaries);
  const label = t({ id: 'components.sidebar.openProject', defaultMessage: 'Open project' });
  const keys = shortcutKeys('open-project');
  const title = t({ id: 'components.sidebar.projects', defaultMessage: 'Projects' });
  return (
    <>
      <div className="sb-sh">
        <span>{title}</span>
        <Tip content={keys ? `${label} ${keyText(keys)}` : label}>
          <button
            type="button"
            className="ib"
            aria-label={label}
            aria-keyshortcuts={keys || undefined}
            onClick={() => useProjectsView.getState().setOpening(true)}
          >
            <Plus aria-hidden="true" />
          </button>
        </Tip>
      </div>
      <nav className="sb-pl" aria-label={title} aria-busy={summary.loading || undefined}>
        {summary.loading &&
          projects.map((p) => (
            <span key={p.id} className="sb-it" aria-hidden="true">
              <Skeleton style={{ height: 10, width: '60%' }} />
            </span>
          ))}
        {sorted.map((p) => {
          const summary = summaries.find((s) => s.project_id === p.id);
          const count = summary?.needs_you
            ? {
                tone: 'wait',
                n: summary.needs_you,
                label: t(
                  {
                    id: 'components.sidebar.projectNeedsYou',
                    defaultMessage: '{count, plural, one {# needs you} other {# need you}}',
                  },
                  { count: summary.needs_you },
                ),
              }
            : summary?.counts.running
              ? {
                  tone: 'run',
                  n: summary.counts.running,
                  label: t(
                    {
                      id: 'components.sidebar.projectRunning',
                      defaultMessage:
                        '{count, plural, one {# session running} other {# sessions running}}',
                    },
                    { count: summary.counts.running },
                  ),
                }
              : null;
          const idle = p.id !== currentProjectId && projectIdle(summary);
          return (
            <button
              key={p.id}
              type="button"
              className="sb-it sb-pr"
              data-idle={idle || undefined}
              onClick={() => onChooseProject(p.id)}
            >
              <ProjectMonogram id={p.id} name={p.name} />
              <span className="sb-pn">{p.name}</span>
              {idle && (
                <span className="ss-vh">
                  {t({ id: 'components.sidebar.projectIdle', defaultMessage: 'Idle' })}
                </span>
              )}
              {count && (
                <span className="sb-pc" role="img" aria-label={count.label}>
                  <span className="sb-pd" data-tone={count.tone} />
                  {count.n}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}

interface SidebarProps {
  layout: ReturnType<typeof useSidebarLayout>;
  projects: readonly Project[];
  currentProjectId: string | null;
  onChooseProject: (project_id: string) => void;
  list: ReturnType<typeof useSessionList>;
  // The needs-you items of every project.
  allNeeds: NeedsYouState;
}

export function Sidebar({
  layout,
  projects,
  currentProjectId,
  onChooseProject,
  list,
  allNeeds,
}: SidebarProps) {
  const screen = useShell((s) => s.screen);
  const sessionId = useShell((s) => s.sessionId);
  const followed = useShell((s) => s.followed);
  const askedGroup = useShell((s) => s.sessionGroup);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const targetRef = useRef<HTMLElement>(null);
  // Whether the rail's splitter is being dragged rather than moved with the arrow keys.
  const railDrag = useRef(false);
  // The open sidebar floated over the main area while the pointer rests on the rail.
  const [peek, setPeek] = useState<'shut' | 'open' | 'closing'>('shut');
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (!layout.collapsed && peek !== 'shut') setPeek('shut');
  const [view, setView] = useSessionView(currentProjectId);
  const all = list.data ?? [];
  // Each kind's newest resident lead that is not archived; null until one is opened.
  const residentOf = (kind: string) =>
    all
      .filter((s) => s.resident?.kind === kind && !s.archived_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  const residents = view.hiddenTypes?.includes('resident')
    ? []
    : RESIDENTS.map((r) => ({ kind: r.kind, name: r.name, session: residentOf(r.kind) })).filter(
        (r) => !r.session || keptByView(r.session, view),
      );
  const runtimes = [
    ...new Set([...all.map((s) => s.runtime), ...(view.hiddenRuntimes ?? [])]),
  ].sort(compareRuntimes);
  // The project whose list shows only the sessions that need the user; null when none does.
  const [waitingIn, setWaitingIn] = useState<string | null>(null);
  const waitingCount = (list.data ?? []).filter((s) => !s.archived_at && needsAttention(s)).length;
  const waitingOnly = waitingIn !== null && waitingIn === currentProjectId && waitingCount > 0;
  const now = useNow(30_000);
  // Rows keep their order while one has keyboard focus or its menu open.
  const [focused, setFocused] = useState(false);
  const [menuOf, setMenuOf] = useState<string | null>(null);
  const shownId = screen === 'sessions' ? shownSessionId(sessionId, followed, list.data) : null;
  // Without room for two panes side by side only the current one shows.
  const splitRoom = useSplitRoom();
  const leftHidden = useShell((s) => !!s.splitId && s.splitPane === 'right') && !splitRoom;
  const unread = useUnread(currentProjectId, list.data, leftHidden ? null : shownId);
  // The check is a new function each render; the unread ids say when the groups change.
  const unreadIds = (list.data ?? []).filter(unread).map((s) => s.id);
  const fresh = useMemo(
    () =>
      sidebarGroups(
        (list.data ?? []).filter((s) => !s.resident && keptByView(s, view)),
        view,
        unread,
        now,
      ),
    [list.data, view, unreadIds.join('\n'), now],
  );
  const shown = useRef<{ view: SessionListView; groups: SidebarGroup[] } | null>(null);
  const held =
    (focused || (menuOf !== null && !!list.data?.some((s) => s.id === menuOf))) &&
    shown.current?.view === view;
  const ordered = useMemo(
    () => (held ? keepOrder(shown.current!.groups, fresh) : fresh),
    [held, fresh],
  );
  useEffect(() => {
    shown.current = { view, groups: ordered };
  });
  const groups = useMemo(
    () => (waitingOnly ? onlyWaiting(ordered) : ordered),
    [ordered, waitingOnly],
  );
  // Sessions board tasks were opened from, and every listed session's title for the preview.
  const leads = new Set((list.data ?? []).flatMap((s) => (s.lead ? [s.lead] : [])));
  const titleOf = (id: string | undefined) => {
    const found = id ? list.data?.find((s) => s.id === id) : undefined;
    return found && sessionRow(found).title;
  };
  const before = useRef<{ view: SessionListView; groups: SidebarGroup[] } | null>(null);
  useEffect(() => {
    if (!list.data) return;
    const was = before.current?.view === view ? before.current.groups : null;
    setToggled((now) => unfoldEntered(now, was, fresh));
    before.current = { view, groups: fresh };
  }, [fresh]);
  const project = projects.find((p) => p.id === currentProjectId)?.name ?? null;
  const folded = (key: SidebarGroupKey, initial: boolean) => initial !== toggled.has(key);
  // The list's one tab stop: the row or group header last focused.
  const [active, setActive] = useState<string | null>(null);
  // Rows picked with the select key; the keyboard focus moves without changing them.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const stops: {
    key: string;
    group: SidebarGroupKey;
    shut: boolean;
    bare: boolean;
    session: WorkbenchSession | null;
  }[] = [
    ...residents.map((r) => ({
      key: `resident:${r.kind}`,
      group: 'tree' as const,
      shut: false,
      bare: true,
      session: null,
    })),
    ...groups.flatMap((group) => {
      const shut = !group.bare && folded(group.key, group.folded);
      const rows = shut ? [] : group.rows.flatMap((r) => [r.session, ...r.children]);
      const bare = !!group.bare;
      return [
        ...(bare
          ? []
          : [{ key: `group:${group.key}`, group: group.key, shut, bare, session: null }]),
        ...rows.map((session) => ({ key: session.id, group: group.key, shut, bare, session })),
      ];
    }),
  ];
  const visible = stops.flatMap((stop) => (stop.session ? [stop.session] : []));
  const tabStop =
    stops.find((stop) => stop.key === active)?.key ??
    stops.find((stop) => stop.key === shownId)?.key ??
    stops[0]?.key;
  // Opened sessions, newest first; ⌃Tab walks it while ⌃ is held and reorders it on release.
  const recent = useRef<string[]>([]);
  const cycling = useRef<number | null>(null);

  useShortcut('new', () => {
    if (screen !== 'projects' && currentProjectId) {
      useShell.getState().startNewSession();
      return;
    }
    useProjectsView.getState().setOpening(true);
  });

  const toggle = (key: SidebarGroupKey) =>
    setToggled((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  useEffect(() => {
    if (!shownId || cycling.current !== null) return;
    recent.current = [shownId, ...recent.current.filter((id) => id !== shownId)];
  }, [shownId]);

  useEffect(() => {
    const settle = () => {
      if (cycling.current === null) return;
      const id = recent.current[cycling.current]!;
      cycling.current = null;
      recent.current = [id, ...recent.current.filter((other) => other !== id)];
    };
    const release = (e: KeyboardEvent) => {
      if (e.key === 'Control') settle();
    };
    // A window that loses focus never sees ⌃ come up.
    window.addEventListener('keyup', release);
    window.addEventListener('blur', settle);
    return () => {
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', settle);
    };
  }, []);

  const stepRecent = (by: number) => {
    recent.current = recent.current.filter((id) => list.data?.some((s) => s.id === id));
    const n = recent.current.length;
    if (n < 2) return;
    cycling.current = ((cycling.current ?? 0) + by + n) % n;
    useShell.getState().openSession(recent.current[cycling.current]!);
  };

  // The session of the current one of two panes side by side.
  const paneId = () => {
    const { splitId, splitPane } = useShell.getState();
    return splitId && splitPane === 'right' ? splitId : shownId;
  };

  // The row whose menu is open, else a focused row, else the current pane's session.
  const target = () =>
    list.data?.find((s) => s.id === menuOf) ??
    list.data?.find((s) => s.id === (focused ? active : null)) ??
    list.data?.find((s) => s.id === paneId()) ??
    null;

  const listed = currentProjectId !== null;
  useShortcut(
    'session-pin',
    () => {
      const session = target();
      if (!session) return;
      const revision =
        useBoard.getState().board?.sessions.find((s) => s.id === session.id)?.revision ?? null;
      void runCommand(
        'session.pin',
        { session_id: session.id, pinned: !session.pinned_at },
        revision,
      ).then((result) => result.ok || toast({ title: failureText(result.error), kind: 'failure' }));
    },
    listed,
  );
  useShortcut(
    'session-unread',
    () => {
      const session = target();
      if (session) (unread(session) ? markRead : markUnread)(currentProjectId, session);
    },
    listed,
  );
  useShortcut(
    'session-rename',
    () => {
      const session = target();
      if (session && !baselineRow(session)) useShell.getState().renameSession(session.id);
    },
    listed,
  );
  useShortcut(
    'session-number',
    (e) => {
      const session = visible[Number((e?.code || e?.key || '').slice(-1)) - 1];
      if (session) useShell.getState().openSession(session.id);
    },
    listed,
  );
  useShortcut(
    'stop-turn',
    () => {
      const session = list.data?.find((s) => s.id === paneId());
      if (session?.state !== 'running' || session.stopping) return;
      const revision =
        useBoard.getState().board?.sessions.find((s) => s.id === session.id)?.revision ?? null;
      void runCommand('session.interrupt', { session_id: session.id }, revision).then(
        (result) => result.ok || toast({ title: failureText(result.error), kind: 'failure' }),
      );
    },
    listed,
  );
  useShortcut('go-board', () => useShell.getState().setScreen('board'), listed);
  useShortcut('recent-next', () => stepRecent(1), listed);
  useShortcut('recent-back', () => stepRecent(-1), listed);
  // This project's sessions needing attention in list order, then those of the other projects.
  useShortcut('next-attention', () => {
    const mine = fresh
      .flatMap((g) => g.rows.flatMap((r) => [r.session, ...r.children]))
      .filter((s) => !s.archived_at && needsAttention(s))
      .map((s) => ({ projectId: currentProjectId, id: s.id }));
    const others = (allNeeds.items ?? []).flatMap((item) => {
      const id = item.source.table === 'sessions' ? item.source.id : item.session_id;
      return id ? [{ projectId: item.project_id, id }] : [];
    });
    const all = [...mine, ...others].filter(
      (c, i, every) => every.findIndex((d) => d.id === c.id) === i,
    );
    if (all.length === 0) return;
    const at = all.findIndex((c) => c.projectId === currentProjectId && c.id === shownId);
    const next = all[(at + 1) % all.length]!;
    if (next.projectId && next.projectId !== currentProjectId)
      useShell.getState().openProjectSession(next.projectId, next.id);
    else useShell.getState().openSession(next.id);
  });
  // Of this project's sessions that need the user, the one whose needs-you item is oldest; those
  // without an item come after, in list order.
  const openLongestWaiting = () => {
    const since = (id: string) =>
      Math.min(
        ...(allNeeds.items ?? [])
          .filter(
            (item) =>
              item.project_id === currentProjectId &&
              (item.source.table === 'sessions' ? item.source.id : item.session_id) === id,
          )
          .map((item) => item.created_at),
      );
    const [first] = fresh
      .flatMap((g) => g.rows.flatMap((r) => [r.session, ...r.children]))
      .filter((s) => !s.archived_at && needsAttention(s))
      .map((s) => ({ id: s.id, since: since(s.id) }))
      .sort((a, b) => (a.since === b.since ? 0 : a.since - b.since));
    if (first) useShell.getState().openSession(first.id);
  };

  const onListKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const index = stops.findIndex((stop) => stop.key === stopOf(e.target as HTMLElement));
    const here = stops[index];
    if (!here) return;
    const focus = (key: string) => {
      setActive(key);
      for (const el of e.currentTarget.querySelectorAll<HTMLElement>('[data-session],[data-stop]'))
        if (stopOf(el) === key) el.focus();
    };
    const go = (i: number) => {
      const to = stops[i];
      if (to && i !== index) focus(to.key);
    };
    const fold = shortcutMatches('list-fold', e);
    const session = here.session;
    if (shortcutMatches('list-down', e) || shortcutMatches('list-next', e)) go(index + 1);
    else if (shortcutMatches('list-up', e) || shortcutMatches('list-previous', e)) go(index - 1);
    else if (shortcutMatches('list-first', e)) go(0);
    else if (shortcutMatches('list-last', e)) go(stops.length - 1);
    else if (shortcutMatches('list-open', e) && here.session)
      useShell.getState().openSession(here.session.id);
    else if (shortcutMatches('list-select', e) && session)
      setSelected((now) => {
        const next = new Set(now);
        if (!next.delete(session.id)) next.add(session.id);
        return next;
      });
    else if (shortcutMatches('list-unread', e) && session)
      (unread(session) ? markRead : markUnread)(currentProjectId, session);
    // An archived session cannot be snoozed.
    else if (shortcutMatches('list-snooze', e) && session && !session.archived_at) {
      const revision =
        useBoard.getState().board?.sessions.find((s) => s.id === session.id)?.revision ?? null;
      void runCommand(
        'session.snooze',
        { session_id: session.id, snoozed: !session.snoozed_at },
        revision,
      ).then((result) => result.ok || toast({ title: failureText(result.error), kind: 'failure' }));
    } else if (fold || shortcutMatches('list-unfold', e)) {
      if (here.bare) return;
      if (fold !== here.shut) toggle(here.group);
      if (fold) focus(`group:${here.group}`);
    } else return;
    e.preventDefault();
  };

  const peekLater = (ms: number, to: 'open' | 'closing') => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(
      () => setPeek((now) => (to === 'closing' && now === 'shut' ? now : to)),
      ms,
    );
  };
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  useEffect(() => {
    if (peek !== 'open') return;
    const shut = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPeek('closing');
    };
    window.addEventListener('keydown', shut);
    return () => window.removeEventListener('keydown', shut);
  }, [peek]);

  // Unfold and scroll to the group asked for once the list has loaded; only the unfolded list
  // grouped by state has every state group.
  useEffect(() => {
    if (!askedGroup || !list.data) return;
    if (askedGroup === 'inbox') {
      useShell.setState({ sessionGroup: null });
      setWaitingIn(currentProjectId);
      if (layout.collapsed) layout.toggle();
      return;
    }
    // The needs-you filter would hide the group asked for.
    if (waitingIn !== null) {
      setWaitingIn(null);
      return;
    }
    if (view.grouping !== 'state') {
      setView({ ...view, grouping: 'state' });
      return;
    }
    if (layout.collapsed) {
      layout.toggle();
      return;
    }
    useShell.setState({ sessionGroup: null });
    const group = groups.find((g) => g.key === askedGroup);
    if (!group) return;
    if (folded(group.key, group.folded)) toggle(group.key);
    targetRef.current?.scrollIntoView({ block: 'start' });
  }, [askedGroup, list.data, groups, view, layout.collapsed, waitingIn]);

  const { openSession, openSettings, setScreen, startNewSession } = useShell.getState();
  // The count of every project's needs-you items; null when the read failed.
  const attention = allNeeds.error ? null : (allNeeds.items?.length ?? 0);
  const menu = { projects, currentProjectId, onChooseProject, attention };
  // A failed read keeps the last list, so the error goes below it rather than in its place.
  const listError = list.error && <LoadError message={list.error} onRetry={list.reload} />;
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const swatch = currentProject ? (
    <ProjectMonogram id={currentProject.id} name={currentProject.name} />
  ) : (
    <span className="sb-sw" aria-hidden="true" />
  );
  const current = (s: typeof screen) => (screen === s ? 'page' : undefined);
  const allProjects = screen === 'projects';
  // A project window stays on its project: its head names it and nothing switches it.
  const projectWindow = globalThis.window?.pantheon?.windowContext?.().kind === 'project';
  const rowOf = (session: WorkbenchSession, tree?: TreeLine[]) => {
    const number = visible.indexOf(session) + 1;
    return (
      <SessionListRow
        key={session.id}
        session={session}
        tree={tree}
        lead={leads.has(session.id)}
        number={number > 0 && number <= 9 ? number : undefined}
        source={titleOf(session.lead ?? session.forked_from?.session_id)}
        on={session.id === shownId}
        unread={unread(session)}
        selected={selected.has(session.id)}
        now={now}
        tabIndex={session.id === tabStop ? 0 : -1}
        onSelect={() => openSession(session.id)}
        onMenu={(open) => setMenuOf((was) => (open ? session.id : was === session.id ? null : was))}
      />
    );
  };
  const openSettingsHere = () => openSettings(currentProjectId);
  // resident.open returns the open resident of the kind, opening one when there is none.
  const openResident = (kind: (typeof RESIDENTS)[number]['kind']) => {
    if (!currentProjectId) return;
    void runCommand('resident.open', { project_id: currentProjectId, kind }, null).then(
      (result) => {
        if (!result.ok) return toast({ title: failureText(result.error), kind: 'failure' });
        const id = (result.value as { id?: unknown } | null)?.id;
        if (typeof id !== 'string') return;
        setCreatedHere(id);
        openSession(id);
      },
    );
  };
  const residentRow = (r: (typeof residents)[number]) => {
    const s = r.session;
    const key = `resident:${r.kind}`;
    const counts = workerCounts(s ? all.filter((w) => w.lead === s.id && !w.archived_at) : []);
    const waits = s
      ? (allNeeds.items ?? []).filter(
          (item) =>
            item.project_id === currentProjectId &&
            (item.session_id === s.id ||
              (item.source.table === 'sessions' && item.source.id === s.id)),
        ).length
      : 0;
    const name = [
      r.name,
      s
        ? sessionStateLabel(s)
        : t({ id: 'components.sidebar.residentNotStarted', defaultMessage: 'Not started' }),
      ...(counts.running + counts.review + counts.failed > 0 ? [workerCountsText(counts)] : []),
      ...(waits > 0
        ? [
            t(
              {
                id: 'components.sidebar.residentWaits',
                defaultMessage:
                  '{count, plural, one {# item waits for you} other {# items wait for you}}',
              },
              { count: waits },
            ),
          ]
        : []),
    ].join(t({ id: 'sessions.screen.separator', defaultMessage: ', ' }));
    return (
      <button
        key={key}
        type="button"
        className="ss-rr"
        aria-current={(!!s && s.id === shownId) || undefined}
        aria-label={name}
        data-stop={key}
        tabIndex={key === tabStop ? 0 : -1}
        onClick={() => openResident(r.kind)}
      >
        {s ? (
          <SessionStateIcon session={s} place="list" />
        ) : (
          <StateGlyph name="idle" place="list" />
        )}
        <span className="ss-ttl">{r.name}</span>
        <span className="ss-rsum">{workerCountMarks(counts)}</span>
        {waits > 0 && (
          <span className="ss-rct" aria-hidden="true">
            {waits}
          </span>
        )}
      </button>
    );
  };
  // The open sidebar's content; the rail floats it in a panel too.
  const body = () => (
    <>
      <section
        className="sb-pz"
        aria-label={
          allProjects
            ? SCREEN_NAMES.projects
            : t({
                id: 'components.sidebar.currentProject',
                defaultMessage: 'Current project',
              })
        }
      >
        {projectWindow ? (
          <div className="sb-pj sb-fixed">
            {swatch}
            <Clip className="sb-pj-nm" text={project ?? ''} />
          </div>
        ) : (
          <ProjectMenu
            {...menu}
            className={allProjects ? 'sb-pj sb-all' : 'sb-pj'}
            current={current('projects')}
          >
            {allProjects ? (
              <>
                <Columns3 aria-hidden="true" />
                <b>{SCREEN_NAMES.projects}</b>
              </>
            ) : (
              <>
                {swatch}
                <Clip
                  className="sb-pj-nm"
                  text={
                    project ??
                    t({
                      id: 'components.sidebar.chooseProject',
                      defaultMessage: 'Choose a project',
                    })
                  }
                />
                {(attention === null || attention > 0) && (
                  <span
                    className="sb-dot"
                    role="img"
                    aria-label={
                      attention === null
                        ? t({
                            id: 'components.sidebar.attentionFailed',
                            defaultMessage: 'Could not read what other projects need',
                          })
                        : t({
                            id: 'components.sidebar.attention',
                            defaultMessage: 'Projects need you',
                          })
                    }
                  />
                )}
              </>
            )}
            <ChevronDown aria-hidden="true" />
          </ProjectMenu>
        )}
        {allProjects && (
          <ProjectList
            projects={projects}
            currentProjectId={currentProjectId}
            onChooseProject={onChooseProject}
          />
        )}
        {currentProjectId && !allProjects && (
          <>
            <button
              type="button"
              className="sb-it"
              aria-current={current('board')}
              onClick={() => setScreen('board')}
            >
              <LayoutDashboard aria-hidden="true" />
              {SCREEN_NAMES.board}
            </button>
            <button
              type="button"
              className="sb-it"
              aria-current={current('insights')}
              onClick={() => setScreen('insights')}
            >
              <ChartLine aria-hidden="true" />
              {SCREEN_NAMES.insights}
            </button>
            <button
              type="button"
              className="sb-it"
              aria-current={current('repo')}
              onClick={() => setScreen('repo')}
            >
              <GitBranch aria-hidden="true" />
              {SCREEN_NAMES.repo}
            </button>
            <button
              type="button"
              className="sb-it"
              aria-current={current('trace')}
              onClick={() => setScreen('trace')}
            >
              <ChartGantt aria-hidden="true" />
              {SCREEN_NAMES.trace}
            </button>
            <button
              type="button"
              className="sb-it"
              aria-current={current('memory')}
              onClick={() => setScreen('memory')}
            >
              <BookOpen aria-hidden="true" />
              {SCREEN_NAMES.memory}
            </button>
            <div className="sb-sh">
              <span>{t({ id: 'components.sidebar.agents', defaultMessage: 'Agents' })}</span>
              {waitingCount > 0 && (
                <button
                  type="button"
                  className="sb-wait"
                  aria-pressed={waitingOnly}
                  aria-label={t(
                    {
                      id: 'components.sidebar.onlyWaiting',
                      defaultMessage:
                        'Show only the {count, plural, one {# session} other {# sessions}} that need you',
                    },
                    { count: waitingCount },
                  )}
                  onClick={() => {
                    if (!waitingOnly) openLongestWaiting();
                    setWaitingIn(waitingOnly ? null : currentProjectId);
                  }}
                >
                  {waitingCount}
                </button>
              )}
              <ViewMenu view={view} runtimes={runtimes} onChange={setView} />
            </div>
            <nav
              className="ss-list"
              aria-label={SCREEN_NAMES.sessions}
              data-debug-region="sessions.list"
              onFocus={(e) => {
                setFocused(e.target.matches(':focus-visible'));
                const key = stopOf(e.target);
                if (key) setActive(key);
              }}
              onKeyDown={onListKey}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
              }}
            >
              {residents.length > 0 && (
                <div
                  className="ss-grp"
                  role="group"
                  aria-label={t({
                    id: 'components.sidebar.residents',
                    defaultMessage: 'Residents',
                  })}
                >
                  {residents.map(residentRow)}
                </div>
              )}
              <div className="ss-zh">
                <span>{SCREEN_NAMES.sessions}</span>
                <Tip
                  content={t(
                    {
                      id: 'components.sidebar.newSessionTip',
                      defaultMessage: 'New session {keys}',
                    },
                    { keys: keyText(shortcutKeys('new')) },
                  )}
                >
                  <button
                    type="button"
                    className="ib"
                    aria-label={t({
                      id: 'components.sidebar.newSession',
                      defaultMessage: 'New session',
                    })}
                    aria-keyshortcuts="Meta+N"
                    aria-current={(screen === 'sessions' && sessionId === '') || undefined}
                    onClick={startNewSession}
                  >
                    <SquarePen aria-hidden="true" />
                    <KeyHint id="new" />
                  </button>
                </Tip>
              </div>
              {!list.data && listError}
              {!list.data && !list.error && (
                <div className="ss-grp" aria-busy="true">
                  <Skeleton style={{ height: 10, width: '70%', margin: '10px 14px' }} />
                  <Skeleton style={{ height: 10, width: '50%', margin: '0 14px' }} />
                </div>
              )}
              {groups.map((group) => {
                const shut = !group.bare && folded(group.key, group.folded);
                const count = group.rows.reduce((n, row) => n + 1 + row.children.length, 0);
                const rows = (shut ? [] : group.rows).flatMap((row) => {
                  const lines = treeLines(treeDepths(row));
                  return [
                    rowOf(row.session),
                    ...row.children.map((child, i) => rowOf(child, lines[i])),
                  ];
                });
                if (group.bare)
                  return (
                    <div key={group.key} className="ss-grp">
                      {rows}
                    </div>
                  );
                return (
                  <section
                    key={group.key}
                    ref={group.key === askedGroup ? targetRef : undefined}
                    className="ss-grp"
                    aria-label={group.label}
                  >
                    <button
                      type="button"
                      className="ss-gh"
                      aria-expanded={!shut}
                      data-stop={`group:${group.key}`}
                      tabIndex={`group:${group.key}` === tabStop ? 0 : -1}
                      onClick={() => toggle(group.key)}
                    >
                      {group.key === 'pinned' && <Pin className="ic-sm" aria-hidden="true" />}
                      {group.label}
                      <span className="ss-gn">{count}</span>
                      <span className="ss-chev" aria-hidden="true">
                        {shut ? (
                          <ChevronRight className="ic-sm" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="ic-sm" aria-hidden="true" />
                        )}
                      </span>
                    </button>
                    {rows}
                  </section>
                );
              })}
              {list.data && listError}
            </nav>
          </>
        )}
      </section>
      <hr className="sb-sep" />
      <div className="sb-gz">
        <button type="button" className="sb-it" onClick={openSettingsHere}>
          <Settings2 aria-hidden="true" />
          {SCREEN_NAMES.settings}
        </button>
        <Connection side="top" />
      </div>
    </>
  );

  if (layout.collapsed) {
    const icon = (
      label: string,
      tip: string,
      run: () => void,
      glyph: ReactNode,
      extra: { current?: 'page'; keys?: string; disabled?: boolean } = {},
    ) => (
      <Tip content={tip} side="right" disabled={peek === 'open'}>
        <button
          type="button"
          className="ib"
          aria-label={label}
          aria-current={extra.current}
          aria-keyshortcuts={extra.keys}
          disabled={extra.disabled}
          onClick={run}
        >
          {glyph}
        </button>
      </Tip>
    );
    return (
      <aside
        className="sb sb-rail"
        aria-label={t({ id: 'components.sidebar.navigation', defaultMessage: 'Navigation' })}
        data-debug-region="app.sidebar"
        onPointerDownCapture={(e) => {
          if (e.button === 0 && (e.target as Element).classList.contains('split'))
            railDrag.current = true;
        }}
        onPointerOver={(e) => {
          if (e.pointerType === 'touch') return;
          const at = e.target as Element;
          if (peek === 'open' || at.closest('.sb-peek')) clearTimeout(peekTimer.current);
          else if (at.closest('.ib')) peekLater(120, 'open');
          else clearTimeout(peekTimer.current);
        }}
        onPointerLeave={() => {
          if (peek === 'shut') clearTimeout(peekTimer.current);
          else peekLater(200, 'closing');
        }}
      >
        <div className="sb-top" />
        {currentProjectId && !allProjects && (
          <>
            {icon(
              SCREEN_NAMES.board,
              SCREEN_NAMES.board,
              () => setScreen('board'),
              <LayoutDashboard aria-hidden="true" />,
              {
                current: current('board'),
              },
            )}
            {icon(
              SCREEN_NAMES.insights,
              SCREEN_NAMES.insights,
              () => setScreen('insights'),
              <ChartLine aria-hidden="true" />,
              {
                current: current('insights'),
              },
            )}
            {icon(
              SCREEN_NAMES.repo,
              SCREEN_NAMES.repo,
              () => setScreen('repo'),
              <GitBranch aria-hidden="true" />,
              {
                current: current('repo'),
              },
            )}
            {icon(
              SCREEN_NAMES.trace,
              SCREEN_NAMES.trace,
              () => setScreen('trace'),
              <ChartGantt aria-hidden="true" />,
              {
                current: current('trace'),
              },
            )}
            {icon(
              SCREEN_NAMES.memory,
              SCREEN_NAMES.memory,
              () => setScreen('memory'),
              <BookOpen aria-hidden="true" />,
              {
                current: current('memory'),
              },
            )}
            {icon(
              t({ id: 'components.sidebar.newSession', defaultMessage: 'New session' }),
              t(
                { id: 'components.sidebar.newSessionTip', defaultMessage: 'New session {keys}' },
                { keys: keyText(shortcutKeys('new')) },
              ),
              startNewSession,
              <SquarePen aria-hidden="true" />,
              {
                keys: 'Meta+N',
              },
            )}
          </>
        )}
        <div className="sb-rail-end">
          {!projectWindow &&
            icon(
              SCREEN_NAMES.projects,
              SCREEN_NAMES.projects,
              () => setScreen('projects'),
              <>
                <LayoutGrid aria-hidden="true" />
                {attention === null ? (
                  <b aria-hidden="true">—</b>
                ) : (
                  attention > 0 && <b aria-hidden="true" />
                )}
              </>,
              { current: current('projects') },
            )}
          {icon(
            SCREEN_NAMES.settings,
            SCREEN_NAMES.settings,
            openSettingsHere,
            <Settings2 aria-hidden="true" />,
          )}
          <Connection side="right" />
        </div>
        {peek !== 'shut' && (
          <div
            className="sb-peek"
            style={{ width: layout.width }}
            data-ending-style={peek === 'closing' ? '' : undefined}
            // A pick goes somewhere; a fold or a menu trigger keeps the panel.
            onClick={(e) => {
              const hit = (e.target as Element).closest('button');
              if (hit && !hit.hasAttribute('aria-haspopup') && !hit.hasAttribute('aria-expanded'))
                setPeek('closing');
            }}
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget && e.propertyName === 'opacity')
                setPeek((now) => (now === 'closing' ? 'shut' : now));
            }}
          >
            {body()}
          </div>
        )}
        <Splitter
          label={t({ id: 'components.sidebar.resize', defaultMessage: 'Resize sidebar' })}
          value={SIDEBAR.rail}
          min={SIDEBAR.rail}
          max={SIDEBAR.max}
          edge="right"
          // A drag opens the rail past the fold; an arrow step, which never reaches it, opens it too.
          onSize={(width) =>
            layout.resize(
              (railDrag.current ? width >= SIDEBAR.fold : width > SIDEBAR.rail)
                ? Math.max(width, layout.width)
                : width,
            )
          }
          onCommit={() => {
            railDrag.current = false;
            layout.commit();
          }}
          onToggle={layout.toggle}
          onReset={layout.reset}
        />
      </aside>
    );
  }

  return (
    <aside
      className="sb"
      data-debug-region="app.sidebar"
      aria-label={t({ id: 'components.sidebar.navigation', defaultMessage: 'Navigation' })}
      style={{ width: layout.width }}
    >
      <div className="sb-top" />
      {body()}
      <Splitter
        label={t({ id: 'components.sidebar.resize', defaultMessage: 'Resize sidebar' })}
        value={layout.width}
        min={SIDEBAR.min}
        max={SIDEBAR.max}
        edge="right"
        onSize={layout.resize}
        onCommit={layout.commit}
        onToggle={layout.toggle}
        onReset={layout.reset}
      />
    </aside>
  );
}
