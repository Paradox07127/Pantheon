import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuAction } from '@pantheon/protocol';
const mock = vi.hoisted(() => ({ run: vi.fn((_id: string) => true) }));
vi.mock('@/lib/shortcuts', async (actual) => ({
  ...(await actual<object>()),
  runShortcut: mock.run,
}));
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
});
