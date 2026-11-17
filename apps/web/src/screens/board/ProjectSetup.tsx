import { useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown } from 'lucide-react';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { failureText, useNow } from '../../data/needs-you';
import { effectiveSessionDefaults, useLastProjectDefaults } from '../../data/project-defaults';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { elapsedText } from '../../data/transcript';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { keyText, shortcutKeys } from '../../lib/shortcuts';
import { baselineEntry, type ProjectBaseline } from '../projects/baseline';
import { BaselinePopover, ReviewBaseline } from '../projects/BaselineBlocks';
import { TaskGraph } from '../projects/TaskGraph';
import { defaultModelFor, defaultRuntime } from '../sessions/model';
import { ModelMenu, type ModelChoice } from '../sessions/ModelMenu';
import { defaultPermissionMode, newSessionInput } from '../sessions/thread-model';
import type { ProjectSetupRead } from './project-setup';
import './project-setup.css';

const buildLabel = () => t({ id: 'board.baseline.start', defaultMessage: 'Build baseline' });
const rebuildLabel = () => t({ id: 'board.baseline.restart', defaultMessage: 'Rebuild baseline' });
const scratchLabel = () =>
  t({ id: 'board.setup.fromScratch', defaultMessage: 'Start from scratch' });
const chooseLabel = () =>
  t({ id: 'board.setup.chooseModel', defaultMessage: 'Choose runtime and model' });
const viewLabel = () =>
  t({ id: 'board.setup.viewConversation', defaultMessage: 'View conversation' });

type Glyph = 'done' | 'running' | 'failed' | 'idle';

/** Why the failed baseline stopped, when the daemon said. */
const failureOf = (baseline: ProjectBaseline) => {
  const entry = baselineEntry(baseline, false);
  return entry.kind === 'start' ? (entry.failure ?? null) : null;
};

/** The folder's last path segment, as the steps list names it. */
const folderName = (root: string) => `${root.split(/[\\/]/).filter(Boolean).pop() ?? root}/`;

const errorLine = (error: string | null) =>
  error && (
    <p className="pst-err" role="alert">
      {error}
    </p>
  );

/**
 * A project's first steps in place of an empty page: the baseline start, its progress or failure,
 * its review, and the lead planning from it.
 */
export function ProjectSetup({
  setup,
  onOpenSession,
}: {
  setup: ProjectSetupRead;
  onOpenSession: (sessionId: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const now = useNow();
  const { state, baseline, busy, error } = setup;
  // The board's sessions do not say whether one waits for the user; the session list does.
  const lead = useSessionList(state === 'planning' ? setup.projectId : null).data?.find(
    (session) => session.id === setup.plan?.id,
  );
  const waiting = lead?.state === 'waiting' ? (lead.waiting_kind ?? 'approval') : null;
  if (state === 'none') {
    const keys = keyText(shortcutKeys('palette'));
    return (
      <div className="pst pst-es">
        <p className="pst-t">
          {t(
            {
              id: 'board.setup.readFirst',
              defaultMessage:
                'Pantheon reads {project}, asks you where it should go, then lays out the first tasks.',
            },
            { project: setup.name },
          )}
        </p>
        <div className="pst-a">
          <div className="pst-split" role="group" aria-label={buildLabel()} ref={group}>
            <button
              type="button"
              className="btn pri"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => setup.start()}
            >
              {buildLabel()}
            </button>
            <button
              type="button"
              className="btn pri"
              aria-label={chooseLabel()}
              aria-haspopup="dialog"
              aria-expanded={choosing}
              disabled={busy}
              onClick={() => setChoosing(true)}
            >
              <ChevronDown className="ic-sm" aria-hidden="true" />
            </button>
          </div>
          <span
            className="kbd"
            role="img"
            aria-label={t(
              { id: 'board.setup.palette', defaultMessage: 'Also in the command palette, {keys}' },
              { keys },
            )}
          >
            {keys}
          </span>
          {choosing && (
            <BaselinePopover
              project_id={setup.projectId}
              anchor={group}
              label={buildLabel()}
              busy={busy}
              onClose={() => setChoosing(false)}
              onStart={setup.start}
            />
          )}
        </div>
        {errorLine(error)}
      </div>
    );
  }
  if (state === 'empty_folder')
    return (
      <div className="pst pst-es">
        <p className="pst-t">
          {t(
            {
              id: 'board.setup.empty',
              defaultMessage:
                '{project} has no code yet. A setup session asks what to build and writes the first files.',
            },
            { project: setup.name },
          )}
        </p>
        <ScratchStart projectId={setup.projectId} onOpenSession={onOpenSession} />
      </div>
    );
  if (state === 'submitted' && baseline)
    return (
      <section
        className="pst pst-rv"
        aria-label={t({ id: 'board.setup.review', defaultMessage: 'Baseline review' })}
      >
        <ReviewBaseline key={baseline.id} baseline={baseline} onOpenSession={onOpenSession} />
      </section>
    );
  if (state === 'planning' && setup.plan) {
    const plan = setup.plan;
    const tasks = baseline?.result?.tasks ?? [];
    return (
      <section
        className="pst pst-pl"
        aria-label={t({ id: 'board.setup.planning', defaultMessage: 'First plan' })}
      >
        <div className="pst-lead">
          <RuntimeGlyph runtime={plan.runtime} size={14} />
          <StateGlyph name={waiting ?? 'running'} />
          <span className="pst-lt">
            {waiting
              ? t({ id: 'board.setup.leadWaiting', defaultMessage: 'Lead is waiting for you' })
              : t({ id: 'board.setup.leadWriting', defaultMessage: 'Lead is writing the plan' })}
          </span>
          {setup.planSince !== null && (
            <span className="mono mu pst-n">{elapsedText(now - setup.planSince)}</span>
          )}
          <button type="button" className="btn pst-end" onClick={() => onOpenSession(plan.id)}>
            {t({ id: 'board.setup.viewLead', defaultMessage: 'View lead' })}
          </button>
        </div>
        {tasks.length > 0 && (
          <div
            className="pst-draft"
            role="group"
            aria-label={t(
              {
                id: 'board.setup.draftGraph',
                defaultMessage:
                  'Draft task graph from the baseline, {count, plural, one {# task} other {# tasks}}',
              },
              { count: tasks.length },
            )}
          >
            <div className="pst-dh">
              <span className="chip pst-chip">
                {t({ id: 'board.setup.draft', defaultMessage: 'Draft' })}
              </span>
              <span className="mu pst-n">
                {t(
                  {
                    id: 'board.setup.taskCount',
                    defaultMessage: '{count, plural, one {# task} other {# tasks}}',
                  },
                  { count: tasks.length },
                )}
              </span>
            </div>
            <TaskGraph tasks={tasks} workstreams={baseline?.result?.workstreams ?? []} />
          </div>
        )}
      </section>
    );
  }
  if ((state !== 'running' && state !== 'failed') || !baseline) return null;
  const failed = state === 'failed';
  const submitted = new Set((baseline.folders ?? []).map((folder) => folder.root));
  const done = setup.roots.filter((root) => submitted.has(root)).length;
  const open: Glyph = failed ? 'failed' : 'running';
  const steps: { key: string; glyph: Glyph; label: string; count?: string; sub?: true }[] = [
    {
      key: 'folders',
      glyph: done >= setup.roots.length ? 'done' : open,
      label: t({ id: 'board.setup.folders', defaultMessage: 'Folders submitted' }),
      count: `${done} / ${setup.roots.length}`,
    },
    ...(failed || setup.roots.length < 2
      ? []
      : setup.roots.map((root) => ({
          key: root,
          glyph: (submitted.has(root) ? 'done' : 'running') as Glyph,
          label: folderName(root),
          sub: true as const,
        }))),
    {
      key: 'intro',
      glyph: setup.intro ? 'done' : open,
      label: t({ id: 'board.setup.intro.step', defaultMessage: 'Project introduction' }),
    },
    {
      key: 'charts',
      glyph: !setup.charts ? 'idle' : failed ? 'done' : 'running',
      label: t({ id: 'board.setup.charts', defaultMessage: 'Explanation charts' }),
      count: String(setup.charts),
    },
    {
      key: 'summary',
      glyph: 'idle',
      label: t({ id: 'board.setup.summary', defaultMessage: 'Summary' }),
    },
  ];
  const session = baseline.session_id;
  return (
    <div className="pst pst-es">
      <section
        className="panel pst-run"
        aria-label={t({ id: 'board.setup.baseline', defaultMessage: 'Baseline' })}
      >
        <div className="cell">
          <div className="pst-h">
            <StateGlyph name={failed ? 'failed' : 'running'} />
            <span className="pst-ttl">
              {failed
                ? t({ id: 'board.setup.failed', defaultMessage: 'Baseline failed' })
                : t({ id: 'board.setup.running', defaultMessage: 'Building baseline' })}
            </span>
            {!failed && (
              <span className="mono mu pst-n">{elapsedText(now - baseline.created_at)}</span>
            )}
            {baseline.runtime && (
              <span className="pst-rt">
                <RuntimeGlyph runtime={baseline.runtime} size={14} />
                {runtimeName(baseline.runtime)}
              </span>
            )}
          </div>
          {failed && errorLine(failureOf(baseline))}
        </div>
        <div className="cell">
          <ul
            className="pst-steps"
            aria-label={t({ id: 'board.setup.steps', defaultMessage: 'Steps' })}
          >
            {steps.map((step) => (
              <li
                key={step.key}
                className="pst-st"
                data-sub={step.sub}
                data-idle={step.glyph === 'idle' || undefined}
              >
                <StateGlyph name={step.glyph} />
                <span className={step.sub ? 'mono pst-cut' : 'pst-cut'}>{step.label}</span>
                {step.count !== undefined && <span className="mono pst-n">{step.count}</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="cell">
          <div className="pst-f">
            {failed && (
              <button
                type="button"
                className="btn pri"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => setup.start()}
              >
                {rebuildLabel()}
              </button>
            )}
            {session && (
              <button type="button" className="btn ghost" onClick={() => onOpenSession(session)}>
                {viewLabel()}
              </button>
            )}
          </div>
          {errorLine(error)}
        </div>
      </section>
    </div>
  );
}

/** The empty folder's start: a setup session on the runtime and model a new session gets. */
export function ScratchStart({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { read, runtimes, unavailable, disconnected } = useRuntimeStatus('writer');
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === projectId));
  const defaults = effectiveSessionDefaults(project, useLastProjectDefaults());
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const chosen = choice?.runtime ?? defaultRuntime(runtimes, defaults?.runtime, unavailable);
  const offered = offeredRuntimes(read, [chosen]);
  const models = useRuntimeModels(projectId, offered);
  const listed = models[chosen];
  const preset =
    listed?.state === 'ready'
      ? defaultModelFor(listed.models, chosen === defaults?.runtime ? defaults.model : undefined)
      : null;
  const projectModel =
    preset !== null &&
    chosen === defaults?.runtime &&
    defaults.model !== undefined &&
    (preset.id === defaults.model || preset.resolved === defaults.model);
  const value: ModelChoice = choice ?? {
    runtime: chosen,
    backend: null,
    model: preset?.id ?? null,
    effort: (projectModel ? defaults?.effort : undefined) ?? preset?.default_effort ?? null,
  };
  const create = async () => {
    setChoosing(false);
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.create',
      {
        ...newSessionInput({
          projectId,
          runtime: value.runtime,
          permissionMode: defaultPermissionMode(value.runtime, defaults?.permission_mode),
          // The setup session's first message, as the composer's own start sends it.
          input: t({ id: 'sessions.composer.fromScratch', defaultMessage: 'Start from scratch' }),
          backend: value.backend,
          model: value.model,
          effort: value.effort,
        }),
        workspace: 'worktree',
        purpose: 'project_setup',
      },
      null,
    );
    setBusy(false);
    if (!result.ok) return setError(failureText(result.error));
    const id = (result.value as { id?: unknown } | null)?.id;
    if (typeof id === 'string') onOpenSession(id);
  };
  return (
    <>
      <div className="pst-a">
        <div className="pst-split" role="group" aria-label={scratchLabel()} ref={group}>
          <button
            type="button"
            className="btn pri"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void create()}
          >
            {scratchLabel()}
          </button>
          <button
            type="button"
            className="btn pri"
            aria-label={chooseLabel()}
            aria-haspopup="dialog"
            aria-expanded={choosing}
            disabled={busy}
            onClick={() => setChoosing(true)}
          >
            <ChevronDown className="ic-sm" aria-hidden="true" />
          </button>
        </div>
        {choosing && (
          <Popover.Root open onOpenChange={(open) => open || setChoosing(false)}>
            <Popover.Portal>
              <Popover.Positioner
                anchor={group}
                side="bottom"
                align="start"
                sideOffset={4}
                style={{ zIndex: 40 }}
              >
                <Popover.Popup className="pop pst-pop" aria-label={chooseLabel()}>
                  <ModelMenu
                    runtimes={offered}
                    models={models}
                    value={value}
                    onChange={setChoice}
                    unavailable={unavailable}
                    disconnected={disconnected}
                    mode={null}
                    fast={null}
                  />
                  <button type="button" className="btn pri" onClick={() => void create()}>
                    {scratchLabel()}
                  </button>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      {errorLine(error)}
    </>
  );
}
