import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DomainError,
  requireThat,
  type Project,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import type { inputSchemas } from '@pantheon/protocol';
import type { Store } from '@pantheon/store';
import type { IPty, IPtyForkOptions } from 'node-pty';

export type TerminalPty = Pick<IPty, 'write' | 'resize' | 'onData' | 'onExit' | 'kill'>;
export type TerminalSpawn = (file: string, args: string[], options: IPtyForkOptions) => TerminalPty;
export type TerminalFrame = Buffer | { type: 'exit'; code: number };

const REPLAY_BYTES = 256 * 1024;
const IDLE_MS = 30 * 60 * 1000;

interface Terminal {
  session_id?: string;
  pty?: TerminalPty;
  replay: Buffer;
  code?: number;
  subscribers: Set<(frame: TerminalFrame) => void>;
  idle?: ReturnType<typeof setTimeout>;
}

export class Terminals {
  private readonly entries = new Map<string, Terminal>();
  private loading?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private spawn?: TerminalSpawn,
  ) {}

  prepare(): Promise<void> {
    if (this.spawn) return Promise.resolve();
    return (this.loading ??= import('node-pty').then(
      ({ spawn }) => {
        this.spawn = (file, args, options) => {
          const pty = spawn(file, args, options);
          return {
            write: pty.write.bind(pty),
            resize: pty.resize.bind(pty),
            onData: pty.onData.bind(pty),
            onExit: pty.onExit.bind(pty),
            kill: () => {
              // The shell's background jobs run in other process groups but share its controlling tty.
              // macOS pgrep has no -s and its ps reports no session id, so match by tty instead.
              const rows = (
                spawnSync('ps', ['-A', '-o', 'pid=,tty='], { encoding: 'utf8' }).stdout ?? ''
              )
                .split('\n')
                .map((line) => line.trim().split(/\s+/))
                // `?` (Linux) and `??` (macOS) mean no tty, as for an exited shell; never match those.
                .filter(([pid, tty]) => pid && tty && !/^\?+$/.test(tty));
              const tty = rows.find(([pid]) => Number(pid) === pty.pid)?.[1];
              const members = rows.filter((row) => row[1] === tty).map(([pid]) => Number(pid));
              try {
                // PTYs start a process group; killing only the shell leaves its children alive.
                process.kill(-pty.pid, 'SIGKILL');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
              }
              for (const member of members)
                try {
                  process.kill(member, 'SIGKILL');
                } catch (error) {
                  // ESRCH: already gone; EPERM: a job running as another user, such as under sudo.
                  if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
                    throw error;
                }
            },
          };
        };
      },
      (error: unknown) => {
        throw new DomainError(
          'unsupported_capability',
          error instanceof Error ? error.message : String(error),
        );
      },
    ));
  }

  open(input: ReturnType<(typeof inputSchemas)['terminal.open']['parse']>): {
    terminal_id: string;
  } {
    requireThat(!this.stopped, 'invalid_state', 'Daemon is stopping');
    requireThat(
      [...this.entries.values()].filter((terminal) => terminal.pty).length < 8,
      'resource_busy',
      'At most 8 terminals may be open',
    );
    let cwd = this.store.must<Project>('projects', input.project_id).roots[0]!;
    if (input.session_id) {
      const session = this.store.must<Session>('sessions', input.session_id);
      requireThat(
        session.project_id === input.project_id,
        'permission_denied',
        'Session belongs to another project',
      );
      requireThat(
        session.state !== 'closed' && !session.outcome,
        'invalid_state',
        'Session has ended',
      );
      requireThat(session.workspace_id, 'invalid_state', 'Session has no worktree');
      const workspace = this.store.must<Workspace>('workspaces', session.workspace_id);
      // A shell writing into the reservation before `git worktree add` breaks provisioning.
      requireThat(
        (workspace.provisioning?.state ?? 'ready') === 'ready' &&
          workspace.removed_at === undefined,
        'invalid_state',
        'Worktree is not ready',
      );
      cwd = workspace.path;
    }
    const pty = this.spawn!(
      process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
      ['-l'],
      {
        cwd,
        cols: input.cols,
        rows: input.rows,
        name: 'xterm-256color',
        env: { ...process.env, TERM: 'xterm-256color' },
      },
    );
    const terminal_id = randomUUID();
    const terminal: Terminal = {
      session_id: input.session_id,
      pty,
      replay: Buffer.alloc(0),
      subscribers: new Set(),
    };
    this.entries.set(terminal_id, terminal);
    this.armIdle(terminal_id, terminal);
    pty.onData((data) => {
      const bytes = Buffer.from(data);
      const replay = Buffer.concat([terminal.replay, bytes]);
      terminal.replay =
        replay.length > REPLAY_BYTES ? Buffer.from(replay.subarray(-REPLAY_BYTES)) : replay;
      for (const subscriber of terminal.subscribers) subscriber(bytes);
    });
    pty.onExit(({ exitCode }) => {
      terminal.pty = undefined;
      terminal.code = exitCode;
      for (const subscriber of terminal.subscribers) subscriber({ type: 'exit', code: exitCode });
    });
    return { terminal_id };
  }

  private get(terminal_id: string): Terminal {
    const terminal = this.entries.get(terminal_id);
    requireThat(terminal, 'not_found', `Terminal ${terminal_id} not found`);
    return terminal;
  }

  write(terminal_id: string, data: string): void {
    const terminal = this.get(terminal_id);
    requireThat(terminal.pty, 'invalid_state', 'Terminal has exited');
    terminal.pty.write(data);
  }

  resize(terminal_id: string, cols: number, rows: number): void {
    const terminal = this.get(terminal_id);
    requireThat(terminal.pty, 'invalid_state', 'Terminal has exited');
    terminal.pty.resize(cols, rows);
  }

  close(terminal_id: string): void {
    this.get(terminal_id).pty?.kill();
  }

  subscribe(terminal_id: string, subscriber: (frame: TerminalFrame) => void): () => void {
    const terminal = this.get(terminal_id);
    clearTimeout(terminal.idle);
    terminal.subscribers.add(subscriber);
    if (terminal.replay.length) subscriber(terminal.replay);
    if (terminal.code !== undefined) subscriber({ type: 'exit', code: terminal.code });
    return () => {
      terminal.subscribers.delete(subscriber);
      if (!terminal.subscribers.size) this.armIdle(terminal_id, terminal);
    };
  }

  private armIdle(terminal_id: string, terminal: Terminal): void {
    clearTimeout(terminal.idle);
    if (this.stopped || !this.entries.has(terminal_id)) return;
    terminal.idle = setTimeout(() => {
      terminal.pty?.kill();
      this.entries.delete(terminal_id);
    }, IDLE_MS);
    terminal.idle.unref();
  }

  reapSessions(): void {
    for (const terminal of this.entries.values()) {
      if (!terminal.pty || !terminal.session_id) continue;
      const session = this.store.get<Session>('sessions', terminal.session_id);
      if (!session || session.state === 'closed' || session.outcome) terminal.pty.kill();
    }
  }

  shutdown(): void {
    this.stopped = true;
    for (const terminal of this.entries.values()) {
      clearTimeout(terminal.idle);
      terminal.pty?.kill();
    }
    this.entries.clear();
  }
}
