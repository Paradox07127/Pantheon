import { useEffect, useState } from 'react';
import type {
  TurnSkill,
  WorkflowDefinition,
  WorkflowLeafStep,
  WorkflowStep,
} from '@pantheon/domain';
import type { WorkflowDefinitionView } from '@pantheon/protocol';
import { useBoard } from './board';
import { runCommand } from './commands';
import {
  readInventory,
  RUNTIMES,
  type ExtensionInventory,
  type ExtensionOverrides,
} from './extensions';
import { failureText } from './needs-you';
import { useProjectQuery } from './project-read';

export type { TurnSkill, WorkflowDefinition, WorkflowLeafStep, WorkflowStep };
export type Slot = keyof WorkflowDefinition['slots'];
export type StepKind = WorkflowStep['kind']['type'];
export type LeafKind = WorkflowLeafStep['kind']['type'];

export const SLOTS: readonly Slot[] = ['before_dispatch', 'before_merge', 'after_merge'];
export const STEP_KINDS: readonly LeafKind[] = ['command', 'approval', 'prompt', 'review'];
/** Kinds that hold other steps; a group's steps are plain steps. */
export const GROUP_KINDS = ['parallel', 'loop'] as const satisfies readonly StepKind[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isDefinition = (value: unknown): value is WorkflowDefinition =>
  isObject(value) &&
  isObject(value.slots) &&
  SLOTS.every((slot) => Array.isArray((value.slots as Record<string, unknown>)[slot]));

export const isDefinitionView = (value: unknown): value is WorkflowDefinitionView =>
  isObject(value) &&
  typeof value.definition_version === 'number' &&
  isDefinition(value.definition) &&
  Array.isArray(value.fixed_steps) &&
  value.fixed_steps.every((step) => isObject(step) && typeof step.id === 'string');

/** The project's default workflow, or the named one of that id. */
export const useWorkflowDefinition = (project_id: string | null, id?: string) =>
  useProjectQuery<WorkflowDefinitionView>(
    'workflow.definition',
    project_id,
    isDefinitionView,
    id ? { id } : undefined,
  );

/** One row of workflow.definition.list. */
export interface WorkflowSummary {
  id: string;
  name: string;
  version: number;
  is_default: boolean;
}

const isWorkflowList = (value: unknown): value is WorkflowSummary[] =>
  Array.isArray(value) &&
  value.every((row) => isObject(row) && typeof row.id === 'string' && typeof row.name === 'string');

/** The project's workflows; the default one is marked. */
export const useWorkflowList = (project_id: string | null) =>
  useProjectQuery<WorkflowSummary[]>(
    'workflow.definition.list',
    project_id,
    isWorkflowList,
    undefined,
    { events: true },
  );

/** The fixed step each slot sits next to, and on which side. */
const SLOT_PLACE: Record<Slot, { step: string; after: boolean }> = {
  before_dispatch: { step: 'dispatch', after: false },
  before_merge: { step: 'merge', after: false },
  after_merge: { step: 'merge', after: true },
};

export type ChartItem = { type: 'fixed'; id: string } | { type: 'slot'; slot: Slot };

/** The fixed steps in the daemon's order with each slot at its place; a slot whose step is missing goes last. */
export function chartItems(fixed: readonly { id: string }[]): ChartItem[] {
  const items: ChartItem[] = [];
  const slotsAt = (id: string, after: boolean) =>
    SLOTS.filter((slot) => SLOT_PLACE[slot].step === id && SLOT_PLACE[slot].after === after).map(
      (slot): ChartItem => ({ type: 'slot', slot }),
    );
  for (const step of fixed)
    items.push(
      ...slotsAt(step.id, false),
      { type: 'fixed', id: step.id },
      ...slotsAt(step.id, true),
    );
  for (const slot of SLOTS)
    if (!items.some((item) => item.type === 'slot' && item.slot === slot))
      items.push({ type: 'slot', slot });
  return items;
}

export const slotOf = (definition: WorkflowDefinition, id: string): Slot | undefined =>
  SLOTS.find((slot) => definition.slots[slot].some((step) => step.id === id));

/** The definition without the step of that id. */
export const removeStep = (definition: WorkflowDefinition, id: string): WorkflowDefinition => ({
  ...definition,
  slots: Object.fromEntries(
    SLOTS.map((slot) => [slot, definition.slots[slot].filter((step) => step.id !== id)]),
  ) as WorkflowDefinition['slots'],
});

/** The definition with the step of the same id changed in place. */
export const replaceStep = (
  definition: WorkflowDefinition,
  step: WorkflowStep,
): WorkflowDefinition => ({
  ...definition,
  slots: Object.fromEntries(
    SLOTS.map((slot) => [slot, definition.slots[slot].map((s) => (s.id === step.id ? step : s))]),
  ) as WorkflowDefinition['slots'],
});

/** The definition with the step taken out of wherever it was and put into the slot at the index. */
export function placeStep(
  definition: WorkflowDefinition,
  step: WorkflowStep,
  slot: Slot,
  index: number,
): WorkflowDefinition {
  const from = slotOf(definition, step.id);
  const at = from === slot ? definition.slots[slot].findIndex((s) => s.id === step.id) : -1;
  const rest = removeStep(definition, step.id);
  const list = rest.slots[slot].slice();
  list.splice(Math.min(at >= 0 && at < index ? index - 1 : index, list.length), 0, step);
  return { ...rest, slots: { ...rest.slots, [slot]: list } };
}

/** The definition with the step one place earlier or later in its slot; at either end it stays. */
export function moveStep(
  definition: WorkflowDefinition,
  id: string,
  by: -1 | 1,
): WorkflowDefinition {
  const slot = slotOf(definition, id);
  if (!slot) return definition;
  const list = definition.slots[slot];
  const from = list.findIndex((step) => step.id === id);
  const to = from + by;
  if (to < 0 || to >= list.length) return definition;
  const next = list.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return { ...definition, slots: { ...definition.slots, [slot]: next } };
}

export type SaveResult =
  | { ok: true; saved: Pick<WorkflowDefinitionView, 'definition' | 'definition_version'> | null }
  | { ok: false; conflict: boolean; error: string };

/**
 * Sends workflow.definition.set; a version conflict means another change landed since the read.
 * Without an id the default workflow is saved; trial_tasks lets only that many next tasks take it.
 */
export async function saveDefinition(
  project_id: string,
  definition: WorkflowDefinition,
  base_version: number,
  options: { id?: string; trial_tasks?: number } = {},
): Promise<SaveResult> {
  const result = await runCommand(
    'workflow.definition.set',
    {
      project_id,
      ...(options.id && { id: options.id }),
      definition,
      base_version,
      ...(options.trial_tasks && { trial_tasks: options.trial_tasks }),
    },
    null,
  );
  if (!result.ok)
    return {
      ok: false,
      conflict: result.error.code === 'version_conflict',
      error: failureText(result.error),
    };
  const value = result.value;
  return {
    ok: true,
    saved:
      isObject(value) &&
      typeof value.definition_version === 'number' &&
      isDefinition(value.definition)
        ? { definition: value.definition, definition_version: value.definition_version }
        : null,
  };
}

/** Copies a workflow, the default one without from_id, under a new name; gives the copy's view. */
export async function saveWorkflowAs(
  project_id: string,
  from_id: string | undefined,
  name: string,
): Promise<{ ok: true; view: WorkflowDefinitionView | null } | { ok: false; error: string }> {
  const result = await runCommand(
    'workflow.definition.save_as',
    { project_id, ...(from_id && { from_id }), name },
    null,
  );
  if (!result.ok) return { ok: false, error: failureText(result.error) };
  return { ok: true, view: isDefinitionView(result.value) ? result.value : null };
}

/** Makes the workflow the one tasks take when they name none. */
export async function setDefaultWorkflow(project_id: string, id: string): Promise<string | null> {
  const result = await runCommand('workflow.definition.set_default', { project_id, id }, null);
  return result.ok ? null : failureText(result.error);
}

type Skill = ExtensionInventory['skills'][number];

/** The runtime's skills the project leaves on, as the daemon checks a saved workflow's skills. */
function leftOn(skills: readonly Skill[], overrides: ExtensionOverrides | undefined): Skill[] {
  if (!overrides) return [...skills];
  const opened = overrides.enabled_user_skills;
  return skills.filter(
    (s) =>
      !overrides.disabled_skills.includes(s.id) &&
      !overrides.disabled_skills.includes(s.name) &&
      !(opened && s.user && !opened.includes(s.id)),
  );
}

/**
 * The skills with a path in any runtime's inventory of the project, less those the project turned
 * off there; reads nothing without a project.
 */
export function useSkillChoices(project_id: string | null): TurnSkill[] {
  const [read, setRead] = useState<{
    project_id: string;
    skills: { runtime: string; skills: Skill[] }[];
  } | null>(null);
  const overrides = useBoard(
    (s) => s.board?.projects.find((p) => p.id === project_id)?.extension_overrides,
  );
  useEffect(() => {
    if (!project_id) return;
    let current = true;
    void Promise.all(
      RUNTIMES.map((runtime) => readInventory(window.pantheon, project_id, runtime)),
    ).then((results) => {
      if (!current) return;
      setRead({
        project_id,
        skills: results.flatMap((result, i) =>
          result.ok ? [{ runtime: RUNTIMES[i]!, skills: result.value.skills }] : [],
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [project_id]);
  if (!project_id || read?.project_id !== project_id) return [];
  const list: TurnSkill[] = [];
  for (const { runtime, skills } of read.skills)
    for (const skill of leftOn(skills, overrides?.[runtime]))
      if (skill.path && !list.some((s) => s.path === skill.path))
        list.push({ name: skill.name, path: skill.path });
  return list;
}
