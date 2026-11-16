// A daemon process on the caller's data directory: it arms the named failpoint, sends the given
// commands over HTTP and kills itself with SIGKILL at the failpoint, so no shutdown or close runs.
import { FixtureAdapter } from '@pantheon/adapters';
import { FakeAgentAdapter } from '../fixtures/fake-agent-adapter.mjs';
import { startFixtureDaemon } from './daemon.mjs';

const config = JSON.parse(process.argv[2]);
let armed = false;
const fixture = await startFixtureDaemon(
  config.directory,
  [new FixtureAdapter(), new FakeAgentAdapter(config.fakeAgent)],
  {
    intervalMs: 50,
    workspaceRoot: config.workspaceRoot,
    failpoint: (name) => {
      if (armed && name === config.failpoint) process.kill(process.pid, 'SIGKILL');
    },
  },
);
armed = true;
for (const body of config.commands) {
  const result = await fixture.submit(body);
  if (result.status !== 200) {
    process.stderr.write(`${body.type} was refused: ${JSON.stringify(result.data)}\n`);
    process.exit(3);
  }
}
setTimeout(() => {
  process.stderr.write(`Failpoint ${config.failpoint} was not reached\n`);
  process.exit(2);
}, config.timeoutMs);
