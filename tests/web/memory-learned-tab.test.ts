import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearnedItem } from '@pantheon/protocol';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'learned-tab-id' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { MemoryScreen } from '@/screens/memory/MemoryScreen';

const learned = (id: string, group: LearnedItem['group']): LearnedItem => ({
  kind: 'experience',
  id,
  grade: 'trial',
  status: 'candidate',
  group,
  diff: { from: '', to: `Rule ${id}.` },
  evidence: [],
  actions: [],
  at: 1,
});

let answer: LearnedItem[] = [];
const query = vi.fn(async (method: string) =>
  method === 'learned.list'
    ? { ok: true, value: answer }
    : { ok: false, error: { code: 'unknown_route', message: method } },
);

beforeEach(() => {
  query.mockClear();
  vi.stubGlobal('window', {
    pantheon: { query, command: query },
    addEventListener() {},
    removeEventListener() {},
  });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [] },
    events: [],
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null, events: [] } as never);
});

async function learnedTab() {
  const h = mount(() => MemoryScreen({ projectId: 'pay' }));
  await h.flush();
  return nodes(h.value).find((n) => n.props.className === 'tb-tab' && n.props.value === 'learned')!;
}

describe('memory learned tab', () => {
  it('counts the changes that need you and says so in its name', async () => {
    answer = [learned('a', 'needs_you'), learned('b', 'in_force'), learned('c', 'needs_you')];
    const tab = await learnedTab();
    expect(text(tab)).toBe(`${zh('memory.tab.learned')}2`);
    expect(tab.props['aria-label']).toBe(zhf('memory.tab.learnedCount', { count: 2 }));
    expect(query.mock.calls.filter(([method]) => method === 'learned.list')).toHaveLength(1);
  });

  it('shows no count when nothing needs you', async () => {
    answer = [learned('b', 'in_force')];
    const tab = await learnedTab();
    expect(text(tab)).toBe(zh('memory.tab.learned'));
    expect(tab.props['aria-label']).toBeUndefined();
  });
});
