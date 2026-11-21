import type { FolderFacts } from '@pantheon/domain';

const ENTRIES_SHOWN = 24;

/** The first message of a baseline session: the folders and the files that name their commands. */
export function renderScanSeed(
  project: { name: string; roots: string[] },
  folders: Pick<FolderFacts, 'root' | 'git' | 'manifests' | 'ci' | 'agent_instructions'>[],
): string {
  const lines = [
    '# Gate search',
    `Project: ${project.name}`,
    'Folders:',
    ...folders.map((folder) => `- ${folder.root} (${folder.git ? 'git' : 'not git, read-only'})`),
  ];
  for (const folder of folders) {
    const found = [
      ['Agent instructions', folder.agent_instructions],
      ['Manifests', folder.manifests],
      ['CI', folder.ci],
    ] as const;
    if (!found.some(([, entries]) => entries.length)) continue;
    lines.push('', `## ${folder.root}`);
    for (const [label, entries] of found)
      if (entries.length)
        lines.push(
          `${label}: ${entries
            .slice(0, ENTRIES_SHOWN)
            .map((entry) => entry.path)
            .join(', ')}`,
        );
  }
  return `${lines.join('\n')}\n`;
}
