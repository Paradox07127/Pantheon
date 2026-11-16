import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurn } from '@pantheon/domain';
import { nodes, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
import {
  buildTranscript,
  type ToolItem,
  type TranscriptItem,
  type TurnView,
} from '@/data/transcript';
import {
  DEFAULT_LOOK,
  getLook,
  LOOK_KEY,
  readLook,
  setLook,
  toggleTranscript,
} from '@/data/layout';
import { resetShortcuts, setShortcut, SHORTCUTS, useShortcut } from '@/lib/shortcuts';
import { Items, TurnWork } from '@/screens/sessions/parts';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';

type Listener = (e: KeyboardEvent) => void;

const call = (id: string): ToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command: `run ${id}` },
  ok: true,
});
const say = (value: string): TranscriptItem => ({ kind: 'text', text: value });
const view = (items: TranscriptItem[], state: SessionTurn['state']): TurnView => ({
  ...buildTranscript(
    [
      {
        id: 'turn-a',
        project_id: 'project-a',
        session_id: 'session-a',
        revision: 1,
        input: 'Tighten the release notes',
        kind: 'send',
        delivery: 'delivered',
        state,
      } satisfies SessionTurn,
    ],
    [],
  ).turns[0]!,
  started_at: 1_000,
  ended_at: state === 'running' ? null : 4_400,
  end: state === 'running' ? null : { state: 'completed', error: null },
  items,
});

let stored: Map<string, string>;
let listeners: Listener[];

beforeEach(() => {
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = {};
  stored = new Map();
  listeners = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => type === 'keydown' && listeners.push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      if (type === 'keydown') listeners = listeners.filter((l) => l !== fn);
    },
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  setLook(DEFAULT_LOOK);
  resetShortcuts();
  vi.unstubAllGlobals();
});

const press = (key: string, mods: Partial<KeyboardEvent> = {}) => {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...mods,
  } as unknown as KeyboardEvent;
  for (const listener of [...listeners]) listener(e);
  return e.preventDefault as ReturnType<typeof vi.fn>;
};

const thread = (v: TurnView) =>
  mount(() =>
    ThreadTurn({
      view: v,
      folders: [],
      status: { kind: 'ended', tool: null, since: null },
      fresh: new Set(),
      request: () => null,
      listed: null,
    }),
  );
const shownItems = (tree: unknown) => nodes(tree as any).filter((n) => n.type === Items);
const groupsOpen = (props: any) =>
  nodes(mount(() => Items(props)).value as any)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'ToolCalls')
    .map((n) => n.props.open);

describe('transcript detail', () => {
  it('folds the transcript by default and keeps the choice across a restart', () => {
    expect(readLook(null).transcript).toBe('folded');
    expect(readLook(JSON.stringify({ transcript: 'all' })).transcript).toBe('folded');
    toggleTranscript();
    expect(getLook().transcript).toBe('expanded');
    expect(readLook(stored.get(LOOK_KEY)!).transcript).toBe('expanded');
    toggleTranscript();
    expect(getLook().transcript).toBe('folded');
  });

  it('opens the tool groups of a running turn once the transcript is expanded', () => {
    const v = view([call('a'), call('b'), say('done')], 'running');
    const folded = shownItems(thread(v).value);
    expect(folded.map((n) => n.props.verbose)).toEqual([false]);
    expect(groupsOpen(folded[0]!.props)).toEqual([false]);
    setLook({ transcript: 'expanded' });
    const expanded = shownItems(thread(v).value);
    expect(expanded.map((n) => n.props.verbose)).toEqual([true]);
    expect(groupsOpen(expanded[0]!.props)).toEqual([true]);
  });

  it('shows a finished turn whole, its tool groups open, once the transcript is expanded', () => {
    const items = [say('looking'), call('a'), say('done')];
    setLook({ transcript: 'expanded' });
    const tree = thread(view(items, 'completed')).value;
    expect(nodes(tree as any).some((n) => n.type === TurnWork)).toBe(false);
    const shown = shownItems(tree);
    expect(shown.map((n) => [n.props.items, n.props.verbose])).toEqual([[items, true]]);
  });

  it('lists the transcript toggle in the shortcut table without default keys', () => {
    const entry = SHORTCUTS.find((s) => s.id === 'transcript');
    expect(entry?.scope).toBe('app');
    expect(entry!.keys).toBe('');
  });

  it('toggles on a recorded ⌃O inside the composer and keeps the key from inserting a line break', () => {
    setShortcut('transcript', 'Control+O');
    mount(() => useShortcut('transcript', toggleTranscript));
    const composer = { tagName: 'TEXTAREA', isContentEditable: false } as any;
    expect(press('o', { ctrlKey: true, target: composer })).toHaveBeenCalledTimes(1);
    expect(getLook().transcript).toBe('expanded');
    expect(press('o', { ctrlKey: true, target: { tagName: 'DIV' } as any })).toHaveBeenCalledTimes(
      1,
    );
    expect(getLook().transcript).toBe('folded');
    // Other ⌃ editing keys stay with the text field.
    expect(press('a', { ctrlKey: true, target: composer })).not.toHaveBeenCalled();
    expect(press('o', { metaKey: true, target: composer })).not.toHaveBeenCalled();
    expect(getLook().transcript).toBe('folded');
  });
});
