import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { RuntimeModel, WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { draftKey, useDrafts } from '@/data/drafts';
import { t } from '@/i18n';
import { useFeedback } from '@/data/feedback';
import { sessionBranch } from '@/screens/sessions/inspector-model';
import { SessionCompose, SessionHeader } from '@/screens/sessions/SessionsScreen';
import { SessionPreview } from '@/screens/sessions/SessionRow';
import { timelineNodes } from '@/screens/sessions/thread-model';

let answers: Record<string, unknown>;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let commandResult: unknown;
const preview = (key: string) => zh(`sessions.row.preview.${key}`);

beforeEach(() => {
  answers = {};
  commandResult = { ok: true, value: { id: 'session-new' } };
  mock.board = {
    board: {
      sessions: [],
      session_turns: [],
      projects: [],
      workspaces: [{ id: 'workspace-a', path: '/work/a', source: '/src/a' }],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = { openSession: vi.fn(), renameSession() {} };
  bridge = {
    command: vi.fn(async () => commandResult),
    query: vi.fn(async (method: string, params: Record<string, string>) => {
      const answer = answers[method];
      if (answer === undefined)
        return { ok: false, error: { code: 'unknown_route', message: method } };
      return { ok: true, value: typeof answer === 'function' ? answer(params) : answer };
    }),
    chooseFiles: vi.fn(async () => ({ ok: true, value: [] })),
  };
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Signature check',
  runtime: 'claude',
  model: 'claude-a',
  effort: 'medium',
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const session = (projectId = 'project-a'): Session => ({
  id: 'session-a',
  revision: 7,
  project_id: projectId,
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
});

function header(row: WorkbenchSession) {
  return mount(() =>
    SessionHeader({
      session: session(),
      listed: row,
      title: row.title,
      panels: [],
      onPanel: () => {},
      overview: false,
    }),
  );
}
/** Renders a part of a tree, such as the gate bar, with the props the tree gave it. */
const part = (tree: ReactNode, name: string) => {
  const element = named(tree, name);
  return mount(() => (element.type as (props: unknown) => ReactNode)(element.props));
};
const chip = (h: HookHost<any>) =>
  nodes(h.value).find((n) => n.props?.className === 'sh-chip') ?? null;
const parts = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'i')
    .map((n) => [n.props['data-tone'], n.props.style['--n']]);

describe('session branch chip', () => {
  it("names the session's own branch with what it is ahead and behind", () => {
    expect(sessionBranch(listed({ branch: 'feature/sign', ahead: 3 }), 'main')).toEqual({
      name: 'feature/sign',
      ahead: 3,
      behind: 0,
    });
    expect(sessionBranch(listed({ branch: 'feature/sign', ahead: 0, behind: 2 }), 'main')).toEqual({
      name: 'feature/sign',
      ahead: 0,
      behind: 2,
    });
  });

  it('names the source branch for a detached worktree and for a session without a worktree branch', () => {
    expect(sessionBranch(listed({ branch: null, ahead: 3 }), 'main')).toEqual({
      name: 'main',
      ahead: 3,
      behind: 0,
    });
    expect(sessionBranch(listed({ branch: null }), null)).toEqual({
      name: null,
      ahead: 0,
      behind: 0,
    });
    expect(sessionBranch(listed(), 'main')).toEqual({ name: 'main', ahead: 0, behind: 0 });
    expect(sessionBranch(listed(), null)).toBeNull();
  });

  it('writes the ahead count after the branch only when it is ahead', () => {
    expect(text(chip(header(listed({ branch: 'feature/sign', ahead: 3 }))))).toBe('feature/sign↑3');
    expect(text(chip(header(listed({ branch: 'feature/sign', ahead: 0, behind: 2 }))))).toBe(
      'feature/sign↓2',
    );
  });

  it('writes a detached worktree as detached and shows no chip without a known branch', () => {
    expect(text(chip(header(listed({ branch: null }))))).toBe(zh('sessions.branch.detached'));
    expect(chip(header(listed()))).toBeNull();
  });
});

describe('session checks bar', () => {
  const result = (name: string, exit_code: number, extra: object = {}) => ({
    name,
    exit_code,
    timed_out: false,
    output_tail: '',
    ...extra,
  });
  it.each([
    [
      'draws passed, failed and running parts as wide as their counts',
      { state: 'running', passed: 3, failed: 1, running: 1 },
      null,
      [3, 5],
      [
        ['ok', 3],
        ['bad', 1],
        ['run', 1],
      ],
    ],
    [
      'falls back to the last run results when every count is zero',
      { state: 'failed', passed: 0, failed: 0, running: 0 },
      [result('test', 0), result('lint', 1)],
      [1, 2],
      [
        ['ok', 1],
        ['bad', 1],
      ],
    ],
    [
      'gives skipped checks a part of their own and counts them in the total, not as passed',
      { state: 'passed', passed: 2, failed: 0, skipped: 1, running: 0 },
      null,
      [2, 3],
      [
        ['ok', 2],
        ['skip', 1],
      ],
    ],
    [
      'counts the checks a failed run never reached in the total, as a part of their own',
      { state: 'failed', passed: 0, failed: 1, not_run: 4, running: 0 },
      null,
      [0, 5],
      [
        ['bad', 1],
        ['none', 4],
      ],
    ],
    [
      'counts a skipped result of the last run apart from the passed ones',
      { state: 'passed', passed: 0, failed: 0, running: 0 },
      [result('test', 0), result('lint', 1, { state: 'skipped' })],
      [1, 2],
      [
        ['ok', 1],
        ['skip', 1],
      ],
    ],
  ] as const)('%s', async (_name, gate, results, [passed, total], drawn) => {
    if (results)
      answers['session.gates'] = {
        configured: true,
        running: false,
        last: { commit: 'abc', checked_at: 1, results },
      };
    const h = header(listed({ gate } as Partial<WorkbenchSession>));
    await h.flush();
    const label = t(
      { id: 'sessions.header.checks', defaultMessage: '{passed} of {total} checks passed' },
      { passed, total },
    );
    const bar = find(h.value, (n) => n.props?.['aria-label'] === label);
    expect(text(bar)).toBe(`${passed} / ${total}`);
    expect(parts(part(bar, 'GateSeg').value)).toEqual(drawn);
  });
});

describe('session preview git facts', () => {
  const tree = (s: WorkbenchSession) =>
    nodes(SessionPreview({ session: s, now: Date.parse('2026-11-03T00:10:00.000Z') }));
  // Model, effort and permissions share one unlabeled line whose title repeats its text.
  const modelLine = (s: WorkbenchSession) =>
    tree(s).findIndex((n) => typeof n.props.title === 'string' && text(n) === n.props.title);
  const facts = (s: WorkbenchSession) => {
    return tree(s)
      .filter((n) => n.type === 'div' && nodes(n.props.children).some((c) => c.type === 'dt'))
      .map((n) => {
        const [dt, dd] = nodes(n.props.children).filter((c) => c.type === 'dt' || c.type === 'dd');
        return [text(dt), dd] as const;
      });
  };
  const row = (s: WorkbenchSession, label: string) => facts(s).find(([l]) => l === label)?.[1];

  it('shows the branch with its ahead count and the checks as a bar with passed of total', () => {
    const s = listed({
      branch: 'feature/sign',
      ahead: 3,
      gate: { state: 'running', passed: 3, failed: 1, running: 1 },
    });
    expect(text(row(s, preview('branch')))).toBe('feature/sign ↑3');
    const checks = row(s, preview('checks'))!;
    expect(text(checks)).toBe('3 / 5');
    expect(parts(part(checks, 'GateSeg').value)).toEqual([
      ['ok', 3],
      ['bad', 1],
      ['run', 1],
    ]);
    const line = modelLine(s);
    expect(text(tree(s)[line])).toMatch(/^claude-a，/);
    expect(line).toBeLessThan(tree(s).findIndex((n) => n.type === 'dt'));
    expect(facts(s).map(([l]) => l)).toEqual(['branch', 'checks', 'elapsed'].map(preview));
  });

  it('shows skipped checks as their own part of the bar, not as passed', () => {
    const checks = row(
      listed({ gate: { state: 'failed', passed: 1, failed: 1, skipped: 2, running: 0 } }),
      preview('checks'),
    )!;
    expect(text(checks)).toBe('1 / 4');
    expect(parts(part(checks, 'GateSeg').value)).toEqual([
      ['ok', 1],
      ['skip', 2],
      ['bad', 1],
    ]);
  });

  it('writes only the distance of a detached worktree and has no branch row without the field', () => {
    expect(text(row(listed({ branch: null, ahead: 2 }), preview('branch')))).toBe('↑2');
    expect(row(listed({ branch: null }), preview('branch'))).toBeUndefined();
    expect(row(listed(), preview('branch'))).toBeUndefined();
  });
});

describe('timeline goal node', () => {
  const at = (hour: number, minute: number) => new Date(2026, 10, 12, hour, minute);
  const turns = [
    { id: 'turn-1', at: at(10, 0).getTime() },
    { id: 'turn-2', at: at(10, 20).getTime() },
  ];

  it('places the goal at its time, pointing to the turn running by then', () => {
    const shown = timelineNodes({
      sessionId: 'session-a',
      history: null,
      turns,
      waits: [{ id: 'approval-1', at: at(10, 10).getTime(), turn: 'turn-1', question: false }],
      goal: { text: 'Check raw body signatures', at: at(10, 25).toISOString() },
    });
    expect(shown.map((n) => [n.kind, n.label, n.name, n.turn])).toEqual([
      [
        'wait',
        zh('sessions.thread.status.approval'),
        zh('sessions.thread.status.approval'),
        'turn-1',
      ],
      [
        'goal',
        'Check raw body signatures',
        t(
          { id: 'sessions.thread.timeline.goal', defaultMessage: 'Goal: {text}' },
          { text: 'Check raw body signatures' },
        ),
        'turn-2',
      ],
    ]);
  });

  it('has no goal node without a goal', () => {
    expect(timelineNodes({ sessionId: 'session-a', history: null, turns, waits: [] })).toEqual([]);
  });
});

describe('switching a session to another runtime', () => {
  const model = (id: string): RuntimeModel => ({
    id,
    label: `label of ${id}`,
    permission_modes: ['plan', 'ask', 'auto_edit'],
    efforts: ['low', 'medium', 'high'],
    default_effort: 'medium',
    default: false,
  });
  let project = 0;
  async function composer(extra: Partial<WorkbenchSession> = {}) {
    answers['runtime.status'] = ['claude', 'codex'].map((runtime) => ({
      runtime,
      enabled: true,
      installed: true,
      auth: { state: 'logged_in' },
    }));
    answers['runtime.models'] = (params: { runtime: string }) => [model(`${params.runtime}-a`)];
    answers['backend.list'] = [];
    // The runtime models are read once per project; a new project reads them again.
    const projectId = `project-switch-${++project}`;
    const h = mount(() =>
      SessionCompose({
        session: session(projectId),
        listed: listed(extra),
        title: 'Signature check',
      }),
    );
    await h.flush();
    useDrafts.getState().update(draftKey(projectId, 'session-a'), () => ({
      text: 'carry on',
      attachments: [{ id: 'attachment-1', name: 'trace.txt', mime: 'text/plain' }],
    }));
    h.render();
    return h;
  }
  const menu = (h: HookHost<any>) => named(h.value, 'ModelMenu').props;
  const hint = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props?.className === 'cp-fork') ?? null;
  const pick = async (h: HookHost<any>) => {
    menu(h).onChange({ runtime: 'codex', backend: null, model: 'codex-a', effort: 'high' });
    await h.flush();
  };
  const send = async (h: HookHost<any>) => {
    named(h.value, 'SendButton').props.onPress();
    await h.flush();
  };
  const sent = () => bridge.command!.mock.calls.map(([c]: any) => c);

  it("offers the other runtimes' models and warns before the next message forks", async () => {
    const h = await composer();
    expect(menu(h).runtimes).toEqual(['claude', 'codex']);
    expect(hint(h)).toBeNull();
    await pick(h);
    expect(sent()).toEqual([]);
    expect(menu(h).value).toMatchObject({ runtime: 'codex', model: 'codex-a' });
    expect(text(hint(h))).toContain(
      t(
        {
          id: 'sessions.compose.handoff',
          defaultMessage: 'Switching to {runtime} opens a new session with only a text handoff',
        },
        { runtime: 'Codex' },
      ),
    );
    await send(h);
    expect(sent()).toHaveLength(1);
    // A fork opens a new session, so it names no revision; the source's would be refused.
    expect(sent()[0]).toMatchObject({ type: 'session.fork', expected_revision: null });
    expect(sent()[0].input).toEqual({
      session_id: 'session-a',
      runtime: 'codex',
      model: 'codex-a',
      effort: 'high',
      input: 'carry on',
      attachments: ['attachment-1'],
    });
    expect(mock.shell.openSession).toHaveBeenCalledWith('session-new');
  });

  it('forks on the send key as well', async () => {
    const h = await composer();
    await pick(h);
    const box = find(h.value, (n) => n.type === 'textarea');
    box.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    await h.flush();
    expect(sent().map((c: any) => c.type)).toEqual(['session.fork']);
  });

  it('goes back to the session model on cancel and sends the next message as before', async () => {
    const h = await composer();
    await pick(h);
    find(
      hint(h),
      (n) => n.type === 'button' && text(n) === zh('sessions.compose.handoffCancel'),
    ).props.onClick();
    await h.flush();
    expect(hint(h)).toBeNull();
    expect(menu(h).value).toMatchObject({ runtime: 'claude', model: 'claude-a' });
    await send(h);
    expect(sent().map((c: any) => c.type)).toEqual(['session.send']);
  });

  it('shows a failed fork in the warning line and keeps the switch', async () => {
    commandResult = { ok: false, error: { code: 'invalid_input', message: 'no such model' } };
    const h = await composer();
    await pick(h);
    await send(h);
    const alert = find(hint(h), (n) => n.props.role === 'alert');
    expect(text(alert)).toContain('no such model');
    expect(menu(h).value.runtime).toBe('codex');
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });

  it("offers no permission or fast mode while forking, which would change the source session's", async () => {
    const h = await composer({ fast_mode: { on: false } });
    expect(menu(h).mode).toBe('ask');
    expect(menu(h).fast).toEqual({ on: false });
    await pick(h);
    expect(menu(h).mode).toBeNull();
    expect(menu(h).fast).toBeNull();
  });

  it('marks a stored comment the fork carried as sent', async () => {
    const h = await composer();
    useFeedback.getState().add('session-a', {
      id: 'comment:comment-a',
      kind: 'comment',
      label: 'a.ts:3',
      text: 'Rename the flag',
      comment: { id: 'comment-a', revision: 2 },
    });
    h.render();
    await pick(h);
    await send(h);
    expect(sent()[0].input.input).toContain('Rename the flag');
    expect(sent().slice(1)).toMatchObject([
      {
        type: 'session.comment.resolve',
        input: { comment_id: 'comment-a', state: 'sent' },
        expected_revision: 2,
      },
    ]);
    expect(useFeedback.getState().items['session-a']).toEqual([]);
  });

  it('marks the stored comments a draft put back from the queue carries as sent once the fork succeeds', async () => {
    const h = await composer();
    useDrafts.getState().update(draftKey(`project-switch-${project}`, 'session-a'), (draft) => ({
      ...draft,
      comments: [{ id: 'comment-b', revision: 4 }],
    }));
    h.render();
    await pick(h);
    await send(h);
    expect(sent().map((c: any) => [c.type, c.input.comment_id, c.expected_revision])).toEqual([
      ['session.fork', undefined, null],
      ['session.comment.resolve', 'comment-b', 4],
    ]);
  });

  it('leaves the stored comments a draft carries open when the fork fails', async () => {
    commandResult = { ok: false, error: { code: 'invalid_input', message: 'no such model' } };
    const h = await composer();
    useDrafts.getState().update(draftKey(`project-switch-${project}`, 'session-a'), (draft) => ({
      ...draft,
      comments: [{ id: 'comment-b', revision: 4 }],
    }));
    h.render();
    await pick(h);
    await send(h);
    expect(sent().map((c: any) => c.type)).toEqual(['session.fork']);
  });
});
