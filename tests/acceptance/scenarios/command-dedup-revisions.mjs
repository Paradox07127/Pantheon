import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { startFixtureDaemon } from '../lib/daemon.mjs';
import { waitFor } from '../lib/event-client.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { createWorkspaceRoot } from '../lib/workspace-root.mjs';

export const title = '去重、并发和过期版本';
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
const CONCURRENT_CREATES = 100;
/** A turn input the fixture runtime runs as these steps. */
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

export async function run({ workspace, evidenceDir }) {
  const adapter = new FixtureAdapter();
  const managed = createWorkspaceRoot('command-dedup-revisions');
  const fixture = await startFixtureDaemon(path.join(workspace, 'daemon'), [adapter], {
    intervalMs: 50,
    workspaceRoot: managed.root,
  });
  const { daemon } = fixture;
  const receipts = [],
    observations = {};
  let projectId, milestoneId, sharedKey, failure, evidence;

  /** One client of the daemon: its own requests, recorded under its name. */
  const client = (name) => ({
    async send(step, body) {
      const response = await fetch(daemon.url + '/v1/commands', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      const entry = {
        client: name,
        step,
        type: body.type,
        command_id: body.command_id,
        idempotency_key: body.idempotency_key,
        expected_revision: body.expected_revision,
        input: body.input,
        status: response.status,
        receipt_id: data.receipt?.id ?? null,
        receipt_revision: data.receipt?.revision ?? null,
        error: data.error ?? null,
        message: data.message ?? null,
      };
      receipts.push(entry);
      return entry;
    },
  });
  const clients = [client('first'), client('second')];
  const call = async (step, type, input, revision = null) => {
    const result = await clients[0].send(step, command(USER_PRINCIPAL_ID, type, input, revision));
    if (result.status !== 200)
      throw new Error(`${step} ${type}: ${result.error} ${result.message}`);
    return result;
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
  const events = async () => {
    const all = [];
    for (let after = 0; ;) {
      const page = await get('events', { after: String(after), project_id: projectId });
      if (page.snapshot_required) throw new Error('Event log no longer reaches the first event');
      if (!page.events.length) return all;
      all.push(...page.events);
      after = page.events.at(-1).sequence;
    }
  };

  try {
    // One project.
    const repo = path.join(workspace, 'repo');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Command Dedup');
    git(repo, 'config', 'user.email', 'command-dedup@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'README.md'), 'Command dedup\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'Initial commit');
    const project = await call('setup', 'project.open', { name: 'Command dedup', roots: [repo] });
    projectId = project.receipt_id;

    // Both clients send the same session.create under one idempotency key, all at once.
    sharedKey = randomUUID();
    const input = {
      project_id: projectId,
      runtime: adapter.name,
      input: script({ say: 'Created once' }),
    };
    const creates = await Promise.all(
      Array.from({ length: CONCURRENT_CREATES }, (_, index) =>
        clients[index % 2].send('concurrent_create', {
          ...command(USER_PRINCIPAL_ID, 'session.create', input, null),
          idempotency_key: sharedKey,
        }),
      ),
    );
    // The same key with a different input.
    const changed = await clients[1].send('changed_input', {
      ...command(
        USER_PRINCIPAL_ID,
        'session.create',
        { ...input, input: script({ say: 'Created twice' }) },
        null,
      ),
      idempotency_key: sharedKey,
    });
    const board = await waitFor(
      async () => {
        const next = await snapshot();
        const sessions = next.sessions.filter((row) => row.project_id === projectId);
        return sessions.length > 0 &&
          sessions.every(
            (row) =>
              row.state !== 'running' &&
              next.session_turns.filter((turn) => turn.session_id === row.id).every(ended),
          )
          ? next
          : false;
      },
      'the created session to settle',
      WAIT_MS,
    );
    const sessions = board.sessions.filter((row) => row.project_id === projectId);
    const opened = (await events()).filter((event) => event.kind === 'session.opened');
    observations.sessions = { created: sessions.length };
    observations.commands = {
      different_input_conflict:
        changed.status === 400 &&
        changed.error === 'conflict' &&
        sessions.length === new Set(creates.map((entry) => entry.receipt_id)).size,
    };
    observations.creates = {
      accepted: creates.filter((entry) => entry.status === 200).length,
      distinct_receipts: [...new Set(creates.map((entry) => entry.receipt_id))],
      session_opened_events: opened.length,
    };

    // The user makes a milestone; both clients revise it from the same revision at the same time.
    const milestone = await call('milestone', 'milestone.create', {
      project_id: projectId,
      title: 'Ship the first slice',
      required_sessions: [sessions[0].id],
      criteria: ['The first slice is merged'],
    });
    milestoneId = milestone.receipt_id;
    const current = (await snapshot()).milestones.find((row) => row.id === milestoneId);
    const revisions = await Promise.all(
      clients.map((each, index) =>
        each.send(
          'stale_revision',
          command(
            USER_PRINCIPAL_ID,
            'milestone.revise',
            {
              milestone_id: milestoneId,
              title: `Ship the first slice, revised by client ${index + 1}`,
              required_sessions: [sessions[0].id],
              criteria: ['The first slice is merged'],
            },
            current.revision,
          ),
        ),
      ),
    );
    const accepted = revisions.filter((entry) => entry.status === 200);
    const rejected = revisions.filter((entry) => entry.status !== 200);
    const after = (await snapshot()).milestones.find((row) => row.id === milestoneId);
    observations.milestones = {
      stale_revision_rejected:
        accepted.length === 1 &&
        rejected.length === 1 &&
        after.revision === current.revision + 1 &&
        after.title === accepted[0].input.title
          ? rejected[0].error
          : revisions.map((entry) => entry.error ?? 'accepted'),
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      evidence = await collectEvidence();
    } catch (error) {
      evidence = { 'collection-error.txt': String(error?.stack ?? error) };
    }
    await fixture.close();
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
    adapters: [`${adapter.name}@${adapter.report.version}`],
  };

  async function collectEvidence() {
    if (!projectId) return { 'command-receipts.json': receipts };
    const board = await snapshot();
    const db = daemon.store.db;
    return {
      'command-receipts.json': receipts,
      'db-snapshot.json': {
        sessions: board.sessions.map(({ id, revision, state, project_id, runtime }) => ({
          id,
          revision,
          state,
          project_id,
          runtime,
        })),
        session_turns: board.session_turns.map(({ id, session_id, state }) => ({
          id,
          session_id,
          state,
        })),
        milestones: board.milestones,
        shared_key_receipts: sharedKey
          ? db
              .prepare('SELECT source_key, input_hash FROM inbox WHERE source_key=?')
              .all(`${USER_PRINCIPAL_ID}:key:${sharedKey}`)
          : [],
        session_opened_events: (await events())
          .filter((event) => event.kind === 'session.opened')
          .map(({ sequence, aggregate_id, causation_id }) => ({
            sequence,
            aggregate_id,
            causation_id,
          })),
      },
      'observations.json': observations,
    };
  }
}
