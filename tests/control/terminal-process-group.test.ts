import { expect, it, vi } from 'vitest';
import { fixture } from '../helpers.js';
import { FakePty } from '../fixtures/fake-pty.js';

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../packages/control/node_modules/node-pty/lib/index.js', () => native);

it('uses the fallback login shell and kills its process group on close and daemon shutdown', async () => {
  vi.stubEnv('SHELL', '');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const pty = new FakePty();
  native.spawn.mockReturnValue({
    pid: 12345,
    write: pty.write,
    resize: pty.resize,
    kill: pty.kill,
    onData: pty.onData.bind(pty),
    onExit: pty.onExit.bind(pty),
  });
  const f = fixture();
  try {
    expect(native.spawn).not.toHaveBeenCalled();
    const { terminal_id } = await f.call<Promise<{ terminal_id: string }>>('terminal.open', {
      project_id: f.project.id,
      cols: 80,
      rows: 24,
    });
    expect(native.spawn).toHaveBeenCalledWith(
      process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
      ['-l'],
      expect.objectContaining({ cwd: f.project.roots[0] }),
    );
    f.call('terminal.close', { terminal_id });
    expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGKILL');
    pty.exit(137);
    await f.call('terminal.open', { project_id: f.project.id, cols: 80, rows: 24 });
    await f.control.shutdown();
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenLastCalledWith(-12345, 'SIGKILL');
  } finally {
    await f.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
