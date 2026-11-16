import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BoardModel, BridgeResult } from '@pantheon/protocol';
import { HookHost, find, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { PolicyFields, WorkflowTab } from '@/screens/insights/WorkflowTab';
import { useSettingsView } from '@/screens/settings/view';
import { zh } from './i18n-setup.js';

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };

const policy = (): WorkflowPolicy => ({
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  improvement_mode: 'confirm',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'milestone',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 2,
  budget: {},
  pinned: [],
  dispatch_paused: true,
  runtime_parallel: { claude: 2 },
  runtime_quota_threshold: 75,
});

const view = {
  definition_version: 2,
  definition: {
    slots: { before_dispatch: [], before_merge: [], after_merge: [] },
    plan_review: { tiers: [] },
    review: { max_rounds: 3 },
  },
  fixed_steps: ['dispatch', 'gate', 'merge', 'handback', 'wake', 'review'].map((id) => ({
    id,
    policy: id === 'merge' ? { auto_merge: false } : {},
  })),
};

let commands: unknown[];
const bridge = {
  async query(method: string): Promise<BridgeResult<unknown>> {
    if (method === 'workflow.policy') return { ok: true, value: policy() };
    if (method === 'workflow.definition') return { ok: true, value: view };
    if (method === 'routing.table') return { ok: true, value: { cells: [] } };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: unknown): Promise<BridgeResult<unknown>> {
    commands.push(command);
    return { ok: true, value: {} };
  },
};

const hosts: HookHost<any>[] = [];
async function fields(step: string) {
  const h = new HookHost(() => PolicyFields({ projectId: 'alpha', step }));
  hosts.push(h);
  h.render();
  await h.flush();
  return h;
}
const rowTexts = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.props.className === 'wfl-row')
    .map((n) => [text(find(n, (c) => c.props.className === 'wfl-rl')), text(find(n, isValue))]);
const isValue = (n: ReactElement<any>) => n.props.className === 'wfl-pv';
const controls = (tree: unknown) =>
  nodes(tree as never).filter(
    (n) =>
      n.type === 'input' ||
      n.type === 'output' ||
      typeof n.props.onValueChange === 'function' ||
      typeof n.props.onChange === 'function',
  );
const buttons = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n) === label);

beforeEach(() => {
  commands = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
  useSettingsView.setState({ open: false, page: 'general' });
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('policy parameters in the step inspector', () => {
  it('shows each parameter as its label and value, with no control to change it', async () => {
    const dispatch = await fields('dispatch');
    expect(rowTexts(dispatch.value)).toEqual([
      [zh('data.workflowPolicy.param.maxParallel'), '3'],
      [zh('data.workflowPolicy.param.runtimeParallel'), 'Claude 2'],
      [zh('data.workflowPolicy.param.dispatchPaused'), zh('insights.workflow.on')],
      [zh('data.workflowPolicy.param.runtimeQuotaThreshold'), '75'],
      [zh('data.workflowPolicy.param.projectBudget'), zh('settings.common.noLimit')],
    ]);
    expect(rowTexts((await fields('handback')).value)).toEqual([
      [zh('data.workflowPolicy.param.handbackLimit'), '2'],
    ]);
    expect(rowTexts((await fields('gate')).value)).toEqual([
      [zh('data.workflowPolicy.param.handbackLimit'), '2'],
    ]);
    expect(rowTexts((await fields('wake')).value)).toEqual([
      [zh('data.workflowPolicy.param.acceptanceWake'), zh('data.workflowPolicy.wake.milestone')],
    ]);
    for (const h of hosts) {
      expect(controls(h.value)).toEqual([]);
      expect(
        buttons(h.value).every((b) =>
          [
            zh('insights.workflow.editInSettings'),
            zh('insights.workflow.workflowSettings'),
            zh('insights.workflow.usageSettings'),
          ].includes(b),
        ),
      ).toBe(true);
    }
    expect(commands).toEqual([]);
  });

  it('opens the settings page that holds the parameters', async () => {
    const handback = await fields('handback');
    expect(buttons(handback.value)).toEqual([zh('insights.workflow.editInSettings')]);
    button(handback.value, zh('insights.workflow.editInSettings')).props.onClick();
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      detail: 'alpha',
      page: 'gates',
    });

    useSettingsView.setState({ open: false, page: 'general' });
    const dispatch = await fields('dispatch');
    expect(buttons(dispatch.value)).toEqual([
      zh('insights.workflow.workflowSettings'),
      zh('insights.workflow.usageSettings'),
    ]);
    button(dispatch.value, zh('insights.workflow.usageSettings')).props.onClick();
    expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'usage' });
    button(dispatch.value, zh('insights.workflow.workflowSettings')).props.onClick();
    expect(useSettingsView.getState().page).toBe('workflow');
  });

  it('keeps the other settings of the inspector editable', async () => {
    const h = new HookHost(() =>
      WorkflowTab({
        projectId: 'alpha',
        model: { now: 0, tasks: [] } as unknown as BoardModel,
        onOpenSession: () => {},
      }),
    );
    hosts.push(h);
    h.render();
    await h.flush();
    const select = async (step: string) => {
      find(h.value, (n) => n.props['data-step'] === step && n.type === 'button').props.onClick();
      await h.flush();
    };
    const labelled = (label: string) => nodes(h.value).some((n) => n.props['aria-label'] === label);
    await select('review');
    expect(labelled('代码审查最多几轮 加一')).toBe(true);
    await select('merge');
    expect(labelled(zh('insights.workflow.autoMerge'))).toBe(true);
    await select('gate');
    expect(buttons(h.value)).toContain(zh('insights.workflow.gate.add'));
  });
});
