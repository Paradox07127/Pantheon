import { useEffect, useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { GripVertical, Plus, X } from 'lucide-react';
import { create } from 'zustand';
import type { BoardSnapshot } from '@pantheon/protocol';
import { EnvironmentCheck } from '../../components/EnvironmentCheck';
import { PathText } from '../../components/PathText';
import { useBaselineRead } from '../../data/baseline-read';
import { runCommand } from '../../data/commands';
import {
  isPolicy,
  PARAM_LABEL,
  setPolicy,
  useWorkflowPolicy,
  type PolicyPatch,
  type WorkflowPolicy,
} from '../../data/workflow-policy';
import { useQuery } from '../../data/workbench-sessions';
import { copyPathProblem, type CopyPathProblem } from '../../data/worktree-setup';
import { t } from '../../i18n';
import { durationText } from '../../lib/time-text';
import {
  addRow,
  checkGate,
  DEFAULT_TIMEOUT_SECONDS,
  gateSetRequest,
  knownGitFolder,
  lastDuration,
  moveRow,
  placeRow,
  protectedPathsRequest,
  removeRow,
  rowsOf,
  savedGate,
  type GateRow,
  type GateRun,
} from './gate';
import { failureText, Section, type Failure } from './ProjectSettingsScreen';
import { EmptyState } from '../../components/EmptyState';
import './gates.css';
import './policy-rows.css';

type Project = BoardSnapshot['projects'][number];

type GateSave = { revision: number; rows: GateRow[] };

/** Each folder gate's last save until the board catches up, by project and folder. */
const useGateSaves = create<Record<string, GateSave>>(() => ({}));
const saveKey = (project_id: string, root: string) => `${project_id}\n${root}`;
const putSave = (key: string, save: GateSave | null) =>
  useGateSaves.setState((saves) => {
    const { [key]: _, ...rest } = saves;
    return save ? { ...rest, [key]: save } : rest;
  }, true);

const runParams = (project_id: string) => ({ project_id, limit: '30' });
const acceptRuns = (value: unknown): GateRun[] | null => {
  const runs = (value as { runs?: unknown } | null)?.runs;
  return Array.isArray(runs) ? (runs as GateRun[]) : null;
};

/** One gate per folder, in the project's folder order, then what follows a failed gate. */
export function ProjectGate({ project }: { project: Project }) {
  const baseline = useBaselineRead(project.id).read;
  const runs = useQuery('project.gates.history', project.id, runParams, acceptRuns, 0).data ?? [];
  const named = project.roots.length > 1;
  return (
    <>
      <EnvironmentCheck
        project_id={project.id}
        planned={project.roots.map((root) => ({
          root,
          commands: (project.gates?.[root] ?? []).filter((command) => command.enabled !== false),
        }))}
      />
      {project.roots.map((root) => (
        <FolderGate
          key={root}
          project={project}
          root={root}
          named={named}
          git={knownGitFolder(project, baseline, root)}
          runs={runs}
        />
      ))}
      <GatePolicy project={project} />
    </>
  );
}

/**
 * The commands every merge into this folder must pass first, in order; the same for every runtime.
 * A change saves when it is made: a field when it is left, a move or a removal at once.
 */
export function FolderGate({
  project,
  root,
  named,
  git,
  runs,
}: {
  project: Project;
  root: string;
  /** Show the folder's path, for a project with more than one folder. */
  named: boolean;
  git: boolean;
  runs: readonly GateRun[];
}) {
  const saved = savedGate(project, root);
  const [rows, setRows] = useState<GateRow[] | null>(null);
  // Keys of the rows last saved, so the saved gate read back keeps their elements and focus.
  const [ids, setIds] = useState<readonly number[]>([]);
  // The row the change that failed came from; null for the whole gate.
  const [failure, setFailure] = useState<{ row: number | null; failure: Failure } | null>(null);
  // Rows whose problems show: those a save was held back for.
  const [shown, setShown] = useState<readonly number[]>([]);
  const [saving, setSaving] = useState(false);
  const sending = useRef(false);
  // Keep the submitted rows until the board catches up; a change made meanwhile waits in queued.
  const key = saveKey(project.id, root);
  const savedAt = useGateSaves((saves) => saves[key] ?? null);
  const setSavedAt = (save: GateSave | null) => putSave(key, save);
  useEffect(() => () => putSave(key, null), [key]);
  const queued = useRef<{ row: number | null } | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const [added, setAdded] = useState<number | null>(null);
  const [grip, setGrip] = useState<number | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const draft = rows ?? rowsOf(saved, ids);
  const check = checkGate(saved, draft);
  const busy = saving || savedAt !== null;

  const commit = async (next: GateRow[], row: number | null) => {
    setRows(next);
    const nextCheck = checkGate(saved, next);
    if (!nextCheck.commands) {
      const held = next.filter((_, i) => nextCheck.rows[i]!.errors.length > 0).map((r) => r.id);
      setShown((s) => [...s, ...held.filter((id) => !s.includes(id))]);
      return;
    }
    if (nextCheck.status === 'unchanged') return;
    if (sending.current || savedAt) {
      queued.current = { row };
      return;
    }
    sending.current = true;
    setSaving(true);
    const request = gateSetRequest(project, root, nextCheck.commands);
    const result = await runCommand(request.type, request.input, request.expected_revision);
    sending.current = false;
    setSaving(false);
    setFailure(result.ok ? null : { row, failure: result.error });
    if (result.ok)
      setSavedAt({
        revision: (result.value as Project).revision ?? request.expected_revision + 1,
        rows: next,
      });
  };

  useEffect(() => {
    if (!savedAt || project.revision < savedAt.revision) return;
    setIds(savedAt.rows.map((r) => r.id));
    setRows((r) => (r === savedAt.rows ? null : r));
    setSavedAt(null);
  }, [project.revision, savedAt]);

  // A change made while the last save waited goes out once the board has caught up.
  useEffect(() => {
    if (busy || !queued.current) return;
    const { row } = queued.current;
    queued.current = null;
    void commit(draft, row);
  }, [busy]);

  // A row moved by keyboard is put back in the list, so its handle takes the focus again.
  useEffect(() => {
    if (grip === null) return;
    list.current?.querySelector<HTMLElement>(`[data-grip="${grip}"]`)?.focus();
    setGrip(null);
  }, [grip]);

  const edit = (index: number, field: 'name' | 'line' | 'timeout', value: string) =>
    setRows(draft.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  const flip = (index: number, field: 'enabled' | 'skippable', value: boolean) =>
    void commit(
      draft.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
      draft[index]!.id,
    );
  const move = (from: number, to: number) => {
    const next = placeRow(draft, from, to);
    if (next !== draft) void commit(next, draft[from]!.id);
  };

  const nameLabel = t({ id: 'settings.gate.name', defaultMessage: 'Name' });
  const lineLabel = t({ id: 'settings.gate.line', defaultMessage: 'Command line' });
  const timeoutLabel = t({ id: 'settings.gate.timeoutField', defaultMessage: 'Timeout (s)' });
  const rowFailure = failure && draft.some((r) => r.id === failure.row) ? failure : null;

  return (
    <div className="gt-folder">
      <Section
        title={t({ id: 'settings.gate.order', defaultMessage: 'Runs in order before merging' })}
        settingId="gates.gate"
        action={
          named ? (
            <span className="gt-dir">
              <PathText path={root} className="mono" />
              {git && (
                <span className="chip">
                  {t({ id: 'settings.gate.gitFolder', defaultMessage: 'git' })}
                </span>
              )}
            </span>
          ) : undefined
        }
      >
        {failure && !rowFailure && (
          <div className="ps-err" role="alert">
            {failureText(failure.failure)}
          </div>
        )}
        {draft.length === 0 ? (
          <EmptyState
            inline
            title={t({
              id: 'settings.gate.none',
              defaultMessage: 'No gate: merging runs no commands',
            })}
          />
        ) : (
          <div className="ps-rows" ref={list}>
            {draft.map((row, i) => {
              const n = i + 1;
              const { argv, errors } = check.rows[i]!;
              const took = argv && lastDuration({ name: row.name.trim(), argv }, runs);
              const leave = () => void commit(draft, row.id);
              const enter = (e: { key: string }) => {
                if (e.key === 'Enter') leave();
              };
              return (
                <div
                  key={row.id}
                  className="ps-row gt-step"
                  role="group"
                  aria-label={t({ id: 'settings.gate.step', defaultMessage: 'Step {n}' }, { n })}
                  data-dragged={dragged === i || undefined}
                  onDragOver={
                    dragged === null
                      ? undefined
                      : (e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }
                  }
                  onDrop={
                    dragged === null
                      ? undefined
                      : (e) => {
                          e.preventDefault();
                          setDragged(null);
                          move(dragged, i);
                        }
                  }
                >
                  <span className="gt-main">
                    <button
                      type="button"
                      className="ib gt-grip"
                      draggable
                      data-grip={row.id}
                      aria-label={t(
                        { id: 'settings.gate.moveStep', defaultMessage: 'Move step {n}' },
                        { n },
                      )}
                      aria-keyshortcuts="ArrowUp ArrowDown"
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', row.name);
                        setDragged(i);
                      }}
                      onDragEnd={() => setDragged(null)}
                      onKeyDown={(e) => {
                        const by = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
                        if (by === 0) return;
                        e.preventDefault();
                        const next = moveRow(draft, i, by);
                        if (next === draft) return;
                        setGrip(row.id);
                        void commit(next, row.id);
                      }}
                    >
                      <GripVertical aria-hidden="true" />
                    </button>
                    <input
                      type="checkbox"
                      className="ps-sw gt-on"
                      aria-label={t(
                        { id: 'settings.gate.enableStep', defaultMessage: 'Turn on step {n}' },
                        { n },
                      )}
                      checked={row.enabled}
                      onChange={(e) => flip(i, 'enabled', e.target.checked)}
                    />
                    <span className="gt-text">
                      <input
                        className="gt-name"
                        data-setting-id="gates.name"
                        aria-label={nameLabel}
                        placeholder={nameLabel}
                        autoFocus={row.id === added}
                        value={row.name}
                        onChange={(e) => edit(i, 'name', e.target.value)}
                        onBlur={leave}
                        onKeyDown={enter}
                      />
                      <input
                        className="gt-line"
                        data-setting-id="gates.commandLine"
                        aria-label={lineLabel}
                        placeholder={lineLabel}
                        spellCheck={false}
                        value={row.line}
                        onChange={(e) => edit(i, 'line', e.target.value)}
                        onBlur={leave}
                        onKeyDown={enter}
                      />
                    </span>
                  </span>
                  <span className="gt-end">
                    {took != null && <span className="gt-took">{durationText(took)}</span>}
                    <label className="gt-timeout" data-setting-id="gates.timeout">
                      <input
                        className="inp mono"
                        inputMode="decimal"
                        aria-label={timeoutLabel}
                        placeholder={String(DEFAULT_TIMEOUT_SECONDS)}
                        value={row.timeout}
                        onChange={(e) => edit(i, 'timeout', e.target.value)}
                        onBlur={leave}
                        onKeyDown={enter}
                      />
                      <span aria-hidden="true">
                        {t({ id: 'settings.gate.timeoutUnit', defaultMessage: 's timeout' })}
                      </span>
                    </label>
                    {row.enabled && (
                      <label className="ps-tg gt-skip">
                        <span aria-hidden="true">
                          {t({ id: 'settings.gate.skippable', defaultMessage: 'Skippable' })}
                        </span>
                        <input
                          type="checkbox"
                          className="ps-sw"
                          aria-label={t(
                            {
                              id: 'settings.gate.skippableStep',
                              defaultMessage: 'Step {n} can be skipped when it fails',
                            },
                            { n },
                          )}
                          checked={row.skippable}
                          onChange={(e) => flip(i, 'skippable', e.target.checked)}
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="ib gt-del"
                      aria-label={t(
                        { id: 'settings.gate.deleteStep', defaultMessage: 'Delete step {n}' },
                        { n },
                      )}
                      onClick={() => void commit(removeRow(draft, i), null)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </span>
                  {shown.includes(row.id) && errors.length > 0 && (
                    <div className="ps-err gt-err" role="alert">
                      {errors.join(t({ id: 'settings.gate.errorSeparator', defaultMessage: '; ' }))}
                    </div>
                  )}
                  {rowFailure?.row === row.id && (
                    <div className="ps-err gt-err" role="alert">
                      {failureText(rowFailure.failure)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <button
        type="button"
        className="btn gt-add"
        onClick={() => {
          const next = addRow(draft);
          setAdded(next.at(-1)!.id);
          setRows(next);
        }}
      >
        <Plus aria-hidden="true" />
        {t({ id: 'settings.gate.addStep', defaultMessage: 'Add a step' })}
      </button>
      <ProtectedPaths project={project} root={root} busy={busy} />
    </div>
  );
}

const PROTECT_PROBLEM: Record<Exclude<CopyPathProblem, 'empty'>, () => string> = {
  duplicate: () =>
    t({ id: 'settings.gate.protectDuplicate', defaultMessage: 'Already in the list' }),
  absolute: () =>
    t({
      id: 'settings.gate.protectAbsolute',
      defaultMessage: 'Use a path relative to the folder, not an absolute one',
    }),
  parent: () =>
    t({
      id: 'settings.gate.protectParent',
      defaultMessage: 'The path cannot leave the folder with ..',
    }),
};

/**
 * The paths or globs, besides the files the gate names, that a merge into this folder changes only
 * with the user's leave; a change saves at once.
 */
export function ProtectedPaths({
  project,
  root,
  busy,
}: {
  project: Project;
  root: string;
  /** The folder's steps are being saved. */
  busy: boolean;
}) {
  // The list sent, until the board reaches the revision its save returned; null while it is out.
  const [sent, setSent] = useState<{ paths: string[]; revision: number | null } | null>(null);
  const [adding, setAdding] = useState('');
  const [problem, setProblem] = useState<Exclude<CopyPathProblem, 'empty'> | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    if (sent?.revision != null && project.revision >= sent.revision) setSent(null);
  }, [project.revision, sent]);

  const paths = sent?.paths ?? project.protected_paths?.[root] ?? [];
  const off = busy || sent !== null;
  const save = async (next: string[]) => {
    if (off) return;
    setSent({ paths: next, revision: null });
    setFailure(null);
    const request = protectedPathsRequest(project, root, next);
    const result = await runCommand(request.type, request.input, request.expected_revision);
    setSent(
      result.ok
        ? {
            paths: next,
            revision: (result.value as Project).revision ?? request.expected_revision + 1,
          }
        : null,
    );
    if (!result.ok) setFailure(result.error);
  };
  const add = () => {
    const entry = adding.trim();
    const found = copyPathProblem(entry, paths);
    if (found === 'empty') return;
    if (found) {
      setProblem(found);
      return;
    }
    setAdding('');
    void save([...paths, entry]);
  };
  const pathLabel = t({
    id: 'settings.gate.protectPath',
    defaultMessage: 'Path or glob to protect',
  });

  return (
    <Section title={t({ id: 'settings.gate.protected', defaultMessage: 'Protected paths' })}>
      {failure && (
        <div className="ps-err" role="alert">
          {failureText(failure)}
        </div>
      )}
      <div className="ps-rows" aria-busy={sent !== null || undefined}>
        {paths.map((entry) => (
          <div key={entry} className="ps-row">
            <span className="ps-row-nm mono gt-path">{entry}</span>
            <div className="ps-row-ct">
              <button
                type="button"
                className="ib"
                disabled={off}
                aria-label={t(
                  { id: 'settings.gate.unprotect', defaultMessage: 'Stop protecting {path}' },
                  { path: entry },
                )}
                onClick={() => void save(paths.filter((p) => p !== entry))}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        <div className="ps-row">
          <span className="ps-row-nm">
            <input
              className="inp mono"
              spellCheck={false}
              aria-label={pathLabel}
              aria-invalid={problem !== null || undefined}
              value={adding}
              onChange={(e) => {
                setAdding(e.target.value);
                setProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            {problem !== null && (
              <span className="ps-err" role="alert">
                {PROTECT_PROBLEM[problem]()}
              </span>
            )}
          </span>
          <div className="ps-row-ct">
            <button
              type="button"
              className="ib"
              disabled={off}
              aria-label={t({ id: 'settings.gate.protect', defaultMessage: 'Protect this path' })}
              onClick={add}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </Section>
  );
}

type GatePolicyPatch = Pick<PolicyPatch, 'gate_on_fail' | 'gate_runner'>;

/** The gate fields of a policy; those it stores none of read as the daemon's defaults. */
const gatePolicyOf = (policy: WorkflowPolicy): Required<GatePolicyPatch> => ({
  gate_on_fail: policy.gate_on_fail ?? 'stop',
  gate_runner: policy.gate_runner ?? 'daemon',
});

const useGatePolicySave = create<{
  /** The policy a command returned, shown until a read reaches its version. */
  saved: WorkflowPolicy | null;
  pending: boolean;
  failure: { project_id: string; text: string } | null;
  /** Counts the saves that went through, so the page reads the policy again after each. */
  saves: number;
}>(() => ({ saved: null, pending: false, failure: null, saves: 0 }));

/** Sends the fields of wanted that differ from the policy; nothing when none do. */
async function saveGatePolicy(policy: WorkflowPolicy, wanted: GatePolicyPatch) {
  const current: Record<string, unknown> = gatePolicyOf(policy);
  const patch = Object.fromEntries(
    Object.entries(wanted).filter(([key, value]) => current[key] !== value),
  ) as PolicyPatch;
  if (useGatePolicySave.getState().pending || Object.keys(patch).length === 0) return;
  useGatePolicySave.setState({ pending: true, failure: null });
  const result = await setPolicy(policy, patch);
  const s = useGatePolicySave.getState();
  useGatePolicySave.setState(
    result.ok
      ? {
          pending: false,
          saved: isPolicy(result.value) ? result.value : s.saved,
          saves: s.saves + 1,
        }
      : { pending: false, failure: { project_id: policy.project_id, text: result.error } },
  );
}

type PolicyChoice<T> = {
  label: string;
  value: T;
  choices: readonly (readonly [T, string])[];
  disabled: boolean;
  onChange: (value: T) => void;
};

function policySegments<T extends string>(props: PolicyChoice<T>) {
  return (
    <RadioGroup<T>
      className="seg"
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onValueChange={props.onChange}
    >
      {props.choices.map(([value, text]) => (
        <Radio.Root key={value} value={value}>
          {text}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/**
 * What follows a failed gate: the agent is sent back to fix it, the failed step reruns once first,
 * or the work stops at once; then where the gates run.
 */
export function GatePolicy({ project }: { project: Project }) {
  const read = useWorkflowPolicy(project.id);
  const savedPolicy = useGatePolicySave((s) => s.saved);
  const pending = useGatePolicySave((s) => s.pending);
  const savedFailure = useGatePolicySave((s) => s.failure);
  const saves = useGatePolicySave((s) => s.saves);

  const saved = savedPolicy?.project_id === project.id ? savedPolicy : null;
  const policy =
    saved && (!read.read || read.read.policy_version < saved.policy_version) ? saved : read.read;
  const failure = savedFailure?.project_id === project.id ? savedFailure.text : null;

  useEffect(() => {
    if (saves > 0) read.reload();
  }, [saves]);

  if (!policy)
    return read.error ? (
      <div className="ps-err" role="alert">
        {read.error}
      </div>
    ) : null;
  const current = gatePolicyOf(policy);
  const disabled = pending || read.stale;
  const save = (patch: GatePolicyPatch) => void saveGatePolicy(policy, patch);
  const onFail = t({ id: 'settings.gate.onFail', defaultMessage: 'When a gate fails' });
  const runner = t({ id: 'settings.gate.runner', defaultMessage: 'Where gates run' });
  return (
    <div className="ps-grp">
      <div className="ps-rows" aria-busy={pending || undefined}>
        <div className="ps-row wf-pr" data-setting-id="gates.onFail">
          <span className="wf-nm">
            <span>{onFail}</span>
          </span>
          <span className="gt-fail">
            {policySegments<Required<GatePolicyPatch>['gate_on_fail']>({
              label: onFail,
              value: current.gate_on_fail,
              choices: [
                [
                  'retry',
                  t({ id: 'settings.gate.onFail.retry', defaultMessage: 'Rerun once first' }),
                ],
                ['stop', t({ id: 'settings.gate.onFail.stop', defaultMessage: 'Stop for me' })],
              ],
              disabled,
              onChange: (gate_on_fail) => save({ gate_on_fail }),
            })}
          </span>
          <span />
        </div>
        <div className="ps-row wf-pr" data-setting-id="gates.runner">
          <span className="wf-nm">{runner}</span>
          {policySegments<Required<GatePolicyPatch>['gate_runner']>({
            label: runner,
            value: current.gate_runner,
            choices: [
              ['daemon', t({ id: 'settings.gate.runner.daemon', defaultMessage: 'daemon' })],
              [
                'session',
                t({ id: 'settings.gate.runner.session', defaultMessage: 'Session worktree' }),
              ],
            ],
            disabled,
            onChange: (gate_runner) => save({ gate_runner }),
          })}
          <span />
        </div>
      </div>
      {failure && (
        <div className="ps-err gt-err" role="alert">
          {failure}
        </div>
      )}
    </div>
  );
}
