import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hash = (value) => sha256(JSON.stringify(value));

async function agentRun(root, fixtureRoot, FakeAgentAdapter, startFixtureDaemon) {
  const events = [];
  const adapter = new FakeAgentAdapter({
    dir: path.join(fixtureRoot, 'agent'),
    script: {
      turns: [
        {
          steps: [
            { message: 'Reading the module' },
            {
              tool: {
                name: 'read_file',
                input: { path: 'src/text-stats.mjs' },
                output: 'contents',
              },
            },
            { usage: { input_tokens: 12, output_tokens: 4, context_tokens: 2048 } },
          ],
        },
      ],
    },
  });
  const start = adapter.start.bind(adapter);
  adapter.start = (spec, sink) =>
    start(spec, (event) => {
      events.push(event);
      sink(event);
    });
  const driver = await startFixtureDaemon(path.join(fixtureRoot, 'driver'), [adapter]);
  try {
    const project = await driver.call('project.open', {
      name: 'reproducible-fixture',
      roots: [root],
    });
    const session = driver.daemon.store.insert('sessions', {
      id: randomUUID(),
      revision: 1,
      project_id: project.id,
      runtime: adapter.name,
      device_id: 'local',
      state: 'open',
      turn_count: 0,
    });
    await driver.call(
      'session.send',
      { session_id: session.id, input: 'Read the module' },
      session.revision,
    );
    const deadline = Date.now() + 5000;
    while (!events.some((event) => event.kind === 'turn.completed')) {
      if (Date.now() > deadline)
        throw new Error('Fake agent did not complete its deterministic turn');
      await driver.daemon.control.tick();
      await delay(20);
    }
    const nativeId = events.find((event) => event.kind === 'session.started').native_session_id;
    const ledger = await adapter.ledger(nativeId);
    const { checked_at, ...report } = await adapter.probe();
    return {
      report,
      events: events.map(({ native_session_id, turn_id, ...event }) => event),
      ledger: ledger.map(({ at, pid, marker, native_session_id, turn_id, ...entry }) => entry),
    };
  } finally {
    await driver.close();
  }
}

export async function runFixtures(repository, workspace, userCheckout) {
  const load = (file) => import(pathToFileURL(path.join(repository, file)).href);
  const { createRepoBasic } = await load('tests/acceptance/fixtures/repo-basic.mjs');
  const { FakeAgentAdapter } = await load('tests/acceptance/fixtures/fake-agent-adapter.mjs');
  const { startFixtureDaemon } = await load('tests/acceptance/lib/daemon.mjs');
  const fixtures = {
    'repo-basic': {
      hashes: [],
      runs: [],
      excluded_fields: [],
      hash_source: 'createRepoBasic.hash',
    },
    'fake-agent': {
      hashes: [],
      runs: [],
      excluded_fields: [
        'report.checked_at',
        'events[].native_session_id',
        'events[].turn_id',
        'ledger[].at',
        'ledger[].pid',
        'ledger[].marker',
        'ledger[].native_session_id',
        'ledger[].turn_id',
      ],
    },
  };
  for (let run = 0; run < 2; run++) {
    const dir = path.join(workspace, `run-${run + 1}`);
    await mkdir(dir, { recursive: true });
    const controlFile = userCheckout && path.join(userCheckout, `.fixture-control-${randomUUID()}`);
    try {
      if (controlFile) await writeFile(controlFile, 'Deliberate fixture write\n', { flag: 'wx' });
      const repo = await createRepoBasic(path.join(dir, 'repo-basic'));
      fixtures['repo-basic'].hashes.push(repo.hash);
      fixtures['repo-basic'].runs.push({
        hash: repo.hash,
        base_commit: repo.base_commit,
        branches: repo.branches,
      });
      for (const [name, content] of [
        ['fake-agent', await agentRun(repo.repo, dir, FakeAgentAdapter, startFixtureDaemon)],
      ]) {
        fixtures[name].hashes.push(hash(content));
        fixtures[name].runs.push(content);
      }
    } finally {
      if (controlFile) await rm(controlFile);
    }
  }
  return { fixtures, adapters: ['fake-agent@1'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, workspace, userCheckout] = process.argv.slice(2);
  const manifest = await runFixtures(repository, workspace, userCheckout);
  await writeFile(
    path.join(workspace, 'fixture-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}
