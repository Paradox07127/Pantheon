import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeModel } from '@pantheon/protocol';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { find, HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { ModelMenu, type ModelChoice } from '@/screens/sessions/parts';
import { supersededModels } from '@/screens/sessions/ModelMenu';
import { useSettingsView } from '@/screens/settings/view';
import { zh, zhf } from './i18n-setup.js';

const model = (id: string): RuntimeModel => ({
  id,
  label: `label of ${id}`,
  permission_modes: ['plan', 'ask', 'auto_edit'],
  efforts: ['low', 'high'],
  default_effort: 'low',
  default: false,
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const onClaude: ModelChoice = { runtime: 'claude', backend: null, model: 'opus', effort: 'low' };

function menu(props: Partial<Parameters<typeof ModelMenu>[0]> = {}) {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  return mount(() =>
    ModelMenu({
      runtimes: ['claude', 'codex', 'gemini'],
      models: {
        claude: { state: 'ready', models: [model('opus'), model('sonnet')] },
        codex: { state: 'loading' },
        gemini: { state: 'ready', models: [model('gemini-pro')] },
      },
      value: onClaude,
      onChange: vi.fn(),
      mode: 'ask',
      unavailable: { gemini: '未安装' },
      ...props,
    }),
  );
}

const runtimeRow = (h: HookHost<any>, runtime: string) =>
  find(
    find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.runtime')),
    (n) => n.props.value === runtime && typeof n.props.onClick === 'function',
  );
const count = (row: any) => nodes(row).find((n) => n.props.className === 'cp-mmn');

const toggle = (h: HookHost<any>, label: string) =>
  find(h.value, (n) => n.props['aria-expanded'] !== undefined && text(n).includes(label));
const press = (h: HookHost<any>, label: string) => {
  toggle(h, label).props.onClick();
  h.render();
};

describe('session model menu', () => {
  it('ends each provider row with its model count, or why it cannot start', () => {
    const h = menu();
    expect(text(count(runtimeRow(h, 'claude')))).toBe('2');
    // The list is still being read: no count yet.
    expect(count(runtimeRow(h, 'codex'))).toBeUndefined();
    expect(text(count(runtimeRow(h, 'gemini')))).toBe('未安装');
  });

  it('folds the runtimes that are not connected under the others until asked', () => {
    const h = menu({
      unavailable: { codex: '写隔离未验证', gemini: '未登录' },
      disconnected: ['gemini'],
    });
    const runtimes = () =>
      nodes(find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.runtime')))
        .filter((n) => typeof n.props.onClick === 'function' && typeof n.props.value === 'string')
        .map((n) => n.props.value);
    expect(runtimes()).toEqual(['claude', 'codex']);
    expect(text(runtimeRow(h, 'codex'))).toContain('写隔离未验证');
    const notConnected = zh('sessions.composer.runtimeNotConnected');
    expect(toggle(h, notConnected).props['aria-expanded']).toBe(false);
    press(h, notConnected);
    expect(toggle(h, notConnected).props['aria-expanded']).toBe(true);
    expect(runtimes()).toEqual(['claude', 'codex', 'gemini']);
    expect(runtimeRow(h, 'gemini').props.disabled).toBe(true);
  });

  it('opens the connections page of the settings from add provider', () => {
    const h = menu();
    const left = find(h.value, (n) => n.props.className === 'cp-mml');
    const add = find(
      left,
      (n) =>
        text(n) === zh('sessions.composer.addProvider') && typeof n.props.onClick === 'function',
    );
    add.props.onClick();
    expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'connections' });
  });

  it('says a model change keeps the context only inside a session', () => {
    const footnote = zh('sessions.composer.sameProviderKeepsContext');
    expect(text(menu({ inSession: true }).value)).toContain(footnote);
    expect(text(menu().value)).not.toContain(footnote);
  });

  it('keeps the providers on the left and the models and settings on the right', () => {
    const h = menu({ runtimes: ['claude'] });
    const left = find(h.value, (n) => n.props.className === 'cp-mml');
    const right = find(h.value, (n) => n.props.className === 'cp-mmr');
    expect(nodes(left).some((n) => n.props['aria-label'] === zh('sessions.composer.runtime'))).toBe(
      true,
    );
    expect(nodes(left).some((n) => n.props['aria-label'] === zh('sessions.composer.model'))).toBe(
      false,
    );
    const halves = nodes(right).filter((n) => ['cp-mmt', 'cp-mmb'].includes(n.props.className));
    expect(halves.map((n) => n.props.className)).toEqual(['cp-mmt', 'cp-mmb']);
    expect(
      nodes(halves[0]).some((n) => n.props['aria-label'] === zh('sessions.composer.model')),
    ).toBe(true);
    expect(
      nodes(halves[1]).some((n) => n.props['aria-label'] === zh('sessions.composer.effort')),
    ).toBe(true);
    expect(
      nodes(halves[1]).some(
        (n) => n.props['aria-label'] === zh('sessions.composer.permissionMode'),
      ),
    ).toBe(true);
  });
});

describe('session model menu groups', () => {
  const values = (tree: any) =>
    nodes(tree)
      .filter((n) => n.props.closeOnClick === true)
      .map((n) => n.props.value);
  const more = (h: HookHost<any>) =>
    nodes(h.value).find(
      (n) =>
        n.type === Menu.SubmenuRoot &&
        nodes(n).some(
          (t) => t.type === Menu.SubmenuTrigger && text(t) === zh('sessions.composer.moreModels'),
        ),
    );
  /** The models on the menu itself, outside more models. */
  const shown = (h: HookHost<any>) => {
    const inMore = new Set(values(more(h)));
    return values(
      find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.model')),
    ).filter((id) => !inMore.has(id));
  };
  const onList = (ids: string[], props: Partial<Parameters<typeof ModelMenu>[0]> = {}) =>
    menu({
      runtimes: ['claude'],
      models: { claude: { state: 'ready', models: ids.map(model) } },
      ...props,
    });
  const claude = [
    'claude-opus-5-5',
    'claude-fable-5-2',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-haiku-4-5',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
    'claude-opus-4-8',
  ];

  it.each([
    {
      name: 'a newest model',
      chosen: 'claude-opus-5-5',
      top: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
      older: [
        'claude-fable-5-1',
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-fable-5',
        'claude-opus-4-8',
        'claude-haiku-4-5',
      ],
    },
    {
      name: 'a replaced model',
      chosen: 'claude-opus-4-8',
      top: [
        'claude-opus-5-5',
        'claude-fable-5-2',
        'claude-sonnet-5-5',
        'claude-haiku-5-5',
        'claude-opus-4-8',
      ],
      older: [
        'claude-fable-5-1',
        'claude-sonnet-5',
        'claude-opus-5',
        'claude-fable-5',
        'claude-haiku-4-5',
      ],
    },
  ])(
    'lists the newest model of each family and the chosen one on $name, the replaced ones newest first under more models',
    ({ chosen, top, older }) => {
      const h = onList(claude, { value: { ...onClaude, model: chosen } });
      expect(shown(h)).toEqual(top);
      expect(values(more(h))).toEqual(older);
    },
  );

  it('offers no more models when no listed model is replaced', () => {
    const h = onList(['opus', 'sonnet', 'haiku', 'fable']);
    expect(shown(h)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    expect(more(h)).toBeUndefined();
  });

  it("keeps the runtime's default model of a session without a model on the menu itself", () => {
    const h = menu({
      runtimes: ['claude'],
      models: {
        claude: {
          state: 'ready',
          models: [model('claude-opus-5'), { ...model('claude-opus-4-8'), default: true }],
        },
      },
      value: { ...onClaude, model: null },
    });
    expect(shown(h)).toEqual(['claude-opus-5', 'claude-opus-4-8']);
    expect(more(h)).toBeUndefined();
  });

  it('takes a model as replaced only by a newer version of the same family', () => {
    expect(
      [
        ...supersededModels([
          'claude-opus-4-1-20250805',
          'claude-opus-4-5',
          'claude-3-5-haiku-20241022',
          'claude-haiku-4-5',
          'gpt-5-codex',
          'gpt-5.1-codex',
          'gpt-5.2-codex',
          'gpt-5-codex-mini',
          'gpt-5-2025-08-07',
          'gpt-5.1',
          'gemini-2.5-pro',
          'gemini-3-pro-preview',
          'opus',
          'gpt-4o',
          'o3',
        ]),
      ].sort(),
    ).toEqual(['claude-opus-4-1-20250805', 'gpt-5-2025-08-07', 'gpt-5-codex', 'gpt-5.1-codex']);
  });
});

describe('session model menu capabilities', () => {
  const onModels = (models: RuntimeModel[], props: Partial<Parameters<typeof ModelMenu>[0]> = {}) =>
    menu({ models: { claude: { state: 'ready', models } }, runtimes: ['claude'], ...props });
  const modeItems = (h: HookHost<any>) =>
    nodes(find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.permissionMode')))
      .filter((n) => n.props.className === 'cp-sgi')
      .map((n) => [n.props.value, text(n)]);
  const fastItem = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props['aria-label'] === zh('sessions.composer.fastMode'));
  const oneMode = zh('sessions.composer.onePermissionMode');

  it('shows the description of a model after its name, and the whole of it on hover', () => {
    const h = onModels([{ ...model('opus'), description: 'Most capable for complex work' }]);
    const row = find(h.value, (n) => n.props.value === 'opus' && n.props.onClick);
    const shown = find(row, (n) => n.props.className === 'cp-mmd');
    expect(text(shown)).toBe('Most capable for complex work');
    const tip = find(h.value, (n) => n.props.content === 'Most capable for complex work');
    expect(tip.props.children).toBe(row);
  });

  it("names the runtime's default model row in the interface language, in its row and on the button", () => {
    const h = onModels([{ ...model('default'), label: 'Default (recommended)', default: true }], {
      value: { ...onClaude, model: 'default' },
    });
    const row = find(h.value, (n) => n.props.value === 'default' && n.props.onClick);
    expect(text(row)).toBe(zh('sessions.composer.defaultModel'));
    expect(text(h.value)).not.toContain('Default (recommended)');
    expect(
      nodes(h.value).filter((n) =>
        String(n.props['aria-label'] ?? '').includes('Default (recommended)'),
      ),
    ).toEqual([]);
  });

  const button = (h: HookHost<any>) =>
    find(h.value, (n) => n.props.className === 'cp-mdl' && n.props['aria-label'] !== undefined);
  const claude = [
    {
      ...model('default'),
      label: 'Default (recommended)',
      default: true,
      resolved: 'claude-opus-5-5',
      default_effort: 'high' as const,
    },
    { ...model('opus'), label: 'Opus 5.5', resolved: 'claude-opus-5-5' },
    { ...model('sonnet'), label: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' },
  ];
  const high = zh('sessions.model.effort.high');

  it.each<[string, Partial<ModelChoice>, string | null, string]>([
    ['the default row', { model: 'default', effort: null }, null, 'Opus 5.5'],
    ['no model', { model: null, effort: null }, null, 'Opus 5.5'],
    [
      'no model and a reported one',
      { model: null, effort: null },
      'claude-sonnet-5-5',
      'Sonnet 5.5',
    ],
  ])(
    'names the model and effort a session on %s runs, on the button and in its name',
    (_, choice, reported, name) => {
      const h = onModels(claude, { value: { ...onClaude, ...choice }, reported });
      expect(text(find(button(h), (n) => n.props.className === 'cp-mdn'))).toBe(name);
      expect(text(button(h))).toContain(high);
      expect(button(h).props['aria-label']).toContain(`${name}，${high}`);
    },
  );

  it('names the model the default row resolves to in its row', () => {
    const h = onModels(claude, { value: { ...onClaude, model: 'default' } });
    const row = find(h.value, (n) => n.props.value === 'default' && n.props.onClick);
    expect(text(row)).toBe(zhf('sessions.composer.defaultModelNamed', { model: 'Opus 5.5' }));
  });

  it("offers the picked model's permission modes, else the runtime's when it lists none", () => {
    const listed = onModels([
      { ...model('opus'), permission_modes: ['plan', 'ask', 'auto_edit', 'auto'] },
    ]);
    expect(modeItems(listed)).toEqual([
      ['plan', zh('sessions.model.mode.plan')],
      ['ask', zh('sessions.model.mode.ask')],
      ['auto_edit', zh('sessions.model.mode.autoEdit')],
      ['auto', zh('sessions.model.mode.auto')],
    ]);
    const none = onModels([{ ...model('opus'), permission_modes: [] }]);
    expect(modeItems(none).map(([value]) => value)).toEqual(['ask', 'auto_edit', 'plan']);
  });

  it("names Codex's modes by its sandbox", () => {
    const h = menu({
      runtimes: ['codex'],
      models: {
        codex: {
          state: 'ready',
          models: [{ ...model('gpt'), permission_modes: ['plan', 'auto_edit', 'full_access'] }],
        },
      },
      value: { runtime: 'codex', backend: null, model: 'gpt', effort: null },
      mode: 'auto_edit',
    });
    expect(modeItems(h)).toEqual([
      ['plan', zh('components.runtime.codexReadOnly')],
      ['auto_edit', zh('components.runtime.codexWorkspaceWrite')],
      ['full_access', zh('sessions.model.mode.fullAccess')],
    ]);
  });

  it('offers a Codex session without a listed model the modes and fast mode of its default model', () => {
    const gpt: RuntimeModel = {
      ...model('gpt-default'),
      permission_modes: ['plan', 'auto_edit', 'full_access'],
      fast: true,
      default: true,
    };
    for (const chosen of [null, 'gpt-retired']) {
      const h = menu({
        runtimes: ['codex'],
        models: { codex: { state: 'ready', models: [model('gpt-other'), gpt] } },
        value: { runtime: 'codex', backend: null, model: chosen, effort: null },
        mode: 'auto_edit',
        fast: { on: false },
      });
      expect(modeItems(h).map(([value]) => value)).toEqual(['plan', 'auto_edit', 'full_access']);
      expect(fastItem(h)).toBeDefined();
    }
  });

  it('says when the connection reports a single permission mode', () => {
    expect(text(onModels([{ ...model('opus'), permission_modes: ['ask'] }]).value)).toContain(
      oneMode,
    );
    expect(text(onModels([model('opus')]).value)).not.toContain(oneMode);
    const both = onModels([{ ...model('opus'), permission_modes: ['ask'] }], { inSession: true });
    const notes = nodes(both.value).filter((n) => n.props.className === 'cp-mmf');
    expect(notes.map(text)).toEqual([oneMode, zh('sessions.composer.sameProviderKeepsContext')]);
  });

  it('offers the fast mode switch only for a model with fast mode when the caller gives one', () => {
    const fast = { ...model('opus'), fast: true as const };
    expect(fastItem(onModels([fast], { fast: { on: false } }))).toBeDefined();
    expect(fastItem(onModels([fast]))).toBeUndefined();
    expect(fastItem(onModels([model('opus')], { fast: { on: false } }))).toBeUndefined();
  });

  it.each([
    {
      name: 'a reasoning effort',
      group: 'sessions.composer.effort',
      value: 'high',
      heard: 'onChange' as const,
      with: { ...onClaude, effort: 'high' },
    },
    {
      name: 'a permission mode',
      group: 'sessions.composer.permissionMode',
      value: 'plan',
      heard: 'onMode' as const,
      with: 'plan',
    },
  ])('keeps the menu open after picking $name', ({ group, value, heard, with: given }) => {
    const calls = { onChange: vi.fn(), onMode: vi.fn() };
    const h = menu(calls);
    const root = () => h.value as any;
    root().props.onOpenChange(true);
    h.render();
    const item = find(
      find(h.value, (n) => n.props['aria-label'] === zh(group)),
      (n) => n.props.value === value && typeof n.props.onClick === 'function',
    );
    expect(item.props.closeOnClick).toBe(false);
    item.props.onClick();
    h.render();
    expect(calls[heard]).toHaveBeenCalledWith(given);
    expect(root().props.open).toBe(true);
  });

  it('closes only itself on Escape, before a dialog or composer under it hears the key', () => {
    const h = menu();
    const listeners: { type: string; listener: (e: any) => void; capture: unknown }[] = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (e: any) => void, capture: unknown) =>
        listeners.push({ type, listener, capture }),
      removeEventListener: (type: string, listener: (e: any) => void) =>
        listeners.splice(
          listeners.findIndex((l) => l.type === type && l.listener === listener),
          1,
        ),
    });
    const root = () => h.value as any;
    root().props.onOpenChange(true);
    h.render();
    const keys = () => listeners.filter((l) => l.type === 'keydown');
    expect(keys().map((l) => l.capture)).toEqual([true]);
    const press = (key: string) => {
      const e = { key, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      keys()[0]!.listener(e);
      h.render();
      return e;
    };
    expect(press('ArrowDown').stopPropagation).not.toHaveBeenCalled();
    expect(root().props.open).toBe(true);
    const escape = press('Escape');
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(root().props.open).toBe(false);
    expect(keys()).toEqual([]);
  });

  it('lists the reasoning efforts the picked model reports', () => {
    const h = onModels([{ ...model('opus'), efforts: ['low', 'max', 'ultra'] }]);
    expect(
      nodes(find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.effort')))
        .filter((n) => n.props.className === 'cp-sgi')
        .map((n) => [n.props.value, text(n)]),
    ).toEqual([
      ['low', zh('sessions.model.effort.low')],
      ['max', zh('sessions.model.effort.max')],
      ['ultra', zh('sessions.model.effort.ultra')],
    ]);
  });

  const ultracodeItem = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props['aria-label'] === zh('sessions.composer.ultracode'));

  it('offers the ultracode switch only on Claude when the caller gives one', () => {
    expect(ultracodeItem(onModels([model('opus')], { ultracode: false }))).toBeDefined();
    expect(ultracodeItem(onModels([model('opus')]))).toBeUndefined();
    const codex = menu({
      runtimes: ['codex'],
      models: { codex: { state: 'ready', models: [model('gpt')] } },
      value: { runtime: 'codex', backend: null, model: 'gpt', effort: null },
      ultracode: false,
    });
    expect(ultracodeItem(codex)).toBeUndefined();
  });

  it('turns ultracode on from the switch while the menu stays open', () => {
    const onUltracode = vi.fn();
    const h = onModels([model('opus')], { ultracode: false, onUltracode });
    const root = () => h.value as any;
    root().props.onOpenChange(true);
    h.render();
    const item = ultracodeItem(h)!;
    expect(item.props.checked).toBe(false);
    expect(item.props.closeOnClick).toBe(false);
    item.props.onCheckedChange(true);
    h.render();
    expect(onUltracode).toHaveBeenCalledWith(true);
    expect(root().props.open).toBe(true);
  });

  it('turns fast mode on from the switch while the menu stays open', () => {
    const onFast = vi.fn();
    const h = onModels([{ ...model('opus'), fast: true }], { fast: { on: false }, onFast });
    const root = () => h.value as any;
    root().props.onOpenChange(true);
    h.render();
    const item = fastItem(h)!;
    expect(item.props.checked).toBe(false);
    expect(item.props.closeOnClick).toBe(false);
    item.props.onCheckedChange(true);
    h.render();
    expect(onFast).toHaveBeenCalledWith(true);
    expect(root().props.open).toBe(true);
  });

  it('says why fast mode runs at another speed than chosen, and nothing while it is checked', () => {
    const shown = (state: 'on' | 'off' | 'cooldown', reason?: string) => {
      const h = onModels([{ ...model('opus'), fast: true }], {
        fast: { on: true, state, ...(reason ? { reason } : {}) },
      });
      return nodes(h.value).find((n) => n.props.className === 'cp-mms');
    };
    expect(text(shown('cooldown'))).toBe(zh('daemon.fastMode.cooldown'));
    expect(text(shown('off', 'free'))).toBe(zh('daemon.fastMode.free'));
    expect(text(shown('off', 'preference'))).toBe(zh('daemon.fastMode.turnedOff'));
    expect(text(shown('off', 'network_error'))).toBe(zh('daemon.fastMode.networkError'));
    expect(text(shown('off', 'unknown_reason'))).toBe(zh('daemon.fastMode.unavailable'));
    expect(shown('off', 'pending')).toBeUndefined();
    expect(shown('on')).toBeUndefined();
  });

  it('shows why the switch was refused under it until the menu opens again', async () => {
    const onFast = vi.fn(async () => '会话已经结束');
    const h = onModels([{ ...model('opus'), fast: true }], { fast: { on: false }, onFast });
    fastItem(h)!.props.onCheckedChange(true);
    await h.flush();
    const alert = () => nodes(h.value).find((n) => n.props.role === 'alert');
    expect(text(alert())).toBe('会话已经结束');
    (h.value as any).props.onOpenChange(true);
    h.render();
    expect(alert()).toBeUndefined();
  });
});
