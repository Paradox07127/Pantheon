import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Session } from '@pantheon/domain';
import type { RuntimeModel, WorkbenchSession } from '@pantheon/protocol';
import { find, HookHost, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
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
import { runShortcut } from '@/lib/shortcuts';
import {
  ModelMenu,
  SendButton,
  useQueued,
  usePrefill,
  type QueuedMessage,
} from '@/screens/sessions/parts';
import { QueueDock } from '@/screens/sessions/QueueDock';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';

const model = (id: string): RuntimeModel => ({
  id,
  label: `label of ${id}`,
  permission_modes: ['plan', 'ask', 'auto_edit'],
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  default: false,
});

let project = 0;
let session: Session;
let listed: WorkbenchSession;
let command: ReturnType<typeof vi.fn>;
const compose = () => mount(() => SessionCompose({ session, listed, title: 'Composer work' }));
const sent = () => command.mock.calls.map(([c]: any) => [c.type, c.input]);

beforeEach(() => {
  // Models are read once per project; each test reads its own.
  const id = `project-row-${++project}`;
  session = {
    id: 'session-row',
    revision: 4,
    project_id: id,
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
  };
  listed = {
    id: 'session-row',
    created_at: '2026-01-01T00:00:00.000Z',
    title: 'Composer work',
    runtime: 'claude',
    model: 'model-a',
    effort: 'medium',
    permission_mode: 'ask',
    workspace_id: 'workspace-row',
    workspace_kind: 'linked_worktree',
    state: 'idle',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    changes: null,
    merge: null,
  };
  useQueued.setState({ queued: {}, failures: {} });
  usePrefill.setState({ prefill: {} });
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    board: { cursor: 1, projects: [] },
    events: [],
    resync: 0,
    status: { state: 'live' },
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', {
    pantheon: {
      command,
      query: vi.fn(async (method: string) =>
        method === 'runtime.models'
          ? { ok: true, value: [model('model-a'), model('model-b')] }
          : { ok: false, error: { code: 'unknown_route', message: method } },
      ),
      chooseFiles: vi.fn(async () => ({ ok: true, value: [] })),
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

describe('composer row', () => {
  it('puts the add menu with its window snapshot picker, the model button, the context ring and the send key in that order', () => {
    const h = compose();
    const row = find(h.value, (n) => n.props.className === 'cp-row');
    const names = [row.props.children]
      .flat()
      .filter(Boolean)
      .map((child: ReactElement<any>) =>
        nodes(child).some((n) => n.props['aria-label'] === zh('sessions.composer.addMenu'))
          ? 'add'
          : typeof child.type === 'function'
            ? child.type.name
            : null,
      )
      .filter(Boolean);
    expect(names).toEqual(['add', 'WindowSnapshots', 'ModelMenu', 'ContextRing', 'SendButton']);
  });

  it('draws the send key as an icon button named Send, disabled while the box is empty', () => {
    const h = compose();
    const send = named(h.value, 'SendButton');
    expect(send.props.label).toBe(zh('sessions.composer.send'));
    expect(send.props.icon).toBeTruthy();
    const button = find(SendButton(send.props), (n) => n.type === 'button');
    expect(button.props.className).toBe('cp-send');
    expect(button.props['aria-label']).toBe(zh('sessions.composer.send'));
    expect(button.props['aria-disabled']).toBe(true);
    expect(text(button)).toBe('');
  });

  it('offers only the add actions the composer has: a file, an app window snapshot, a file reference and a command', async () => {
    const key = draftKey(session.project_id, session.id);
    useDrafts.getState().update(key, () => ({ text: 'look at' }));
    const h = compose();
    const items = () =>
      nodes(find(h.value, (n) => n.props.className === 'pop cp-am')).filter(
        (n) => typeof n.props.onClick === 'function',
      );
    const label = (item: ReactElement<any>) =>
      text(find(item, (n) => n.props.className === 'cp-mil'));
    expect(items().map(label)).toEqual([
      zh('sessions.composer.addFile'),
      zh('sessions.composer.addWindowSnapshot'),
      zh('sessions.composer.mentionFile'),
      zh('sessions.composer.command'),
    ]);
    items()[2]!.props.onClick();
    expect(useDrafts.getState().drafts[key]?.text).toBe('look at @');
    useDrafts.getState().update(key, () => ({ text: '' }));
    h.render();
    items()[3]!.props.onClick();
    expect(useDrafts.getState().drafts[key]?.text).toBe('/');
  });
});

describe('composer box', () => {
  const box = (h: HookHost<any>) => find(h.value, (n) => n.props.className === 'cp-box');
  const textarea = (h: HookHost<any>) => find(box(h), (n) => n.type === 'textarea');
  const dragged = (types: string[], files: File[] = []) => ({
    preventDefault: vi.fn(),
    dataTransfer: { types, files },
  });
  const attached = () =>
    useDrafts.getState().drafts[draftKey(session.project_id, session.id)]?.attachments ?? [];
  beforeEach(() => {
    (window as any).pantheon.attachFile = vi.fn(async (_project: string, name: string) => ({
      ok: true,
      value: { id: `attachment-${name}`, name, mime: 'text/plain', size: 4 },
    }));
  });

  it('checks the spelling of the message', () => {
    expect(textarea(compose()).props.spellCheck).toBe(true);
  });

  it('attaches a dropped file the same way as a pasted one, and marks the box while one is over it', async () => {
    const h = compose();
    const over = dragged(['Files']);
    box(h).props.onDragOver(over);
    h.render();
    expect(over.preventDefault).toHaveBeenCalled();
    expect(box(h).props['data-drop']).toBe(true);
    box(h).props.onDrop(dragged(['Files'], [new File(['drop'], 'dropped.txt')]));
    await h.flush();
    expect(box(h).props['data-drop']).toBeUndefined();
    textarea(h).props.onPaste({
      preventDefault() {},
      clipboardData: { files: [new File(['past'], 'pasted.txt')], getData: () => '' },
    });
    await h.flush();
    expect((window as any).pantheon.attachFile.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      'dropped.txt',
      'pasted.txt',
    ]);
    expect(attached().map((a) => a.name)).toEqual(['dropped.txt', 'pasted.txt']);
  });

  it('leaves a drag of anything but files, or files over a box that takes none, to the page', () => {
    const h = compose();
    const words = dragged(['text/plain']);
    box(h).props.onDragOver(words);
    expect(words.preventDefault).not.toHaveBeenCalled();
    listed = { ...listed, workspace_id: null };
    const closed = compose();
    const files = dragged(['Files']);
    box(closed).props.onDragOver(files);
    expect(files.preventDefault).not.toHaveBeenCalled();
  });
});

describe('model button', () => {
  const menu = (props: Partial<Parameters<typeof ModelMenu>[0]> = {}) =>
    mount(() =>
      ModelMenu({
        runtimes: ['claude'],
        models: { claude: { state: 'ready', models: [model('model-a')] } },
        value: { runtime: 'claude', backend: null, model: 'model-a', effort: 'high' },
        onChange: () => {},
        mode: 'plan',
        onMode: () => {},
        ...props,
      }),
    );

  it('names the model, the effort and the permission mode', () => {
    const h = menu();
    const name = find(h.value, (n) => n.props.className === 'cp-mdl').props['aria-label'];
    expect(name).toContain('label of model-a');
    expect(name).toContain(zh('sessions.model.effort.high'));
    expect(name).toContain(zh('sessions.model.mode.plan'));
  });

  it("offers the model's permission modes beside the efforts and picks one", () => {
    const onMode = vi.fn();
    const h = menu({ onMode });
    const modes = find(
      h.value,
      (n) => n.props['aria-label'] === zh('sessions.composer.permissionMode'),
    );
    const items = nodes(modes).filter((n) => typeof n.props.onClick === 'function');
    expect(items.map((n) => [n.props.value, text(n)])).toEqual([
      ['plan', zh('sessions.model.mode.plan')],
      ['ask', zh('sessions.model.mode.ask')],
      ['auto_edit', zh('sessions.model.mode.autoEdit')],
    ]);
    items[2]!.props.onClick();
    expect(onMode).toHaveBeenCalledExactlyOnceWith('auto_edit');
    const codex = menu({
      runtimes: ['codex'],
      models: {
        codex: { state: 'ready', models: [{ ...model('model-a'), permission_modes: [] }] },
      },
      value: { runtime: 'codex', backend: null, model: 'model-a', effort: 'high' },
      mode: 'auto_edit',
    });
    expect(
      nodes(
        find(codex.value, (n) => n.props['aria-label'] === zh('sessions.composer.permissionMode')),
      )
        .filter((n) => typeof n.props.onClick === 'function')
        .map((n) => n.props.value),
    ).toEqual(['auto_edit', 'plan']);
  });

  it("moves a session without a model to the next mode of the runtime's default model from the keys", async () => {
    session = { ...session, runtime: 'codex' };
    listed = { ...listed, runtime: 'codex', model: null, permission_mode: 'auto_edit' };
    vi.mocked(window.pantheon!.query).mockImplementation(async (method: string) =>
      method === 'runtime.models'
        ? {
            ok: true,
            value: [
              model('gpt-other'),
              {
                ...model('gpt-default'),
                permission_modes: ['plan', 'auto_edit', 'full_access'],
                default: true,
              },
            ],
          }
        : { ok: false, error: { code: 'unknown_route', message: method } },
    );
    const h = compose();
    await h.flush();
    runShortcut('permission-mode');
    await h.flush();
    expect(sent()).toEqual([
      ['session.setPermissionMode', { session_id: 'session-row', permission_mode: 'full_access' }],
    ]);
  });

  it('sends the same commands as before when the effort or the permission mode changes', async () => {
    const h = compose();
    await h.flush();
    const shown = named(h.value, 'ModelMenu').props;
    expect(shown.mode).toBe('ask');
    shown.onChange({ ...shown.value, effort: 'high' });
    await h.flush();
    named(h.value, 'ModelMenu').props.onMode('plan');
    await h.flush();
    expect(sent()).toEqual([
      ['session.setModel', { session_id: 'session-row', model: 'model-a', effort: 'high' }],
      ['session.setPermissionMode', { session_id: 'session-row', permission_mode: 'plan' }],
    ]);
  });
});

describe('queued messages on the composer', () => {
  const one: QueuedMessage = { text: 'queued one', attachments: [], skills: [] };
  const two: QueuedMessage = { text: 'queued two', attachments: [], skills: [] };
  beforeEach(() => {
    session = { ...session, state: 'running' };
    listed = { ...listed, state: 'running' };
    useQueued.setState({ queued: { 'session-row': [one, two] }, failures: {} });
  });

  it('sits right above the box in the same stack', () => {
    const h = compose();
    const stack = find(h.value, (n) => n.props.className === 'cp-stack');
    const [dock, box] = [stack.props.children].flat();
    expect(dock.type).toBe(QueueDock);
    expect(box.props.className).toBe('cp-box');
  });

  it('steers with a queued message now and takes another back without a command', async () => {
    const h = mount(() => QueueDock({ session }));
    const button = (label: string, at: number) =>
      nodes(h.value).filter((n) => n.type === 'button' && n.props['aria-label'] === label)[at]!;
    button(zh('sessions.composer.dropQueued'), 1).props.onClick();
    h.render();
    expect(command).not.toHaveBeenCalled();
    expect(useQueued.getState().queued['session-row']).toEqual([one]);
    button(zh('sessions.composer.steerNow'), 0).props.onClick();
    await h.flush();
    expect(sent()).toEqual([['session.steer', { session_id: 'session-row', input: 'queued one' }]]);
  });
});
