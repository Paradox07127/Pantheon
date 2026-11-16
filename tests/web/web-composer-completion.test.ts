import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, type HookHost, mount as host, named, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { draftKey, useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { searchFiles } from '@/data/runtime-models';
import { applyCompletion, completionAt, matchSkills } from '@/screens/sessions/completion';
import { CompletionPopup, useQueueDispatch, useQueued } from '@/screens/sessions/parts';
import { NewSession, SessionCompose } from '@/screens/sessions/SessionsScreen';

describe('completion trigger', () => {
  // One case: the input, the caret, and the kind, query and start it completes, if any.
  const c = (
    input: string,
    caret: number,
    ...at: [kind: string, query: string, start: number] | []
  ) => [input, caret, at.length ? { kind: at[0], query: at[1], start: at[2] } : null] as const;
  it.each([
    [
      'completes a command at the start of the input',
      [c('/re', 3, '/', 're', 0), c('/', 1, '/', '', 0)],
    ],
    [
      'completes a path after a space or at the start of a line',
      [c('看 @src/a', 8, '@', 'src/a', 2), c('first\n@b', 8, '@', 'b', 6), c('@', 1, '@', '', 0)],
    ],
    [
      'reads the token only up to the caret',
      [c('看 @src/a 了', 5, '@', 'sr', 2), c('看 @src/a ', 9), c('/review now', 11)],
    ],
    [
      'ignores an @ inside a word and a / after the first token',
      [c('mail a@b', 8), c('fix /re', 7), c('plain', 5)],
    ],
  ])('%s', (_, cases) => {
    for (const [input, caret, expected] of cases)
      expect(completionAt(input, caret)).toEqual(expected);
  });
});

describe('applying a completion', () => {
  it('replaces the token before the caret and puts the caret after a space', () => {
    const at = { kind: '@', query: 'sr', start: 2 } as const;
    expect(applyCompletion('看 @sr', 5, at, '@src/a.ts')).toEqual({
      text: '看 @src/a.ts ',
      caret: 12,
    });
    expect(applyCompletion('看 @sr 了', 5, at, '@src/a.ts')).toEqual({
      text: '看 @src/a.ts  了',
      caret: 12,
    });
  });

  it('replaces the rest of the token after the caret too', () => {
    const at = completionAt('@src/old.ts', 3)!;
    expect(applyCompletion('@src/old.ts', 3, at, '@src/new.ts')).toEqual({
      text: '@src/new.ts ',
      caret: 12,
    });
    const inside = completionAt('看 @src/old.ts 了', 5)!;
    expect(applyCompletion('看 @src/old.ts 了', 5, inside, '@src/new.ts')).toEqual({
      text: '看 @src/new.ts  了',
      caret: 14,
    });
  });
});

describe('skill matching', () => {
  const skill = (name: string) => ({ name });

  it('puts names starting with the query first, then names containing it, ignoring case', () => {
    const skills = ['pre-review', 'lint', 'Review', 'rebase'].map(skill);
    expect(matchSkills(skills, 'RE').map((s) => s.name)).toEqual([
      'Review',
      'rebase',
      'pre-review',
    ]);
  });

  it('returns at most eight', () => {
    const skills = Array.from({ length: 12 }, (_, i) => skill(`skill-${i}`));
    expect(matchSkills(skills, '')).toHaveLength(8);
  });
});

describe('file search', () => {
  it.each([
    ['a non-array', { files: [] }],
    ['a non-string entry', ['a.ts', 3]],
  ])('reports bad_response for %s', async (_, value) => {
    const query = vi.fn(async () => ({ ok: true as const, value }));
    vi.stubGlobal('window', { pantheon: { query } });
    const result = await searchFiles('project-a', 'session-a', 'ap');
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_response' } });
    expect(query).toHaveBeenCalledWith('files.search', {
      project_id: 'project-a',
      session_id: 'session-a',
      q: 'ap',
    });
    vi.unstubAllGlobals();
  });
});

describe('completion popup', () => {
  const item = (label: string, mono: boolean) => ({
    key: label,
    label,
    mono,
    insert: label,
    skill: null,
  });

  it('lists the options with the active one selected', () => {
    const onPick = vi.fn();
    const tree = CompletionPopup({
      id: 'list',
      items: [item('apps/a.ts', true), item('apps/b.ts', true)],
      active: 1,
      onPick,
    })!;
    expect(tree.props.role).toBe('listbox');
    const options = nodes(tree).filter((n) => n.props.role === 'option');
    expect(options.map((n) => n.props['aria-selected'])).toEqual([false, true]);
    expect(options.map((n) => n.props.id)).toEqual(['list-0', 'list-1']);
    expect(options[0]!.props.className).toContain('mono');
    const keep = vi.fn();
    options[0]!.props.onMouseDown({ preventDefault: keep });
    expect(keep).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    options[0]!.props.onClick();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(item('apps/a.ts', true));
  });

  it('renders nothing without options', () => {
    expect(CompletionPopup({ id: 'list', items: [], active: 0, onPick() {} })).toBeNull();
  });
});

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'title of session-a',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const running: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'running',
  turn_count: 1,
};
const REVIEW = { name: 'review', path: '/skills/review/SKILL.md' };
const inventory = (runtime: string) => ({
  runtime,
  mcp_servers: [],
  plugins: [],
  skills:
    runtime === 'codex'
      ? [
          { id: 'review', enabled: true, ...REVIEW },
          { id: 'refactor', name: 'refactor', enabled: false, path: '/skills/refactor' },
          { id: 'release', name: 'release', enabled: true, path: '/skills/release' },
        ]
      : [
          { id: 'review', name: 'review', enabled: true },
          { id: 'rebase', name: 'rebase', enabled: true },
        ],
  apps: false,
  connectors: [],
  hooks: [],
});
const closing = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: ['release'],
  disable_apps: false,
  disable_hooks: false,
};

describe('composer completion', () => {
  let session: Session;
  let row: WorkbenchSession;
  let command: ReturnType<typeof vi.fn>;
  let query: ReturnType<typeof vi.fn>;
  const mount = async () => {
    const h = host(() => SessionCompose({ session, listed: row, title: 'title of session-a' }));
    await h.flush();
    return h;
  };
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const popup = (h: HookHost<any>) => named(h.value, 'CompletionPopup').props;
  const labels = (h: HookHost<any>) => popup(h).items.map((i: { label: string }) => i.label);
  const press = (h: HookHost<any>, key: string, extra: object = {}) => {
    box(h).props.onKeyDown({
      key,
      shiftKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
      ...extra,
    });
    h.render();
  };
  const type = (h: HookHost<any>, value: string) => {
    box(h).props.onChange({ target: { value } });
    h.render();
  };
  const sent = () => command.mock.calls.map(([c]) => [c.type, c.input]);

  beforeEach(() => {
    vi.useFakeTimers();
    session = { ...running, state: 'open' };
    row = listed;
    useQueued.setState({ queued: {} });
    useFeedback.setState({ items: {} });
    useDrafts.setState({ drafts: {} });
    mock.board = {
      board: {
        cursor: 1,
        projects: [{ id: 'project-a', name: 'Project A', extension_overrides: { codex: closing } }],
      },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
    query = vi.fn(async (method: string, params: Record<string, string>) =>
      method === 'files.search'
        ? { ok: true, value: ['apps/a.ts', 'apps/b.ts'] }
        : method === 'extensions.inventory'
          ? { ok: true, value: inventory(params.runtime!) }
          : { ok: true, value: [] },
    );
    vi.stubGlobal('window', {
      pantheon: { command, query },
      addEventListener() {},
      removeEventListener() {},
    });
  });
  afterEach(() => {
    unmountAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const searches = () => query.mock.calls.filter(([method]) => method === 'files.search');

  it('searches the session worktree for an @ path and puts the picked one on the box without sending', async () => {
    const h = await mount();
    expect(box(h).props['aria-autocomplete']).toBe('list');
    expect(box(h).props['aria-expanded']).toBe(false);
    type(h, '看 @ap');
    vi.advanceTimersByTime(149);
    await h.flush();
    expect(searches()).toEqual([]);
    vi.advanceTimersByTime(1);
    await h.flush();
    expect(searches()).toEqual([
      ['files.search', { project_id: 'project-a', session_id: 'session-a', q: 'ap' }],
    ]);
    expect(labels(h)).toEqual(['apps/a.ts', 'apps/b.ts']);
    expect(box(h).props['aria-expanded']).toBe(true);
    expect(box(h).props['aria-controls']).toBe(popup(h).id);
    press(h, 'ArrowDown');
    expect(popup(h).active).toBe(1);
    expect(box(h).props['aria-activedescendant']).toBe(`${popup(h).id}-1`);
    press(h, 'Enter');
    await h.flush();
    expect(box(h).props.value).toBe('看 ');
    expect(useDrafts.getState().drafts[draftKey('project-a', 'session-a')]?.mentions).toMatchObject(
      [{ kind: 'reference', label: 'apps/b.ts', text: '@apps/b.ts' }],
    );
    expect(command).not.toHaveBeenCalled();
    expect(popup(h).items).toEqual([]);
  });

  it('offers no paths found for an earlier query once the query changes', async () => {
    const h = await mount();
    type(h, '@ap');
    vi.advanceTimersByTime(150);
    await h.flush();
    expect(labels(h)).toEqual(['apps/a.ts', 'apps/b.ts']);
    type(h, '@x');
    expect(labels(h)).toEqual([]);
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([['session.send', { session_id: 'session-a', input: '@x' }]]);
  });

  it('searches the project without a session in the new-session composer', async () => {
    const h = host(() =>
      NewSession({
        projectId: 'project-a',
        defaults: undefined,
        focus: 0,
        onCreated() {},
        recent: [],
        onOpen() {},
        onClose() {},
      }),
    );
    await h.flush();
    type(h, '@ap');
    vi.advanceTimersByTime(150);
    await h.flush();
    expect(searches()).toEqual([['files.search', { project_id: 'project-a', q: 'ap' }]]);
    press(h, 'Tab');
    expect(box(h).props.value).toBe('@apps/a.ts ');
    expect(command).not.toHaveBeenCalled();
  });

  it('sends a picked Codex skill with the message and only once', async () => {
    session = { ...session, runtime: 'codex' };
    row = { ...listed, runtime: 'codex' };
    const h = await mount();
    type(h, '/re');
    expect(labels(h)).toEqual(['/review', '$review']);
    press(h, 'ArrowDown');
    press(h, 'Enter');
    expect(box(h).props.value).toBe('$review ');
    expect(command).not.toHaveBeenCalled();
    type(h, '$review the diff');
    press(h, 'Enter');
    await h.flush();
    type(h, 'again');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([
      ['session.send', { session_id: 'session-a', input: '$review the diff', skills: [REVIEW] }],
      ['session.send', { session_id: 'session-a', input: 'again' }],
    ]);
  });

  it.each([
    ['drops a picked Codex skill whose name was deleted from the message', 'just the diff'],
    [
      'drops a picked Codex skill whose name was lengthened into another word',
      '$reviewer the diff',
    ],
  ])('%s', async (_, input) => {
    session = { ...session, runtime: 'codex' };
    row = { ...listed, runtime: 'codex' };
    const h = await mount();
    type(h, '/re');
    press(h, 'ArrowDown');
    press(h, 'Enter');
    type(h, input);
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([['session.send', { session_id: 'session-a', input }]]);
  });

  it('sends the skill picked last of two with the same name and tells them apart', async () => {
    // Its own project, since skill inventories stay cached per project.
    session = { ...session, runtime: 'codex', project_id: 'project-with-twin-skills' };
    row = { ...listed, runtime: 'codex' };
    const other = { name: 'review', path: '/repo/.codex/skills/review/SKILL.md' };
    query.mockImplementation(async (method: string, params: Record<string, string>) =>
      method === 'extensions.inventory'
        ? {
            ok: true,
            value: {
              ...inventory(params.runtime!),
              skills: [
                { id: 'review', enabled: true, ...REVIEW },
                { id: 'review-repo', enabled: true, ...other },
              ],
            },
          }
        : { ok: true, value: [] },
    );
    const h = await mount();
    type(h, '/re');
    expect(labels(h)).toEqual(['/review', `$review ${REVIEW.path}`, `$review ${other.path}`]);
    press(h, 'ArrowDown');
    press(h, 'Enter');
    type(h, '/re');
    // The same token keeps its selection, which was on the first skill.
    press(h, 'ArrowDown');
    press(h, 'Enter');
    type(h, '$review the diff');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([
      ['session.send', { session_id: 'session-a', input: '$review the diff', skills: [other] }],
    ]);
  });

  it('sends no skills from a new session switched away from Codex', async () => {
    const h = host(() =>
      NewSession({
        projectId: 'project-a',
        defaults: { runtime: 'codex' } as never,
        focus: 0,
        onCreated() {},
        recent: [],
        onOpen() {},
        onClose() {},
      }),
    );
    await h.flush();
    type(h, '/re');
    press(h, 'Enter');
    expect(box(h).props.value).toBe('$review ');
    named(h.value, 'ModelMenu').props.onChange({ runtime: 'claude', model: null, effort: null });
    h.render();
    press(h, 'Enter');
    await h.flush();
    expect(sent()[0]![1]).toMatchObject({ runtime: 'claude' });
    expect(sent()[0]![1]).not.toHaveProperty('skills');
  });

  it('inserts a Claude command by its slash name and sends no skills', async () => {
    const h = await mount();
    type(h, '/re');
    // The skill named like the review command is left out; the command takes the name.
    expect(labels(h)).toEqual(['/review', '/rebase']);
    press(h, 'ArrowDown');
    press(h, 'Enter');
    expect(box(h).props.value).toBe('/rebase ');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([['session.send', { session_id: 'session-a', input: '/rebase ' }]]);
  });

  it('queues a picked Codex skill with the message and sends it later', async () => {
    session = { ...running, runtime: 'codex' };
    row = { ...listed, runtime: 'codex' };
    const h = await mount();
    type(h, '/re');
    press(h, 'ArrowDown');
    press(h, 'Enter');
    type(h, '$review later');
    press(h, 'Enter');
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: '$review later', attachments: [], skills: [REVIEW] },
    ]);
    session = { ...session, state: 'open' };
    mock.board.board.sessions = [session];
    await host(() => useQueueDispatch()).flush();
    expect(sent()).toEqual([
      ['session.send', { session_id: 'session-a', input: '$review later', skills: [REVIEW] }],
    ]);
  });

  it('closes the popup on Esc without interrupting the turn', async () => {
    session = running;
    const h = await mount();
    type(h, '/re');
    expect(labels(h)).toEqual(['/review', '/rebase']);
    press(h, 'Escape');
    await h.flush();
    expect(popup(h).items).toEqual([]);
    expect(box(h).props['aria-expanded']).toBe(false);
    expect(box(h).props.value).toBe('/re');
    expect(command).not.toHaveBeenCalled();
    // With the popup closed, Esc pressed twice interrupts.
    press(h, 'Escape');
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    press(h, 'Escape');
    await h.flush();
    expect(sent()).toEqual([['session.interrupt', { session_id: 'session-a' }]]);
  });

  it('offers the options again when a closed token is erased and typed anew', async () => {
    const h = await mount();
    type(h, '/re');
    press(h, 'Escape');
    expect(labels(h)).toEqual([]);
    type(h, '');
    type(h, '/re');
    expect(labels(h)).toEqual(['/review', '/rebase']);
  });

  it('leaves the turn running when Esc only closes an input method', async () => {
    session = running;
    const h = await mount();
    type(h, 'にほん');
    press(h, 'Escape', { nativeEvent: { isComposing: true } });
    await h.flush();
    expect(command).not.toHaveBeenCalled();
  });
});
