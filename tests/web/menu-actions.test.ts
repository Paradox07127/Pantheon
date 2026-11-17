import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuAction } from '@pantheon/protocol';
const mock = vi.hoisted(() => ({ run: vi.fn((_id: string) => true) }));
vi.mock('@/lib/shortcuts', async (actual) => ({
  ...(await actual<object>()),
  runShortcut: mock.run,
}));
import { useDebugView } from '@/components/DebugView';
import { runMenuAction } from '@/lib/menu-actions';

afterEach(() => vi.unstubAllGlobals());

describe('menu actions', () => {
  it.each([
    ['search', 'palette'],
    ['toggle-sidebar', 'sidebar'],
    ['toggle-details', 'details'],
    ['toggle-overview', 'overview'],
    ['back', 'back'],
    ['forward', 'forward'],
    ['shortcuts', 'shortcuts'],
  ] as const)('runs the %s item with the %s shortcut', (action: MenuAction, id) => {
    mock.run.mockClear();
    runMenuAction(action);
    expect(mock.run.mock.calls).toEqual([[id]]);
  });

  it('toggles the debug view from its item', () => {
    useDebugView.setState({ open: false });
    runMenuAction('debug-view');
    expect(useDebugView.getState().open).toBe(true);
    runMenuAction('debug-view');
    expect(useDebugView.getState().open).toBe(false);
  });

  it('turns the user stylesheet off from its item', async () => {
    const command = vi.fn(async (_c: { type: string; input: unknown }) => ({
      ok: true,
      value: {},
    }));
    vi.stubGlobal('window', {
      pantheon: { command, query: async () => ({ ok: true, value: {} }) },
    });
    runMenuAction('disable-user-style');
    await vi.waitFor(() =>
      expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
        ['style.enable', { enabled: false }],
      ]),
    );
  });
});
