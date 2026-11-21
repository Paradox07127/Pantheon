// The conditions an eval run compares; each sends the task's goal alone to one session of the runtime.
// plain: a worktree session the user opens in Pantheon.
// adopted: a session the runtime's own CLI opened in the repository, imported into Pantheon and continued there.
// bare: the runtime's own CLI in the repository, outside Pantheon.
export const conditionCatalog = {
  plain: { mode: 'plain' },
  adopted: { mode: 'adopted' },
  bare: { mode: 'bare' },
};

/** The named conditions; an unknown name throws with the list of known names. */
export function parseConditions(names) {
  const unknown = names.filter((name) => !Object.hasOwn(conditionCatalog, name));
  if (unknown.length)
    throw new Error(
      `unknown condition ${unknown.join(', ')}; known conditions: ${Object.keys(conditionCatalog).join(', ')}`,
    );
  return names.map((name) => ({ name, ...conditionCatalog[name] }));
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
