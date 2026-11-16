import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { BridgeResult, McpAppResource } from '@pantheon/protocol';
import { useBoard } from '../../data/board';
import { appSender, appToolCaller, readAppResource } from '../../data/mcp-app';
import { failureText } from '../../data/needs-you';
import type { ToolItem, ToolState } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { createAppHost, loadAppHost, type AppHostContext } from './host';
import { hostStyles } from './host-styles';
import './app-frame.css';

export type AppDisplayMode = AppHostContext['displayMode'];

const MODES: AppDisplayMode[] = ['inline', 'fullscreen', 'pip'];
const INLINE = { min: 120, initial: 240, max: 800 } as const;

/** The iframe allow attribute; camera, microphone and geolocation are never granted. */
export const appAllow = (permissions: McpAppResource['permissions'] = {}): string =>
  permissions.clipboardWrite ? 'clipboard-write' : '';

/** A click or key press in the frame focuses it and activates this page too, for a few seconds. */
export const frameGesture = (frame: Element | null): boolean =>
  frame !== null && document.activeElement === frame && navigator.userActivation?.isActive === true;

// An https or wss source with nothing that could end the attribute, the directive or the source.
const SOURCE = /^(https|wss):\/\/[^\s;,'"`<>]+$/;
const sources = (domains: string[] = []): string =>
  domains
    .filter((domain) => SOURCE.test(domain))
    .map((domain) => ` ${domain}`)
    .join('');

/** The page with its policy in a meta tag, for a browser with no desktop app to serve it. */
export function appSrcdoc(html: string, csp?: McpAppResource['csp']): string {
  const resource = sources(csp?.resourceDomains);
  const connect = sources(csp?.connectDomains);
  const frame = sources(csp?.frameDomains);
  const base = sources(csp?.baseUriDomains);
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resource}`,
    `style-src 'unsafe-inline'${resource}`,
    `img-src data:${resource}`,
    ...(resource ? [`font-src${resource}`] : []),
    `media-src data:${resource}`,
    `connect-src${connect || " 'none'"}`,
    `frame-src${frame || " 'none'"}`,
    `base-uri${base || " 'none'"}`,
    "object-src 'none'",
  ].join('; ');
  // The doctype keeps the page out of quirks mode; a second one in the page's own HTML is ignored.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
}

/** The height an inline interface asked for, kept between 120 and 800 px; null when it gave none. */
export const inlineHeight = (height: number | undefined): number | null =>
  height === undefined || !Number.isFinite(height)
    ? null
    : Math.round(Math.min(INLINE.max, Math.max(INLINE.min, height)));

/** The tool's own name, without the `mcp__<server>__` prefix Claude gives it. */
export const appToolName = (name: string): string =>
  name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;

// Set by loadAppHost, which resolves before any frame is drawn.
let Transport: typeof PostMessageTransport;

const reads = new Map<string, Promise<BridgeResult<McpAppResource>>>();
const readKey = (session: string, server: string, uri: string) => `${session}\n${server}\n${uri}`;

/** The interface's page, read once per session; a failed read is tried again next time. */
function readCached(session: string, server: string, uri: string) {
  const key = readKey(session, server, uri);
  let read = reads.get(key);
  if (!read) {
    read = readAppResource(session, server, uri).then((result) => {
      if (!result.ok) reads.delete(key);
      return result;
    });
    reads.set(key, read);
  }
  return read;
}

/** Forgets the page read, so the next frame reads it again. */
export const dropAppResource = (session: string, server: string, uri: string) =>
  void reads.delete(readKey(session, server, uri));

const look = (): Pick<AppHostContext, 'theme' | 'styles'> => {
  const root = document.documentElement;
  const tokens = getComputedStyle(root);
  return {
    theme: root.classList.contains('dark') ? 'dark' : 'light',
    styles: { variables: hostStyles((token) => tokens.getPropertyValue(token)) },
  };
};

const dimensions = (mode: AppDisplayMode, el: HTMLElement) =>
  mode === 'inline'
    ? { width: el.clientWidth, maxHeight: INLINE.max }
    : { width: el.clientWidth, height: el.clientHeight };

async function openLink(url: string): Promise<boolean> {
  const bridge = window.pantheon;
  if (bridge) return (await bridge.openLink(url).catch(() => ({ ok: false }))).ok;
  if (!/^(https?|mailto):/i.test(url)) return false;
  window.open(url, '_blank', 'noopener');
  return true;
}

type Page =
  | { attempt: number; resource: McpAppResource; src: { url: string } | { doc: string } }
  | { attempt: number; error: string };

/** The interface of one tool call: its page in a sandboxed frame, told the call's input and result. */
export function AppFrame(props: {
  sessionId: string;
  item: ToolItem;
  state: ToolState;
  mode: AppDisplayMode;
  /** Shows the interface in another mode; the frame of the new mode loads it again. */
  onMode: (mode: AppDisplayMode) => void;
  /** The modes the interface may ask for; by default all three. */
  modes?: AppDisplayMode[];
  /** Drawn over the frame, such as its actions. */
  children?: ReactNode;
}) {
  const { sessionId, item, mode } = props;
  const app = item.app!;
  const tool = appToolName(item.name);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [height, setHeight] = useState<number>(INLINE.initial);
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const host = useRef<ReturnType<typeof createAppHost> | null>(null);
  const onMode = useRef(props.onMode);
  onMode.current = props.onMode;

  useEffect(() => {
    let live = true;
    let served: string | null = null;
    const bridge = window.pantheon;
    void (async () => {
      // The frame waits for the MCP packages, so its host listens before the page's ui/initialize.
      const [read, mcp] = await Promise.all([
        readCached(sessionId, app.server, app.resource_uri),
        loadAppHost(),
      ]);
      Transport = mcp.bridge.PostMessageTransport;
      if (!live) return;
      if (!read.ok) return setPage({ attempt, error: failureText(read.error) });
      const resource = read.value;
      if (!bridge)
        return setPage({ attempt, resource, src: { doc: appSrcdoc(resource.html, resource.csp) } });
      const result = await bridge
        .appServe({ html: resource.html, csp: resource.csp })
        .catch((reason: unknown): BridgeResult<string> => ({
          ok: false,
          error: { code: 'ipc_failed', message: String(reason) },
        }));
      if (!result.ok) {
        if (live) setPage({ attempt, error: failureText(result.error) });
        return;
      }
      if (!live) return void bridge.appRelease(result.value);
      served = result.value;
      setPage({ attempt, resource, src: { url: result.value } });
    })();
    return () => {
      live = false;
      if (served) void bridge?.appRelease(served);
    };
  }, [sessionId, app.server, app.resource_uri, attempt]);

  const ready = page && page.attempt === attempt && 'resource' in page ? page : null;
  // Connected as the frame is inserted, before its page can send ui/initialize.
  useLayoutEffect(() => {
    const view = frame.current?.contentWindow;
    if (!ready || !view || !box.current) return;
    const sender = () => {
      const session = useBoard.getState().board?.sessions.find((s) => s.id === sessionId);
      return appSender(sessionId, session?.state, session?.revision ?? null, app.server);
    };
    const own = createAppHost({
      toolCallId: item.id,
      toolName: tool,
      server: app.server,
      hostContext: {
        ...look(),
        displayMode: mode,
        availableDisplayModes: props.modes ?? MODES,
        containerDimensions: dimensions(mode, box.current),
        locale: currentLocale(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: window.pantheon ? 'desktop' : 'web',
      },
      csp: ready.resource.csp,
      permissions: ready.resource.permissions as Parameters<typeof createAppHost>[0]['permissions'],
      deps: {
        sendMessage: (text) => sender().sendMessage(text),
        setModelContext: (text) => sender().setModelContext(text),
        userGesture: () => frameGesture(frame.current),
        openLink,
        setDisplayMode: (next) => {
          onMode.current(next);
          return next;
        },
        onSize: (_width, next) => {
          const fit = inlineHeight(next);
          if (fit !== null) setHeight(fit);
        },
        ...(ready.resource.tool_calls ? { callTool: appToolCaller(sessionId, app.server) } : {}),
      },
    });
    host.current = own;
    void own.connect(new Transport(view, view)).catch(() => {});
    return () => {
      host.current = null;
      void own.teardown();
    };
  }, [ready]);

  useEffect(() => {
    const own = host.current;
    if (!own) return;
    if (item.input && typeof item.input === 'object')
      own.feed({ input: item.input as Record<string, unknown> });
    if (item.ok !== undefined) own.feed({ result: { ok: item.ok, app_result: item.app_result } });
    else if (props.state === 'none') own.feed({ cancelled: 'The turn ended without a result' });
  }, [ready, item.input, item.ok, item.app_result, props.state]);

  // The app's light or dark look and its tokens change on the root element.
  useEffect(() => {
    const root = document.documentElement;
    let seen = JSON.stringify(look());
    const observer = new MutationObserver(() => {
      const next = look();
      const text = JSON.stringify(next);
      if (text === seen) return;
      seen = text;
      host.current?.setContext(next);
    });
    observer.observe(root, { attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let seen = '';
    const observer = new ResizeObserver(() => {
      const next = dimensions(mode, el);
      const text = JSON.stringify(next);
      if (text === seen) return;
      seen = text;
      host.current?.setContext({ containerDimensions: next });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode]);

  const failed = page && page.attempt === attempt && 'error' in page ? page.error : null;
  const sized = mode === 'inline' ? { height } : undefined;
  const title = t(
    { id: 'components.mcpApp.title', defaultMessage: '{tool} from {server}' },
    { tool, server: app.server },
  );
  return (
    <div
      ref={box}
      className="apf"
      data-mode={mode}
      data-bare={ready?.resource.prefers_border === false || undefined}
    >
      {props.children}
      {ready ? (
        <iframe
          ref={frame}
          className="apf-page"
          style={sized}
          title={title}
          sandbox={'url' in ready.src ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
          allow={appAllow(ready.resource.permissions)}
          {...('url' in ready.src ? { src: ready.src.url } : { srcDoc: ready.src.doc })}
        />
      ) : failed ? (
        <div className="apf-err" role="alert" style={sized}>
          <span className="apf-msg">{failed}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              dropAppResource(sessionId, app.server, app.resource_uri);
              setAttempt((n) => n + 1);
            }}
          >
            {t({ id: 'components.mcpApp.retry', defaultMessage: 'Retry' })}
          </button>
        </div>
      ) : (
        <div className="apf-wait" aria-busy="true" style={sized} />
      )}
    </div>
  );
}
