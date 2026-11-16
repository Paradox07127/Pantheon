import type { BaselineResult, FolderFacts } from '@pantheon/domain';

const PREVIOUS_LIMIT = 1_500;
const ENTRIES_SHOWN = 24;

/** The first message of a baseline session: the folders to scan, where their code is and the last confirmed result. */
export function renderScanSeed(
  project: { name: string; roots: string[] },
  folders: Pick<FolderFacts, 'root' | 'git' | 'directories' | 'manifests'>[],
  previous?: { result: BaselineResult; commits_since: Record<string, number> },
): string {
  const lines = [
    '# Project scan',
    `Project: ${project.name}`,
    'Folders:',
    ...folders.map((folder) => `- ${folder.root} (${folder.git ? 'git' : 'not git, read-only'})`),
  ];
  for (const folder of folders) {
    const directories = [...folder.directories]
      .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
      .slice(0, ENTRIES_SHOWN);
    if (!directories.length && !folder.manifests.length) continue;
    lines.push('', `## Code in ${folder.root}`);
    if (directories.length)
      lines.push(
        'Directories (tracked files):',
        ...directories.map((entry) => `- ${entry.path}: ${entry.files}`),
      );
    if (folder.manifests.length)
      lines.push(
        `Manifests: ${folder.manifests
          .slice(0, ENTRIES_SHOWN)
          .map((entry) => entry.path)
          .join(', ')}`,
      );
  }
  if (previous) {
    const lists = previous.result.folders.filter((folder) => folder.context?.task_lists.length);
    const since = Object.entries(previous.commits_since);
    const section = [
      '## Previous confirmed scan',
      'Workstreams:',
      ...previous.result.workstreams.map((stream) => `- ${stream.title} (${stream.status})`),
      ...(lists.length
        ? [
            'Task lists:',
            ...lists.map((folder) => `- ${folder.root}: ${folder.context!.task_lists.join(', ')}`),
          ]
        : []),
      ...(since.length
        ? ['Commits since then:', ...since.map(([root, count]) => `- ${root}: ${count}`)]
        : []),
    ].join('\n');
    lines.push(
      '',
      section.length > PREVIOUS_LIMIT ? `${section.slice(0, PREVIOUS_LIMIT - 1)}…` : section,
    );
  }
  return `${lines.join('\n')}\n`;
}
