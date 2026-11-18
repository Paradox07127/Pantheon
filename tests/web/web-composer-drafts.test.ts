import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { AttachmentMeta, BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import {
  deferred,
  find,
  type HookHost,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'card' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useCurrentProject } from '@/data/current-project';
import { draftKey, useDrafts } from '@/data/drafts';
import { usePrefill, useQueued, type QueuedMessage } from '@/screens/sessions/parts';
import { useShell } from '@/store';
import { QueueDock } from '@/screens/sessions/QueueDock';
import { QuestionCard } from '@/components/QuestionCard';
import { NewSession, SessionCompose } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const meta = (id: string): AttachmentMeta => ({
  id,
  name: `name of ${id}`,
  mime: 'text/plain',
  size: 3,
});
const listed = (id: string): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'codex',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});
const idle = (id: string): Session => ({
  id,
  revision: 2,
  project_id: 'project-a',
  runtime: 'codex',
  state: 'open',
  turn_count: 1,
});
const skill = { name: 'review', path: '/skills/review/SKILL.md' };

let command: ReturnType<typeof vi.fn>;
let chooseFiles: ReturnType<typeof vi.fn>;
let attachFile: ReturnType<typeof vi.fn>;
const compose = (session: Session) =>
  host(() =>
    SessionCompose({ session, listed: listed(session.id), title: `title of ${session.id}` }),
  );
const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
const strip = (h: HookHost<any>) => named(h.value, 'AttachmentStrip').props;
const ids = (h: HookHost<any>) => strip(h).items.map((a: AttachmentMeta) => a.id);
const key = (extra: object = {}) => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  nativeEvent: { isComposing: false },
  preventDefault() {},
  ...extra,
});
function type(h: HookHost<any>, input: string) {
  box(h).props.onChange({ target: { value: input } });
  h.render();
}
async function attach(h: HookHost<any>, ...items: AttachmentMeta[]) {
  chooseFiles.mockResolvedValueOnce({ ok: true, value: items });
  // Both composers add a file from their add menu.
  find(
    h.value,
    (n) => text(n) === zh('sessions.composer.addFile') && n.props.onClick,
  ).props.onClick();
  await h.flush();
  h.render();
}
function paste(h: HookHost<any>, name: string) {
  box(h).props.onPaste({
    clipboardData: { files: [new File(['png'], name, { type: 'image/png' })], getData: () => '' },
    preventDefault() {},
  });
}
const sent = () => command.mock.calls.map(([c]) => [c.type, c.input]);

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {} });
  usePrefill.setState({ prefill: {} });
  mock.board = {
    board: { cursor: 1, projects: [] },
    events: [],
    resync: 0,
    status: { state: 'live' },
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  chooseFiles = vi.fn(async () => ({ ok: true, value: [] }));
  attachFile = vi.fn(async (_project: string, name: string, mime: string) => ({
    ok: true,
    value: { id: `uploaded ${name}`, name, mime, size: 3 },
  }));
  vi.stubGlobal('window', {
    pantheon: {
      command,
      chooseFiles,
      attachFile,
      query: vi.fn(async () => ({ ok: true, value: [] })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('session composer drafts', () => {
  it('keeps each session draft when another session is opened and then returned to', async () => {
    const a = compose(idle('session-a'));
    type(a, 'half a thought');
    await attach(a, meta('file-a'));
    a.unmount();
    const b = compose(idle('session-b'));
    expect(box(b).props.value).toBe('');
    expect(ids(b)).toEqual([]);
    b.unmount();
    const back = compose(idle('session-a'));
    expect(box(back).props.value).toBe('half a thought');
    expect(ids(back)).toEqual(['file-a']);
  });

  it('keeps a picked skill with the draft across a remount', async () => {
    useDrafts.getState().update(draftKey('project-a', 'session-a'), () => ({
      text: '$review the diff',
      skills: [skill],
    }));
    const h = compose(idle('session-a'));
    expect(box(h).props.value).toBe('$review the diff');
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(sent()).toEqual([
      ['session.send', { session_id: 'session-a', input: '$review the diff', skills: [skill] }],
    ]);
  });

  it('keeps a skill the text written while the message was being sent still names', async () => {
    const answer = deferred<BridgeResult<unknown>>();
    command.mockImplementationOnce(() => answer.promise);
    useDrafts.getState().update(draftKey('project-a', 'session-a'), () => ({
      text: '$review the diff',
      skills: [skill],
    }));
    const h = compose(idle('session-a'));
    box(h).props.onKeyDown(key());
    type(h, '$review the tests');
    answer.resolve({ ok: true, value: {} });
    await h.flush();
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(sent()).toEqual([
      ['session.send', { session_id: 'session-a', input: '$review the diff', skills: [skill] }],
      ['session.send', { session_id: 'session-a', input: '$review the tests', skills: [skill] }],
    ]);
  });

  it('puts a handed-over message after the draft and keeps its files and skills', () => {
    const h = compose(idle('session-a'));
    type(h, 'my own words');
    usePrefill
      .getState()
      .set('session-a', { text: 'rewritten', attachments: [meta('file-q')], skills: [skill] });
    // The composer takes the handed-over message in an effect; the next render shows it.
    h.render();
    h.render();
    expect(box(h).props.value).toBe('my own words\n\nrewritten');
    expect(ids(h)).toEqual(['file-q']);
  });

  it('keeps the skill a handed-over message picked over a picked skill of the same name', () => {
    const key = draftKey('project-a', 'session-a');
    const other = { name: 'review', path: '/plugins/docs/skills/review/SKILL.md' };
    useDrafts.getState().update(key, () => ({ text: '$review first', skills: [other] }));
    useDrafts.getState().put(key, { text: '$review again', attachments: [], skills: [skill] });
    expect(useDrafts.getState().drafts[key]!.skills).toEqual([skill]);
  });

  it('puts a handed-over message into an empty draft as it is', () => {
    usePrefill.getState().set('session-a', { text: 'rewritten', attachments: [], skills: [] });
    const h = compose(idle('session-a'));
    h.render();
    expect(box(h).props.value).toBe('rewritten');
  });

  it('moves an edited queued message with its files and skills into the box', async () => {
    const running = { ...idle('session-a'), state: 'running' as const };
    const queued: QueuedMessage = {
      text: '$review later',
      attachments: [meta('file-q')],
      skills: [skill],
    };
    useQueued.setState({ queued: { 'session-a': [queued] } });
    const h = compose(running);
    type(h, 'draft first');
    const turns = host(() => QueueDock({ session: running }));
    find(
      turns.value,
      (n) => n.props['aria-label'] === zh('sessions.composer.editQueued'),
    ).props.onClick();
    // The composer takes the handed-over message in an effect; the next render shows it.
    h.render();
    h.render();
    expect(useQueued.getState().queued['session-a']).toEqual([]);
    expect(box(h).props.value).toBe('draft first\n\n$review later');
    expect(ids(h)).toEqual(['file-q']);
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    box(h).props.onKeyDown(key({ metaKey: true }));
    await h.flush();
    expect(sent()).toEqual([
      [
        'session.steer',
        {
          session_id: 'session-a',
          input: 'draft first\n\n$review later',
          attachments: ['file-q'],
          skills: [skill],
        },
      ],
    ]);
  });

  it('waits for a pasted file to upload before sending', async () => {
    const upload = deferred<BridgeResult<AttachmentMeta>>();
    attachFile.mockReturnValueOnce(upload.promise);
    const h = compose(idle('session-a'));
    paste(h, 'shot.png');
    await h.flush();
    type(h, 'see the shot');
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    upload.resolve({ ok: true, value: meta('file-shot') });
    await h.flush();
    h.render();
    expect(sent()).toEqual([
      [
        'session.send',
        { session_id: 'session-a', input: 'see the shot', attachments: ['file-shot'] },
      ],
    ]);
    expect(ids(h)).toEqual([]);
    expect(box(h).props.value).toBe('');
  });

  it('waits for a pasted file to upload before queueing', async () => {
    const upload = deferred<BridgeResult<AttachmentMeta>>();
    attachFile.mockReturnValueOnce(upload.promise);
    const h = compose({ ...idle('session-a'), state: 'running' });
    paste(h, 'shot.png');
    await h.flush();
    type(h, 'later');
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(useQueued.getState().queued['session-a'] ?? []).toEqual([]);
    upload.resolve({ ok: true, value: meta('file-shot') });
    await h.flush();
    h.render();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'later', attachments: [meta('file-shot')], skills: [] },
    ]);
    expect(ids(h)).toEqual([]);
  });
});

describe('queued rows', () => {
  it('keeps each row keyed to its own message when the first one leaves', () => {
    const one: QueuedMessage = { text: 'one', attachments: [], skills: [] };
    const two: QueuedMessage = { text: 'two', attachments: [], skills: [] };
    useQueued.setState({ queued: { 'session-a': [one, two] } });
    const session = { ...idle('session-a'), state: 'running' as const };
    const h = host(() => QueueDock({ session }));
    const rows = () =>
      nodes(h.value)
        .filter((n) => n.props.role === 'listitem')
        .map((row) => row.key);
    const [, second] = rows();
    useQueued.getState().shift('session-a');
    h.render();
    expect(rows()).toEqual([second]);
  });
});

describe('new session drafts', () => {
  const props = (projectId: string) => ({
    projectId,
    defaults: undefined,
    focus: 0,
    onCreated() {},
    recent: [],
    onOpen() {},
    onClose() {},
  });

  it('keeps the new-session draft across a remount', async () => {
    const first = host(() => NewSession(props('project-a')));
    type(first, 'start the API');
    await attach(first, meta('file-a'));
    first.unmount();
    const again = host(() => NewSession(props('project-a')));
    expect(box(again).props.value).toBe('start the API');
    expect(ids(again)).toEqual(['file-a']);
  });

  it('waits for uploads and keeps a file added while the session was being created', async () => {
    const upload = deferred<BridgeResult<AttachmentMeta>>();
    attachFile.mockReturnValueOnce(upload.promise);
    const created = deferred<BridgeResult<unknown>>();
    command.mockReturnValueOnce(created.promise);
    const h = host(() => NewSession(props('project-a')));
    paste(h, 'shot.png');
    await h.flush();
    type(h, 'start');
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    upload.resolve({ ok: true, value: meta('file-shot') });
    await h.flush();
    expect(command.mock.calls[0]![0].input.attachments).toEqual(['file-shot']);
    await attach(h, meta('file-later'));
    created.resolve({ ok: true, value: { id: 'session-new' } });
    await h.flush();
    h.render();
    expect(ids(h)).toEqual(['file-later']);
  });

  it('opens the created session only while its project composer is still shown', async () => {
    const opened: string[] = [];
    const created = deferred<BridgeResult<unknown>>();
    command.mockReturnValueOnce(created.promise);
    let projectId = 'project-a';
    const h = host(() =>
      NewSession({ ...props(projectId), onCreated: (id: string) => opened.push(id) }),
    );
    type(h, 'start the API');
    box(h).props.onKeyDown(key());
    await h.flush();
    projectId = 'project-b';
    h.render();
    const otherTask = { id: 'task-b', title: 'Task of project b', goal: 'Ship b' };
    useShell.setState({ sessionTask: otherTask });
    created.resolve({ ok: true, value: { id: 'session-new' } });
    await h.flush();
    expect(opened).toEqual([]);
    expect(useShell.getState().sessionTask).toEqual(otherTask);

    projectId = 'project-a';
    h.render();
    type(h, 'start the API again');
    box(h).props.onKeyDown(key());
    await h.flush();
    expect(opened).toEqual(['session-new']);
  });

  it('keeps a file uploading for one project out of another project composer', async () => {
    const upload = deferred<BridgeResult<AttachmentMeta>>();
    attachFile.mockReturnValueOnce(upload.promise);
    let projectId = 'project-a';
    const h = host(() => NewSession(props(projectId)));
    paste(h, 'shot.png');
    await h.flush();
    projectId = 'project-b';
    h.render();
    upload.resolve({ ok: true, value: meta('file-shot') });
    await h.flush();
    h.render();
    expect(ids(h)).toEqual([]);
    projectId = 'project-a';
    h.render();
    expect(ids(h)).toEqual(['file-shot']);
  });
});

describe('question card drafts', () => {
  const onSend = vi.fn();
  const card = (permission: {
    id: string;
    questions: Parameters<typeof QuestionCard>[0]['questions'];
  }) =>
    host(() =>
      QuestionCard({
        draft: permission.id,
        questions: permission.questions,
        label: '',
        reason: null,
        busy: false,
        error: null,
        onSend,
      }),
    );
  const pick = (h: HookHost<any>, label: string) =>
    find(h.value, (n) => n.props.role === 'radio' && text(n).includes(label));
  const field = (h: HookHost<any>, id: string) =>
    find(h.value, (n) => n.props['aria-label'] === zh(id));

  it('keeps unfinished answers when the card mounts again', () => {
    const permission = {
      id: 'approval-ask',
      questions: [
        {
          question: 'Which package manager?',
          header: 'Tooling',
          options: [{ label: 'pnpm', description: '' }],
          multiSelect: false,
        },
        { question: 'Anything else?', header: '', options: [], multiSelect: false },
      ],
    };
    const first = card(permission);
    pick(first, 'pnpm').props.onClick();
    first.render();
    field(first, 'components.questionCard.answer').props.onChange({
      target: { value: 'run the linter' },
    });
    first.render();
    first.unmount();
    const again = card(permission);
    expect(pick(again, 'pnpm').props['aria-checked']).toBe(true);
    expect(field(again, 'components.questionCard.answer').props.value).toBe('run the linter');
  });

  const choosing = {
    id: 'approval-choose',
    questions: [
      {
        question: 'Keep the config?',
        header: '',
        options: [{ label: 'Keep existing', description: '' }],
        multiSelect: false,
      },
    ],
  };
  const own = (h: HookHost<any>) => field(h, 'components.questionCard.otherAnswer');
  const submit = (h: HookHost<any>) => {
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('components.questionCard.send'),
    ).props.onClick();
    return onSend.mock.calls.at(-1)![0];
  };

  it('sends the option picked after a typed answer, and clears the typed one', () => {
    const h = card(choosing);
    own(h).props.onChange({ target: { value: 'replace it' } });
    h.render();
    pick(h, 'Keep existing').props.onClick();
    h.render();
    expect(own(h).props.value).toBe('');
    expect(submit(h)).toEqual({ 'Keep the config?': 'Keep existing' });
  });

  it('sends a typed answer written after an option was picked, and unpicks the option', () => {
    const h = card(choosing);
    pick(h, 'Keep existing').props.onClick();
    h.render();
    own(h).props.onChange({ target: { value: 'replace it' } });
    h.render();
    expect(pick(h, 'Keep existing').props['aria-checked']).toBe(false);
    expect(submit(h)).toEqual({ 'Keep the config?': 'replace it' });
  });
});

describe('new session project picker', () => {
  it('opens the new-session composer of the picked project, not its remembered place', async () => {
    mock.board.board.projects = [
      { id: 'project-a', name: 'Alpha' },
      { id: 'project-b', name: 'Beta' },
    ];
    const openProject = vi.spyOn(useShell.getState(), 'openProject');
    useShell.getState().openSession('session-b');
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
    find(h.value, (n) => n.props.value === 'project-b' && n.props.onClick).props.onClick();
    expect(openProject).not.toHaveBeenCalled();
    expect(useShell.getState()).toMatchObject({ screen: 'sessions', sessionId: '' });
    expect(useCurrentProject.getState().projectId).toBe('project-b');
    openProject.mockRestore();
  });
});
