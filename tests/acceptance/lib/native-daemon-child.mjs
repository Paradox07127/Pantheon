// A daemon with the Claude and Codex adapters in its own process, on the caller's workspace. It
// prints its url and token as one JSON line. The line "crash" on stdin makes it kill itself with
// SIGKILL, so no shutdown runs; the end of stdin closes it.
import { createInterface } from 'node:readline';
import { ClaudeAdapter, CodexAdapter } from '@pantheon/adapters';
import { startNativeDaemon } from './daemon.mjs';

const config = JSON.parse(process.argv[2]);
const fixture = await startNativeDaemon(
  config.workspace,
  [
    new ClaudeAdapter('claude', config.versions.claude),
    new CodexAdapter('codex', config.versions.codex),
  ],
  { intervalMs: config.intervalMs },
);
process.stdout.write(
  JSON.stringify({ url: fixture.daemon.url, token: fixture.daemon.token }) + '\n',
);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line === 'crash') process.kill(process.pid, 'SIGKILL');
});
lines.on('close', () => {
  fixture.close().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(String(error?.stack ?? error));
      process.exit(1);
    },
  );
});
