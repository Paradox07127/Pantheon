// Rebuilds the workspace on change and runs the desktop app; the app reloads its daemon after a rebuild.
import { spawn } from 'node:child_process';

const children = [
  ['exec', 'tsc', '-b', '--watch', '--preserveWatchOutput'],
  ['--filter', '@pantheon/desktop', 'dev'],
].map((args) => spawn('pnpm', args, { stdio: ['ignore', 'inherit', 'inherit'] }));

const running = (child) => child.exitCode === null && child.signalCode === null;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) if (running(child)) child.kill(signal);
  });
for (const child of children)
  child.on('exit', (code) => {
    process.exitCode ??= code ?? 1;
    for (const other of children) if (running(other)) other.kill('SIGTERM');
  });
