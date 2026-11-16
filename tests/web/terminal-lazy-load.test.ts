import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, nodes } from './web-hook-host.js';
const xt = vi.hoisted(() => ({ loaded: 0, made: 0 }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/@xterm/xterm', () => {
  xt.loaded++;
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      constructor(public options: Record<string, unknown>) {
        xt.made++;
      }
      loadAddon() {}
      open() {}
      write() {}
      onData() {
        return { dispose() {} };
      }
      dispose() {}
    },
  };
});
vi.mock('../../apps/web/node_modules/@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
import { TerminalPanel } from '@/screens/sessions/TerminalPanel';

afterEach(() => vi.unstubAllGlobals());

it('loads xterm only once a terminal panel mounts', async () => {
  expect(xt.loaded).toBe(0);
  vi.stubGlobal('window', {
    pantheon: {
      command: vi.fn(async () => ({ ok: true, value: { terminal_id: 'terminal-1' } })),
      terminalSubscribe: vi.fn(() => () => {}),
    },
  });
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  for (const name of ['ResizeObserver', 'MutationObserver'])
    vi.stubGlobal(
      name,
      class {
        observe() {}
        disconnect() {}
      },
    );
  const h = new HookHost(
    () => TerminalPanel({ projectId: 'project-a', sessionId: null, onClose() {} }),
    (tree) => {
      for (const node of nodes(tree as ReactNode))
        if (node.props.ref && typeof node.props.ref === 'object') node.props.ref.current ??= {};
    },
  );
  h.render();
  await vi.waitFor(() => expect(xt.made).toBe(1));
  expect(xt.loaded).toBe(1);
  h.unmount();
});
