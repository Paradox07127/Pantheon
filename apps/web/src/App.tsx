import {
  Activity,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { BackgroundHooks } from './components/BackgroundHooks';
import { CommandPalette } from './components/CommandPalette';
import { DebugView, toggleDebugView } from './components/DebugView';
import type { PaletteItem } from './components/palette';
import { recentActivityTitle } from './components/RecentActivity';
import { RuntimeBanner } from './components/RuntimeBanner';
import { runtimeName } from './components/RuntimeGlyph';
import { sessionStateLabel } from './components/SessionStateIcon';
import { ShortcutSheet } from './components/Shortcuts';
import { Sidebar, useSidebarLayout } from './components/Sidebar';
import { toast, Toasts } from './components/Toast';
import { TitleBarEnd } from './components/TitleBarEnd';
import { ThemeBackdrop, useForcedScheme, useUserTheme } from './components/UserTheme';
import { WindowControls } from './components/WindowControls';
import { useBoard } from './data/board';
import { currentProject, useCurrentProject } from './data/current-project';
import { draftKey, useDrafts } from './data/drafts';
import {
  applyLook,
  applyText,
  foldAll,
  resetLayout,
  setAppearance,
  SIDEBAR,
  setLook,
  toggleTranscript,
  useAccent,
  useAppearance,
  useLook,
  TEXT_PRESETS,
  type Density,
  type Look,
} from './data/layout';
import { failureText, reasonText, useNeedsYou } from './data/needs-you';
import { visibleProjects } from './data/projects';
import { applySessionDisplay, useSessionDisplay } from './data/session-display';
import { useSystemReducedMotion, windowColours, windowDark } from './data/theme';
import { storedUnread } from './data/unread';
import { useSessionList } from './data/workbench-sessions';
import { t } from './i18n';
import { useHeldModifier } from './lib/held-keys';
import { listText } from './lib/list-text';
import { runShortcut, shortcutKeys, SHORTCUTS, useShortcut } from './lib/shortcuts';
import { SCREEN_NAMES } from './screens';
import { BoardScreen, PanelBoundary } from './screens/board/BoardScreen';
import { startBaseline } from './screens/board/project-setup';
import { InsightsScreen } from './screens/insights/InsightsScreen';
import { MemoryScreen } from './screens/memory/MemoryScreen';
import { ProjectsScreen } from './screens/projects/ProjectsScreen';
import { useAppDisplay } from './screens/sessions/app-display';
import { answerBrowser } from './screens/sessions/BrowserPanel';
import { groupWorkbenchSessions, sessionRow } from './screens/sessions/model';
import { RepoScreen } from './screens/repo/RepoScreen';
import { SessionsScreen } from './screens/sessions/SessionsScreen';
import { openBoardTab } from './screens/settings/settings-jump';
import { SettingsDialog } from './screens/settings/SettingsDialog';
import { AddProject } from './screens/projects/AddProject';
import { SETTINGS_PAGES, useSettingsView } from './screens/settings/view';
import { SetupScreen, useShowsSetup } from './screens/setup/SetupScreen';
import { TraceScreen } from './screens/trace/TraceScreen';
import { useMiniWindowPaletteItems } from './shell/MiniWindow';
import { useRecentProject } from './shell/recent-project';
import { SessionWindow } from './shell/SessionWindow';
import { shownWindow } from './shell/window-kind';
import { resolveTheme, useShell, type Screen } from './store';

const NO_PROJECTS: readonly never[] = [];
const KEPT: readonly Screen[] = [
  'sessions',
  'board',
  'insights',
  'repo',
  'trace',
  'memory',
  'projects',
];

/** Whether the screen belongs to a project that is not there. */
export function showsMissingProject(screen: Screen, current: string | null): boolean {
  if (screen === 'projects') return false;
  return current === null;
}

/** The palette's settings pages, except the parts of one project's page, and appearance choices. */
export function settingsPaletteItems(look: Look): PaletteItem[] {
  const action = (id: string, label: string, run: () => void, keys?: string): PaletteItem => ({
    id,
    group: 'action',
    label,
    keys,
    run,
  });
  const setTheme = useShell.getState().setTheme;
  const densities: Record<Density, string> = {
    standard: t({ id: 'app.palette.densityStandard', defaultMessage: 'Density: standard' }),
    compact: t({ id: 'app.palette.densityCompact', defaultMessage: 'Density: compact' }),
  };
  const chatFonts: Record<keyof typeof TEXT_PRESETS, string> = {
    small: t({ id: 'app.palette.chatFontSmall', defaultMessage: 'Text size: small' }),
    standard: t({ id: 'app.palette.chatFontStandard', defaultMessage: 'Text size: standard' }),
    large: t({ id: 'app.palette.chatFontLarge', defaultMessage: 'Text size: large' }),
  };
  return [
    ...SETTINGS_PAGES.filter((p) => p.group !== 'project').map((p): PaletteItem => ({
      id: `settings-${p.key}`,
      group: 'screen',
      label: t(
        { id: 'app.palette.settingsPage', defaultMessage: 'Settings: {page}' },
        { page: p.label },
      ),
      run: () => {
        useSettingsView.getState().setPage(p.key);
        useShell.getState().openSettings(null);
      },
    })),
    action('theme-light', t({ id: 'app.palette.themeLight', defaultMessage: 'Light theme' }), () =>
      setTheme('light'),
    ),
    action('theme-dark', t({ id: 'app.palette.themeDark', defaultMessage: 'Dark theme' }), () =>
      setTheme('dark'),
    ),
    action(
      'theme-system',
      t({ id: 'app.palette.themeSystem', defaultMessage: 'Match system' }),
      () => setTheme('system'),
    ),
    ...(['standard', 'compact'] as const).map((density) =>
      action(`density-${density}`, densities[density], () => setAppearance({ density })),
    ),
    ...(['small', 'standard', 'large'] as const).map((size) =>
      action(`chat-font-${size}`, chatFonts[size], () =>
        setAppearance({ chat_font: TEXT_PRESETS[size] }),
      ),
    ),
    ...[12, 13, 14].map((code_font) =>
      action(
        `code-font-${code_font}`,
        t(
          { id: 'app.palette.codeFont', defaultMessage: 'Code text size: {size}' },
          { size: code_font },
        ),
        () => setLook({ code_font }),
      ),
    ),
    action(
      'transcript',
      look.transcript === 'expanded'
        ? t({ id: 'app.palette.foldTranscript', defaultMessage: 'Fold transcript' })
        : t({ id: 'app.palette.expandTranscript', defaultMessage: 'Expand transcript' }),
      toggleTranscript,
      shortcutKeys('transcript') || undefined,
    ),
    action(
      'next-attention',
      t({ id: 'lib.shortcuts.label.nextAttention', defaultMessage: 'Next session that needs you' }),
      () => void runShortcut('next-attention'),
      shortcutKeys('next-attention') || undefined,
    ),
    action(
      'colorblind',
      look.colorblind
        ? t({ id: 'app.palette.standardColours', defaultMessage: 'Use standard colours' })
        : t({
            id: 'app.palette.colorblindColours',
            defaultMessage: 'Use colour-blind friendly colours',
          }),
      () => setLook({ colorblind: !look.colorblind }),
    ),
    action(
      'motion',
      look.motion === 'reduced'
        ? t({ id: 'app.palette.standardMotion', defaultMessage: 'Standard motion' })
        : t({ id: 'app.palette.reduceMotion', defaultMessage: 'Reduce motion' }),
      () => setLook({ motion: look.motion === 'reduced' ? 'system' : 'reduced' }),
    ),
  ];
}

/** A session in the palette: its state glyph, its title, then its state and runtime. */
export function sessionPaletteItem(
  session: WorkbenchSession,
  open: (sessionId: string) => void,
): PaletteItem {
  return {
    id: `session-${session.id}`,
    group: 'session',
    label: sessionRow(session).title,
    sub: listText(sessionStateLabel(session), runtimeName(session.runtime)),
    session,
    run: () => open(session.id),
  };
}

/** Puts the text into the project's new-session composer, then opens it. */
export function paletteNewSession(projectId: string, text: string, start: () => void) {
  useDrafts.getState().put(draftKey(projectId, null), { text, attachments: [], skills: [] });
  start();
}

export function App() {
  // A window keeps what it shows for its whole life.
  const [shown] = useState(shownWindow);
  const theme = useShell((s) => s.theme);
  const appearance = useAppearance();
  const { density, reading_width: readingWidth } = appearance;
  const look = useLook();
  const systemReduced = useSystemReducedMotion();
  const display = useSessionDisplay();
  const userTheme = useUserTheme();
  // A saved theme that gives one scheme holds the window in it, leaving the stored choice as it is.
  const forced = useForcedScheme();
  const accent = useAccent();

  useEffect(() => {
    // The main window carries out the sessions' browser tool calls in its browser panel.
    const bridge = window.pantheon;
    useBoard
      .getState()
      .start(
        undefined,
        shown.kind === 'main' && bridge
          ? (request) => void answerBrowser(bridge, request)
          : undefined,
      );
    return () => useBoard.getState().stop();
  }, []);

  // The theme's and the accent's tokens are on the root by now, so the colours read are the ones shown.
  useLayoutEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = windowDark(resolveTheme(theme, query.matches), forced);
      document.documentElement.classList.toggle('dark', dark);
      void window.pantheon?.setTitleBarTheme?.({ dark, ...windowColours() }).catch(() => {});
    };
    apply();
    if (theme !== 'system' || forced) return;
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme, forced, userTheme, accent]);

  // The body is the .pt shell.
  useLayoutEffect(() => {
    document.body.dataset.density = density;
  }, [density]);
  // The type scale is worked out on the root, so its size goes there.
  useLayoutEffect(() => {
    applyText(appearance, document.documentElement.style);
  }, [appearance.chat_font, appearance.line_height]);
  useLayoutEffect(() => {
    document.body.style.setProperty(
      '--read-w',
      readingWidth === 'none' ? 'none' : `${readingWidth}px`,
    );
  }, [readingWidth]);
  useLayoutEffect(() => {
    applyLook(look, document.body, systemReduced);
  }, [look, systemReduced]);
  useLayoutEffect(() => {
    applySessionDisplay(display, document.body.dataset);
  }, [display]);

  useHeldModifier();
  useShortcut('transcript', toggleTranscript);

  return shown.kind === 'session' ? (
    <SessionShell project_id={shown.project_id} session_id={shown.session_id} />
  ) : (
    <MainWindow kind={shown.kind} />
  );
}

/** A session window, with the command palette, the shortcut sheet and the steps back and forward its menu and keys run. */
function SessionShell({ project_id, session_id }: { project_id: string; session_id: string }) {
  const back = useShell((s) => s.back);
  const forward = useShell((s) => s.forward);
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const look = useLook();
  const root = useBoard((s) => s.board?.projects.find((p) => p.id === project_id)?.roots[0]);
  const miniWindowItems = useMiniWindowPaletteItems(palette);
  // Settings, other screens, sessions and the sidebar are the main window's, so only its actions are offered.
  const paletteItems = useMemo(
    () =>
      palette
        ? [
            ...miniWindowItems,
            ...settingsPaletteItems(look).filter(
              (item) => item.group === 'action' && item.id !== 'next-attention',
            ),
          ]
        : [],
    [palette, look, miniWindowItems],
  );
  useShortcut('palette', () => setPalette((now) => !now));
  useShortcut('shortcuts', () => setSheet((now) => !now));
  useShortcut('back', back);
  useShortcut('forward', forward);
  return (
    <>
      <SessionWindow project_id={project_id} session_id={session_id} />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        items={paletteItems}
        fileSearch={{ projectId: project_id, root }}
        navigable={false}
      />
      <ShortcutSheet open={sheet} onOpenChange={setSheet} />
    </>
  );
}

/** The whole app, or in a project window the whole of one project. */
function MainWindow({ kind }: { kind: 'main' | 'project' }) {
  const {
    screen,
    setScreen,
    setTraceTab,
    openSession,
    openSettings,
    openProject,
    openProjectSession,
    startNewSession,
    back,
    forward,
    history,
  } = useShell();
  const storedProject = useCurrentProject((state) => state.projectId);
  const allProjects = useBoard((state) => state.board?.projects ?? NO_PROJECTS);
  const projects = useMemo(() => visibleProjects(allProjects), [allProjects]);
  const loaded = useBoard((state) => state.board !== null);
  const showsSetup = useShowsSetup(loaded, allProjects.length);
  const mismatch = useBoard(
    (state) => state.status.state === 'offline' && state.status.protocol_mismatch === true,
  );
  const current = useBoard((state) => currentProject(state.board, storedProject)?.id ?? null);
  const currentRoot = allProjects.find((p) => p.id === current)?.roots[0];
  useRecentProject(kind);
  // The sessions page answers a pending request through its needs-you item.
  const needs = useNeedsYou(current);
  const allNeeds = useNeedsYou(null);
  const list = useSessionList(current);
  const layout = useSidebarLayout();
  const look = useLook();
  const [palette, setPalette] = useState(false);
  const [sheet, setSheet] = useState(false);
  const miniWindowItems = useMiniWindowPaletteItems(palette);
  // The shown session has a tool call with an interface for the app entries to act on.
  const appShown = useAppDisplay((s) => !!s.hosted && !!s.calls[s.hosted]?.length);
  // The screens shown in this project stay mounted, hidden, so a switch back keeps their state.
  const [kept, setKept] = useState<{ project: string | null; screens: readonly Screen[] }>({
    project: current,
    screens: [],
  });
  const keptBefore = kept.project === current ? kept.screens : [];
  const keptScreens =
    KEPT.includes(screen) && !keptBefore.includes(screen) ? [...keptBefore, screen] : keptBefore;
  if (kept.project !== current || keptScreens !== kept.screens)
    setKept({ project: current, screens: keptScreens });
  const action = (id: string, label: string, run: () => void, keys?: string): PaletteItem => ({
    id,
    group: 'action',
    label,
    keys,
    run,
  });
  const page = (id: string, label: string, run: () => void, keys?: string): PaletteItem => ({
    id,
    group: 'screen',
    label,
    keys,
    run,
  });
  // The palette's items are built only while it is open.
  const paletteItems = useMemo(
    (): PaletteItem[] =>
      palette
        ? [
            ...(current
              ? [
                  action(
                    'new-session',
                    t({ id: 'app.palette.newSession', defaultMessage: 'New session' }),
                    startNewSession,
                    shortcutKeys('new'),
                  ),
                ]
              : []),
            action(
              'toggle-sidebar',
              layout.collapsed
                ? t({ id: 'app.palette.expandSidebar', defaultMessage: 'Expand sidebar' })
                : t({ id: 'app.palette.collapseSidebar', defaultMessage: 'Collapse sidebar' }),
              layout.toggle,
              shortcutKeys('sidebar'),
            ),
            action(
              'fold-panes',
              t({ id: 'app.palette.foldPanes', defaultMessage: 'Collapse all side panes' }),
              foldAll,
            ),
            action(
              'reset-layout',
              t({ id: 'app.palette.resetLayout', defaultMessage: 'Reset layout' }),
              resetLayout,
            ),
            action(
              'debug-view',
              SHORTCUTS.find((s) => s.id === 'debug-view')!.label,
              toggleDebugView,
              shortcutKeys('debug-view') || undefined,
            ),
            ...(current
              ? [page('screen-board', SCREEN_NAMES.board, () => setScreen('board'))]
              : []),
            ...(current
              ? [page('screen-insights', SCREEN_NAMES.insights, () => setScreen('insights'))]
              : []),
            ...(current ? [page('screen-repo', SCREEN_NAMES.repo, () => setScreen('repo'))] : []),
            ...(current
              ? [
                  page(
                    'screen-retro',
                    t({ id: 'board.panels.retro', defaultMessage: 'Retrospectives' }),
                    () => openBoardTab('retro'),
                  ),
                ]
              : []),
            ...(current
              ? [
                  action(
                    'build-baseline',
                    t({ id: 'board.baseline.start', defaultMessage: 'Build baseline' }),
                    () => void startBaseline(current),
                  ),
                ]
              : []),
            ...(current
              ? [
                  action(
                    'draw-chart',
                    t({ id: 'app.palette.drawChart', defaultMessage: 'Draw a chart' }),
                    startNewSession,
                  ),
                ]
              : []),
            ...(current
              ? [page('screen-trace', SCREEN_NAMES.trace, () => setScreen('trace'))]
              : []),
            ...(current
              ? [page('screen-memory', SCREEN_NAMES.memory, () => setScreen('memory'))]
              : []),
            ...(current
              ? [
                  action('recent-activity', recentActivityTitle(), () => {
                    setTraceTab('activity');
                    setScreen('trace');
                  }),
                ]
              : []),
            ...(screen === 'sessions' && appShown
              ? (['app-dock', 'app-fullscreen', 'app-reload'] as const).map((id) =>
                  action(
                    id,
                    SHORTCUTS.find((s) => s.id === id)!.label,
                    () => void runShortcut(id),
                    shortcutKeys(id) || undefined,
                  ),
                )
              : []),
            ...miniWindowItems,
            page('screen-projects', SCREEN_NAMES.projects, () => setScreen('projects')),
            page(
              'screen-settings',
              SCREEN_NAMES.settings,
              () => openSettings(current),
              shortcutKeys('settings'),
            ),
            ...settingsPaletteItems(look),
            ...groupWorkbenchSessions(list.data ?? [], 'activity', storedUnread(current))
              .flatMap((g) => g.sessions)
              .map((s) => sessionPaletteItem(s, openSession)),
          ]
        : [],
    [palette, current, layout.collapsed, look, list.data, miniWindowItems, screen, appShown],
  );
  const recent = useMemo(
    () =>
      palette
        ? [
            ...new Set(
              history
                .filter((place) => place.screen === 'sessions' && place.sessionId)
                .map((place) => `session-${place.sessionId}`)
                .reverse(),
            ),
          ]
        : [],
    [palette, history],
  );

  // A remembered project that was removed leaves its screen for the project picker.
  useEffect(() => {
    if (loaded && showsMissingProject(screen, current)) setScreen('projects');
  }, [loaded, screen, current]);

  // Another window asks this one to show a place, or the menu to open the project in a window.
  useEffect(
    () =>
      window.pantheon?.onShowInMainWindow(({ project_id, session_id }) =>
        session_id === undefined
          ? openProject(project_id)
          : openProjectSession(project_id, session_id),
      ),
    [],
  );
  useEffect(() => {
    if (!current) return;
    return window.pantheon?.onNewWindowRequest(
      () =>
        void window.pantheon
          ?.openWindow({ kind: 'project', project_id: current })
          .then((opened) => {
            if (!opened.ok) toast({ title: failureText(opened.error), kind: 'failure' });
          }),
    );
  }, [current]);

  useShortcut('palette', () => setPalette((now) => !now));
  useShortcut('shortcuts', () => setSheet((now) => !now));
  useShortcut('back', back);
  useShortcut('forward', forward);
  useShortcut('debug-view', toggleDebugView);

  const main = useRef<HTMLDivElement>(null);
  // A kept screen leaves display:none here, which would run every entrance transition in it again.
  useLayoutEffect(() => {
    const el = main.current!;
    el.setAttribute('data-switching', '');
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => el.removeAttribute('data-switching'));
    });
    return () => cancelAnimationFrame(frame);
  }, [screen]);

  if (showsSetup)
    return (
      <div className="app sb-off app-setup">
        <div className="app-main" ref={main}>
          <SetupScreen />
        </div>
      </div>
    );

  return (
    <div
      className={layout.collapsed ? 'app sb-off' : 'app'}
      // The content's left edge: the open sidebar's width, or the rail and the 8px gap.
      style={
        { '--main-x': `${layout.collapsed ? SIDEBAR.rail + 8 : layout.width}px` } as CSSProperties
      }
    >
      <ThemeBackdrop />
      <div className="app-drag" aria-hidden="true" />
      <Sidebar
        layout={layout}
        projects={projects}
        currentProjectId={current}
        onChooseProject={openProject}
        list={list}
        allNeeds={allNeeds}
      />
      <div className="app-main" ref={main}>
        <RuntimeBanner />
        {KEPT.filter((s) => keptScreens.includes(s)).map((s) => (
          <Activity key={s} mode={s === screen ? 'visible' : 'hidden'}>
            {/* Showing the screen again clears its failure, so it mounts afresh. */}
            <PanelBoundary model={s === screen}>
              {s === 'sessions' ? (
                <SessionsScreen projectId={current} needs={needs} list={list} />
              ) : s === 'board' ? (
                <BoardScreen projectId={current} onOpenSession={openSession} />
              ) : s === 'insights' ? (
                <InsightsScreen projectId={current} onOpenSession={openSession} />
              ) : s === 'repo' ? (
                <RepoScreen projectId={current} onOpenSession={openSession} />
              ) : s === 'trace' ? (
                <TraceScreen projectId={current} sessions={list.data} />
              ) : s === 'memory' ? (
                <MemoryScreen projectId={current} />
              ) : (
                <ProjectsScreen onOpenSettings={openSettings} onOpenProject={openProject} />
              )}
            </PanelBoundary>
          </Activity>
        ))}
        {mismatch && (
          <p className="app-banner" role="alert">
            {reasonText('protocol_mismatch')}
          </p>
        )}
      </div>
      <WindowControls
        collapsed={layout.collapsed}
        onToggle={layout.toggle}
        onSearch={() => setPalette(true)}
      />
      <TitleBarEnd needs={allNeeds.items ?? []} />
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        items={paletteItems}
        recent={recent}
        fileSearch={current ? { projectId: current, root: currentRoot } : undefined}
        onNewSession={
          current ? (text) => paletteNewSession(current, text, startNewSession) : undefined
        }
      />
      <ShortcutSheet open={sheet} onOpenChange={setSheet} />
      <SettingsDialog />
      <AddProject projects={allProjects} onOpened={openProject} />
      <DebugView />
      <Toasts />
      {/* Notice cards, the badge, keeping awake and queued sends run once, in the main window. */}
      {kind === 'main' && (
        <BackgroundHooks projectId={current} sessions={list.data} allNeeds={allNeeds.items} />
      )}
    </div>
  );
}
