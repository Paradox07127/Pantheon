import { expect, it, vi } from 'vitest';
import type { Session, Workspace } from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import type { TerminalSpawn } from '@pantheon/control';
import { fixture, user } from '../helpers.js';
import { FakePty } from '../fixtures/fake-pty.js';

function terminalFixture() {
  const ptys: FakePty[] = [];
  const spawn = vi.fn<TerminalSpawn>(() => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  });
  const f = fixture({ controlOptions: { terminalSpawn: spawn } });
  const open = async (session_id?: string) =>
    (
      await f.call<Promise<{ terminal_id: string }>>('terminal.open', {
        project_id: f.project.id,
        session_id,
        cols: 80,
        rows: 24,
      })
    ).terminal_id;
  const session = (workspaceFields: Partial<Workspace> = {}) => {
    const workspace = f.store.insert<Workspace>('workspaces', {
      id: 'terminal-workspace',
      revision: 1,
      project_id: f.project.id,
      path: f.root,
      kind: 'in_place',
      owner: 'none',
      ownership_epoch: 0,
      ...workspaceFields,
    });
    return f.store.insert<Session>('sessions', {
      id: 'terminal-session',
      revision: 1,
      project_id: f.project.id,
      workspace_id: workspace.id,
      runtime: f.adapter.name,
      state: 'open',
      turn_count: 0,
    });
  };
  return { ...f, ptys, spawn, open, session };
}

it('opens a login shell in the project or session workspace and forwards writes and sizes', async () => {
  const f = terminalFixture();
  try {
    const terminal_id = await f.open();
    expect(f.spawn).toHaveBeenCalledWith(
      process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
      ['-l'],
      {
        cwd: f.project.roots[0],
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color' },
      },
    );
    f.call('terminal.write', { terminal_id, data: 'pwd\r' });
    f.call('terminal.resize', { terminal_id, cols: 100, rows: 30 });
    expect(f.ptys[0]!.write).toHaveBeenCalledWith('pwd\r');
    expect(f.ptys[0]!.resize).toHaveBeenCalledWith(100, 30);
    await f.open(f.session().id);
    expect(f.spawn.mock.calls[1]![2].cwd).toBe(f.root);
    f.call('terminal.close', { terminal_id });
    expect(f.ptys[0]!.kill).toHaveBeenCalledOnce();
    expect(() => f.call('terminal.write', { terminal_id, data: 'x' })).toThrow(/exited/);
  } finally {
    await f.close();
  }
});

it('refuses the ninth live terminal and frees a slot after shell exit', async () => {
  const f = terminalFixture();
  try {
    await Promise.all(Array.from({ length: 8 }, () => f.open()));
    await expect(f.open()).rejects.toMatchObject({ code: 'resource_busy' });
    expect(f.spawn).toHaveBeenCalledTimes(8);
    f.ptys[0]!.exit(0);
    await f.open();
    expect(f.spawn).toHaveBeenCalledTimes(9);
  } finally {
    await f.close();
  }
});

it('replays the last 256 KiB as bytes before live output and a single exit frame', async () => {
  const f = terminalFixture();
  try {
    const terminal_id = await f.open();
    const cursor = f.store.cursor();
    const pty = f.ptys[0]!;
    pty.output('old'.repeat(100000));
    pty.output('界'.repeat(100000));
    const frames: (Buffer | { type: 'exit'; code: number })[] = [];
    const detach = f.control.terminalSubscribe(user, terminal_id, (frame) => frames.push(frame));
    expect(frames).toEqual([Buffer.from('界'.repeat(100000)).subarray(-256 * 1024)]);
    pty.output('live');
    pty.exit(7);
    expect(frames.slice(1)).toEqual([Buffer.from('live'), { type: 'exit', code: 7 }]);
    detach();
    const replay: (Buffer | { type: 'exit'; code: number })[] = [];
    f.control.terminalSubscribe(user, terminal_id, (frame) => replay.push(frame));
    expect((replay[0] as Buffer).length).toBe(256 * 1024);
    expect(replay[1]).toEqual({ type: 'exit', code: 7 });
    expect(f.store.cursor()).toBe(cursor);
  } finally {
    await f.close();
  }
});

it.each(['closed', 'merged', 'discarded'] as const)(
  'closes a session terminal when its session becomes %s',
  async (ending) => {
    const f = terminalFixture();
    try {
      const session = f.session();
      await f.open(session.id);
      await f.open();
      f.store.update<Session>(
        'sessions',
        {
          ...session,
          state: 'closed',
          ...(ending === 'closed' ? {} : { outcome: ending }),
        },
        session.revision,
      );
      await f.control.tick();
      expect(f.ptys[0]!.kill).toHaveBeenCalledOnce();
      expect(f.ptys[1]!.kill).not.toHaveBeenCalled();
      await expect(f.open(session.id)).rejects.toMatchObject({ code: 'invalid_state' });
    } finally {
      await f.close();
    }
  },
);

it('closes terminals after thirty minutes without sockets, restarting the clock on final detach', async () => {
  vi.useFakeTimers();
  const f = terminalFixture();
  try {
    const unopened = await f.open();
    const connected = await f.open();
    const detach = f.control.terminalSubscribe(user, connected, () => {});
    const detachOther = f.control.terminalSubscribe(user, connected, () => {});
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(f.ptys[0]!.kill).toHaveBeenCalledOnce();
    expect(() => f.control.terminalSubscribe(user, unopened, () => {})).toThrow(/not found/);
    expect(f.ptys[1]!.kill).not.toHaveBeenCalled();
    detach();
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(f.ptys[1]!.kill).not.toHaveBeenCalled();
    detachOther();
    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(f.ptys[1]!.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.ptys[1]!.kill).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

it('kills every live terminal on daemon shutdown', async () => {
  const f = terminalFixture();
  try {
    await f.open();
    await f.open();
    await f.control.shutdown();
    expect(f.ptys.every((pty) => pty.kill.mock.calls.length === 1)).toBe(true);
    await expect(f.open()).rejects.toMatchObject({ code: 'invalid_state' });
  } finally {
    await f.close();
  }
});

it('requires the user and null revisions and refuses a session from another project', async () => {
  const f = terminalFixture();
  try {
    const terminal_id = await f.open();
    for (const [type, input] of [
      ['terminal.open', { project_id: f.project.id, cols: 80, rows: 24 }],
      ['terminal.write', { terminal_id, data: 'x' }],
      ['terminal.resize', { terminal_id, cols: 80, rows: 24 }],
      ['terminal.close', { terminal_id }],
    ] as const) {
      expect(() => f.call(type, input, 1)).toThrow(/revision/);
      expect(() => f.call(type, input, null, { id: 'planner', role: 'planner' })).toThrow(/user/);
    }
    expect(() =>
      f.control.terminalSubscribe({ id: 'planner', role: 'planner' }, terminal_id, () => {}),
    ).toThrow(/user/);
    const session = f.session();
    f.store.update('sessions', { ...session, project_id: 'another-project' }, session.revision);
    await expect(f.open(session.id)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(f.spawn).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it.each([
  ['still being prepared', { provisioning: { state: 'running', base_ref: 'HEAD' } }],
  ['whose preparation failed', { provisioning: { state: 'failed', base_ref: 'HEAD' } }],
  ['already removed', { removed_at: 1 }],
] as const)('refuses a session terminal in a worktree %s', async (_, workspaceFields) => {
  const f = terminalFixture();
  try {
    const session = f.session({ kind: 'linked_worktree', ...workspaceFields });
    await expect(f.open(session.id)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(f.spawn).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('deduplicates concurrent terminal opens and repeated input commands', async () => {
  const f = terminalFixture();
  try {
    const sent = command(user.id, 'terminal.open', {
      project_id: f.project.id,
      cols: 80,
      rows: 24,
    });
    const receipts = await Promise.all([
      f.control.execute(user, sent),
      f.control.execute(user, sent),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(f.spawn).toHaveBeenCalledOnce();
    const write = command(user.id, 'terminal.write', {
      terminal_id: (receipts[0] as { terminal_id: string }).terminal_id,
      data: 'once',
    });
    f.control.execute(user, write);
    f.control.execute(user, write);
    expect(f.ptys[0]!.write).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
