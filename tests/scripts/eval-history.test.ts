import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const checkout = path.resolve(import.meta.dirname, '../..');
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && key !== 'PANTHEON_EVAL_HISTORY',
  ),
);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  }).trim();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A bundle with a base commit and a source commit that adds the file its hidden check needs, and
 * a project, holding the eval script and one task on those commits, whose history lacks both.
 */
const setup = (sourceCommit?: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-history-'));
  roots.push(root);
  const old = path.join(root, 'old');
  fs.mkdirSync(old);
  git(old, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(old, 'readme.txt'), 'base\n');
  git(old, 'add', '-A');
  git(old, 'commit', '-q', '-m', 'Base');
  const base = git(old, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(old, 'feature.txt'), 'feature\n');
  fs.writeFileSync(path.join(old, 'check.sh'), 'test -f feature.txt\n');
  git(old, 'add', '-A');
  git(old, 'commit', '-q', '-m', 'Source');
  const source = git(old, 'rev-parse', 'HEAD');
  const bundle = path.join(root, 'history.bundle');
  git(old, 'bundle', 'create', '-q', bundle, 'main');

  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(checkout, 'scripts/eval.mjs'), path.join(project, 'scripts/eval.mjs'));
  fs.cpSync(path.join(checkout, 'tests/eval/lib'), path.join(project, 'tests/eval/lib'), {
    recursive: true,
  });
  const taskDir = path.join(project, 'tests/eval/tasks/adds-feature');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.json'),
    JSON.stringify({
      name: 'adds-feature',
      source_commit: sourceCommit ?? source,
      base_commit: base,
      goal: 'Add the feature file.',
      scope: ['feature.txt'],
      acceptance: ['true'],
      hidden_files: ['check.sh'],
      hidden_check: ['sh check.sh'],
    }),
  );
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'Project');
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(project, 'scripts/eval.mjs'), ...args], {
      cwd: project,
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  return { root, base, source, bundle, run };
};

describe('eval history', () => {
  it('refuses check when a frozen commit is missing, naming the task, the commit and PANTHEON_EVAL_HISTORY', () => {
    const { base, run } = setup();
    const result = run(['check']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('adds-feature');
    expect(result.stderr).toContain(base);
    expect(result.stderr).toContain('PANTHEON_EVAL_HISTORY');
    expect(result.stderr).not.toContain('not a tree object');
  });

  it('checks the task against a history repository built from the bundle', () => {
    const { root, bundle, run } = setup();
    const history = path.join(root, 'history.git');
    const built = run(['history', bundle, history]);
    expect(built.stderr).toBe('');
    expect(built.status).toBe(0);
    expect(built.stdout).toContain(history);
    expect(built.stdout).toContain('PANTHEON_EVAL_HISTORY');
    const result = run(['check'], { PANTHEON_EVAL_HISTORY: history });
    expect(result.stdout).toContain('adds-feature: base red, source green');
    expect(result.status).toBe(0);
  });

  it('refuses a history target directory that is not empty', () => {
    const { root, bundle, run } = setup();
    const history = path.join(root, 'history.git');
    fs.mkdirSync(history);
    fs.writeFileSync(path.join(history, 'kept.txt'), 'kept\n');
    const result = run(['history', bundle, history]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(history);
    expect(fs.readdirSync(history)).toEqual(['kept.txt']);
  });

  it('lists a task commit that the bundle lacks', () => {
    const missing = 'f'.repeat(40);
    const { root, bundle, run } = setup(missing);
    const result = run(['history', bundle, path.join(root, 'history.git')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`adds-feature`);
    expect(result.stderr).toContain(missing);
  });
});
