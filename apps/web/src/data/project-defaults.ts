import { useRef } from 'react';
import { create } from 'zustand';
import type {
  BoardSnapshot,
  BridgeResult,
  ProjectDefaultsRead,
  ProjectSettingKey,
  ProjectSettingOverview,
  ProjectSettingValues,
} from '@pantheon/protocol';
import { useBoard } from './board';
import { runCommand } from './commands';
import type { PolicyPatch, WorkflowPolicy } from './workflow-policy';
import { readQuery, useQuery, type QueryState } from './workbench-sessions';

type Project = BoardSnapshot['projects'][number];
export type { ProjectDefaultsRead, ProjectSettingKey };
export type PolicySettings = ProjectSettingValues['workflow_policy'];
export type SettingOverview<K extends ProjectSettingKey> = Extract<
  ProjectSettingOverview,
  { key: K }
>;

/** Counts the writes made here, so every reader of the global values reads them again. */
const useDefaultsWrites = create<{ count: number }>(() => ({ count: 0 }));

/** Reads the global values again after a command that changed what a project sets itself. */
export const noteSettingWrite = () => useDefaultsWrites.setState((s) => ({ count: s.count + 1 }));

const acceptDefaults = (value: unknown): ProjectDefaultsRead | null => {
  const read = value as Partial<ProjectDefaultsRead> | null;
  return read &&
    Array.isArray(read.settings) &&
    Array.isArray(read.projects) &&
    Array.isArray(read.permission_rules)
    ? (read as ProjectDefaultsRead)
    : null;
};

/** GET /v1/project.defaults, again after each event that can change the board and after each write. */
export function useProjectDefaults(): QueryState<ProjectDefaultsRead> {
  const changed = useBoard((s) => s.changed);
  const writes = useDefaultsWrites((s) => s.count);
  return useQuery('project.defaults', 'all', () => ({}), acceptDefaults, changed + writes);
}

/** The last project.defaults read that succeeded, kept through failed reads; null until one does. */
export function useLastProjectDefaults(): ProjectDefaultsRead | null {
  const { data } = useProjectDefaults();
  const last = useRef<ProjectDefaultsRead | null>(null);
  if (data !== null) last.current = data;
  return last.current;
}

export const settingOf = <K extends ProjectSettingKey>(
  read: ProjectDefaultsRead | null,
  key: K,
): SettingOverview<K> | undefined =>
  read?.settings.find((s) => s.key === key) as SettingOverview<K> | undefined;

async function send(
  type: Parameters<typeof runCommand>[0],
  input: Record<string, unknown>,
  expected: number | null,
) {
  const result = await runCommand(type, input, expected);
  noteSettingWrite();
  return result;
}

export const setGlobal = <K extends ProjectSettingKey>(key: K, value: ProjectSettingValues[K]) =>
  send('project.defaults.set', { key, value }, null);

export const clearGlobal = (key: ProjectSettingKey) =>
  send('project.defaults.clear', { key }, null);

/** Removes the project's own value, or only its workflow setting `param`, so it follows the global one again. */
export async function clearOverride(
  project: Pick<Project, 'id' | 'revision'>,
  key: ProjectSettingKey,
  param?: keyof PolicySettings,
): Promise<BridgeResult<unknown>> {
  if (key !== 'workflow_policy')
    return send('project.override.clear', { project_id: project.id, key }, project.revision);
  // The workflow policy has its own row and revision; a project without one stores none.
  const policy = await readQuery('workflow.policy', { project_id: project.id });
  if (!policy.ok) return policy;
  const { policy_version, revision } = policy.value as WorkflowPolicy;
  return send(
    'project.override.clear',
    { project_id: project.id, key, ...(param && { param }) },
    policy_version === 0 ? null : revision,
  );
}

export const addGlobalRule = (rule: string) => send('permission.globalRule.add', { rule }, null);
export const removeGlobalRule = (rule: string) =>
  send('permission.globalRule.remove', { rule }, null);

/** The global workflow settings over the built-in ones, as a policy the workflow rows read. */
export function globalPolicy(setting: SettingOverview<'workflow_policy'>): WorkflowPolicy {
  return {
    ...(setting.builtin as WorkflowPolicy),
    ...(setting.global as Partial<WorkflowPolicy>),
    id: '',
    revision: 0,
    project_id: '',
    policy_version: 0,
  };
}

/** The global workflow settings with the patch applied. */
export function patchedPolicy(
  global: PolicySettings | undefined,
  patch: PolicyPatch,
): PolicySettings {
  const { project_budget: _budget, ...rest } = patch;
  return { ...global, ...rest };
}

/** The project's session defaults, else the global ones whole, as the daemon starts a session with. */
export const effectiveSessionDefaults = (
  project: Pick<Project, 'session_defaults'> | undefined,
  read: ProjectDefaultsRead | null,
): Project['session_defaults'] =>
  project?.session_defaults ?? settingOf(read, 'session_defaults')?.global;

/** The project's token targets over the global ones, by runtime. */
export const effectiveUsageTargets = (
  project: Pick<Project, 'usage_targets'> | undefined,
  read: ProjectDefaultsRead | null,
): Record<string, number> => ({
  ...settingOf(read, 'usage_targets')?.global,
  ...project?.usage_targets,
});
