import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { eventually, fixture, ptyUsable, user } from '../helpers.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

it.skipIf(!existsSync('/bin/bash') || !ptyUsable)(
  'kills background jobs of the shell when the terminal closes',
  async () => {
    vi.stubEnv('SHELL', '/bin/bash');
    const f = await fixture();
    try {
      const { terminal_id } = await f.call<Promise<{ terminal_id: string }>>('terminal.open', {
        project_id: f.project.id,
        cols: 80,
        rows: 24,
      });
      let output = '';
      const unsubscribe = f.control.terminalSubscribe(user, terminal_id, (frame) => {
        if (Buffer.isBuffer(frame)) output += frame.toString();
      });
      // Job control puts the job in its own process group, outside the shell's. A `!` before a
      // quote is a history expansion in bash 3.2 (macOS); at the end of the line it is not.
      f.call('terminal.write', { terminal_id, data: 'sleep 987 & echo job=$!\r' });
      await eventually(() => /job=\d+/.test(output), undefined, 15000);
      const job = Number(/job=(\d+)/.exec(output)![1]);
      expect(alive(job)).toBe(true);
      f.call('terminal.close', { terminal_id });
      await eventually(() => !alive(job), undefined, 5000);
      unsubscribe();
    } finally {
      await f.close();
      vi.unstubAllEnvs();
    }
  },
);
