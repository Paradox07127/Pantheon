import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { AttachmentMeta, RuntimeModel, WorkbenchSession } from '@pantheon/protocol';
import { zhf } from './i18n-setup.js';
import {
  deferred,
  find,
  type HookHost,
  mount,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any, toasts: [] as any[] }));
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
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => {
    mock.toasts.push(options);
    return 'toast';
  },
}));
import { draftKey, useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { failureText } from '@/data/needs-you';
import { useAttachments, useQueued } from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';

type How = 'send' | 'queue' | 'fork';

const meta = (id: string): AttachmentMeta => ({ id, name: id, mime: 'text/plain', size: 3 });
const model = (id: string): RuntimeModel => ({
  id,
  label: `label of ${id}`,
  permission_modes: ['plan', 'ask', 'auto_edit'],
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  default: false,
});
const row = (id: string, state: WorkbenchSession['state']): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Signature check',
  runtime: 'claude',
  model: 'claude-a',
  effort: 'medium',
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
});
const refused = { ok: false, error: { code: 'revision_conflict', message: 'stale' } };

let command: ReturnType<typeof vi.fn>;
let attachFile: ReturnType<typeof vi.fn>;
let session: Session;
let listed: WorkbenchSession;
let project = 0;

beforeEach(() => {
  mock.toasts = [];
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {}, failures: {} });
  useFeedback.setState({ items: {} });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = { openSession: vi.fn(), openSettings() {} };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  attachFile = vi.fn(async (_project: string, name: string) => ({ ok: true, value: meta(name) }));
  const answers: Record<string, unknown> = {
    'runtime.status': ['claude', 'codex'].map((runtime) => ({
      runtime,
      enabled: true,
      installed: true,
      auth: { state: 'logged_in' },
    })),
    'backend.list': [],
  };
  vi.stubGlobal('window', {
    pantheon: {
      command,
      attachFile,
      chooseFiles: vi.fn(async () => ({ ok: true, value: [] })),
      query: vi.fn(async (method: string, params: { runtime?: string }) =>
        method === 'runtime.models'
          ? { ok: true, value: [model(`${params.runtime}-a`)] }
          : method in answers
            ? { ok: true, value: answers[method] }
            : { ok: false, error: { code: 'unknown_route', message: method } },
      ),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

/** A composer of session-a that sends, queues or forks its next message. */
async function composer(how: How) {
  // The runtime models are read once per project; a new project reads them again.
  const projectId = `project-race-${++project}`;
  const running = how === 'queue';
  session = {
    id: 'session-a',
    revision: 3,
    project_id: projectId,
    runtime: 'claude',
    state: running ? 'running' : 'open',
    turn_count: 1,
  };
  listed = row('session-a', running ? 'running' : 'idle');
  const h = mount(() => SessionCompose({ session, listed, title: 'Signature check' }));
  await h.flush();
  if (how === 'fork') {
    named(h.value, 'ModelMenu').props.onChange({
      runtime: 'codex',
      backend: null,
      model: 'codex-a',
      effort: 'high',
    });
    await h.flush();
  }
  const key = draftKey(projectId, 'session-a');
  const files = mount(() => useAttachments(projectId, key));
  return { h, files, key };
}
const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
function type(h: HookHost<any>, value: string) {
  box(h).props.onChange({ target: { value, selectionStart: value.length } });
  h.render();
}
const press = (h: HookHost<any>) => named(h.value, 'SendButton').props.onPress();
const keyDown = (h: HookHost<any>, metaKey: boolean) =>
  box(h).props.onKeyDown({
    key: 'Enter',
    shiftKey: false,
    metaKey,
    ctrlKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
  });
const commands = () => command.mock.calls.map(([c]: any[]) => c);
/** The messages that went out: sent, forked or queued. */
const delivered = () => [
  ...commands()
    .filter((c: any) => c.type === 'session.send' || c.type === 'session.fork')
    .map((c: any) => ({ text: c.input.input, files: c.input.attachments ?? [] })),
  ...(useQueued.getState().queued['session-a'] ?? []).map((m) => ({
    text: m.text,
    files: m.attachments.map((a) => a.id),
  })),
];
const alerts = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));

describe("a session's message sent while its draft changes", () => {
  it.each<How>(['send', 'queue', 'fork'])(
    'keeps the message and says why when a file it waits for fails to upload (%s)',
    async (how) => {
      const { h, files, key } = await composer(how);
      const upload = deferred<unknown>();
      attachFile.mockReturnValueOnce(upload.promise);
      type(h, 'see the file');
      const adding = files.value.addFiles([new File(['a'], 'a.txt')]);
      press(h);
      await h.flush();
      upload.resolve({ ok: false, error: { code: 'attachment_too_large', message: 'too large' } });
      await adding;
      await h.flush();
      expect(delivered()).toEqual([]);
      expect(useDrafts.getState().drafts[key]?.text).toBe('see the file');
      expect(alerts(h)).toContain(zhf('sessions.composer.attachmentFailed', { name: 'a.txt' }));
      expect(named(h.value, 'SendButton').props.busy).toBe(false);
    },
  );

  it.each<How>(['send', 'queue', 'fork'])(
    'sends the files of the message and leaves a file added after it for the next (%s)',
    async (how) => {
      const { h, files, key } = await composer(how);
      const first = deferred<unknown>();
      attachFile.mockReturnValueOnce(first.promise);
      type(h, 'message A');
      const addingA = files.value.addFiles([new File(['a'], 'a.txt')]);
      press(h);
      await h.flush();
      type(h, 'message B');
      await files.value.addFiles([new File(['b'], 'b.txt')]);
      first.resolve({ ok: true, value: meta('att-a') });
      await addingA;
      await h.flush();
      expect(delivered()).toEqual([{ text: 'message A', files: ['att-a'] }]);
      const left = useDrafts.getState().drafts[key];
      expect(left?.text).toBe('message B');
      expect(left?.attachments.map((a) => a.id)).toEqual(['b.txt']);
    },
  );

  it.each<How>(['queue', 'fork'])(
    'keeps an item taken off and attached again while the message waits (%s)',
    async (how) => {
      const { h, key } = await composer(how);
      const item = {
        id: 'reference:src/a.ts',
        kind: 'reference' as const,
        label: 'src/a.ts',
        text: '@src/a.ts',
      };
      useFeedback.getState().add('session-a', item);
      useDrafts.getState().update(key, () => ({ uploading: 1 }));
      type(h, 'look here');
      press(h);
      await h.flush();
      useFeedback.getState().remove('session-a', item.id);
      const again = { ...item };
      useFeedback.getState().add('session-a', again);
      useDrafts.getState().update(key, () => ({ uploading: 0 }));
      await h.flush();
      expect(delivered()).toHaveLength(1);
      expect(useFeedback.getState().items['session-a']).toEqual([again]);
    },
  );

  it.each<How>(['queue', 'fork'])(
    'leaves references, comments and skills added while the message waits for the next one (%s)',
    async (how) => {
      const { h, key } = await composer(how);
      useDrafts.getState().update(key, () => ({ uploading: 1 }));
      type(h, 'message A $lint');
      press(h);
      await h.flush();
      const later = {
        refs: [row('session-r', 'idle')],
        github: [{ kind: 'pr' as const, number: 7, title: 'Fix the header' }],
        comments: [{ id: 'comment-b', revision: 1 }],
        skills: [{ name: 'lint', path: '/skills/lint' }],
      };
      useDrafts.getState().update(key, () => ({ ...later, uploading: 0 }));
      await h.flush();
      const forked = commands().find((c: any) => c.type === 'session.fork');
      const queued = useQueued.getState().queued['session-a'] ?? [];
      const out = how === 'fork' ? forked?.input : queued[0];
      expect(out).toBeDefined();
      expect(out.refs).toBeUndefined();
      expect(out.github).toBeUndefined();
      expect(out.comments).toBeUndefined();
      expect(out.skills ?? []).toEqual([]);
      expect(commands().filter((c: any) => c.type === 'session.comment.resolve')).toEqual([]);
      const left = useDrafts.getState().drafts[key];
      expect(left?.refs).toEqual(later.refs);
      expect(left?.github).toEqual(later.github);
      expect(left?.comments).toEqual(later.comments);
      expect(left?.skills).toEqual(later.skills);
    },
  );

  it.each<How>(['queue', 'fork'])(
    'keeps the skill the text typed while the message waits still names (%s)',
    async (how) => {
      const { h, key } = await composer(how);
      const review = { name: 'review', path: '/skills/review' };
      useDrafts.getState().update(key, () => ({ skills: [review], uploading: 1 }));
      type(h, '$review first');
      press(h);
      await h.flush();
      type(h, '$review second');
      useDrafts.getState().update(key, () => ({ uploading: 0 }));
      await h.flush();
      expect(delivered().map((m) => m.text)).toEqual(['$review first']);
      const left = useDrafts.getState().drafts[key];
      expect(left?.text).toBe('$review second');
      expect(left?.skills).toEqual([review]);
    },
  );

  it.each<How>(['queue', 'fork'])(
    'carries a comment both in the draft and attached once (%s)',
    async (how) => {
      const { h, key } = await composer(how);
      const comment = { id: 'comment-a', revision: 2 };
      useFeedback.getState().add('session-a', {
        id: 'comment:comment-a',
        kind: 'comment',
        label: 'a.ts:3',
        text: 'Rename the flag',
        comment,
      });
      useDrafts.getState().update(key, () => ({ comments: [comment] }));
      type(h, 'carry on');
      press(h);
      await h.flush();
      if (how === 'queue')
        expect(useQueued.getState().queued['session-a']?.[0]?.comments).toEqual([comment]);
      else
        expect(commands().filter((c: any) => c.type === 'session.comment.resolve')).toHaveLength(1);
    },
  );

  it('shows a failure toast for each comment the fork carried that cannot be marked sent', async () => {
    const { h, key } = await composer('fork');
    command.mockImplementation(async (c: any) =>
      c.type === 'session.comment.resolve' ? refused : { ok: true, value: { id: 'session-new' } },
    );
    useFeedback.getState().add('session-a', {
      id: 'comment:comment-a',
      kind: 'comment',
      label: 'a.ts:3',
      text: 'Rename the flag',
      comment: { id: 'comment-a', revision: 2 },
    });
    useDrafts.getState().update(key, () => ({ comments: [{ id: 'comment-b', revision: 4 }] }));
    type(h, 'carry on');
    press(h);
    await h.flush();
    expect(commands().map((c: any) => c.type)).toEqual([
      'session.fork',
      'session.comment.resolve',
      'session.comment.resolve',
    ]);
    const failed = { title: failureText(refused.error as any), kind: 'failure' };
    expect(mock.toasts).toEqual([failed, failed]);
  });

  it('does not steer the text a send key is queueing while its files upload', async () => {
    const { h, key } = await composer('queue');
    useDrafts.getState().update(key, () => ({ uploading: 1 }));
    type(h, 'fix the header');
    keyDown(h, false);
    keyDown(h, true);
    useDrafts.getState().update(key, () => ({ uploading: 0 }));
    await h.flush();
    expect(commands()).toEqual([]);
    expect(delivered()).toEqual([{ text: 'fix the header', files: [] }]);
  });

  it('leaves the view on the session shown when a fork answers after a switch', async () => {
    const { h } = await composer('fork');
    const forked = deferred<unknown>();
    command.mockReturnValueOnce(forked.promise);
    type(h, 'carry on');
    press(h);
    await h.flush();
    session = { ...session, id: 'session-b' };
    listed = row('session-b', 'idle');
    h.render();
    forked.resolve({ ok: true, value: { id: 'session-new' } });
    await h.flush();
    expect(commands().map((c: any) => c.type)).toEqual(['session.fork']);
    expect(mock.shell.openSession).not.toHaveBeenCalled();
  });
});
