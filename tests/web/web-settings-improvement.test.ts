import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import {
  find,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
  type HookHost,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { PATH_LABEL } from '@/data/workflow-policy';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { WorkflowPage } from '@/screens/settings/WorkflowPage';

const param = (key: string) => zh(`data.workflowPolicy.param.${key}`);
const path = (key: string) => zh(`data.workflowPolicy.path.${key}`);

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const bridge = {
  answers: {} as Record<string, unknown>,
  commandAnswer: { ok: true, value: {} } as BridgeResult<unknown>,
  queries: [] as string[],
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    bridge.queries.push(method);
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer;
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

async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
// Renders a component element the tree holds unrendered.
const expand = (node: ReactElement<any>) =>
  (node.type as (props: unknown) => ReactNode)(node.props);
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const button = (t: ReactNode, label: string) =>
  find(t, (n) => n.type === 'button' && text(n.props.children) === label);
const alerts = (t: ReactNode) =>
  nodes(t)
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));
async function click(h: HookHost<any>, target: ReactElement<any>) {
  target.props.onClick();
  await h.flush();
}

beforeEach(() => {
  bridge.answers = {};
  bridge.commandAnswer = { ok: true, value: {} };
  bridge.queries = [];
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useSettingsView.setState({ page: 'general' });
});

describe('settings navigation', () => {
  it('puts the harness page with the app pages and the workflow pages with the pages for every project', () => {
    expect(SETTINGS_PAGES.map((p) => `${p.group}:${p.key}:${p.label}`)).toEqual(
      expect.arrayContaining([
        `app:harness:${zh('settings.pages.runtimes')}`,
        `global:workflow:${zh('settings.pages.workflow')}`,
        `global:defaults:${zh('settings.pages.defaults')}`,
      ]),
    );
    expect(SETTINGS_PAGES.map((p) => p.key)).not.toContain('experience');
  });

  it('switches to each new page from the navigation', async () => {
    const screen = await mount(() => ProjectSettingsScreen());
    const nav = named(tree(screen), 'SettingsNav');
    const links = expand(nav);
    for (const [label, key, page] of [
      [zh('settings.pages.workflow'), 'workflow', 'WorkflowPage'],
      [zh('settings.pages.defaults'), 'defaults', 'SessionDefaults'],
    ] as const) {
      button(links, label).props.onClick();
      expect(useSettingsView.getState().page).toBe(key);
      const shown = await mount(() => ProjectSettingsScreen());
      expect(named(expand(named(tree(shown), 'GlobalPage')), page).props.project).toBeNull();
    }
    button(links, zh('settings.pages.runtimes')).props.onClick();
    expect(useSettingsView.getState().page).toBe('harness');
    const shown = await mount(() => ProjectSettingsScreen());
    const app = named(tree(shown), 'AppPage');
    const harness = await mount(() => expand(app));
    expect(named(tree(harness), 'HarnessPage').props.projectId).toBe('alpha');
  });
});

describe('workflow page', () => {
  const page = () => mount(() => WorkflowPage({ project: project as never }));

  it('shows the queried parallel limit and steps it with workflow.policy.set', async () => {
    bridge.answers['workflow.policy'] = policy();
    const h = await page();
    const row = labelled(tree(h), param('maxParallel'));
    expect(find(row, (n) => n.type === 'input').props.value).toBe('3');
    await click(h, labelled(row, '并发上限 加一'));
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'workflow.policy.set',
        input: { project_id: 'alpha', max_parallel: 4 },
        expected_revision: 2,
      }),
    ]);
  });

  it('writes a policy the daemon has not stored yet without an expected revision', async () => {
    bridge.answers['workflow.policy'] = policy({ revision: 0, policy_version: 0 });
    const h = await page();
    await click(h, labelled(tree(h), '并发上限 减一'));
    expect(bridge.commands[0]).toMatchObject({
      input: { max_parallel: 2 },
      expected_revision: null,
    });
  });

  it('turns a step off at the bounds the daemon accepts', async () => {
    bridge.answers['workflow.policy'] = policy({ max_parallel: 4 });
    const h = await page();
    const off = (label: string) => labelled(tree(h), label).props.disabled;
    expect(off('并发上限 加一')).toBe(true);
    expect(off('并发上限 减一')).toBe(false);
    expect(off('并发上限封顶 减一')).toBe(true);
    expect(off('并发上限封顶 加一')).toBe(false);
    expect(labelled(tree(h), '并发上限 加一').props.onClick).toBeUndefined();
  });

  it('pins and unpins a parameter', async () => {
    bridge.answers['workflow.policy'] = policy({ pinned: ['acceptance_wake'] });
    const h = await page();
    expect(labelled(tree(h), '钉住验收时机').props['aria-pressed']).toBe(true);
    await click(h, labelled(tree(h), '钉住验收时机'));
    await click(h, labelled(tree(h), '钉住并发上限'));
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', pinned: [] },
      { project_id: 'alpha', pinned: ['acceptance_wake', 'max_parallel'] },
    ]);
  });

  it('sets the concurrency of each runtime and pauses dispatch', async () => {
    bridge.answers['workflow.policy'] = policy({ runtime_parallel: { claude: 8 } });
    bridge.answers['runtime.status'] = ['claude', 'codex'].map((runtime) => ({
      runtime,
      enabled: true,
      installed: true,
      auth: { state: 'ok' },
    }));
    const h = await page();
    const row = () => labelled(tree(h), param('runtimeParallel'));
    const claude = () => labelled(row(), 'Claude 并发上限');
    expect(claude().props.value).toBe('8');
    expect(labelled(row(), 'Claude 并发上限 加一').props.disabled).toBe(true);
    await click(h, labelled(row(), 'Codex 并发上限 减一'));
    claude().props.onChange({ target: { value: '' } });
    await h.flush();
    claude().props.onBlur();
    await h.flush();
    const paused = find(labelled(tree(h), param('dispatchPaused')), (n) => n.type === 'input');
    expect(paused.props.checked).toBe(false);
    paused.props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', runtime_parallel: { claude: 8, codex: 8 } },
      { project_id: 'alpha', runtime_parallel: {} },
      { project_id: 'alpha', dispatch_paused: true },
    ]);
  });

  it('sends only the task budget cells that changed, with minutes as wall_ms', async () => {
    bridge.answers['workflow.policy'] = policy({
      budget: { t1: { direct: { input_tokens: 400000, wall_ms: 90000 } } },
    });
    const h = await page();
    const input = (label: string) => labelled(labelled(tree(h), param('budget')), label);
    const type = async (label: string, value: string) => {
      input(label).props.onChange({ target: { value } });
      await h.flush();
      input(label).props.onBlur();
      await h.flush();
    };
    expect(input('T1 主会话直接做 输入 token').props.value).toBe('400000');
    expect(input('T1 主会话直接做 分钟').props.value).toBe('1.5');
    expect(input('T2 派任务会话 分钟').props.value).toBe('');
    input('T2 派任务会话 分钟').props.onBlur();
    await h.flush();
    await type('T1 主会话直接做 分钟', '2');
    await type('T3 派任务会话 输入 token', '700000');
    await type('T3 派任务会话 分钟', '15');
    expect(bridge.commands.map((c) => c.input)).toEqual([
      {
        project_id: 'alpha',
        budget: { t1: { direct: { input_tokens: 400000, wall_ms: 120000 } } },
      },
      {
        project_id: 'alpha',
        budget: { t3: { dispatch: { input_tokens: 700000, wall_ms: 900000 } } },
      },
    ]);
  });

  it('names every flow path', () => {
    expect(PATH_LABEL).toEqual({
      direct: path('direct'),
      dispatch: path('dispatch'),
      review_loop: path('reviewLoop'),
      parallel: path('parallel'),
    });
  });

  it('offers each tier the three flow paths and sets the review loop', async () => {
    bridge.answers['workflow.policy'] = policy();
    const h = await page();
    for (const tier of ['T1', 'T2', 'T3'])
      expect(
        nodes(labelled(tree(h), `任务路径 ${tier}`).props.children).map((n) => n.props.value),
      ).toEqual(['direct', 'dispatch', 'review_loop']);
    labelled(tree(h), '任务路径 T2').props.onValueChange('review_loop');
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', path: { t2: 'review_loop' } },
    ]);
  });

  it('gives the review loop its own budget columns', async () => {
    bridge.answers['workflow.policy'] = policy();
    const h = await page();
    const table = () => labelled(tree(h), param('budget'));
    const input = (label: string) => labelled(table(), label);
    const type = async (label: string, value: string) => {
      input(label).props.onChange({ target: { value } });
      await h.flush();
      input(label).props.onBlur();
      await h.flush();
    };
    expect(nodes(table()).filter((n) => n.props.className === 'cap wf-bud-p')).toHaveLength(3);
    await type('T2 写和审来回 输入 token', '300000');
    await type('T2 写和审来回 分钟', '30');
    expect(bridge.commands.map((c) => c.input)).toEqual([
      {
        project_id: 'alpha',
        budget: { t2: { review_loop: { input_tokens: 300000, wall_ms: 1800000 } } },
      },
    ]);
  });

  it('shows a failed command where it was given', async () => {
    bridge.answers['workflow.policy'] = policy();
    bridge.commandAnswer = {
      ok: false,
      error: { code: 'invalid_input', message: 'max_parallel must be from 1 to 4' },
    };
    const h = await page();
    await click(h, labelled(tree(h), '并发上限 加一'));
    expect(alerts(tree(h)).join('\n')).toContain('max_parallel must be from 1 to 4');
  });

  it('shows a failed read', async () => {
    const h = await page();
    expect(alerts(tree(h)).join('\n')).toContain('workflow.policy');
  });
});
