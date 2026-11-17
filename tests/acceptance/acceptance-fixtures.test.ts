import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent } from '@pantheon/domain';
import { eventually } from '../helpers.js';
import { LeadFixtureAdapter, leadAnswers } from './fixtures/lead-fixture-adapter.mjs';
import { createRepoBasic } from './fixtures/repo-basic.mjs';
import { createResearchDoc } from './fixtures/research-doc.mjs';

type RepoBasic = {
  repo: string;
  base_commit: string;
  branches: string[];
  patches: { good: string; bad: string; test_edit: string };
  verifier: { dir: string; script: string };
  hash: string;
};

type ResearchDoc = {
  dir: string;
  sources: { id: string; path: string }[];
  drafts: { complete: string; missing_citation: string };
  citation_pattern: string;
  hash: string;
};

const gitEnv = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: 'Fixture Test',
  GIT_AUTHOR_EMAIL: 'fixture-test@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Test',
  GIT_COMMITTER_EMAIL: 'fixture-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });

const projectTests = (cwd: string) =>
  spawnSync(process.execPath, ['--test'], { cwd, encoding: 'utf8' });

const verify = (fixture: RepoBasic, workspace: string) =>
  spawnSync(process.execPath, [fixture.verifier.script, workspace], { encoding: 'utf8' });

async function withRepoBasic(run: (fixture: RepoBasic, work: string) => Promise<void> | void) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pantheon-repo-basic-'));
  const root = path.join(tmp, 'fixture');
  const work = path.join(tmp, 'work');
  mkdirSync(root);
  mkdirSync(work);
  try {
    await run((await createRepoBasic(root)) as RepoBasic, work);
  } finally {
    const verifierDir = path.join(root, 'verifier');
    if (existsSync(verifierDir)) {
      chmodSync(verifierDir, 0o755);
      for (const name of readdirSync(verifierDir)) chmodSync(path.join(verifierDir, name), 0o644);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

const copyRepo = (fixture: RepoBasic, work: string, name: string) => {
  const copy = path.join(work, name);
  cpSync(fixture.repo, copy, { recursive: true });
  return copy;
};

it('generates the same code repository hash and base commit twice', async () => {
  await withRepoBasic(async (first) => {
    await withRepoBasic((second) => {
      expect(second.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.hash).toBe(first.hash);
      expect(second.base_commit).toBe(first.base_commit);
      expect(git(second.repo, 'branch', '--format=%(refname:short)').stdout.split('\n')).toEqual([
        'conflict-left',
        'conflict-right',
        'main',
        '',
      ]);
    });
  });
});

it('passes the project tests on base while the verifier rejects base', async () => {
  await withRepoBasic((fixture) => {
    expect(git(fixture.repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(fixture.base_commit);
    expect(projectTests(fixture.repo).status).toBe(0);
    expect(verify(fixture, fixture.repo).status).not.toBe(0);
  });
});

it('accepts the good patch, rejects the bad patch and keeps the test edit passing', async () => {
  await withRepoBasic((fixture, work) => {
    const good = copyRepo(fixture, work, 'good');
    expect(git(good, 'apply', fixture.patches.good).status).toBe(0);
    expect(verify(fixture, good).status).toBe(0);

    const bad = copyRepo(fixture, work, 'bad');
    expect(git(bad, 'apply', fixture.patches.bad).status).toBe(0);
    expect(verify(fixture, bad).status, 'verifier exit code after bad.patch').not.toBe(0);

    const editOnBase = copyRepo(fixture, work, 'test-edit-on-base');
    expect(git(editOnBase, 'apply', fixture.patches.test_edit).status).toBe(0);
    expect(projectTests(editOnBase).status).toBe(0);

    expect(git(good, 'apply', fixture.patches.test_edit).status).toBe(0);
    const run = projectTests(good);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('counts words separated by tabs and newlines');
  });
});

it('keeps both conflict branches green on their own but conflicting when merged', async () => {
  await withRepoBasic((fixture, work) => {
    const copy = copyRepo(fixture, work, 'merge');
    const [left, right] = fixture.branches;
    for (const branch of [left!, right!]) {
      expect(git(copy, 'switch', '-q', branch).status).toBe(0);
      expect(projectTests(copy).status).toBe(0);
    }
    const merge = git(copy, 'merge', '--no-edit', left!);
    expect(merge.status).not.toBe(0);
    expect(merge.stdout).toContain('CONFLICT');
  });
});

// Root writes into a read-only directory, so the mode cannot be observed this way.
it.skipIf(process.getuid?.() === 0)('makes the verifier directory read-only', async () => {
  await withRepoBasic((fixture) => {
    expect(() => writeFileSync(path.join(fixture.verifier.dir, 'extra.mjs'), '')).toThrow(
      expect.objectContaining({ code: 'EACCES' }),
    );
  });
});

async function withResearchDoc(run: (fixture: ResearchDoc, root: string) => Promise<void> | void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-research-doc-'));
  try {
    await run((await createResearchDoc(root)) as ResearchDoc, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('generates the same research document hash twice without any git directory', async () => {
  await withResearchDoc(async (first, firstRoot) => {
    await withResearchDoc((second) => {
      expect(second.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.hash).toBe(first.hash);
    });
    const entries = readdirSync(firstRoot, { recursive: true }) as string[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((entry) => path.basename(entry) === '.git')).toEqual([]);
  });
});

it('finds every citation of the complete draft verbatim and misses one in the other draft', async () => {
  await withResearchDoc((fixture) => {
    const citationsFound = (draft: string) =>
      [...readFileSync(draft, 'utf8').matchAll(new RegExp(fixture.citation_pattern, 'g'))].map(
        ([, id, quote]) => {
          const source = fixture.sources.find((s) => s.id === id);
          return source !== undefined && readFileSync(source.path, 'utf8').includes(quote!);
        },
      );

    const complete = citationsFound(fixture.drafts.complete);
    expect(complete.length).toBeGreaterThan(0);
    expect(complete.every(Boolean)).toBe(true);

    const missing = citationsFound(fixture.drafts.missing_citation);
    expect(missing.length).toBe(complete.length);
    expect(missing.some((found) => !found)).toBe(true);
  });
});

const LEAD = 'lead-session';
const digest = (...lines: string[]) =>
  ['[Pantheon] Board updates since your last message:', ...lines].join('\n');
const heldEdit = (editId: string) =>
  `What happened: the user asks to change tasks that have open sessions (edit ${editId}):`;
const doneNote = (id: string, title: string) =>
  `What happened: Task ${id} "${title}" sent a done report, status done: "${title} is finished".`;
const CODE = { id: 'code', title: 'Add the export command', session_ids: ['code-session'] };
const NOTES = {
  id: 'notes',
  title: 'Write the export notes',
  done_when: 'report',
  session_ids: ['notes-session'],
};
const CLEANUP = {
  id: 'cleanup',
  title: 'Remove the old exporter',
  session_ids: ['cleanup-session'],
};
const projectRead = (states: Record<string, string>, milestones: unknown[] = []) => ({
  project: { id: 'notes-project' },
  plans: [
    {
      lead_session_id: LEAD,
      plan_version: 4,
      tasks: [CODE, NOTES, CLEANUP].map((task) => ({
        ...task,
        state: states[task.id] ?? 'active',
      })),
    },
  ],
  milestones,
});
const exportMilestone = (owner: string, status: string, reasons: string[] = []) => ({
  milestone: {
    id: `${owner}-export`,
    key: 'export',
    owner_session_id: owner,
    task_ids: ['code', 'notes'],
  },
  status,
  reasons,
});
const acceptNotes = {
  tool: {
    name: 'accept_task',
    arguments: {
      project_id: 'notes-project',
      task_id: 'notes',
      evidence: 'Write the export notes is finished',
    },
  },
};
const acceptExport = {
  tool: {
    name: 'milestone_accept',
    arguments: { milestone_id: 'export', evidence_refs: ['session:code-session', 'task:notes'] },
  },
};

it('applies every user edit that waits for the lead in one edit_board call on the read plan version', async () => {
  const input = digest(
    heldEdit('edit-7'),
    '- make task cleanup depend on code',
    'What happened: Task cleanup "Remove the old exporter": The session waits for the user to answer a permission request.',
    heldEdit('edit-8'),
    '- set model fixture-large of task cleanup',
  );
  expect(await leadAnswers(input, async () => projectRead({}), LEAD)).toEqual([
    {
      tool: {
        name: 'edit_board',
        arguments: {
          project_id: 'notes-project',
          base_version: 4,
          ops: [
            { type: 'resolve_edit', edit_id: 'edit-7', decision: 'apply' },
            { type: 'resolve_edit', edit_id: 'edit-8', decision: 'apply' },
          ],
        },
      },
    },
  ]);
});

it('accepts a report task on the done report in its notes and leaves other done reports alone', async () => {
  const input = digest(
    doneNote('code', 'Add the export command'),
    doneNote('notes', 'Write the export notes'),
  );
  expect(await leadAnswers(input, async () => projectRead({}), LEAD)).toEqual([acceptNotes]);
});

it.each([
  [
    'after the merge of its last task',
    digest(
      'What happened: Task code "Add the export command" session code-session merged into main at c0ffee1.',
    ),
    projectRead({ code: 'done', notes: 'done' }, [
      exportMilestone('other-lead', 'ready_for_acceptance'),
      exportMilestone(LEAD, 'ready_for_acceptance'),
    ]),
    [acceptExport],
  ],
  [
    'once the report task the lead accepts was the last',
    digest(doneNote('notes', 'Write the export notes')),
    projectRead({ code: 'done' }, [
      exportMilestone(LEAD, 'active', ['task:notes:active', 'session:notes-session:open']),
    ]),
    [acceptNotes, acceptExport],
  ],
])('accepts its own milestone that waits for acceptance %s', async (_, input, read, steps) => {
  expect(await leadAnswers(input, async () => read, LEAD)).toEqual(steps);
});

it('runs a lead turn that carries a fixture script as the script says, notes and all', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'pantheon-lead-fixture-'));
  const adapter = new LeadFixtureAdapter();
  const events: AgentEvent[] = [];
  // Without a Pantheon MCP server any read of the project would fail the send.
  const handle = await adapter.start(
    {
      platform_session_id: LEAD,
      project_id: 'notes-project',
      runtime: 'fixture',
      device_id: 'local',
      role: 'lead',
      cwd,
      env_allowlist: NATIVE_ENV_ALLOWLIST,
      skills: [],
      mcp_servers: [],
      budget: { max_turns: 1, wall_time_ms: 10000 },
    },
    (event) => void events.push(event),
  );
  try {
    const input = digest(
      heldEdit('edit-7'),
      'fixture-script',
      JSON.stringify([{ say: 'as scripted' }]),
    );
    expect(await adapter.send(handle, { turn_id: 'scripted', input })).toMatchObject({
      status: 'delivered',
    });
    await eventually(() => events.some((e) => e.kind === 'turn.completed'), undefined, 10000);
    expect(
      events.filter((e) => e.kind !== 'session.started' && e.kind !== 'usage.updated'),
    ).toEqual([
      expect.objectContaining({ kind: 'message.delta', text: 'as scripted' }),
      expect.objectContaining({ kind: 'turn.completed', status: 'completed' }),
    ]);
  } finally {
    await adapter.close(handle, Date.now() + 10000);
    rmSync(cwd, { recursive: true, force: true });
  }
});
