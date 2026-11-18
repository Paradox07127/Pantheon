import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';
import { runCommands } from './check.mjs';

// Scripted task behaviours on the fixture runtime; what each one leaves on main is known,
// so the runs check the runner and the report rather than measure a model.
const FILE = 'greeting.txt';
const EXPECTED = 'hello';
// The file a task session tries to write into the project's own checkout, outside its worktree.
const ESCAPED = 'outside.txt';
const GOAL = `Write ${EXPECTED} to ${FILE}`;

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const write = (file, text) => ({ write: { path: file, text: `${text}\n` } });
const commit = { commit: GOAL };
const reportDone = { tool: { name: 'report', arguments: { kind: 'done', text: 'Done' } } };

/** What the task session does in its first turn, given the path of the project's repository. */
export const behaviours = {
  completes_correctly: () => [write(FILE, EXPECTED), commit, reportDone],
  ends_without_artifact: () => [{ say: 'Done' }, reportDone],
  writes_wrong_content: () => [write(FILE, 'goodbye'), commit, reportDone],
  leaves_work_uncommitted: () => [write(FILE, EXPECTED), reportDone],
  writes_outside_scope: () => [
    write(FILE, EXPECTED),
    write('notes.txt', 'scratch'),
    commit,
    reportDone,
  ],
  writes_into_source_checkout: (repo) => [
    { write_outside: { path: path.join(repo, ESCAPED), text: 'escaped\n' } },
    write(FILE, EXPECTED),
    commit,
    reportDone,
  ],
  turn_fails: () => [{ fail: 'Usage limit reached' }],
};

/** The conditions a fixture run compares when none is named; the task's acceptance (`test -f`) is in both. */
export const conditions = ['acceptance_only', 'independent_check'];

/** What the runs of each condition must come to; a difference means the runner or the report is wrong. */
export const knownAnswers = {
  acceptance_only: { runs: 7, merged: 3, leaked: 1, leaking: ['writes_wrong_content'] },
  independent_check: { runs: 7, merged: 2, leaked: 0, leaking: [] },
};

export const leadRuntime = new FixtureAdapter().name;

export const adapters = () => [new FixtureAdapter()];

export const gate = [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }];

/** A new repository on main whose one commit holds only a README. */
export function createRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture Tasks');
  git(dir, 'config', 'user.email', 'fixture-tasks@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'Fixture tasks\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
}

/** The plan task for the behaviour, whose script is in its goal. */
export const task = (behaviour, repo) => ({
  goal: `${GOAL}\n${script(...behaviours[behaviour](repo))}`,
  scope: [FILE],
  acceptance: [`test -f ${FILE}`],
});

export const hiddenCheck = (tree) => runCommands([`grep -qx ${EXPECTED} ${FILE}`], tree).ok;
