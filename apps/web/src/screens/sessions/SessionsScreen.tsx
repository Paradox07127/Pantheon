import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Crown, SquareTerminal, X } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { MenuItem } from '../../components/Menu';
import { PantheonField } from '../../components/PantheonField';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { Splitter } from '../../components/Splitter';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import {
  inspectorIsSheet,
  PANEL_WIDTHS_KEY,
  TERMINAL_HEIGHT_KEY,
  THREAD_MIN,
  useAppearance,
  useFolds,
  useSizeChanges,
} from '../../data/layout';
import type { NeedsYouState } from '../../data/needs-you';
import { effectiveSessionDefaults, useLastProjectDefaults } from '../../data/project-defaults';
import { useSessionDisplay } from '../../data/session-display';
import { useUnread } from '../../data/unread';
import type { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { useShortcut } from '../../lib/shortcuts';
import { scrimFlag } from '../../lib/root-flag';
import { useShell, type SplitPane } from '../../store';
import {
  groupWorkbenchSessions,
  inspectorTabs,
  readInspector,
  referableSessions,
  sessionRow,
  type InspectorPlace,
  type PanelTab,
} from './model';
import {
  dockFit,
  initialWidth,
  PANEL_WIDTH,
  panelOf,
  readPanelWidths,
  type ChangesView,
  type Panel,
} from './inspector-model';
import { appDisplay, useAppDisplay } from './app-display';
import { APP_DOCK_WIDTH, AppDock, AppFullscreen, reloadApp } from './AppPanels';
import { NEW, NewSession } from './NewSession';
import { RUN_MAP_WIDTH, RunMap, spawnedOf } from './RunMap';
import {
  createdHere,
  discardDescription,
  discardKind,
  FIT_MENU,
  noSplitRoom,
  readFailed,
  setCreatedHere,
  setSplitRoom,
  useSessionMenu,
} from './shared';
import { DiscardDialog } from './parts';
import { SessionCard, SessionInspector } from './SessionCard';
import { MoreMenu, PANELS, parentLink, type TerminalToggle } from './SessionHeader';
import { conductorLabel, parentOf } from './session-groups';
import { TerminalPanel } from './TerminalPanel';
import { Thread } from './Thread';
import './split.css';

export { SessionRowButton, SessionListRow } from './SessionRow';
export { ThreadTurn, RequestIndex } from './Thread';
export {
  BaselineReview,
  RequestSlot,
  PermissionCard,
  PlanCard,
  QuestionRequest,
} from './RequestCards';
export { useTurnScope } from './TurnMenu';
export { SessionHeader } from './SessionHeader';
export { SessionCompose } from './SessionCompose';
export { NewSession } from './NewSession';
export { SessionCard, SessionInspector } from './SessionCard';

/**
 * The session the sessions screen shows: the chosen one, else the followed one until it is
 * archived, else the first one of an unfolded group; NEW is the composer, null while the list loads.
 */
export function shownSessionId(
  sessionId: string | null,
  followed: string | null,
  sessions: readonly WorkbenchSession[] | null,
): string | null {
  if (sessionId !== null || !sessions) return sessionId;
  if (sessions.some((s) => s.id === followed && !s.archived_at)) return followed;
  return groupWorkbenchSessions(sessions).find((g) => !g.folded)?.sessions[0]?.id ?? NEW;
}

interface SessionsScreenProps {
  projectId: string | null;
  needs: NeedsYouState;
  list: ReturnType<typeof useSessionList>;
}

export function SessionsScreen({ projectId, needs, list }: SessionsScreenProps) {
  const board = useBoard((s) => s.board);
  const globalDefaults = useLastProjectDefaults();
  // null follows the first open session; NEW is the new-session composer.
  const sessionId = useShell((s) => s.sessionId);
  const restored = useShell((s) => s.sessionRestored);
  const openTab = useShell((s) => s.sessionTab);
  const [places, setPlaces] = useState<Readonly<Record<string, InspectorPlace>>>({});
  const opened = useShell((s) => s.sessionOpened);
  const [widths, setWidths] = useState(storedWidths);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(storedTerminalHeight);
  const { inspector: opening } = useAppearance();
  const folds = useFolds();
  // The main area is never wider or taller than the window; measured once mounted.
  const [main, setMain] = useState(() => window.innerWidth);
  const [tall, setTall] = useState(() => window.innerHeight);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      setMain(el.clientWidth);
      setTall(el.clientHeight);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const sheet = useRef<HTMLDivElement>(null);
  const narrow = inspectorIsSheet(main);
  const sizeChanges = useSizeChanges();
  const seenSizes = useRef(sizeChanges);
  useEffect(() => {
    if (seenSizes.current === sizeChanges) return;
    seenSizes.current = sizeChanges;
    setWidths(storedWidths());
    setTerminalHeight(storedTerminalHeight());
  }, [sizeChanges]);

  useEffect(() => {
    const target = openTab && panelOf(openTab);
    if (!sessionId || !target) return;
    // Panels show beside one session only.
    if (useShell.getState().splitId) useShell.getState().closeSplit('right');
    setPlaces((now) => {
      const place = now[sessionId] ?? storedInspector(sessionId);
      const panels = place.panels ?? [];
      return {
        ...now,
        [sessionId]: {
          ...place,
          // Last, so the dock and the sheet keep it shown.
          panels: [...panels.filter((each) => each !== target.panel), target.panel],
          recent: target.panel,
          ...(target.panel === 'changes' ? { view: target.view ?? 'diff' } : {}),
        },
      };
    });
  }, [opened]);

  const followed = useShell((s) => s.followed);
  const currentId = shownSessionId(sessionId, followed, list.data);
  useEffect(() => {
    useShell.getState().follow(sessionId === null && currentId !== NEW ? currentId : null);
  }, [sessionId, currentId]);
  const current = currentId ? (list.data?.find((s) => s.id === currentId) ?? null) : null;
  const previousList = useRef(list.data);
  useEffect(() => {
    if (
      sessionId &&
      list.data &&
      !list.data.some((session) => session.id === sessionId) &&
      (previousList.current?.some((session) => session.id === sessionId) ||
        (sessionId !== createdHere &&
          !!board &&
          !board.sessions.some((session) => session.id === sessionId)))
    )
      useShell.getState().followFirstSession();
    previousList.current = list.data;
  }, [list.data, sessionId]);
  useEffect(() => {
    if (restored && list.data)
      useShell.getState().checkRestoredSession(list.data.map((session) => session.id));
  }, [restored, list.data]);

  const splitId = useShell((s) => s.splitId) ?? null;
  const splitPane = useShell((s) => s.splitPane) ?? 'left';
  const second = splitId
    ? (list.data?.find((s) => s.id === splitId && !s.archived_at) ?? null)
    : null;
  // The second session was deleted or archived, or became the shown one.
  const splitGone = !!splitId && !!list.data && (!second || splitId === currentId);
  useEffect(() => {
    if (splitGone) useShell.getState().closeSplit('right');
  }, [splitGone]);
  // The dock and full screen show the interfaces of the one session shown alone.
  const appHost =
    currentId !== null &&
    currentId !== NEW &&
    !!current &&
    !(projectId && board && second && !splitGone)
      ? currentId
      : null;
  useEffect(() => appDisplay.getState().host(appHost), [appHost]);
  const appPlace = useAppDisplay((s) => (appHost ? s.places[appHost] : undefined));
  const appCalls = useAppDisplay((s) => (appHost ? s.calls[appHost] : undefined));
  const appCall = appPlace && appCalls?.find((c) => c.item.id === appPlace.call);
  const appDocked = appPlace?.mode === 'pip' && !appPlace.hidden ? appCall : undefined;
  const appFull = appPlace?.mode === 'fullscreen' ? appCall : undefined;
  // The palette's app entries act on the session's newest call with an interface.
  const latestApp = appCalls?.at(-1);
  const placeLatest = (mode: 'pip' | 'fullscreen') =>
    appHost && latestApp && appDisplay.getState().place(appHost, latestApp.item.id, mode);
  useShortcut('app-dock', () => placeLatest('pip'), !!latestApp);
  useShortcut('app-fullscreen', () => placeLatest('fullscreen'), !!latestApp);
  useShortcut(
    'app-reload',
    () => appHost && latestApp && reloadApp(appHost, latestApp.item),
    !!latestApp,
  );
  const twoFit = splitFits(main);
  useEffect(() => setSplitRoom(twoFit), [twoFit]);
  // Each session that shows stays read; without room for two only the current pane shows.
  const split = !!projectId && !!board && !!current && !!second && !splitGone;
  const leftUnread = useUnread(
    projectId,
    list.data,
    !split || twoFit || splitPane === 'left' ? currentId : null,
  );
  const rightUnread = useUnread(
    projectId,
    list.data,
    split && (twoFit || splitPane === 'right') ? splitId : null,
  );
  const unread = (s: WorkbenchSession) => leftUnread(s) && rightUnread(s);
  const groups = groupWorkbenchSessions(list.data ?? [], 'activity', unread);
  const referable = referableSessions(groups);
  const [picking, setPicking] = useState(false);
  const pickAt = useRef<HTMLSpanElement>(null);
  // The project's other open sessions, any of which can show beside the current one.
  const besides = (list.data ?? []).filter((s) => !s.archived_at && s.id !== currentId);
  const splittable = !!current && besides.length > 0;
  const pick = () => twoFit && setPicking(true);
  useShortcut(
    'session-split',
    () => (splitId ? useShell.getState().closeSplit('right') : splittable && pick()),
    !!projectId,
  );

  const showPanel = currentId !== null && currentId !== NEW;
  const place = showPanel ? (places[currentId] ?? storedInspector(currentId)) : {};
  const tabs = inspectorTabs(current);
  const spawned = spawnedOf(current, list.data);
  const runMapShown = showPanel && !narrow && spawned.length > 0;
  const asked = (
    place.panels ??
    ((opening === 'auto' ? !narrow && window.innerWidth >= 1280 : opening === 'always' && !narrow)
      ? [tabs[0]!]
      : [])
  ).filter((tab) => tabs.includes(tab));
  // The thread keeps THREAD_MIN; a sheet shows the newest panel only.
  const room =
    main - THREAD_MIN - (appDocked ? APP_DOCK_WIDTH : 0) - (runMapShown ? RUN_MAP_WIDTH : 0);
  const fit = !showPanel
    ? { panels: [], widths }
    : narrow
      ? { panels: asked.slice(-1), widths }
      : dockFit(asked, widths, room);
  const { panels, widths: shown } = fit;
  const docked = panels.reduce((sum, tab) => sum + shown[tab], 0);
  const overviewStart = useSessionDisplay().overview;
  // The session's own choice, else the one chosen in Session display; as a sheet, like the panels, only once asked.
  const overview = place.overview ?? (overviewStart !== 'off' && !narrow);
  const remember = (next: InspectorPlace) => {
    if (!showPanel) return;
    setPlaces((now) => ({ ...now, [currentId]: next }));
    try {
      localStorage.setItem(inspectorKey(currentId), JSON.stringify(next));
    } catch {
      // The choice still holds until the app closes.
    }
  };
  const openPanel = (tab: PanelTab) => {
    const target = panelOf(tab);
    if (!target) return;
    const view = target.view ?? place.view;
    if (!panels.includes(target.panel) || view !== place.view)
      remember({
        ...place,
        panels: panels.includes(target.panel) ? panels : [...panels, target.panel],
        recent: target.panel,
        ...(view ? { view } : {}),
      });
  };
  const closePanel = (tab: Panel) =>
    remember({ ...place, panels: panels.filter((each) => each !== tab), recent: tab });
  const showView = (view: ChangesView) => remember({ ...place, panels, view });
  const storeWidths = () =>
    setWidths((now) => {
      try {
        localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(now));
      } catch {
        // The widths still hold until the app closes.
      }
      return now;
    });
  const seenFolds = useRef(folds);
  useEffect(() => {
    if (seenFolds.current === folds) return;
    seenFolds.current = folds;
    if (panels.length) remember({ ...place, panels: [] });
  }, [folds]);
  // The terminal needs the desktop app, which runs it through the daemon.
  const terminable = !!window.pantheon && !!projectId && showPanel && !!current;
  const terminalShown = terminable && terminalOpen;
  const terminalMax = Math.max(TERMINAL_HEIGHT.min, tall - TERMINAL_HEIGHT.room);
  const terminalSize = Math.min(terminalMax, terminalHeight);
  const storeTerminalHeight = () =>
    setTerminalHeight((now) => {
      try {
        localStorage.setItem(TERMINAL_HEIGHT_KEY, String(now));
      } catch {
        // The height still holds until the app closes.
      }
      return now;
    });
  const terminalToggle: TerminalToggle = {
    open: terminalOpen,
    busy: terminalBusy,
    onToggle: () => setTerminalOpen((open) => !open),
  };
  const terminalPanel = (projectId: string, listed: WorkbenchSession) => (
    <TerminalPanel
      key={`${projectId}:${listed.id}`}
      projectId={projectId}
      sessionId={!ENDED.has(listed.state) ? listed.id : null}
      ready={listed.state !== 'starting'}
      onBusy={setTerminalBusy}
      onClose={() => {
        setTerminalOpen(false);
        setTerminalBusy(false);
      }}
      grip={
        <Splitter
          label={t({ id: 'sessions.terminal.resize', defaultMessage: 'Resize terminal' })}
          value={terminalSize}
          min={TERMINAL_HEIGHT.min}
          max={terminalMax}
          edge="top"
          onSize={(next) =>
            setTerminalHeight(Math.min(terminalMax, Math.max(TERMINAL_HEIGHT.min, next)))
          }
          onCommit={storeTerminalHeight}
          onToggle={() => setTerminalOpen(false)}
          onReset={() => {
            setTerminalHeight(TERMINAL_HEIGHT.initial);
            storeTerminalHeight();
          }}
        />
      }
    />
  );
  const terminalStyle = terminalShown
    ? ({ '--ss-th': `${terminalSize}px` } as CSSProperties)
    : undefined;
  const boardSession = showPanel ? (board?.sessions.find((s) => s.id === currentId) ?? null) : null;
  const grip = (tab: Panel) => {
    const max = Math.max(PANEL_WIDTH.min, room - docked + shown[tab]);
    return (
      <Splitter
        label={t(
          { id: 'sessions.screen.resizePanel', defaultMessage: 'Resize {panel}' },
          { panel: PANELS[tab].label },
        )}
        value={shown[tab]}
        min={PANEL_WIDTH.min}
        max={max}
        edge="left"
        onSize={(next) =>
          setWidths((now) => ({ ...now, [tab]: Math.min(max, Math.max(PANEL_WIDTH.min, next)) }))
        }
        onCommit={storeWidths}
        onToggle={() => closePanel(tab)}
        onReset={() => {
          setWidths((now) => ({ ...now, [tab]: initialWidth(tab) }));
          storeWidths();
        }}
      />
    );
  };
  const inspector = showPanel && (
    <SessionInspector
      key={currentId}
      sessionId={currentId}
      listed={current}
      session={boardSession}
      panels={panels}
      view={place.view ?? 'diff'}
      sheet={narrow}
      {...(narrow ? {} : { widths: shown, grip })}
      onOpen={openPanel}
      onClose={closePanel}
      onView={showView}
    />
  );
  const overviewable = showPanel;
  // The overview takes the panels' place at the right; showing it closes the panels.
  const overviewShown = overviewable && overview && panels.length === 0;
  const parentIn = (s: WorkbenchSession) =>
    list.data?.find((each) => each.id === parentOf(s) && each.id !== s.id) ?? null;
  const card = overviewShown && (
    <SessionCard
      key={currentId}
      sessionId={currentId}
      listed={current}
      session={boardSession}
      onTab={openPanel}
    />
  );
  const cardDocked = !!card && !narrow;
  const composer = (projectId: string) => (
    <NewSession
      key={`${projectId}:${NEW}`}
      projectId={projectId}
      defaults={effectiveSessionDefaults(
        board?.projects.find((p) => p.id === projectId),
        globalDefaults,
      )}
      focus={opened}
      recent={referable}
      needs={needs.items}
      onCreated={(id) => {
        setCreatedHere(id);
        useShell.getState().openSession(id);
      }}
      onOpen={(id) => useShell.getState().openSession(id)}
      {...(list.data?.length === 0
        ? {}
        : {
            onClose: () => {
              const shell = useShell.getState();
              if (shell.historyIndex > 0) shell.back();
              else shell.followFirstSession();
            },
          })}
    />
  );
  if (projectId && board && current && second && !splitGone) {
    const pane = (side: SplitPane, listed: WorkbenchSession) => (
      <section
        key={listed.id}
        className="sp-pane"
        aria-label={sessionRow(listed).title}
        onPointerDown={() => useShell.getState().focusPane(side)}
        onFocus={() => useShell.getState().focusPane(side)}
      >
        <Thread
          key={listed.id}
          board={board}
          sessionId={listed.id}
          listed={listed}
          needs={needs}
          parent={parentIn(listed)}
          panels={NO_PANELS}
          onPanel={() => {}}
          overview={false}
          onDiscarded={() => useShell.getState().closeSplit(side)}
          head={
            <SplitHead
              listed={listed}
              parent={parentIn(listed)}
              current={side === splitPane}
              renames={side === 'left'}
              onClose={() => useShell.getState().closeSplit(side)}
              onDiscarded={() => useShell.getState().closeSplit(side)}
              {...(terminable && side === splitPane ? { terminal: terminalToggle } : {})}
            />
          }
          active={side === splitPane}
          sessions={referable}
        />
      </section>
    );
    // Without room for two panes only the current one shows, until the window widens again.
    const both = twoFit;
    return (
      <div
        ref={measure}
        className={`ss ss-np${terminalShown ? ' ss-tm' : ''}`}
        style={terminalStyle}
      >
        <main
          className="ss-convo sp"
          aria-label={t({ id: 'sessions.screen.conversation', defaultMessage: 'Conversation' })}
        >
          {(both || splitPane === 'left') && pane('left', current)}
          {(both || splitPane === 'right') && pane('right', second)}
        </main>
        {terminalShown && terminalPanel(projectId, splitPane === 'left' ? current : second)}
      </div>
    );
  }
  const dockShown =
    (inspector && !narrow && panels.length > 0) || appDocked || cardDocked || runMapShown;
  return (
    <div
      ref={measure}
      className={`${dockShown ? 'ss' : 'ss ss-np'}${terminalShown ? ' ss-tm' : ''}`}
      style={
        {
          // The overview's column takes its own width, none while it has nothing to show.
          '--ss-pw': cardDocked
            ? 'auto'
            : `${(narrow ? 0 : docked) + (appDocked ? APP_DOCK_WIDTH : 0) + (runMapShown ? RUN_MAP_WIDTH : 0)}px`,
          ...terminalStyle,
        } as CSSProperties
      }
    >
      <main
        className="ss-convo"
        aria-label={t({ id: 'sessions.screen.conversation', defaultMessage: 'Conversation' })}
        data-docked={dockShown ? '' : undefined}
      >
        {!projectId ? (
          <>
            <div className="ss-head" aria-hidden="true" />
            <div className="empty ss-fill">
              {t({
                id: 'sessions.screen.openProjectFirst',
                defaultMessage: 'Open a project first',
              })}
            </div>
          </>
        ) : currentId === NEW ? (
          <>
            {list.data?.length === 0 && <div className="ss-head" aria-hidden="true" />}
            <div className="ss-home">
              <PantheonField />
              {composer(projectId)}
            </div>
          </>
        ) : currentId === null && list.error ? (
          <div className="ss-fill">{readFailed(list)}</div>
        ) : currentId === null || !board ? (
          <div className="ss-fill" aria-busy="true" />
        ) : (
          // The same section, key and slot as the first split pane, so opening one beside keeps this thread.
          <section key={currentId} className="sp-pane">
            <Thread
              key={currentId}
              board={board}
              sessionId={currentId}
              listed={current}
              needs={needs}
              parent={current ? parentIn(current) : null}
              panels={panels}
              {...(place.recent ? { recent: place.recent } : {})}
              onPanel={(tab) => (panels.includes(tab) ? closePanel(tab) : openPanel(tab))}
              overview={overviewShown}
              {...(overviewable
                ? {
                    onOverview: () =>
                      remember({
                        ...place,
                        panels: overviewShown ? panels : [],
                        overview: !overviewShown,
                      }),
                  }
                : {})}
              onDiscarded={() => useShell.getState().followFirstSession()}
              {...(splittable
                ? { split: { open: pick, ...(twoFit ? {} : { reason: noSplitRoom() }) } }
                : {})}
              sessions={referable}
              {...(terminable ? { terminal: terminalToggle } : {})}
            />
          </section>
        )}
        <span ref={pickAt} className="sp-at" aria-hidden="true" />
        {picking && (
          <Menu.Root open onOpenChange={(open) => open || setPicking(false)}>
            <Menu.Portal>
              <Menu.Positioner
                anchor={pickAt}
                side="bottom"
                align="end"
                sideOffset={4}
                style={{ zIndex: 40 }}
              >
                <Menu.Popup
                  className="mn mn-menu pop"
                  style={FIT_MENU}
                  aria-label={t({
                    id: 'sessions.split.openSession',
                    defaultMessage: 'Open session beside',
                  })}
                >
                  {besides.map((s) => (
                    <MenuItem
                      key={s.id}
                      icon={<SessionStateIcon session={s} place="list" />}
                      onClick={() => {
                        setPicking(false);
                        useShell.getState().openSplit(s.id);
                      }}
                    >
                      {sessionRow(s).title}
                    </MenuItem>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}
      </main>
      {dockShown && (
        <aside
          className="ss-dock"
          data-debug-region="sessions.inspector"
          aria-label={t({ id: 'sessions.header.panels', defaultMessage: 'Panels' })}
        >
          {!narrow && panels.length > 0 && inspector}
          {cardDocked && card}
          {appHost && appDocked && <AppDock sessionId={appHost} call={appDocked} />}
          {runMapShown && projectId && <RunMap projectId={projectId} spawned={spawned} />}
        </aside>
      )}
      {appHost && appFull && current && (
        <AppFullscreen sessionId={appHost} call={appFull} title={sessionRow(current).title} />
      )}
      {inspector && narrow && (
        <Dialog.Root
          open={panels.length > 0 || !!card}
          onOpenChange={(open) =>
            !open && remember({ ...place, panels: [], ...(card ? { overview: false } : {}) })
          }
        >
          <Dialog.Portal>
            {/* Under the sheet; dialogs opened from the sheet put their scrim over it. */}
            <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} style={{ zIndex: 35 }} />
            {/* Focusing the close button would ring it even when a pointer opened the sheet. */}
            <Dialog.Popup
              ref={sheet}
              className="ss-panel ss-sheet"
              data-debug-region="sessions.inspector"
              style={{
                width: Math.min(main, panels.length ? widths[panels[0]!] : PANEL_WIDTH.initial),
              }}
              aria-label={t({ id: 'sessions.screen.details', defaultMessage: 'Details' })}
              initialFocus={sheet}
            >
              {inspector}
              {card}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {terminalShown && terminalPanel(projectId, current)}
    </div>
  );
}

/** The terminal's height in px; the thread above keeps room. */
const TERMINAL_HEIGHT = { initial: 240, min: 120, room: 200 } as const;

/** The listed states of a session that closed, merged or was discarded; its terminal starts in the project. */
const ENDED: ReadonlySet<WorkbenchSession['state']> = new Set(['merged', 'discarded', 'failed']);

function storedTerminalHeight(): number {
  try {
    const stored = Number(localStorage.getItem(TERMINAL_HEIGHT_KEY));
    return stored >= TERMINAL_HEIGHT.min ? stored : TERMINAL_HEIGHT.initial;
  } catch {
    return TERMINAL_HEIGHT.initial;
  }
}

const NO_PANELS: readonly Panel[] = [];

/** The narrowest pane of two sessions side by side, in px. */
const SPLIT_PANE_MIN = 480;

/** Whether the main area has room for two sessions side by side. */
export const splitFits = (main: number): boolean => main >= 2 * SPLIT_PANE_MIN;

/** The head of a pane of two sessions side by side: its state, source, title, actions and close. */
function SplitHead(props: {
  listed: WorkbenchSession;
  parent: WorkbenchSession | null;
  current: boolean;
  /** Takes rename requests, as the session bar does for the shown session. */
  renames: boolean;
  onClose: () => void;
  onDiscarded: () => void;
  /** The terminal under both panes, on the current pane's head only. */
  terminal?: TerminalToggle;
}) {
  const { listed, parent, terminal } = props;
  const title = sessionRow(listed).title;
  const known = useBoard((s) => s.board?.sessions.find((k) => k.id === listed.id) ?? null);
  const close = t({ id: 'sessions.split.close', defaultMessage: 'Close this pane' });
  const terminalLabel = t({ id: 'sessions.terminal.title', defaultMessage: 'Terminal' });
  const discard = discardKind(known, listed);
  const [discarding, setDiscarding] = useState(false);
  const { askRename, dialog } = useSessionMenu(listed, { discard: () => setDiscarding(true) });
  const renaming = useShell((s) => props.renames && s.renaming === listed.id);
  useEffect(() => {
    if (!renaming) return;
    useShell.getState().renameSession(null);
    askRename();
  }, [renaming]);
  return (
    <header className="sp-head" data-current={props.current || undefined}>
      <SessionStateIcon session={listed} place="header" />
      {parent && parentLink(parent, !!listed.spawned_by && !listed.forked_from)}
      {listed.conductor && (
        <Crown className="ic-sm sh-agent" role="img" aria-label={conductorLabel()} />
      )}
      <h2 className="sh-title" title={title}>
        {title}
      </h2>
      <span className="sp-fill" />
      {terminal && (
        <Tip content={terminalLabel}>
          <button
            type="button"
            className="ib sh-term"
            aria-label={
              terminal.busy
                ? t({
                    id: 'sessions.terminal.running',
                    defaultMessage: 'Terminal, a command is running',
                  })
                : terminalLabel
            }
            aria-pressed={terminal.open}
            onClick={terminal.onToggle}
          >
            <SquareTerminal aria-hidden="true" />
            {terminal.busy && <i className="sh-pip" aria-hidden="true" />}
          </button>
        </Tip>
      )}
      <MoreMenu
        session={listed}
        discardable={discard !== null}
        onRename={askRename}
        onDiscard={() => setDiscarding(true)}
      />
      <Tip content={close}>
        <button type="button" className="ib" aria-label={close} onClick={props.onClose}>
          <X aria-hidden="true" />
        </button>
      </Tip>
      {dialog}
      {discard && (
        <DiscardDialog
          open={discarding}
          title={title}
          sessionId={listed.id}
          revision={known?.revision ?? null}
          {...discardDescription(discard)}
          listed={listed}
          onClose={() => setDiscarding(false)}
          onDiscarded={props.onDiscarded}
        />
      )}
    </header>
  );
}

const inspectorKey = (sessionId: string) => `pantheon.inspector.${sessionId}`;

function storedInspector(sessionId: string): InspectorPlace {
  try {
    return readInspector(localStorage.getItem(inspectorKey(sessionId)));
  } catch {
    return {};
  }
}

/** One key for every session: each panel kind keeps its width. */
function storedWidths(): Record<Panel, number> {
  try {
    return readPanelWidths(localStorage.getItem(PANEL_WIDTHS_KEY));
  } catch {
    return readPanelWidths(null);
  }
}
