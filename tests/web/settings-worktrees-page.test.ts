import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { autoMergeRequest } from '@/data/auto-merge';
import { useBoard } from '@/data/board';
import { t as format } from '@/i18n';
import { FolderGate } from '@/screens/settings/GatesPage';
import { Section } from '@/screens/settings/ProjectSettingsScreen';
import { WorktreesPage } from '@/screens/settings/WorktreesPage';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Project = Parameters<typeof WorktreesPage>[0]['project'];

// A fresh project id per test, so a save left over in the page's store shows nowhere else.
const base: Project = {
  id: 'alpha',
  revision: 1,
  name: 'Alpha app',
  roots: ['/work/alpha'],
  gates: { '/work/alpha': [{ name: 'test', argv: ['pnpm', 'test'] }] },
};
let made = 0;
let gated = base;

const bridge = {
  commands: [] as Command[],
  answers: [] as BridgeResult<unknown>[],
  async query(): Promise<BridgeResult<unknown>> {
    return { ok: false, error: { code: 'unknown_route', message: 'none' } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.answers.shift() ?? { ok: true, value: { revision: 2 } };
  },
};
const sent = () =>
  bridge.commands.map(({ type, input, expected_revision }) => ({ type, input, expected_revision }));

function mount(start: Project) {
  const shown = { project: start };
  return { h: host(() => WorktreesPage({ project: shown.project })), shown };
}
const autoSwitch = (tree: unknown) =>
  find(tree as never, (n) => n.props['aria-label'] === zh('settings.autoMerge.toggle'));
const alert = (tree: unknown) => nodes(tree as never).find((n) => n.props.role === 'alert');
const gateName = format({ id: 'settings.gate.name', defaultMessage: '' });

beforeEach(() => {
  gated = { ...base, id: `alpha-${++made}` };
  bridge.commands = [];
  bridge.answers = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [gated], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('worktrees and merging page', () => {
  it('holds the auto-merge switch in its merging group', () => {
    const { h } = mount(gated);
    const group = find(
      h.value,
      (n) => n.type === Section && n.props.title === zh('settings.worktrees.merging'),
    );
    expect(nodes(group).some((n) => n.props.settingId === 'worktrees.autoMerge')).toBe(true);
    expect(autoSwitch(group).props.checked).toBe(false);
    expect(autoSwitch(group).props.disabled).toBe(false);
  });

  it('needs a gate on the first folder before it can be turned on', () => {
    const { h } = mount({ ...gated, gates: {} });
    expect(autoSwitch(h.value).props.disabled).toBe(true);
    const on = mount({ ...gated, gates: {}, auto_merge: true });
    expect(autoSwitch(on.h.value).props.disabled).toBe(false);
  });

  it('sends the switch and shows the sent value until the board catches up', async () => {
    const { h, shown } = mount(gated);
    autoSwitch(h.value).props.onChange({ target: { checked: true } });
    await h.flush();
    h.render();
    expect(sent()).toEqual([autoMergeRequest(gated, true)]);
    expect(autoSwitch(h.value).props.checked).toBe(true);
    expect(autoSwitch(h.value).props.disabled).toBe(true);

    shown.project = { ...gated, revision: 2, auto_merge: true };
    h.render();
    h.render();
    expect(autoSwitch(h.value).props.checked).toBe(true);
    expect(autoSwitch(h.value).props.disabled).toBe(false);
  });

  it("shows the daemon's refusal in place and keeps the saved value", async () => {
    bridge.answers = [{ ok: false, error: { code: 'no_gate', message: 'add a gate first' } }];
    const { h } = mount(gated);
    autoSwitch(h.value).props.onChange({ target: { checked: true } });
    await h.flush();
    h.render();
    expect(text(alert(h.value))).toContain('add a gate first');
    expect(autoSwitch(h.value).props.checked).toBe(false);
    expect(autoSwitch(h.value).props.disabled).toBe(false);
  });

  it('waits for the board to catch up with a gate just saved before the switch can be used', async () => {
    const gates = host(() =>
      FolderGate({ project: gated, root: '/work/alpha', named: false, git: true, runs: [] }),
    );
    const { h, shown } = mount(gated);
    const name = () =>
      find(gates.value as never, (n) => n.type === 'input' && n.props['aria-label'] === gateName);
    name().props.onChange({ target: { value: 'unit' } });
    await gates.flush();
    name().props.onBlur();
    await gates.flush();
    h.render();
    expect(sent().map((c) => c.type)).toEqual(['project.gate.set']);
    expect(autoSwitch(h.value).props.disabled).toBe(true);

    shown.project = { ...gated, revision: 2 };
    h.render();
    expect(autoSwitch(h.value).props.disabled).toBe(false);
  });
});
