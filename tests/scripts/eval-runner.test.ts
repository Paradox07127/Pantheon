import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FixtureAdapter } from '@pantheon/adapters';
import type { SessionSpec } from '@pantheon/domain';

type Row = {
  task: string;
  condition: string;
  repetition: number;
  mode: string;
  outcome: string;
  hidden_passed: boolean | null;
  turn_error: string | null;
  runtime_version: string;
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

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a fixture eval run', () => {
  it('writes one bare row per task that meets the known answers', () => {
    const { status, stderr, rows } = evalRun('--condition', 'bare');
    expect(status, stderr).toBe(0);
    expect(new Set(rows.map((row) => row.task)).size).toBe(7);
    expect(new Set(rows.map((row) => `${row.condition} ${row.mode}`))).toEqual(
      new Set(['bare bare']),
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
  }, 600000);
});

describe('one bare run', () => {
  it('cannot read the hidden tests or the frozen commits, and merges what it commits in its worktree', async () => {
    const workspace = fresh(path.join(repoRoot, 'node_modules/.cache'));
    const outside = fresh(path.join(repoRoot, 'node_modules/.cache'));
    const checkout = path.join(outside, 'checkout'),
      history = path.join(outside, 'history');
    const hiddenTest = path.join(checkout, 'tests/eval/tasks/sample/hidden.test.ts'),
      frozenCommit = path.join(history, 'objects/pack/frozen.pack');
    for (const file of [hiddenTest, frozenCommit]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'hidden\n');
    }
    const adapters = fixtureTasks.adapters() as FixtureAdapter[];
    const start = vi.spyOn(adapters[0]!, 'start');
    const row = await runOne({
      workspace,
      createRepo: fixtureTasks.createRepo,
      adapters,
      leadRuntime: fixtureTasks.leadRuntime,
      task: fixtureTasks.task('completes_correctly', path.join(workspace, 'repo')),
      gate: fixtureTasks.gate,
      condition: { name: 'bare', mode: 'bare' },
      hiddenCheck: fixtureTasks.hiddenCheck,
      settleMs: 60000,
      quietMs: 2000,
      checkout,
      history,
    });
    expect(row).toMatchObject({ outcome: 'merged', hidden_passed: true });
    const { sandbox, cwd } = start.mock.calls[0]![0] as SessionSpec;
    const covers = (entry: string, file: string) => file === entry || file.startsWith(`${entry}/`);
    const readable = (file: string) =>
      !sandbox?.protected_entries.some(
        (entry) => entry.deny === 'read_write' && covers(entry.path, fs.realpathSync(file)),
      );
    expect([hiddenTest, frozenCommit].filter(readable)).toEqual([]);
    expect(readable(path.join(workspace, 'repo/README.md'))).toBe(true);
    // The file a commit in the worktree updates for its HEAD.
    const ref = (() => {
      const git = (...args: string[]) =>
        spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
      return path.resolve(
        cwd,
        git('rev-parse', '--git-path', git('symbolic-ref', '-q', 'HEAD') || 'HEAD'),
      );
    })();
    expect(sandbox?.writable_roots.some((root) => covers(root, fs.realpathSync(ref)))).toBe(true);
    expect(
      sandbox?.protected_entries.filter((entry) => covers(entry.path, fs.realpathSync(ref))),
    ).toEqual([]);
  }, 120000);
});
