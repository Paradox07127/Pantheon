import { vi, type Mock } from 'vitest';
import type { TerminalPty } from '@pantheon/control';

export class FakePty implements TerminalPty {
  private data = new Set<(data: string) => void>();
  private exits = new Set<(event: { exitCode: number }) => void>();
  write: Mock<TerminalPty['write']> = vi.fn();
  resize: Mock<TerminalPty['resize']> = vi.fn();
  kill: Mock<TerminalPty['kill']> = vi.fn(() => this.exit(137));
  onData(listener: (data: string) => void) {
    this.data.add(listener);
    return { dispose: () => this.data.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exits.add(listener);
    return { dispose: () => this.exits.delete(listener) };
  }
  output(data: string) {
    for (const listener of this.data) listener(data);
  }
  exit(exitCode: number) {
    for (const listener of this.exits) listener({ exitCode });
  }
}
