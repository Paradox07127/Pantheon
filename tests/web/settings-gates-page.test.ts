import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { type HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { t as format } from '@/i18n';
import { lastDuration, placeRow, rowsOf } from '@/screens/settings/gate';
import { FolderGate, GateGpu, GatePolicy } from '@/screens/settings/GatesPage';
import { useSettingsView } from '@/screens/settings/view';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Project = Parameters<typeof FolderGate>[0]['project'];

const ROOT = '/work/alpha';
const steps = [
  { name: 'typecheck', argv: ['pnpm', 'typecheck'] },
  { name: 'unit tests', argv: ['pnpm', 'test'], timeout_ms: 90000 },
  { name: 'lint', argv: ['pnpm', 'lint'] },
];
let project: Project;

const bridge = {
  answers: {} as Record<string, unknown>,
  replies: [] as BridgeResult<unknown>[],
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.replies.shift() ?? { ok: true, value: { revision: project.revision + 1 } };
  },
};

const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  pinned: [],
  ...patch,
});

const runs = [
  {
    results: [
      { name: 'typecheck', command: ['pnpm', 'typecheck'], duration_ms: 8400 },
      { name: 'unit tests', command: ['pnpm', 'test'], skipped: true },
    ],
  },
  {
    results: [
      { name: 'typecheck', command: ['pnpm', 'typecheck'], duration_ms: 12000 },
      { name: 'unit tests', command: ['pnpm', 'test', '--old'], duration_ms: 31000 },
    ],
  },
];

const gate = (id: string, values?: Record<string, string | number>) =>
  format({ id: `settings.gate.${id}`, defaultMessage: '' }, values);
const NAME = gate('name');
const LINE = gate('line');
const ON_FAIL = gate('onFail');
const RUNNER = gate('runner');
async function folder(named = false, git = false) {
  const h = mount(() => FolderGate({ project, root: ROOT, named, git, runs }));
  await h.flush();
  return h;
}
async function fixLimit() {
  const h = mount(() => GatePolicy({ project }));
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const step = (h: HookHost<any>, n: number) => labelled(tree(h), gate('step', { n }));
const field = (h: HookHost<any>, n: number, label: string) => () =>
  find(step(h, n), (e) => e.type === 'input' && e.props['aria-label'] === label);
const sent = () => bridge.commands.map((c) => (c.input.commands as { name: string }[]) ?? c.input);
async function type(h: HookHost<any>, input: () => ReactElement<any>, value: string) {
  input().props.onChange({ target: { value } });
  await h.flush();
  input().props.onBlur();
  await h.flush();
}
/** The board catches up with the revision the last save returned. */
async function catchUp(h: HookHost<any>) {
  const last = bridge.commands.at(-1)!;
  project = {
    ...project,
    revision: project.revision + 1,
    gates: { [ROOT]: last.input.commands as never },
  };
  h.render();
  await h.flush();
}

beforeEach(() => {
  project = {
    id: 'alpha',
    revision: 4,
    name: 'Alpha app',
    roots: [ROOT],
    gates: { [ROOT]: steps },
  };
  bridge.answers = { 'workflow.policy': policy() };
  bridge.replies = [];
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ open: false, page: 'general' });
});

describe('the gates page steps', () => {
  it('shows each step as one row of name over command, with no save button', async () => {
    const h = await folder();
    expect([1, 2, 3].map((n) => field(h, n, NAME)().props.value)).toEqual([
      'typecheck',
      'unit tests',
      'lint',
    ]);
    expect(field(h, 2, LINE)().props.value).toBe('pnpm test');
    expect(field(h, 2, gate('timeoutField'))().props.value).toBe('90');
    expect(
      nodes(tree(h)).filter((n) => n.type === 'button' && text(n) === zh('settings.common.save')),
    ).toEqual([]);
  });

  it('marks a git folder in the page language', async () => {
    const h = await folder(true, true);
    expect(
      nodes(tree(h))
        .filter((n) => n.props.className === 'chip')
        .map(text),
    ).toEqual([gate('gitFolder')]);
  });

  it('saves a step as soon as its field is left', async () => {
    const h = await folder();
    await type(h, field(h, 1, NAME), 'types');
    expect(bridge.commands).toHaveLength(1);
    expect(bridge.commands[0]).toMatchObject({
      type: 'project.gate.set',
      input: { project_id: 'alpha', root: ROOT },
      expected_revision: 4,
    });
    expect(sent()[0]).toEqual([{ ...steps[0], name: 'types' }, steps[1], steps[2]]);
    // Leaving a field that did not change sends nothing more.
    await catchUp(h);
    field(h, 2, NAME)().props.onBlur();
    await h.flush();
    expect(bridge.commands).toHaveLength(1);
  });

  it('shows a failed save beside the step that changed', async () => {
    bridge.replies.push({ ok: false, error: { code: 'conflict', message: 'stale revision' } });
    const h = await folder();
    await type(h, field(h, 2, LINE), 'pnpm test --run');
    const inStep = (n: number) =>
      nodes(step(h, n))
        .filter((e) => e.props.role === 'alert')
        .map(text)
        .join('');
    expect(inStep(2)).toContain('stale revision');
    expect(inStep(1)).toBe('');
  });

  it('keeps a step that is not valid as a draft and says why in its row', async () => {
    const h = await folder();
    find(tree(h), (n) => n.type === 'button' && text(n).includes(gate('addStep'))).props.onClick();
    await h.flush();
    expect(field(h, 4, NAME)().props.value).toBe('');
    expect(bridge.commands).toEqual([]);
    field(h, 4, NAME)().props.onBlur();
    await h.flush();
    expect(bridge.commands).toEqual([]);
    const alert = find(step(h, 4), (e) => e.props.role === 'alert');
    expect(text(alert)).toContain(gate('nameEmpty'));
  });

  it('moves a step with the arrow keys on its handle and saves the new order', async () => {
    const h = await folder();
    const grip = labelled(step(h, 1), gate('moveStep', { n: 1 }));
    expect(grip.props.draggable).toBe(true);
    grip.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
    await h.flush();
    expect(sent()[0]!.map((c) => c.name)).toEqual(['unit tests', 'typecheck', 'lint']);
    await catchUp(h);
    labelled(step(h, 1), gate('moveStep', { n: 1 })).props.onKeyDown({
      key: 'ArrowUp',
      preventDefault() {},
    });
    await h.flush();
    expect(bridge.commands).toHaveLength(1);
  });

  it('moves a step dragged onto another row and saves the new order', async () => {
    const h = await folder();
    labelled(step(h, 3), gate('moveStep', { n: 3 })).props.onDragStart({
      dataTransfer: { setData() {}, effectAllowed: '' },
    });
    await h.flush();
    const target = step(h, 1);
    const over = { preventDefault: vi.fn(), dataTransfer: { dropEffect: '' } };
    target.props.onDragOver(over);
    expect(over.preventDefault).toHaveBeenCalled();
    target.props.onDrop({ preventDefault() {} });
    await h.flush();
    expect(sent()[0]!.map((c) => c.name)).toEqual(['lint', 'typecheck', 'unit tests']);
  });

  it('deletes a step from its row and saves at once', async () => {
    const h = await folder();
    labelled(step(h, 2), gate('deleteStep', { n: 2 })).props.onClick();
    await h.flush();
    expect(sent()[0]!.map((c) => c.name)).toEqual(['typecheck', 'lint']);
  });

  it('shows how long a step took in the newest run that ran it, and nothing without one', async () => {
    const h = await folder();
    expect(text(step(h, 1))).toContain('8 秒');
    expect(text(step(h, 2))).not.toMatch(/\d 秒/);
    expect(text(step(h, 3))).not.toMatch(/\d 秒/);
  });

  it('turns a step off and lets another be skipped when it fails, saving each at once', async () => {
    const h = await folder();
    const on = () => labelled(step(h, 2), gate('enableStep', { n: 2 }));
    expect(on().props.checked).toBe(true);
    on().props.onChange({ target: { checked: false } });
    await h.flush();
    expect(sent()[0]).toEqual([steps[0], { ...steps[1], enabled: false }, steps[2]]);
    await catchUp(h);
    expect(on().props.checked).toBe(false);
    const skip = () => labelled(step(h, 3), gate('skippableStep', { n: 3 }));
    expect(skip().props.checked).toBe(false);
    skip().props.onChange({ target: { checked: true } });
    await h.flush();
    expect(sent()[1]).toEqual([
      steps[0],
      { ...steps[1], enabled: false },
      { ...steps[2], skippable: true },
    ]);
    await catchUp(h);
    expect(skip().props.checked).toBe(true);
  });

  it('sets the step switch by its handle and the skip choice after it, only while the step is on', async () => {
    const h = await folder();
    const controls = () =>
      nodes(step(h, 2))
        .filter((n) => n.type === 'input' || n.type === 'button')
        .map((n) => n.props['aria-label']);
    expect(controls()).toEqual([
      gate('moveStep', { n: 2 }),
      gate('enableStep', { n: 2 }),
      NAME,
      LINE,
      gate('timeoutField'),
      gate('skippableStep', { n: 2 }),
      gate('deleteStep', { n: 2 }),
    ]);
    // The skip choice's words come before its own switch.
    const skip = find(
      step(h, 2),
      (n) =>
        n.type === 'label' &&
        nodes(n.props.children).some(
          (c) => c.props['aria-label'] === gate('skippableStep', { n: 2 }),
        ),
    );
    expect(
      nodes(skip.props.children).map((c) => (c.type === 'input' ? 'switch' : text(c))),
    ).toEqual([gate('skippable'), 'switch']);
    labelled(step(h, 2), gate('enableStep', { n: 2 })).props.onChange({
      target: { checked: false },
    });
    await h.flush();
    await catchUp(h);
    expect(controls()).not.toContain(gate('skippableStep', { n: 2 }));
  });

  it('writes seconds in the same unit for how long a step took and for its timeout', async () => {
    const h = await folder();
    expect(text(step(h, 1))).toContain('8 秒');
    expect(text(step(h, 1))).toContain(zh('settings.gate.timeoutUnit'));
  });
});

describe('gate step helpers', () => {
  it('reads a step duration only from a run of the same name and command that ran it', () => {
    expect(lastDuration(steps[0]!, runs)).toBe(8400);
    expect(lastDuration(steps[1]!, runs)).toBeNull();
    expect(lastDuration(steps[0]!, [])).toBeNull();
  });

  it('places a row at another index and keeps the list when it stays put', () => {
    const rows = rowsOf(steps);
    expect(placeRow(rows, 2, 0).map((r) => r.name)).toEqual(['lint', 'typecheck', 'unit tests']);
    expect(placeRow(rows, 0, 2).map((r) => r.name)).toEqual(['unit tests', 'lint', 'typecheck']);
    expect(placeRow(rows, 1, 1)).toBe(rows);
  });

  it('keeps row keys it is given when it reads the saved gate again', () => {
    expect(rowsOf(steps, [5, 2, 7]).map((r) => r.id)).toEqual([5, 2, 7]);
    expect(rowsOf(steps, [5]).map((r) => r.id)).toEqual([5, 6, 7]);
  });
});

describe('what a failed gate does and where the gates run', () => {
  const choices = (group: ReactElement<any>) =>
    nodes(group)
      .filter((n) => n.props.value !== undefined && n !== group)
      .map((c) => text(c));

  it.each([
    [
      'sends what follows a failed gate',
      ON_FAIL,
      [gate('onFail.handback'), gate('onFail.retry'), gate('onFail.stop')],
      'handback',
      { gate_on_fail: 'stop' },
    ],
    [
      'sends where the gates run',
      RUNNER,
      ['daemon', gate('runner.session')],
      'daemon',
      { gate_runner: 'session' },
    ],
  ])('%s', async (_, label, shown, saved, input) => {
    const h = await fixLimit();
    const group = labelled(tree(h), label!);
    expect(choices(group)).toEqual(shown);
    expect(group.props.value).toBe(saved);
    group.props.onValueChange(Object.values(input)[0]);
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([{ project_id: 'alpha', ...input }]);
  });

  it('sends only the choice for each of the three', async () => {
    for (const [from, to] of [
      ['handback', 'retry'],
      ['retry', 'handback'],
      ['handback', 'stop'],
    ] as const) {
      bridge.answers['workflow.policy'] = policy({ gate_on_fail: from });
      bridge.commands = [];
      const h = await fixLimit();
      labelled(tree(h), ON_FAIL).props.onValueChange(to);
      await h.flush();
      expect(bridge.commands.map((c) => c.input)).toEqual([
        { project_id: 'alpha', gate_on_fail: to },
      ]);
    }
  });

  it('shows the saved choices', async () => {
    bridge.answers['workflow.policy'] = policy({ gate_on_fail: 'retry', gate_runner: 'session' });
    const h = await fixLimit();
    expect(labelled(tree(h), ON_FAIL).props.value).toBe('retry');
    expect(labelled(tree(h), RUNNER).props.value).toBe('session');
  });
});

describe('the GPU switch for gate commands', () => {
  const GPU = '门禁命令可使用 GPU';
  const gpu = async () => {
    const h = mount(() => GateGpu({ project }));
    await h.flush();
    return h;
  };
  const toggle = (h: HookHost<any>) =>
    find(tree(h), (n) => n.type === 'input' && n.props['aria-label'] === GPU);

  it('is off for a project that stores no choice and on once the project reads true', async () => {
    const h = await gpu();
    expect(toggle(h).props.type).toBe('checkbox');
    expect(toggle(h).props.checked).toBe(false);
    project = { ...project, revision: 5, gate_gpu: true };
    h.render();
    await h.flush();
    expect(toggle(h).props.checked).toBe(true);
  });

  it('sends the new choice at the project revision when it is clicked', async () => {
    const h = await gpu();
    toggle(h).props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands).toMatchObject([
      {
        type: 'project.gateGpu.set',
        input: { project_id: 'alpha', enabled: true },
        expected_revision: 4,
      },
    ]);
  });
});
