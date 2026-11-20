import { useProjectQuery } from './project-read';

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

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
