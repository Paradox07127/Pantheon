import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { ExternalEvent, ExternalRead } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import {
  type HookHost,
  deferred,
  find,
  mount as host,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { RadioGroup } from '../../apps/web/node_modules/@base-ui/react/radio-group/index.mjs';
import { EmptyState } from '@/components/EmptyState';
import { useBoard } from '@/data/board';
import { t } from '@/i18n';
import { ExternalPage } from '@/screens/settings/ExternalPage';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';

type Project = Parameters<typeof ExternalPage>[0]['project'];
type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const NOW = new Date(2026, 10, 14, 15, 0).getTime(),
  MINUTE = 60_000;

let made = 0;
let project: Project;
const event = (fields: Partial<ExternalEvent>): ExternalEvent => ({
  id: `event-${++made}`,
  revision: 1,
  project_id: project.id,
  source: 'github',
  subject_key: 'github:acme/reports#12',
  kind: 'issue_assigned',
  actor: 'taylor',
  actor_trust: 'self',
  title: 'Totals are wrong',
  url: 'https://github.com/acme/reports/issues/12',
  texts: [],
  received_at: NOW - 2 * MINUTE,
  state: 'handled',
  ...fields,
});
const read = (fields: Partial<ExternalRead> = {}): BridgeResult<unknown> => ({
  ok: true,
  value: {
    mode: 'approve',
    sources: [{ id: 'github', polled_at: NOW - MINUTE }],
    events: [
      event({ session_id: 'held' }),
      event({
        kind: 'review_requested',
        title: 'Sign callbacks',
        actor: 'robin',
        actor_trust: 'write',
        session_id: 'working',
        received_at: NOW - 18 * MINUTE,
      }),
      event({ kind: 'mention', title: 'Roll this back?', actor: 'robin', state: 'pending' }),
      event({ title: 'Bump lodash', actor: 'dependabot', actor_trust: 'bot', state: 'dropped' }),
      event({
        title: 'Add a dark mode',
        actor: 'night-owl',
        actor_trust: 'other',
        state: 'dropped',
      }),
      event({ title: 'Old request', session_id: 'gone', received_at: NOW - 26 * 60 * MINUTE }),
      event({ title: 'No runtime', state: 'failed', error: 'Runtime absent not available' }),
    ],
    ...fields,
  } satisfies ExternalRead,
});

const bridge = {
  queries: [] as { method: string; params: Record<string, string> }[],
  answers: [] as BridgeResult<unknown>[],
  commands: [] as Command[],
  commandAnswers: [] as BridgeResult<unknown>[],
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    return bridge.answers.shift() ?? read({ events: [] });
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswers.shift() ?? { ok: true, value: {} };
  },
};
const sent = () =>
  bridge.commands.map(({ type, input, expected_revision }) => ({
    type,
    input,
    expected_revision,
  }));

const openProjectSession = vi.fn();
const shell = useShell.getState();
const external = (id: string, values?: Record<string, string>) =>
  t({ id: `settings.external.${id}`, defaultMessage: '' }, values);

async function mount() {
  const h = host(() => ExternalPage({ project }));
  await h.flush();
  h.render();
  return h;
}
const all = (h: HookHost<any>) => nodes(h.value as ReactElement);
const rows = (h: HookHost<any>) => all(h).filter((n) => n.props.role === 'listitem');
const cells = (row: ReactElement<any>) =>
  (row.props.children as ReactElement<any>[]).filter(Boolean).map(text);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  project = { id: `alpha-${++made}`, revision: 4, name: 'Alpha app', roots: ['/work/alpha'] };
  bridge.queries = [];
  bridge.answers = [];
  bridge.commands = [];
  bridge.commandAnswers = [];
  vi.stubGlobal('window', { pantheon: bridge });
  const session = (id: string, fields: object) => ({
    id,
    revision: 1,
    project_id: project.id,
    runtime: 'claude',
    title: 'Totals are wrong',
    ...fields,
  });
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [project],
      sessions: [
        session('held', { state: 'open', external_hold: true }),
        session('working', { state: 'running', title: 'Sign callbacks' }),
      ],
    },
    status: { state: 'live' },
  } as never);
  useSettingsView.setState({ open: true, page: 'external' as never });
  useShell.setState({ openProjectSession });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useBoard.setState({ board: null });
  useShell.setState(shell);
  useSettingsView.setState({ open: false, page: 'general' });
  openProjectSession.mockReset();
});

describe('external requests settings page', () => {
  it('sits among the pages for every project after usage, named External requests', () => {
    const keys = SETTINGS_PAGES.filter((p) => p.group === 'global').map((p) => p.key);
    expect(keys.slice(0, 4)).toEqual(['workflow', 'defaults', 'usage', 'external']);
    expect(SETTINGS_PAGES.find((p) => p.key === ('external' as never))!.label).toBe(
      zh('settings.pages.external'),
    );
  });

  it('reads how the project takes requests', async () => {
    await mount();
    expect(bridge.queries).toEqual([
      { method: 'external.read', params: { project_id: project.id } },
    ]);
  });

  it.each([
    {
      what: 'answered a minute ago',
      source: { polled_at: NOW - MINUTE },
      s: 'ok',
      shown: external('checked', { age: '1 分钟' }),
    },
    {
      what: 'failed',
      source: { error: 'gh: not logged in' },
      s: 'bad',
      shown: 'gh: not logged in',
    },
    { what: 'was never asked', source: {}, s: 'idle', shown: external('neverChecked') },
  ])('shows a source that $what', async ({ source, s, shown }) => {
    bridge.answers = [read({ sources: [{ id: 'github', ...source }], events: [] })];
    const h = await mount();
    const row = find(h.value, (n) => n.props.className === 'xr-src');
    expect(text(find(row, (n) => n.type === 'b'))).toBe('GitHub');
    const status = find(row, (n) => n.props.className === 'hp-st');
    expect(find(status, (n) => n.props['data-s'] !== undefined).props['data-s']).toBe(s);
    expect(text(status)).toBe(shown);
  });

  it.each([
    { stored: 'approve', value: 'approve' },
    { stored: 'auto', value: 'auto' },
    { stored: undefined, value: 'off' },
  ] as const)('selects $value when the project has $stored', async ({ stored, value }) => {
    const { mode: _mode, ...rest } = (read({ events: [] }) as { value: ExternalRead }).value;
    bridge.answers = [{ ok: true, value: stored ? { ...rest, mode: stored } : rest }];
    const h = await mount();
    const group = find(h.value, (n) => n.type === RadioGroup);
    expect(group.props.value).toBe(value);
    expect(group.props['aria-label']).toBe(external('mode', { source: 'GitHub' }));
    expect(
      nodes(group)
        .filter((n) => n.props.value !== undefined && n !== group)
        .map(text),
    ).toEqual([external('off'), external('ask'), external('auto')]);
  });

  it('sends the mode the user picks and reads the page again', async () => {
    const h = await mount();
    find(h.value, (n) => n.type === RadioGroup).props.onValueChange('auto');
    await h.flush();
    expect(sent()).toEqual([
      {
        type: 'project.externalEvents.set',
        input: { project_id: project.id, mode: 'auto' },
        expected_revision: 4,
      },
    ]);
    expect(bridge.queries).toHaveLength(2);
  });

  it('shows why the mode was not saved', async () => {
    bridge.commandAnswers = [
      { ok: false, error: { code: 'revision_conflict', message: 'Project changed' } },
    ];
    const h = await mount();
    find(h.value, (n) => n.type === RadioGroup).props.onValueChange('off');
    await h.flush();
    h.render();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(
      'revision_conflict：Project changed',
    );
  });

  it('lists each request with who raised it, what became of it and when', async () => {
    bridge.answers = [read()];
    const h = await mount();
    const list = find(h.value, (n) => n.props.role === 'list');
    expect(list.props['aria-label']).toBe(external('requests'));
    const head = find(list, (n) => n.props.className === 'xr-row xr-hd');
    expect(
      nodes(head)
        .filter((n) => n.props.className === 'cap')
        .map(text),
    ).toEqual([external('request'), external('raisedBy'), external('outcome')]);
    expect(rows(h).map(cells)).toEqual([
      ['Totals are wrong', 'taylor', `${external('held')}${external('approve')}`, '2 分钟'],
      ['Sign callbacks', 'robin', external('working'), '18 分钟'],
      ['Roll this back?', 'robin', external('settling'), '2 分钟'],
      ['Bump lodash', 'dependabot', external('droppedBot'), '2 分钟'],
      ['Add a dark mode', 'night-owl', external('droppedOther'), '2 分钟'],
      ['Old request', 'taylor', zh('settings.permissions.sessionGone'), '1 天'],
      ['No runtime', 'taylor', 'Runtime absent not available', '2 分钟'],
    ]);
    expect(rows(h).map((row) => row.props['data-dropped'])).toEqual([
      undefined,
      undefined,
      undefined,
      true,
      true,
      undefined,
      undefined,
    ]);
  });

  it('approves a held request from its row and reads the page again', async () => {
    bridge.answers = [read()];
    const h = await mount();
    const approve = find(rows(h)[0]!, (n) => n.type === 'button');
    expect(approve.props['aria-label']).toBe(
      external('approveNamed', { title: 'Totals are wrong' }),
    );
    approve.props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      { type: 'external.approve', input: { session_id: 'held' }, expected_revision: null },
    ]);
    expect(bridge.queries).toHaveLength(2);
  });

  it('sends one command at a time, the mode and the approve button held until it answers', async () => {
    bridge.answers = [read(), read()];
    const answer = deferred<BridgeResult<unknown>>();
    const command = bridge.command;
    bridge.command = async (c) => {
      bridge.commands.push(c);
      return answer.promise;
    };
    try {
      const h = await mount();
      const group = () => find(h.value, (n) => n.type === RadioGroup);
      const approve = () => find(rows(h)[0]!, (n) => n.type === 'button');
      approve().props.onClick();
      approve().props.onClick();
      group().props.onValueChange('auto');
      await h.flush();
      h.render();
      expect(sent().map((c) => c.type)).toEqual(['external.approve']);
      expect(approve().props.disabled).toBe(true);
      expect(group().props.disabled).toBe(true);

      answer.resolve({ ok: true, value: {} });
      await h.flush();
      h.render();
      expect(approve().props.disabled).toBe(false);
      expect(group().props.disabled).toBe(false);
      expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    } finally {
      bridge.command = command;
    }
  });

  it('opens the lead that has a request and closes the settings', async () => {
    bridge.answers = [read()];
    const h = await mount();
    find(rows(h)[1]!, (n) => n.type === 'button').props.onClick();
    expect(openProjectSession).toHaveBeenCalledWith(project.id, 'working');
    expect(useSettingsView.getState().open).toBe(false);
  });

  it('says so when the project has received no request', async () => {
    const h = await mount();
    expect(find(h.value, (n) => n.type === EmptyState).props.title).toBe(external('empty'));
    expect(all(h).some((n) => n.props.role === 'list')).toBe(false);
  });
});
