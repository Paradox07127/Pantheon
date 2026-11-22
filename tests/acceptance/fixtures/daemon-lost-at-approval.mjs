// A daemon process on the caller's data directory: it sends the given commands over HTTP and, once
// its store holds a pending approval, prints that row and kills itself with SIGKILL, so no shutdown
// or close runs.
import { FixtureAdapter } from '@pantheon/adapters';
import { startFixtureDaemon } from '../lib/daemon.mjs';

const config = JSON.parse(process.argv[2]);
const fixture = await startFixtureDaemon(config.directory, [new FixtureAdapter()], {
  intervalMs: 50,
  workspaceRoot: config.workspaceRoot,
});
for (const body of config.commands) {
  const result = await fixture.submit(body);
  if (result.status !== 200) {
    process.stderr.write(`${body.type} was refused: ${JSON.stringify(result.data)}\n`);
    process.exit(3);
  }
}
const poll = setInterval(() => {
  const pending = fixture.daemon.store.list('approvals').find((row) => row.state === 'pending');
  if (!pending) return;
  clearInterval(poll);
  process.stdout.write(`${JSON.stringify(pending)}\n`, () => process.kill(process.pid, 'SIGKILL'));
}, 20);
setTimeout(() => {
  process.stderr.write('No approval became pending\n');
  process.exit(2);
}, config.timeoutMs);
