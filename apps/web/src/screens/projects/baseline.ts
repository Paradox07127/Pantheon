import type { ProjectBaseline, BaselineResult } from '@pantheon/domain';
import { t } from '../../i18n';
import type { Request } from './brief';

export type { ProjectBaseline };

type GateCommand = BaselineResult['folders'][number]['gate'][number];

export interface BaselineDraft {
  gate: { root: string; command: GateCommand; checked: boolean }[];
}

export function baselineStartRequest(project_id: string): Request {
  return {
    ok: true,
    type: 'project.baseline.start',
    input: { project_id },
    expected_revision: null,
  };
}

/** The editable form of a handed-back baseline: every gate command checked. */
export function baselineDraft(baseline: ProjectBaseline): BaselineDraft {
  return {
    gate: (baseline.result?.folders ?? []).flatMap((folder) =>
      folder.gate.map((command) => ({ root: folder.root, command, checked: true })),
    ),
  };
}

/** The baseline's folders in its order, each with its setup command and its draft gate indexes. */
export function baselineFolders(
  baseline: ProjectBaseline,
  draft: BaselineDraft,
): { root: string; setup: string | null; gate: number[] }[] {
  return (baseline.result?.folders ?? []).map((folder) => ({
    root: folder.root,
    setup: folder.setup ? folder.setup.argv.join(' ') : null,
    gate: draft.gate.flatMap((item, i) => (item.root === folder.root ? [i] : [])),
  }));
}

const notSubmitted = (): Request => ({
  ok: false,
  errors: [
    t({
      id: 'projects.baseline.notSubmitted',
      defaultMessage: 'This baseline is not waiting for confirmation',
    }),
  ],
});

export function baselineConfirmRequest(baseline: ProjectBaseline, draft: BaselineDraft): Request {
  if (baseline.state !== 'submitted') return notSubmitted();
  // A folder with every command unchecked is sent with none, which clears its gate.
  const gates: { root: string; commands: Omit<GateCommand, 'sources'>[] }[] = [];
  for (const { root, checked, command } of draft.gate) {
    let entry = gates.find((item) => item.root === root);
    if (!entry) gates.push((entry = { root, commands: [] }));
    if (!checked) continue;
    const { sources: _, ...picked } = command;
    entry.commands.push(picked);
  }
  return {
    ok: true,
    type: 'project.baseline.confirm',
    input: { baseline_id: baseline.id, ...(gates.length > 0 && { gates }) },
    expected_revision: baseline.revision,
  };
}
