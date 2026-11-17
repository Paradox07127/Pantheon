import { expect, it, vi } from 'vitest';
import { fixture } from '../helpers.js';

const load = vi.hoisted(() => vi.fn());
vi.mock('../../packages/control/node_modules/node-pty/lib/index.js', () => {
  load();
  throw new Error('Native terminal binding could not load');
});

it('starts without loading node-pty and reports its load failure only when opening a terminal', async () => {
  const f = await fixture();
  try {
    expect(load).not.toHaveBeenCalled();
    await expect(
      f.call('terminal.open', { project_id: f.project.id, cols: 80, rows: 24 }),
    ).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect(load).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
