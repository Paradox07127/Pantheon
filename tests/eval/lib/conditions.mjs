import fs from 'node:fs';
import { playbookVersions } from './playbooks.mjs';

// The conditions an eval run compares. A dispatch condition runs a scripted lead's one-task plan
// with these before_merge steps; the task's own acceptance command runs in every condition.
// A bare condition runs one session of the runtime on the goal alone, outside Pantheon.
export const conditionCatalog = {
  default: { mode: 'dispatch', lead: 'scripted', before_merge: [] },
  acceptance_only: { mode: 'dispatch', lead: 'scripted', before_merge: [] },
  independent_check: {
    mode: 'dispatch',
    lead: 'scripted',
    // The fixture task's expected content; see tests/eval/lib/fixture-tasks.mjs.
    before_merge: [
      {
        id: 'content-check',
        title: 'Content check',
        kind: { type: 'command', command: 'grep -qx hello greeting.txt', timeout_seconds: 30 },
      },
    ],
  },
  dispatch: { mode: 'dispatch', lead: 'scripted', before_merge: [] },
  bare: { mode: 'bare' },
  // A playbook acts on a lead that plans, so its conditions have a real lead.
  ...Object.fromEntries(
    Object.entries(playbookVersions).map(([version, sections]) => [
      `playbook=${version}`,
      { mode: 'dispatch', lead: 'real', before_merge: [], playbook: { version, sections } },
    ]),
  ),
};

// A playbook version the daemon's playbook.export wrote, as {version, sections}.
const PLAYBOOK_FILE = 'playbook=file:';

/** The named conditions; an unknown name throws with the list of known names. */
export function parseConditions(names) {
  const unknown = names.filter(
    (name) => !Object.hasOwn(conditionCatalog, name) && !name.startsWith(PLAYBOOK_FILE),
  );
  if (unknown.length)
    throw new Error(
      `unknown condition ${unknown.join(', ')}; known conditions: ${Object.keys(conditionCatalog).join(', ')}, ${PLAYBOOK_FILE}<path>`,
    );
  return names.map((name) => {
    if (!name.startsWith(PLAYBOOK_FILE)) return { name, ...conditionCatalog[name] };
    const { version, sections } = JSON.parse(
      fs.readFileSync(name.slice(PLAYBOOK_FILE.length), 'utf8'),
    );
    return {
      name,
      mode: 'dispatch',
      lead: 'real',
      before_merge: [],
      playbook: { version, sections },
    };
  });
}

/**
 * Every task under every condition, repetition by repetition in task order. The conditions of
 * repetition r of task i run in the given order when i + r is even and reversed when it is odd,
 * so two conditions alternate A B, B A.
 */
export const jobOrder = (tasks, conditions, repetitions) =>
  Array.from({ length: repetitions }, (_, repetition) =>
    tasks.flatMap((task, index) =>
      ((index + repetition) % 2 ? [...conditions].reverse() : conditions).map((condition) => ({
        task,
        condition,
        repetition,
      })),
    ),
  ).flat();
