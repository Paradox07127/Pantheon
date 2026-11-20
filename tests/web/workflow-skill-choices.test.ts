import { describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { scopeText } from '@/data/workflow-policy';

describe('improvement scope', () => {
  it('names the tier of a path change that sets one', () => {
    expect(
      scopeText({ type: 'policy_change', param: 'path', tier: 't1', from: 'full', to: 'light' }),
    ).toBe('T1');
  });
});
