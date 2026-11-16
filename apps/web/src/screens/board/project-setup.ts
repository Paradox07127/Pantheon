import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProjectBaseline, SessionTurn } from '@pantheon/domain';
import type { BoardModel, BoardSnapshot } from '@pantheon/protocol';
import { useBaselineRead } from '../../data/baseline-read';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useFactsRead } from '../../data/facts-read';
import { useIntroRead } from '../../data/intro-read';
import { failureText } from '../../data/needs-you';
import { useSessionVisuals } from '../../data/visuals';
import { baselineStartInput, type BaselineChoice } from '../projects/baseline';
import type { SnapshotSession } from './panels-model';

/** The turns a board sync or a baseline start queued on these sessions, of these origins (null: any). */
export interface TurnWait {
  sessions: readonly string[];
  /** Turns that had ended when the command was sent. */
  ended: ReadonlySet<string>;
  origins: readonly SessionTurn['origin'][] | null;
  /** The board showed one of the turns. */
  seen?: true;
}

export const endedTurns = (turns: readonly SessionTurn[] | undefined): ReadonlySet<string> =>
  new Set(turns?.filter((t) => t.state !== 'queued' && t.state !== 'running').map((t) => t.id));

/**
 * The wait left after this board: null once its turns ended, or once they left the board after it
 * showed them or it lists their sessions discarded.
 */
export function waitAfter(
  wait: TurnWait | null,
  board: BoardSnapshot | null | undefined,
): TurnWait | null {
  if (!wait?.sessions.length) return null;
  const queued = (board?.session_turns ?? []).filter(
    (t) =>
      wait.sessions.includes(t.session_id) &&
      (!wait.origins || wait.origins.includes(t.origin)) &&
      !wait.ended.has(t.id),
  );
  const discarded = wait.sessions.every(
    (id) => board?.sessions?.find((s) => s.id === id)?.outcome === 'discarded',
  );
  if (!queued.length) return wait.seen || discarded ? null : wait;
  if (!queued.some((t) => t.state === 'queued' || t.state === 'running')) return null;
  return wait.seen ? wait : { ...wait, seen: true };
}

interface Start {
  starting: boolean;
  error: string | null;
  wait: TurnWait | null;
}

const IDLE: Start = { starting: false, error: null, wait: null };
// Each project's baseline start, shared by every page that offers it.
let starts: Readonly<Record<string, Start>> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function put(projectId: string, patch: Partial<Start>) {
  starts = { ...starts, [projectId]: { ...(starts[projectId] ?? IDLE), ...patch } };
  listeners.forEach((listener) => listener());
}

/** Starts the project's baseline; each page of the project shows it busy until its session turn ends. */
export async function startBaseline(projectId: string, choice?: BaselineChoice) {
  put(projectId, { starting: true, error: null, wait: null });
  const ended = endedTurns(useBoard.getState().board?.session_turns);
  const result = await runCommand(
    'project.baseline.start',
    baselineStartInput(projectId, choice),
    null,
  );
  if (!result.ok) return put(projectId, { starting: false, error: failureText(result.error) });
  const { session_id } = result.value as ProjectBaseline;
  put(projectId, {
    starting: false,
    wait: session_id ? { sessions: [session_id], ended, origins: null } : null,
  });
}

/** One page's view of the project's shared baseline start. */
function useStart(projectId: string | null): { busy: boolean; error: string | null } {
  const read = () => (projectId && starts[projectId]) || IDLE;
  const start = useSyncExternalStore(subscribe, read, read);
  const board = useBoard((s) => s.board);
  const left = waitAfter(start.wait, board);
  useEffect(() => {
    if (projectId && left !== start.wait) put(projectId, { wait: left });
  });
  return { busy: start.starting || left !== null, error: start.error };
}

export type SetupState =
  'none' | 'empty_folder' | 'running' | 'submitted' | 'planning' | 'failed' | 'ready';

export interface ProjectSetupRead {
  projectId: string;
  name: string;
  /** null until a read of the project's baseline went through. */
  state: SetupState | null;
  baseline: ProjectBaseline | null;
  roots: readonly string[];
  /** This baseline's session handed in the project introduction. */
  intro: boolean;
  /** Explanation charts this baseline's session drew. */
  charts: number;
  /** The lead writing the first plan from the confirmed baseline, and when it opened if known. */
  plan: SnapshotSession | null;
  planSince: number | null;
  busy: boolean;
  error: string | null;
  /** The baseline read failed before any read of the project went through. */
  readFailure?: { error: string; onRetry: () => void };
  start: (choice?: BaselineChoice) => void;
}

const NO_ROOTS: readonly string[] = [];

/** The project's setup: what its newest baseline has reached, and the shared start. */
export function useProjectSetup(projectId: string | null): ProjectSetupRead | undefined {
  const start = useStart(projectId);
  const baselineRead = useBaselineRead(projectId);
  const facts = useFactsRead(projectId);
  const introRead = useIntroRead(projectId);
  const project = useBoard((s) => s.board?.projects?.find((p) => p.id === projectId));
  const baseline = baselineRead.read;
  const planId =
    baseline?.state === 'confirmed'
      ? (baseline.plan_session_id ?? baseline.lead_session_id)
      : undefined;
  const plan = useBoard((s) => s.board?.sessions?.find((x) => x.id === planId) ?? null);
  const planWorking = useBoard(
    (s) =>
      !!planId &&
      !!s.board?.session_turns?.some(
        (turn) =>
          turn.session_id === planId && (turn.state === 'queued' || turn.state === 'running'),
      ),
  );
  const planSince = useBoard(
    (s) =>
      s.events.find((e) => e.kind === 'session.opened' && e.aggregate_id === planId)?.created_at ??
      null,
  );
  const working = baseline?.state === 'running' || baseline?.state === 'failed';
  const visuals = useSessionVisuals(
    projectId ?? '',
    working ? (baseline.session_id ?? null) : null,
  );
  // A null read means no baseline only once a read of this project went through.
  const [baselineKnown, setBaselineKnown] = useState<string | null>(null);
  if (!baselineRead.loading && !baselineRead.error && baselineKnown !== projectId)
    setBaselineKnown(projectId);
  const known = baseline !== null || (baselineKnown === projectId && !baselineRead.error);
  if (!projectId) return undefined;
  const empty = facts.read?.empty;
  const state: SetupState | null = !known
    ? null
    : !baseline
      ? empty === true
        ? 'empty_folder'
        : 'none'
      : baseline.state === 'empty'
        ? empty === false
          ? 'none'
          : 'empty_folder'
        : baseline.state === 'confirmed'
          ? plan && (plan.state === 'running' || planWorking)
            ? 'planning'
            : 'ready'
          : baseline.state;
  return {
    projectId,
    name: project?.name ?? '',
    state,
    baseline,
    roots: project?.roots ?? NO_ROOTS,
    intro: !!baseline?.session_id && introRead.read?.intro?.session_id === baseline.session_id,
    charts: visuals.data?.length ?? 0,
    plan: state === 'planning' ? plan : null,
    planSince,
    ...start,
    ...(!known &&
      baselineRead.error !== null && {
        readFailure: { error: baselineRead.error, onRetry: baselineRead.reload },
      }),
    start: (choice) => void startBaseline(projectId, choice),
  };
}

/**
 * Whether a page shows the setup in place of its body: while the board is empty, or while the
 * planning lead's own task is all it holds.
 */
export function setupShown(
  setup: ProjectSetupRead | undefined,
  model: BoardModel | null,
  empty: boolean,
): boolean {
  if (!setup?.state || setup.state === 'ready') return false;
  if (setup.state !== 'planning') return empty;
  return (
    !!model &&
    !model.leads?.length &&
    model.tasks.every((task) => task.id === setup.plan?.id) &&
    !model.milestones.length &&
    !model.risks.length &&
    !model.findings.length
  );
}
