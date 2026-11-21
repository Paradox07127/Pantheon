import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { sessionKinds, useRuntimeStatus } from '@/data/runtime-status';
import { HarnessPage } from '@/screens/settings/HarnessPage';
import { SessionDefaults } from '@/screens/settings/SessionDefaultsPage';
import { zh } from './i18n-setup.js';

const status = (runtime: string, enabled = true, writer = true) => ({
  runtime,
  enabled,
  installed: true,
  version: '1.0.0',
  min_version: null,
  version_ok: null,
  auth: { state: 'unknown' as const },
  checked_at: '2026-11-11T00:00:00Z',
  ...(enabled && {
    capabilities: {
      write_isolation: {
        status: writer ? ('supported' as const) : ('unsupported' as const),
        evidence: 'fixture',
      },
      text_execution: { status: 'supported' as const, evidence: 'fixture' },
    },
  }),
});
const project = { id: 'alpha', revision: 1, name: 'Alpha', roots: ['/work/alpha'] };
let statuses: (ReturnType<typeof status> & { binary?: string })[];
const query = vi.fn(async (method: string) => ({
  ok: true as const,
  value: method === 'runtime.status' ? statuses : [],
}));
async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}
beforeEach(() => {
  statuses = [status('grok', true, false), status('claude', false), status('codex')];
  query.mockClear();
  vi.stubGlobal('window', { pantheon: { query }, addEventListener() {}, removeEventListener() {} });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    events: [],
  } as never);
});
afterEach(() => {
  unmountAll();
  useBoard.setState({ board: null });
  vi.unstubAllGlobals();
});

it('marks a turned-off runtime unavailable for sessions even though it has no capability report', async () => {
  const h = await mount(() => useRuntimeStatus('writer'));
  expect(h.value.unavailable.claude).toBe(zh('data.runtimeStatus.disabled'));
  expect(h.value.unavailable.grok).toBe(zh('data.runtimeStatus.noWriteIsolation'));
  expect(h.value.unavailable.codex).toBeUndefined();
  expect(sessionKinds(status('claude', false))).toEqual([]);
});

it('offers a runtime without verified isolation once its settings allow it, as the daemon admits it', async () => {
  statuses = [{ ...status('grok', true, false), unverified_isolation: true } as never];
  const h = await mount(() => useRuntimeStatus('writer'));
  expect(h.value.unavailable.grok).toBeUndefined();
  expect(sessionKinds(statuses[0]!)).toEqual(['writer', 'reviewer', 'text']);
});

it('shows a disabled configured binary and a distinct missing-install state without stand-in rows', async () => {
  statuses = [
    { ...status('grok', false), binary: '/configured/grok' },
    { ...status('codex'), installed: false },
  ];
  const h = await mount(() => HarnessPage({ projectId: 'alpha' }));
  const row = () => find(h.value, (n) => n.props['aria-label'] === 'grok');
  expect(find(row(), (n) => n.type === 'input' && n.props.type === 'checkbox').props.checked).toBe(
    false,
  );
  const binary = () => find(row(), (n) => n.type === 'input' && n.props.spellCheck === false);
  expect(binary().props.value).toBe('/configured/grok');
  expect(text(row())).toContain(zh('data.runtimeStatus.disabled'));
  expect(text(find(h.value, (n) => n.props['aria-label'] === 'Codex'))).toContain(
    zh('settings.runtimes.noBinary'),
  );
  expect(
    nodes(h.value)
      .filter((n) => n.props.role === 'group')
      .map((n) => n.props['aria-label']),
  ).toEqual(['grok', 'Codex']);
  expect(query.mock.calls.map(([method]) => method)).not.toContain('runtime.models');
  binary().props.onChange({ target: { value: '/edited/grok' } });
  await h.flush();
  expect(binary().props.value).toBe('/edited/grok');
});

it('uses writer status for the session-default choices without reading capabilities', async () => {
  const h = await mount(() => SessionDefaults({ project: project as never }));
  expect(query.mock.calls.map(([method]) => method)).not.toContain('capabilities');
  const menu = named(h.value, 'ModelMenu');
  expect(menu.props.runtimes).toEqual(['claude', 'codex', 'grok']);
  expect(Object.keys(menu.props.unavailable).sort()).toEqual(['claude', 'grok']);
});
