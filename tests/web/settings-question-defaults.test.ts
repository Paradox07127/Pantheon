import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { HookHost, find, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { forgetQuery } from '@/data/query-cache';
import { useSettingsView } from '@/screens/settings/view';
import { QuestionDefaults } from '@/screens/settings/QuestionDefaults';
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
async function page() {
  const h = mount(() => QuestionDefaults({ project: project as never }));
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
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

describe('question defaults on a project page', () => {
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

  it('writes a policy the daemon has not stored yet without an expected revision', async () => {
    bridge.answers['workflow.policy'] = policy({ revision: 0, policy_version: 0 });
    const h = await page();
    find(
      labelled(tree(h), zh('settings.workflow.questionDefaults')),
      (n) => n.type === 'input' && n.props.type === 'checkbox',
    ).props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands[0]).toMatchObject({
      input: { question_defaults: { after_hours: 24 } },
      expected_revision: null,
    });
  });

  it('shows a failed read', async () => {
    forgetQuery('workflow.policy', 'alpha');
    bridge.answers = {};
    const h = await page();
    expect(alerts(tree(h)).join('\n')).toContain('workflow.policy');
  });
});
