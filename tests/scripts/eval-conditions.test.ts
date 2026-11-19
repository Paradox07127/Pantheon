import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Condition = {
  name: string;
  mode: string;
  lead?: string;
  before_merge?: unknown[];
  playbook?: { version: string; sections: Record<string, string> };
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
    const jobs = jobOrder(['one', 'two'], parseConditions(['default', 'independent_check']), 2);
    expect(jobs.map((job) => [job.task, job.repetition, job.condition.name])).toEqual([
      ['one', 0, 'default'],
      ['one', 0, 'independent_check'],
      ['two', 0, 'independent_check'],
      ['two', 0, 'default'],
      ['one', 1, 'independent_check'],
      ['one', 1, 'default'],
      ['two', 1, 'default'],
      ['two', 1, 'independent_check'],
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
      /no_such_condition.*default, acceptance_only, independent_check/,
    );
  });

  it('carries the before_merge steps of a named condition', () => {
    const [plain, checked] = parseConditions(['acceptance_only', 'independent_check']);
    expect(plain).toMatchObject({ name: 'acceptance_only', mode: 'dispatch', before_merge: [] });
    expect(checked?.before_merge).toHaveLength(1);
  });

  it('has a bare condition with no lead and no merge steps', () => {
    expect(parseConditions(['bare'])).toEqual([{ name: 'bare', mode: 'bare' }]);
  });

  it('gives a playbook version a real lead and the sections it replaces', () => {
    const [first, second] = parseConditions(['playbook=v1', 'playbook=v2']);
    expect(first).toMatchObject({
      mode: 'dispatch',
      lead: 'real',
      playbook: { version: 'v1', sections: {} },
    });
    expect(Object.keys(second?.playbook?.sections ?? {})).toEqual(['replies']);
  });

  it('reads a playbook version exported to a file as a condition with a real lead', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-playbook-')), 'v3.json');
    const sections = { before_you_plan: 'Plan.', routing: '- t1.', replies: '- One line.' };
    fs.writeFileSync(file, JSON.stringify({ version: 3, sections }));
    expect(parseConditions([`playbook=file:${file}`])).toEqual([
      {
        name: `playbook=file:${file}`,
        mode: 'dispatch',
        lead: 'real',
        before_merge: [],
        playbook: { version: 3, sections },
      },
    ]);
  });

  it('refuses a playbook version it does not hold', () => {
    expect(() => parseConditions(['playbook=v0'])).toThrow(/playbook=v0.*playbook=v1/);
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
