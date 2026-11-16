import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Braces, ExternalLink, File, Folder, FolderOpen } from 'lucide-react';
import rehypeHighlight from 'rehype-highlight';
import { create } from 'zustand';
import type { FilesListResult, FilesReadResult } from '@pantheon/protocol';
import { Markdown, openFailureText } from '../../components/Markdown';
import { Tip } from '../../components/Tip';
import { SandboxFrame } from '../../components/visual/SandboxFrame';
import { useBoard } from '../../data/board';
import { failureText } from '../../data/needs-you';
import { STREAM_KINDS } from '../../data/sync';
import {
  readQuery,
  touchesSession,
  useFocusTick,
  useRefetchTick,
} from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { EmptyState } from '../../components/EmptyState';
import './files-panel.css';

type Failed = { error: string };

// The rendered page's height; the view scrolls past it.
const PAGE_HEIGHT = 560;

/** The file the conversation last asked a session's files panel to show; `at` counts the asks. */
const useAsked = create<{
  asked: { sessionId: string; path: string; line?: number; at: number } | null;
}>(() => ({
  asked: null,
}));

/** Opens the session's files panel on a file, named by its path in the folder the panel shows. */
export function showFile(sessionId: string, path: string, line?: number) {
  useAsked.setState((s) => ({
    asked: { sessionId, path, ...(line !== undefined && { line }), at: (s.asked?.at ?? 0) + 1 },
  }));
  useShell.getState().openSession(sessionId, 'files');
}

const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: Hast[];
};
type Run = { text: string; className?: string };
let highlight: ((tree: Hast, file: { message: () => void }) => void) | null = null;

/** The text's lines as runs, each with the highlight classes around it; plain for an unknown language. */
function codeLines(text: string, language: string): Run[][] {
  const code: Hast = {
    type: 'element',
    tagName: 'code',
    properties: { className: [`language-${language}`] },
    children: [{ type: 'text', value: text }],
  };
  // Markdown highlights through the same plugin; an unknown language leaves the code as it is.
  if (language) {
    highlight ??= rehypeHighlight() as unknown as typeof highlight;
    highlight!(
      { type: 'root', children: [{ type: 'element', tagName: 'pre', children: [code] }] },
      { message: () => {} },
    );
  }
  const lines: Run[][] = [[]];
  const walk = (node: Hast, classes: string) => {
    if (node.type === 'text')
      return (node.value ?? '').split('\n').forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines.at(-1)!.push(classes ? { text: part, className: classes } : { text: part });
      });
    const own = node.properties?.className;
    const inner = [classes, ...(Array.isArray(own) ? own : [])].filter(Boolean).join(' ');
    for (const child of node.children ?? []) walk(child, inner);
  };
  for (const child of code.children ?? []) walk(child, '');
  return lines;
}

/** The tree's keys, as the ARIA tree pattern has them. */
function treeKey(e: KeyboardEvent<HTMLDivElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const at = rows.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  const row = rows[at]!;
  const level = (el: HTMLElement) => Number(el.getAttribute('aria-level'));
  const expanded = row.getAttribute('aria-expanded');
  let next: HTMLElement | undefined;
  if (e.key === 'ArrowDown') next = rows[at + 1];
  else if (e.key === 'ArrowUp') next = rows[at - 1];
  else if (e.key === 'Home') next = rows[0];
  else if (e.key === 'End') next = rows.at(-1);
  else if (e.key === 'ArrowRight' && expanded === 'true')
    next = rows.slice(at + 1, at + 2).find((r) => level(r) > level(row));
  else if (e.key === 'ArrowLeft' && expanded !== 'true')
    next = rows.slice(0, at).findLast((r) => level(r) === level(row) - 1);
  else if (
    (e.key === 'ArrowRight' && expanded === 'false') ||
    (e.key === 'ArrowLeft' && expanded === 'true')
  ) {
    e.preventDefault();
    row.click();
    return;
  } else return;
  e.preventDefault();
  next?.focus();
}

/** The session's worktree as a tree that lists a folder once it is opened, with the picked file below. */
export function FilesPanel({
  projectId,
  sessionId,
  worktree,
}: {
  projectId: string;
  sessionId: string;
  /** Whether the session has a worktree; without one the panel reads the project's first folder. */
  worktree: boolean;
}) {
  const [folders, setFolders] = useState<Record<string, FilesListResult | Failed>>({});
  const [open, setOpen] = useState<readonly string[]>([]);
  const [shown, setShown] = useState<{
    path: string;
    read: FilesReadResult | Failed | null;
    /** The line a conversation link named, scrolled to once the text shows. */
    line?: number;
  } | null>(null);
  const picked = useRef<string | null>(null);
  // The row the tree's one tab stop is on.
  const [focused, setFocused] = useState<string | null>(null);
  const scope: Record<string, string> = worktree
    ? { project_id: projectId, session_id: sessionId }
    : { project_id: projectId };
  const sequence = useBoard(
    (s) =>
      s.events.findLast((e) => !STREAM_KINDS.has(e.kind) && touchesSession(e, sessionId, s.board))
        ?.sequence ?? 0,
  );
  const tick = useRefetchTick(sequence, false) + useFocusTick();
  const asked = useAsked((s) => (s.asked?.sessionId === sessionId ? s.asked : null));
  // The folder the panel reads, where the external editor opens its files.
  const root = useBoard((s) => {
    const board = s.board;
    if (!worktree) return board?.projects.find((p) => p.id === projectId)?.roots[0];
    const session = board?.sessions.find((each) => each.id === sessionId);
    return board?.workspaces.find((w) => w.id === session?.workspace_id)?.path;
  });
  // A rendered Markdown or HTML file shows its text instead.
  const [source, setSource] = useState(false);
  const [openFailed, setOpenFailed] = useState<string | null>(null);

  const list = async (path: string) => {
    const result = await readQuery('files.list', path ? { ...scope, path } : scope);
    setFolders((now) => ({
      ...now,
      [path]: result.ok ? (result.value as FilesListResult) : { error: failureText(result.error) },
    }));
  };
  // The agent and edits outside the app change the worktree: list and read again after them.
  useEffect(() => {
    void list('');
    if (!tick) return;
    for (const path of open) void list(path);
    if (picked.current !== null) void read(picked.current, true);
  }, [tick]);

  const toggle = (path: string) => {
    if (open.includes(path)) return setOpen(open.filter((each) => each !== path));
    setOpen([...open, path]);
    void list(path);
  };
  /** Reads the file; `again` keeps the shown text until the new read lands. */
  const read = async (path: string, again = false, line?: number) => {
    picked.current = path;
    if (!again) {
      setShown({ path, read: null, ...(line !== undefined && { line }) });
      setSource(false);
      setOpenFailed(null);
    }
    const result = await readQuery('files.read', { ...scope, path });
    if (picked.current !== path) return;
    setShown((now) => ({
      ...now,
      path,
      read: result.ok ? (result.value as FilesReadResult) : { error: failureText(result.error) },
    }));
  };
  // A file asked for from the conversation opens with the folders above it.
  useEffect(() => {
    if (!asked) return;
    const parts = asked.path.split('/').slice(0, -1);
    const above = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    setOpen((now) => [...now, ...above.filter((folder) => !now.includes(folder))]);
    for (const folder of above) void list(folder);
    void read(asked.path, false, asked.line);
  }, [asked?.at]);

  const visible = (folder: string): string[] => {
    const listed = folders[folder];
    if (!listed || 'error' in listed) return [];
    return listed.entries.flatMap((entry) => {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      return [path, ...(entry.kind === 'dir' && open.includes(path) ? visible(path) : [])];
    });
  };
  const paths = visible('');
  const stop = focused !== null && paths.includes(focused) ? focused : (paths[0] ?? null);

  const rows = (folder: string, level: number): ReactNode[] => {
    const listed = folders[folder];
    if (!listed) return [];
    if ('error' in listed)
      return [
        <div key={`${folder}/`} className="ftr-err" role="alert">
          {listed.error}
        </div>,
      ];
    return listed.entries.flatMap((entry) => {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      const dir = entry.kind === 'dir';
      const expanded = dir && open.includes(path);
      const Icon = dir ? (expanded ? FolderOpen : Folder) : File;
      return [
        <button
          key={path}
          type="button"
          role="treeitem"
          className="ftr-row"
          aria-level={level}
          aria-expanded={dir ? expanded : undefined}
          aria-selected={dir ? undefined : shown?.path === path}
          tabIndex={path === stop ? 0 : -1}
          style={{ '--lv': level - 1 } as CSSProperties}
          onFocus={() => setFocused(path)}
          onClick={() => (dir ? toggle(path) : void read(path))}
        >
          <Icon aria-hidden="true" />
          <span className="ftr-name">{entry.name}</span>
        </button>,
        ...(expanded ? rows(path, level + 1) : []),
      ];
    });
  };

  const file = shown?.read ?? null;
  const parts = shown?.path.split('/') ?? [];
  const leaf = parts.at(-1) ?? '';
  const loaded = file && !('error' in file) ? file : null;
  const kind = extension(shown?.path ?? '');
  const rendered =
    loaded?.text !== undefined && ['md', 'markdown', 'html', 'htm'].includes(kind) ? kind : null;
  const pdf = loaded?.mime === 'application/pdf' ? (loaded.data ?? null) : null;
  const [pdfUrl, setPdfUrl] = useState<{ data: string; url: string } | null>(null);
  useEffect(() => {
    if (!pdf) return;
    const bytes = Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setPdfUrl({ data: pdf, url });
    return () => URL.revokeObjectURL(url);
  }, [pdf]);
  const text = loaded?.text;
  const lines = useMemo(
    () => (text === undefined ? [] : codeLines(text.replace(/\n$/, ''), kind)),
    [text, kind],
  );
  // One function for every render, so a line already shown is not scrolled to again.
  const reveal = useCallback((el: HTMLDivElement | null) => {
    el?.scrollIntoView({ block: 'center' });
  }, []);
  const bridge = window.pantheon;
  const sourceLabel = t({ id: 'sessions.panel.files.source', defaultMessage: 'View source' });
  const editorLabel = t({
    id: 'sessions.panel.files.openInEditor',
    defaultMessage: 'Open in external editor',
  });
  const view = (): ReactNode => {
    if (!loaded) return null;
    if (loaded.mime && loaded.data === undefined)
      return (
        <EmptyState
          inline
          title={t({ id: 'sessions.panel.files.tooLarge', defaultMessage: 'Too large to preview' })}
        />
      );
    if (pdf)
      return (
        pdfUrl?.data === pdf && (
          // The PDF viewer does not load in a sandboxed frame; a PDF blob only ever opens in it.
          <iframe className="ftr-pdf" src={pdfUrl.url} title={leaf} />
        )
      );
    if (loaded.mime)
      return (
        <img
          className="ftr-img"
          src={`data:${loaded.mime};base64,${loaded.data}`}
          alt={leaf}
          draggable={false}
        />
      );
    if (loaded.binary)
      return (
        <EmptyState
          inline
          title={t({ id: 'sessions.panel.files.binary', defaultMessage: 'Binary file' })}
        />
      );
    if (rendered && !source)
      return rendered.startsWith('htm') ? (
        <SandboxFrame
          spec={{ html: loaded.text ?? '' }}
          height={PAGE_HEIGHT}
          network={false}
          onBlocked={() => {}}
          onViewSpec={() => setSource(true)}
        />
      ) : (
        <div className="ftr-doc">
          <Markdown text={loaded.text ?? ''} />
        </div>
      );
    return (
      <div className="ftr-code">
        {lines.map((runs, i) => (
          <div key={i} className="ftr-ln" ref={i + 1 === shown?.line ? reveal : undefined}>
            <span className="ftr-n">{i + 1}</span>
            <span>
              {runs.map((run, j) =>
                run.className ? (
                  <span key={j} className={run.className}>
                    {run.text}
                  </span>
                ) : (
                  run.text
                ),
              )}
            </span>
          </div>
        ))}
      </div>
    );
  };
  return (
    <div className="ftr" data-open={shown ? true : undefined}>
      {shown && (
        <div className="ftr-path">
          {parts.map((part, i) => (
            <span key={i} className={i === parts.length - 1 ? 'ftr-leaf' : undefined}>
              {i > 0 && <span className="ftr-sep">/</span>}
              {part}
            </span>
          ))}
          <span className="ftr-acts">
            {rendered && (
              <Tip content={sourceLabel}>
                <button
                  type="button"
                  className="ib"
                  aria-label={sourceLabel}
                  aria-pressed={source}
                  onClick={() => setSource((now) => !now)}
                >
                  <Braces aria-hidden="true" />
                </button>
              </Tip>
            )}
            {bridge?.openFile && root && (
              <Tip content={editorLabel}>
                <button
                  type="button"
                  className="ib"
                  aria-label={editorLabel}
                  onClick={() => {
                    setOpenFailed(null);
                    void bridge.openFile({ path: shown.path, base: root }).then((r) => {
                      if (!r.ok) setOpenFailed(openFailureText(r.error));
                    });
                  }}
                >
                  <ExternalLink aria-hidden="true" />
                </button>
              </Tip>
            )}
          </span>
        </div>
      )}
      <div
        className="ftr-tree"
        role="tree"
        aria-label={t({ id: 'sessions.panel.dock.files', defaultMessage: 'Files' })}
        onKeyDown={treeKey}
      >
        {rows('', 1)}
      </div>
      {shown && (
        <div className="ftr-view">
          {openFailed && (
            <div className="ftr-err" role="alert">
              {openFailed}
            </div>
          )}
          {file && 'error' in file ? (
            <div className="ftr-err" role="alert">
              {file.error}
            </div>
          ) : (
            <>
              {view()}
              {loaded?.truncated && !loaded.mime && (
                <div className="ftr-cut">
                  {t({ id: 'sessions.panel.files.truncated', defaultMessage: 'Truncated' })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
