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
import { forgetQuery } from '@/data/query-cache';
import { t } from '@/i18n';
import { GlobalPermissions } from '@/screens/settings/PermissionsPage';
import { ProjectListPage } from '@/screens/settings/ProjectListPage';
import { useSettingsView } from '@/screens/settings/view';
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
      {
        key: 'session_defaults',
        overrides: [{ project_id: 'beta', name: 'Beta api', value: { runtime: 'codex' } }],
      },
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
    const defaults = zh('settings.pages.defaults');
    expect(
      nodes(own)
        .filter((n) => n.props.label !== undefined)
        .map((n) => n.props.label),
    ).toEqual([zh('settings.pages.workflow'), defaults]);
    button(own, zhf('settings.projectList.clearNamed', { setting: defaults })).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'project.override.clear',
        input: { project_id: 'beta', key: 'session_defaults' },
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
