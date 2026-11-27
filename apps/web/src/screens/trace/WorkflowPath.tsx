import { useMemo } from 'react';
import {
  SPAWNED_SESSION_LIMIT,
  type BoardSnapshot,
  type ProjectGateRun,
  type WorkflowPolicyView,
} from '@pantheon/protocol';
import { EnvironmentCheck } from '../../components/EnvironmentCheck';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { runtimeName } from '../../components/RuntimeGlyph';
import type { GraphSpec } from '../../components/visual/graph-layout';
import { GraphDiagram } from '../../components/visual/GraphDiagram';
import { useBoard } from '../../data/board';
import { useGateHistory } from '../../data/quality';
import { useWorkflowPolicy } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { gateState } from '../../lib/gate-model';
import { dayText } from '../../lib/time-text';

type Project = BoardSnapshot['projects'][number];

const PATH_HEIGHT = 320;
const START = 'start';
const REVIEW = 'review';
const LAND = 'land';
const GATES = 'gates';
const NO_RUNS: readonly ProjectGateRun[] = [];
// The daemon reads more than 100 runs only from a start time; 0 is from the first.
const ALL_RUNS = { since: '0', limit: '500' };
// Review may be skipped; its way is dashed.
const OPTIONAL_EDGE = 'async' as const;
const DIRECT_EDGE = 'main' as const;
export const gateNode = (root: string) => `gate:${root}`;
export const approveNode = (root: string) => `approve:${root}`;

/** The newest run of exactly the root's enabled commands, in order; a run names no root itself. */
function lastRun(
  commands: NonNullable<Project['gates']>[string],
  runs: readonly ProjectGateRun[],
): ProjectGateRun | null {
  // A run is the folder's when its results are exactly its commands in order; the daemon lists
  // the commands after a failure as skipped, so a failed run covers them all too.
  const ours = runs.filter(
    ({ results }) =>
      results.length === commands.length &&
      results.every(
        (r, i) =>
          commands[i]!.name === r.name &&
          commands[i]!.argv.length === r.command.length &&
          commands[i]!.argv.every((arg, k) => arg === r.command[k]),
      ),
  );
  return ours.reduce<ProjectGateRun | null>(
    (newest, run) =>
      !newest || Date.parse(run.finished_at) > Date.parse(newest.finished_at) ? run : newest,
    null,
  );
}

/**
 * The way a change takes in the project, left to right: starting sessions, review when it is asked
 * for, the user's release of a folder with protected paths, that folder's gate, and landing.
 */
export function workflowPath(
  project: Project,
  policy: WorkflowPolicyView,
  runs: readonly ProjectGateRun[],
  now: number,
): GraphSpec {
  const limits = Object.entries(policy.runtime_parallel ?? {});
  const routes = policy.kind_routes?.length ?? 0;
  const onFail = policy.gate_on_fail ?? 'stop';
  const runner = policy.gate_runner ?? 'daemon';
  const protectedRoots = project.roots.filter((root) => project.protected_paths?.[root]?.length);
  const gates = project.roots.map((root) => {
    const configured = project.gates?.[root] ?? [];
    const enabled = configured.filter((command) => command.enabled !== false);
    if (enabled.length === 0)
      return {
        id: gateNode(root),
        label: root,
        group: GATES,
        detail: [t({ id: 'trace.workflow.gate.none', defaultMessage: 'No gate' })],
      };
    const run = lastRun(enabled, runs);
    const failed = run?.results.some((r) => ['failed', 'timed_out'].includes(gateState(r)));
    const at = run && dayText(Date.parse(run.finished_at), now, { time: true });
    return {
      id: gateNode(root),
      label: root,
      group: GATES,
      ...(run && { status: failed ? ('failed' as const) : ('done' as const) }),
      detail: [
        ...enabled.map((command) => command.argv.join(' ')),
        runner === 'session'
          ? t({
              id: 'trace.workflow.gate.runner.session',
              defaultMessage: 'Runs in the session worktree',
            })
          : t({ id: 'trace.workflow.gate.runner.daemon', defaultMessage: 'Runs in the daemon' }),
        onFail === 'retry'
          ? t({
              id: 'trace.workflow.gate.onFail.retry',
              defaultMessage: 'A failed step reruns once first',
            })
          : t({ id: 'trace.workflow.gate.onFail.stop', defaultMessage: 'A failure stops for you' }),
        ...(run
          ? [
              failed
                ? t({ id: 'trace.workflow.gate.lastFailed', defaultMessage: 'Failed {at}' }, { at })
                : t(
                    { id: 'trace.workflow.gate.lastPassed', defaultMessage: 'Passed {at}' },
                    { at },
                  ),
            ]
          : []),
      ],
    };
  });
  return {
    direction: 'LR',
    groups: [{ id: GATES, label: t({ id: 'trace.workflow.gates', defaultMessage: 'Gates' }) }],
    nodes: [
      {
        id: START,
        label: t({ id: 'trace.workflow.start', defaultMessage: 'Start sessions' }),
        detail: [
          t(
            {
              id: 'trace.workflow.start.max',
              defaultMessage: 'At most {count} spawned sessions at a time',
            },
            { count: policy.max_spawned ?? SPAWNED_SESSION_LIMIT },
          ),
          ...limits.map(([runtime, count]) =>
            t(
              { id: 'trace.workflow.start.runtime', defaultMessage: '{runtime} at most {count}' },
              { runtime: runtimeName(runtime), count },
            ),
          ),
          t(
            {
              id: 'trace.workflow.start.routes',
              defaultMessage:
                '{count, plural, =0 {No routes by kind} one {# route by kind} other {# routes by kind}}',
            },
            { count: routes },
          ),
        ],
      },
      {
        id: REVIEW,
        label: t({ id: 'trace.workflow.review', defaultMessage: 'Review' }),
        detail: [
          policy.verify_timing === 'each_session'
            ? t({
                id: 'trace.workflow.review.eachSession',
                defaultMessage: 'After each session',
              })
            : policy.verify_timing === 'before_landing'
              ? t({ id: 'trace.workflow.review.beforeLanding', defaultMessage: 'Before landing' })
              : t({
                  id: 'trace.workflow.review.unset',
                  defaultMessage: 'When the main agent decides',
                }),
        ],
      },
      ...protectedRoots.map((root) => ({
        id: approveNode(root),
        label:
          project.roots.length === 1
            ? t({ id: 'trace.workflow.approve', defaultMessage: 'Waits for you' })
            : t(
                { id: 'trace.workflow.approve.root', defaultMessage: 'Waits for you: {root}' },
                { root },
              ),
        detail: project.protected_paths![root]!,
      })),
      ...gates,
      { id: LAND, label: t({ id: 'trace.workflow.land', defaultMessage: 'Land' }) },
    ],
    edges: [
      { from: START, to: REVIEW, style: OPTIONAL_EDGE },
      ...project.roots.flatMap((root) => {
        // The daemon holds a change to protected paths for the user before it runs the gate.
        const held = protectedRoots.includes(root)
          ? [
              { from: START, to: approveNode(root), style: OPTIONAL_EDGE },
              { from: REVIEW, to: approveNode(root), style: OPTIONAL_EDGE },
              { from: approveNode(root), to: gateNode(root), style: DIRECT_EDGE },
            ]
          : [];
        return [
          { from: START, to: gateNode(root), style: DIRECT_EDGE },
          { from: REVIEW, to: gateNode(root), style: OPTIONAL_EDGE },
          ...held,
          { from: gateNode(root), to: LAND, style: DIRECT_EDGE },
        ];
      }),
    ],
  };
}

/** The project's way from a started session to landing, and a run of its gates that lands nothing. */
export function WorkflowPath({ projectId }: { projectId: string }) {
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === projectId));
  const policy = useWorkflowPolicy(projectId);
  const history = useGateHistory(projectId, ALL_RUNS);
  // Without the history the gates are drawn with no last result.
  const runs = history.read?.runs ?? (history.error ? NO_RUNS : null);
  // The graph lays out again for a new spec, so it changes only with what it draws.
  const spec = useMemo(
    () => project && policy.read && runs && workflowPath(project, policy.read, runs, Date.now()),
    [project, policy.read, runs],
  );
  if (!project) return <Skeleton />;
  return (
    <div className="trc-flow">
      {policy.error && <Failure error={policy.error} onRetry={policy.reload} />}
      {history.error && <Failure error={history.error} onRetry={history.reload} />}
      {spec ? (
        <GraphDiagram
          spec={spec}
          height={PATH_HEIGHT}
          grows
          styleNames={{
            [DIRECT_EDGE]: t({ id: 'trace.workflow.edge.direct', defaultMessage: 'Direct' }),
            [OPTIONAL_EDGE]: t({ id: 'trace.workflow.edge.optional', defaultMessage: 'Optional' }),
          }}
        />
      ) : (
        <Skeleton />
      )}
      <section
        aria-label={t({ id: 'trace.workflow.trial', defaultMessage: 'Trial-run the gates' })}
      >
        <EnvironmentCheck
          project_id={project.id}
          planned={project.roots.map((root) => ({
            root,
            commands: (project.gates?.[root] ?? []).filter((command) => command.enabled !== false),
          }))}
        />
      </section>
    </div>
  );
}
