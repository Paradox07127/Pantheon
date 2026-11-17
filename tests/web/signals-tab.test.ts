import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
const runCommand = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ ok: true, value: {} as unknown })),
);
vi.mock('@/data/commands', () => ({ runCommand }));
const read = vi.hoisted(() => ({ issues: null as any, agents: null as any }));
vi.mock('@/data/signals', () => ({
  useSignalIssues: () => ({
    read: read.issues,
    error: null,
    loading: read.issues === null,
    unavailable: false,
    stale: false,
    reload() {},
  }),
}));
vi.mock('@/data/agents', async (actual) => ({
  ...(await actual<object>()),
  useAgents: () => read.agents,
}));
import { SignalsTab } from '@/screens/insights/SignalsTab';

const NOW = Date.now();
const issue = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  revision: 1,
  project_id: 'alpha',
  source: 'gate_failures',
  fingerprint: `gate:${id}`,
  title: `Title of ${id}`,
  state: 'new',
  priority: 'interrupt',
  count: 1,
  first_seen: NOW - 60_000,
  last_seen: NOW,
  routed: [],
  samples: [],
  history: [{ at: NOW - 60_000, state: 'new', text: 'First signal' }],
  ...extra,
});

beforeEach(() => {
  runCommand.mockClear();
  read.agents = [
    {
      id: 'agent-triage',
      template: 'triage',
      name: 'Triage',
      role: 'Bugs',
      revision: 1,
      routines: [],
      role_prompt: '',
    },
  ];
  read.issues = [
    issue('env', {
      title: 'Environment failure on main',
      routed: [{ agent_id: 'agent-triage', at: NOW, state: 'new', via: 'interrupt' }],
    }),
    issue('single', {
      title: '212 single test failures',
      state: 'muted',
      priority: 'record',
      count: 212,
      muted_by: 'env',
    }),
    issue('crash', { title: 'Renderer crash', source: 'app_errors', state: 'regressed' }),
    issue('noisy', { title: 'Noisy log line', state: 'muted', muted_by_user: true }),
    issue('old', { title: 'Old flaky test', source: 'flaky_tests', state: 'resolved' }),
  ];
});
afterEach(() => unmountAll());

const tab = () => mount(() => SignalsTab({ projectId: 'alpha' }));
const listbox = (h: HookHost<any>) => nodes(h.value).find((n) => n.props.role === 'listbox')!;
/** The titles of the option rows, top to bottom, each the first part of its accessible name. */
const titles = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.props.role === 'option')
    .map((n) => String(n.props['aria-label']).split(/，|, /)[0]);
const radio = (h: HookHost<any>, id: string) =>
  nodes(h.value).find((n) => n.props.role === 'radio' && text(n).startsWith(zh(id)))!;
const button = (h: HookHost<any>, name: string) =>
  nodes(h.value).find((n) => n.type === 'button' && text(n) === name);

describe('signals tab', () => {
  it('lists the open issues with each muted one under the issue that mutes it', () => {
    const h = tab();
    expect(listbox(h).props['aria-label']).toBe(zh('insights.signals.list.open'));
    expect(titles(listbox(h))).toEqual([
      'Environment failure on main',
      '212 single test failures',
      'Renderer crash',
    ]);
    const group = nodes(h.value).find(
      (n) =>
        n.props.role === 'group' && n.props['aria-label'] === zh('insights.signals.mutedGroup'),
    )!;
    expect(titles(group)).toEqual(['212 single test failures']);
    const cause = nodes(h.value).find((n) => n.props.role === 'option')!;
    expect(cause.props['aria-label']).toContain(zh('sessions.agents.template.triage'));
    expect(text(radio(h, 'insights.signals.filter.open'))).toBe(
      `${zh('insights.signals.filter.open')}2`,
    );
    expect(text(radio(h, 'insights.signals.filter.muted'))).toBe(
      `${zh('insights.signals.filter.muted')}2`,
    );
    expect(text(radio(h, 'insights.signals.filter.resolved'))).toBe(
      `${zh('insights.signals.filter.resolved')}1`,
    );
  });

  it('switches to the muted issues', () => {
    const h = tab();
    radio(h, 'insights.signals.filter.muted').props.onClick();
    h.render();
    expect(radio(h, 'insights.signals.filter.muted').props['aria-checked']).toBe(true);
    expect(listbox(h).props['aria-label']).toBe(zh('insights.signals.list.muted'));
    expect(titles(listbox(h))).toEqual(['212 single test failures', 'Noisy log line']);
  });

  it('opens the selected issue and mutes and resolves it through the signal commands', async () => {
    const h = tab();
    nodes(h.value)
      .find((n) => n.props.role === 'option')!
      .props.onClick();
    h.render();
    const details = nodes(h.value).find(
      (n) => n.type === 'aside' && n.props['aria-label'] === zh('insights.signals.details'),
    )!;
    expect(text(details)).toContain('gate:env');
    expect(text(details)).toContain(zh('insights.signals.mutedByThis'));
    button(h, zh('insights.signals.mute'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith('signal.mute', { id: 'env' }, null);
    button(h, zh('insights.signals.resolve'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenLastCalledWith('signal.resolve', { id: 'env' }, null);
  });

  it('shows the newest sample of the selected issue as code, labelled by its origin', () => {
    read.issues = [issue('env', { samples: ['older sample line', 'newest sample line'] })];
    const h = tab();
    nodes(h.value)
      .find((n) => n.props.role === 'option')!
      .props.onClick();
    h.render();
    const sample = nodes(h.value).find(
      (n) =>
        n.type === 'section' &&
        String(n.props['aria-label']).startsWith(zh('insights.signals.sample')),
    )!;
    expect(sample.props['aria-label']).toContain(zh('insights.signals.source.gate'));
    expect(nodes(sample).some((n) => n.type === 'pre')).toBe(true);
    expect(text(sample)).toContain('newest sample line');
    expect(text(sample)).not.toContain('older sample line');
  });

  it('shows no sample section for an issue without samples', () => {
    const h = tab();
    nodes(h.value)
      .find((n) => n.props.role === 'option')!
      .props.onClick();
    h.render();
    expect(
      nodes(h.value).some((n) =>
        String(n.props['aria-label'] ?? '').startsWith(zh('insights.signals.sample')),
      ),
    ).toBe(false);
  });

  it('says in one sentence that there is nothing to show', () => {
    read.issues = [];
    const h = tab();
    const empty = nodes(h.value).find((n) => n.props.title === zh('insights.signals.empty.open'));
    expect(empty).toBeTruthy();
    expect(nodes(h.value).some((n) => n.props.role === 'option')).toBe(false);
  });
});
