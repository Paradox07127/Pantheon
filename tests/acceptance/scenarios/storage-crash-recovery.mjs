import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { startDaemon } from '@pantheon/daemon';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { migrations } from '@pantheon/store';
import { FakeAgentAdapter } from '../fixtures/fake-agent-adapter.mjs';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '持久化原子性与升级恢复';
export const mode = 'integration';

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const WAIT_MS = 30000;
const CRASH_TIMEOUT_MS = 20000;
const OUTBOX_DRAIN_MS = 10000;
const crashChild = fileURLToPath(new URL('../lib/crash-daemon.mjs', import.meta.url));
const passingGate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];
/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Bytes of the database file and its WAL, as hashes; null for a missing file. */
const fileHashes = (file) =>
  Object.fromEntries(
    ['', '-wal'].map((suffix) => [
      `control.sqlite${suffix}`,
      existsSync(file + suffix) ? sha256(readFileSync(file + suffix)) : null,
    ]),
  );
/** Reads a database file without writing to it. */
function inspectDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    return {
      user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
      integrity_check: db
        .prepare('PRAGMA integrity_check')
        .all()
        .map((row) => row.integrity_check),
      tables,
      projects: tables.includes('projects')
        ? db
            .prepare('SELECT id FROM projects ORDER BY rowid')
            .all()
            .map((row) => row.id)
        : [],
      events: tables.includes('events')
        ? Number(db.prepare('SELECT count(*) AS n FROM events').get().n)
        : 0,
    };
  } finally {
    db.close();
  }
}

export async function run({ workspace, evidenceDir }) {
  const dataDir = path.join(workspace, 'daemon');
  const managed = createWorkspaceRoot('storage-crash-recovery');
  const workspaceRoot = managed.root;
  const fakeAgent = { dir: path.join(workspace, 'fake-agent'), script: { turns: [{}] } };
  const adapters = () => [new FixtureAdapter(), new FakeAgentAdapter(fakeAgent)];
  const options = { intervalMs: 50, workspaceRoot };
  let fixture, daemon;
  const rounds = [],
    sequences = [],
    observations = {},
    gate = {};
  let projectId, failure, evidence, migrationProbes;
  let lastEvents = [];

  const start = async () => {
    fixture = await startFixtureDaemon(dataDir, adapters(), options);
    daemon = fixture.daemon;
  };
  const stop = async () => {
    await fixture?.close();
    fixture = undefined;
  };
  const submit = (body) => fixture.submit(body);
  const call = async (type, input, revision = null) => {
    const body = command(USER_PRINCIPAL_ID, type, input, revision);
    const result = await submit(body);
    if (result.status !== 200) throw new Error(`${type}: ${JSON.stringify(result.data)}`);
    return result.data.receipt;
  };
  const get = async (method, params) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const snapshot = () => get('board', { project_id: projectId });
  /** Every event the daemon still holds, read through GET /v1/events. */
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after) });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };
  /** Records whether the log read now keeps every earlier event and only grows in sequence. */
  const checkSequence = async (moment) => {
    const all = await events();
    const increasing = all.every(
      (event, index) => !index || event.sequence > all[index - 1].sequence,
    );
    const ids = new Set(all.map((event) => event.event_id));
    const now = new Map(all.map((event) => [event.sequence, event.event_id]));
    const kept = lastEvents.every((event) => now.get(event.sequence) === event.event_id);
    sequences.push({
      moment,
      count: all.length,
      first: all[0]?.sequence ?? null,
      last: all.at(-1)?.sequence ?? null,
      increasing,
      unique_ids: ids.size === all.length,
      earlier_events_kept: kept,
    });
    lastEvents = all;
    return all;
  };
  const rowExists = (id) =>
    ['sessions', 'session_turns', 'workspaces', 'reviews'].some((table) =>
      daemon.store.get(table, id),
    );
  /** What one command left in the database: all of it or none of it. */
  const commandFootprint = (body) => {
    const db = daemon.store.db;
    const receipts = db
      .prepare('SELECT source_key FROM inbox WHERE source_key IN (?, ?)')
      .all(
        `${USER_PRINCIPAL_ID}:key:${body.idempotency_key}`,
        `${USER_PRINCIPAL_ID}:command:${body.command_id}`,
      )
      .map((row) => row.source_key);
    const caused = db
      .prepare(
        'SELECT sequence, kind, aggregate_id FROM events WHERE causation_id=? ORDER BY sequence',
      )
      .all(body.command_id);
    const missingRows = [...new Set(caused.map((event) => event.aggregate_id))].filter(
      (id) => !rowExists(id),
    );
    const parts = [receipts.length === 2, caused.length > 0];
    const integrity = db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => row.integrity_check);
    return {
      receipts,
      caused_events: caused.map(({ sequence, kind, aggregate_id }) => ({
        sequence,
        kind,
        aggregate_id,
      })),
      missing_rows: missingRows,
      integrity_check: integrity,
      committed: parts.every(Boolean),
      partial:
        receipts.length === 1 ||
        parts.some((part) => part !== parts[0]) ||
        missingRows.length > 0 ||
        integrity.join() !== 'ok',
    };
  };
  /** Artifact files against the reviews that name them: every file referenced, every reference present. */
  const artifactFootprint = () => {
    const directory = path.join(dataDir, 'state', 'artifacts');
    const files = readdirSync(directory).filter(
      (name) => /^[a-f0-9]{64}$/.test(name) || /^\.[a-f0-9-]+\.tmp$/.test(name),
    );
    const referenced = daemon.store
      .list('reviews')
      .map((review) => review.input_hash)
      .filter(Boolean);
    const valid = (hash) =>
      existsSync(path.join(directory, hash)) &&
      sha256(readFileSync(path.join(directory, hash))) === hash;
    return {
      files,
      referenced,
      unreferenced_files: files.filter((name) => !referenced.includes(name)),
      missing_or_invalid: referenced.filter((hash) => !valid(hash)),
      collected: daemon.store
        .events(0, undefined, 100000)
        .filter((event) => event.kind === 'storage.collected')
        .map((event) => event.payload),
    };
  };
  /** Sessions opened by the command, counted by the events the command caused. */
  const sessionsOpenedBy = (body) =>
    daemon.store.db
      .prepare(
        "SELECT DISTINCT aggregate_id FROM events WHERE causation_id=? AND kind='session.opened'",
      )
      .all(body.command_id)
      .map((row) => row.aggregate_id);
  const settle = (ids, description) =>
    waitFor(
      async () => {
        const board = await snapshot();
        const rows = board.sessions.filter((row) => ids.includes(row.id));
        return rows.length === ids.length &&
          rows.every(
            (row) =>
              ['reconciling', 'closed'].includes(row.state) ||
              (row.state === 'open' &&
                board.session_turns.filter((turn) => turn.session_id === row.id).every(ended)),
          )
          ? board
          : false;
      },
      description,
      WAIT_MS,
    );
  /** Runs the commands in a daemon process that the failpoint kills; this process's daemon is stopped first. */
  const crash = async (failpoint, commands) => {
    await stop();
    const marker = randomUUID();
    const child = spawn(
      process.execPath,
      [
        crashChild,
        JSON.stringify({
          directory: dataDir,
          workspaceRoot,
          fakeAgent,
          failpoint,
          commands,
          timeoutMs: CRASH_TIMEOUT_MS,
        }),
        `--crash-marker=${marker}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const [code, signal] = await once(child, 'exit');
    return { failpoint, code, signal, stderr };
  };
  /** One crash of a command at the failpoint, the restart on the same directory and the resends. */
  const crashRound = async (failpoint, type, input, sessionCommand) => {
    const body = command(USER_PRINCIPAL_ID, type, input, null);
    const child = await crash(failpoint, [body]);
    await start();
    const footprint = commandFootprint(body);
    const artifacts = artifactFootprint();
    await checkSequence(`restart after ${failpoint}`);
    const resends = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await submit(body);
      resends.push({
        status: result.status,
        receipt_id: result.data.receipt?.id ?? null,
        error: result.data.error ?? null,
      });
    }
    const opened = sessionsOpenedBy(body);
    const board = await settle(opened, `the sessions after the ${failpoint} crash to settle`);
    const round = {
      failpoint,
      command: { type, command_id: body.command_id, idempotency_key: body.idempotency_key },
      child,
      // The child signals itself only at the failpoint; its stderr may carry Node warnings.
      killed_at_failpoint: child.signal === 'SIGKILL',
      after_restart: footprint,
      artifacts_after_restart: artifacts,
      resends,
      resend_receipts_agree: resends.every(
        (resend) => resend.status === 200 && resend.receipt_id === resends[0].receipt_id,
      ),
      sessions_opened: sessionCommand ? opened.length : null,
      settled_sessions: board.sessions
        .filter((row) => opened.includes(row.id))
        .map((row) => ({ id: row.id, state: row.state, runtime: row.runtime })),
    };
    rounds.push(round);
    return round;
  };
  /** Outbox work after the daemon settled that no turn, session or worktree accounts for. */
  const unaccountedOutbox = async () => {
    const rows = daemon.store.db.prepare('SELECT id, kind, state, payload FROM outbox').all();
    const listed = new Set(
      (await get('needs_you.list', { project_id: projectId })).items
        .filter((item) => item.source?.table === 'sessions')
        .map((item) => item.source.id),
    );
    // A session left reconciling is accounted for only while "needs you" shows it to the user.
    const reconciling = (session) => session?.state === 'reconciling' && listed.has(session.id);
    const unaccounted = [];
    for (const row of rows) {
      if (row.state === 'done') continue;
      const payload = JSON.parse(row.payload);
      if (row.kind === 'session.turn') {
        const turn = daemon.store.get('session_turns', payload.turn_id);
        const session = turn && daemon.store.get('sessions', turn.session_id);
        if (turn && (ended(turn) || reconciling(session))) continue;
        if (turn?.state === 'queued' && row.state === 'pending') continue;
      }
      unaccounted.push({ id: row.id, kind: row.kind, state: row.state, payload });
    }
    for (const turn of daemon.store.list('session_turns')) {
      if (ended(turn)) continue;
      const session = daemon.store.get('sessions', turn.session_id);
      if (reconciling(session)) continue;
      const queuedWork = rows.some(
        (row) =>
          row.kind === 'session.turn' &&
          row.state !== 'done' &&
          JSON.parse(row.payload).turn_id === turn.id,
      );
      if (!queuedWork) unaccounted.push({ turn_id: turn.id, state: turn.state, outbox: 'none' });
    }
    return unaccounted;
  };

  try {
    // A project with a passing gate, on an empty data directory.
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Storage Recovery');
    git(repo, 'config', 'user.email', 'storage-recovery@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Storage recovery\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    await start();
    const project = await call('project.open', { name: 'Storage recovery', roots: [repo] });
    projectId = project.id;
    await call(
      'project.gate.set',
      { project_id: projectId, root: project.roots[0], commands: passingGate },
      project.revision,
    );
    await checkSequence('project opened');

    // Crashes around a session.create, each followed by a restart and resends of the same command.
    for (const [failpoint, runtime] of [
      ['before_transaction_commit', 'fixture'],
      ['after_commit_before_send', 'fixture'],
      ['during_turn_start', 'fixture'],
      ['before_native_running_receipt', 'fake-agent'],
    ])
      await crashRound(
        failpoint,
        'session.create',
        {
          project_id: projectId,
          runtime,
          input: script({ say: `Created before the ${failpoint} crash` }),
        },
        true,
      );

    // A session passes its gate, then commits again.
    const gated = await call('session.create', {
      project_id: projectId,
      runtime: 'fixture',
      input: script({ write: { path: 'gate.txt', text: 'first\n' } }, { commit: 'Add gate.txt' }),
    });
    let board = await settle([gated.id], 'the gated session to commit');
    const sessionRow = () => board.sessions.find((row) => row.id === gated.id);
    /** Sends a turn that commits the file and waits for it to end. */
    const commitOnGated = async (file, text) => {
      board = await snapshot();
      const turns = board.session_turns.filter((turn) => turn.session_id === gated.id).length;
      await call(
        'session.send',
        {
          session_id: gated.id,
          input: script({ write: { path: file, text } }, { commit: `Change ${file}` }),
        },
        sessionRow().revision,
      );
      return waitFor(
        async () => {
          const next = await settle([gated.id], `the gated session to commit ${file}`);
          return next.session_turns.filter((turn) => turn.session_id === gated.id).length > turns
            ? next
            : false;
        },
        `the turn that commits ${file}`,
        WAIT_MS,
      );
    };
    const gateChecks = async () =>
      (await events()).filter(
        (event) => event.kind === 'session.gate_checked' && event.aggregate_id === gated.id,
      );
    await call('session.gates.run', { session_id: gated.id }, sessionRow().revision);
    await waitFor(async () => (await gateChecks()).length === 1, 'the gate run to record', WAIT_MS);
    board = await settle([gated.id], 'the gated session after its gate run');
    gate.preflight_after_gate = await get('session.preflight', { session_id: gated.id });
    gate.story_after_gate = await call('change_story.start', { session_id: gated.id });
    board = await commitOnGated('gate.txt', 'second\n');
    gate.preflight_after_commit = await get('session.preflight', { session_id: gated.id });
    gate.story_after_commit = await call('change_story.start', { session_id: gated.id });
    gate.gate_checked = (await gateChecks()).map((event) => event.payload);
    observations.evidence = {
      gate_record_stale_after_commit:
        gate.preflight_after_gate.gate.last === 'passed' &&
        gate.story_after_gate.context?.checks.state === 'recorded' &&
        gate.preflight_after_commit.gate.last === 'stale' &&
        gate.story_after_commit.context?.checks.state === 'stale',
    };

    // Crashes around the artifact a review request writes; a new commit makes each review input a new file.
    for (const failpoint of ['before_artifact_rename', 'after_artifact_rename_before_db']) {
      board = await commitOnGated(`${failpoint}.txt`, `${failpoint}\n`);
      await crashRound(
        failpoint,
        'review.request',
        { session_id: gated.id, runtimes: ['fixture'] },
        false,
      );
    }
    const artifactsSettled = artifactFootprint();

    // Every session settled; the outbox holds no work nothing accounts for.
    const ids = (await snapshot()).sessions.map((row) => row.id);
    await settle(ids, 'every session to settle');
    await checkSequence('settled');
    // Cleanup jobs such as review.remove run in the background after their session ends.
    await waitFor(
      async () => (await unaccountedOutbox()).length === 0,
      'the outbox to drain',
      OUTBOX_DRAIN_MS,
    ).catch(() => {});
    const unaccounted = await unaccountedOutbox();

    observations.transactions = {
      partial_commit_count:
        rounds.filter((round) => round.after_restart.partial).length +
        rounds.filter(
          (round) =>
            round.artifacts_after_restart.unreferenced_files.length > 0 ||
            round.artifacts_after_restart.missing_or_invalid.length > 0,
        ).length +
        (artifactsSettled.unreferenced_files.length > 0 ||
        artifactsSettled.missing_or_invalid.length > 0
          ? 1
          : 0) +
        rounds.filter((round) => !round.killed_at_failpoint).length,
    };
    const counts = rounds
      .filter((round) => round.sessions_opened !== null)
      .map((round) => round.sessions_opened);
    observations.commands = {
      logical_session_count: counts.every((count) => count === counts[0]) ? counts[0] : counts,
    };
    observations.events = {
      monotonic_sequence: sequences.every(
        (entry) => entry.increasing && entry.unique_ids && entry.earlier_events_kept,
      ),
    };
    observations.outbox = { unaccounted_actions: unaccounted.length };
    gate.unaccounted_outbox = unaccounted;
    gate.artifacts_settled = artifactsSettled;
    await stop();

    // Startup migration of an older schema: failure rolls back or restores, success upgrades, the old build refuses.
    migrationProbes = await migrationRun(path.join(workspace, 'migration'), repo);
    observations.migrations = {
      rollback_and_version_guard_verified: migrationProbes.verified,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (!fixture && projectId) await start();
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await stop();
    managed.remove();
  }
  if (failure) {
    await writeEvidence(evidenceDir, {
      ...evidence,
      'failure.txt': String(failure?.stack ?? failure),
    });
    throw failure;
  }
  return {
    observations,
    evidence,
    adapters: ['fixture@1', 'fake-agent@1'],
  };

  async function collectEvidence() {
    if (!projectId) return { 'failpoint-receipts.json': rounds };
    const all = await events();
    const store = daemon.store;
    return {
      'failpoint-receipts.json': rounds,
      'events.jsonl': all.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'db-snapshot.json': {
        integrity_check: store.db
          .prepare('PRAGMA integrity_check')
          .all()
          .map((row) => row.integrity_check),
        sessions: store.list('sessions').map(({ id, state, runtime, workspace_id, review_id }) => ({
          id,
          state,
          runtime,
          workspace_id,
          review_id,
        })),
        session_turns: store
          .list('session_turns')
          .map(({ id, session_id, state, delivery }) => ({ id, session_id, state, delivery })),
        reviews: store
          .list('reviews')
          .map(({ id, session_id, state, input_hash }) => ({ id, session_id, state, input_hash })),
        outbox: store.db
          .prepare('SELECT id, kind, state, payload FROM outbox ORDER BY rowid')
          .all()
          .map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
        inbox_rows: Number(store.db.prepare('SELECT count(*) AS n FROM inbox').get().n),
        event_sequence_checks: sequences,
        gate_and_story: gate,
      },
      'storage-migration-probes.json': migrationProbes ?? { error: 'not reached' },
      'observations.json': observations,
    };
  }
}

/** Opens an older schema written by an older build, fails two migrations, upgrades, then opens it with the older build. */
async function migrationRun(directory, root) {
  const file = path.join(directory, 'control.sqlite');
  // This build plays the older one; the newer build adds one migration to its schema.
  const older = migrations;
  const newer = [
    ...older,
    {
      version: older.at(-1).version + 1,
      up: (db) => db.exec('CREATE TABLE upgrade_probe (value TEXT) STRICT;'),
    },
  ];
  const latest = newer.at(-1).version;
  const probes = { latest_version: latest, older_version: older.at(-1).version, steps: [] };
  const open = async (known) => {
    try {
      const daemon = await startDaemon({
        directory,
        adapters: [new FixtureAdapter()],
        intervalMs: 600000,
        ...(known ? { storeOptions: { migrations: known } } : {}),
      });
      return { daemon };
    } catch (error) {
      return { error: { code: error.code ?? null, details: error.details ?? null } };
    }
  };
  const backups = () =>
    existsSync(path.join(directory, 'migration-backups'))
      ? readdirSync(path.join(directory, 'migration-backups'))
          .filter((name) => /^control-v\d+-\d+\.sqlite$/.test(name))
          .sort()
      : [];

  // The older build opens an empty directory and records a project.
  const first = await open(older);
  if (!first.daemon) throw new Error(`Older build did not start: ${JSON.stringify(first.error)}`);
  const body = command(USER_PRINCIPAL_ID, 'project.open', {
    name: 'Migrated project',
    roots: [root],
  });
  const response = await fetch(first.daemon.url + '/v1/commands', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${first.daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const projectId = (await response.json()).receipt?.id;
  await first.daemon.close();
  const seeded = inspectDatabase(file);
  probes.steps.push({ step: 'older build wrote', project_id: projectId ?? null, database: seeded });

  // A migration that throws inside the transaction rolls back; one that commits first is restored from the backup.
  const failing = (commitFirst) => [
    ...newer,
    {
      version: latest + 1,
      up(db) {
        db.exec('CREATE TABLE migration_probe (value TEXT) STRICT;');
        if (commitFirst) db.exec(`COMMIT; PRAGMA user_version=${latest + 1};`);
        throw new Error('Injected migration failure');
      },
    },
  ];
  const failures = [];
  for (const [label, commitFirst] of [
    ['rollback', false],
    ['backup', true],
  ]) {
    const before = backups();
    const result = await open(failing(commitFirst));
    if (result.daemon) await result.daemon.close();
    const after = inspectDatabase(file);
    const made = backups().filter((name) => !before.includes(name));
    const backup = made.length
      ? inspectDatabase(path.join(directory, 'migration-backups', made[0]))
      : null;
    const entry = {
      step: `failing migration (${label})`,
      started: Boolean(result.daemon),
      error: result.error ?? null,
      database: after,
      new_backups: made,
      backup,
    };
    entry.restored =
      !result.daemon &&
      result.error?.code === 'migration_failed' &&
      result.error.details?.recovery === label &&
      after.user_version === seeded.user_version &&
      after.integrity_check.join() === 'ok' &&
      JSON.stringify(after.tables) === JSON.stringify(seeded.tables) &&
      JSON.stringify(after.projects) === JSON.stringify(seeded.projects) &&
      after.events === seeded.events &&
      made.length === 1 &&
      backup?.integrity_check.join() === 'ok' &&
      backup?.user_version === seeded.user_version &&
      JSON.stringify(backup?.projects) === JSON.stringify(seeded.projects);
    probes.steps.push(entry);
    failures.push(entry.restored);
  }

  // A damaged copy is refused by the integrity check before any change or backup.
  const damagedDir = path.join(path.dirname(directory), 'migration-damaged');
  await mkdir(damagedDir, { recursive: true });
  const damagedFile = path.join(damagedDir, 'control.sqlite');
  copyFileSync(file, damagedFile);
  const pages = new DatabaseSync(file, { readOnly: true });
  const pageSize = Number(pages.prepare('PRAGMA page_size').get().page_size);
  const rootpage = Number(
    pages.prepare("SELECT rootpage FROM sqlite_schema WHERE name='projects'").get().rootpage,
  );
  pages.close();
  const damaged = readFileSync(damagedFile);
  damaged.fill(0xff, (rootpage - 1) * pageSize, rootpage * pageSize);
  writeFileSync(damagedFile, damaged);
  const damagedBefore = sha256(readFileSync(damagedFile));
  let corrupt;
  try {
    const daemon = await startDaemon({ directory: damagedDir, adapters: [], intervalMs: 600000 });
    await daemon.close();
    corrupt = { started: true };
  } catch (error) {
    corrupt = { started: false, code: error.code ?? null };
  }
  const integrityGuard = {
    step: 'damaged copy',
    ...corrupt,
    unchanged: sha256(readFileSync(damagedFile)) === damagedBefore,
    backups: existsSync(path.join(damagedDir, 'migration-backups'))
      ? readdirSync(path.join(damagedDir, 'migration-backups'))
      : [],
  };
  integrityGuard.refused =
    !corrupt.started &&
    corrupt.code === 'schema_corrupt' &&
    integrityGuard.unchanged &&
    integrityGuard.backups.length === 0;
  probes.steps.push(integrityGuard);

  // The current build migrates the older schema with a backup.
  const before = backups();
  const current = await open(newer);
  let upgraded = { started: Boolean(current.daemon), error: current.error ?? null };
  if (current.daemon) {
    const board = await (
      await fetch(`${current.daemon.url}/v1/board`, {
        headers: { Authorization: `Bearer ${current.daemon.token}` },
      })
    ).json();
    upgraded.board_projects = board.projects.map((row) => row.id);
    await current.daemon.close();
  }
  upgraded = {
    step: 'current build',
    ...upgraded,
    database: inspectDatabase(file),
    new_backups: backups().filter((name) => !before.includes(name)),
  };
  upgraded.migrated =
    upgraded.started &&
    upgraded.database.user_version === latest &&
    upgraded.database.integrity_check.join() === 'ok' &&
    JSON.stringify(upgraded.board_projects) === JSON.stringify(seeded.projects) &&
    upgraded.new_backups.length === 1;
  probes.steps.push(upgraded);

  // The older build refuses the upgraded database without writing a byte.
  const bytesBefore = fileHashes(file);
  const refused = await open(older);
  if (refused.daemon) await refused.daemon.close();
  const guard = {
    step: 'older build after upgrade',
    started: Boolean(refused.daemon),
    error: refused.error ?? null,
    bytes_before: bytesBefore,
    bytes_after: fileHashes(file),
  };
  guard.refused =
    !refused.daemon &&
    refused.error?.code === 'schema_incompatible' &&
    JSON.stringify(guard.bytes_before) === JSON.stringify(guard.bytes_after);
  probes.steps.push(guard);

  probes.verified =
    Boolean(projectId) &&
    failures.every(Boolean) &&
    integrityGuard.refused &&
    upgraded.migrated &&
    guard.refused;
  return probes;
}
