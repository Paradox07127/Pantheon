import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffortLevel, RuntimeModel } from '@pantheon/protocol';
import { mount, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'loading' } }),
  offeredRuntimes: () => ['claude', 'codex'],
}));
const model = (id: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  label: id,
  permission_modes: [],
  efforts: ['minimal', 'medium', 'high', 'xhigh', 'max'],
  default_effort: 'medium',
  default: false,
  ...extra,
});
vi.mock('@/data/runtime-models', () => ({
  useRuntimeModels: () => ({
    claude: { state: 'loading' },
    codex: {
      state: 'ready',
      models: [
        model('gpt-other'),
        model('gpt-default', { efforts: ['low', 'high'], default: true }),
        model('gpt-flat', { efforts: [], default_effort: null }),
      ],
    },
  }),
}));
import { useRouteFields } from '@/screens/board/PlanEdit';
import { zh } from './i18n-setup.js';

afterEach(() => unmountAll());

const fields = (model: string | null, effort: EffortLevel | null = null) => {
  const set = vi.fn();
  const h = mount(() =>
    useRouteFields('project-route', { runtime: 'codex', model, effort }, false, set),
  );
  const field = (id: string) => nodes(h.value).find((n) => n.props['aria-label'] === zh(id));
  return { set, field };
};
const efforts = (model: string | null) =>
  nodes(fields(model).field('board.plan.field.effort')?.props.children).map((n) => n.props.value);

describe('task route fields', () => {
  it('offers the efforts of the picked model, and of the default model while none is picked', () => {
    expect(efforts('gpt-other')).toEqual(['minimal', 'medium', 'high', 'xhigh', 'max']);
    expect(efforts(null)).toEqual(['low', 'high']);
  });

  it('takes the effort away for a model that takes none', () => {
    const { set, field } = fields('gpt-other', 'high');
    field('board.plan.field.model')!.props.onChange('gpt-flat');
    expect(set).toHaveBeenCalledWith({ model: 'gpt-flat', effort: null });
  });

  it('offers only runtimes whose models are listed', () => {
    const options = nodes(
      fields('gpt-other').field('board.plan.field.runtime')?.props.children,
    ).filter((n) => n.props.value !== undefined);
    expect(options.map((n) => [n.props.value, n.props.disabled])).toEqual([
      ['claude', true],
      ['codex', false],
    ]);
  });

  it('goes back to the runtime default model and effort from a picked model', () => {
    const { set, field } = fields('gpt-other', 'high');
    const select = field('board.plan.field.model')!;
    expect(select.props.options[0]).toEqual({
      value: '',
      label: '默认（gpt-default）',
    });
    select.props.onChange('');
    expect(set).toHaveBeenCalledWith({ model: null, effort: null });
  });
});
