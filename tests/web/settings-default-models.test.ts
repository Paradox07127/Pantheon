import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BridgeResult, RuntimeStatus } from '@pantheon/protocol';
import {
  type HookHost,
  deferred,
  find,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { t as format } from '@/i18n';
import { SessionDefaults } from '@/screens/settings/SessionDefaultsPage';
import { pageHeader } from '@/screens/settings/settings-header';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const saved = {
  ...project,
  session_defaults: {
    runtime: 'claude',
    permission_mode: 'ask',
    model: 'claude-opus',
    effort: 'high',
  },
};
const kept = {
  ...project,
  session_defaults: {
    ...saved.session_defaults,
    reviewer: { runtime: 'claude', model: 'claude-opus' },
    fallbacks: { lead: { runtime: 'claude', model: 'claude-sonnet' } },
  },
};
const bridge = {
  answers: {} as Record<string, unknown>,
  commandAnswer: (): Promise<BridgeResult<unknown>> =>
    Promise.resolve({ ok: true, value: { revision: 2 } }),
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.commandAnswer();
  },
};
const status = (runtime: string, extra: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
  runtime,
  enabled: true,
  installed: true,
  version: '2.1.312',
  min_version: '2.1.312',
  version_ok: true,
  auth: { state: 'ok', email: 'dev@example.com', plan: 'max' },
  checked_at: new Date().toISOString(),
  ...extra,
});
const model = (id: string) => ({
  id,
  label: id,
  efforts: ['low', 'high'],
  default_effort: 'low',
  default: false,
  permission_modes: [] as string[],
});

const roleModel = (role: string) =>
  format({ id: 'settings.defaults.roleModel', defaultMessage: '' }, { role });
const NEW_SESSIONS = zh('settings.defaults.newSessions');
const REVIEW = zh('settings.defaults.reviewer');
const REVIEWER_MODEL = roleModel(REVIEW);
const LEAD_MODEL = zh('settings.defaults.sameAsNew');
const fallbackOf = (role: string) =>
  format({ id: 'settings.defaults.fallbackOf', defaultMessage: '' }, { role });
const PERMISSION = zh('settings.defaults.permissionMode');
async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const role = (t: ReactNode, name: string) => nodes(t).filter((n) => n.props.role === name);
const menu = (h: HookHost<any>) => named(tree(h), 'ModelMenu');
const alerts = (t: ReactNode) => role(t, 'alert').map((n) => text(n));
const sections = (t: ReactNode) =>
  nodes(t).filter((n) => typeof n.type === 'function' && n.type.name === 'Section');
const section = (t: ReactNode, title: string) => sections(t).find((n) => n.props.title === title)!;
const rowNames = (t: ReactNode) =>
  nodes(t)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'Row')
    .map((n) => n.props.label);
/** The accessible names of the controls and the names of the rows. */
const names = (t: ReactNode): string[] =>
  nodes(t).flatMap((n) => [n.props['aria-label'], n.props.label].filter(Boolean));
const leadSwitch = (h: HookHost<any>) =>
  labelled(tree(h), zh('settings.defaults.sameModelForReviews'));
/** What the role chip labelled `label` draws: its menu, or the chip alone when it cannot be chosen. */
const open = (h: HookHost<any>, label: string) => {
  const chip = find(tree(h), (n) => n.props.label === label);
  return (chip.type as (props: unknown) => ReactElement<any>)(chip.props);
};
const choices = (menu: ReactNode) =>
  nodes(menu).filter((n) => typeof n.props.value === 'string' && !n.props.onChange);
const items = (menu: ReactNode) => choices(menu).map((n) => text(n));
const chosen = (menu: ReactElement<any>) => {
  const value = find(menu, (n) => typeof n.props.onChange === 'function').props.value;
  return choices(menu).find((n) => n.props.value === value)!;
};
const pick = (menu: ReactNode, label: string) =>
  find(menu, (n) => typeof n.props.onChange === 'function').props.onChange(
    choices(menu).find((n) => text(n) === label)!.props.value,
  );

beforeEach(() => {
  bridge.answers = {
    'runtime.status': [status('claude'), status('codex', { installed: false })],
    'runtime.models': [model('claude-opus'), model('claude-sonnet')],
  };
  bridge.commandAnswer = () => Promise.resolve({ ok: true, value: { revision: 2 } });
  bridge.commands = [];
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [saved], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('default models page', () => {
  it('shows a new sessions section and an outside review section, each with its rows', async () => {
    const h = await mount(() => SessionDefaults({ project: kept as never }));
    expect(sections(tree(h)).map((n) => n.props.title)).toEqual([NEW_SESSIONS, REVIEW]);
    expect(rowNames(section(tree(h), NEW_SESSIONS))).toEqual([
      zh('settings.defaults.model'),
      PERMISSION,
      zh('settings.defaults.fallback'),
    ]);
    expect(rowNames(section(tree(h), REVIEW))).toEqual([
      zh('settings.defaults.model'),
      zh('settings.defaults.fallback'),
      zh('settings.defaults.sameModelForReviews'),
    ]);
    expect(names(tree(h))).toEqual(
      expect.arrayContaining([fallbackOf(NEW_SESSIONS), REVIEWER_MODEL, fallbackOf(REVIEW)]),
    );
  });

  it('offers no writer choice and keeps the saved writer and fallbacks when it saves', async () => {
    const project = {
      ...kept,
      session_defaults: {
        ...kept.session_defaults,
        writer: { runtime: 'claude', model: 'claude-opus' },
        fallbacks: {
          lead: { runtime: 'claude', model: 'claude-sonnet' },
          writer: { runtime: 'claude', model: 'claude-opus' },
        },
      },
    };
    const h = await mount(() => SessionDefaults({ project: project as never }));
    const writer = format({ id: 'settings.defaults.writer', defaultMessage: 'Writing code' });
    expect(names(tree(h)).filter((name) => name.includes(writer))).toEqual([]);
    labelled(tree(h), PERMISSION).props.onValueChange('plan');
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { ...project.session_defaults, project_id: 'alpha', permission_mode: 'plan' },
    ]);
  });

  it("picks the lead's runtime in its model menu, with the installed runtimes and why one cannot start", async () => {
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    expect(menu(h).props.runtimes).toEqual(['claude']);
    expect(menu(h).props.unavailable).toEqual({ codex: zh('data.runtimeStatus.notInstalled') });
    expect(
      nodes(tree(h)).some((n) => n.props['aria-label'] === zh('settings.common.runtime')),
    ).toBe(false);
  });

  it('saves a new lead model at once, with no save button', async () => {
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    expect(
      nodes(tree(h)).some((n) => n.type === 'button' && text(n) === zh('settings.common.save')),
    ).toBe(false);
    menu(h).props.onChange({
      runtime: 'claude',
      backend: null,
      model: 'claude-sonnet',
      effort: 'low',
    });
    await h.flush();
    expect(bridge.commands).toEqual([
      expect.objectContaining({
        type: 'project.sessionDefaults.set',
        input: {
          project_id: 'alpha',
          runtime: 'claude',
          permission_mode: 'ask',
          model: 'claude-sonnet',
          effort: 'low',
        },
        expected_revision: 1,
      }),
    ]);
    expect(menu(h).props.value).toMatchObject({ model: 'claude-sonnet', effort: 'low' });
  });

  it('moves to a permission mode the new runtime offers when the lead changes runtime', async () => {
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    menu(h).props.onChange({ runtime: 'codex', backend: null, model: 'gpt-5', effort: null });
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      { project_id: 'alpha', runtime: 'codex', permission_mode: 'auto_edit', model: 'gpt-5' },
    ]);
  });

  it('saves the permission mode and the lead-model switch as soon as each changes', async () => {
    let shown: typeof saved = saved;
    const h = await mount(() => SessionDefaults({ project: shown as never }));
    labelled(tree(h), PERMISSION).props.onValueChange('plan');
    await h.flush();
    expect(bridge.commands.at(-1)!.input).toMatchObject({ permission_mode: 'plan' });
    shown = {
      ...saved,
      revision: 2,
      session_defaults: { ...saved.session_defaults, permission_mode: 'plan' },
    };
    h.render();
    leadSwitch(h).props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands.at(-1)).toMatchObject({
      input: { permission_mode: 'plan', single_model: true },
      expected_revision: 2,
    });
  });

  it("offers and keeps the permission modes of the runtime's default model while the lead has no model", async () => {
    bridge.answers['runtime.status'] = [status('claude'), status('codex')];
    bridge.answers['runtime.models'] = [
      model('gpt-other'),
      {
        ...model('gpt-default'),
        default: true,
        permission_modes: ['plan', 'auto_edit', 'full_access'],
      },
    ];
    // Its own project, so the models no earlier test read for it are read.
    const onCodex = {
      ...project,
      id: 'gamma',
      session_defaults: { runtime: 'codex', permission_mode: 'full_access' },
    };
    const h = await mount(() => SessionDefaults({ project: onCodex as never }));
    const modes = labelled(tree(h), PERMISSION);
    expect(modes.props.value).toBe('full_access');
    expect((modes.props.children as ReactElement<any>[]).map((n) => n.props.value)).toEqual([
      'plan',
      'auto_edit',
      'full_access',
    ]);
  });

  it('holds a change made while a save is on its way and sends it once the board shows the first', async () => {
    const first = deferred<BridgeResult<unknown>>();
    bridge.commandAnswer = () => first.promise;
    let shown: typeof saved = saved;
    const h = await mount(() => SessionDefaults({ project: shown as never }));
    labelled(tree(h), PERMISSION).props.onValueChange('plan');
    await h.flush();
    leadSwitch(h).props.onChange({ target: { checked: true } });
    await h.flush();
    expect(bridge.commands).toHaveLength(1);
    expect(leadSwitch(h).props.checked).toBe(true);
    first.resolve({ ok: true, value: { revision: 2 } });
    await h.flush();
    expect(bridge.commands).toHaveLength(1);
    bridge.commandAnswer = () => Promise.resolve({ ok: true, value: { revision: 3 } });
    shown = {
      ...saved,
      revision: 2,
      session_defaults: { ...saved.session_defaults, permission_mode: 'plan' },
    };
    h.render();
    await h.flush();
    expect(bridge.commands.at(-1)).toMatchObject({
      input: { permission_mode: 'plan', single_model: true },
      expected_revision: 2,
    });
  });

  it('names a failed save after the section and goes back to the saved choice', async () => {
    bridge.commandAnswer = () =>
      Promise.resolve({ ok: false, error: { code: 'conflict', message: 'stale revision' } });
    const h = await mount(() => SessionDefaults({ project: saved as never }));
    menu(h).props.onChange({
      runtime: 'claude',
      backend: null,
      model: 'claude-sonnet',
      effort: 'low',
    });
    await h.flush();
    expect(alerts(tree(h))).toHaveLength(1);
    expect(menu(h).props.value).toMatchObject({ model: 'claude-opus', effort: 'high' });
    expect(alerts(section(tree(h), NEW_SESSIONS))).toEqual([]);
  });

  it("offers the reviewer another runtime or a model, and only the new sessions' model while the switch is on", async () => {
    const off = await mount(() => SessionDefaults({ project: saved as never }));
    expect(text(chosen(open(off, REVIEWER_MODEL)))).toBe(zh('settings.defaults.otherRuntime'));
    expect(items(open(off, REVIEWER_MODEL))).toEqual([
      zh('settings.defaults.otherRuntime'),
      'claude-opus',
      'claude-sonnet',
    ]);
    const on = await mount(() =>
      SessionDefaults({
        project: {
          ...saved,
          session_defaults: { ...saved.session_defaults, single_model: true },
        } as never,
      }),
    );
    const chip = open(on, REVIEWER_MODEL);
    expect([text(chip), chip.props.disabled]).toEqual([LEAD_MODEL, true]);
  });

  it('sends the chosen reviewer model and keeps the fallbacks already saved', async () => {
    const h = await mount(() => SessionDefaults({ project: kept as never }));
    pick(open(h, REVIEWER_MODEL), 'claude-sonnet');
    await h.flush();
    expect(bridge.commands.map((c) => c.input)).toEqual([
      {
        ...kept.session_defaults,
        project_id: 'alpha',
        reviewer: { runtime: 'claude', model: 'claude-sonnet' },
      },
    ]);
  });

  it('sends a fallback for a role beside the ones already saved', async () => {
    const h = await mount(() => SessionDefaults({ project: kept as never }));
    expect(text(chosen(open(h, fallbackOf(NEW_SESSIONS))))).toBe('claude-sonnet');
    expect(text(chosen(open(h, fallbackOf(REVIEW))))).toBe(zh('settings.defaults.noFallback'));
    pick(open(h, fallbackOf(REVIEW)), 'claude-opus');
    await h.flush();
    expect(bridge.commands.at(-1)!.input.fallbacks).toEqual({
      lead: { runtime: 'claude', model: 'claude-sonnet' },
      reviewer: { runtime: 'claude', model: 'claude-opus' },
    });
  });

  it("lists the projects with their own defaults from the header, each set on that project's page", async () => {
    const Tools = pageHeader('defaults').tools as () => ReactElement<any>;
    const h = host(() => Tools());
    await h.flush();
    expect(h.value.props).toMatchObject({
      setting: 'session_defaults',
      name: zh('settings.pages.defaults'),
    });
    const editor = h.value.props.editor(saved) as ReactElement<any>;
    expect(editor.type).toBe(SessionDefaults);
    expect(editor.props.project).toBe(saved);
  });
});
