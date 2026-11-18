import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const gitEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const git = (repoRoot, args) =>
  execFileSync('git', args, { cwd: repoRoot, env: gitEnv(), maxBuffer: Infinity });

/** Writes the tree of the commit into the empty directory dir. */
export function materialize(repoRoot, commit, dir) {
  execFileSync('tar', ['-x', '-C', dir], { input: git(repoRoot, ['archive', commit]) });
}

/** Writes the task's hidden files, as they are at its source commit, over the tree in dir. */
export function overlayHidden(repoRoot, task, dir) {
  for (const file of task.hidden_files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, git(repoRoot, ['show', `${task.source_commit}:${file}`]));
  }
}

/** Runs the commands in order in dir and stops at the first that fails; output is what they printed. */
export function runCommands(commands, dir) {
  let output = '';
  for (const command of commands) {
    const result = spawnSync('sh', ['-c', command], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: Infinity,
    });
    output += `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) return { ok: false, output };
  }
  return { ok: true, output };
}

/**
 * Whether the task's hidden check fails on its base commit and passes on its source commit.
 * base is 'broken' when a command before the last one fails there. The commits are read from history.
 */
export function checkTask(repoRoot, history, task) {
  // The trees stay out of the system temporary directory: the product refuses managed
  // workspaces there, and the tests under check create them below their working directory.
  const work = path.join(repoRoot, '.eval-work');
  fs.mkdirSync(work, { recursive: true });
  const temp = fs.mkdtempSync(path.join(work, `check-${task.name}-`));
  try {
    const run = (commit, side) => {
      const dir = path.join(temp, side);
      fs.mkdirSync(dir);
      materialize(history, commit, dir);
      overlayHidden(history, task, dir);
      // The last command is the check itself; one before it that fails means the check never ran.
      const setup = runCommands(task.hidden_check.slice(0, -1), dir);
      if (!setup.ok) return { ...setup, reached: false };
      return { ...runCommands(task.hidden_check.slice(-1), dir), reached: true };
    };
    const base = run(task.base_commit, 'base');
    const source = run(task.source_commit, 'source');
    return {
      name: task.name,
      base: base.ok ? 'green' : base.reached ? 'red' : 'broken',
      source: source.ok ? 'green' : 'red',
      ok: !base.ok && base.reached && source.ok,
      output: [base.ok || !base.reached ? base.output : '', source.ok ? '' : source.output].join(
        '',
      ),
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
