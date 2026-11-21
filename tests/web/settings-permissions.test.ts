import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BridgeResult, ProjectPermissionRule } from '@pantheon/protocol';
import { HookHost, find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { EmptyState } from '@/components/EmptyState';
import { RuntimeGlyph } from '@/components/RuntimeGlyph';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { PermissionsPage } from '@/screens/settings/PermissionsPage';
import { hitGroups } from '@/screens/settings/settings-jump';
import { SETTINGS_INDEX } from '@/screens/settings/settings-index';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

type Project = Parameters<typeof PermissionsPage>[0]['project'];
type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const at = (month: number, day: number, hour: number, minute: number) =>
  new Date(2026, month, day, hour, minute).getTime();

const RULES: ProjectPermissionRule[] = [
  {
    rule: 'Bash(pnpm test:*)',
    session_id: 'live',
    session_title: 'Sign callbacks',
    added_at: at(10, 13, 9, 42),
  },
  {
    rule: 'Bash(git diff:*)',
    session_id: 'ended',
    session_title: 'Idempotency store',
    added_at: at(10, 12, 17, 20),
  },
  { rule: 'WebFetch(domain:docs.example.com)', session_id: 'gone', added_at: at(10, 11, 8, 0) },
];

let made = 0;
let project: Project;
const bridge = {
  queries: [] as { method: string; params: Record<string, string> }[],
  answers: [] as BridgeResult<unknown>[],
  commands: [] as Command[],
  commandAnswers: [] as BridgeResult<unknown>[],
  async query(method: string, params: Record<string, string>): Promise<BridgeResult<unknown>> {
    bridge.queries.push({ method, params });
    return bridge.answers.shift() ?? { ok: true, value: [] };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswers.shift() ?? { ok: true, value: {} };
  },
};

const openProjectSession = vi.fn();
const openSessionGroup = vi.fn();
const shell = useShell.getState();
const say = (id: string) => zh(`settings.permissions.${id}`);
const removeRule = (rule: string) =>
  t({ id: 'settings.permissions.removeRule', defaultMessage: 'Remove rule {rule}' }, { rule });

async function mount() {
  const h = host(() => PermissionsPage({ project }));
  await h.flush();
  h.render();
  return h;
}
const all = (h: HookHost<any>) => nodes(h.value as ReactElement);
const rows = (h: HookHost<any>) => all(h).filter((n) => n.props.role === 'listitem');
const button = (h: HookHost<any>, label: string) =>
  find(
    h.value,
    (n) => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label),
  );
const dialogOpen = (h: HookHost<any>) =>
  all(h).find((n) => typeof n.props.open === 'boolean')!.props.open as boolean;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  project = { id: `alpha-${++made}`, revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
  bridge.queries = [];
  bridge.answers = [];
  bridge.commands = [];
  bridge.commandAnswers = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [project],
      sessions: [
        {
          id: 'live',
          project_id: project.id,
          runtime: 'claude',
          state: 'open',
          title: 'Sign callbacks',
        },
        {
          id: 'ended',
          project_id: project.id,
          runtime: 'codex',
          state: 'closed',
          title: 'Idempotency store',
        },
      ],
    },
    status: { state: 'live' },
  } as never);
  useSettingsView.setState({ open: true, page: 'permissions' as never });
  useShell.setState({ openProjectSession, openSessionGroup });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useBoard.setState({ board: null });
  useShell.setState(shell);
  useSettingsView.setState({ open: false, page: 'general' });
  openProjectSession.mockReset();
  openSessionGroup.mockReset();
});

describe('permissions settings page', () => {
  it('sits among the pages for every project after external requests, named Permissions', () => {
    const keys = SETTINGS_PAGES.filter((p) => p.group === 'global').map((p) => p.key);
    expect(keys.slice(2, 4)).toEqual(['external', 'permissions']);
    expect(SETTINGS_PAGES.find((p) => p.key === ('permissions' as never))!.label).toBe(
      zh('settings.pages.permissions'),
    );
  });

  it("reads the project's rules", async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    await mount();
    expect(bridge.queries).toEqual([
      { method: 'permission.rules', params: { project_id: project.id } },
    ]);
  });

  it('heads the table with where the rules come from and how many there are', async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    const h = await mount();
    const top = find(h.value, (n) => n.props.className === 'pm-top');
    expect(
      nodes(top)
        .map((n) => [n.props.className, text(n)])
        .slice(1),
    ).toEqual([
      ['cap', say('chosenOn')],
      ['chip', zh('sessions.card.allowProject')],
      ['mu pm-n', '3 条'],
    ]);
  });

  it('lists each rule with its source session, when it was added and a delete button', async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    const h = await mount();
    const list = find(h.value, (n) => n.props.role === 'list');
    expect(list.props['aria-label']).toBe(say('rules'));
    const head = find(list, (n) => n.props.className === 'pm-row pm-hd');
    expect(
      nodes(head)
        .filter((n) => n.props.className === 'cap')
        .map(text),
    ).toEqual([say('rule'), say('fromSession'), say('added')]);
    const cells = rows(h).map((r) => {
      const kids = (r.props.children as ReactElement<any>[]).filter(Boolean);
      return kids.map((k) => (k.type === 'button' && k.props['aria-label']) || text(k));
    });
    expect(cells).toEqual([
      ['Bash(pnpm test:*)', 'Sign callbacks', '09:42', removeRule('Bash(pnpm test:*)')],
      ['Bash(git diff:*)', 'Idempotency store', '昨天 17:20', removeRule('Bash(git diff:*)')],
      [
        'WebFetch(domain:docs.example.com)',
        say('sessionGone'),
        '11月11日 08:00',
        removeRule('WebFetch(domain:docs.example.com)'),
      ],
    ]);
    const rule = find(rows(h)[0]!, (n) => n.props.className === 'mono pm-rule');
    expect(rule.props.title).toBe('Bash(pnpm test:*)');
  });

  it('opens a live source session and closes the settings', async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    const h = await mount();
    const link = find(rows(h)[0]!, (n) => n.props.className === 'pm-src');
    expect(link.type).toBe('button');
    expect(find(link, (n) => n.type === RuntimeGlyph).props.runtime).toBe('claude');
    link.props.onClick();
    expect(openProjectSession).toHaveBeenCalledWith(project.id, 'live');
    expect(useSettingsView.getState().open).toBe(false);
  });

  it('shows an ended or missing session muted and not clickable', async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    const h = await mount();
    for (const row of rows(h).slice(1)) {
      const source = find(row, (n) => n.props.className === 'pm-src mu');
      expect(source.type).toBe('span');
      expect(source.props.onClick).toBeUndefined();
    }
    expect(find(rows(h)[1]!, (n) => n.type === RuntimeGlyph).props.runtime).toBe('codex');
  });

  it('asks before deleting, naming the rule and what happens next', async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    const h = await mount();
    expect(dialogOpen(h)).toBe(false);
    button(h, removeRule('Bash(pnpm test:*)')).props.onClick();
    h.render();
    expect(dialogOpen(h)).toBe(true);
    expect(bridge.commands).toEqual([]);
    const shown = text(h.value as ReactElement);
    expect(shown).toContain(removeRule('Bash(pnpm test:*)'));
    expect(shown).toContain(say('removeBody'));
  });

  it('deletes the rule once confirmed and reads the list again', async () => {
    bridge.answers = [
      { ok: true, value: RULES },
      { ok: true, value: RULES.slice(1) },
    ];
    const h = await mount();
    button(h, removeRule('Bash(pnpm test:*)')).props.onClick();
    h.render();
    button(h, say('remove')).props.onClick();
    await h.flush();
    h.render();
    expect(
      bridge.commands.map(({ type, input, expected_revision }) => ({
        type,
        input,
        expected_revision,
      })),
    ).toEqual([
      {
        type: 'permission.rule.remove',
        input: { project_id: project.id, rule: 'Bash(pnpm test:*)' },
        expected_revision: null,
      },
    ]);
    expect(bridge.queries).toHaveLength(2);
    expect(dialogOpen(h)).toBe(false);
    expect(rows(h).map((r) => text(find(r, (n) => n.props.className === 'mono pm-rule')))).toEqual([
      'Bash(git diff:*)',
      'WebFetch(domain:docs.example.com)',
    ]);
  });

  it('keeps the dialog open with the refusal when the delete fails', async () => {
    bridge.answers = [{ ok: true, value: RULES }];
    bridge.commandAnswers = [{ ok: false, error: { code: 'permission_denied', message: 'no' } }];
    const h = await mount();
    button(h, removeRule('Bash(pnpm test:*)')).props.onClick();
    h.render();
    button(h, say('remove')).props.onClick();
    await h.flush();
    h.render();
    expect(dialogOpen(h)).toBe(true);
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('no');
  });

  it('shows the empty state, whose button lists the waiting sessions and closes the settings', async () => {
    const h = await mount();
    expect(rows(h)).toEqual([]);
    const empty = find(h.value, (n) => n.type === EmptyState);
    expect(empty.props.title).toBe(say('empty'));
    const go = empty.props.action;
    expect(go.label).toBe(say('goWaiting'));
    expect(go.keys).toBeUndefined();
    go.onClick();
    expect(useSettingsView.getState().open).toBe(false);
    expect(useCurrentProject.getState().projectId).toBe(project.id);
    expect(openSessionGroup).toHaveBeenCalledWith('inbox');
  });

  it('shows a failed read in the page with a retry', async () => {
    bridge.answers = [
      { ok: false, error: { code: 'ipc_failed', message: 'socket closed' } },
      { ok: true, value: RULES },
    ];
    const h = await mount();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('socket closed');
    button(h, zh('components.retry')).props.onClick();
    h.render();
    await h.flush();
    h.render();
    expect(bridge.queries).toHaveLength(2);
    expect(rows(h)).toHaveLength(3);
  });
});

describe('searching for permissions', () => {
  it('lands on the permissions page for its name and for rules', () => {
    expect(hitGroups('权限')[0]!.page).toBe('permissions');
    expect(hitGroups('规则')[0]!.page).toBe('permissions');
    expect(hitGroups('permissions')[0]!.page).toBe('permissions');
  });

  it('indexes the rule table under the permissions page', () => {
    expect(
      SETTINGS_INDEX.filter((r) => r.page === ('permissions' as never)).map((r) => r.id),
    ).toEqual(['permissions.page', 'permissions.rules']);
  });
});
