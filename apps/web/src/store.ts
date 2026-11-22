import { create } from 'zustand';
import type { WorkbenchSession } from '@pantheon/protocol';
import { useBoard } from './data/board';
import {
  currentProject,
  readCurrentProjectId,
  useCurrentProject,
  windowProjectId,
} from './data/current-project';
import { storeQuery } from './data/query-cache';
import { readQuery } from './data/workbench-sessions';
import type { PanelTab, SessionGroupKey } from './screens/sessions/model';
import { navPage, useSettingsView } from './screens/settings/view';
import { shownWindow } from './shell/window-kind';

export type Screen = 'sessions' | 'flow' | 'trace' | 'memory' | 'projects';

export type TraceTab = 'timeline' | 'runs' | 'activity' | 'diagnose' | 'approved';
export type MemoryTab = 'overview' | 'entries' | 'diagrams';

export type Theme = 'light' | 'dark' | 'system';

/** One of the two panes of sessions side by side. */
export type SplitPane = 'left' | 'right';

/** A screen that belongs to one project. */
export type ProjectScreen = Exclude<Screen, 'projects'>;

/** Where the viewer last was in one project. */
export interface ProjectPlace {
  screen: ProjectScreen;
  sessionId: string | null;
}

/** One step of back and forward. */
export interface ShellLocation {
  projectId: string | null;
  screen: Screen;
  sessionId: string | null;
}

const THEME_KEY = 'pantheon.theme';
// Project id → ProjectPlace.
const PLACES_KEY = 'pantheon.projectPlaces';
const HISTORY_LIMIT = 50;
const PROJECT_SCREENS: readonly string[] = ['sessions', 'trace', 'memory'];

/** The stored theme; anything unreadable follows the system. */
export function readTheme(storage?: Pick<Storage, 'getItem'>): Theme {
  try {
    const value = (storage ?? localStorage).getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(theme: Theme, prefersDark: boolean): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return prefersDark ? 'dark' : 'light';
}

/** The sessions when a project was chosen before, else the project picker. */
export function startScreen(storedProjectId: string | null): Screen {
  return storedProjectId ? 'sessions' : 'projects';
}

function readPlaces(): Record<string, ProjectPlace> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PLACES_KEY) ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, ProjectPlace>) : {};
  } catch {
    return {};
  }
}

/** The project's remembered place; the sessions screen when there is none. */
function readPlace(projectId: string): ProjectPlace {
  const place = readPlaces()[projectId];
  const sessionId = typeof place?.sessionId === 'string' ? place.sessionId : null;
  return {
    screen: PROJECT_SCREENS.includes(place?.screen as string) ? place!.screen : 'sessions',
    sessionId,
  };
}

function writePlace(projectId: string, place: ProjectPlace) {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify({ ...readPlaces(), [projectId]: place }));
  } catch {
    // The switch then lands on the sessions, as with no memory.
  }
}

interface ShellState {
  screen: Screen;
  theme: Theme;
  // The Sessions screen's session: null follows the first open session, '' is the new-session composer.
  sessionId: string | null;
  // The session shown while sessionId is null; it stays shown while its group is unfolded.
  followed: string | null;
  // sessionId came from project memory or history and was not yet checked against the list.
  sessionRestored: boolean;
  // The side panel tab to show first for sessionId; null keeps the default tab.
  sessionTab: PanelTab | null;
  // The gate run the checks tab shows first for sessionId; null shows the newest.
  sessionRun: string | null;
  // The session list group to unfold and scroll to; null when none was asked for.
  sessionGroup: SessionGroupKey | null;
  // Counts openings, so opening the same session or the composer again still moves to it.
  sessionOpened: number;
  // The session ⌘⌥R asked to rename: the thread header renames the shown one, its row any other.
  renaming: string | null;
  // The session shown in a right pane beside sessionId's, of the same project; null shows one.
  splitId: string | null;
  // The pane the keys act on; the left one while there is one pane.
  splitPane: SplitPane;
  // Shows the session beside the shown one; nothing while no session or that one is shown.
  openSplit: (sessionId: string) => void;
  // Closing the left pane leaves the right one's session as the only one.
  closeSplit: (pane: SplitPane) => void;
  focusPane: (pane: SplitPane) => void;
  // Places for back and forward, oldest first; historyIndex is the one shown.
  history: ShellLocation[];
  historyIndex: number;
  // The tab the trace and memory pages show; other pages set them before switching there.
  traceTab: TraceTab;
  memoryTab: MemoryTab;
  // The one session the trace's runs tab shows; null shows them all.
  runsSession: string | null;
  runsView: 'now' | 'history';
  // Opens the trace's runs tab on the session, or on every session for null.
  showRuns: (sessionId: string | null) => void;
  setTraceTab: (tab: TraceTab) => void;
  setMemoryTab: (tab: MemoryTab) => void;
  setScreen: (screen: Screen) => void;
  // The current project's sessions; opening a project lands here.
  openSessions: () => void;
  openSession: (sessionId: string, tab?: PanelTab, runId?: string) => void;
  openSessionGroup: (group: SessionGroupKey) => void;
  startNewSession: () => void;
  followFirstSession: () => void;
  follow: (sessionId: string | null) => void;
  // null opens the app settings, or the only project's when there is exactly one.
  openSettings: (projectId: string | null) => void;
  // Makes the project current and returns to where the viewer was in it.
  openProject: (projectId: string) => void;
  // Makes the project current and opens one of its sessions, in one switch.
  openProjectSession: (projectId: string, sessionId: string) => void;
  // Makes the project current and opens its sessions, in one switch.
  openProjectSessions: (projectId: string) => void;
  // Makes the project current and opens one tab of its memory, in one switch.
  openProjectMemory: (projectId: string, tab: MemoryTab) => void;
  // Makes the project current and opens the trace's list of what was approved for the user.
  openProjectApproved: (projectId: string) => void;
  back: () => void;
  forward: () => void;
  // Drops a restored session the project's list no longer has.
  checkRestoredSession: (sessionIds: readonly string[]) => void;
  setTheme: (theme: Theme) => void;
  renameSession: (sessionId: string | null) => void;
}

type ShellPatch = Partial<ShellState> | ((state: ShellState) => Partial<ShellState>);

const sameLocation = (a: ShellLocation | undefined, b: ShellLocation) =>
  a?.projectId === b.projectId && a.screen === b.screen && a.sessionId === b.sessionId;

// The project App shows: the stored one, or the only project when none is stored.
function shownProjectId(): string | null {
  const stored = useCurrentProject.getState().projectId;
  return currentProject(useBoard.getState().board, stored)?.id ?? stored;
}

// Remembers the place in its project and, unless it came from history, adds it to history.
function arrive(fromHistory: boolean) {
  const s = useShell.getState();
  const here: ShellLocation = {
    projectId: shownProjectId(),
    screen: s.screen,
    sessionId: s.sessionId,
  };
  // The places are the main window's; a window of one project leaves them.
  if (here.screen !== 'projects' && here.projectId && !windowProjectId())
    writePlace(here.projectId, {
      screen: here.screen,
      sessionId: here.sessionId,
    });
  if (fromHistory || sameLocation(s.history[s.historyIndex], here)) return;
  // A session window steps only between the sessions opened in it.
  if (shownWindow().kind === 'session' && (here.screen !== 'sessions' || !here.sessionId)) return;
  const history = [...s.history.slice(0, s.historyIndex + 1), here].slice(-HISTORY_LIMIT);
  useShell.setState({ history, historyIndex: history.length - 1 });
}

// Every screen switch goes through here.
function navigate(patch: ShellPatch, projectId: string | null = null, fromHistory = false) {
  const fixed = windowProjectId();
  if (fixed && projectId && projectId !== fixed) {
    // A window of one project shows another project in the main window.
    const { sessionId } = typeof patch === 'function' ? patch(useShell.getState()) : patch;
    void window.pantheon?.showInMainWindow({
      project_id: projectId,
      // '' asks for the new-session composer, so only an absent session is left out.
      ...(typeof sessionId === 'string' ? { session_id: sessionId } : {}),
    });
    return;
  }
  if (projectId) useCurrentProject.getState().choose(projectId);
  useShell.setState(patch);
  const { sessionId, splitId } = useShell.getState();
  if (splitId && splitId === sessionId) useShell.setState(ONE_PANE);
  arrive(fromHistory);
}

const ONE_PANE = { splitId: null, splitPane: 'left' } as const;

function restore(location: ShellLocation): Partial<ShellState> {
  return {
    screen: location.screen,
    sessionId: location.sessionId,
    sessionRestored: true,
    sessionTab: null,
    sessionRun: null,
    sessionGroup: null,
  };
}

function step(by: number) {
  const { history, historyIndex } = useShell.getState();
  const to = historyIndex + by;
  const location = history[to];
  if (!location) return;
  navigate({ ...restore(location), historyIndex: to }, location.projectId, true);
}

// The main window opens on the place last left in its project; other windows on their own start.
async function startLocation(): Promise<ShellLocation> {
  const shown = shownWindow();
  if (shown.kind === 'session')
    return {
      projectId: shown.project_id,
      screen: 'sessions',
      sessionId: shown.session_id,
    };
  const projectId = windowProjectId() ?? readCurrentProjectId();
  const fresh = { projectId, screen: startScreen(projectId), sessionId: null };
  const kind = globalThis.window?.pantheon?.windowContext?.().kind ?? 'main';
  if (!projectId || kind !== 'main' || !readPlaces()[projectId]) return fresh;
  const place = readPlace(projectId);
  if (place.screen !== 'sessions' || !place.sessionId) return { projectId, ...place };
  // A session deleted or archived since, or a list that cannot be read, opens the sessions instead.
  const result = await readQuery('session.list', { project_id: projectId });
  const sessions =
    result.ok && Array.isArray(result.value) ? (result.value as WorkbenchSession[]) : null;
  if (sessions) storeQuery('session.list', projectId, sessions, Date.now());
  return sessions?.some((s) => s.id === place.sessionId && !s.archived_at)
    ? { projectId, ...place }
    : fresh;
}

// The first frame waits for the start place, so it already shows that place.
const start = await startLocation();

export const useShell = create<ShellState>((set) => ({
  screen: start.screen,
  theme: readTheme(),
  sessionId: start.sessionId,
  followed: null,
  // Only a session on the sessions page was checked against the list.
  sessionRestored: start.screen !== 'sessions' && !!start.sessionId,
  sessionTab: null,
  sessionRun: null,
  sessionGroup: null,
  sessionOpened: 0,
  renaming: null,
  ...ONE_PANE,
  history: [start],
  historyIndex: 0,
  traceTab: 'timeline',
  memoryTab: 'overview',
  runsSession: null,
  runsView: 'now',
  showRuns: (runsSession) =>
    navigate({
      screen: 'trace',
      traceTab: 'runs',
      runsSession,
      sessionTab: null,
      sessionRun: null,
      sessionGroup: null,
    }),
  setTraceTab: (traceTab) => set({ traceTab }),
  setMemoryTab: (memoryTab) => set({ memoryTab }),
  setScreen: (screen) =>
    navigate({ screen, sessionTab: null, sessionRun: null, sessionGroup: null }),
  openSessions: () =>
    navigate({
      screen: 'sessions',
      sessionId: null,
      sessionRestored: false,
      sessionTab: null,
      sessionRun: null,
      sessionGroup: null,
    }),
  openSession: (sessionId, tab, runId) =>
    navigate((s) => ({
      screen: 'sessions',
      sessionId,
      sessionRestored: false,
      sessionTab: tab ?? null,
      sessionRun: runId ?? null,
      sessionGroup: null,
      sessionOpened: s.sessionOpened + 1,
    })),
  openSessionGroup: (sessionGroup) =>
    navigate({
      screen: 'sessions',
      sessionId: null,
      sessionRestored: false,
      sessionTab: null,
      sessionRun: null,
      sessionGroup,
    }),
  startNewSession: () =>
    navigate((s) => ({
      screen: 'sessions',
      sessionId: '',
      sessionRestored: false,
      sessionOpened: s.sessionOpened + 1,
    })),
  // With two panes the right one's session stays as the only one.
  followFirstSession: () =>
    set((s) => ({ sessionId: s.splitId, sessionRestored: false, ...ONE_PANE })),
  follow: (followed) => set((s) => (s.followed === followed ? s : { followed })),
  // The settings open as a dialog over the current screen, outside history, the same whichever project is current.
  openSettings: (projectId) =>
    useSettingsView.setState((v) => {
      // Only the default page yields to the project's; openSettingsPage has set any other page before this call.
      const page = projectId && v.page === 'general' ? 'projects' : v.page;
      return {
        open: true,
        page,
        ...(projectId && navPage(page) === 'projects' && { detail: projectId }),
      };
    }),
  openProject: (projectId) => navigate(restore({ projectId, ...readPlace(projectId) }), projectId),
  openProjectSession: (projectId, sessionId) =>
    navigate(
      (s) => ({
        screen: 'sessions',
        sessionId,
        sessionRestored: false,
        sessionTab: null,
        sessionRun: null,
        sessionGroup: null,
        sessionOpened: s.sessionOpened + 1,
      }),
      projectId,
    ),
  openProjectSessions: (projectId) =>
    navigate(
      {
        screen: 'sessions',
        sessionId: null,
        sessionRestored: false,
        sessionTab: null,
        sessionRun: null,
        sessionGroup: null,
      },
      projectId,
    ),
  openProjectMemory: (projectId, memoryTab) =>
    navigate(
      {
        screen: 'memory',
        memoryTab,
        sessionTab: null,
        sessionRun: null,
        sessionGroup: null,
      },
      projectId,
    ),
  openProjectApproved: (projectId) =>
    navigate(
      {
        screen: 'trace',
        traceTab: 'approved',
        sessionTab: null,
        sessionRun: null,
        sessionGroup: null,
      },
      projectId,
    ),
  back: () => step(-1),
  forward: () => step(1),
  checkRestoredSession: (sessionIds) =>
    set((s) =>
      s.sessionRestored
        ? {
            sessionRestored: false,
            sessionId: !s.sessionId || sessionIds.includes(s.sessionId) ? s.sessionId : null,
          }
        : {},
    ),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The choice still applies for this session.
    }
    set({ theme });
  },
  renameSession: (renaming) => set({ renaming }),
  openSplit: (splitId) =>
    navigate((s) => {
      const left = s.sessionId || s.followed;
      return left && left !== splitId
        ? {
            screen: 'sessions',
            sessionId: left,
            sessionRestored: false,
            splitId,
            splitPane: 'right',
          }
        : {};
    }),
  closeSplit: (pane) =>
    pane === 'right'
      ? set(ONE_PANE)
      : navigate((s) =>
          s.splitId ? { sessionId: s.splitId, sessionRestored: false, ...ONE_PANE } : {},
        ),
  focusPane: (splitPane) => set((s) => (s.splitPane === splitPane ? s : { splitPane })),
}));

// Sessions side by side are of one project and two sessions; the runs tab's session is of one project too.
useCurrentProject.subscribe((now, before) => {
  if (now.projectId !== before.projectId) useShell.setState({ ...ONE_PANE, runsSession: null });
});

// Another window stored a theme: this one follows it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY) useShell.setState({ theme: readTheme({ getItem: () => e.newValue }) });
  });
