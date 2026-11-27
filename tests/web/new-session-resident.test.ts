import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { zh, zhf } from './i18n-setup.js';
import { find, HookHost, mount as mountHook, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  resident: { read: null, error: null } as {
    read: unknown;
    error: string | null;
    stale?: boolean;
  },
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/project-resident', () => ({
  useProjectResident: (projectId: string | null) => ({
    loading: false,
    unavailable: false,
    stale: false,
    reload() {},
    ...(projectId ? mock.resident : { read: null, error: null }),
  }),
}));
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { RoutineEditor } from '@/screens/project/RoutinesCard';
import { draftKey, useDrafts } from '@/data/drafts';

const KEY = draftKey('project-a', null);

const lead = {
  id: 'lead',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'Release lead',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-lead',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  conductor: true,
} as const;

const residentOf = (session_id: string | null) => ({
  read: {
    instructions: null,
    session_id,
    since: null,
    turns: { pantheon: 0, user: 0 },
    budget: null,
    wakes: [],
  },
  error: null,
});

const triage = {
  name: 'Triage',
  prompt: 'Look at new issues',
  every_minutes: 30,
  enabled: true,
  precheck: { argv: ['gh', 'issue', 'list', '--search', 'updated:>={since}'] },
};
const daily = { name: 'Standup', prompt: 'Sum up yesterday', at: '09:00', enabled: true };

let command: ReturnType<typeof vi.fn>;
async function mount() {
  const h = mountHook(() =>
    NewSession({
      projectId: 'project-a',
      defaults: undefined,
      focus: 0,
      onCreated: () => {},
      recent: [lead],
      onOpen: () => {},
    }),
  );
  await h.flush();
  return h;
}
const labelled = (label: string) => (n: ReactElement<any>) => n.props['aria-label'] === label;
const part = (h: HookHost<any>) => nodes(h.value).find(labelled(zh('sessions.composer.resident')));
const mainAgent = (h: HookHost<any>) => {
  find(h.value, labelled(zh('sessions.conductor.name'))).props.onClick();
  h.render();
};
const residentSwitch = (h: HookHost<any>) =>
  find(
    h.value,
    (n) => n.type === 'label' && text(n) === zh('sessions.composer.residentOn'),
  ).props.children.find((n: any) => n?.props?.type === 'checkbox');
const setSwitch = (h: HookHost<any>, checked: boolean) => {
  residentSwitch(h).props.onChange({ target: { checked } });
  h.render();
};
const instructions = (h: HookHost<any>) =>
  nodes(h.value).find(labelled(zh('sessions.composer.residentInstructions')));
const write = (h: HookHost<any>, value: string) => {
  instructions(h)!.props.onChange({ target: { value } });
  h.render();
};
const button = (tree: unknown, name: string) =>
  nodes(tree as ReactElement).find((n) => n.type === 'button' && text(n) === name);
const editor = (h: HookHost<any>) => nodes(h.value).find((n) => n.type === RoutineEditor);
const rows = (h: HookHost<any>) => nodes(h.value).filter((n) => n.type === 'li');
async function addRoutine(h: HookHost<any>, routine: object) {
  button(h.value, zh('sessions.composer.residentAddRoutine'))!.props.onClick();
  h.render();
  const form = editor(h)!;
  expect(form.props.routine).toBeNull();
  expect(await form.props.save(routine)).toEqual({ ok: true });
  form.props.onSaved();
  h.render();
}
async function start(h: HookHost<any>, message = 'watch the repo') {
  find(h.value, labelled(zh('sessions.composer.firstMessage'))).props.onChange({
    target: { value: message },
  });
  h.render();
  find(h.value, labelled(zh('sessions.composer.newSession'))).props.onKeyDown({
    key: 'Enter',
    code: 'Enter',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    isDefaultPrevented: () => false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  await h.flush();
}
const created = () =>
  command.mock.calls.map(([c]) => c as any).find((c) => c.type === 'session.create')?.input;

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  mock.board = {
    board: { cursor: 1, projects: [{ id: 'project-a', name: 'Pantheon' }] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.resident = residentOf(null);
  command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({
        ok: false,
        error: { code: 'unknown_route', message: method },
      })),
      command,
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('shows the resident part only while the main agent toggle is on', async () => {
  const h = await mount();
  expect(part(h)).toBeUndefined();
  mainAgent(h);
  expect(part(h)?.props.role).toBe('group');
  mainAgent(h);
  expect(part(h)).toBeUndefined();
});

it('makes the main agent resident by default while the project has none', async () => {
  const h = await mount();
  mainAgent(h);
  expect(residentSwitch(h).props.checked).toBe(true);
  expect(instructions(h)).toBeDefined();
  expect(text(part(h))).not.toContain(zhf('sessions.composer.residentReplaces', { title: '' }));
});

it('leaves an existing resident by default, and names it once the switch is on', async () => {
  mock.resident = residentOf('lead');
  const h = await mount();
  mainAgent(h);
  const replaces = zhf('sessions.composer.residentReplaces', { title: 'Release lead' });
  expect(residentSwitch(h).props.checked).toBe(false);
  expect(instructions(h)).toBeUndefined();
  expect(text(part(h))).not.toContain(replaces);
  setSwitch(h, true);
  expect(text(part(h))).toContain(replaces);
});

it('waits for a fresh resident read before it turns the switch on or starts', async () => {
  mock.resident = { ...residentOf(null), stale: true };
  const h = await mount();
  mainAgent(h);
  expect(residentSwitch(h).props.disabled).toBe(true);
  expect(residentSwitch(h).props.checked).toBe(false);
  await start(h);
  expect(command).not.toHaveBeenCalled();
});

it('takes an old read beside a failed refresh as unknown and leaves the switch off', async () => {
  mock.resident = { ...residentOf(null), error: 'offline' };
  const h = await mount();
  mainAgent(h);
  expect(residentSwitch(h).props.checked).toBe(false);
  expect(residentSwitch(h).props.disabled).toBe(false);
});

it('keeps the resident part of a draft a start did not send', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, 'Keep main green');
  await addRoutine(h, triage);
  setSwitch(h, false);
  await start(h);
  expect(created()).not.toHaveProperty('resident');
  expect(useDrafts.getState().drafts[KEY]?.resident).toMatchObject({
    instructions: 'Keep main green',
    routines: [triage],
  });
});

it('refuses to save an edited routine that another window moved or removed', async () => {
  const h = await mount();
  mainAgent(h);
  await addRoutine(h, triage);
  await addRoutine(h, daily);
  button(rows(h)[1], zh('project.routines.edit'))!.props.onClick();
  h.render();
  const form = editor(h)!;
  const draft = useDrafts.getState().drafts[KEY]!;
  useDrafts.setState({
    drafts: { [KEY]: { ...draft, resident: { ...draft.resident!, routines: [daily] } } },
  });
  expect((await form.props.save({ ...daily, name: 'Morning' })).ok).toBe(false);
  expect(useDrafts.getState().drafts[KEY]?.resident?.routines).toEqual([daily]);
});

it('sends the instructions as written and each routine of the draft', async () => {
  const h = await mount();
  mainAgent(h);
  const written = '  Keep main green.\nAsk before you push.\n';
  write(h, written);
  await addRoutine(h, triage);
  await addRoutine(h, daily);
  await start(h);
  expect(created()).toMatchObject({ purpose: 'conductor' });
  expect(created().resident).toEqual({ instructions: written, routines: [triage, daily] });
});

it('sends no instructions while they are blank', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, ' \n\t');
  await addRoutine(h, triage);
  await start(h);
  expect(created().resident).toEqual({ routines: [triage] });
});

it('sends no routines while the draft has none', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, 'Keep main green');
  await start(h);
  expect(created().resident).toEqual({ instructions: 'Keep main green' });
});

it('sends no resident once the switch is off', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, 'Keep main green');
  setSwitch(h, false);
  await start(h);
  expect(created()).toMatchObject({ purpose: 'conductor' });
  expect(created()).not.toHaveProperty('resident');
});

it('sends no resident for a session that is not a main agent', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, 'Keep main green');
  mainAgent(h);
  await start(h);
  expect(created()).not.toHaveProperty('purpose');
  expect(created()).not.toHaveProperty('resident');
});

it('cannot start with instructions over 4000 characters, and marks them', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, 'x'.repeat(4000));
  expect(instructions(h)!.props['aria-invalid']).toBeUndefined();
  write(h, 'x'.repeat(4001));
  expect(instructions(h)!.props['aria-invalid']).toBe(true);
  const send = find(h.value, (n) => typeof n.type === 'function' && n.type.name === 'SendButton');
  expect(send.props.state.enabled).toBe(false);
  await start(h);
  expect(command).not.toHaveBeenCalled();
});

it('keeps the resident part with the draft when the composer opens again', async () => {
  const first = await mount();
  mainAgent(first);
  write(first, 'Keep main green');
  await addRoutine(first, triage);
  unmountAll();

  const h = await mount();
  expect(instructions(h)!.props.value).toBe('Keep main green');
  expect(rows(h).map((row) => row.props['aria-label'])).toEqual(['Triage']);
});

it('clears the resident part once the session starts', async () => {
  const h = await mount();
  mainAgent(h);
  write(h, 'Keep main green');
  await addRoutine(h, triage);
  await start(h);
  expect(useDrafts.getState().drafts[KEY]?.resident).toBeUndefined();
});

it('keeps the resident part and shows the failure when the start fails', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'invalid_input', message: 'routine refused' },
  });
  const h = await mount();
  mainAgent(h);
  write(h, 'Keep main green');
  await addRoutine(h, triage);
  await start(h);
  expect(text(nodes(h.value).find((n) => n.props.role === 'alert'))).toContain('routine refused');
  expect(useDrafts.getState().drafts[KEY]?.resident).toMatchObject({
    instructions: 'Keep main green',
    routines: [triage],
  });
});

it('adds, edits and deletes routines in the draft only', async () => {
  const h = await mount();
  mainAgent(h);
  await addRoutine(h, triage);
  await addRoutine(h, daily);
  expect(rows(h).map((row) => text(row))).toEqual([
    expect.stringContaining(zhf('project.routines.every', { count: 30 })),
    expect.stringContaining(zhf('project.routines.daily', { time: '09:00' })),
  ]);
  expect(rows(h).map((row) => row.props['aria-label'])).toEqual(['Triage', 'Standup']);

  button(rows(h)[1], zh('project.routines.edit'))!.props.onClick();
  h.render();
  const form = editor(h)!;
  expect(form.props.routine).toEqual(daily);
  await form.props.save({ ...daily, name: 'Morning' });
  form.props.onSaved();
  h.render();
  expect(editor(h)).toBeUndefined();
  expect(useDrafts.getState().drafts[KEY]?.resident?.routines).toEqual([
    triage,
    { ...daily, name: 'Morning' },
  ]);

  button(rows(h)[0], zh('project.routines.remove'))!.props.onClick();
  h.render();
  expect(useDrafts.getState().drafts[KEY]?.resident?.routines).toEqual([
    { ...daily, name: 'Morning' },
  ]);
  expect(command).not.toHaveBeenCalled();
});
