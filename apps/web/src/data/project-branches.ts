import type { BridgeResult, DesktopBridge, ProjectBranch } from '@pantheon/protocol';

export type { ProjectBranch };

/** GET /v1/project.branches for one project folder, with the checked-out branch moved first. */
export async function readBranches(
  bridge: Pick<DesktopBridge, 'query'> | undefined,
  project_id: string,
  root: string | undefined,
): Promise<BridgeResult<ProjectBranch[]>> {
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('project.branches', { project_id, ...(root !== undefined ? { root } : {}) })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  if (!Array.isArray(result.value))
    return {
      ok: false,
      error: { code: 'bad_response', message: 'project.branches result is not a list' },
    };
  const branches = result.value as ProjectBranch[];
  return {
    ok: true,
    value: [...branches.filter((b) => b.checked_out), ...branches.filter((b) => !b.checked_out)],
  };
}
