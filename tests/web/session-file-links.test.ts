import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  contexts: new Map<unknown, unknown>(),
  toasts: [] as unknown[],
  openSession: (() => {}) as (...args: unknown[]) => void,
  board: {
    board: {
      sessions: [
        { id: 'session-a', project_id: 'project-a', workspace_id: 'workspace-a', runtime: 'codex' },
      ],
      workspaces: [{ id: 'workspace-a', path: '/work/tree' }],
      projects: [{ id: 'project-a', roots: ['/work/project'] }],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  } as any,
}));
vi.mock('react', async (actual) => ({
  ...(await (await import('./web-hook-host.js')).reactMock(actual, { useId: 'md' })),
  useContext: (context: any) =>
    mock.contexts.has(context) ? mock.contexts.get(context) : context._currentValue,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), {
    getState: () => ({ openSession: mock.openSession }),
  }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => {
    mock.toasts.push(options);
    return '';
  },
}));
import { Markdown } from '@/components/Markdown';
import { failureText } from '@/data/needs-you';
import { workspaceFile } from '@/data/tool-calls';
import { ToolFiles, ToolImages } from '@/screens/sessions/items';

afterEach(() => {
  unmountAll();
  mock.contexts.clear();
  mock.toasts = [];
  vi.unstubAllGlobals();
});

/** The anchor a Markdown link draws, with its opener's hooks run. */
function link(markdown: string, href: string) {
  const tree = mount(() => (Markdown as any).type({ text: markdown })).value;
  const anchor = find(tree, (n) => n.props.href === href && typeof n.type === 'function');
  const opener = (anchor.type as any)(anchor.props) as ReactElement<any>;
  const h = mount(() => (opener.type as any)(opener.props));
  return find(h.value, (n) => n.type === 'a');
}
const click = (modifier = false) => ({
  preventDefault: vi.fn(),
  metaKey: modifier,
  ctrlKey: false,
});

describe('file links in the conversation', () => {
  it('opens a Markdown file link in the editor', () => {
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('window', { pantheon: { openFile } });
    link('see [the chart](out/chart.png)', 'out/chart.png').props.onClick(click());
    expect(openFile).toHaveBeenCalledWith({ path: 'out/chart.png' });
  });

  it('opens a link in the editor at its line, with a modifier held or outside the worktree', () => {
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('window', { pantheon: { openFile } });
    link('see [main](src/main.ts:4)', 'src/main.ts:4').props.onClick(click(true));
    expect(openFile).toHaveBeenCalledWith({ path: 'src/main.ts', line: 4 });
    link('see [other](/elsewhere/a.ts)', '/elsewhere/a.ts').props.onClick(click());
    expect(openFile).toHaveBeenLastCalledWith({ path: '/elsewhere/a.ts' });
  });

  it('names a linked file by its path in the worktree, and nothing outside it', () => {
    const bases = ['/work/tree', '/work/project'];
    expect(workspaceFile('/work/tree/out/chart.png', bases)).toBe('out/chart.png');
    expect(workspaceFile('file:///work/tree/docs/a.md', bases)).toBe('docs/a.md');
    expect(workspaceFile('./src/main.ts', bases)).toBe('src/main.ts');
    expect(workspaceFile('src/main.ts', bases)).toBe('src/main.ts');
    expect(workspaceFile('/work/project/a.ts', bases)).toBeNull();
    expect(workspaceFile('../outside.ts', bases)).toBeNull();
    expect(workspaceFile('src/a.ts', [])).toBeNull();
  });

  it('decodes a file URL and reads it only on this machine', () => {
    const bases = ['/work/tree'];
    expect(workspaceFile('file:///work/tree/docs/My%20Note.md', bases)).toBe('docs/My Note.md');
    expect(workspaceFile('file:///work/tree/%E7%AC%94%E8%AE%B0.md', bases)).toBe('笔记.md');
    expect(workspaceFile('file://localhost/work/tree/a.md', bases)).toBe('a.md');
    expect(workspaceFile('file://server/work/tree/a.md', bases)).toBeNull();
  });

  it('opens a file a tool wrote in the editor, from its path and from the button beside it', () => {
    const openSession = vi.fn();
    mock.openSession = openSession;
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('window', { pantheon: { openFile } });
    const h = mount(() =>
      ToolFiles({ files: ['out/chart.png'], base: '/work/tree', sessionId: 'session-a' }),
    );
    find(h.value, (n) => n.type === 'button' && text(n) === 'out/chart.png').props.onClick(click());
    expect(openFile).toHaveBeenCalledWith({ path: 'out/chart.png', base: '/work/tree' });
    expect(openSession).not.toHaveBeenCalled();
    openFile.mockClear();
    find(
      h.value,
      (n) =>
        n.props['aria-label'] === zhf('sessions.parts.openInEditor', { path: 'out/chart.png' }),
    ).props.onClick();
    expect(openFile).toHaveBeenCalledWith({ path: 'out/chart.png', base: '/work/tree' });
  });

  it('says why a file a tool wrote did not open in the editor', async () => {
    const error = { code: 'editor_failed', message: 'No editor could open the file' };
    vi.stubGlobal('window', { pantheon: { openFile: vi.fn(async () => ({ ok: false, error })) } });
    const h = mount(() =>
      ToolFiles({ files: ['out/chart.png'], base: '/work/tree', sessionId: 'session-a' }),
    );
    find(
      h.value,
      (n) =>
        n.props['aria-label'] === zhf('sessions.parts.openInEditor', { path: 'out/chart.png' }),
    ).props.onClick();
    await h.flush();
    expect(mock.toasts).toEqual([{ title: failureText(error), kind: 'failure' }]);
  });
});

describe('images from tools', () => {
  const png = 'iVBORw0KGgoAAAA';

  it('reads an image file a tool wrote for its thumbnail and opens it in the editor', async () => {
    const openSession = vi.fn();
    mock.openSession = openSession;
    const query = vi.fn(async () => ({
      ok: true,
      value: { path: 'out/chart.png', mime: 'image/png', data: png, size: 11, truncated: false },
    }));
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('window', { pantheon: { query, openFile } });
    const h = mount(() =>
      ToolImages({
        images: [],
        files: ['out/chart.png'],
        base: '/work/tree',
        sessionId: 'session-a',
      }),
    );
    await h.flush();
    expect(query).toHaveBeenCalledWith('files.read', {
      project_id: 'project-a',
      session_id: 'session-a',
      path: 'out/chart.png',
    });
    const thumb = find(
      h.value,
      (n) =>
        n.props['aria-label'] === zhf('sessions.parts.openImageFile', { path: 'out/chart.png' }),
    );
    expect(find(thumb, (n) => n.type === 'img').props.src).toBe(`data:image/png;base64,${png}`);
    thumb.props.onClick();
    expect(openFile).toHaveBeenCalledWith({ path: 'out/chart.png', base: '/work/tree' });
    expect(openSession).not.toHaveBeenCalled();
  });

  it('opens a returned image large', () => {
    const h = mount(() =>
      ToolImages({
        images: [{ mime: 'image/png', data: png }],
        files: [],
        base: '/work/tree',
        sessionId: 'session-a',
      }),
    );
    find(h.value, (n) => n.props['aria-label'] === zh('sessions.parts.openImage')).props.onClick();
    h.render();
    const large = nodes(h.value).filter(
      (n) => n.type === 'img' && n.props.src === `data:image/png;base64,${png}`,
    );
    expect(large.some((n) => n.props.alt === zh('sessions.parts.image'))).toBe(true);
  });
});
