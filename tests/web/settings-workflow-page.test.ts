import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { HookHost, deferred, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { useSettingsView } from '@/screens/settings/view';
import { WorkflowPage } from '@/screens/settings/WorkflowPage';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const bridge = {
  answers: {} as Record<string, unknown>,
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return { ok: true, value: {} };
  },
};

const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  improvement_mode: 'confirm',
  plan_changes: 'auto',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: ['handback_limit'],
  ...patch,
});

let stored: Map<string, string>;
const param = (id: string) => zh(`data.workflowPolicy.param.${id}`);
const pin = (id: string) =>
  t({ id: 'settings.workflow.pin', defaultMessage: 'Pin {param}' }, { param: param(id) });
const runtimeLimit = (runtime: string) =>
  t(
    { id: 'settings.workflow.runtimeLimit', defaultMessage: '{runtime} concurrency limit' },
    { runtime },
  );
async function page() {
  const h = mount(() => WorkflowPage({ project: project as never }));
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const rowNames = (t: ReactNode) =>
  nodes(t)
    .filter((n) => n.props['data-setting-id'] && n.props.role === 'group')
    .map((n) => n.props['aria-label'] as string);
const alerts = (t: ReactNode) =>
  nodes(t)
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));
async function type(h: HookHost<any>, input: () => ReactElement<any>, value: string) {
  input().props.onChange({ target: { value } });
  await h.flush();
  input().props.onBlur();
  await h.flush();
}

beforeEach(() => {
  stored = new Map();
  bridge.answers = { 'workflow.policy': policy() };
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
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

describe('workflow settings page', () => {
  it('groups the parameters into dispatch, tasks and acceptance', async () => {
    const h = await page();
    const groups = nodes(tree(h)).filter((n) => typeof n.props.title === 'string');
    expect(groups.map((g) => g.props.title)).toEqual(
      ['dispatch', 'tasks', 'acceptance'].map((id) => zh(`settings.workflow.${id}`)),
    );
    expect(rowNames(groups[0]).slice(0, 4)).toEqual(
      ['maxParallel', 'maxParallelLimit', 'runtimeParallel', 'dispatchPaused'].map(param),
    );
    expect(rowNames(groups[1])).toEqual(['path', 'taskSizeHint', 'budget'].map(param));
    expect(rowNames(groups[2])).toEqual([param('acceptanceWake')]);
    expect(rowNames(tree(h))).not.toContain(param('handbackLimit'));
    expect(rowNames(tree(h))).not.toContain(param('improvementMode'));
  });

  it('sends the plan changes choice the user picks', async () => {
    const h = await page();
    const row = labelled(tree(h), zh('settings.workflow.planChanges'));
    expect(row.props.role).toBe('group');
    const wait = find(
      row,
      (n) => n.props.value !== undefined && text(n) === zh('settings.workflow.planChanges.confirm'),
    );
    find(row, (n) => typeof n.props.onValueChange === 'function').props.onValueChange(
      wait.props.value,
    );
    await h.flush();
    expect(bridge.commands.map((c) => [c.type, c.input])).toEqual([
      ['workflow.policy.set', { project_id: 'alpha', plan_changes: 'confirm' }],
    ]);
  });

  it('sets a count typed between its steps and refuses one out of range in its row', async () => {
    const h = await page();
    const max = param('maxParallel');
    const field = () =>
      find(labelled(tree(h), max), (n) => n.type === 'input' && n.props['aria-label'] === max);
    expect(field().props.value).toBe('3');
    await type(h, field, '9');
    expect(bridge.commands).toEqual([]);
    expect(alerts(labelled(tree(h), max)).join('\n')).toContain('1 到 4');
    await type(h, field, '2');
    expect(bridge.commands.map((c) => c.input)).toEqual([{ project_id: 'alpha', max_parallel: 2 }]);
  });

  it('holds every control while it shows an earlier read, with a retry once the new read fails', async () => {
    const before = new HookHost(() => WorkflowPage({ project: project as never }));
    before.render();
    await before.flush();
    before.unmount();
    const answer = deferred<BridgeResult<unknown>>();
    const query = bridge.query;
    bridge.query = (method) => (method === 'workflow.policy' ? answer.promise : query(method));
    try {
      const h = await page();
      const max = param('maxParallel');
      const field = () =>
        find(labelled(tree(h), max), (n) => n.type === 'input' && n.props['aria-label'] === max);
      expect(field().props.value).toBe('3');
      expect(field().props.disabled).toBe(true);
      expect(labelled(tree(h), pin('acceptanceWake')).props.disabled).toBe(true);
      const wake = find(
        labelled(tree(h), param('acceptanceWake')),
        (n) => typeof n.props.onValueChange === 'function',
      );
      expect(wake.props.disabled).toBe(true);

      answer.resolve({ ok: false, error: { code: 'internal', message: 'read failed' } });
      await h.flush();
      expect(field().props.disabled).toBe(true);
      const retry = find(tree(h), (n) => n.type === 'button' && text(n) === zh('components.retry'));
      bridge.query = query;
      retry.props.onClick();
      await h.flush();
      expect(field().props.disabled).toBe(false);
    } finally {
      bridge.query = query;
    }
  });

  it('lays the runtimes out in a grid of typed limits, empty for no limit', async () => {
    bridge.answers['workflow.policy'] = policy({ runtime_parallel: { claude: 8 } });
    bridge.answers['runtime.status'] = ['claude', 'codex', 'agy'].map((runtime) => ({
      runtime,
      enabled: true,
      installed: true,
      auth: { state: 'ok' },
    }));
    const h = await page();
    const row = () => labelled(tree(h), param('runtimeParallel'));
    const claude = () => labelled(row(), runtimeLimit('Claude'));
    const codex = () => labelled(row(), runtimeLimit('Codex'));
    expect(claude().props.value).toBe('8');
    expect(codex().props.value).toBe('');
    expect(codex().props.placeholder).toBe(zh('settings.common.noLimit'));
    await type(h, claude, '');
    await type(h, codex, '3');
    labelled(
      row(),
      t(
        { id: 'settings.workflow.decrease', defaultMessage: 'Decrease {param}' },
        { param: runtimeLimit('agy') },
      ),
    ).props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', runtime_parallel: {} },
      { project_id: 'alpha', runtime_parallel: { claude: 8, codex: 3 } },
      { project_id: 'alpha', runtime_parallel: { claude: 8, agy: 8 } },
    ]);
  });

  it('pins with an icon button that also pins the task budget', async () => {
    bridge.answers['workflow.policy'] = policy({ pinned: ['acceptance_wake'] });
    const h = await page();
    const pinOf = (id: string) => labelled(tree(h), pin(id));
    expect(pinOf('acceptanceWake').props['aria-pressed']).toBe(true);
    expect(pinOf('budget').props['aria-pressed']).toBe(false);
    expect(text(pinOf('budget'))).toBe('');
    pinOf('budget').props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', pinned: ['acceptance_wake', 'budget'] },
    ]);
  });

  it('puts the task budget table across the whole row', async () => {
    const h = await page();
    const row = labelled(tree(h), param('budget'));
    const table = find(row, (n) => n.props.className === 'wf-bud');
    expect((row.props.children as ReactNode[]).flat()).toContain(table);
  });

  it('turns on the recommended answer for reversible questions after a day', async () => {
    const h = await page();
    const row = labelled(tree(h), zh('settings.workflow.questionDefaults'));
    expect(row.props.role).toBe('group');
    const toggle = find(row, (n) => n.type === 'input' && n.props.type === 'checkbox');
    expect(toggle.props.checked).toBe(false);
    expect(
      nodes(row).some(
        (n) => n.props['aria-label'] === zh('settings.workflow.questionDefaultsHours'),
      ),
    ).toBe(false);
    toggle.props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', question_defaults: { after_hours: 24 } },
    ]);
  });

  it('sets the hours before a recommended answer applies within 1 to 168, and turns it off', async () => {
    bridge.answers['workflow.policy'] = policy({ question_defaults: { after_hours: 12 } });
    const h = await page();
    const label = zh('settings.workflow.questionDefaults');
    const hours = zh('settings.workflow.questionDefaultsHours');
    const field = () =>
      find(labelled(tree(h), label), (n) => n.type === 'input' && n.props['aria-label'] === hours);
    expect(field().props.value).toBe('12');
    await type(h, field, '200');
    expect(bridge.commands).toEqual([]);
    expect(alerts(labelled(tree(h), label)).join('\n')).toContain('1 到 168');
    await type(h, field, '48');
    find(
      labelled(tree(h), label),
      (n) => n.type === 'input' && n.props.type === 'checkbox',
    ).props.onChange({ target: { checked: false } });
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', question_defaults: { after_hours: 48 } },
      { project_id: 'alpha', question_defaults: null },
    ]);
  });
});
