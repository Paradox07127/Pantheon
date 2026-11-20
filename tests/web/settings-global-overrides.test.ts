import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult, ProjectDefaultsRead } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { effectiveUsageTargets } from '@/data/project-defaults';
import { forgetQuery } from '@/data/query-cache';
import { t } from '@/i18n';
import { Overrides } from '@/screens/settings/Overrides';
import { GlobalPermissions } from '@/screens/settings/PermissionsPage';
import { ProjectListPage } from '@/screens/settings/ProjectListPage';
import { useSettingsView } from '@/screens/settings/view';
import { WorkflowPage } from '@/screens/settings/WorkflowPage';
import { WorktreesPage } from '@/screens/settings/WorktreesPage';
import { zh, zhf } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const alpha = { id: 'alpha', revision: 4, name: 'Alpha app', roots: ['/work/alpha'] };
const beta = {
  id: 'beta',
  revision: 7,
  name: 'Beta api',
  roots: ['/work/beta'],
  gates: { '/work/beta': [{ name: 'test', argv: ['pnpm', 'test'] }] },
};
const builtin = {
  improvement_mode: 'auto',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 6,
  runtime_parallel: {},
  dispatch_paused: false,
  runtime_quota_threshold: 90,
  handback_limit: 3,
  gate_on_fail: 'handback',
  gate_runner: 'daemon',
  budget: {},
  pinned: [],
};
const defaults = (patch: Partial<ProjectDefaultsRead> = {}): ProjectDefaultsRead =>
  ({
    settings: [
      {
        key: 'workflow_policy',
        global: { max_parallel: 4 },
        builtin,
        overrides: [{ project_id: 'beta', name: 'Beta api', value: { max_parallel: 5 } }],
      },
      { key: 'session_defaults', overrides: [] },
      { key: 'usage_targets', global: { codex: 700 }, builtin: {}, overrides: [] },
      {
        key: 'external_events',
        builtin: 'off',
        overrides: [{ project_id: 'beta', name: 'Beta api', value: 'auto' }],
      },
      { key: 'auto_merge', global: true, builtin: false, overrides: [] },
    ],
    projects: [
      { project_id: 'alpha', name: 'Alpha app', overridden: 0 },
      { project_id: 'beta', name: 'Beta api', overridden: 2 },
    ],
    permission_rules: [{ rule: 'Bash(git status)', added_at: Date.now() }],
    ...patch,
  }) as ProjectDefaultsRead;
const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicy =>
  ({
    ...builtin,
    id: 'alpha',
    revision: 2,
    project_id: 'alpha',
    policy_version: 2,
    ...patch,
  }) as WorkflowPolicy;

const bridge = {
  answers: {} as Record<string, unknown>,
  commands: [] as Command[],
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    const answer = bridge.answers[method];
    const value = typeof answer === 'function' ? answer(params) : answer;
    return value === undefined
      ? { ok: false, error: { code: 'unknown_route', message: method } }
      : { ok: true, value };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return { ok: true, value: defaults() };
  },
};
const sent = () =>
  bridge.commands.map(({ type, input, expected_revision }) => ({ type, input, expected_revision }));

const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const button = (tree: ReactNode, name: string) =>
  find(tree, (n) => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === name);
const param = (id: string) => zh(`data.workflowPolicy.param.${id}`);
const overridesOf = (tree: ReactNode) => find(tree, (n) => n.type === Overrides);
const opener = (tree: ReactNode) => find(tree, (n) => n.props['aria-haspopup'] === 'dialog');
const openLabel = (count: number, setting: string) =>
  zhf('settings.overrides.open', { count, setting });

beforeEach(() => {
  forgetQuery('project.defaults', 'all');
  bridge.answers = {
    'project.defaults': defaults(),
    'workflow.policy': (params: { project_id: string }) =>
      policy({ project_id: params.project_id, revision: 9 }),
  };
  bridge.commands = [];
  vi.stubGlobal('window', {
    pantheon: bridge,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
  });
  useBoard.setState({
    board: { cursor: 1, projects: [alpha, beta], sessions: [] },
    status: { state: 'live' },
  } as never);
  useSettingsView.setState({ open: false, page: 'general', detail: null, query: '' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('a setting every project follows', () => {
  it('edits the global value over the built-in one and counts the projects that set their own', async () => {
    const h = mount(() => WorkflowPage({ project: null }));
    await h.flush();
    const row = () => labelled(h.value, param('maxParallel'));
    const field = () =>
      find(row(), (n) => n.type === 'input' && n.props['aria-label'] === param('maxParallel'));
    expect(field().props.value).toBe('4');

    const counted = mount(() => Overrides(overridesOf(row()).props));
    expect(opener(counted.value).props['aria-label']).toBe(openLabel(1, param('maxParallel')));
    expect(text(opener(counted.value))).toBe('1');
    const none = mount(() =>
      Overrides(overridesOf(labelled(h.value, param('maxParallelLimit'))).props),
    );
    expect(opener(none.value).props['aria-label']).toBe(openLabel(0, param('maxParallelLimit')));
    expect(text(opener(none.value))).toBe('');

    field().props.onChange({ target: { value: '2' } });
    await h.flush();
    field().props.onBlur();
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'project.defaults.set',
        input: { key: 'workflow_policy', value: { max_parallel: 2 } },
        expected_revision: null,
      },
    ]);
  });

  it('clears a project’s own value and the global one from the row’s dialog', async () => {
    const h = mount(() => WorkflowPage({ project: null }));
    await h.flush();
    const dialog = mount(() =>
      Overrides(overridesOf(labelled(h.value, param('maxParallel'))).props),
    );
    await dialog.flush();
    const list = labelled(dialog.value, zh('settings.overrides.list'));
    expect(
      nodes(list)
        .filter((n) => n.props.role === 'listitem')
        .map(text),
    ).toEqual([`Beta api5${zh('settings.overrides.clear')}`]);
    button(list, zhf('settings.overrides.clearNamed', { project: 'Beta api' })).props.onClick();
    await dialog.flush();
    button(dialog.value, zh('settings.overrides.restoreDefault')).props.onClick();
    await dialog.flush();
    expect(sent()).toEqual([
      {
        type: 'project.override.clear',
        input: { project_id: 'beta', key: 'workflow_policy', param: 'max_parallel' },
        expected_revision: 9,
      },
      {
        type: 'project.defaults.set',
        input: { key: 'workflow_policy', value: {} },
        expected_revision: null,
      },
    ]);
  });

  it('edits the gate settings every project follows, each row with the projects that set their own', async () => {
    const h = mount(() => WorkflowPage({ project: null }));
    await h.flush();
    const gates = find(h.value, (n) => n.props.title === zh('settings.pages.gates'));
    const onFail = zh('settings.gate.onFail');
    const limit = param('handbackLimit');
    for (const name of [onFail, limit])
      expect(overridesOf(labelled(gates, name)).props.name).toBe(name);
    find(labelled(gates, onFail), (n) => n.props.onValueChange !== undefined).props.onValueChange(
      'stop',
    );
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'project.defaults.set',
        input: { key: 'workflow_policy', value: { max_parallel: 4, gate_on_fail: 'stop' } },
        expected_revision: null,
      },
    ]);
  });

  it('sets a chosen project’s own value inside the dialog', async () => {
    const h = mount(() => WorkflowPage({ project: null }));
    await h.flush();
    const props = overridesOf(labelled(h.value, param('maxParallel'))).props;
    const dialog = mount(() => Overrides(props));
    await dialog.flush();
    const editor = () =>
      find(dialog.value, (n) => n.type === WorkflowPage) as ReactElement<{
        project: { id: string };
        only: string;
      }>;
    // A project that follows the global value comes first.
    expect(editor().props).toMatchObject({ project: { id: 'alpha' }, only: 'max_parallel' });
    find(
      dialog.value,
      (n) => n.props['aria-label'] === zh('settings.overrides.project'),
    ).props.onChange('beta');
    await dialog.flush();
    expect(editor().props.project.id).toBe('beta');

    const own = mount(() => WorkflowPage(editor().props as never));
    await own.flush();
    const field = () =>
      find(own.value, (n) => n.type === 'input' && n.props['aria-label'] === param('maxParallel'));
    field().props.onChange({ target: { value: '1' } });
    await own.flush();
    field().props.onBlur();
    await own.flush();
    expect(sent()).toEqual([
      {
        type: 'workflow.policy.set',
        input: { project_id: 'beta', max_parallel: 1 },
        expected_revision: 9,
      },
    ]);
  });
});

describe('the projects page', () => {
  it('lists every project with how many settings it sets itself, and opens one', async () => {
    const h = mount(() => ProjectListPage());
    await h.flush();
    const list = labelled(h.value, zh('settings.pages.projects'));
    expect(
      nodes(list)
        .filter((n) => n.props.role === 'listitem')
        .map(text),
    ).toEqual(['Alpha app', `Beta api${zhf('settings.projectList.ownCount', { count: 2 })}`]);
    find(list, (n) => n.type === 'button' && text(n).startsWith('Beta api')).props.onClick();
    expect(useSettingsView.getState().detail).toBe('beta');
  });

  it('shows the settings the project sets itself, each cleared on its own', async () => {
    useSettingsView.setState({ page: 'projects', detail: 'beta' });
    const list = mount(() => ProjectListPage());
    const detail = list.value as ReactElement<any>;
    const h = mount(() => (detail.type as (props: unknown) => ReactNode)(detail.props));
    await h.flush();
    const own = find(h.value, (n) => n.props.title === zh('settings.projectList.own'));
    const external = zh('settings.pages.external');
    expect(
      nodes(own)
        .filter((n) => n.props.label !== undefined)
        .map((n) => n.props.label),
    ).toEqual([zh('settings.pages.workflow'), external]);
    button(own, zhf('settings.projectList.clearNamed', { setting: external })).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'project.override.clear',
        input: { project_id: 'beta', key: 'external_events' },
        expected_revision: 7,
      },
    ]);
    button(h.value, zh('settings.nav.projects')).props.onClick();
    expect(useSettingsView.getState().detail).toBeNull();
  });
});

describe('global permission rules', () => {
  it('adds and removes a rule every project follows', async () => {
    const h = mount(() => GlobalPermissions());
    await h.flush();
    const list = labelled(h.value, zh('settings.permissions.rules'));
    expect(nodes(list).filter((n) => n.props.role === 'listitem').length).toBe(1);
    button(
      list,
      t(
        { id: 'settings.permissions.removeRule', defaultMessage: '' },
        { rule: 'Bash(git status)' },
      ),
    ).props.onClick();
    await h.flush();
    const field = () => labelled(h.value, zh('settings.permissions.newRule'));
    field().props.onChange({ target: { value: ' Bash(ls) ' } });
    await h.flush();
    button(h.value, zh('settings.permissions.add')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'permission.globalRule.remove',
        input: { rule: 'Bash(git status)' },
        expected_revision: null,
      },
      { type: 'permission.globalRule.add', input: { rule: 'Bash(ls)' }, expected_revision: null },
    ]);
    expect(field().props.value).toBe('');
  });
});

describe('values a project follows', () => {
  it('shows a project’s auto merge as the global value until it sets its own', async () => {
    const label = zh('settings.autoMerge.toggle');
    const follows = mount(() => WorktreesPage({ project: beta as never }));
    await follows.flush();
    expect(labelled(follows.value, label).props.checked).toBe(true);
    const own = mount(() => WorktreesPage({ project: { ...beta, auto_merge: false } as never }));
    await own.flush();
    expect(labelled(own.value, label).props.checked).toBe(false);
  });

  it('reads token targets from the project, then the global ones', () => {
    expect(effectiveUsageTargets({ usage_targets: { claude: 500 } }, defaults())).toEqual({
      codex: 700,
      claude: 500,
    });
    expect(effectiveUsageTargets(undefined, defaults())).toEqual({ codex: 700 });
  });
});
