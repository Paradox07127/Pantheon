import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { AttachmentMeta, WorkbenchSession } from '@pantheon/protocol';
import { FileText, ImageIcon } from '../../apps/web/node_modules/lucide-react';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
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
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { draftKey, useDrafts, type DraftAttachment } from '@/data/drafts';
import { failureText } from '@/data/needs-you';
import { markSend } from '@/screens/sessions/attachments';
import { newSessionInput } from '@/screens/sessions/model';
import {
  AttachmentStrip,
  useAttachments,
  useQueueDispatch,
  useQueued,
} from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const meta = (id: string, mime = 'text/plain'): AttachmentMeta => ({
  id,
  name: `name of ${id}`,
  mime,
  size: 3,
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

let session: Session;
let command: ReturnType<typeof vi.fn>;
let chooseFiles: ReturnType<typeof vi.fn>;
let attachFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  session = running;
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {} });
  mock.board = {
    status: { state: 'live' },
    board: { cursor: 1, projects: [] },
    events: [],
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  chooseFiles = vi.fn(async () => ({ ok: true, value: [] }));
  let uploaded = 0;
  attachFile = vi.fn(async (_project: string, name: string, mime: string) => ({
    ok: true,
    value: { id: `uploaded-${++uploaded}`, name, mime, size: 3 },
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

describe('attachment list', () => {
  // The list lives in the draft store, which these tests read on the next render.
  const list = () => host(() => useAttachments('project-a', draftKey('project-a', 'session-a')));

  it('appends the files chosen in the dialog', async () => {
    chooseFiles.mockResolvedValueOnce({ ok: true, value: [meta('file-a')] });
    chooseFiles.mockResolvedValueOnce({ ok: true, value: [meta('file-b'), meta('file-c')] });
    const h = list();
    await h.value.choose();
    await h.flush();
    await h.value.choose();
    h.render();
    expect(chooseFiles).toHaveBeenCalledWith('project-a');
    expect(h.value.items.map((a: DraftAttachment) => a.id)).toEqual(['file-a', 'file-b', 'file-c']);
    expect(h.value.error).toBeNull();
  });

  it('keeps the files the dialog uploaded when one of them was too large, and says why', async () => {
    chooseFiles.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'attachment_too_large',
        message: 'big.bin is over 20 MiB',
        details: { attached: [meta('file-a')] },
      },
    });
    const h = list();
    await h.value.choose();
    h.render();
    expect(h.value.items.map((a: DraftAttachment) => a.id)).toEqual(['file-a']);
    expect(h.value.error).toEqual(expect.stringContaining('big.bin is over 20 MiB'));
  });

  it('uploads each pasted or dropped file once with its name, type and bytes', async () => {
    const h = list();
    await h.value.addFiles([
      new File(['png'], 'shot.png', { type: 'image/png' }),
      new File(['txt'], 'notes.txt', { type: 'text/plain' }),
    ]);
    h.render();
    expect(attachFile.mock.calls).toEqual([
      ['project-a', 'shot.png', 'image/png', new Uint8Array([112, 110, 103])],
      ['project-a', 'notes.txt', 'text/plain', new Uint8Array([116, 120, 116])],
    ]);
    expect(h.value.items.map((a: DraftAttachment) => a.name)).toEqual(['shot.png', 'notes.txt']);
    expect(h.value.pending).toEqual([]);
  });

  it('keeps at most ten attachments and says why the rest were left out', async () => {
    chooseFiles.mockResolvedValueOnce({
      ok: true,
      value: Array.from({ length: 9 }, (_, i) => meta(`file-${i}`)),
    });
    const h = list();
    await h.value.choose();
    await h.flush();
    await h.value.addFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    h.render();
    expect(attachFile).toHaveBeenCalledTimes(1);
    expect(h.value.items).toHaveLength(10);
    expect(h.value.error).toEqual(expect.any(String));
  });

  it('keeps a failed upload apart from the others and sends it again on retry', async () => {
    attachFile.mockResolvedValueOnce({
      ok: false,
      error: { code: 'attachment_too_large', message: 'too large' },
    });
    const h = list();
    await h.value.addFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    h.render();
    expect(h.value.items.map((a: DraftAttachment) => a.name)).toEqual(['b.txt']);
    expect(h.value.pending).toMatchObject([
      { state: 'failed', error: expect.stringContaining('too large') },
    ]);
    expect(h.value.error).toBeNull();
    expect(useDrafts.getState().drafts[draftKey('project-a', 'session-a')]?.uploading).toBe(0);
    await h.value.retry(h.value.pending[0]!.id);
    h.render();
    expect(attachFile.mock.calls.map(([, name]) => name)).toEqual(['a.txt', 'b.txt', 'a.txt']);
    expect(h.value.items.map((a: DraftAttachment) => a.name)).toEqual(['b.txt', 'a.txt']);
    expect(h.value.pending).toEqual([]);
  });

  it('stops waiting for files removed while they upload, and uploads no removed one', async () => {
    const first = deferred<unknown>();
    attachFile.mockReturnValueOnce(first.promise);
    const key = draftKey('project-a', 'session-a');
    const h = list();
    const adding = h.value.addFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    await h.flush();
    expect(attachFile).toHaveBeenCalledTimes(1);
    h.render();
    expect(h.value.pending).toHaveLength(2);
    for (const p of h.value.pending) h.value.remove(p.id);
    h.render();
    expect(useDrafts.getState().drafts[key]?.uploading ?? 0).toBe(0);
    first.resolve({ ok: true, value: meta('file-a') });
    await adding;
    h.render();
    expect(attachFile).toHaveBeenCalledTimes(1);
    expect(useDrafts.getState().drafts[key]?.uploading ?? 0).toBe(0);
    expect(h.value.items).toEqual([]);
  });

  it('keeps a message waiting on a file whose retry began after it was sent', async () => {
    const key = draftKey('project-a', 'session-a');
    const later = deferred<unknown>();
    attachFile.mockResolvedValueOnce({ ok: false, error: { code: 'ipc_failed', message: 'x' } });
    attachFile.mockReturnValueOnce(later.promise);
    const h = list();
    const adding = h.value.addFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    await h.flush();
    h.render();
    const files = markSend(key);
    const failedId = h.value.pending.find((p: { state: string }) => p.state === 'failed')!.id;
    await h.value.retry(failedId);
    later.resolve({ ok: true, value: meta('file-b') });
    await adding;
    h.render();
    expect(files.failure()).toBeNull();
    expect(files.ids()).toEqual(['uploaded-1', 'file-b']);
  });

  it('sends the files held or uploading when the message was sent, not ones added while it waits', async () => {
    const key = draftKey('project-a', 'session-a');
    const later = deferred<unknown>();
    chooseFiles.mockResolvedValueOnce({ ok: true, value: [meta('file-a')] });
    attachFile.mockReturnValueOnce(later.promise);
    const h = list();
    await h.value.choose();
    const adding = h.value.addFiles([new File(['b'], 'b.txt')]);
    await h.flush();
    const files = markSend(key);
    // Another window attaches a file to the same draft while the message waits.
    useDrafts
      .getState()
      .update(key, (draft) => ({ attachments: [...draft.attachments, meta('file-c')] }));
    later.resolve({ ok: true, value: meta('file-b') });
    await adding;
    expect(files.ids()).toEqual(['file-a', 'file-b']);
  });

  it('refuses a message waiting on a file dialog that failed', async () => {
    const key = draftKey('project-a', 'session-a');
    const dialog = deferred<unknown>();
    chooseFiles.mockReturnValueOnce(dialog.promise);
    const h = list();
    const choosing = h.value.choose();
    const files = markSend(key);
    const error = { code: 'ipc_failed', message: 'dialog failed' };
    dialog.resolve({ ok: false, error });
    await choosing;
    expect(files.failure()).toBe(failureText(error));
  });

  it('refuses a message waiting on a window snapshot that failed', async () => {
    const key = draftKey('project-a', 'session-a');
    const shot = deferred<unknown>();
    (window.pantheon as any).snapshotWindow = vi.fn(() => shot.promise);
    const h = list();
    const snapping = h.value.snapshot('window-a');
    const files = markSend(key);
    const error = { code: 'ipc_failed', message: 'snapshot failed' };
    shot.resolve({ ok: false, error });
    await snapping;
    expect(files.failure()).toBe(failureText(error));
  });

  it('removes one attachment', async () => {
    chooseFiles.mockResolvedValueOnce({ ok: true, value: [meta('file-a'), meta('file-b')] });
    const h = list();
    await h.value.choose();
    h.value.remove('file-a');
    h.render();
    expect(h.value.items.map((a: DraftAttachment) => a.id)).toEqual(['file-b']);
  });
});

describe('attachment strip', () => {
  /** The tiles of the strip, each drawn with the props the strip gave it. */
  const tiles = (tree: ReturnType<typeof AttachmentStrip>) =>
    nodes(tree)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'AttachmentTile')
      .map((n) => (n.type as (props: unknown) => any)(n.props))
      .map((tile) => (tile.props.role === 'listitem' ? tile : tile.props.children));

  it('names each attachment on its tile and removes it with its cross', () => {
    const onRemove = vi.fn();
    const tree = AttachmentStrip({
      items: [meta('file-a', 'image/png'), meta('file-b')],
      pending: [],
      onRemove,
    });
    const shown = tiles(tree);
    expect(shown.map((tile) => tile.props['aria-label'])).toEqual([
      'name of file-a',
      'name of file-b',
    ]);
    expect(shown.map((tile) => nodes(tile).some((n) => n.type === ImageIcon))).toEqual([
      true,
      false,
    ]);
    expect(shown.map((tile) => nodes(tile).some((n) => n.type === FileText))).toEqual([
      false,
      true,
    ]);
    expect(text(shown[1])).toContain('name of file-b');
    find(
      shown[1],
      (n) =>
        n.props['aria-label'] ===
        t(
          { id: 'sessions.composer.removeAttachment', defaultMessage: '' },
          { name: 'name of file-b' },
        ),
    ).props.onClick();
    expect(onRemove).toHaveBeenCalledWith('file-b');
  });

  it('marks an uploading file without a percent and a failed one with its retry and error', () => {
    const onRetry = vi.fn();
    const file = (name: string) => new File(['x'], name, { type: 'text/plain' });
    const tree = AttachmentStrip({
      items: [],
      pending: [
        { id: 'upload-a', file: file('a.txt'), state: 'uploading', error: null },
        { id: 'upload-b', file: file('b.txt'), state: 'failed', error: 'too large' },
      ],
      onRemove() {},
      onRetry,
    });
    const [uploading, failed] = tiles(tree);
    expect(uploading.props['aria-label']).toBe(
      t({ id: 'sessions.composer.attachmentUploading', defaultMessage: '' }, { name: 'a.txt' }),
    );
    expect(
      nodes(uploading).some((n) => typeof n.type === 'function' && n.type.name === 'Skeleton'),
    ).toBe(true);
    expect(text(uploading)).not.toContain('%');
    expect(failed.props['aria-label']).toBe(
      t({ id: 'sessions.composer.attachmentFailed', defaultMessage: '' }, { name: 'b.txt' }),
    );
    expect(failed.props['data-bad']).toBe(true);
    const tip = nodes(tree)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'AttachmentTile')
      .map((n) => (n.type as (props: unknown) => any)(n.props))[1];
    expect(tip.props.content).toBe('too large');
    find(
      failed,
      (n) => n.props['aria-label'] === zh('sessions.composer.retryUpload'),
    ).props.onClick();
    expect(onRetry).toHaveBeenCalledWith('upload-b');
  });

  it('draws nothing when empty', () => {
    expect(AttachmentStrip({ items: [], pending: [], onRemove() {} })).toBeNull();
  });
});

describe('composer attachments', () => {
  const mount = () => host(() => SessionCompose({ session, listed, title: 'title of session-a' }));
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const key = (extra: object) => ({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
    ...extra,
  });
  async function attach(h: HookHost<any>, ...items: AttachmentMeta[]) {
    chooseFiles.mockResolvedValueOnce({ ok: true, value: items });
    find(
      h.value,
      (n) => text(n) === zh('sessions.composer.addFile') && n.props.onClick,
    ).props.onClick();
    await h.flush();
    h.render();
  }
  function type(h: HookHost<any>, input: string) {
    box(h).props.onChange({ target: { value: input } });
    h.render();
  }
  const strip = (h: HookHost<any>) => named(h.value, 'AttachmentStrip').props;

  it('sends the attachment ids with the message and then clears them', async () => {
    session = { ...running, state: 'open' };
    const h = mount();
    await attach(h, meta('file-a'), meta('file-b'));
    expect(strip(h).items.map((a: AttachmentMeta) => a.id)).toEqual(['file-a', 'file-b']);
    type(h, 'look at these');
    box(h).props.onKeyDown(key({}));
    await h.flush();
    expect(command.mock.calls.map(([c]) => c.input)).toEqual([
      { session_id: 'session-a', input: 'look at these', attachments: ['file-a', 'file-b'] },
    ]);
    expect(strip(h).items).toEqual([]);
  });

  it('keeps an attachment added while the message was being sent', async () => {
    session = { ...running, state: 'open' };
    let answer!: (value: unknown) => void;
    command.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const h = mount();
    await attach(h, meta('file-a'));
    type(h, 'first');
    box(h).props.onKeyDown(key({}));
    await attach(h, meta('file-c'));
    answer({ ok: true, value: {} });
    await h.flush();
    expect(strip(h).items.map((a: AttachmentMeta) => a.id)).toEqual(['file-c']);
  });

  it('uploads pasted files and leaves pasted text alone', async () => {
    const h = mount();
    const prevent = vi.fn();
    box(h).props.onPaste({
      clipboardData: { files: [], getData: () => '' },
      preventDefault: prevent,
    });
    expect(prevent).not.toHaveBeenCalled();
    box(h).props.onPaste({
      clipboardData: {
        files: [new File(['png'], 'shot.png', { type: 'image/png' })],
        getData: () => '',
      },
      preventDefault: prevent,
    });
    await h.flush();
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(attachFile).toHaveBeenCalledWith(
      'project-a',
      'shot.png',
      'image/png',
      expect.any(Uint8Array),
    );
    h.render();
    expect(strip(h).items.map((a: AttachmentMeta) => a.name)).toEqual(['shot.png']);
  });

  it('uploads the pasted files and lets the text pasted with them reach the box', async () => {
    const h = mount();
    const prevent = vi.fn();
    box(h).props.onPaste({
      clipboardData: {
        files: [new File(['png'], 'shot.png', { type: 'image/png' })],
        getData: (type: string) => (type === 'text/plain' ? 'see the screenshot' : ''),
      },
      preventDefault: prevent,
    });
    await h.flush();
    expect(prevent).not.toHaveBeenCalled();
    expect(attachFile).toHaveBeenCalledWith(
      'project-a',
      'shot.png',
      'image/png',
      expect.any(Uint8Array),
    );
  });

  it('offers no file to add where the session takes no attachments', () => {
    const h = host(() =>
      SessionCompose({
        session,
        listed: { ...listed, state: 'discarded' },
        title: 'title of session-a',
      }),
    );
    expect(nodes(h.value).some((n) => text(n) === zh('sessions.composer.addFile'))).toBe(false);
  });

  it('sends the attachments of a session without a worktree', async () => {
    session = { ...running, state: 'open' };
    const h = host(() =>
      SessionCompose({
        session,
        listed: { ...listed, state: 'idle', workspace_id: null },
        title: 'Assistant',
      }),
    );
    await attach(h, meta('file-a'));
    type(h, 'look at this');
    box(h).props.onKeyDown(key({}));
    await h.flush();
    expect(command.mock.calls.map(([c]) => c.input)).toEqual([
      { session_id: 'session-a', input: 'look at this', attachments: ['file-a'] },
    ]);
  });

  it('queues the attachments with the message and sends their ids later', async () => {
    const h = mount();
    await attach(h, meta('file-a'));
    type(h, 'later');
    box(h).props.onKeyDown(key({}));
    h.render();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'later', attachments: [meta('file-a')], skills: [] },
    ]);
    expect(strip(h).items).toEqual([]);
    session = { ...running, state: 'open' };
    mock.board.board.sessions = [session];
    await host(() => useQueueDispatch()).flush();
    expect(command.mock.calls.map(([c]) => c.input)).toEqual([
      { session_id: 'session-a', input: 'later', attachments: ['file-a'] },
    ]);
  });
});

describe('composer session references', () => {
  const other = (n: number): WorkbenchSession => ({
    ...listed,
    id: `session-${n}`,
    title: `title of session-${n}`,
  });
  const others = [other(1), other(2)];
  const mount = (sessions = [listed, ...others]) =>
    host(() => SessionCompose({ session, listed, title: 'title of session-a', sessions }));
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const options = (h: HookHost<any>) =>
    nodes(find(h.value, (n) => n.type === Menu.SubmenuRoot)).filter((n) => n.type === Menu.Item);
  function refer(h: HookHost<any>, title: string) {
    find(options(h), (n) => text(n) === title).props.onClick();
    h.render();
  }
  const strip = (h: HookHost<any>) => named(h.value, 'AttachmentStrip').props;
  const refIds = (h: HookHost<any>) => strip(h).refs.map((s: WorkbenchSession) => s.id);
  function send(h: HookHost<any>, input: string, extra: object = {}) {
    box(h).props.onChange({ target: { value: input } });
    h.render();
    box(h).props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
      ...extra,
    });
  }

  it('offers the other open sessions under another session in the add menu', () => {
    const h = mount();
    const trigger = find(h.value, (n) => n.type === Menu.SubmenuTrigger);
    expect(text(trigger)).toContain(zh('sessions.newWorkspace.referAnother'));
    expect(options(h).map(text)).toEqual(['title of session-1', 'title of session-2']);
    expect(options(h).map((n) => n.props.disabled)).toEqual([false, false]);
  });

  it('turns every session off once eight are referred, and a referred one at once', () => {
    const h = mount([listed, ...Array.from({ length: 9 }, (_, i) => other(i + 1))]);
    refer(h, 'title of session-1');
    expect(options(h).map((n) => n.props.disabled)).toEqual([true, ...Array(8).fill(false)]);
    for (let i = 2; i <= 8; i++) refer(h, `title of session-${i}`);
    expect(refIds(h)).toHaveLength(8);
    expect(options(h).every((n) => n.props.disabled)).toBe(true);
  });

  it('shows a referred session as a card in the strip and removes it with its cross', () => {
    const h = mount();
    refer(h, 'title of session-2');
    expect(refIds(h)).toEqual(['session-2']);
    const tree = AttachmentStrip(strip(h));
    const card = find(tree, (n) => n.props.role === 'group');
    expect(card.props['aria-label']).toBe('title of session-2');
    expect(card.props.className).toBe('cr-card cr-ref');
    find(
      card,
      (n) =>
        n.props['aria-label'] ===
        t(
          { id: 'sessions.newWorkspace.removeRef', defaultMessage: '' },
          { title: 'title of session-2' },
        ),
    ).props.onClick();
    h.render();
    expect(refIds(h)).toEqual([]);
  });

  it('keeps the referred sessions in the draft when the composer shows again', () => {
    const h = mount();
    refer(h, 'title of session-1');
    expect(refIds(mount())).toEqual(['session-1']);
  });

  it('sends the referred sessions with the message and then clears them', async () => {
    session = { ...running, state: 'open' };
    const h = mount();
    refer(h, 'title of session-1');
    refer(h, 'title of session-2');
    send(h, 'compare these');
    await h.flush();
    expect(command.mock.calls.map(([c]) => c.input)).toEqual([
      {
        session_id: 'session-a',
        input: 'compare these',
        refs: [
          { kind: 'session', id: 'session-1' },
          { kind: 'session', id: 'session-2' },
        ],
      },
    ]);
    h.render();
    expect(refIds(h)).toEqual([]);
  });

  it('leaves a session referred while the message waited for its files to the next message', async () => {
    session = { ...running, state: 'open' };
    const dialog = deferred<unknown>();
    chooseFiles.mockReturnValueOnce(dialog.promise);
    const h = mount();
    find(
      h.value,
      (n) => text(n) === zh('sessions.composer.addFile') && n.props.onClick,
    ).props.onClick();
    send(h, 'first');
    h.render();
    refer(h, 'title of session-1');
    dialog.resolve({ ok: true, value: [meta('file-a')] });
    await h.flush();
    expect(command.mock.calls.map(([c]) => c.input)).toEqual([
      { session_id: 'session-a', input: 'first', attachments: ['file-a'] },
    ]);
    h.render();
    expect(refIds(h)).toEqual(['session-1']);
  });

  it('steers the running turn with the referred sessions', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    const h = mount();
    refer(h, 'title of session-1');
    send(h, 'look there', { metaKey: true });
    await h.flush();
    expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
      [
        'session.steer',
        {
          session_id: 'session-a',
          input: 'look there',
          refs: [{ kind: 'session', id: 'session-1' }],
        },
      ],
    ]);
  });

  it('queues the referred sessions with the message and sends them later', async () => {
    const h = mount();
    refer(h, 'title of session-2');
    send(h, 'later');
    h.render();
    expect(useQueued.getState().queued['session-a']).toEqual([
      { text: 'later', attachments: [], skills: [], refs: [other(2)] },
    ]);
    expect(refIds(h)).toEqual([]);
    session = { ...running, state: 'open' };
    mock.board.board.sessions = [session];
    await host(() => useQueueDispatch()).flush();
    expect(command.mock.calls.map(([c]) => c.input)).toEqual([
      { session_id: 'session-a', input: 'later', refs: [{ kind: 'session', id: 'session-2' }] },
    ]);
  });
});

describe('long pasted text', () => {
  const mount = (shown: WorkbenchSession = listed) =>
    host(() => SessionCompose({ session, listed: shown, title: 'title of session-a' }));
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const strip = (h: HookHost<any>) => named(h.value, 'AttachmentStrip').props;
  async function paste(h: HookHost<any>, pasted: string) {
    const prevent = vi.fn();
    box(h).props.onPaste({
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? pasted : ''),
      },
      preventDefault: prevent,
    });
    await h.flush();
    h.render();
    return prevent;
  }
  const lines = (count: number, each = 'line') =>
    Array.from({ length: count }, () => each).join('\n');

  it('uploads text of more than 4000 characters as a file and leaves the box as it was', async () => {
    const h = mount();
    box(h).props.onChange({ target: { value: 'before' } });
    h.render();
    const prevent = await paste(h, 'x'.repeat(4001));
    expect(prevent).toHaveBeenCalled();
    expect(attachFile).toHaveBeenCalledWith(
      'project-a',
      'pasted-text.txt',
      'text/plain',
      new TextEncoder().encode('x'.repeat(4001)),
    );
    expect(box(h).props.value).toBe('before');
    expect(strip(h).items).toMatchObject([{ name: 'pasted-text.txt', lines: 1 }]);
  });

  it('uploads text of more than 80 lines as a file', async () => {
    const h = mount();
    expect(await paste(h, lines(81))).toHaveBeenCalled();
    expect(strip(h).items).toMatchObject([{ name: 'pasted-text.txt', lines: 81 }]);
  });

  it('lets text of 4000 characters on 80 lines reach the box', async () => {
    const h = mount();
    const pasted = `${lines(80, 'y'.repeat(49))}y`;
    expect(pasted).toHaveLength(4000);
    expect(await paste(h, pasted)).not.toHaveBeenCalled();
    expect(attachFile).not.toHaveBeenCalled();
  });

  it('lets long text reach the box where the session takes no attachments', async () => {
    const h = mount({ ...listed, state: 'discarded' });
    expect(await paste(h, 'x'.repeat(5000))).not.toHaveBeenCalled();
    expect(attachFile).not.toHaveBeenCalled();
  });

  it('numbers a pasted text after the one the message already has', async () => {
    const h = mount();
    await paste(h, lines(90));
    await paste(h, lines(100));
    expect(attachFile.mock.calls.map(([, name]) => name)).toEqual([
      'pasted-text.txt',
      'pasted-text-2.txt',
    ]);
  });

  it('names the tile of pasted text by its lines, not its file name', () => {
    const tree = AttachmentStrip({
      items: [{ id: 'file-a', name: 'pasted-text.txt', mime: 'text/plain', lines: 81 }],
      pending: [],
      onRemove() {},
    });
    const tile = nodes(tree)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'AttachmentTile')
      .map((n) => (n.type as (props: unknown) => any)(n.props))[0];
    expect(tile.props['aria-label']).toBe(
      t({ id: 'sessions.composer.pastedTextName', defaultMessage: '' }, { count: 81 }),
    );
    expect(text(tile)).toContain(zh('sessions.composer.pastedText'));
    expect(text(tile)).not.toContain('pasted-text');
    expect(text(find(tile, (n) => n.props.className === 'cp-fln'))).toBe('81 行');
  });
});

describe('new session input with attachments', () => {
  const base = {
    projectId: 'project',
    runtime: 'claude',
    permissionMode: 'ask',
    input: 'go',
  } as const;

  it('carries the attachment ids when there are some', () => {
    expect(newSessionInput({ ...base, attachments: ['file-a'] })).toEqual({
      project_id: 'project',
      runtime: 'claude',
      permission_mode: 'ask',
      input: 'go',
      attachments: ['file-a'],
    });
  });

  it('leaves out the attachments when there are none', () => {
    expect(newSessionInput({ ...base, attachments: [] })).not.toHaveProperty('attachments');
    expect(newSessionInput(base)).not.toHaveProperty('attachments');
  });
});
