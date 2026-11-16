import fs from 'node:fs';
import path from 'node:path';

const COMMIT = /^[0-9a-f]{40}$/;
const LISTS = ['scope', 'acceptance', 'hidden_files', 'hidden_check'];

function validate(dir, task) {
  const fail = (field, why) => {
    throw new Error(`task ${dir}: ${field} ${why}`);
  };
  if (task.name !== dir) fail('name', 'must equal the directory name');
  for (const field of ['source_commit', 'base_commit']) {
    if (typeof task[field] !== 'string' || !COMMIT.test(task[field]))
      fail(field, 'must be 40 lowercase hex characters');
  }
  if (typeof task.goal !== 'string' || task.goal.length === 0 || task.goal.length > 400)
    fail('goal', 'must be a non-empty string of at most 400 characters');
  // The plan's source quotes the goal verbatim from the lead's JSON input, which escapes these.
  if (/["\\\n]/.test(task.goal))
    fail('goal', 'must not hold a double quote, a backslash or a newline');
  for (const field of LISTS) {
    const list = task[field];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((item) => typeof item === 'string')
    )
      fail(field, 'must be a non-empty array of strings');
  }
  return task;
}

/** The frozen tasks under root, validated; names narrows them, and an unknown name throws. */
export function loadTasks(root, names) {
  const tasks = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      validate(
        entry.name,
        JSON.parse(fs.readFileSync(path.join(root, entry.name, 'task.json'), 'utf8')),
      ),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!names || names.length === 0) return tasks;
  return names.map((name) => {
    const task = tasks.find((candidate) => candidate.name === name);
    if (!task) throw new Error(`no task named ${name} under ${root}`);
    return task;
  });
}
