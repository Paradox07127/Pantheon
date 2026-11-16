import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type Task = {
  name: string;
  source_commit: string;
  base_commit: string;
  goal: string;
  scope: string[];
  acceptance: string[];
  hidden_files: string[];
  hidden_check: string[];
};
// The tests project only typechecks the scripts it lists, so this module is imported by URL.
const { loadTasks }: { loadTasks(root: string, names?: string[]): Task[] } = await import(
  new URL('../eval/lib/tasks.mjs', import.meta.url).href
);

const validTask = (name: string): Task => ({
  name,
  source_commit: 'a'.repeat(40),
  base_commit: 'b'.repeat(40),
  goal: 'Make the step return to pending.',
  scope: ['packages/control/src/workflow-engine.ts'],
  acceptance: ['pnpm install --frozen-lockfile', 'pnpm build'],
  hidden_files: ['tests/control/workflow-steps.test.ts'],
  hidden_check: ['pnpm install --frozen-lockfile', 'pnpm exec vitest run'],
});

const roots: string[] = [];
const taskRoot = (tasks: Record<string, unknown>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-tasks-'));
  roots.push(root);
  for (const [dir, task] of Object.entries(tasks)) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, 'task.json'), JSON.stringify(task));
  }
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('loadTasks', () => {
  it('returns a valid task with its fields as written', () => {
    const task = validTask('step-returns');
    expect(loadTasks(taskRoot({ 'step-returns': task }))).toEqual([task]);
  });

  it('rejects a goal of 401 characters, naming the task directory and the field', () => {
    const root = taskRoot({ 'long-goal': { ...validTask('long-goal'), goal: 'x'.repeat(401) } });
    expect(() => loadTasks(root)).toThrow(/long-goal.*goal/);
  });

  it.each([
    ['a double quote', 'Return the "pending" state.'],
    ['a backslash', 'Split the path at \\ too.'],
    ['a newline', 'Return the step.\nKeep its state.'],
  ])('rejects a goal that holds %s', (_, goal) => {
    const root = taskRoot({ 'escaped-goal': { ...validTask('escaped-goal'), goal } });
    expect(() => loadTasks(root)).toThrow(/escaped-goal.*goal/);
  });

  it('rejects a name that differs from its directory', () => {
    const root = taskRoot({ 'dir-name': validTask('other-name') });
    expect(() => loadTasks(root)).toThrow(/dir-name.*name/);
  });

  it('rejects an empty hidden check', () => {
    const root = taskRoot({ 'no-check': { ...validTask('no-check'), hidden_check: [] } });
    expect(() => loadTasks(root)).toThrow(/no-check.*hidden_check/);
  });

  it('rejects a task name that does not exist', () => {
    const root = taskRoot({ 'step-returns': validTask('step-returns') });
    expect(() => loadTasks(root, ['missing-task'])).toThrow(/missing-task/);
  });
});
