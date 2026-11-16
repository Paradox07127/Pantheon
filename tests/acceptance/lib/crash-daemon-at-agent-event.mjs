// A daemon process on the caller's data directory with several fake agents: it sends the given
// commands over HTTP and kills itself with SIGKILL at the named failpoint, or when the named
// runtime hands the daemon an agent event of the named kind, before the daemon records it.
import { FixtureAdapter } from '@pantheon/adapters';
import { FakeAgentAdapter } from '../fixtures/fake-agent-adapter.mjs';
import { startFixtureDaemon } from './daemon.mjs';

const config = JSON.parse(process.argv[2]);
let armed = false;
const kill = () => process.kill(process.pid, 'SIGKILL');
const watch = (adapter) => {
  if (config.killOn?.runtime !== adapter.name) return adapter;
  const wrap = (sink) => (event) => {
    if (armed && event.kind === config.killOn.kind) kill();
    sink(event);
  };
  const start = adapter.start.bind(adapter);
  adapter.start = (spec, sink) => start(spec, wrap(sink));
  const resume = adapter.resume;
  if (resume) adapter.resume = (spec, nativeId, sink) => resume(spec, nativeId, wrap(sink));
  return adapter;
};
const fixture = await startFixtureDaemon(
  config.directory,
  [new FixtureAdapter(), ...config.fakeAgents.map((agent) => watch(new FakeAgentAdapter(agent)))],
  {
    intervalMs: 50,
    workspaceRoot: config.workspaceRoot,
    failpoint: (name) => {
      if (armed && name === config.failpoint) kill();
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
  process.stderr.write(
    `The daemon was not killed at ${JSON.stringify(config.killOn ?? config.failpoint)}\n`,
  );
  process.exit(2);
}, config.timeoutMs);
