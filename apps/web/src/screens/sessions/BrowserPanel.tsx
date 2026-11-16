import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import { create } from 'zustand';
import {
  command,
  USER_PRINCIPAL_ID,
  type BrowserBounds,
  type BrowserPage,
  type BrowserRequest,
  type BrowserState,
  type DesktopBridge,
} from '@pantheon/protocol';
import { toast } from '../../components/Toast';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { ipcFailed } from './attachments';
import './browser-panel.css';

/** The page the conversation last asked a session's browser panel to show, until the panel goes to it. */
const useAsked = create<{ asked: { sessionId: string; url: string } | null }>(() => ({
  asked: null,
}));

/** Opens the session's browser panel on the page, or takes the open panel there. */
export function showUrl(sessionId: string, url: string) {
  useAsked.setState({ asked: { sessionId, url } });
  useShell.getState().openSession(sessionId, 'browser');
}

/** The session whose browser panel this window shows, and the id of its page. */
const useShown = create<{ shown: { sessionId: string; id: string } | null }>(() => ({
  shown: null,
}));

// Less than the daemon's 30 s, so the agent hears why rather than a timeout.
const LOAD_WAIT_MS = 25_000;

/** Shows the page in the session's panel and resolves once a load that started after the call stops. */
function loaded(bridge: DesktopBridge, sessionId: string, url: string): Promise<BrowserPage> {
  return new Promise((resolve, reject) => {
    let started: string | null = null;
    const stop = bridge.onBrowserState((state) => {
      if (state.loading) started = state.id;
      else if (state.id === started) {
        end();
        resolve({ url: state.url, title: state.title });
      }
    });
    const timer = setTimeout(() => {
      end();
      reject(new Error(`The page did not load within ${LOAD_WAIT_MS / 1000} seconds`));
    }, LOAD_WAIT_MS);
    const end = () => {
      stop();
      clearTimeout(timer);
    };
    showUrl(sessionId, url);
  });
}

async function browserAnswer(
  bridge: DesktopBridge,
  request: BrowserRequest,
): Promise<{ page: BrowserPage } | { error: { code: string; message: string } }> {
  if (request.action === 'open') {
    const shell = useShell.getState();
    // The window has one browser view; a session the user is not viewing does not take it.
    if (shell.screen !== 'sessions' || shell.sessionId !== request.session_id)
      return {
        error: {
          code: 'browser_busy',
          message:
            'The user is viewing another session, so the browser panel is not yours now; try again later',
        },
      };
    return { page: await loaded(bridge, request.session_id, request.url!) };
  }
  const shown = useShown.getState().shown;
  if (shown?.sessionId !== request.session_id)
    return {
      error: {
        code: 'browser_not_open',
        message: "No page is open in this session's browser panel; open one with browser_open",
      },
    };
  const page =
    request.action === 'read'
      ? bridge.browserRead({ id: shown.id })
      : bridge.browserCapture({ id: shown.id });
  const result = await page.catch(ipcFailed);
  return result.ok
    ? { page: result.value }
    : { error: { code: result.error.code, message: result.error.message } };
}

/** Carries out a session's browser tool call in this window and sends the daemon the answer. */
export async function answerBrowser(bridge: DesktopBridge, request: BrowserRequest) {
  const answer = await browserAnswer(bridge, request).catch((error: unknown) => ({
    error: {
      code: 'browser_failed',
      message: error instanceof Error ? error.message : String(error),
    },
  }));
  const sent = await bridge
    .command(
      command(USER_PRINCIPAL_ID, 'browser.result', {
        request_id: request.request_id,
        ...answer,
      }),
    )
    .catch(ipcFailed);
  if (!sent.ok) toast({ title: failureText(sent.error), kind: 'failure' });
}

const boundsOf = (el: HTMLElement): BrowserBounds => {
  const at = el.getBoundingClientRect();
  return {
    x: Math.round(at.left),
    y: Math.round(at.top),
    width: Math.round(at.width),
    height: Math.round(at.height),
  };
};

/** Base UI dialogs, menus, popovers and select lists; a tooltip or a toast (a non-modal dialog) is not one. */
const POPUPS =
  '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]:not([aria-modal="false"]), [role="menu"], [role="listbox"]';

/** Whether a popup the app portals outside its root lies over the element. */
const covered = (el: HTMLElement): boolean => {
  const at = el.getBoundingClientRect();
  return [...document.body.children].some(
    (child) =>
      !child.contains(el) &&
      [...child.querySelectorAll(POPUPS)].some((node) => {
        const over = node.getBoundingClientRect();
        return (
          over.width > 0 &&
          over.height > 0 &&
          over.left < at.left + at.width &&
          over.left + over.width > at.left &&
          over.top < at.top + at.height &&
          over.top + over.height > at.top
        );
      }),
  );
};

/** The page is painted above the DOM, so it shrinks to nothing while an overlay covers its area. */
const placeOf = (el: HTMLElement): BrowserBounds =>
  covered(el) ? { ...boundsOf(el), width: 0, height: 0 } : boundsOf(el);

/** An address typed without a scheme, such as `localhost:3000`, is an http one. */
const webUrl = (text: string): string =>
  /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`;

/** A web page the desktop app lays over this panel's area; it closes with the panel. */
export function BrowserPanel({
  url = '',
  sessionId,
}: {
  /** The address opened first; empty opens nothing until one is entered. */
  url?: string;
  /** The session whose conversation can ask the panel for a page. */
  sessionId?: string;
}) {
  const bridge = window.pantheon!;
  const view = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(url);
  const [page, setPage] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page the app opened for this window, the address an open still out ends on, the mounts not
  // yet cleaned up, and the address the page last reported.
  const id = useRef<string | null>(null);
  const opening = useRef<string | null>(null);
  const mounted = useRef(0);
  const seen = useRef('');
  const place = useRef(() => {});
  const asked = useAsked((s) =>
    sessionId !== undefined && s.asked?.sessionId === sessionId ? s.asked : null,
  );

  const go = async (target: string): Promise<void> => {
    const el = view.current;
    if (!el) return;
    setError(null);
    if (id.current) {
      const result = await bridge.browserNavigate({ id: id.current, url: target }).catch(ipcFailed);
      if (!result.ok) setError(failureText(result.error));
      return;
    }
    const out = opening.current !== null;
    opening.current = target;
    if (out) return;
    const result = await bridge.browserOpen({ url: target, bounds: placeOf(el) }).catch(ipcFailed);
    const last = opening.current;
    opening.current = null;
    if (!result.ok) return setError(failureText(result.error));
    if (mounted.current === 0) return void bridge.browserClose({ id: result.value.id });
    id.current = result.value.id;
    // The layout may have changed while the page opened.
    place.current();
    if (last !== null && last !== target) await go(last);
  };

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    mounted.current += 1;
    let placed = '';
    place.current = () => {
      if (!id.current) return;
      const bounds = placeOf(el);
      const key = `${id.current} ${JSON.stringify(bounds)}`;
      if (key === placed) return;
      placed = key;
      void bridge.browserSetBounds({ id: id.current, bounds });
    };
    const again = () => place.current();
    const resized = new ResizeObserver(again);
    resized.observe(el);
    // Popups open, move and close inside the containers the app portals to the body.
    const portals = new MutationObserver((records) => {
      if (records.some((record) => record.target === document.body)) watch();
      again();
    });
    const watch = () => {
      portals.disconnect();
      portals.observe(document.body, { childList: true });
      for (const child of document.body.children)
        if (!child.contains(el))
          portals.observe(child, { childList: true, subtree: true, attributes: true });
    };
    watch();
    // The layout moves the panel without resizing it on a window resize, a scroll or a sheet sliding in.
    const moves = ['resize', 'scroll', 'transitionend'];
    for (const kind of moves) window.addEventListener(kind, again, true);
    const stop = bridge.onBrowserState((state) => {
      // A page whose first load failed still reports its id.
      id.current ??= state.id;
      if (state.id !== id.current) return;
      if (sessionId !== undefined) useShown.setState({ shown: { sessionId, id: state.id } });
      if (state.url !== seen.current) {
        seen.current = state.url;
        setAddress(state.url);
      }
      setPage(state);
    });
    // A screen shown again opens the page it showed last.
    const target = seen.current || url;
    if (target && !id.current) void go(target);
    return () => {
      mounted.current -= 1;
      stop();
      resized.disconnect();
      portals.disconnect();
      for (const kind of moves) window.removeEventListener(kind, again, true);
      // A remount right after this cleanup keeps the page.
      queueMicrotask(() => {
        if (mounted.current > 0 || !id.current) return;
        if (useShown.getState().shown?.id === id.current) useShown.setState({ shown: null });
        void bridge.browserClose({ id: id.current });
        id.current = null;
        setPage(null);
      });
    };
  }, []);

  useEffect(() => {
    if (!asked) return;
    useAsked.setState({ asked: null });
    setAddress(asked.url);
    void go(asked.url);
  }, [asked]);

  const act = async (action: 'browserBack' | 'browserForward' | 'browserReload') => {
    if (!id.current) return;
    setError(null);
    const result = await bridge[action]({ id: id.current }).catch(ipcFailed);
    if (!result.ok) setError(failureText(result.error));
  };
  const loading = !!page?.loading;
  const back = t({ id: 'sessions.panel.browser.back', defaultMessage: 'Back' });
  const forward = t({ id: 'sessions.panel.browser.forward', defaultMessage: 'Forward' });
  const reload = loading
    ? t({ id: 'sessions.panel.browser.loading', defaultMessage: 'Loading' })
    : t({ id: 'sessions.panel.browser.reload', defaultMessage: 'Reload' });
  return (
    <div className="brw">
      <div className="brw-bar">
        <button
          type="button"
          className="ib"
          aria-label={back}
          disabled={!page?.can_go_back}
          onClick={() => void act('browserBack')}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={forward}
          disabled={!page?.can_go_forward}
          onClick={() => void act('browserForward')}
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ib"
          aria-label={reload}
          aria-busy={loading || undefined}
          disabled={!page || loading}
          onClick={() => void act('browserReload')}
        >
          <RotateCw aria-hidden="true" />
        </button>
        <div className="field brw-addr">
          <input
            type="text"
            value={address}
            spellCheck={false}
            aria-label={t({ id: 'sessions.panel.browser.address', defaultMessage: 'Address' })}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const text = address.trim();
              if (text) void go(webUrl(text));
            }}
          />
        </div>
      </div>
      {error && (
        <div className="brw-err" role="alert">
          {error}
        </div>
      )}
      <div ref={view} className="brw-view" />
    </div>
  );
}
