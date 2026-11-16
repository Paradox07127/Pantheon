// A daemon process for crash tests: opens the test's store, runs its commands and ticks until
// the named failpoint kills it with SIGKILL, so no finally block, shutdown or store close runs.
import { setTimeout as sleep } from 'node:timers/promises';
import { FixtureAdapter } from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import { command } from '@pantheon/protocol';
import { ArtifactFiles, Store } from '@pantheon/store';

const scenario = JSON.parse(process.argv[2]);
const store = new Store(scenario.store),
  files = new ArtifactFiles(scenario.artifacts);
const control = new Control(
  store,
  files,
  [new FixtureAdapter(scenario.delay)],
  (name) => {
    if (name === scenario.failpoint) process.kill(process.pid, 'SIGKILL');
  },
  { ...scenario.controlOptions, readProcess: () => undefined },
);
control.recover();
await control.reconcile();
for (const step of scenario.commands) {
  const revision = step.revision_of ? store.must('sessions', step.revision_of).revision : null;
  control.execute(step.principal, command(step.principal.id, step.type, step.input, revision));
}
// A kill point the child checks between ticks: a delivered turn runs under a recorded process.
const runningWithProcess = () =>
  store
    .list('session_turns')
    .some((t) => t.state === 'running' && store.must('sessions', t.session_id).process_identity);
const end = Date.now() + scenario.timeout_ms;
while (Date.now() < end) {
  await control.tick();
  if (scenario.failpoint === 'turn_running_with_process' && runningWithProcess())
    process.kill(process.pid, 'SIGKILL');
  await sleep(10);
}
process.stderr.write(`Failpoint ${scenario.failpoint} was not reached\n`);
process.exit(2);
