import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel, BridgeResult } from '@pantheon/protocol';
import type { ImprovementFinding } from '@/data/workflow-policy';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const mock = vi.hoisted(() => ({
  findings: [] as ImprovementFinding[],
  notices: [] as {
    heading: string;
    command?: string;
    actions?: { label: string; run(): void }[];
  }[],
}));
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useImprovementSignals: () => ({
    read: mock.findings,
    error: null,
    loading: false,
    unavailable: false,
    stale: false,
    reload() {},
  }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  noticeResult: (options: (typeof mock.notices)[number]) => {
    mock.notices.push(options);
    return 'notice';
  },
}));
import { useBoard } from '@/data/board';
import { AllowRule, DigestPanel, type AllowRuleProps } from '@/screens/insights/DigestPanel';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown> };

const NOW = Date.UTC(2026, 10, 11, 12);
const MODEL = {
  since: NOW - 7 * 86_400_000,
  now: NOW,
  counts: { merged: 0, median_ms: null },
  milestones: [],
  task_progress: {
    totals: {
      done: 0,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
  },
  tasks: [],
  merges: [],
} as unknown as BoardModel;

const approved = (extra: object = {}): ImprovementFinding => ({
  signal: 'always_approved_command',
  retrospective_ids: [],
  evidence: {
    kind: 'always_approved_command',
    command: 'pnpm db:migrate --env staging',
    approvals: 11,
    ...extra,
  },
});
const RULE = { rule: 'Bash(pnpm db:migrate:*)', session_id: 'session-a' };

const bridge = {
  commands: [] as Command[],
  refusal: null as { code: string; message: string } | null,
  pending: null as Promise<void> | null,
  async query(method: string): Promise<BridgeResult<unknown>> {
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    if (bridge.pending) await bridge.pending;
    return bridge.refusal ? { ok: false, error: bridge.refusal } : { ok: true, value: {} };
  },
};

const panel = () =>
  DigestPanel({ model: MODEL, projectId: 'alpha', bar: null, week: 0, onWeek() {} });
const ruleRow = () => find(panel() as never, (n) => n.type === 'li');
// Runs the row's rule button, which the panel puts in the row of the finding.
async function mount() {
  const element = find(ruleRow(), (n) => n.type === AllowRule);
  const h = host(() => AllowRule(element.props as AllowRuleProps));
  await h.flush();
  return h;
}
const allowButton = (tree: unknown) =>
  nodes(tree as never).find(
    (n) => n.type === 'button' && text(n) === zh('insights.digest.allowForProject'),
  );
const sent = () => bridge.commands.map((c) => [c.type, c.input]);

beforeEach(() => {
  mock.findings = [approved(RULE)];
  mock.notices = [];
  bridge.commands = [];
  bridge.refusal = null;
  bridge.pending = null;
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [], session_turns: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('always allowing an approved command for the project', () => {
  it('adds the rule the last approval backs with permission.rule.add', async () => {
    const h = await mount();
    allowButton(h.value)!.props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      [
        'permission.rule.add',
        { project_id: 'alpha', rule: 'Bash(pnpm db:migrate:*)', session_id: 'session-a' },
      ],
    ]);
  });

  it('is disabled while the command runs', async () => {
    let release!: () => void;
    bridge.pending = new Promise((resolve) => (release = resolve));
    const h = await mount();
    allowButton(h.value)!.props.onClick();
    await h.flush();
    expect(allowButton(h.value)!.props.disabled).toBe(true);
    release();
    await h.flush();
    expect(allowButton(h.value)!.props.disabled).toBe(false);
  });

  it('shows a refusal in the row, without a notice', async () => {
    bridge.refusal = {
      code: 'permission_denied',
      message: 'Only the user can add permission rules',
    };
    const h = await mount();
    allowButton(h.value)!.props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(
      'permission_denied：Only the user can add permission rules',
    );
    expect(mock.notices).toEqual([]);
  });

  it('says so with the rule and undoes it with permission.rule.remove', async () => {
    const h = await mount();
    allowButton(h.value)!.props.onClick();
    await h.flush();
    expect(mock.notices).toHaveLength(1);
    const [notice] = mock.notices;
    expect(notice).toMatchObject({
      heading: zh('insights.digest.allowedForProject'),
      command: 'Bash(pnpm db:migrate:*)',
    });
    expect(notice!.actions!.map((a) => a.label)).toEqual([zh('insights.digest.undo')]);
    notice!.actions![0]!.run();
    await h.flush();
    expect(sent()[1]).toEqual([
      'permission.rule.remove',
      { project_id: 'alpha', rule: 'Bash(pnpm db:migrate:*)' },
    ]);
  });

  it('offers nothing when no project rule backs the command', () => {
    mock.findings = [approved()];
    expect(nodes(ruleRow()).some((n) => n.type === AllowRule)).toBe(false);
  });
});
