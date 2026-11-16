import type {
  ProjectBaseline,
  BaselineExtension,
  BaselineResult,
  EffortLevel,
} from '@pantheon/domain';
import { compareRuntimes } from '../../components/RuntimeGlyph';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import type { WorkstreamCount } from './facts';
import type { Request } from './brief';

export type { ProjectBaseline };

type GateCommand = BaselineResult['folders'][number]['gate'][number];

export interface BaselineDraft {
  goal: string;
  goals: string[];
  non_goals: string[];
  gate: { root: string; command: GateCommand; checked: boolean }[];
  answers: { question: string; options: string[]; answer: string | null }[];
  extensions: (BaselineExtension & { checked: boolean })[];
}

export type BaselineEntry =
  | { kind: 'start'; label: string; failure?: string }
  | { kind: 'running' | 'review' | 'empty' | 'confirmed'; baseline: ProjectBaseline };

// Labels are getters, so each is read in the language loaded by then.
const FAILURE: Record<string, string> = {
  get baseline_window_expired() {
    return t({ id: 'projects.baseline.failure.expired', defaultMessage: 'The baseline timed out' });
  },
  get baseline_missing() {
    return t({
      id: 'projects.baseline.failure.missing',
      defaultMessage: 'The baseline session handed back no result',
    });
  },
};

const ENTRY: Record<
  Exclude<ProjectBaseline['state'], 'failed'>,
  Exclude<BaselineEntry['kind'], 'start'>
> = {
  running: 'running',
  submitted: 'review',
  empty: 'empty',
  confirmed: 'confirmed',
};

/** Which block the planning widget shows for the project's newest baseline. */
export function baselineEntry(baseline: ProjectBaseline | null, hasBrief: boolean): BaselineEntry {
  if (!baseline || baseline.state === 'failed') {
    const label = hasBrief
      ? t({ id: 'projects.baseline.readAgain', defaultMessage: 'Read it again' })
      : t({ id: 'projects.baseline.read', defaultMessage: 'Read this project' });
    if (!baseline?.reason) return { kind: 'start', label };
    return { kind: 'start', label, failure: FAILURE[baseline.reason] ?? baseline.reason };
  }
  return { kind: ENTRY[baseline.state], baseline };
}

/** What a baseline runs on; an absent field is left to the daemon's default. */
export interface BaselineChoice {
  runtime?: string;
  model?: string;
  effort?: EffortLevel;
}

/** Each project's last baseline choice in this window; a start without one, such as a retry, reuses it. */
const lastChoice = new Map<string, BaselineChoice>();

/** The baseline start input: the given choice, remembered, else the project's last one. */
export function baselineStartInput(project_id: string, choice?: BaselineChoice) {
  if (choice) lastChoice.set(project_id, choice);
  return { project_id, ...(choice ?? lastChoice.get(project_id)) };
}

export function baselineStartRequest(project_id: string, choice?: BaselineChoice): Request {
  return {
    ok: true,
    type: 'project.baseline.start',
    input: baselineStartInput(project_id, choice),
    expected_revision: null,
  };
}

/** The editable form of a handed-back baseline: every gate command and extension checked, no question answered. */
export function baselineDraft(baseline: ProjectBaseline): BaselineDraft {
  const result = baseline.result;
  return {
    goal: result?.brief?.goal ?? '',
    goals: result?.brief?.goals ?? [],
    non_goals: result?.brief?.non_goals ?? [],
    gate: (result?.folders ?? []).flatMap((folder) =>
      folder.gate.map((command) => ({ root: folder.root, command, checked: true })),
    ),
    answers: (result?.questions ?? []).map((q) => ({ ...q, answer: null })),
    extensions: (result?.extensions ?? []).map((item) => ({ ...item, checked: true })),
  };
}

const STAGE: Record<BaselineResult['folders'][number]['stage'], string> = {
  get empty() {
    return t({ id: 'projects.baseline.stage.empty', defaultMessage: 'Empty' });
  },
  get early() {
    return t({ id: 'projects.baseline.stage.early', defaultMessage: 'Early' });
  },
  get active() {
    return t({ id: 'projects.baseline.stage.active', defaultMessage: 'Active' });
  },
  get maintenance() {
    return t({ id: 'projects.baseline.stage.maintenance', defaultMessage: 'Maintenance' });
  },
};

/** The baseline's folders in its order, each with its stage and stack and its draft gate indexes. */
export function baselineFolders(
  baseline: ProjectBaseline,
  draft: BaselineDraft,
): { root: string; facts: string; gate: number[] }[] {
  return (baseline.result?.folders ?? []).map((folder) => ({
    root: folder.root,
    facts: listText(STAGE[folder.stage], ...(folder.stack ?? [])),
    gate: draft.gate.flatMap((item, i) => (item.root === folder.root ? [i] : [])),
  }));
}

/** The handed-back workstreams in their order, each with its items counted in the newest facts. */
export function baselineWorkstreams(
  baseline: ProjectBaseline,
  counts: readonly WorkstreamCount[],
): (WorkstreamCount & { reason: string })[] {
  return (baseline.result?.workstreams ?? []).map((stream) => {
    const counted = counts.find((c) => c.id === stream.id);
    return {
      id: stream.id,
      title: stream.title,
      status: stream.status,
      reason: stream.reason,
      done: counted?.done ?? 0,
      open: counted?.open ?? 0,
      missing: counted?.missing ?? 0,
    };
  });
}

/** The suggested extensions grouped by runtime in the runtime table's order, as draft indexes. */
export function baselineExtensions(draft: BaselineDraft): { runtime: string; items: number[] }[] {
  const runtimes = [...new Set(draft.extensions.map((item) => item.runtime))].sort(compareRuntimes);
  return runtimes.map((runtime) => ({
    runtime,
    items: draft.extensions.flatMap((item, i) => (item.runtime === runtime ? [i] : [])),
  }));
}

const lines = (items: readonly string[]) =>
  items.map((item) => item.trim()).filter((item) => item !== '');

export function baselineConfirmRequest(baseline: ProjectBaseline, draft: BaselineDraft): Request {
  if (baseline.state !== 'submitted')
    return {
      ok: false,
      errors: [
        t({
          id: 'projects.baseline.notSubmitted',
          defaultMessage: 'This baseline is not waiting for confirmation',
        }),
      ],
    };
  const goal = draft.goal.trim();
  // Without a brief the daemon plans with the suggested one.
  if (!goal && baseline.result?.brief)
    return {
      ok: false,
      errors: [t({ id: 'projects.brief.goalRequired', defaultMessage: 'Goal is required' })],
    };
  // A folder with every command unchecked is sent with none, which clears its gate.
  const gates: { root: string; commands: Omit<GateCommand, 'sources'>[] }[] = [];
  for (const { root, checked, command } of draft.gate) {
    let entry = gates.find((item) => item.root === root);
    if (!entry) gates.push((entry = { root, commands: [] }));
    if (!checked) continue;
    const { sources: _, ...picked } = command;
    entry.commands.push(picked);
  }
  const extensions = draft.extensions.flatMap(({ checked, ...item }) => (checked ? [item] : []));
  return {
    ok: true,
    type: 'project.baseline.confirm',
    input: {
      baseline_id: baseline.id,
      ...(goal && {
        brief: { goal, goals: lines(draft.goals), non_goals: lines(draft.non_goals) },
      }),
      ...(gates.length > 0 && { gates }),
      answers: draft.answers.flatMap((a) =>
        a.answer === null ? [] : [{ question: a.question, answer: a.answer }],
      ),
      ...(extensions.length > 0 && { extensions }),
      plan_board: true,
    },
    expected_revision: baseline.revision,
  };
}
