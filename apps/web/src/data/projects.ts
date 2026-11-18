import type { BoardSnapshot, BridgeResult } from '@pantheon/protocol';
import { t } from '../i18n';
import { runCommand } from './commands';
import { failureText, reasonText } from './needs-you';

type Project = BoardSnapshot['projects'][number];

/**
 * The projects not removed, without the personal agent's home; a removed project comes back when
 * its folder is opened again.
 */
export function visibleProjects<T extends Pick<Project, 'removed_at' | 'kind'>>(
  projects: readonly T[],
): T[] {
  return projects.filter((p) => p.removed_at === undefined && p.kind !== 'personal');
}

/** Projects whose name or any root contains the query, without case; an empty query keeps all. */
export function searchProjects<T extends Pick<Project, 'name' | 'roots'>>(
  projects: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter(
    (p) =>
      p.name.toLowerCase().includes(q) || p.roots.some((root) => root.toLowerCase().includes(q)),
  );
}

/** The last segment of a directory path, for the default project name. */
export function nameFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}

const trimRoot = (root: string): string => root.replace(/[\\/]+$/, '');

/** The project opened at exactly these roots as a set, compared as typed; the daemon resolves links on open. */
export function findProjectByRoots<T extends Pick<Project, 'roots'>>(
  projects: readonly T[],
  roots: readonly string[],
): T | null {
  const want = new Set(roots.map(trimRoot));
  if (want.size === 0 || want.has('')) return null;
  return (
    projects.find((p) => {
      const have = new Set(p.roots.map(trimRoot));
      return have.size === want.size && [...have].every((root) => want.has(root));
    }) ?? null
  );
}

/** Why the daemon refused project.open, in words; message is the daemon's own text. */
export function openRejectText(code: string, message: string): string {
  switch (code) {
    case 'invalid_project': {
      const file = /^Invalid .*\/(\.pantheon\/[^/:]+):/.exec(message)?.[1];
      return file === undefined
        ? t({ id: 'data.projects.notFolder', defaultMessage: 'This path is not a folder' })
        : t(
            {
              id: 'data.projects.invalidConfig',
              defaultMessage: 'The project config file {file} is invalid',
            },
            { file },
          );
    }
    case 'scope_violation': {
      if (message.includes('credentials'))
        return t({
          id: 'data.projects.containsData',
          defaultMessage: "A project can't contain Pantheon's data folder or credentials",
        });
      if (message.includes('overlap each other'))
        return t({
          id: 'data.projects.foldersNested',
          defaultMessage: "The folders can't contain one another",
        });
      const [, removed, other] = /overlap (removed )?project "(.*)"/.exec(message) ?? [];
      if (other === undefined) return message;
      return removed
        ? t(
            {
              id: 'data.projects.overlapsRemoved',
              defaultMessage:
                'Overlaps the removed project “{name}”; open its original folder to restore it',
            },
            { name: other },
          )
        : t(
            {
              id: 'data.projects.overlaps',
              defaultMessage: 'The folder overlaps the project “{name}”',
            },
            { name: other },
          );
    }
    case 'permission_denied':
      return t({
        id: 'data.projects.ownerOnly',
        defaultMessage: 'Only you can open projects',
      });
    case 'invalid_request':
      if (message.includes('ENOENT'))
        return t({ id: 'data.projects.folderMissing', defaultMessage: "The folder doesn't exist" });
      if (message.includes('ENOTDIR'))
        return t({
          id: 'data.projects.pathNotFolder',
          defaultMessage: 'Part of the path is not a folder',
        });
      if (message.includes('EACCES') || message.includes('EPERM'))
        return t({
          id: 'data.projects.noReadPermission',
          defaultMessage: 'No permission to read this folder',
        });
      return t({ id: 'data.reason.invalidInput', defaultMessage: 'Invalid input' });
  }
  return reasonText(code);
}

export function removeProject(
  project: Pick<Project, 'id' | 'revision'>,
): Promise<BridgeResult<unknown>> {
  return runCommand('project.remove', { project_id: project.id }, project.revision);
}

/** Why the daemon refused project.remove, in words. */
export function removeRejectText(error: { code: string; message: string }): string {
  if (error.code === 'resource_busy')
    return t({
      id: 'data.projects.removeBusy',
      defaultMessage: 'The project still has sessions or runs going; stop them before removing it',
    });
  return failureText(error);
}
