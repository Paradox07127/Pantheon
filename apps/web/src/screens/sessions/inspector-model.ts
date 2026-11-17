import type {
  ChangeStory,
  ProjectFacts,
  Review,
  ReviewFinding,
  SessionComment,
} from '@pantheon/domain';
import type { SessionGates, WorkbenchSession } from '@pantheon/protocol';
import { numbered, type CommentedLine } from '../../components/DiffReview';
import { runtimeTraits } from '../../components/RuntimeGlyph';
import type { DiffFile } from '../../data/patch';
import type { FeedbackItem } from '../../data/feedback';
import { reasonText } from '../../data/needs-you';
import { currentLocale, t } from '../../i18n';
import type { SessionListGroup } from './session-groups';

const ENDED_TEXT: Partial<Record<WorkbenchSession['state'], string>> = {
  get merged() {
    return t({ id: 'sessions.model.ended.merged', defaultMessage: 'Merged' });
  },
  get discarded() {
    return t({ id: 'sessions.model.ended.discarded', defaultMessage: 'Discarded' });
  },
  get done() {
    return t({ id: 'sessions.model.ended.done', defaultMessage: 'Done' });
  },
};

/** How the session ended when its worktree is gone or its baseline finished, else null. */
export const endedText = (session: WorkbenchSession | null): string | null =>
  (session && ENDED_TEXT[session.state]) ?? null;

/** The sessions of the list's groups that a message can refer to: not archived and not ended. */
export const referableSessions = (groups: readonly SessionListGroup[]): WorkbenchSession[] =>
  groups
    .filter((g) => g.key !== 'archived')
    .flatMap((g) => g.sessions)
    .filter((s) => !endedText(s));

/** Whether the panel reads the worktree's changes: not before the list shows the worktree exists, and not after a discard removed it. */
export const readsDiff = (session: WorkbenchSession | null): boolean =>
  !!session && session.state !== 'starting' && (!endedText(session) || session.state === 'merged');

type MergeBlock = NonNullable<WorkbenchSession['merge']>;

/** Why the last merge stopped, and the message that asks the session to fix it; null for no block. */
export function mergeBlock(
  merge: WorkbenchSession['merge'],
): { text: string; request: string | null } | null {
  if (merge?.state !== 'blocked') return null;
  if (merge.reason === 'cancelled')
    return {
      text: t({ id: 'sessions.model.mergeBlock.cancelled', defaultMessage: 'Merge cancelled' }),
      request: null,
    };
  const block: MergeBlock = merge;
  if (block.reason === 'rebase_conflict') {
    const files = new Intl.ListFormat(currentLocale(), { style: 'narrow' }).format(
      block.conflicts ?? [],
    );
    return {
      text: t(
        {
          id: 'sessions.model.mergeBlock.conflict',
          defaultMessage: 'Conflicts with the source branch: {files}',
        },
        { files },
      ),
      request: `Rebasing onto the source branch conflicts in ${block.conflicts?.join(', ') ?? 'some files'}. Rebase this worktree onto the source branch, resolve the conflicts and commit.`,
    };
  }
  if (block.reason === 'gate_failed')
    return {
      text: t(
        { id: 'sessions.model.mergeBlock.gateFailed', defaultMessage: 'Gate “{gate}” failed' },
        { gate: block.gate?.name ?? '' },
      ),
      request: `The project gate "${block.gate?.name ?? ''}" failed on this worktree:\n\n${block.gate?.output ?? ''}\n\nFix it and commit.`,
    };
  if (block.reason === 'local_changes')
    return {
      text: t({
        id: 'sessions.model.mergeBlock.localChanges',
        defaultMessage: 'The source repository has uncommitted changes',
      }),
      request: null,
    };
  if (block.reason === 'detached_head')
    return {
      text: t({
        id: 'sessions.model.mergeBlock.detachedHead',
        defaultMessage: 'The source repository is not on a branch',
      }),
      request: null,
    };
  if (block.reason === 'no_changes')
    return {
      text: t({ id: 'sessions.model.mergeBlock.noChanges', defaultMessage: 'No commits to merge' }),
      request: null,
    };
  if (block.reason === 'dependency_folder_skipped')
    return {
      text: t({
        id: 'sessions.model.mergeBlock.dependencySkipped',
        defaultMessage: 'Dependency folders were skipped',
      }),
      request: null,
    };
  return {
    text: block.reason
      ? reasonText(block.reason)
      : t({ id: 'sessions.model.mergeBlock.blocked', defaultMessage: 'Merge blocked' }),
    request: null,
  };
}

/** The current branch of the folder the worktree came from, as last measured; null when unknown. */
export function sourceBranch(facts: ProjectFacts | null, source: string | null): string | null {
  return facts?.folders.find((folder) => folder.root === source)?.branch ?? null;
}

/** A branch chip: the branch, null for a detached worktree of an unknown source, and the commits ahead and behind. */
export interface SessionBranch {
  name: string | null;
  ahead: number;
  behind: number;
}

/**
 * The session's own branch. A detached worktree shows the source branch its commits are counted
 * against; a session listed without a branch, imported, shows the source branch; null shows none.
 */
export function sessionBranch(
  session: WorkbenchSession | null,
  source: string | null,
): SessionBranch | null {
  if (session && session.branch !== undefined)
    return {
      name: session.branch ?? source,
      ahead: session.ahead ?? 0,
      behind: session.behind ?? 0,
    };
  return source === null ? null : { name: source, ahead: 0, behind: 0 };
}

export const detachedText = () =>
  t({ id: 'sessions.branch.detached', defaultMessage: 'Detached HEAD' });

/** The commits ahead and behind as `↑N ↓N`, each left out at zero. */
export const aheadText = (branch: SessionBranch): string[] => [
  ...(branch.ahead > 0 ? [`↑${branch.ahead}`] : []),
  ...(branch.behind > 0 ? [`↓${branch.behind}`] : []),
];

/** The newest gate run's counts; null without a run or when every count is zero. */
export function gateCounts(gate: WorkbenchSession['gate']): {
  passed: number;
  failed: number;
  skipped: number;
  running: number;
  notRun: number;
  total: number;
} | null {
  if (!gate) return null;
  const skipped = gate.skipped ?? 0;
  const notRun = gate.not_run ?? 0;
  const total = gate.passed + gate.failed + skipped + gate.running + notRun;
  return total === 0
    ? null
    : { passed: gate.passed, failed: gate.failed, skipped, running: gate.running, notRun, total };
}

const SIGN = { add: '+', del: '-', ctx: ' ' } as const;

/** The message of a comment on one diff line: `file:line`, the quoted line, then the comment. */
export const lineComment = (at: CommentedLine, comment: string): string =>
  `${at.path}:${at.line}\n> ${SIGN[at.kind]}${at.text}\n\n${comment.trim()}`;

/**
 * A stored comment as an item; it quotes the commented line where the diff shows it, else the text
 * the line had when the comment was made.
 */
export const commentItem = (comment: SessionComment, at: CommentedLine | null): FeedbackItem => ({
  id: `comment:${comment.id}`,
  kind: 'comment',
  label: `${comment.path}:${comment.line}`,
  text: at
    ? lineComment(at, comment.text)
    : `${comment.path}:${comment.line}\n${comment.line_text === undefined ? '' : `> ${comment.line_text}\n`}\n${comment.text.trim()}`,
  comment: { id: comment.id, revision: comment.revision },
});

/** The merge block's request to fix it; the same request is the same item. */
export const conflictItem = (block: { text: string; request: string }): FeedbackItem => ({
  id: `conflict:${block.request}`,
  kind: 'conflict',
  label: block.text,
  text: block.request,
});

/** A column of the session's panel dock. */
export type Panel = 'changes' | 'checks' | 'plan' | 'files' | 'browser' | 'trace' | 'monitor';
/** What a link into a session opens: a panel, or the review or change story of the changes panel. */
export type PanelTab = Panel | 'review' | 'story';
/** What the changes panel shows. */
export type ChangesView = 'diff' | 'review' | 'story';

const PANELS: readonly Panel[] = [
  'changes',
  'checks',
  'plan',
  'files',
  'browser',
  'trace',
  'monitor',
];
const NO_WORKTREE_PANELS: readonly Panel[] = ['plan', 'files', 'browser', 'trace', 'monitor'];
const IN_PLACE_PANELS = PANELS.filter((panel) => panel !== 'checks');
const CHANGES_VIEWS: readonly ChangesView[] = ['diff', 'review', 'story'];

/** Whether the desktop app can show a web page inside the window. */
export const hasBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof window.pantheon?.browserOpen === 'function';

/**
 * The session's panels in order; a session without a worktree has its plan and the project's files,
 * one in its own folder has no checks, and the browser needs the desktop app.
 */
export const inspectorTabs = (session: WorkbenchSession | null): readonly Panel[] =>
  (session?.workspace_id === null
    ? NO_WORKTREE_PANELS
    : session?.workspace_kind === 'in_place' && !session.lands
      ? IN_PLACE_PANELS
      : PANELS
  ).filter((panel) => panel !== 'browser' || hasBrowser());

/** The panel, and the view of the changes panel, that a link to `tab` opens. */
export function panelOf(tab: PanelTab): { panel: Panel; view?: ChangesView } {
  return tab === 'review' || tab === 'story' ? { panel: 'changes', view: tab } : { panel: tab };
}

/** What the panels of one session last showed; absent fields were never chosen. */
export interface InspectorPlace {
  /** The open panels, the earliest opened first. */
  panels?: readonly Panel[];
  /** The overview card shows while no panel is open; absent shows it. */
  overview?: boolean;
  /** What the changes panel shows; absent shows the diff. */
  view?: ChangesView;
  /** The panel last opened or closed, which the details shortcut toggles. */
  recent?: Panel;
}

/** The stored panels of a session; nothing stored was never chosen, anything else unreadable opens none. */
export function readInspector(raw: string | null): InspectorPlace {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as {
      panels?: unknown;
      overview?: unknown;
      view?: unknown;
      recent?: unknown;
    } | null;
    const panels = Array.isArray(value?.panels)
      ? [
          ...new Set(
            (value.panels as unknown[]).filter((tab): tab is Panel =>
              PANELS.includes(tab as Panel),
            ),
          ),
        ]
      : [];
    const view = CHANGES_VIEWS.find((each) => each === value?.view);
    const recent = PANELS.find((each) => each === value?.recent);
    return {
      panels,
      ...(typeof value?.overview === 'boolean' ? { overview: value.overview } : {}),
      ...(view ? { view } : {}),
      ...(recent ? { recent } : {}),
    };
  } catch {
    return { panels: [] };
  }
}

/** A panel column's width in px. */
export const PANEL_WIDTH = { min: 280, initial: 340 } as const;

/** The width a panel kind opens at in px; the browser is wider. */
export const initialWidth = (tab: Panel): number => (tab === 'browser' ? 380 : PANEL_WIDTH.initial);

/** The stored width of each panel kind; anything unreadable is the initial width. */
export function readPanelWidths(raw: string | null): Record<Panel, number> {
  let value: Record<string, unknown> | null = null;
  try {
    value = JSON.parse(raw ?? 'null') as Record<string, unknown> | null;
  } catch {
    // Unreadable widths are the initial ones.
  }
  return Object.fromEntries(
    PANELS.map((tab) => {
      const width = value?.[tab];
      return [
        tab,
        typeof width === 'number' && Number.isFinite(width)
          ? Math.max(PANEL_WIDTH.min, width)
          : initialWidth(tab),
      ];
    }),
  ) as Record<Panel, number>;
}

/**
 * The open panels whose columns fit in `room` px and the widths they show at: the newest opened
 * narrows to the room, then the earliest opened close first.
 */
export function dockFit(
  panels: readonly Panel[],
  widths: Readonly<Record<Panel, number>>,
  room: number,
): { panels: readonly Panel[]; widths: Readonly<Record<Panel, number>> } {
  const newest = panels[panels.length - 1];
  const shown =
    newest && widths[newest] > room
      ? { ...widths, [newest]: Math.max(PANEL_WIDTH.min, room) }
      : widths;
  let kept = panels;
  while (kept.length > 0 && kept.reduce((sum, tab) => sum + shown[tab], 0) > room)
    kept = kept.slice(1);
  return { panels: kept, widths: shown };
}

/** Ended sessions keep their checks and reviews to read only. */
export const readOnlySession = (session: WorkbenchSession | null): boolean =>
  !session || ['merged', 'discarded', 'failed'].includes(session.state);

/** The runtime that reviews a session on the runtime. */
export const reviewRuntime = (runtime: string): string => runtimeTraits(runtime).reviewer;

type GateResult = NonNullable<SessionGates['last']>['results'][number];

export const gateOutcome = (result: GateResult): 'passed' | 'failed' | 'timed_out' | 'skipped' =>
  result.state === 'skipped'
    ? 'skipped'
    : result.timed_out
      ? 'timed_out'
      : result.exit_code === 0
        ? 'passed'
        : 'failed';

/** A command skipped after failing neither passed nor failed. */
export const gateFailing = (result: GateResult): boolean =>
  ['failed', 'timed_out'].includes(gateOutcome(result));

/** The text without terminal colour codes. */
export const plainLog = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The test files and tests a vitest log reports failed, in the order it names them: from its
 * `FAIL file > test` lines and the `×` lines under a `❯ file (… failed)` line.
 */
export function failedTests(log: string): { file: string; tests: string[] }[] {
  const files = new Map<string, string[]>();
  const add = (file: string, test?: string) => {
    const tests = files.get(file) ?? [];
    files.set(file, tests);
    if (!test) return;
    // A `×` line names the test alone, a `FAIL` line with its describe blocks: keep the full name once.
    const same = tests.findIndex(
      (t) => t === test || t.endsWith(` > ${test}`) || test.endsWith(` > ${t}`),
    );
    if (same < 0) tests.push(test);
    else if (test.length > tests[same]!.length) tests[same] = test;
  };
  let current: string | null = null;
  for (const line of plainLog(log).split('\n')) {
    // A workspace project's name may stand before the file.
    const failed = /^\s*FAIL\s+(?:[^\s/.]+\s+)?(\S+)(?:\s+>\s+(.+?))?(?:\s+\[.*\])?\s*$/.exec(line);
    if (failed) {
      add(failed[1]!, failed[2]);
      continue;
    }
    const file = /^\s*\u276f\s+(?:[^\s/.]+\s+)?(\S+)\s+\(\d+ tests?\b.*\bfailed\)/.exec(line);
    if (file) {
      current = file[1]!;
      continue;
    }
    const test = /^\s+\u00d7\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/.exec(line);
    if (test && current) add(current, test[1]);
  }
  return [...files].map(([file, tests]) => ({ file, tests }));
}

/** The failed or timed out command at `index` of the gate run checked at `checkedAt`. */
export const checkItem = (result: GateResult, checkedAt: number, index: number): FeedbackItem => {
  const listed = failedTests(result.output_tail).flatMap(({ file, tests }) => [
    `- ${file}`,
    ...tests.map((test) => `  - ${test}`),
  ]);
  return {
    id: `check:${checkedAt}:${index}:${result.name}`,
    kind: 'check',
    label: result.name,
    text: [
      `The project gate "${result.name}" failed on this worktree:`,
      ...(listed.length ? [['Failed tests:', ...listed].join('\n')] : []),
      plainLog(result.output_tail),
      'Fix it and commit.',
    ].join('\n\n'),
  };
};

export const gatesFailed = (gates: SessionGates | null): boolean =>
  !!gates?.last?.results.some(gateFailing);

export function gateSummary(
  gates: SessionGates | null,
): 'running' | 'cancelling' | 'cancelled' | 'passed' | 'failed' | 'none' {
  if (gates?.operation?.state === 'cancelling' || gates?.operation?.state === 'cancelled')
    return gates.operation.state;
  if (gates?.running) return 'running';
  if (!gates?.last || !gates.configured) return 'none';
  return gatesFailed(gates) ? 'failed' : 'passed';
}

/** The newest interpretation started for the session, or null. */
export function sessionStory(
  stories: readonly ChangeStory[],
  sessionId: string,
): ChangeStory | null {
  let newest: ChangeStory | null = null;
  for (const story of stories)
    if (
      story.workbench_session_id === sessionId &&
      (!newest || story.created_at > newest.created_at)
    )
      newest = story;
  return newest;
}

/** Findings of the session's reviews, newest review first; findings rejected on recording are left out. */
export const reviewFindings = (reviews: readonly Review[]): ReviewFinding[] =>
  // The reviews query lists reviews in the order they were requested.
  [...reviews]
    .reverse()
    .flatMap((review) => review.findings.filter((finding) => finding.status !== 'rejected'));

export const findingOpen = (finding: ReviewFinding): boolean =>
  finding.status === 'open' && !finding.resolution;

/** The diff line a finding's `path:line` names, when that line is shown and contains the quote's first line. */
export function anchorFinding(
  finding: ReviewFinding,
  files: readonly DiffFile[],
): { path: string; side: 'new' | 'old'; line: number } | null {
  const at = /^(.+?):(\d+)(?:-\d+)?$/.exec(finding.location);
  if (!at) return null;
  const path = at[1]!;
  const line = Number(at[2]);
  const file = files.find((f) => f.path === path);
  if (!file) return null;
  const lines = file.hunks.flatMap(numbered);
  const quote = finding.quote.split('\n')[0]!.trim();
  if (quote === '') return null;
  const holds = (l: (typeof lines)[number] | undefined) => !!l && l.text.trim().includes(quote);
  if (holds(lines.find((l) => l.kind !== 'del' && l.new === line)))
    return { path, side: 'new', line };
  if (holds(lines.find((l) => l.kind === 'del' && l.old === line)))
    return { path, side: 'old', line };
  return null;
}

export function findingState(finding: ReviewFinding): string {
  if (finding.resolution)
    return finding.resolution.outcome === 'adopted'
      ? t({ id: 'sessions.model.finding.adopted', defaultMessage: 'Adopted' })
      : t({ id: 'sessions.model.finding.dismissed', defaultMessage: 'Dismissed' });
  return finding.status === 'stale'
    ? t({ id: 'sessions.model.finding.stale', defaultMessage: 'Out of date' })
    : t({ id: 'sessions.model.finding.open', defaultMessage: 'Open' });
}

export const findingItem = (finding: ReviewFinding): FeedbackItem => ({
  id: `finding:${finding.id}`,
  kind: 'finding',
  label: finding.location,
  text: [
    `Please fix this review finding: ${finding.impact} (${finding.location})`,
    `Quote:\n${finding.quote}`,
    `Evidence:\n${finding.evidence}`,
    ...(finding.reproduction === undefined
      ? []
      : [
          `Reproduction:\n${typeof finding.reproduction === 'string' ? finding.reproduction : JSON.stringify(finding.reproduction, null, 2)}`,
        ]),
  ].join('\n\n'),
});
