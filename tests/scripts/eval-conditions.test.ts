import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Condition = {
  name: string;
  mode: string;
};
type Job<T> = { task: T; condition: Condition; repetition: number };
// The tests project only typechecks the scripts it lists, so this module is imported by URL.
const {
  jobOrder,
  parseConditions,
}: {
  jobOrder<T>(tasks: T[], conditions: Condition[], repetitions: number): Job<T>[];
  parseConditions(names: string[]): Condition[];
} = await import(new URL('../eval/lib/conditions.mjs', import.meta.url).href);

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const evalRun = (...args: string[]) =>
  spawnSync(process.execPath, [path.join(repoRoot, 'scripts/eval.mjs'), 'run', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
const outside = path.join(os.homedir(), '.pantheon-eval');

describe('the order of eval jobs', () => {
  it('alternates two conditions as A B, B A, B A, A B over tasks and repetitions', () => {
    const jobs = jobOrder(['one', 'two'], parseConditions(['plain', 'bare']), 2);
    expect(jobs.map((job) => [job.task, job.repetition, job.condition.name])).toEqual([
      ['one', 0, 'plain'],
      ['one', 0, 'bare'],
      ['two', 0, 'bare'],
      ['two', 0, 'plain'],
      ['one', 1, 'bare'],
      ['one', 1, 'plain'],
      ['two', 1, 'plain'],
      ['two', 1, 'bare'],
    ]);
  });

  it('gives one job per task and repetition, in task order, for one condition', () => {
    const jobs = jobOrder(['one', 'two', 'three'], parseConditions(['plain']), 2);
    expect(jobs.map((job) => [job.task, job.repetition, job.condition.name])).toEqual([
      ['one', 0, 'plain'],
      ['two', 0, 'plain'],
      ['three', 0, 'plain'],
      ['one', 1, 'plain'],
      ['two', 1, 'plain'],
      ['three', 1, 'plain'],
    ]);
  });
});

describe('eval conditions', () => {
  it('refuses an unknown condition and lists the known ones', () => {
    expect(() => parseConditions(['plain', 'no_such_condition'])).toThrow(
      /no_such_condition.*plain, adopted, bare/,
    );
  });

  it('has a bare condition outside Pantheon', () => {
    expect(parseConditions(['bare'])).toEqual([{ name: 'bare', mode: 'bare' }]);
  });
});

describe('eval run refusals', () => {
  it('refuses more than five real runs without --over-cap', () => {
    const result = evalRun('--runtime', 'codex', '--workspace', outside);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/24 real runs.*--over-cap/);
  });

  it('refuses the adopted condition on a runtime other than codex', () => {
    const result = evalRun('--runtime', 'fixture', '--condition', 'adopted');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/adopted condition needs --runtime codex/);
  });

  it('refuses an unknown condition on the command line', () => {
    const result = evalRun('--runtime', 'fixture', '--condition', 'no_such_condition');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/known conditions: plain, adopted, bare/);
  });
});
