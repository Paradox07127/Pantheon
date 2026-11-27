import { useEffect, useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ArrowDown, ArrowUp, Plus, Undo2, X } from 'lucide-react';
import { create } from 'zustand';
import { canonical, type RuntimeChoice } from '@pantheon/domain';
import { SPAWNED_SESSION_LIMIT, type BoardSnapshot } from '@pantheon/protocol';
import { runtimeName } from '../../components/RuntimeGlyph';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import {
  isPolicy,
  setPolicy,
  useWorkflowPolicy,
  type PolicyPatch,
  type WorkflowPolicy,
  type WorkflowPolicyView,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { ModelMenu, type ModelChoice } from '../sessions/parts';
import { Row, Section } from './ProjectSettingsScreen';
import './spawn-policy.css';

type Project = BoardSnapshot['projects'][number];
type Group = 'spawn' | 'routes';
type Field = 'max_spawned' | 'runtime_parallel' | 'task_size' | 'verify_timing' | 'kind_routes';
type KindRoute = NonNullable<WorkflowPolicy['kind_routes']>[number];
type RouteRow = { id: number; kind: string; choice: RuntimeChoice; fallbacks: RuntimeChoice[] };
type KindProblem = 'empty' | 'long' | 'characters' | 'duplicate';

const LIMIT_MAX = 16;
const KIND_MAX = 32;
const ROUTES_MAX = 12;
const FALLBACKS_MAX = 3;

const useSpawnPolicySave = create<{
  /** The policy a command returned, shown until a read reaches its version. */
  saved: WorkflowPolicy | null;
  pending: boolean;
  failure: { project_id: string; group: Group; text: string } | null;
  saves: number;
}>(() => ({ saved: null, pending: false, failure: null, saves: 0 }));

/** True once the daemon took the patch. */
async function saveSpawnPolicy(policy: WorkflowPolicy, patch: PolicyPatch, group: Group) {
  if (useSpawnPolicySave.getState().pending) return false;
  useSpawnPolicySave.setState({ pending: true, failure: null });
  const result = await setPolicy(policy, patch);
  const s = useSpawnPolicySave.getState();
  useSpawnPolicySave.setState(
    result.ok
      ? {
          pending: false,
          saved: isPolicy(result.value) ? result.value : s.saved,
          saves: s.saves + 1,
        }
      : { pending: false, failure: { project_id: policy.project_id, group, text: result.error } },
  );
  return result.ok;
}

/** A whole number in the range spawnLimit takes; null for anything else. */
const limitOf = (text: string) => {
  const n = Number(text);
  return /^\d+$/.test(text) && n >= 1 && n <= LIMIT_MAX ? n : null;
};

function kindProblem(rows: readonly RouteRow[], index: number): KindProblem | null {
  const { kind } = rows[index]!;
  if (kind === '') return 'empty';
  if (kind.length > KIND_MAX) return 'long';
  if (!/^[a-z0-9-]+$/.test(kind)) return 'characters';
  return rows.some((r, j) => j !== index && r.kind === kind) ? 'duplicate' : null;
}

const KIND_PROBLEM: Record<KindProblem, () => string> = {
  empty: () => t({ id: 'settings.spawn.kindEmpty', defaultMessage: 'Name the kind' }),
  long: () =>
    t(
      { id: 'settings.spawn.kindTooLong', defaultMessage: 'At most {max} characters' },
      { max: KIND_MAX },
    ),
  characters: () =>
    t({
      id: 'settings.spawn.kindCharacters',
      defaultMessage: 'Use only lowercase letters, digits and dashes',
    }),
  duplicate: () =>
    t({ id: 'settings.spawn.kindDuplicate', defaultMessage: 'Another route names this kind' }),
};

const limitProblem = () =>
  t(
    { id: 'settings.spawn.limitRange', defaultMessage: 'Enter a whole number from 1 to {max}' },
    { max: LIMIT_MAX },
  );

const rowsOf = (routes: readonly KindRoute[]): RouteRow[] =>
  routes.map(({ kind, fallbacks, ...choice }, id) => ({
    id,
    kind,
    choice,
    fallbacks: fallbacks ?? [],
  }));

const routesOf = (rows: readonly RouteRow[]): KindRoute[] =>
  rows.map((r) => ({
    kind: r.kind,
    ...r.choice,
    ...(r.fallbacks.length > 0 && { fallbacks: r.fallbacks }),
  }));

const menuValue = (choice: RuntimeChoice): ModelChoice => ({
  runtime: choice.runtime,
  backend: null,
  model: choice.model ?? null,
  effort: choice.effort ?? null,
});

const choiceOf = (next: ModelChoice): RuntimeChoice => ({
  runtime: next.runtime,
  ...(next.model !== null && { model: next.model }),
  ...(next.effort !== null && { effort: next.effort }),
});

const swap = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
};

/**
 * How many sessions the main agent keeps taking turns, in all and on each runtime, what it is told
 * about task size and checking, and which runtime and model each kind of task goes to.
 */
export function SpawnPolicy({ project }: { project: Project }) {
  const read = useWorkflowPolicy(project.id);
  const status = useRuntimeStatus('writer');
  const savedPolicy = useSpawnPolicySave((s) => s.saved);
  const pending = useSpawnPolicySave((s) => s.pending);
  const savedFailure = useSpawnPolicySave((s) => s.failure);
  const saves = useSpawnPolicySave((s) => s.saves);
  // Text typed into a number field, until it is left.
  const [limitText, setLimitText] = useState<string | null>(null);
  const [parallelText, setParallelText] = useState<Record<string, string>>({});
  const [badNumbers, setBadNumbers] = useState<readonly string[]>([]);
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  // Routes whose kind field was left; only their problems show.
  const [shown, setShown] = useState<readonly number[]>([]);

  const saved = savedPolicy?.project_id === project.id ? savedPolicy : null;
  const policy: (WorkflowPolicy & Partial<WorkflowPolicyView>) | null =
    saved && (!read.read || read.read.policy_version < saved.policy_version) ? saved : read.read;
  const failure = savedFailure?.project_id === project.id ? savedFailure : null;

  useEffect(() => {
    if (saves > 0) read.reload();
  }, [saves]);

  const draft = routes ?? rowsOf(policy?.kind_routes ?? []);
  const savedRoutes = canonical(routesOf(rowsOf(policy?.kind_routes ?? [])));
  // The saved routes a draft was started from; a draft over routes changed since is not sent.
  const routesBase = useRef<string | null>(null);
  useEffect(() => {
    routesBase.current = routes === null ? null : (routesBase.current ?? savedRoutes);
  }, [routes]);
  const parallel = policy?.runtime_parallel ?? {};
  const offered = offeredRuntimes(status.read, [
    ...Object.keys(parallel),
    ...draft.flatMap((r) => [r.choice.runtime, ...r.fallbacks.map((f) => f.runtime)]),
  ]);
  const models = useRuntimeModels(project.id, offered);

  if (!policy)
    return read.error ? (
      <div className="ps-err" role="alert">
        {read.error}
      </div>
    ) : null;

  const disabled = pending || read.stale;
  const defaultLimit = read.read?.defaults?.max_spawned ?? SPAWNED_SESSION_LIMIT;
  const own = (field: Field) => policy.overridden?.includes(field) ?? false;
  const limitShown =
    own('max_spawned') && policy.max_spawned !== undefined ? String(policy.max_spawned) : '';
  const ownParallel = own('runtime_parallel') ? parallel : {};
  const usable = offered.filter((r) => status.unavailable[r] === undefined);
  const firstRuntime = usable[0] ?? offered[0] ?? 'claude';

  const save = async (patch: PolicyPatch, group: Group) => {
    const ok = await saveSpawnPolicy(policy, patch, group);
    if (!ok && group === 'spawn') {
      setLimitText(null);
      setParallelText({});
      setBadNumbers([]);
    }
    if (!ok && group === 'routes') {
      setRoutes(null);
      setShown([]);
    }
    return ok;
  };

  const leaveLimit = () => {
    if (limitText === null) return;
    const text = limitText.trim();
    const value = text === '' ? null : limitOf(text);
    if (text !== '' && value === null) {
      setBadNumbers((b) => (b.includes('') ? b : [...b, '']));
      return;
    }
    setBadNumbers((b) => b.filter((k) => k !== ''));
    setLimitText(null);
    if (String(value ?? '') !== limitShown) void save({ max_spawned: value }, 'spawn');
  };

  const leaveParallel = (runtime: string) => {
    const typed = parallelText[runtime];
    if (typed === undefined) return;
    const text = typed.trim();
    const value = text === '' ? null : limitOf(text);
    if (text !== '' && value === null) {
      setBadNumbers((b) => (b.includes(runtime) ? b : [...b, runtime]));
      return;
    }
    setBadNumbers((b) => b.filter((k) => k !== runtime));
    setParallelText(({ [runtime]: _, ...rest }) => rest);
    if (value === (ownParallel[runtime] ?? null)) return;
    // Setting one runtime while following the global limits keeps the others as they were.
    const { [runtime]: _, ...others } = parallel;
    void save(
      { runtime_parallel: value === null ? others : { ...others, [runtime]: value } },
      'spawn',
    );
  };

  const commitRoutes = async (next: RouteRow[]) => {
    const problems = next.some((_, i) => kindProblem(next, i) !== null);
    const sent = routesOf(next);
    if (routesBase.current !== null && routesBase.current !== savedRoutes) {
      setRoutes(null);
      setShown([]);
      useSpawnPolicySave.setState({
        failure: {
          project_id: policy.project_id,
          group: 'routes',
          text: t({
            id: 'settings.spawn.routesChanged',
            defaultMessage: 'The routes changed elsewhere; these are the saved ones',
          }),
        },
      });
      return;
    }
    if (!problems && canonical(sent) === savedRoutes) {
      setRoutes(null);
      return;
    }
    setRoutes(next);
    if (problems) return;
    if (!(await save({ kind_routes: sent }, 'routes'))) return;
    routesBase.current = canonical(sent);
    setRoutes((r) => (r === next ? null : r));
  };
  const editRoute = (index: number, change: Partial<RouteRow>) =>
    draft.map((r, i) => (i === index ? { ...r, ...change } : r));

  const limitLabel = t({ id: 'settings.spawn.limit', defaultMessage: 'Spawned sessions at once' });
  const taskSize = t({ id: 'settings.spawn.taskSize', defaultMessage: 'Task size' });
  const verifyTiming = t({ id: 'settings.spawn.verifyTiming', defaultMessage: 'When to check' });
  const parallelLabel = t({
    id: 'settings.spawn.runtimeLimits',
    defaultMessage: 'Sessions at once on each runtime',
  });
  const routesLabel = t({ id: 'settings.spawn.routes', defaultMessage: 'Routes by kind' });
  const kindLabel = t({ id: 'settings.spawn.kind', defaultMessage: 'Kind' });
  /** Drops the project's own value of field, so it follows the global one. */
  const backToGlobal = (field: Field, label: string, group: Group, drop?: () => void) =>
    own(field) ? (
      <button
        type="button"
        className="ib"
        disabled={disabled}
        aria-label={t(
          { id: 'settings.spawn.useGlobal', defaultMessage: 'Use the global value for {field}' },
          { field: label },
        )}
        onClick={() => {
          drop?.();
          void save({ [field]: null }, group);
        }}
      >
        <Undo2 aria-hidden="true" />
      </button>
    ) : (
      <span className="spw-slot" />
    );
  const dropNumber = (key: string) => setBadNumbers((b) => b.filter((k) => k !== key));
  const groupFailure = (group: Group) =>
    failure?.group === group && (
      <div className="ps-err" role="alert">
        {failure.text}
      </div>
    );
  const numberField = (
    label: string,
    value: string,
    placeholder: string | undefined,
    bad: boolean,
    onChange: (text: string) => void,
    onLeave: () => void,
  ) => (
    <span className="spw-num">
      <input
        className="inp mono"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={bad || undefined}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onLeave}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onLeave();
        }}
      />
      {bad && (
        <span className="ps-err" role="alert">
          {limitProblem()}
        </span>
      )}
    </span>
  );
  const segments = <T extends string>(
    label: string,
    value: T | null,
    choices: readonly (readonly [T, string])[],
    onChange: (value: T) => void,
  ) => (
    <RadioGroup<T | null>
      className="seg"
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(next) => next !== null && onChange(next)}
    >
      {choices.map(([v, text]) => (
        <Radio.Root key={v} value={v}>
          {text}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
  const menu = (label: string, choice: RuntimeChoice, onChange: (next: RuntimeChoice) => void) => (
    <span role="group" aria-label={label}>
      <ModelMenu
        runtimes={offered}
        unavailable={status.unavailable}
        disconnected={status.disconnected}
        models={models}
        keys={false}
        disabled={disabled}
        value={menuValue(choice)}
        onChange={(next) => onChange(choiceOf(next))}
      />
    </span>
  );

  return (
    <>
      <Section title={t({ id: 'settings.spawn.title', defaultMessage: 'Spawned sessions' })}>
        {groupFailure('spawn')}
        <div className="ps-rows" aria-busy={pending || undefined}>
          <Row label={limitLabel}>
            {numberField(
              limitLabel,
              limitText ?? limitShown,
              String(defaultLimit),
              badNumbers.includes(''),
              setLimitText,
              leaveLimit,
            )}
            {backToGlobal('max_spawned', limitLabel, 'spawn', () => {
              setLimitText(null);
              dropNumber('');
            })}
          </Row>
          {offered.map((runtime, r) => {
            const label = t(
              { id: 'settings.spawn.runtimeLimit', defaultMessage: 'At once on {runtime}' },
              { runtime: runtimeName(runtime) },
            );
            return (
              <Row key={runtime} label={label}>
                {numberField(
                  label,
                  parallelText[runtime] ?? String(ownParallel[runtime] ?? ''),
                  own('runtime_parallel') || parallel[runtime] === undefined
                    ? undefined
                    : String(parallel[runtime]),
                  badNumbers.includes(runtime),
                  (text) => setParallelText((p) => ({ ...p, [runtime]: text })),
                  () => leaveParallel(runtime),
                )}
                {r === 0 ? (
                  backToGlobal('runtime_parallel', parallelLabel, 'spawn', () => {
                    setParallelText({});
                    setBadNumbers((b) => b.filter((k) => k === ''));
                  })
                ) : (
                  <span className="spw-slot" />
                )}
              </Row>
            );
          })}
          {offered.length === 0 && own('runtime_parallel') && (
            <Row label={parallelLabel}>
              {backToGlobal('runtime_parallel', parallelLabel, 'spawn', () => {
                setParallelText({});
                setBadNumbers((b) => b.filter((k) => k === ''));
              })}
            </Row>
          )}
          <Row label={taskSize}>
            {segments<NonNullable<WorkflowPolicy['task_size']>>(
              taskSize,
              policy.task_size ?? null,
              [
                ['small', t({ id: 'settings.spawn.taskSize.small', defaultMessage: 'Small' })],
                ['medium', t({ id: 'settings.spawn.taskSize.medium', defaultMessage: 'Medium' })],
                ['large', t({ id: 'settings.spawn.taskSize.large', defaultMessage: 'Large' })],
              ],
              (value) => void save({ task_size: value }, 'spawn'),
            )}
            {backToGlobal('task_size', taskSize, 'spawn')}
          </Row>
          <Row label={verifyTiming}>
            {segments<NonNullable<WorkflowPolicy['verify_timing']>>(
              verifyTiming,
              policy.verify_timing ?? null,
              [
                [
                  'each_session',
                  t({
                    id: 'settings.spawn.verifyTiming.eachSession',
                    defaultMessage: 'After each session',
                  }),
                ],
                [
                  'before_landing',
                  t({
                    id: 'settings.spawn.verifyTiming.beforeLanding',
                    defaultMessage: 'Before landing',
                  }),
                ],
              ],
              (value) => void save({ verify_timing: value }, 'spawn'),
            )}
            {backToGlobal('verify_timing', verifyTiming, 'spawn')}
          </Row>
        </div>
      </Section>
      <Section
        title={routesLabel}
        action={
          own('kind_routes')
            ? backToGlobal('kind_routes', routesLabel, 'routes', () => {
                setRoutes(null);
                setShown([]);
              })
            : undefined
        }
      >
        {groupFailure('routes')}
        <div className="ps-rows" aria-busy={pending || undefined}>
          {draft.map((route, i) => {
            const n = i + 1;
            const found = kindProblem(draft, i);
            // A duplicate shows in every route that names the kind once one of them was left.
            const left =
              found === 'duplicate'
                ? draft.some((r) => r.kind === route.kind && shown.includes(r.id))
                : shown.includes(route.id);
            const problem = left ? found : null;
            const leave = () => {
              setShown((s) => (s.includes(route.id) ? s : [...s, route.id]));
              void commitRoutes(draft);
            };
            const setFallbacks = (fallbacks: RuntimeChoice[]) =>
              void commitRoutes(editRoute(i, { fallbacks }));
            return (
              <div
                key={route.id}
                className="ps-row spw-route"
                role="group"
                aria-label={t({ id: 'settings.spawn.route', defaultMessage: 'Route {n}' }, { n })}
              >
                <span className="spw-main">
                  <input
                    className="inp mono spw-kind"
                    spellCheck={false}
                    aria-label={kindLabel}
                    aria-invalid={problem !== null || undefined}
                    placeholder={kindLabel}
                    disabled={disabled}
                    value={route.kind}
                    onChange={(e) => setRoutes(editRoute(i, { kind: e.target.value }))}
                    onBlur={leave}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') leave();
                    }}
                  />
                  {menu(
                    t({ id: 'settings.spawn.preferred', defaultMessage: 'Preferred' }),
                    route.choice,
                    (choice) => void commitRoutes(editRoute(i, { choice })),
                  )}
                  <button
                    type="button"
                    className="ib"
                    disabled={disabled}
                    aria-label={t(
                      { id: 'settings.spawn.deleteRoute', defaultMessage: 'Delete route {n}' },
                      { n },
                    )}
                    onClick={() => {
                      setShown((s) => s.filter((id) => id !== route.id));
                      void commitRoutes(draft.filter((_, j) => j !== i));
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
                {route.fallbacks.map((fallback, f) => {
                  const m = f + 1;
                  return (
                    <span key={f} className="spw-fallback">
                      {menu(
                        t(
                          { id: 'settings.spawn.fallback', defaultMessage: 'Fallback {n}' },
                          { n: m },
                        ),
                        fallback,
                        (choice) =>
                          setFallbacks(route.fallbacks.map((x, j) => (j === f ? choice : x))),
                      )}
                      <button
                        type="button"
                        className="ib"
                        disabled={disabled || f === 0}
                        aria-label={t(
                          {
                            id: 'settings.spawn.fallbackUp',
                            defaultMessage: 'Move fallback {n} up',
                          },
                          { n: m },
                        )}
                        onClick={() => setFallbacks(swap(route.fallbacks, f, f - 1))}
                      >
                        <ArrowUp aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ib"
                        disabled={disabled || f === route.fallbacks.length - 1}
                        aria-label={t(
                          {
                            id: 'settings.spawn.fallbackDown',
                            defaultMessage: 'Move fallback {n} down',
                          },
                          { n: m },
                        )}
                        onClick={() => setFallbacks(swap(route.fallbacks, f, f + 1))}
                      >
                        <ArrowDown aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="ib"
                        disabled={disabled}
                        aria-label={t(
                          {
                            id: 'settings.spawn.deleteFallback',
                            defaultMessage: 'Delete fallback {n}',
                          },
                          { n: m },
                        )}
                        onClick={() => setFallbacks(route.fallbacks.filter((_, j) => j !== f))}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
                {route.fallbacks.length < FALLBACKS_MAX && (
                  <span className="spw-fallback">
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled}
                      onClick={() =>
                        setFallbacks([
                          ...route.fallbacks,
                          {
                            runtime: usable.find((r) => r !== route.choice.runtime) ?? firstRuntime,
                          },
                        ])
                      }
                    >
                      <Plus aria-hidden="true" />
                      {t({ id: 'settings.spawn.addFallback', defaultMessage: 'Add a fallback' })}
                    </button>
                  </span>
                )}
                {problem !== null && (
                  <span className="ps-err" role="alert">
                    {KIND_PROBLEM[problem]()}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Section>
      {draft.length < ROUTES_MAX && (
        <button
          type="button"
          className="btn spw-add"
          disabled={disabled}
          onClick={() =>
            setRoutes([
              ...draft,
              {
                id: Math.max(-1, ...draft.map((r) => r.id)) + 1,
                kind: '',
                choice: { runtime: firstRuntime },
                fallbacks: [],
              },
            ])
          }
        >
          <Plus aria-hidden="true" />
          {t({ id: 'settings.spawn.addRoute', defaultMessage: 'Add a route' })}
        </button>
      )}
    </>
  );
}
