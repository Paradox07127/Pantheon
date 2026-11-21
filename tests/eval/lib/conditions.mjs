// The conditions an eval run compares. A dispatch condition runs a scripted lead's one-task plan;
// the task's own acceptance command runs in every condition.
// A bare condition runs one session of the runtime on the goal alone, outside Pantheon.
export const conditionCatalog = {
  default: { mode: 'dispatch', lead: 'scripted' },
  acceptance_only: { mode: 'dispatch', lead: 'scripted' },
  dispatch: { mode: 'dispatch', lead: 'scripted' },
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
