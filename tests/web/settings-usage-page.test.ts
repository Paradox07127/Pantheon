import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { HookHost, find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { searchSettings } from '@/screens/settings/settings-search';
import { UsagePage } from '@/screens/settings/UsagePage';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Project = Parameters<typeof UsagePage>[0]['project'];

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
  ...patch,
});

const budget = zh('settings.usage.projectBudget');
const budgetParam = zh('data.workflowPolicy.param.projectBudget');

async function mount(body: () => unknown = () => UsagePage({ project })) {
  const h = host(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const inputOf = (t: ReactNode, row: string) => find(labelled(t, row), (n) => n.type === 'input');
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
  bridge.answers = { 'workflow.policy': policy() };
  bridge.commandAnswers = [];
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
});

describe('usage page budget', () => {
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

  it('shows a refused save in its row', async () => {
    bridge.commandAnswers = [
      { ok: false, error: { code: 'invalid_input', message: 'budget refused' } },
    ];
    const h = await mount();
    await type(h, () => inputOf(tree(h), budget), '70');
    expect(text(labelled(tree(h), budget))).toContain('budget refused');
  });
});

describe('usage page board link', () => {
  it('has no link to the engineering board', async () => {
    const h = await mount();
    expect(nodes(tree(h)).filter((n) => n.type === 'button' && text(n) === '看用量')).toEqual([]);
  });
});

describe('budget and quota search', () => {
  it("lands a search for the project budget on a project's page", () => {
    const hits = searchSettings('预算');
    expect(hits.find((hit) => hit.id === 'project.budget')?.page).toBe('project');
    expect(hits.map((hit) => hit.id)).not.toContain('workflow.projectBudget');
    expect(searchSettings('项目预算')[0]?.id).toBe('project.budget');
    expect(searchSettings('额度阈值').map((hit) => hit.id)).not.toContain(
      'usage.runtimeQuotaThreshold',
    );
  });
});
