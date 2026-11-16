import { useEffect, type ReactNode } from 'react';
import { AppWindow, ChevronDown, Maximize, PanelRight, RefreshCw, X } from 'lucide-react';
import { AppFrame, appToolName, dropAppResource } from '../../components/mcp-app/AppFrame';
import { Tip } from '../../components/Tip';
import type { ToolItem } from '../../data/transcript';
import { t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { appDisplay, useAppDisplay, type AppCall } from './app-display';
import './app-panels.css';

/** The width of the docked interface's panel, in px. */
export const APP_DOCK_WIDTH = 400;

/** Loads the call's interface again, page read included, wherever it shows. */
export function reloadApp(sessionId: string, item: ToolItem) {
  if (item.app) dropAppResource(sessionId, item.app.server, item.app.resource_uri);
  appDisplay.getState().reload(item.id);
}

const display = appDisplay.getState;

function Act(props: {
  label: string;
  onClick: () => void;
  /** Marks the full screen button that focus goes back to when full screen ends. */
  full?: string;
  children: ReactNode;
}) {
  return (
    <Tip content={props.label}>
      <button
        type="button"
        className="ib"
        aria-label={props.label}
        data-app-full={props.full}
        onClick={props.onClick}
      >
        {props.children}
      </button>
    </Tip>
  );
}

const dockLabel = () => t({ id: 'sessions.app.dock', defaultMessage: 'Dock to the side' });
const fullLabel = () => t({ id: 'sessions.app.fullscreen', defaultMessage: 'Full screen' });
const frameLabel = (item: ToolItem) =>
  t(
    { id: 'components.mcpApp.title', defaultMessage: '{tool} from {server}' },
    { tool: appToolName(item.name), server: item.app!.server },
  );

/** The interface under its tool call, with its actions while pointed at or focused. */
export function InlineApp(props: {
  sessionId: string;
  call: AppCall;
  /** The sessions screen shows this session's dock and full screen. */
  hosted: boolean;
}) {
  const { sessionId, call } = props;
  const { item } = call;
  const reloads = useAppDisplay((s) => s.reloads[item.id] ?? 0);
  return (
    <div className="apd-in">
      <AppFrame
        key={reloads}
        sessionId={sessionId}
        item={item}
        state={call.state}
        mode="inline"
        modes={props.hosted ? undefined : ['inline']}
        onMode={(mode) => display().place(sessionId, item.id, mode)}
      >
        <div className="apf-hov">
          {props.hosted && (
            <>
              <Act label={dockLabel()} onClick={() => display().place(sessionId, item.id, 'pip')}>
                <PanelRight aria-hidden="true" />
              </Act>
              <Act
                label={fullLabel()}
                full={item.id}
                onClick={() => display().place(sessionId, item.id, 'fullscreen')}
              >
                <Maximize aria-hidden="true" />
              </Act>
            </>
          )}
          <Act
            label={t({ id: 'sessions.app.reload', defaultMessage: 'Reload' })}
            onClick={() => reloadApp(sessionId, item)}
          >
            <RefreshCw aria-hidden="true" />
          </Act>
        </div>
      </AppFrame>
    </div>
  );
}

/** The docked interface: a panel at the right of the conversation. */
export function AppDock(props: { sessionId: string; call: AppCall }) {
  const { sessionId, call } = props;
  const { item } = call;
  const reloads = useAppDisplay((s) => s.reloads[item.id] ?? 0);
  return (
    <section
      className="apd"
      style={{ width: APP_DOCK_WIDTH }}
      aria-label={t({ id: 'sessions.app.docked', defaultMessage: 'Docked app' })}
    >
      <div className="apd-h">
        <AppWindow className="apd-ic" aria-hidden="true" />
        <span className="apd-n">{appToolName(item.name)}</span>
        <span className="apd-s mono">{item.app!.server}</span>
        <span className="apd-acts">
          <Act
            label={t({
              id: 'sessions.app.backToThread',
              defaultMessage: 'Back to the conversation',
            })}
            onClick={() => {
              display().toggleDock(sessionId);
              requestAnimationFrame(() =>
                document
                  .querySelector(`[data-app-call="${CSS.escape(item.id)}"]`)
                  ?.scrollIntoView({ block: 'nearest' }),
              );
            }}
          >
            <ChevronDown aria-hidden="true" />
          </Act>
          <Act
            label={fullLabel()}
            full={item.id}
            onClick={() => display().place(sessionId, item.id, 'fullscreen')}
          >
            <Maximize aria-hidden="true" />
          </Act>
          <Act
            label={t({ id: 'sessions.app.close', defaultMessage: 'Close' })}
            onClick={() => display().place(sessionId, item.id, 'inline')}
          >
            <X aria-hidden="true" />
          </Act>
        </span>
      </div>
      <AppFrame
        key={reloads}
        sessionId={sessionId}
        item={item}
        state={call.state}
        mode="pip"
        onMode={(mode) => display().place(sessionId, item.id, mode)}
      />
    </section>
  );
}

/** The interface over the session's content, until Escape or its exit. */
export function AppFullscreen(props: { sessionId: string; call: AppCall; title: string }) {
  const { sessionId, call } = props;
  const { item } = call;
  const reloads = useAppDisplay((s) => s.reloads[item.id] ?? 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && display().escape(sessionId, e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    // Keys typed inside the interface never reach this window, so focus starts on the exit button.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('.apd-full .apd-bar button')?.focus(),
    );
    return () => {
      window.removeEventListener('keydown', onKey);
      // Focus goes back to the full screen button of the place the interface returns to.
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-app-full="${CSS.escape(item.id)}"]`)?.focus(),
      );
    };
  }, [sessionId, item.id]);
  return (
    <section className="apd-full" aria-label={frameLabel(item)}>
      <header className="apd-bar">
        <Act
          label={t({ id: 'sessions.app.exitFullscreen', defaultMessage: 'Exit full screen' })}
          onClick={() => display().escape(sessionId, 'Escape')}
        >
          <X aria-hidden="true" />
        </Act>
        <AppWindow className="apd-ic" aria-hidden="true" />
        <h2 className="apd-t">{appToolName(item.name)}</h2>
        <span className="apd-s mono">{item.app!.server}</span>
        <span className="apd-st">{props.title}</span>
        <span className="apd-acts">
          <span className="kbd">{keyText('Escape')}</span>
          <Act label={dockLabel()} onClick={() => display().place(sessionId, item.id, 'pip')}>
            <PanelRight aria-hidden="true" />
          </Act>
        </span>
      </header>
      <AppFrame
        key={reloads}
        sessionId={sessionId}
        item={item}
        state={call.state}
        mode="fullscreen"
        onMode={(mode) => display().place(sessionId, item.id, mode)}
      />
    </section>
  );
}
