import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Terminal as Xterm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { SquareTerminal, X } from 'lucide-react';
import {
  command,
  USER_PRINCIPAL_ID,
  type BridgeResult,
  type CommandType,
} from '@pantheon/protocol';
import { token, useThemeTick } from '../../components/visual/shared';
import { useLook } from '../../data/layout';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { fail } from './shared';
import './terminal-panel.css';

/** The terminal of each project and session, kept while its process runs so the panel can show it again. */
const opened = new Map<string, string>();
/** The open still in flight for each project and session; the close button drops it, and its terminal is closed when it lands. */
const opening = new Map<string, Promise<BridgeResult<unknown>>>();

// The daemon's bounds of a terminal's size.
const size = (term: Xterm) => ({
  cols: Math.min(500, Math.max(20, term.cols)),
  rows: Math.min(200, Math.max(5, term.rows)),
});

const colors = (at: Element) => ({
  background: token(at, '--term'),
  foreground: token(at, '--term-tx'),
  cursor: token(at, '--term-tx'),
});

// Terminal commands leave the board alone, so they skip runCommand's refresh.
const send = (type: CommandType, input: Record<string, unknown>): Promise<BridgeResult<unknown>> =>
  window.pantheon!.command(command(USER_PRINCIPAL_ID, type, input)).catch(fail);

// terminal.write takes at most 64 KiB of UTF-8; a split never falls inside a surrogate pair.
const pieces = (data: string) => {
  const out: string[] = [];
  let from = 0,
    bytes = 0;
  for (let i = 0; i < data.length;) {
    const code = data.codePointAt(i)!;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > 64 * 1024) {
      out.push(data.slice(from, i));
      from = i;
      bytes = 0;
    }
    bytes += width;
    i += code > 0xffff ? 2 : 1;
  }
  out.push(data.slice(from));
  return out;
};

export interface TerminalPanelProps {
  projectId: string;
  /** The session whose worktree the shell starts in; null starts it in the project. */
  sessionId: string | null;
  /** False while the session's worktree is being made; the shell opens once it is ready. */
  ready?: boolean;
  /** True on output, false once the terminal has been quiet for a second. */
  onBusy?: (busy: boolean) => void;
  /** The close button closed the terminal. */
  onClose: () => void;
  /** The splitter on the panel's top edge. */
  grip?: ReactNode;
}

/** A shell of the project or session's worktree, run by the daemon and drawn with xterm. */
export function TerminalPanel({
  projectId,
  sessionId,
  ready = true,
  onBusy,
  onClose,
  grip,
}: TerminalPanelProps) {
  const box = useRef<HTMLDivElement>(null);
  const xterm = useRef<Xterm | null>(null);
  const terminalId = useRef<string | null>(null);
  const busy = useRef(onBusy);
  busy.current = onBusy;
  const [error, setError] = useState<string | null>(null);
  const [exit, setExit] = useState<number | null>(null);
  const [lost, setLost] = useState(false);
  const [refused, setRefused] = useState(false);
  // Counts the reopens; each one starts a new terminal.
  const [attempt, setAttempt] = useState(0);
  const key = `${projectId}:${sessionId ?? ''}`;
  const fontSize = useLook().code_font;
  const font = useRef(fontSize);
  font.current = fontSize;
  // Fits the grid to the box again and sends the new size; set while a terminal is open.
  const refit = useRef<(() => void) | null>(null);

  useEffect(() => {
    // What the panel says is of one terminal; another place or a reopen starts without it.
    setError(null);
    setExit(null);
    setLost(false);
    setRefused(false);
    const at = box.current;
    if (!at || !window.pantheon || !ready) return;
    const bridge = window.pantheon;
    let stop: (() => void) | undefined,
      gone = false;
    // xterm loads with the first terminal, by which time the panel may be gone.
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (gone) return;
        const term = new Terminal({
          fontFamily: token(at, '--font-mono'),
          fontSize: font.current,
          cursorBlink: true,
          screenReaderMode: true,
          theme: colors(at),
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(at);
        fit.fit();
        xterm.current = term;
        let live = true,
          end: (() => void) | undefined,
          quiet: ReturnType<typeof setTimeout> | undefined,
          sent = size(term);
        const output = (data: Uint8Array) => {
          term.write(data);
          if (quiet === undefined) busy.current?.(true);
          clearTimeout(quiet);
          quiet = setTimeout(() => {
            quiet = undefined;
            busy.current?.(false);
          }, 1000);
        };
        const start = async () => {
          let id = opened.get(key) ?? null;
          // A kept terminal the daemon has since reaped refuses the resize.
          if (id && !(await send('terminal.resize', { terminal_id: id, ...sent })).ok) {
            opened.delete(key);
            id = null;
          }
          if (!id) {
            let pending = opening.get(key);
            // Another mount's open set the size; ours is sent once it lands.
            if (pending) sent = { cols: 0, rows: 0 };
            else {
              const open = send('terminal.open', {
                project_id: projectId,
                ...(sessionId ? { session_id: sessionId } : {}),
                ...sent,
              });
              pending = open;
              opening.set(key, open);
              void open.then((result) => {
                const kept = opening.get(key) === open;
                if (kept) opening.delete(key);
                if (!result.ok) return;
                const landed = (result.value as { terminal_id: string }).terminal_id;
                if (kept) opened.set(key, landed);
                else void send('terminal.close', { terminal_id: landed });
              });
            }
            const result = await pending;
            if (!result.ok) {
              if (live) {
                setError(failureText(result.error));
                setRefused(true);
              }
              return;
            }
            id = opened.get(key) ?? null;
          }
          if (!live || !id) return;
          terminalId.current = id;
          setRefused(false);
          end = bridge.terminalSubscribe(id, (frame) => {
            if ('data' in frame) output(frame.data);
            // The daemon may still have the terminal; reopening attaches to it again.
            else if ('closed' in frame) setLost(true);
            else {
              opened.delete(key);
              setExit(frame.exit);
            }
          });
          resize();
        };
        const report = (result: BridgeResult<unknown>) => {
          if (!result.ok && live) setError(failureText(result.error));
        };
        let writing = Promise.resolve();
        term.onData((data) => {
          const id = terminalId.current;
          if (!id) return;
          writing = writing.then(async () => {
            for (const piece of pieces(data)) {
              const result = await send('terminal.write', { terminal_id: id, data: piece });
              if (!result.ok) return report(result);
            }
          });
        });
        const resize = () => {
          const now = size(term);
          const id = terminalId.current;
          if (!id || (now.cols === sent.cols && now.rows === sent.rows)) return;
          sent = now;
          void send('terminal.resize', { terminal_id: id, ...now }).then(report);
        };
        refit.current = () => {
          fit.fit();
          resize();
        };
        const observer = new ResizeObserver(refit.current);
        observer.observe(at);
        void start();
        stop = () => {
          live = false;
          end?.();
          refit.current = null;
          observer.disconnect();
          clearTimeout(quiet);
          if (quiet !== undefined) busy.current?.(false);
          terminalId.current = null;
          xterm.current = null;
          term.dispose();
        };
      },
    );
    return () => {
      gone = true;
      stop?.();
    };
  }, [key, attempt, ready]);

  const theme = useThemeTick();
  useEffect(() => {
    if (xterm.current && box.current) xterm.current.options.theme = colors(box.current);
  }, [theme]);
  useEffect(() => {
    if (!xterm.current || xterm.current.options.fontSize === fontSize) return;
    xterm.current.options.fontSize = fontSize;
    refit.current?.();
  }, [fontSize]);

  const close = () => {
    const id = terminalId.current ?? opened.get(key);
    opened.delete(key);
    opening.delete(key);
    if (id) void send('terminal.close', { terminal_id: id });
    onClose();
  };
  const reopen = () => {
    setExit(null);
    setLost(false);
    setRefused(false);
    setError(null);
    setAttempt((n) => n + 1);
  };

  const title = t({ id: 'sessions.terminal.title', defaultMessage: 'Terminal' });
  return (
    <section className="ss-term" aria-label={title} aria-busy={!ready || undefined}>
      {grip}
      <div className="ss-colh">
        <SquareTerminal aria-hidden="true" />
        <span className="ss-colt">{title}</span>
        <span className="ss-cola">
          <button
            type="button"
            className="ib"
            aria-label={t({ id: 'sessions.terminal.close', defaultMessage: 'Close terminal' })}
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </span>
      </div>
      {error && (
        <div className="ss-term-err" role="alert">
          {error}
        </div>
      )}
      {(exit !== null || lost || refused) && (
        <div className="ss-term-exit" role="status">
          {(exit !== null || lost) && (
            <span>
              {exit !== null
                ? t(
                    { id: 'sessions.terminal.exited', defaultMessage: 'Exited with code {code}' },
                    { code: exit },
                  )
                : t({ id: 'sessions.terminal.lost', defaultMessage: 'Connection lost' })}
            </span>
          )}
          <button type="button" className="btn sm" onClick={reopen}>
            {t({ id: 'sessions.terminal.reopen', defaultMessage: 'Reopen' })}
          </button>
        </div>
      )}
      <div ref={box} className="ss-term-view" />
    </section>
  );
}
