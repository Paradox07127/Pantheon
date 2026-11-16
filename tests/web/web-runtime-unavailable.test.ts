import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeModel } from '@pantheon/protocol';
import { find, mount, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { Tip } from '@/components/Tip';
import { defaultModelFor, defaultRuntime } from '@/screens/sessions/model';
import { ModelMenu } from '@/screens/sessions/parts';
import { zh } from './i18n-setup.js';

const model = (id: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  label: `label of ${id}`,
  permission_modes: ['plan', 'ask', 'auto_edit'],
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  default: false,
  ...extra,
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('default runtime with unavailable runtimes', () => {
  it('skips a preferred runtime that cannot start a session', () => {
    expect(defaultRuntime(['claude', 'codex'], 'claude', { claude: '未安装' })).toBe('codex');
    expect(defaultRuntime(['claude', 'codex'], 'codex', { codex: '未登录' })).toBe('claude');
  });

  it('keeps the usual choice when every runtime is unavailable', () => {
    const all = { claude: '未安装', codex: '未登录' };
    expect(defaultRuntime(['claude', 'codex'], 'codex', all)).toBe('codex');
    expect(defaultRuntime(['codex', 'claude'], 'agy', all)).toBe('claude');
    expect(defaultRuntime([], 'codex', all)).toBe('codex');
  });
});

describe('default model for a preferred one', () => {
  const models = [model('model-a'), model('opus', { resolved: 'claude-opus-5-5' })];

  it.each([
    ['picks the preferred model by id', 'opus'],
    ['picks the preferred model by its resolved id', 'claude-opus-5-5'],
  ])('%s', (_name, preferred) => {
    expect(defaultModelFor(models, preferred)?.id).toBe('opus');
  });

  it('falls back to the default model when the list lacks the preferred one', () => {
    const marked = [model('model-a'), model('model-b', { default: true })];
    expect(defaultModelFor(marked, 'model-z')?.id).toBe('model-b');
    expect(defaultModelFor(marked, undefined)?.id).toBe('model-b');
  });
});

describe('model menu with unavailable runtimes', () => {
  it('disables an unavailable runtime and gives its reason as a tooltip', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const h = mount(() =>
      ModelMenu({
        runtimes: ['claude', 'codex'],
        models: {
          claude: { state: 'ready', models: [model('claude-model')] },
          codex: { state: 'ready', models: [model('codex-model')] },
        },
        value: { runtime: 'claude', backend: null, model: 'claude-model', effort: 'medium' },
        onChange: vi.fn(),
        unavailable: { codex: '未登录' },
      }),
    );
    const group = find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.runtime'));
    const item = (runtime: string) =>
      find(group, (n) => n.props.value === runtime && typeof n.props.onClick === 'function');
    expect(item('codex').props.disabled).toBe(true);
    expect(item('claude').props.disabled).toBeFalsy();
    const tips = nodes(group).filter((n) => n.type === Tip);
    expect(tips.map((t) => t.props.content)).toEqual(['未登录']);
    expect(tips[0]!.props.children.props.value).toBe('codex');
  });
});
