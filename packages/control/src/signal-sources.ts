import type { AgentEvent, LandingItem, Session, SignalIssue, SignalSource } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { usageLimitWaiting } from './continuation.js';
import { checkOnBase } from './environment-check.js';
import { gateFailed } from './landing.js';
import { inhibit, recordSignal, resolveSignal } from './signals.js';

type GateResult = NonNullable<LandingItem['gate_results']>[number];

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// One check failing the same way in this many tasks within a day is a project pattern, not one task's bug.
const REPEAT_TASKS = 2;
// Trunk's infrastructure-failure rule: when most checks of a large run fail, the machine failed.
const ENVIRONMENT_SHARE = 0.8;
const ENVIRONMENT_CHECKS = 10;
// A flaky check with no new pass-and-fail for this long counts as stable again.
const FLAKY_QUIET_MS = 7 * DAY_MS;
// One failure in this many sessions of a runtime and model within the window is a provider outage.
const OUTAGE_SESSIONS = 3;
const OUTAGE_MS = 5 * MINUTE_MS;
const LINE_CHARS = 200;
const ERROR_LINE = /error|fail|panic|exception|assert|cannot|denied|not found|timed? ?out/i;

/**
 * The error line with what changes between runs of the same error replaced: quoted strings,
 * absolute paths, hex hashes of 7 or more characters and numbers.
 */
export function normalizeErrorLine(line: string): string {
  return Array.from(
    line
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/"[^"]*"|(?<!\w)'[^']*'|`[^`]*`/g, '<string>')
      .replace(/(^|[\s(=:,[])(?:[A-Za-z]:\\|\/)[^\s:,)\]]+/g, '$1<path>')
      .replace(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hash>')
      .replace(/\d+/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, LINE_CHARS)
    .join('');
}

/** The first line of the output that reads as an error, else its last line. */
function errorLine(result: GateResult): string {
  const lines = result.output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => ERROR_LINE.test(line)) ??
    lines.at(-1) ??
    (result.timed_out ? 'timed out' : 'no output')
  );
}

const gateFingerprint = (result: GateResult) =>
  `${Array.from(result.name).slice(0, LINE_CHARS).join('')}:${normalizeErrorLine(errorLine(result))}`;

/** The project's issues of the source that are still open and not muted by the user. */
const openIssues = (ctx: ControlContext, projectId: string, source: SignalSource) =>
  ctx.store
    .list<SignalIssue>('signal_issues')
    .filter(
      (issue) =>
        issue.project_id === projectId &&
        issue.source === source &&
        issue.state !== 'resolved' &&
        !issue.muted_by_user,
    );

interface GateRun {
  at: number;
  task: string;
  commit?: string;
  results: GateResult[];
}

/** The task a session works on, or the session itself when it has none. */
const taskKey = (session: Session | undefined, fallback: string) =>
  session?.task
    ? `${session.task.lead_session_id}:${session.task.id}`
    : session?.direct_task
      ? `${session.id}:${session.direct_task.id}`
      : (session?.id ?? fallback);

/** The project's gate runs since the time, oldest first. */
function gateRuns(ctx: ControlContext, projectId: string, since: number): GateRun[] {
  return ctx.store.kindEventsSince(projectId, ['session.gate_checked'], since).map((event) => {
    const payload = event.payload as { commit?: string; results?: GateResult[] };
    return {
      at: event.created_at,
      task: taskKey(ctx.store.get<Session>('sessions', event.aggregate_id), event.aggregate_id),
      commit: payload.commit,
      results: payload.results ?? [],
    };
  });
}

/** The results of the run that ran in it: not carried from an earlier run, not skipped. */
const ran = (run: GateRun) =>
  run.results.filter((result) => !result.carried && result.state !== 'skipped');

/**
 * Records the project-level patterns of a finished gate run of a task: a check that failed
 * because of the environment, the same failure in several tasks, most checks failing at once, and
 * a check that passed and failed on one commit. Resolves what the run's passes clear. The caller
 * owns the transaction.
 */
export function recordGateRun(
  ctx: ControlContext,
  input: {
    project_id: string;
    session_id?: string;
    commit: string;
    results: GateResult[];
    runner?: string;
  },
): void {
  const now = ctx.store.now(),
    projectId = input.project_id;
  const run: GateRun = {
    at: now,
    task: taskKey(
      input.session_id ? ctx.store.get<Session>('sessions', input.session_id) : undefined,
      input.session_id ?? '',
    ),
    commit: input.commit,
    results: input.results,
  };
  const checks = ran(run),
    failed = checks.filter(gateFailed),
    // The run's own event, when its owner stored one, repeats it; that changes no count below.
    week = [...gateRuns(ctx, projectId, now - FLAKY_QUIET_MS), run];
  for (const issue of openIssues(ctx, projectId, 'flaky_tests'))
    if (now - issue.last_seen >= FLAKY_QUIET_MS) resolveSignal(ctx, issue.id);
  for (const result of checks) {
    const outcome = gateFailed(result);
    const flaky = week.some(
      (other) =>
        other.commit === input.commit &&
        ran(other).some((each) => each.name === result.name && gateFailed(each) !== outcome),
    );
    if (flaky)
      recordSignal(ctx, {
        project_id: projectId,
        source: 'flaky_tests',
        fingerprint: result.name,
        title: `${result.name} passed and failed on ${input.commit.slice(0, 7)}`,
        sample: result.output,
      });
  }
  const environment = `environment:${input.runner ?? 'gate'}`;
  if (checks.length >= ENVIRONMENT_CHECKS && failed.length >= ENVIRONMENT_SHARE * checks.length) {
    const cause = recordSignal(ctx, {
      project_id: projectId,
      source: 'gate_failures',
      fingerprint: environment,
      title: `${failed.length} of ${checks.length} gate checks failed in one run`,
      sample: failed.map((result) => `${result.name}: ${errorLine(result)}`).join('\n'),
    });
    checkOnBase(ctx, cause, input.session_id);
    for (const result of failed)
      inhibit(ctx, {
        project_id: projectId,
        cause_issue_id: cause.id,
        source: 'gate_failures',
        fingerprint_prefix: `${result.name}:`,
      });
  } else if (failed.length < checks.length)
    for (const issue of openIssues(ctx, projectId, 'gate_failures'))
      if (issue.fingerprint === environment) resolveSignal(ctx, issue.id);
  const day = week.filter((other) => other.at >= now - DAY_MS);
  for (const result of failed) {
    const fingerprint = gateFingerprint(result);
    const tasks = new Set(
      day
        .filter((other) =>
          ran(other).some(
            (each) =>
              each.name === result.name &&
              gateFailed(each) &&
              gateFingerprint(each) === fingerprint,
          ),
        )
        .map((other) => other.task),
    );
    if (result.failure_class !== 'environment' && tasks.size < REPEAT_TASKS) continue;
    const issue = recordSignal(ctx, {
      project_id: projectId,
      source: 'gate_failures',
      fingerprint,
      title:
        result.failure_class === 'environment'
          ? `${result.name} failed because of its environment: ${errorLine(result)}`
          : `${result.name} failed the same way in ${tasks.size} tasks: ${errorLine(result)}`,
      sample: result.output,
    });
    if (result.failure_class === 'environment')
      checkOnBase(ctx, issue, input.session_id, result.name);
  }
  const passed = new Set(checks.filter((result) => !gateFailed(result)).map(({ name }) => name));
  if (!passed.size) return;
  const open = openIssues(ctx, projectId, 'gate_failures').filter(
    (issue) => issue.fingerprint !== environment,
  );
  if (!open.length) return;
  const history = [
    ...gateRuns(ctx, projectId, Math.min(...open.map((i) => i.first_seen)) - DAY_MS),
    run,
  ];
  for (const name of passed)
    for (const issue of open) {
      if (!issue.fingerprint.startsWith(`${name}:`)) continue;
      const latest = new Map<string, boolean>(),
        failing = new Set<string>();
      for (const other of history.filter((each) => each.at >= issue.first_seen - DAY_MS))
        for (const each of ran(other))
          if (each.name === name) {
            latest.set(other.task, gateFailed(each));
            if (gateFailed(each) && gateFingerprint(each) === issue.fingerprint)
              failing.add(other.task);
          }
      // An issue no task's gate failed came from the default branch, which alone clears it.
      if (failing.size && [...failing].every((task) => latest.get(task) === false))
        resolveSignal(ctx, issue.id);
    }
}

const scopeOf = (session: Session) =>
  `${session.runtime}:${session.reported_model ?? session.requested_model ?? 'default'}`;

/**
 * Records a failed turn of the session by error code, runtime and model, and a provider outage
 * when sessions of one runtime and model fail alike; a completed turn resolves them. A wait for a
 * used-up usage limit is not a failure. The caller owns the transaction.
 */
export function recordTurnEnd(
  ctx: ControlContext,
  session: Session,
  event: Extract<AgentEvent, { kind: 'turn.completed' }>,
): void {
  if (
    event.status === 'interrupted' ||
    event.error_code === 'usage_limit' ||
    usageLimitWaiting(ctx, session.id)
  )
    return;
  const scope = scopeOf(session),
    projectId = session.project_id,
    outage = `outage:${scope}`;
  const open = openIssues(ctx, projectId, 'session_failures');
  if (event.status === 'completed') {
    for (const issue of open)
      if (
        issue.fingerprint === outage ||
        issue.fingerprint === `runtime_unavailable:${session.runtime}` ||
        issue.fingerprint.endsWith(`:${scope}`)
      )
        resolveSignal(ctx, issue.id);
    return;
  }
  const code = event.error_code ?? 'unknown',
    fingerprint = `${code}:${scope}`,
    cause = open.find((issue) => issue.fingerprint === outage);
  if (cause)
    inhibit(ctx, {
      project_id: projectId,
      cause_issue_id: cause.id,
      source: 'session_failures',
      fingerprint_prefix: fingerprint,
    });
  recordSignal(ctx, {
    project_id: projectId,
    source: 'session_failures',
    fingerprint,
    title: `A turn failed on ${scope}: ${event.error ?? code}`,
    ...(event.error ? { sample: event.error } : {}),
  });
  if (cause) return;
  const sessions = new Set(
    ctx.store
      .kindEventsSince(projectId, ['agent.turn.completed'], ctx.store.now() - OUTAGE_MS)
      .filter((each) => {
        const payload = each.payload as { status?: string; error_code?: string };
        const other = ctx.store.get<Session>('sessions', each.aggregate_id);
        return (
          payload.status === 'failed' &&
          (payload.error_code ?? 'unknown') === code &&
          !!other &&
          scopeOf(other) === scope
        );
      })
      .map((each) => each.aggregate_id),
  ).add(session.id);
  if (sessions.size < OUTAGE_SESSIONS) return;
  const issue = recordSignal(ctx, {
    project_id: projectId,
    source: 'session_failures',
    fingerprint: outage,
    title: `Turns of ${sessions.size} sessions on ${scope} failed with ${code} within 5 minutes`,
    ...(event.error ? { sample: event.error } : {}),
    priority_hint: 'crash',
  });
  for (const each of openIssues(ctx, projectId, 'session_failures'))
    if (each.fingerprint !== outage && each.fingerprint.endsWith(`:${scope}`))
      inhibit(ctx, {
        project_id: projectId,
        cause_issue_id: issue.id,
        source: 'session_failures',
        fingerprint_prefix: each.fingerprint,
      });
}

/** Records that a task's session stays off the runtime its task names. */
export function recordRuntimeUnavailable(
  ctx: ControlContext,
  session: Session,
  runtime: string,
): void {
  recordSignal(ctx, {
    project_id: session.project_id,
    source: 'session_failures',
    fingerprint: `runtime_unavailable:${runtime}`,
    title: `Runtime ${runtime} is not available`,
  });
}
