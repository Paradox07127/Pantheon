import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { AgentEventSink, SessionHandle, SessionSpec } from '@pantheon/domain';

type Row = {
  task: string;
  condition: string;
  repetition: number;
  mode: string;
  outcome: string;
  hidden_passed: boolean | null;
  turn_error: string | null;
  runtime_version: string;
  wall_ms: number;
  title: string | null;
  title_ms: number | null;
  workspace_kind: string | null;
  model_requested: string | null;
  effort_requested: string | null;
};
type Spec = Record<string, unknown>;
// The tests project only typechecks the scripts it lists, so these modules are imported by URL.
const { runOne }: { runOne(spec: Spec): Promise<Row> } = await import(
  new URL('../eval/lib/run.mjs', import.meta.url).href
);
const fixtureTasks: {
  createRepo(dir: string): void;
  adapters(): unknown[];
  goal(behaviour: string, repo: string): string;
  hiddenCheck(tree: string): { ok: boolean; output: string };
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
  it('writes one plain and one bare row per task that meet the known answers', () => {
    const { status, stderr, rows } = evalRun();
    expect(status, stderr).toBe(0);
    expect(new Set(rows.map((row) => row.task)).size).toBe(7);
    expect(new Set(rows.map((row) => `${row.condition} ${row.mode}`))).toEqual(
      new Set(['plain plain', 'bare bare']),
    );
    expect(new Set(rows.map((row) => row.runtime_version))).toEqual(new Set(['1']));
    expect(rows.filter((row) => row.task === 'completes_correctly')).toEqual([
      expect.objectContaining({ outcome: 'changed', hidden_passed: true, turn_error: null }),
      expect.objectContaining({ outcome: 'changed', hidden_passed: true, turn_error: null }),
    ]);
  }, 600000);
});

const TITLE_DELAY_MS = 3000;

/** The fixture runtime under its own name, naming a new session some time after its turn ends. */
class TitlingAdapter extends FixtureAdapter {
  name = 'titling-fixture';
  generatesTitles = true;
  async start(spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> {
    return super.start(spec, (event) => {
      emit(event);
      if (event.kind === 'turn.completed' && spec.auto_title)
        setTimeout(
          () =>
            emit({
              key: 'title',
              provider_sequence: 1000,
              kind: 'title.generated',
              title: 'Write the greeting',
            }),
          TITLE_DELAY_MS,
        );
    });
  }
}

describe('one run', () => {
  const run = async (
    mode: string,
    behaviour: string,
    adapters = fixtureTasks.adapters() as FixtureAdapter[],
    choice: { model?: string; effort?: string } = {},
  ) => {
    const workspace = fresh(path.join(repoRoot, 'node_modules/.cache'));
    const logs = fresh(path.join(repoRoot, 'node_modules/.cache'));
    const start = vi.spyOn(adapters[0]!, 'start');
    const row = await runOne({
      workspace,
      logs,
      createRepo: fixtureTasks.createRepo,
      adapters,
      runtime: adapters[0]!.name,
      goal: fixtureTasks.goal(behaviour, path.join(workspace, 'repo')),
      condition: { name: mode, mode },
      hiddenCheck: fixtureTasks.hiddenCheck,
      settleMs: 60000,
      checkouts: [],
      ...choice,
    });
    const spec = start.mock.calls[0]![0] as SessionSpec;
    return { row, spec, repo: fs.realpathSync(path.join(workspace, 'repo')) };
  };
  const gitDir = (cwd: string) =>
    spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
    }).stdout.trim();

  it('bare works in the repository itself, unsandboxed, and the hidden check sees what it left uncommitted', async () => {
    const { row, spec, repo } = await run('bare', 'leaves_work_uncommitted');
    expect(row).toMatchObject({ mode: 'bare', outcome: 'changed', hidden_passed: true });
    expect(fs.realpathSync(spec.cwd)).toBe(repo);
    expect(spec.sandbox).toBeUndefined();
  }, 120000);

  it('plain works where the app puts a new session, the repository itself, and records it in place', async () => {
    const { row, spec, repo } = await run('plain', 'completes_correctly');
    expect(row).toMatchObject({
      mode: 'plain',
      outcome: 'changed',
      hidden_passed: true,
      workspace_kind: 'in_place',
    });
    expect(fs.realpathSync(spec.cwd)).toBe(repo);
    expect(fs.realpathSync(gitDir(spec.cwd))).toBe(path.join(repo, '.git'));
  }, 120000);

  it.each(['plain', 'bare'])(
    '%s starts its session on the model and effort the run names',
    async (mode) => {
      const choice = { model: 'fixture-model', effort: 'low' };
      const { row, spec } = await run(
        mode,
        'completes_correctly',
        fixtureTasks.adapters() as FixtureAdapter[],
        choice,
      );
      expect(spec).toMatchObject(choice);
      expect(row).toMatchObject({ model_requested: 'fixture-model', effort_requested: 'low' });
    },
    120000,
  );

  it('does not wait for a name the runtime never gives a plain session in the project folder', async () => {
    const begun = Date.now();
    const { row } = await run('plain', 'completes_correctly', [new TitlingAdapter()]);
    expect(row).toMatchObject({ mode: 'plain', workspace_kind: 'in_place', title: null });
    // Below the runner's wait for a worktree session's name.
    expect(Date.now() - begun).toBeLessThan(20000);
  }, 120000);

  it('counts a run that leaves nothing as unchanged, without a hidden check', async () => {
    const { row } = await run('plain', 'ends_without_artifact');
    expect(row).toMatchObject({ outcome: 'unchanged', hidden_passed: null });
  }, 120000);
});
