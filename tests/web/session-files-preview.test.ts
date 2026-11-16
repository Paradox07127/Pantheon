import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HookHost, find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const shell = vi.hoisted(() => ({ openSession: vi.fn() }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/store', () => ({
  useShell: Object.assign((select: any) => select({}), { getState: () => shell }),
}));
import { FilesPanel, showFile } from '@/screens/sessions/FilesPanel';
import { Markdown } from '@/components/Markdown';
import { SandboxFrame } from '@/components/visual/SandboxFrame';
import { useBoard } from '@/data/board';

const hosts: HookHost<any>[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
  shell.openSession.mockClear();
  useBoard.setState({ board: null });
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
const lists: Record<string, unknown> = {
  '': {
    entries: [
      { name: 'docs', kind: 'dir' },
      { name: 'chart.png', kind: 'file', size: 4 },
      { name: 'huge.png', kind: 'file', size: 9_000_000 },
      { name: 'logo.svg', kind: 'file', size: 40 },
      { name: 'page.html', kind: 'file', size: 30 },
      { name: 'report.pdf', kind: 'file', size: 9 },
    ],
    truncated: false,
  },
  docs: { entries: [{ name: 'notes.md', kind: 'file', size: 20 }], truncated: false },
};
const reads: Record<string, unknown> = {
  'chart.png': { path: 'chart.png', mime: 'image/png', data: png, size: 4, truncated: false },
  'huge.png': { path: 'huge.png', mime: 'image/png', size: 9_000_000, truncated: true },
  'logo.svg': { path: 'logo.svg', mime: 'image/svg+xml', data: svg, size: 40, truncated: false },
  'docs/notes.md': { path: 'docs/notes.md', text: '# Notes\n\nBody\n', size: 15, truncated: false },
  'page.html': { path: 'page.html', text: '<p>Hello</p>\n', size: 13, truncated: false },
  'report.pdf': {
    path: 'report.pdf',
    mime: 'application/pdf',
    data: Buffer.from('%PDF-1.7').toString('base64'),
    size: 8,
    truncated: false,
  },
};

const mount = (bridge: Record<string, unknown> = {}) => {
  const query = vi.fn(async (method: string, params: Record<string, string>) => ({
    ok: true,
    value: method === 'files.list' ? lists[params.path ?? ''] : reads[params.path!],
  }));
  vi.stubGlobal('window', {
    pantheon: { query, ...bridge },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  const h = new HookHost(() =>
    FilesPanel({ projectId: 'project-a', sessionId: 'session-a', worktree: true }),
  );
  hosts.push(h);
  h.render();
  return { h, query };
};
const row = (tree: ReactElement, name: string) =>
  find(tree, (n) => n.props.role === 'treeitem' && text(n) === name);
const open = async (h: HookHost<any>, ...names: string[]) => {
  await h.flush();
  for (const name of names) {
    row(h.value, name).props.onClick();
    await h.flush();
  }
};
const has = (tree: ReactElement, predicate: (n: ReactElement<any>) => boolean) =>
  nodes(tree).some(predicate);
const sourceToggle = (tree: ReactElement) =>
  find(tree, (n) => n.props['aria-label'] === zh('sessions.panel.files.source'));

describe('files panel previews', () => {
  it('shows a picture as an image named by its file', async () => {
    const { h } = mount();
    await open(h, 'chart.png');
    const image = find(h.value, (n) => n.type === 'img');
    expect(image.props.alt).toBe('chart.png');
    expect(image.props.src).toBe(`data:image/png;base64,${png}`);
  });

  it('shows an SVG through an image, never as markup in the page', async () => {
    const { h } = mount();
    await open(h, 'logo.svg');
    const image = find(h.value, (n) => n.type === 'img');
    expect(image.props.alt).toBe('logo.svg');
    expect(image.props.src).toBe(`data:image/svg+xml;base64,${svg}`);
    expect(has(h.value, (n) => n.props.dangerouslySetInnerHTML !== undefined)).toBe(false);
  });

  it('says a picture past the preview limit is too large', async () => {
    const { h } = mount();
    await open(h, 'huge.png');
    expect(has(h.value, (n) => n.type === 'img')).toBe(false);
    expect(text(h.value)).toContain(zh('sessions.panel.files.tooLarge'));
  });

  it('renders Markdown and switches to its source', async () => {
    const { h } = mount();
    await open(h, 'docs', 'notes.md');
    const rendered = find(h.value, (n) => n.type === Markdown);
    expect(rendered.props.text).toBe('# Notes\n\nBody\n');
    expect(sourceToggle(h.value).props['aria-pressed']).toBe(false);
    sourceToggle(h.value).props.onClick();
    h.render();
    expect(sourceToggle(h.value).props['aria-pressed']).toBe(true);
    expect(has(h.value, (n) => n.type === Markdown)).toBe(false);
    expect(text(h.value)).toContain('# Notes');
  });

  it('renders HTML in the sandboxed frame and switches to its source', async () => {
    const { h } = mount();
    await open(h, 'page.html');
    const frame = find(h.value, (n) => n.type === SandboxFrame);
    expect(frame.props.spec).toEqual({ html: '<p>Hello</p>\n' });
    expect(frame.props.network).toBe(false);
    sourceToggle(h.value).props.onClick();
    h.render();
    expect(has(h.value, (n) => n.type === SandboxFrame)).toBe(false);
    expect(text(h.value)).toContain('<p>Hello</p>');
  });

  it('shows a PDF in a frame named by its file', async () => {
    const { h } = mount();
    await open(h, 'report.pdf');
    const frame = find(h.value, (n) => n.type === 'iframe');
    expect(frame.props.title).toBe('report.pdf');
    expect(String(frame.props.src)).toMatch(/^blob:/);
  });

  it('opens the shown file in the external editor from the worktree', async () => {
    useBoard.setState({
      board: {
        sessions: [{ id: 'session-a', project_id: 'project-a', workspace_id: 'workspace-a' }],
        workspaces: [{ id: 'workspace-a', path: '/work/tree' }],
        projects: [{ id: 'project-a', roots: ['/work/project'] }],
      } as any,
    });
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    const { h } = mount({ openFile });
    await open(h, 'docs', 'notes.md');
    find(
      h.value,
      (n) => n.props['aria-label'] === zh('sessions.panel.files.openInEditor'),
    ).props.onClick();
    expect(openFile).toHaveBeenCalledWith({ path: 'docs/notes.md', base: '/work/tree' });
  });

  it('opens on a file asked for from the conversation, with its folders open', async () => {
    showFile('session-a', 'docs/notes.md');
    expect(shell.openSession).toHaveBeenCalledWith('session-a', 'files');
    const { h, query } = mount();
    await h.flush();
    await h.flush();
    expect(query.mock.calls.map((call) => [call[0], call[1].path ?? ''])).toEqual(
      expect.arrayContaining([
        ['files.list', 'docs'],
        ['files.read', 'docs/notes.md'],
      ]),
    );
    expect(row(h.value, 'notes.md').props['aria-selected']).toBe(true);
  });

  it('scrolls to the line a conversation link names once the file shows', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
    reads['src/long.ts'] = { path: 'src/long.ts', text: lines, size: 1, truncated: false };
    showFile('session-a', 'src/long.ts', 500);
    const { h } = mount();
    await h.flush();
    await h.flush();
    const marked = nodes(h.value).filter((n) => n.props.className === 'ftr-ln' && n.props.ref);
    expect(marked.map((n) => text(n))).toEqual(['500line 500']);
    const scrollIntoView = vi.fn();
    marked[0]!.props.ref({ scrollIntoView });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });
});
