import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { LoadError } from '../../components/LoadError';
import { Check, ChevronDown, ChevronRight, Coins, Lightbulb, Undo2, X } from 'lucide-react';
import type { GateFailureClass } from '@pantheon/domain';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import {
  STATUS_LABEL,
  useImprovements,
  useTaskRetrospectives,
  type Improvement,
} from '../../data/workflow-policy';
import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { reducedMotion } from '../../lib/motion';
import { useShell } from '../../store';
import { Empty, Panel } from './Charts';
import { runtimeFindingTitle } from '../trace/RuntimeDiagnostics';
import { durationText, tokenText, type BoardTask } from './panels-model';
import { StatusIcon, TaskRoute } from './status';
import { QueryBody } from './Tables';
import './retro.css';

type Retro = NonNullable<BoardTask['retrospective']>;
export type RetroTask = BoardTask & { retrospective: Retro };

const OUTCOME: Record<Retro['outcome'], { glyph: BoardTaskStatus; label: string }> = {
  merged: {
    glyph: 'done',
    get label() {
      return t({ id: 'board.task.retro.outcomeMerged', defaultMessage: 'Merged' });
    },
  },
  accepted: {
    glyph: 'done',
    get label() {
      return t({ id: 'board.task.retro.outcomeAccepted', defaultMessage: 'Accepted' });
    },
  },
  failed: {
    glyph: 'failed',
    get label() {
      return t({ id: 'board.task.retro.outcomeFailed', defaultMessage: 'Failed' });
    },
  },
  removed: {
    glyph: 'discarded',
    get label() {
      return t({ id: 'board.task.retro.outcomeRemoved', defaultMessage: 'Discarded' });
    },
  },
};

const FAILURE_CLASS: Record<GateFailureClass, string> = {
  get environment() {
    return t({ id: 'board.task.retro.failureEnvironment', defaultMessage: 'Environment' });
  },
  get code() {
    return t({ id: 'board.task.retro.failureCode', defaultMessage: 'Code' });
  },
};

/** The statuses whose improvements a row counts, in the order it shows them. */
const COUNTED = ['candidate', 'trial', 'active'] as const;
type Counted = (typeof COUNTED)[number];

/** The tasks with a retrospective, the latest ended first. */
export const retroTasks = (tasks: readonly BoardTask[]): RetroTask[] =>
  tasks
    .filter((t): t is RetroTask => !!t.retrospective)
    .sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));

/** One mark per gate run up to the one that passed; none when no run passed. */
export function gatePips(retro: Retro): ('bad' | 'ok')[] {
  const runs = retro.gate_passed_on_attempt ?? 0;
  return Array.from({ length: runs }, (_, i) => (i === runs - 1 ? 'ok' : 'bad'));
}

/** The improvements resting on the retrospective, counted by status; absent statuses left out. */
export function improvementCounts(
  improvements: readonly Improvement[],
  retroId: string | undefined,
): [Counted, number][] {
  if (!retroId) return [];
  return COUNTED.map((status): [Counted, number] => [
    status,
    improvements.filter((i) => i.status === status && i.retrospective_ids.includes(retroId)).length,
  ]).filter(([, n]) => n > 0);
}

const meanText = (n: number) => String(Math.round(n * 10) / 10);

/** Whether the row can open its gate failures; a gate that passed on its first run has none to read. */
const canExpand = (task: RetroTask, projectId: string | undefined) =>
  !!projectId &&
  (task.retrospective.gate_passed_on_attempt !== 1 || !!task.retrospective.runtime_findings);

// The retrospective asked for from elsewhere; its row takes it once it draws.
let jump: string | null = null;
const jumpListeners = new Set<() => void>();
const subscribeJump = (listener: () => void) => {
  jumpListeners.add(listener);
  return () => void jumpListeners.delete(listener);
};
const readJump = () => jump;
const setJump = (id: string | null) => {
  jump = id;
  jumpListeners.forEach((listener) => listener());
};

/** Opens and reveals the retrospective's row the next time the panel draws it. */
export function openRetro(id: string) {
  setJump(id);
}

function openExperience() {
  useShell.getState().setMemoryTab('learned');
  useShell.getState().setScreen('memory');
}

function Pip({ state }: { state: 'bad' | 'ok' }) {
  return (
    <i className="ret-pip" data-s={state}>
      {state === 'ok' ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
    </i>
  );
}

/** The failed gate runs of the task's retrospective, read when its row opens. */
export function RetroGates({ projectId, task }: { projectId: string; task: RetroTask }) {
  const owner = task.owner_session_id;
  const query = useTaskRetrospectives({
    project_id: projectId,
    task_id: owner ? task.id.slice(owner.length + 1) : task.id,
  });
  return (
    <QueryBody query={query}>
      {(rows) => {
        const retro = rows.find((r) => r.id === task.retrospective.id);
        if (!retro)
          return (
            <LoadError
              message={t({
                id: 'board.task.retro.notFound',
                defaultMessage: 'Retrospective not found',
              })}
            />
          );
        const failures = retro.gate_failures ?? [];
        const findings = retro.runtime_findings ?? [];
        if (!failures.length && !findings.length)
          return (
            <Empty
              text={t({ id: 'board.task.retro.noFailures', defaultMessage: 'No failed gates' })}
            />
          );
        return (
          <>
            {failures.length > 0 && (
              <ol className="ret-gf">
                {failures.map((failure, i) => (
                  <li key={i}>
                    <Pip state="bad" />
                    <code>{retro.gate_failed_checks?.[i] ?? '—'}</code>
                    <span>{FAILURE_CLASS[failure]}</span>
                  </li>
                ))}
              </ol>
            )}
            {findings.length > 0 && (
              <div>
                <strong>
                  {t({ id: 'board.task.retro.runtime', defaultMessage: 'Runtime evidence' })}
                </strong>
                <ul className="ret-gf">
                  {findings.map((finding) => (
                    <Tip key={finding.id} content={finding.evidence_ids.join(', ')}>
                      <li>
                        <span>{runtimeFindingTitle(finding)}</span>
                        <span>
                          {finding.duration_ms === undefined
                            ? '—'
                            : durationText(finding.duration_ms)}
                        </span>
                      </li>
                    </Tip>
                  ))}
                </ul>
              </div>
            )}
          </>
        );
      }}
    </QueryBody>
  );
}

function RetroRow({
  task,
  improvements,
  projectId,
  chevron,
  onOpenTask,
}: {
  task: RetroTask;
  improvements: readonly Improvement[];
  projectId?: string;
  /** Whether the list keeps the expand column. */
  chevron: boolean;
  onOpenTask: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = useId();
  const row = useRef<HTMLLIElement>(null);
  const retro = task.retrospective;
  const jumped = useSyncExternalStore(subscribeJump, readJump, readJump) === retro.id;
  if (jumped && !open) setOpen(true);
  useEffect(() => {
    if (!jumped) return;
    row.current?.scrollIntoView({
      block: 'nearest',
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
    setJump(null);
  }, [jumped]);
  const pips = gatePips(retro);
  const counts = improvementCounts(improvements, retro.id);
  const outcome = OUTCOME[retro.outcome];
  const handbacksText = t(
    {
      id: 'board.task.retro.handbacks',
      defaultMessage: '{count, plural, one {Handed back # time} other {Handed back # times}}',
    },
    { count: retro.handbacks },
  );
  const tokensText =
    retro.tokens === undefined
      ? undefined
      : t(
          { id: 'board.task.retro.tokensLabel', defaultMessage: '{tokens} tokens' },
          { tokens: tokenText(retro.tokens) },
        );
  const expandable = canExpand(task, projectId);
  return (
    <li ref={row} className="ret-row" data-open={open || undefined}>
      {expandable ? (
        <button
          type="button"
          className="ib rp-exp"
          aria-expanded={open}
          aria-controls={open ? detail : undefined}
          aria-label={t(
            {
              id: 'board.task.retro.failuresLabel',
              defaultMessage: 'Retrospective details for {title}',
            },
            { title: task.title },
          )}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
      ) : (
        chevron && <span />
      )}
      <button type="button" className="ret-t" onClick={() => onOpenTask(task.id)}>
        <span className="ret-out" role="img" aria-label={outcome.label}>
          <StatusIcon status={outcome.glyph} />
        </span>
        <span className="ret-tt">{task.title}</span>
      </button>
      <span className="ret-rt">
        <TaskRoute task={task} className="ret-rtm" />
      </span>
      {pips.length ? (
        <span
          className="ret-gate"
          role="img"
          aria-label={t(
            { id: 'board.task.retro.passedOnRun', defaultMessage: 'Gates passed on run {run}' },
            { run: pips.length },
          )}
        >
          {pips.map((state, i) => (
            <Pip key={i} state={state} />
          ))}
        </span>
      ) : (
        <span />
      )}
      <Tip content={handbacksText}>
        <span
          className="ret-n"
          data-zero={retro.handbacks === 0 || undefined}
          role="img"
          tabIndex={0}
          aria-label={handbacksText}
        >
          <Undo2 aria-hidden="true" />
          {retro.handbacks}
        </span>
      </Tip>
      {tokensText === undefined ? (
        <span />
      ) : (
        <Tip content={tokensText}>
          <span
            className="ret-n"
            data-zero={retro.tokens === 0 || undefined}
            role="img"
            tabIndex={0}
            aria-label={tokensText}
          >
            <Coins aria-hidden="true" />
            {tokenText(retro.tokens!)}
          </span>
        </Tip>
      )}
      {counts.length > 0 && projectId ? (
        <button
          type="button"
          className="ret-xp"
          aria-label={t(
            { id: 'board.task.retro.improvements', defaultMessage: 'Improvements: {counts}' },
            { counts: listText(...counts.map(([s, n]) => `${STATUS_LABEL[s]} ${n}`)) },
          )}
          onClick={openExperience}
        >
          <Lightbulb aria-hidden="true" />
          {counts.map(([status, n]) => (
            <span key={status} className="ret-xs" data-s={status}>
              {n}
            </span>
          ))}
        </button>
      ) : (
        <span />
      )}
      {open && projectId && (
        <div className="ret-dt" id={detail}>
          <RetroGates projectId={projectId} task={task} />
        </div>
      )}
    </li>
  );
}

/** What the harness learned from each finished task: gate runs, handbacks and the improvements they led to. */
export function RetroPanel({
  model,
  projectId,
  onOpenTask,
}: {
  model: BoardModel;
  projectId?: string;
  onOpenTask: (taskId: string) => void;
}) {
  const list = useImprovements(projectId ?? null);
  const improvements = list.read ?? [];
  const tasks = retroTasks(model.tasks);
  const pending = improvements.filter((i) => i.status === 'candidate').length;
  const firstPass = tasks.filter((t) => t.retrospective.gate_passed_on_attempt === 1).length;
  const handbacks = tasks.reduce((sum, t) => sum + t.retrospective.handbacks, 0);
  const chevron = tasks.some((task) => canExpand(task, projectId));
  return (
    <Panel
      title={t({ id: 'board.task.retro.listTitle', defaultMessage: 'Finished tasks' })}
      num={
        pending > 0 &&
        projectId && (
          <button
            type="button"
            className="ret-pend"
            aria-label={t(
              {
                id: 'board.task.retro.pending',
                defaultMessage:
                  '{count, plural, one {# proposal awaits a decision} other {# proposals await a decision}}',
              },
              { count: pending },
            )}
            onClick={openExperience}
          >
            <Lightbulb aria-hidden="true" />
            {pending}
          </button>
        )
      }
    >
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      {tasks.length === 0 ? (
        <Empty
          text={t({ id: 'board.task.retro.empty', defaultMessage: 'No retrospectives yet' })}
        />
      ) : (
        <>
          <div className="ret-sum">
            <span
              role="img"
              aria-label={t(
                {
                  id: 'board.task.retro.firstPass',
                  defaultMessage: 'Gates passed on the first run: {passed} / {total}',
                },
                { passed: firstPass, total: tasks.length },
              )}
            >
              <Pip state="ok" />
              {firstPass}/{tasks.length}
            </span>
            <span
              role="img"
              aria-label={t(
                {
                  id: 'board.task.retro.meanHandbacks',
                  defaultMessage: 'Handed back {mean} times on average',
                },
                { mean: meanText(handbacks / tasks.length) },
              )}
            >
              <Undo2 aria-hidden="true" />
              {meanText(handbacks / tasks.length)}
            </span>
          </div>
          <ul className="ret-l" data-flat={!chevron || undefined}>
            {tasks.map((task) => (
              <RetroRow
                key={task.id}
                task={task}
                improvements={improvements}
                projectId={projectId}
                chevron={chevron}
                onOpenTask={onOpenTask}
              />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
