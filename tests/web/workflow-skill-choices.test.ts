import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { RUNTIMES } from '@/data/extensions';
import { useSkillChoices } from '@/data/workflow-definition';
import { scopeText } from '@/data/workflow-policy';

const inventory = (runtime: string): BridgeResult<unknown> => ({
  ok: true,
  value: {
    runtime,
    mcp_servers: [],
    plugins: [],
    skills: [
      {
        id: '/skills/review/SKILL.md',
        name: 'review',
        path: '/skills/review/SKILL.md',
        enabled: true,
      },
      {
        id: '/skills/deploy/SKILL.md',
        name: 'deploy',
        path: '/skills/deploy/SKILL.md',
        enabled: true,
      },
      {
        id: '/home/notes/SKILL.md',
        name: 'notes',
        path: '/home/notes/SKILL.md',
        enabled: true,
        user: true,
      },
    ],
    apps: false,
    connectors: [],
    hooks: [],
  },
});

const off = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: ['/skills/deploy/SKILL.md'],
  enabled_user_skills: [],
  disable_apps: false,
  disable_hooks: false,
};

beforeEach(() => {
  const query = vi.fn(async (_method: string, params: { runtime: string }) =>
    inventory(params.runtime),
  );
  vi.stubGlobal('window', { pantheon: { query } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('workflow skill choices', () => {
  it('leaves out the skills the project turned off on every runtime', async () => {
    mock.board = {
      board: {
        projects: [
          {
            id: 'alpha',
            extension_overrides: Object.fromEntries(RUNTIMES.map((r) => [r, off])),
          },
        ],
      },
    };
    const h = mount(() => useSkillChoices('alpha'));
    await h.flush();
    expect(h.value.map((s) => s.name)).toEqual(['review']);
  });

  it('keeps a skill one runtime still loads', async () => {
    mock.board = {
      board: { projects: [{ id: 'alpha', extension_overrides: { [RUNTIMES[0]!]: off } }] },
    };
    const h = mount(() => useSkillChoices('alpha'));
    await h.flush();
    expect(h.value.map((s) => s.name)).toEqual(['review', 'deploy', 'notes']);
  });
});

describe('improvement scope', () => {
  it('names the tier of a path change that sets one', () => {
    expect(
      scopeText({ type: 'policy_change', param: 'path', tier: 't1', from: 'full', to: 'light' }),
    ).toBe('T1');
  });
});
