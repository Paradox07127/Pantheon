import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type Row = {
  task: string;
  condition: string;
  repetition: number;
  mode: string;
  outcome: string;
  hidden_passed: boolean | null;
  turn_error: string | null;
  runtime_version: string;
  playbook_version: string | null;
  policy_version: number | null;
};
type Spec = Record<string, unknown>;
// The tests project only typechecks the scripts it lists, so these modules are imported by URL.
const { runOne }: { runOne(spec: Spec): Promise<Row> } = await import(
  new URL('../eval/lib/run.mjs', import.meta.url).href
);
const fixtureTasks: {
  createRepo(dir: string): void;
  adapters(): unknown[];
  leadRuntime: string;
  task(behaviour: string, repo: string): unknown;
  gate: unknown;
  hiddenCheck(tree: string): boolean;
} = await import(new URL('../eval/lib/fixture-tasks.mjs', import.meta.url).href);

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const dirs: string[] = [];
const fresh = (parent: string) => {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'eval-runner-'));
  dirs.push(dir);
  return dir;
};
const evalRun = (...args: string[]) => {
  const out = fresh(os.tmpdir());
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/eval.mjs'), 'run', '--runtime', 'fixture', '--out', out, ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const rows = fs.existsSync(path.join(out, 'runs.jsonl'))
    ? fs
        .readFileSync(path.join(out, 'runs.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];
  return { ...result, rows };
};
const count = (rows: Row[], condition: string, test: (row: Row) => boolean) =>
  rows.filter((row) => row.condition === condition && test(row)).length;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a fixture eval run', () => {
  it('writes bare and dispatch rows in A B, B A order that meet the known answers', () => {
    const { status, stderr, rows } = evalRun('--condition', 'bare', '--condition', 'dispatch');
    expect(status, stderr).toBe(0);
    const tasks = [...new Set(rows.map((row) => row.task))];
    expect(tasks).toHaveLength(7);
    expect(rows.map((row) => row.condition)).toEqual(
      tasks.flatMap((_, index) => (index % 2 ? ['dispatch', 'bare'] : ['bare', 'dispatch'])),
    );
    expect(new Set(rows.map((row) => `${row.condition} ${row.mode}`))).toEqual(
      new Set(['bare bare', 'dispatch dispatch']),
    );
    expect(new Set(rows.map((row) => row.runtime_version))).toEqual(new Set(['1']));
    // The fixture's done report is a Pantheon tool, which a bare session does not have.
    expect(
      rows.find((row) => row.condition === 'bare' && row.task === 'completes_correctly'),
    ).toMatchObject({
      outcome: 'merged',
      hidden_passed: true,
      turn_error: expect.stringMatching(/no Pantheon MCP server/),
    });
    expect(
      rows.filter((row) => row.condition === 'dispatch').map((row) => row.policy_version),
    ).toEqual(Array(7).fill(0));
  }, 600000);

  it('tags the rows of a real lead with each playbook version it compares', () => {
    const { status, stderr, rows } = evalRun(
      '--lead',
      'real',
      '--condition',
      'playbook=v1',
      '--condition',
      'playbook=v2',
    );
    expect(status, stderr).toBe(0);
    for (const version of ['v1', 'v2']) {
      const condition = `playbook=${version}`;
      expect(rows.filter((row) => row.condition === condition)).toHaveLength(7);
      expect(count(rows, condition, (row) => row.playbook_version === version)).toBe(7);
      // The lead planned and dispatched each goal, so the runs end as the scripted lead's do.
      expect(count(rows, condition, (row) => row.outcome === 'merged')).toBe(3);
      expect(count(rows, condition, (row) => row.hidden_passed === false)).toBe(1);
    }
  }, 600000);
});

describe('one dispatch run', () => {
  it('sets the condition policy before the run and records its version', async () => {
    const workspace = fresh(path.join(repoRoot, 'node_modules/.cache'));
    const row = await runOne({
      workspace,
      createRepo: fixtureTasks.createRepo,
      adapters: fixtureTasks.adapters(),
      leadRuntime: fixtureTasks.leadRuntime,
      task: fixtureTasks.task('completes_correctly', path.join(workspace, 'repo')),
      gate: fixtureTasks.gate,
      condition: {
        name: 'milestone_wake',
        mode: 'dispatch',
        lead: 'scripted',
        before_merge: [],
        policy: { acceptance_wake: 'milestone' },
      },
      hiddenCheck: fixtureTasks.hiddenCheck,
      settleMs: 60000,
      quietMs: 2000,
    });
    expect(row).toMatchObject({ outcome: 'merged', hidden_passed: true, playbook_version: null });
    expect(row.policy_version).toBeGreaterThan(0);
  }, 120000);
});
