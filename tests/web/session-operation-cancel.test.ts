import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionGates } from '@pantheon/protocol';
import { find, named, text, mount, unmountAll } from './web-hook-host.js';

vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/store', () => ({ useShell: (selector: any) => selector({ sessionRun: null }) }));
const mock = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ events: [] }), {
    getState: () => ({ refresh: mock.refresh }),
  }),
}));
import { CancelOperation, ChecksTab, MergeBar, ReviewTab } from '@/screens/sessions/panel';
import { gateSummary } from '@/screens/sessions/model';
import { zh } from './i18n-setup.js';

let command: ReturnType<typeof vi.fn>;
beforeEach(() => {
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', { pantheon: { command } });
  mock.refresh.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('shows the newest requested review even when rounds tie and blocks mutations on retained stale results', () => {
  const reviews = [
    { id: 'old', round: 1, state: 'failed', findings: [] },
    { id: 'new', round: 1, revision: 4, state: 'completed', findings: [], runtimes: ['codex'] },
  ];
  const h = mount(() =>
    ReviewTab({
      sessionId: 'session-a',
      runtime: 'claude',
      reviews: { data: reviews as any, error: 'read failed', stale: true, reload() {} },
      files: null,
      readOnly: false,
      attached: new Set(),
      onAttach() {},
    }),
  );
  expect(named(h.value, 'ReviewCoverage').props.review.id).toBe('new');
  const request = find(
    h.value,
    (node) => node.type === 'button' && text(node).includes('请 Codex 审查'),
  );
  expect(request.props.disabled).toBe(true);
  request.props.onClick();
  expect(command).not.toHaveBeenCalled();
});

for (const kind of ['gates', 'merge'] as const)
  it(`sends the ${kind} cancellation command with the current revision and waits for reconciliation`, async () => {
    const h = mount(() => CancelOperation({ kind, sessionId: 'session-a', revision: 17 }));
    find(h.value, (n) => n.type === 'button').props.onClick();
    await h.flush();
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: kind === 'gates' ? 'session.gates.cancel' : 'session.merge.cancel',
        input: { session_id: 'session-a' },
        expected_revision: 17,
      }),
    );
    expect(text(h.value)).toContain(zh('sessions.panel.cancel.cancelling'));
    expect(find(h.value, (n) => n.type === 'button').props.disabled).toBe(true);
    expect(mock.refresh).toHaveBeenCalled();
  });

it('keeps a refused cancellation visible and lets the user retry', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'permission_denied', message: 'Only user can cancel' },
  });
  const h = mount(() => CancelOperation({ kind: 'merge', sessionId: 'session-a', revision: 17 }));
  find(h.value, (n) => n.type === 'button').props.onClick();
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('Only user can cancel');
  expect(find(h.value, (n) => n.type === 'button').props.disabled).toBe(false);
});

const check = (gates: SessionGates, readOnly = false) =>
  mount(() =>
    ChecksTab({
      sessionId: 'session-a',
      revision: 17,
      gates: { data: gates, error: null, reload() {} },
      readOnly,
      merging: false,
      busy: false,
      attached: new Set(),
      onAttach() {},
      onRun() {},
      onSettings() {},
    }),
  );

it('offers cancellation for an active explicit gate and keeps read-only views without controls', () => {
  const gates: SessionGates = {
    configured: true,
    running: true,
    last: null,
    operation: { id: 'check-a', state: 'cancelling' },
  };
  const editable = check(gates);
  expect(named(editable.value, 'CancelOperation').props).toMatchObject({
    kind: 'gates',
    sessionId: 'session-a',
    revision: 17,
    cancelling: true,
  });
  const readOnly = check(gates, true);
  expect(() => named(readOnly.value, 'CancelOperation')).toThrow();
});

it('shows a cancelled check independently of an older passing result', () => {
  const gates: SessionGates = {
    configured: true,
    running: false,
    operation: { id: 'check-a', state: 'cancelled' },
    last: {
      commit: 'abc',
      checked_at: Date.now(),
      results: [{ name: 'Old check', exit_code: 0, timed_out: false, output_tail: '' }],
    },
  };
  expect(gateSummary(gates)).toBe('cancelled');
  expect(text(check(gates).value)).toContain(zh('sessions.panel.checks.cancelled'));
});

it('offers merge cancellation while the merge is running and preserves the cancelling state', () => {
  const h = mount(() =>
    MergeBar({
      sessionId: 'session-a',
      revision: 17,
      live: true,
      merging: true,
      cancelling: true,
      preflight: null,
      onPreflight() {},
      gates: null,
      branch: 'main',
      source: '/source',
      onChecks() {},
    }),
  );
  expect(named(h.value, 'CancelOperation').props).toMatchObject({
    kind: 'merge',
    cancelling: true,
  });
});
