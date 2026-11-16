import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { AttachmentMeta } from '@pantheon/protocol';
import { zh, zhf } from './i18n-setup.js';
import { deferred, find, type HookHost, mount, nodes, unmountAll } from './web-hook-host.js';
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
import { draftKey, useDrafts, whenUploaded, type DraftAttachment } from '@/data/drafts';
import { failureText } from '@/data/needs-you';
import { useAttachments } from '@/screens/sessions/parts';
import { NewSession } from '@/screens/sessions/SessionsScreen';

const meta = (id: string): AttachmentMeta => ({
  id,
  name: `name of ${id}`,
  mime: 'text/plain',
  size: 3,
});
const PROJECTS = ['project-a', 'project-b', 'project-c', 'project-d', 'project-e', 'project-f'];

let command: ReturnType<typeof vi.fn>;
let chooseFiles: ReturnType<typeof vi.fn>;
let snapshotWindow: ReturnType<typeof vi.fn>;
let attachFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    board: { cursor: 1, projects: PROJECTS.map((id) => ({ id, name: id })) },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  chooseFiles = vi.fn(async () => ({ ok: true, value: [] }));
  snapshotWindow = vi.fn(async () => ({ ok: true, value: meta('snapshot') }));
  attachFile = vi.fn(async (_project: string, name: string) => ({
    ok: true,
    value: { ...meta(`att-${name}`), name },
  }));
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({
        ok: false,
        error: { code: 'unknown_route', message: method },
      })),
      command,
      chooseFiles,
      snapshotWindow,
      attachFile,
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const ids = (items: readonly DraftAttachment[] | undefined) => (items ?? []).map((a) => a.id);

describe('files still on their way into the draft', () => {
  it('holds a send while the file dialog is open, and the chosen files go with it', async () => {
    const key = draftKey('project-a', 'session-a');
    const chosen = deferred<unknown>();
    chooseFiles.mockReturnValueOnce(chosen.promise);
    const h = mount(() => useAttachments('project-a', key));
    const choosing = h.value.choose();
    let uploaded = false;
    void whenUploaded(key).then(() => (uploaded = true));
    await h.flush();
    expect(uploaded).toBe(false);
    chosen.resolve({ ok: true, value: [meta('file-a')] });
    await choosing;
    await h.flush();
    expect(uploaded).toBe(true);
    expect(ids(useDrafts.getState().drafts[key]?.attachments)).toEqual(['file-a']);
  });

  it('keeps a place for a window snapshot, so the files never go past ten', async () => {
    const key = draftKey('project-a', 'session-b');
    chooseFiles.mockResolvedValueOnce({
      ok: true,
      value: Array.from({ length: 9 }, (_, i) => meta(`file-${i}`)),
    });
    const shot = deferred<unknown>();
    snapshotWindow.mockReturnValueOnce(shot.promise);
    const h = mount(() => useAttachments('project-a', key));
    await h.value.choose();
    await h.flush();
    const snapping = h.value.snapshot('window:1');
    await h.value.addFiles([new File(['a'], 'a.txt')]);
    shot.resolve({ ok: true, value: meta('snapshot') });
    await snapping;
    h.render();
    expect(attachFile).not.toHaveBeenCalled();
    expect(h.value.items).toHaveLength(10);
    expect(h.value.error).toEqual(expect.any(String));
  });

  it('refuses a file over 20 MiB without reading it', async () => {
    const key = draftKey('project-a', 'session-c');
    const file = new File(['x'], 'huge.bin');
    Object.defineProperty(file, 'size', { value: 3 * 1024 ** 3 });
    const read = vi.spyOn(file, 'arrayBuffer');
    const h = mount(() => useAttachments('project-a', key));
    await h.value.addFiles([file]);
    h.render();
    expect(read).not.toHaveBeenCalled();
    expect(attachFile).not.toHaveBeenCalled();
    expect(h.value.pending).toMatchObject([
      {
        state: 'failed',
        error: failureText({
          code: 'invalid_input',
          message: 'bytes must be a Uint8Array of at most 20 MiB',
        }),
      },
    ]);
  });
});

describe('a new session sent while its draft changes', () => {
  const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
  async function open(projectId: string) {
    const onClose = vi.fn();
    const h = mount(() =>
      NewSession({
        projectId,
        defaults: undefined,
        focus: 0,
        onCreated: () => {},
        recent: [],
        onOpen: () => {},
        onClose,
      }),
    );
    await h.flush();
    const files = mount(() => useAttachments(projectId, draftKey(projectId, null)));
    return { h, files, onClose, key: draftKey(projectId, null) };
  }
  const region = (h: HookHost<any>) => find(h.value, labelled(zh('sessions.composer.newSession')));
  function type(h: HookHost<any>, input: string) {
    find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.onChange({
      target: { value: input },
    });
    h.render();
  }
  const press = (h: HookHost<any>, key: string, meta: boolean, isComposing = false) =>
    region(h).props.onKeyDown({
      key,
      code: key,
      metaKey: meta,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      nativeEvent: { isComposing },
      isDefaultPrevented: () => false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
  const creates = () =>
    command.mock.calls.filter(([c]: any[]) => c.type === 'session.create').map(([c]: any[]) => c);

  it('keeps the message and says why when a file it waits for fails to upload', async () => {
    const { h, files, key } = await open('project-a');
    const upload = deferred<unknown>();
    attachFile.mockReturnValueOnce(upload.promise);
    type(h, 'see the file');
    const adding = files.value.addFiles([new File(['a'], 'a.txt')]);
    press(h, 'Enter', true);
    await h.flush();
    upload.resolve({ ok: false, error: { code: 'attachment_too_large', message: 'too large' } });
    await adding;
    await h.flush();
    expect(creates()).toEqual([]);
    expect(useDrafts.getState().drafts[key]?.text).toBe('see the file');
    const alert = nodes(h.value).find((n) => n.props.role === 'alert');
    expect(alert?.props.children).toBe(
      zhf('sessions.composer.attachmentFailed', { name: 'a.txt' }),
    );
  });

  it('sends the files of the message and leaves a file added after it for the next', async () => {
    const { h, files, key } = await open('project-b');
    const first = deferred<unknown>();
    attachFile.mockReturnValueOnce(first.promise);
    type(h, 'message A');
    const addingA = files.value.addFiles([new File(['a'], 'a.txt')]);
    press(h, 'Enter', true);
    await h.flush();
    type(h, 'message B');
    await files.value.addFiles([new File(['b'], 'b.txt')]);
    first.resolve({ ok: true, value: meta('att-a') });
    await addingA;
    await h.flush();
    expect(creates().map((c: any) => c.input.attachments)).toEqual([['att-a']]);
    const left = useDrafts.getState().drafts[key];
    expect(left?.text).toBe('message B');
    expect(ids(left?.attachments)).toEqual(['att-b.txt']);
  });

  it('keeps a skill the text typed while it is created still names', async () => {
    const { h, key } = await open('project-c');
    const created = deferred<unknown>();
    command.mockReturnValueOnce(created.promise);
    useDrafts.getState().update(key, () => ({
      text: '$review first',
      skills: [{ name: 'review', path: '/skills/review' }],
    }));
    h.render();
    press(h, 'Enter', true);
    await h.flush();
    type(h, '$review second');
    created.resolve({ ok: true, value: { id: 'session-new' } });
    await h.flush();
    const left = useDrafts.getState().drafts[key];
    expect(left?.text).toBe('$review second');
    expect(left?.skills).toEqual([{ name: 'review', path: '/skills/review' }]);
  });

  it('keeps the mode and fast mode picked while it is created for the next session', async () => {
    const { h, key } = await open('project-d');
    const created = deferred<unknown>();
    command.mockReturnValueOnce(created.promise);
    type(h, 'go');
    press(h, 'Enter', true);
    await h.flush();
    useDrafts.getState().update(key, () => ({ mode: 'plan', fast: true }));
    created.resolve({ ok: true, value: { id: 'session-new' } });
    await h.flush();
    expect(useDrafts.getState().drafts[key]).toMatchObject({ mode: 'plan', fast: true });
  });

  it('leaves the keys of an input method composing text to it', async () => {
    const { h, onClose } = await open('project-e');
    type(h, 'にほんご');
    press(h, 'Escape', false, true);
    press(h, 'Enter', true, true);
    await h.flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(creates()).toEqual([]);
  });
});
