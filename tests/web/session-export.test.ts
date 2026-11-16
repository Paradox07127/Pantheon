import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Session, SessionTurn } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any, toast: (() => '') as any }));
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
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => mock.toast(options),
}));
import { buildTranscript, type TurnView } from '@/data/transcript';
import type { DaemonEvent } from '@/data/sync';
import { markdownFileName, sessionMarkdown } from '@/screens/sessions/export-markdown';
import { sessionMenu } from '@/screens/sessions/model';
import { SessionHeader, SessionListRow } from '@/screens/sessions/SessionsScreen';
import { showThreadTurns } from '@/screens/sessions/trace';

const turn = (id: string, input: string, extra: Partial<SessionTurn> = {}): SessionTurn =>
  ({
    id,
    project_id: 'project-a',
    session_id: 'session-a',
    input,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    ...extra,
  }) as SessionTurn;

let sequence = 0;
const event = (turn_id: string, kind: string, payload: object): DaemonEvent => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'session-a',
  aggregate_revision: sequence,
  project_id: 'project-a',
  causation_id: '',
  created_at: sequence,
  payload: { turn_id, ...payload },
});
const said = (turn_id: string, text: string) => event(turn_id, 'agent.message.delta', { text });
const read = (turn_id: string, id: string, file_path: string) => [
  event(turn_id, 'agent.tool.started', { tool_call_id: id, name: 'Read', input: { file_path } }),
  event(turn_id, 'agent.tool.completed', { tool_call_id: id, ok: true, output: 'file body' }),
];

const copyMenuLabel = zh('sessions.model.menu.copy');
const copyItems = ['copyWorktreePath', 'copySessionId', 'copyBaseCommit'].map((key) =>
  zh(`sessions.model.menu.${key}`),
);
const copyMarkdown = zh('sessions.export.copyMarkdown');
const exportMarkdown = zh('sessions.export.exportMarkdown');

const createdAt = new Date(2026, 10, 3, 9, 5);
const exportedAt = new Date(2026, 10, 13, 14, 30).getTime();
const source = (turns: readonly TurnView[], extra: object = {}) => ({
  title: 'Release notes',
  project: 'Atlas',
  branch: 'feature/notes',
  runtime: 'claude',
  model: 'claude-opus-4',
  created_at: createdAt.toISOString(),
  turns,
  folders: ['/work/a'],
  ...extra,
});

describe('session as Markdown', () => {
  it('heads the export with the session title and one line per known fact', () => {
    expect(sessionMarkdown(source([]), exportedAt)).toBe(
      [
        '# Release notes',
        '',
        '- 项目：Atlas',
        '- 分支：feature/notes',
        '- 运行时：Claude · claude-opus-4',
        '- 创建于：2026-11-03 09:05',
        '- 导出于：2026-11-13 14:30',
        '',
      ].join('\n'),
    );
    const bare = sessionMarkdown(
      source([], { project: null, branch: null, model: null, created_at: null }),
      exportedAt,
    );
    expect(bare).toBe(
      ['# Release notes', '', '- 运行时：Claude', '- 导出于：2026-11-13 14:30', ''].join('\n'),
    );
  });

  it('writes each turn as the user message and the agent reply under their names', () => {
    const turns = [turn('turn-1', 'Summarise the release'), turn('turn-2', 'Shorter, please')];
    const { turns: views } = buildTranscript(turns, [
      said('turn-1', 'Here is **the** summary.'),
      said('turn-2', 'Done.'),
    ]);
    const markdown = sessionMarkdown(source(views), exportedAt);
    expect(markdown.split('\n- 导出于：2026-11-13 14:30\n\n')[1]).toBe(
      [
        '## 你',
        '',
        'Summarise the release',
        '',
        '## Claude',
        '',
        'Here is **the** summary.',
        '',
        '## 你',
        '',
        'Shorter, please',
        '',
        '## Claude',
        '',
        'Done.',
        '',
      ].join('\n'),
    );
  });

  it('folds tool calls to one quoted line each, without their input or output', () => {
    const { turns: views } = buildTranscript(
      [turn('turn-1', 'Look around')],
      [
        ...read('turn-1', 'call-1', '/work/a/src/state.ts'),
        said('turn-1', 'One file read.'),
        ...read('turn-1', 'call-2', '/work/a/src/a.ts'),
        ...read('turn-1', 'call-3', '/work/a/src/b.ts'),
        ...read('turn-1', 'call-4', '/work/a/src/c.ts'),
        said('turn-1', 'Three more.'),
      ],
    );
    const markdown = sessionMarkdown(source(views), exportedAt);
    expect(markdown).toContain(
      ['> Read src/state.ts', 'One file read.', '> 读了 3 个文件', 'Three more.'].join('\n\n'),
    );
    expect(markdown).not.toContain('file body');
    expect(markdown).not.toContain('/work/a');
  });

  it('leaves out the reasoning and the approval buttons', () => {
    const { turns: views } = buildTranscript(
      [turn('turn-1', 'Run it')],
      [
        event('turn-1', 'agent.reasoning', { text: 'Secret plan' }),
        event('turn-1', 'agent.permission.requested', {
          request_id: 'request-1',
          tool: 'Bash',
          detail: { input: { command: 'make' } },
        }),
        event('turn-1', 'agent.permission.resolved', {
          request_id: 'request-1',
          decision: 'allow',
        }),
        said('turn-1', 'Ran it.'),
      ],
    );
    const markdown = sessionMarkdown(source(views), exportedAt);
    expect(markdown).not.toContain('Secret plan');
    expect(markdown).not.toContain('允许');
    expect(markdown.endsWith('## Claude\n\nRan it.\n')).toBe(true);
  });

  it('keeps code blocks and fences off a text whose fence never closes', () => {
    const closed = 'See:\n\n```ts\nconst a = 1;\n```';
    const open = 'Paste this:\n```\n````js\nlet b;';
    const { turns: views } = buildTranscript([turn('turn-1', open)], [said('turn-1', closed)]);
    const markdown = sessionMarkdown(source(views), exportedAt);
    expect(markdown).toContain(`## 你\n\n\`\`\`\`\`\n${open}\n\`\`\`\`\`\n\n## Claude`);
    expect(markdown).toContain(`## Claude\n\n${closed}\n`);
  });

  it('names the attachments of a message without their content', () => {
    const { turns: views } = buildTranscript(
      [
        turn('turn-1', 'Check these', {
          attachments: [
            { id: 'a', name: 'screen.png', mime: 'image/png', path: '/data/a/screen.png' },
            { id: 'b', name: 'log.txt', mime: 'text/plain', path: '/data/b/log.txt' },
          ],
        }),
      ],
      [],
    );
    const markdown = sessionMarkdown(source(views), exportedAt);
    expect(markdown).toContain('## 你\n\nCheck these\n\n附件：screen.png, log.txt\n');
    expect(markdown).not.toContain('/data/');
  });
});

describe('Markdown file name', () => {
  it('replaces the characters a file name cannot hold and cuts the title to 80', () => {
    expect(markdownFileName('Fix: a/b \\ c*?"<>|d')).toBe('Fix- a-b - c------d.md');
    expect(markdownFileName('x'.repeat(100))).toBe(`${'x'.repeat(80)}.md`);
    expect(markdownFileName('发布说明')).toBe('发布说明.md');
  });
});

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: createdAt.toISOString(),
  title: 'Release notes',
  runtime: 'claude',
  branch: 'feature/notes',
  model: 'claude-opus-4',
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: createdAt.toISOString(),
  changes: null,
  merge: null,
  ...extra,
});
const workspace = { id: 'workspace-a', path: '/work/a', base_sha: 'abc1234' };

describe('session menu export entries', () => {
  it('lists copy and export as Markdown after the copy items, apart from them', () => {
    const copy = sessionMenu(listed(), { workspace })
      .flat()
      .find((e) => e.label === copyMenuLabel) as { items: { label: string; separated?: true }[] };
    expect(copy.items.map((i) => i.label)).toEqual([...copyItems, copyMarkdown, exportMarkdown]);
    expect(copy.items.map((i) => i.separated ?? false)).toEqual([false, false, false, true, false]);
  });
});

describe('session export from the menus', () => {
  let toasts: { title: string; kind?: string }[];
  let clipboard: ReturnType<typeof vi.fn>;
  let query: ReturnType<typeof vi.fn>;
  let links: { href: string; download: string; click: ReturnType<typeof vi.fn> }[];
  let blobs: Blob[];
  const item = (tree: unknown, label: string): ReactElement<any> =>
    nodes(tree as any).find(
      (n) =>
        typeof n.type !== 'string' && typeof n.props.onClick === 'function' && text(n) === label,
    )!;
  const copyMenu = (tree: unknown) => find(tree as any, (n) => n.props.label === copyMenuLabel);
  const row = () =>
    mount(() => SessionListRow({ session: listed(), on: true, now: 0, onSelect() {} }));
  const header = () => {
    const h = mount(() =>
      SessionHeader({
        session: {
          id: 'session-a',
          revision: 5,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'running',
          turn_count: 1,
          workspace_id: 'workspace-a',
        } as Session,
        listed: listed(),
        title: 'Release notes',
        panels: ['changes'],
        onPanel() {},
        overview: true,
      }),
    );
    const more = named(h.value, 'MoreMenu');
    return mount(() => (more.type as (props: unknown) => ReactNode)(more.props));
  };
  const history = [
    said('turn-1', 'Partial answer so far'),
    ...read('turn-1', 'call-9', '/work/a/notes.md'),
  ];

  beforeEach(() => {
    toasts = [];
    links = [];
    blobs = [];
    mock.toast = (options: { title: string; kind?: string }) => {
      toasts.push(options);
      return '';
    };
    mock.board = {
      board: {
        sessions: [{ id: 'session-a', revision: 5, project_id: 'project-a' }],
        session_turns: [turn('turn-1', 'Write the notes', { state: 'running' })],
        projects: [{ id: 'project-a', name: 'Atlas', roots: ['/repo'] }],
        workspaces: [workspace],
        cursor: 1,
      },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    mock.shell = { sessionId: null, followFirstSession: vi.fn(), openSession: vi.fn() };
    clipboard = vi.fn(async () => {});
    query = vi.fn(async (name: string) =>
      name === 'events'
        ? { ok: true, value: { events: history, cursor: history.at(-1)!.sequence } }
        : { ok: false, error: { code: 'not_found', message: 'no preflight' } },
    );
    vi.stubGlobal('window', {
      pantheon: { command: vi.fn(), query },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
    vi.stubGlobal('document', {
      createElement: () => {
        const link = { href: '', download: '', click: vi.fn() };
        links.push(link);
        return link;
      },
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:session';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    unmountAll();
    showThreadTurns(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers both entries, apart from the copy items, in the row and the header menus', () => {
    for (const h of [row(), header()]) {
      const sub = copyMenu(h.value);
      const shown = nodes(sub.props.children).filter(
        (n) =>
          typeof n.type === 'function' &&
          (n.type.name === 'MenuSeparator' || typeof n.props.onClick === 'function'),
      );
      expect(
        shown.map((n) => ((n.type as { name: string }).name === 'MenuSeparator' ? '—' : text(n))),
      ).toEqual([...copyItems, '—', copyMarkdown, exportMarkdown]);
    }
  });

  it('copies the running session as far as it got, read once, and says so', async () => {
    const h = row();
    item(copyMenu(h.value), copyMarkdown).props.onClick();
    await h.flush();
    expect(query).toHaveBeenCalledWith(
      'events',
      expect.objectContaining({ project_id: 'project-a' }),
    );
    expect(clipboard).toHaveBeenCalledTimes(1);
    const markdown = clipboard.mock.calls[0]![0] as string;
    expect(markdown).toMatch(/^# Release notes\n\n- 项目：Atlas\n- 分支：feature\/notes\n/);
    expect(markdown).toContain(
      '## 你\n\nWrite the notes\n\n## Claude\n\nPartial answer so far\n\n> Read notes.md\n',
    );
    expect(toasts).toEqual([{ title: zh('sessions.export.copied') }]);
  });

  it('copies an open thread from what it shows without reading again', async () => {
    const { turns } = buildTranscript(mock.board.board.session_turns, [
      said('turn-1', 'On screen'),
    ]);
    showThreadTurns({ sessionId: 'session-a', turns });
    const h = header();
    item(copyMenu(h.value), copyMarkdown).props.onClick();
    await h.flush();
    expect(query).not.toHaveBeenCalledWith('events', expect.anything());
    expect(clipboard.mock.calls[0]![0]).toContain('## Claude\n\nOn screen\n');
  });

  it('downloads the export as a Markdown file named after the session', async () => {
    const h = row();
    item(copyMenu(h.value), exportMarkdown).props.onClick();
    await h.flush();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ href: 'blob:session', download: 'Release notes.md' });
    expect(links[0]!.click).toHaveBeenCalledTimes(1);
    expect(blobs[0]!.type).toBe('text/markdown');
    expect(await blobs[0]!.text()).toContain('## Claude\n\nPartial answer so far\n');
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('shows a failure notice when the session record cannot be read', async () => {
    query.mockImplementation(async () => ({
      ok: false,
      error: { code: 'history_unreadable', message: 'events timed out' },
    }));
    const h = row();
    item(copyMenu(h.value), exportMarkdown).props.onClick();
    item(copyMenu(h.value), copyMarkdown).props.onClick();
    await h.flush();
    expect(links).toHaveLength(0);
    expect(clipboard).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(2);
    for (const notice of toasts) {
      expect(notice.kind).toBe('failure');
      expect(notice.title).toContain('events timed out');
    }
  });
});
