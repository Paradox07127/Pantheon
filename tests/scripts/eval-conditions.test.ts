import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Condition = {
  name: string;
  mode: string;
  lead?: string;
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
    const jobs = jobOrder(['one', 'two'], parseConditions(['default', 'bare']), 2);
    expect(jobs.map((job) => [job.task, job.repetition, job.condition.name])).toEqual([
      ['one', 0, 'default'],
      ['one', 0, 'bare'],
      ['two', 0, 'bare'],
      ['two', 0, 'default'],
      ['one', 1, 'bare'],
      ['one', 1, 'default'],
      ['two', 1, 'default'],
      ['two', 1, 'bare'],
    ]);
  });

  it('gives one job per task and repetition, in task order, for one condition', () => {
    const jobs = jobOrder(['one', 'two', 'three'], parseConditions(['default']), 2);
    expect(jobs.map((job) => [job.task, job.repetition, job.condition.name])).toEqual([
      ['one', 0, 'default'],
      ['two', 0, 'default'],
      ['three', 0, 'default'],
      ['one', 1, 'default'],
      ['two', 1, 'default'],
      ['three', 1, 'default'],
    ]);
  });
});

describe('eval conditions', () => {
  it('refuses an unknown condition and lists the known ones', () => {
    expect(() => parseConditions(['default', 'no_such_condition'])).toThrow(
      /no_such_condition.*default, acceptance_only, dispatch, bare/,
    );
  });

  it('has a bare condition with no lead and no merge steps', () => {
    expect(parseConditions(['bare'])).toEqual([{ name: 'bare', mode: 'bare' }]);
  });
});

describe('eval run refusals', () => {
  it('refuses more than five real runs without --over-cap', () => {
    const result = evalRun('--runtime', 'claude', '--workspace', outside);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/8 real runs.*--over-cap/);
  });

  it('refuses a model naming neither sonnet nor opus', () => {
    const result = evalRun('--runtime', 'claude', '--task', 'a', '--model', 'haiku');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--model haiku names neither sonnet nor opus/);
  });

  it('refuses an unknown condition on the command line', () => {
    const result = evalRun('--runtime', 'fixture', '--condition', 'no_such_condition');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/known conditions: default, acceptance_only/);
  });

  it('refuses a lead other than scripted or real', () => {
    const result = evalRun('--runtime', 'fixture', '--lead', 'planner');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--lead scripted\|real/);
  });
});
