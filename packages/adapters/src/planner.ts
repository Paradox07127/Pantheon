import type { SessionSpec } from '@pantheon/domain';

export function plannerInstructions(
  spec: Pick<SessionSpec, 'project_id' | 'cwd' | 'control_instructions' | 'project_roots'>,
): string {
  const folders = spec.project_roots
    ? spec.project_roots
        .map((folder) => `- ${folder.path} (${folder.git ? 'git' : 'not git, read-only'})`)
        .join('\n')
    : `- ${spec.cwd}`;
  const project = `The project folders are:
${folders}`;
  if (spec.control_instructions) return `${project}\n${spec.control_instructions}`;
  return `${project}
Use Pantheon tools only; do not use shell tools or access files.
As an exception, you can read project files with your read-only tools and cannot change files.`;
}
