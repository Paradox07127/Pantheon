import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { HookHost, find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/screens/settings/settings-jump', async (actual) => ({
  ...(await actual<object>()),
  openBoardTab: vi.fn(),
}));
import { RuntimeGlyph } from '@/components/RuntimeGlyph';
import { useBoard } from '@/data/board';
import { Section } from '@/screens/settings/ProjectSettingsScreen';
import { openBoardTab } from '@/screens/settings/settings-jump';
import { searchSettings } from '@/screens/settings/settings-search';
import { UsagePage } from '@/screens/settings/UsagePage';
import { WorkflowPage } from '@/screens/settings/WorkflowPage';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Project = NonNullable<Parameters<typeof UsagePage>[0]['project']>;

// A fresh project id per test, so a save left in the page's store shows nowhere else.
let made = 0;
let project: Project;

const bridge = {
  answers: {} as Record<string, unknown>,
  commandAnswers: [] as BridgeResult<unknown>[],
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswers.shift() ?? { ok: true, value: {} };
  },
};
const sent = () => bridge.commands.map((c) => c.input);

const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
  id: project.id,
  revision: 2,
  project_id: project.id,
  policy_version: 2,
  improvement_mode: 'confirm',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: ['handback_limit'],
  ...patch,
});

const [budget, quota] = [zh('settings.usage.projectBudget'), zh('settings.usage.quotaThreshold')];
const budgetParam = zh('data.workflowPolicy.param.projectBudget');
const quotaParam = zh('data.workflowPolicy.param.runtimeQuotaThreshold');
const target = (runtime: string) =>
  t({ id: 'settings.usage.targetField', defaultMessage: '{runtime} token target' }, { runtime });
const pinQuota = () =>
  t({ id: 'settings.usage.pin', defaultMessage: 'Pin {param}' }, { param: quota });

async function mount(body: () => unknown = () => UsagePage({ project })) {
  const h = host(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const inputOf = (t: ReactNode, row: string) => find(labelled(t, row), (n) => n.type === 'input');
const alerts = (t: ReactNode) =>
  nodes(t)
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));
async function type(h: HookHost<any>, input: () => { props: any }, value: string) {
  input().props.onChange({ target: { value } });
  await h.flush();
  input().props.onBlur();
  await h.flush();
  // The page's store does not mark the host for a render.
  h.render();
}

beforeEach(() => {
  project = { id: `alpha-${++made}`, revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
  bridge.answers = { 'workflow.policy': policy(), 'improvement.list': [] };
  bridge.commandAnswers = [];
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
  vi.mocked(openBoardTab).mockClear();
});

describe('usage page token targets', () => {
  it('gives each runtime a row with its glyph and name, empty for no target', async () => {
    project = { ...project, usage_targets: { claude: 20_000_000 } };
    const h = await mount();
    const section = find(
      tree(h),
      (n) => n.type === Section && n.props.title === zh('settings.usage.targets'),
    );
    const rows = nodes(section).filter((n) => n.props.role === 'group');
    expect(rows.map((r) => r.props['aria-label'])).toEqual(['Claude', 'Codex']);
    for (const row of rows) expect(nodes(row).some((n) => n.type === RuntimeGlyph)).toBe(true);
    expect(labelled(tree(h), target('Claude')).props.value).toBe('20000000');
    const codex = labelled(tree(h), target('Codex'));
    expect(codex.props.value).toBe('');
    expect(codex.props.placeholder).toBe(zh('settings.usage.noTarget'));
    expect(text(rows[1])).toContain('token');
  });

  it('sets a typed target on the project for its runtime alone and clears it with null when emptied', async () => {
    project = { ...project, usage_targets: { claude: 20_000_000 } };
    const h = await mount();
    const codex = () => labelled(tree(h), target('Codex'));
    await type(h, codex, '5000000');
    expect(codex().props.value).toBe('5000000');
    await type(h, codex, '5M');
    expect(codex().props['aria-invalid']).toBe(true);
    await type(h, codex, '');
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'project.usageTargets.set',
        input: { project_id: project.id, targets: { codex: 5_000_000 } },
        expected_revision: 1,
      }),
      expect.objectContaining({
        type: 'project.usageTargets.set',
        input: { project_id: project.id, targets: { codex: null } },
        expected_revision: 2,
      }),
    ]);
    expect(codex().props.value).toBe('');
  });

  it('shows a refused target in the row that made it', async () => {
    bridge.commandAnswers = [
      { ok: false, error: { code: 'invalid_input', message: 'target refused' } },
    ];
    const h = await mount();
    await type(h, () => labelled(tree(h), target('Codex')), '5000000');
    expect(text(labelled(tree(h), 'Codex'))).toContain('target refused');
    expect(text(labelled(tree(h), 'Claude'))).not.toContain('target refused');
  });
});

describe('usage page budget and quota', () => {
  it('sets the project budget with workflow.policy.set and clears it when emptied', async () => {
    bridge.answers['workflow.policy'] = policy({ project_budget: { input_tokens: 100, since: 1 } });
    const h = await mount();
    const input = () => inputOf(tree(h), budget);
    expect(input().props['aria-label']).toBe(budgetParam);
    expect(input().props.value).toBe('100');
    await type(h, input, '500000');
    await type(h, input, '');
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'workflow.policy.set',
        input: { project_id: project.id, project_budget: { input_tokens: 500000 } },
        expected_revision: 2,
      }),
      expect.objectContaining({ input: { project_id: project.id, project_budget: null } }),
    ]);
  });

  it('shows a budget that is not a positive whole number in its row', async () => {
    const h = await mount();
    const input = () => inputOf(tree(h), budget);
    await type(h, input, '-3');
    expect(sent()).toEqual([]);
    expect(text(labelled(tree(h), budget))).toContain(
      t(
        {
          id: 'settings.usage.positive',
          defaultMessage: '{param} must be a positive whole number',
        },
        { param: budgetParam },
      ),
    );
  });

  it('sets the quota threshold from 0 to 100 and shows another value in its row', async () => {
    const h = await mount();
    const input = () => inputOf(tree(h), quota);
    expect(input().props['aria-label']).toBe(quotaParam);
    expect(input().props.value).toBe('90');
    await type(h, input, '150');
    expect(sent()).toEqual([]);
    expect(text(labelled(tree(h), quota))).toContain(
      t(
        { id: 'settings.usage.percent', defaultMessage: '{param} must be from 0 to 100' },
        { param: quotaParam },
      ),
    );
    await type(h, input, '80');
    expect(sent()).toEqual([{ project_id: project.id, runtime_quota_threshold: 80 }]);
    expect(alerts(tree(h))).toEqual([]);
  });

  it('shows a refused save in the row that made it', async () => {
    bridge.commandAnswers = [
      { ok: false, error: { code: 'invalid_input', message: 'threshold refused' } },
    ];
    const h = await mount();
    await type(h, () => inputOf(tree(h), quota), '70');
    expect(text(labelled(tree(h), quota))).toContain('threshold refused');
    expect(text(labelled(tree(h), budget))).not.toContain('threshold refused');
  });

  it('pins and unpins the quota threshold', async () => {
    const h = await mount();
    const pin = () => labelled(tree(h), pinQuota());
    expect(pin().props['aria-pressed']).toBe(false);
    pin().props.onClick();
    await h.flush();
    bridge.answers['workflow.policy'] = policy({
      pinned: ['handback_limit', 'runtime_quota_threshold'],
      policy_version: 3,
    });
    const after = await mount();
    expect(labelled(tree(after), pinQuota()).props['aria-pressed']).toBe(true);
    labelled(tree(after), pinQuota()).props.onClick();
    await after.flush();
    expect(sent()).toEqual([
      { project_id: project.id, pinned: ['handback_limit', 'runtime_quota_threshold'] },
      { project_id: project.id, pinned: ['handback_limit'] },
    ]);
  });
});

describe('usage page board link', () => {
  it('opens the usage tab of the engineering board', async () => {
    const h = await mount();
    const link = find(
      tree(h),
      (n) => n.type === 'button' && text(n).includes(zh('settings.usage.openBoard')),
    );
    link.props.onClick();
    expect(openBoardTab).toHaveBeenCalledWith('usage');
  });
});

describe('budget and quota moved off the workflow page', () => {
  it('leaves neither row on the workflow page', async () => {
    const h = await mount(() => WorkflowPage({ project }));
    const labels = nodes(tree(h)).map((n) => n.props['aria-label']);
    expect(labels).toContain(zh('data.workflowPolicy.param.maxParallel'));
    expect(labels).not.toContain(budgetParam);
    expect(labels).not.toContain(quotaParam);
  });

  it("lands a search for the project budget on a project's page", () => {
    const hits = searchSettings('预算');
    expect(hits.find((hit) => hit.id === 'project.budget')?.page).toBe('project');
    expect(hits.map((hit) => hit.id)).not.toContain('workflow.projectBudget');
    expect(searchSettings('项目预算')[0]?.id).toBe('project.budget');
    expect(searchSettings('额度阈值')[0]?.id).toBe('usage.runtimeQuotaThreshold');
  });
});
