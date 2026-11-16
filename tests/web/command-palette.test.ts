import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'palette' }),
);
import { paletteNewSession, sessionPaletteItem } from '@/App';
import { CommandPalette } from '@/components/CommandPalette';
import { toastManager } from '@/components/Toast';
import { SessionStateIcon, sessionStateLabel } from '@/components/SessionStateIcon';
import { runtimeName } from '@/components/RuntimeGlyph';
import { ProjectMonogram } from '@/components/ProjectMonogram';
import { fileItem, paletteIntent, paletteSections, type PaletteItem } from '@/components/palette';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { draftKey, useDrafts } from '@/data/drafts';
import { listText } from '@/lib/list-text';
import { keyText } from '@/lib/shortcuts';
import { useShell } from '@/store';
import { zh, zhf } from './i18n-setup.js';

const item = (id: string, group: PaletteItem['group'], label = id): PaletteItem => ({
  id,
  group,
  label,
  run: () => {},
});
const ids = (items: PaletteItem[]) => items.map((i) => i.id);
const session = (id: string, state: string) =>
  ({ id, state, title: id, runtime: 'claude' }) as unknown as WorkbenchSession;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('palette groups and prefixes', () => {
  const items = [
    item('a1', 'action', 'Open gate'),
    item('s1', 'session', 'Gate fix'),
    item('p1', 'screen', 'Board'),
    item('s2', 'session', 'Refund list'),
  ];

  it('heads an empty search with the sessions, then the commands', () => {
    const sections = paletteSections(items, '', ['s2']);
    expect(sections.map((s) => s.group)).toEqual(['session', 'command']);
    expect(sections.map((s) => ids(s.items))).toEqual([
      ['s2', 's1'],
      ['a1', 'p1'],
    ]);
  });

  it('flattens the groups into one list once a query is typed, the files last', () => {
    const files = [fileItem('docs/gate.md', () => {})];
    const sections = paletteSections(items, 'gate', [], files);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.group).toBeNull();
    expect(ids(sections[0]!.items)).toEqual(['s1', 'a1', 'file-docs/gate.md']);
  });

  it('searches only the commands after > and only the files after #, without matching the prefix', () => {
    const files = [fileItem('web/refunds/RefundList.tsx', () => {})];
    expect(ids(paletteSections(items, '>gate', [], files).flatMap((s) => s.items))).toEqual(['a1']);
    expect(ids(paletteSections(items, '> gate', [], files).flatMap((s) => s.items))).toEqual([
      'a1',
    ]);
    expect(ids(paletteSections(items, '#refund', [], files).flatMap((s) => s.items))).toEqual([
      'file-web/refunds/RefundList.tsx',
    ]);
    expect(paletteSections(items, '>', [], files).map((s) => s.group)).toEqual(['command']);
    expect(paletteSections(items, '#', [], files).map((s) => s.group)).toEqual(['file']);
  });

  it('shows a found file as its name and its folder', () => {
    const open = vi.fn();
    const file = fileItem('web/refunds/RefundList.tsx', open);
    expect(file).toMatchObject({ group: 'file', label: 'RefundList.tsx', sub: 'web/refunds' });
    file.run();
    expect(open).toHaveBeenCalledWith('web/refunds/RefundList.tsx');
  });
});

describe('palette intent', () => {
  const projects = [
    { name: '支付服务', roots: ['/work/payments'] },
    { name: 'Pantheon', roots: ['/Users/me/Pantheon'] },
  ];
  const commands = [
    item('theme-dark', 'action', '深色主题'),
    item('settings-appearance', 'screen', '设置:外观'),
    item('s1', 'session', '对账差异报表'),
  ];

  it.each([
    ['支付', 'project', false],
    ['payments', 'project', false],
    ['refund.ts', 'file', false],
    ['src/refunds', 'file', false],
    ['深色', 'command', false],
    ['外观', 'command', false],
    ['对账', null, false],
    ['给退款接口加上幂等键', null, true],
    ['fix the refund gate', null, true],
    ['fix gate', null, false],
  ] as const)('reads %s as leading with %s, a sentence: %s', (query, lead, sentence) => {
    expect(paletteIntent(query, projects, commands)).toEqual({ lead, sentence });
  });

  it('puts the group of the intent first without reordering inside the groups', () => {
    const items = [item('s1', 'session', 'refund.ts fix'), item('a1', 'action', 'refund.ts run')];
    const files = [fileItem('src/refund.ts', () => {})];
    const sections = paletteSections(items, 'refund.ts', [], files, [], 'file');
    expect(ids(sections[0]!.items)).toEqual(['file-src/refund.ts', 's1', 'a1']);
  });
});

describe('palette session items', () => {
  it('lead with the session state and add its state and runtime', () => {
    const open = vi.fn();
    const s = session('s1', 'running');
    const found = sessionPaletteItem(s, open);
    expect(found).toMatchObject({ id: 'session-s1', group: 'session', label: 's1', session: s });
    expect(found.sub).toBe(listText(sessionStateLabel(s), runtimeName('claude')));
    found.run();
    expect(open).toHaveBeenCalledWith('s1');
  });

  it('puts the text into the new-session composer and opens it', () => {
    const start = vi.fn(() =>
      expect(useDrafts.getState().drafts[draftKey('p1', null)]?.text).toBe('fix the gate'),
    );
    paletteNewSession('p1', 'fix the gate', start);
    expect(start).toHaveBeenCalledOnce();
  });
});

type Props = Parameters<typeof CommandPalette>[0];

const NO_ITEMS: PaletteItem[] = [];

function mount(props: Partial<Props>) {
  vi.stubGlobal('document', { getElementById: () => null, activeElement: null });
  const given: Props = { open: true, onOpenChange() {}, items: NO_ITEMS, ...props };
  const h = new HookHost(() => {
    const tree = CommandPalette(given);
    const body = named(tree, 'PaletteBody');
    return { tree, body: (body.type as (props: unknown) => ReactNode)(body.props) };
  });
  h.render();
  const input = () => find(h.value.body, (n) => n.type === 'input');
  const type = (value: string) => {
    input().props.onChange({ target: { value } });
    h.render();
  };
  const key = (k: string) => {
    input().props.onKeyDown({ key: k, nativeEvent: { isComposing: false }, preventDefault() {} });
    h.render();
  };
  const all = () => nodes(h.value.body);
  const options = () => all().filter((n) => n.props.role === 'option');
  return { h, input, type, key, all, options };
}

const classed = (n: ReactElement<any>, name: string) =>
  typeof n.props.className === 'string' && n.props.className.split(' ').includes(name);

describe('command palette', () => {
  it('leads the input with a search icon and closes on the esc key cap', () => {
    const p = mount({});
    const bar = find(p.h.value.body, (n) => classed(n, 'cmdk-bar'));
    expect(nodes(bar).some((n) => classed(n, 'cmdk-ic'))).toBe(true);
    expect(text(nodes(bar).find((n) => classed(n, 'kbd'))!)).toBe('esc');
    expect(p.input().props.placeholder).toBe(zh('components.commandPalette.placeholder'));
  });

  it('names each group of an empty search above its rows, and none once a query is typed', () => {
    const p = mount({ items: [item('a1', 'action', 'Open'), item('s1', 'session', 'Gold')] });
    const heads = () => p.all().filter((n) => classed(n, 'cmdk-gh'));
    expect(heads().map(text)).toEqual([
      zh('components.commandPalette.groupSessions'),
      zh('components.commandPalette.groupCommands'),
    ]);
    expect(p.options().map((n) => n.key)).toEqual(['s1', 'a1']);
    p.type('o');
    expect(heads()).toEqual([]);
    expect(p.options().map((n) => n.key)).toEqual(['a1', 's1']);
  });

  it('draws a session row with its state glyph and its muted state and runtime', () => {
    const s = session('s1', 'running');
    const p = mount({ items: [{ ...item('s1', 'session', 'Fix'), session: s, sub: 'x' }] });
    const row = p.options()[0]!;
    expect(nodes(row).find((n) => n.type === SessionStateIcon)?.props.session).toBe(s);
    expect(text(nodes(row).find((n) => classed(n, 'cmdk-sub'))!)).toBe('x');
  });

  describe('files', () => {
    const bridge = () => ({
      query: vi.fn(async () => ({ ok: true, value: ['web/refunds/RefundList.tsx'] })),
      openFile: vi.fn(async () => ({ ok: true, value: null })),
    });

    it('searches the project 150ms after typing stops, keeps the last files meanwhile and opens one', async () => {
      vi.useFakeTimers();
      const pantheon = bridge();
      vi.stubGlobal('window', { pantheon });
      const p = mount({ fileSearch: { projectId: 'p1', root: '/repo' } });
      expect(pantheon.query).not.toHaveBeenCalled();
      p.type('refund');
      vi.advanceTimersByTime(149);
      expect(pantheon.query).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(pantheon.query).toHaveBeenCalledWith('files.search', {
        project_id: 'p1',
        q: 'refund',
      });
      await p.h.flush();
      const row = () => p.options()[0]!;
      expect(text(nodes(row()).find((n) => classed(n, 'cmdk-lb'))!)).toBe('RefundList.tsx');
      const folder = nodes(row()).find((n) => classed(n, 'cmdk-sub'))!;
      expect(text(folder)).toBe('web/refunds');
      expect(classed(folder, 'mono')).toBe(true);
      p.type('refundl');
      expect(p.options()).toHaveLength(1);
      p.key('Enter');
      expect(pantheon.openFile).toHaveBeenCalledWith({
        path: 'web/refunds/RefundList.tsx',
        base: '/repo',
      });
    });

    it('shows why a found file did not open', async () => {
      vi.useFakeTimers();
      const add = vi.spyOn(toastManager, 'add').mockReturnValue('toast-a');
      const pantheon = {
        ...bridge(),
        openFile: vi.fn(async () => ({
          ok: false,
          error: { code: 'not_found', message: 'gone' },
        })),
      };
      vi.stubGlobal('window', { pantheon });
      const p = mount({ fileSearch: { projectId: 'p1', root: '/repo' } });
      p.type('refund');
      vi.advanceTimersByTime(150);
      await p.h.flush();
      p.key('Enter');
      await p.h.flush();
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure' }));
      add.mockRestore();
    });

    it('searches no files for an empty query or after > and @', () => {
      vi.useFakeTimers();
      const pantheon = bridge();
      vi.stubGlobal('window', { pantheon });
      const p = mount({ fileSearch: { projectId: 'p1' } });
      vi.advanceTimersByTime(500);
      p.type('>refund');
      vi.advanceTimersByTime(500);
      p.type('@refund');
      vi.advanceTimersByTime(500);
      expect(pantheon.query).not.toHaveBeenCalled();
    });

    it('has no file group without a project or without the desktop bridge', () => {
      vi.useFakeTimers();
      const pantheon = bridge();
      vi.stubGlobal('window', { pantheon });
      const p = mount({});
      p.type('#refund');
      vi.advanceTimersByTime(500);
      expect(pantheon.query).not.toHaveBeenCalled();
      expect(p.all().some((n) => text(n) === '#')).toBe(false);
      vi.stubGlobal('window', {});
      const q = mount({ fileSearch: { projectId: 'p1' } });
      q.type('#refund');
      vi.advanceTimersByTime(500);
      expect(q.all().some((n) => text(n) === '#')).toBe(false);
    });
  });

  it('offers a new session with the text, prefix taken off, when nothing matches', () => {
    const onNewSession = vi.fn();
    const onOpenChange = vi.fn();
    const p = mount({ items: [item('a1', 'action', 'Open')], onNewSession, onOpenChange });
    expect(p.all().some((n) => text(n) === zh('components.commandPalette.noResults'))).toBe(false);
    p.type('>fix the gate');
    expect(p.options()).toEqual([]);
    expect(p.all().some((n) => text(n) === zh('components.commandPalette.noResults'))).toBe(true);
    const start = find(p.h.value.body, (n) => n.type === 'button');
    expect(text(start)).toContain(zh('components.commandPalette.startWithText'));
    p.key('Enter');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNewSession).toHaveBeenCalledWith('fix the gate');
    start.props.onClick();
    expect(onNewSession).toHaveBeenCalledTimes(2);
  });

  it('explains the keys in its footer', () => {
    vi.stubGlobal('window', { pantheon: {} });
    const p = mount({ fileSearch: { projectId: 'p1' } });
    const foot = find(p.h.value.body, (n) => classed(n, 'cmdk-ft'));
    expect(
      nodes(foot)
        .filter((n) => classed(n, 'kbd'))
        .map(text),
    ).toEqual(['↑', '↓', '↵', keyText('Meta+Enter'), 'tab', '@', '>', '#']);
    expect(text(foot)).toBe(
      `↑↓选择↵打开${keyText('Meta+Enter')}在分栏打开tab进入项目@项目>命令#文件`,
    );
  });

  describe('projects', () => {
    const project = (id: string, name: string, root: string) => ({
      id,
      name,
      roots: [root],
    });
    const board = useBoard.getState().board;
    const shell = useShell.getState();
    const choose = useCurrentProject.getState().choose;
    afterEach(() => {
      useBoard.setState({ board });
      useShell.setState(shell);
      useCurrentProject.setState({ choose });
    });
    const withProjects = () =>
      useBoard.setState({
        board: {
          projects: [
            project('p1', 'Pantheon', '/Users/me/Pantheon'),
            project('p2', '支付服务', '/work/payments'),
            { ...project('p3', '支付旧版', '/work/old'), removed_at: '2026-01-01T00:00:00.000Z' },
          ],
        } as never,
      });
    const bridge = () => ({
      query: vi.fn(async (name: string) => ({
        ok: true,
        value: name === 'files.search' ? [] : { hits: [], indexing_complete: true },
      })),
    });

    it('lists only the projects after @, each with its monogram, name and root, and opens its board', () => {
      withProjects();
      const setScreen = vi.fn();
      const followFirstSession = vi.fn();
      const picked = vi.fn();
      useShell.setState({ setScreen, followFirstSession });
      useCurrentProject.setState({ choose: picked });
      const onOpenChange = vi.fn();
      const p = mount({
        items: [item('a1', 'action', '支付设置'), item('s1', 'session', '支付回调')],
        onOpenChange,
      });
      p.type('@支付');
      const rows = p.options();
      expect(rows.map((n) => n.key)).toEqual(['project-p2']);
      expect(nodes(rows[0]!).find((n) => n.type === ProjectMonogram)?.props).toEqual({
        id: 'p2',
        name: '支付服务',
      });
      expect(text(nodes(rows[0]!).find((n) => classed(n, 'cmdk-lb'))!)).toBe('支付服务');
      const root = nodes(rows[0]!).find((n) => classed(n, 'cmdk-sub'))!;
      expect(text(root)).toBe('/work/payments');
      expect(classed(root, 'mono')).toBe(true);
      p.type('@payments');
      expect(p.options().map((n) => n.key)).toEqual(['project-p2']);
      p.key('Enter');
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(picked).toHaveBeenCalledWith('p2');
      expect(followFirstSession).toHaveBeenCalledOnce();
      expect(setScreen).toHaveBeenCalledWith('board');
    });

    it('locks the search to the highlighted project on tab, searches in it, and unlocks on backspace', () => {
      vi.useFakeTimers();
      withProjects();
      const pantheon = bridge();
      vi.stubGlobal('window', { pantheon });
      const p = mount({
        items: [item('s1', 'session', 'refund gate'), item('a1', 'action', 'refund run')],
        fileSearch: { projectId: 'p1', root: '/Users/me/Pantheon' },
      });
      const scope = () => p.all().find((n) => classed(n, 'cmdk-scope'));
      p.type('@pantheon');
      p.key('Tab');
      expect(scope()).toBeUndefined();
      expect(p.input().props.value).toBe('@pantheon');
      p.type('@支付');
      p.key('Tab');
      expect(text(scope()!)).toBe('支付服务');
      expect(nodes(scope()!).find((n) => n.type === ProjectMonogram)?.props.id).toBe('p2');
      expect(p.input().props.value).toBe('');
      const named = zhf('components.commandPalette.searchIn', { project: '支付服务' });
      expect(p.input().props['aria-label']).toBe(named);
      p.type('refund');
      vi.advanceTimersByTime(150);
      expect(pantheon.query).toHaveBeenCalledWith('files.search', {
        project_id: 'p2',
        q: 'refund',
      });
      expect(pantheon.query).toHaveBeenCalledWith('session.search', {
        text: 'refund',
        limit: '8',
        project_id: 'p2',
      });
      expect(p.options().map((n) => n.key)).toEqual(['a1']);
      p.key('Backspace');
      expect(text(scope()!)).toBe('支付服务');
      p.type('');
      p.key('Backspace');
      expect(scope()).toBeUndefined();
      expect(p.input().props['aria-label']).toBe(zh('components.commandPalette.search'));
    });

    it('finds no projects or messages, and names none of their keys, where the window shows no other place', () => {
      vi.useFakeTimers();
      withProjects();
      const pantheon = bridge();
      vi.stubGlobal('window', { pantheon });
      const p = mount({
        items: [item('a1', 'action', '支付设置')],
        fileSearch: { projectId: 'p1' },
        navigable: false,
      });
      p.type('@支付');
      expect(p.options()).toEqual([]);
      p.type('支付');
      vi.advanceTimersByTime(150);
      expect(p.options().map((n) => n.key)).toEqual(['a1']);
      expect(pantheon.query).toHaveBeenCalledWith('files.search', { project_id: 'p1', q: '支付' });
      expect(pantheon.query).not.toHaveBeenCalledWith('session.search', expect.anything());
      const foot = find(p.h.value.body, (n) => classed(n, 'cmdk-ft'));
      expect(
        nodes(foot)
          .filter((n) => classed(n, 'kbd'))
          .map(text),
      ).toEqual(['↑', '↓', '↵', '>', '#']);
    });
  });

  it('leads a sentence with a new session from it, above the matches', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    const onNewSession = vi.fn();
    const onOpenChange = vi.fn();
    const p = mount({
      items: [item('a1', 'action', 'refund the gate run')],
      onNewSession,
      onOpenChange,
    });
    p.type('refund the gate ');
    const rows = p.options();
    expect(rows.map((n) => text(nodes(n).find((c) => classed(c, 'cmdk-lb'))!))).toEqual([
      zhf('components.commandPalette.newSessionWith', { text: 'refund the gate' }),
      'refund the gate run',
    ]);
    expect(rows[0]!.props['aria-selected']).toBe(true);
    p.key('Enter');
    expect(onNewSession).toHaveBeenCalledWith('refund the gate');
    expect(onOpenChange).toHaveBeenCalledOnce();
    p.type('给退款接口加上幂等键');
    expect(text(nodes(p.options()[0]!).find((c) => classed(c, 'cmdk-lb'))!)).toBe(
      zhf('components.commandPalette.newSessionWith', { text: '给退款接口加上幂等键' }),
    );
    p.type('>refund the gate');
    expect(p.options().map((n) => n.key)).toEqual(['a1']);
  });

  it('opens the selected session beside the current one on ⌘↵, and runs any other item', () => {
    const openSplit = vi.fn();
    const shell = useShell.getState();
    useShell.setState({ openSplit });
    const run = vi.fn();
    const onOpenChange = vi.fn();
    const p = mount({
      items: [
        { ...item('s1', 'session'), session: session('s1', 'idle') },
        { ...item('a1', 'action'), run },
      ],
      onOpenChange,
    });
    const split = () =>
      p.input().props.onKeyDown({
        key: 'Enter',
        metaKey: true,
        ctrlKey: true,
        nativeEvent: { isComposing: false },
        preventDefault() {},
      });
    split();
    expect(openSplit).toHaveBeenCalledWith('s1');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    p.key('ArrowDown');
    split();
    expect(run).toHaveBeenCalledOnce();
    expect(openSplit).toHaveBeenCalledOnce();
    useShell.setState(shell);
  });

  it('opens the session as ↵ does on ⌘↵ when there is no session to put it beside', () => {
    const shell = useShell.getState();
    useShell.setState({ sessionId: '', followed: null, splitId: null });
    const run = vi.fn();
    const p = mount({ items: [{ ...item('s1', 'session'), session: session('s1', 'idle'), run }] });
    p.input().props.onKeyDown({
      key: 'Enter',
      metaKey: true,
      ctrlKey: true,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    expect(run).toHaveBeenCalledOnce();
    useShell.setState(shell);
  });

  it('opens and closes without motion and gives focus back to where it was', () => {
    const before = { focus() {} };
    const doc = { getElementById: () => null, activeElement: before as unknown };
    vi.stubGlobal('document', doc);
    let open = false;
    const h = new HookHost(() => CommandPalette({ open, onOpenChange() {}, items: NO_ITEMS }));
    h.render();
    open = true;
    h.render();
    doc.activeElement = null;
    const popup = find(h.value, (n) => classed(n, 'cmdk'));
    expect(popup.props.className).toBe('cmdk');
    expect(popup.props.finalFocus()).toBe(before);
    expect(find(h.value, (n) => classed(n, 'cmdk-scrim')).props.className).toBe('cmdk-scrim');
    const css = readFileSync(
      new URL('../../apps/web/src/components/command-palette.css', import.meta.url),
      'utf8',
    );
    expect(css).not.toMatch(/transition|animation/);
  });
});
