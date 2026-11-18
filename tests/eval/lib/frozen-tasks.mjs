import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { FixtureAdapter } from '@pantheon/adapters';
import { materialize, overlayHidden, runCommands } from './check.mjs';

// The frozen tasks under tests/eval/tasks, run on a runtime the caller names.

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const reportDone = { tool: { name: 'report', arguments: { kind: 'done', text: 'Done' } } };

export const gate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];

/** Creates, in dir, a repository on main whose one commit holds the tree of the task's base commit. */
export const createRepo = (repoRoot, task) => (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  materialize(repoRoot, task.base_commit, dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Frozen Tasks');
  git(dir, 'config', 'user.email', 'frozen-tasks@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  // The product copies the checkout's node_modules into each worktree and gate candidate;
  // its gate sandbox refuses an install.
  const install = runCommands(['pnpm install --frozen-lockfile'], dir);
  if (!install.ok) throw new Error(`pnpm install failed in ${dir}:\n${install.output}`);
};

/** The plan task of the frozen task, run on the runtime and, when given, the model. */
export const planTask = (task, runtime, model) => ({
  goal: task.goal,
  scope: task.scope,
  acceptance: task.acceptance,
  runtime,
  ...(model ? { model } : {}),
});

export const hiddenCheck = (repoRoot, task) => (tree) => {
  overlayHidden(repoRoot, task, tree);
  return runCommands(task.hidden_check, tree).ok;
};

/** The fixture runtime under the name `reference`, whose first turn of each session runs the steps. */
class ReferenceAdapter extends FixtureAdapter {
  name = 'reference';
  #steps;
  #started = new Set();

  constructor(steps) {
    super();
    this.#steps = steps;
  }

  async send(handle, turn) {
    const session = handle.platform_session_id;
    const first = !this.#started.has(session);
    this.#started.add(session);
    return super.send(handle, first ? { ...turn, input: script(...this.#steps) } : turn);
  }
}

/** Writes every file of the task's scope as it is at the source commit, commits, and reports done. */
export const referenceAdapter = (repoRoot, task) =>
  new ReferenceAdapter([
    ...task.scope.map((file) => ({
      write: { path: file, text: git(repoRoot, 'show', `${task.source_commit}:${file}`) },
    })),
    { commit: 'Apply the source commit' },
    reportDone,
  ]);
