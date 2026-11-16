import { useState, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Markdown } from '../../components/Markdown';
import { PathText } from '../../components/PathText';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { useBoard } from '../../data/board';
import { useFactsRead } from '../../data/facts-read';
import { shortId } from '../../data/format';
import { useIntroRead } from '../../data/intro-read';
import { ageText, useNow } from '../../data/needs-you';
import { effectiveSessionDefaults, useLastProjectDefaults } from '../../data/project-defaults';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { mermaidBlocks } from '../board/intro-model';
import { defaultModelFor, defaultRuntime } from '../sessions/model';
import { ModelMenu, type ModelChoice } from '../sessions/ModelMenu';
import { workstreamRows } from './facts';
import { TaskGraph } from './TaskGraph';
import { WorkstreamBars } from './WorkstreamBars';
import { WorkstreamDetails } from './WorkstreamDetails';
import { at, Button, Field, useSend, type Send } from './parts';
import {
  baselineConfirmRequest,
  baselineDraft,
  baselineExtensions,
  baselineFolders,
  baselineStartRequest,
  baselineWorkstreams,
  type BaselineChoice,
  type ProjectBaseline,
  type BaselineDraft,
  type BaselineEntry,
} from './baseline';

export function StartBaseline({
  project_id,
  entry,
}: {
  project_id: string;
  entry: Extract<BaselineEntry, { kind: 'start' }>;
}) {
  const send = useSend();
  return (
    <>
      {entry.failure && (
        <div className="ps-err" role="alert">
          {entry.failure}
        </div>
      )}
      <BaselineLaunch
        project_id={project_id}
        label={entry.label}
        busy={send.busy}
        onStart={(choice) => void send.send(baselineStartRequest(project_id, choice))}
      />
      <Result send={send} />
    </>
  );
}

/** A model menu choice as a baseline start takes it; the daemon has no backend for a baseline. */
const startChoice = (value: ModelChoice): BaselineChoice => ({
  runtime: value.runtime,
  ...(value.model !== null && { model: value.model }),
  ...(value.effort !== null && { effort: value.effort }),
});

/** The baseline's model menu, opening on what a new session of the project gets, and its start button. */
export function BaselineLaunch({
  project_id,
  label,
  busy,
  onStart,
}: {
  project_id: string;
  label: string;
  busy: boolean;
  onStart: (choice: BaselineChoice) => void;
}) {
  // A baseline only reads the project.
  const { read, runtimes, unavailable, disconnected } = useRuntimeStatus('reviewer');
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === project_id));
  const defaults = effectiveSessionDefaults(project, useLastProjectDefaults());
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const chosen = choice?.runtime ?? defaultRuntime(runtimes, defaults?.runtime, unavailable);
  const offered = offeredRuntimes(read, [chosen]);
  const models = useRuntimeModels(project_id, offered);
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
  return (
    <span className="hm-row">
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
      <Button label={label} tone="pri" busy={busy} onPress={() => onStart(startChoice(value))} />
    </span>
  );
}

/** The baseline's model menu and start button in a popover at `anchor`; starting closes it. */
export function BaselinePopover({
  project_id,
  anchor,
  label,
  busy,
  onClose,
  onStart,
}: {
  project_id: string;
  anchor: RefObject<Element | null>;
  label: string;
  busy: boolean;
  onClose: () => void;
  onStart: (choice: BaselineChoice) => void;
}) {
  return (
    <Popover.Root open onOpenChange={(open) => open || onClose()}>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="end"
          sideOffset={4}
          style={{ zIndex: 40 }}
        >
          <Popover.Popup
            className="pop"
            style={{ padding: 'var(--sp-2)' }}
            aria-label={t({ id: 'projects.baseline.model', defaultMessage: 'Baseline model' })}
          >
            <BaselineLaunch
              project_id={project_id}
              label={label}
              busy={busy}
              onStart={(choice) => {
                onClose();
                onStart(choice);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function RunningBaseline({ baseline }: { baseline: ProjectBaseline }) {
  const now = useNow();
  return (
    <span className="hm-row">
      <span className="hm-rt">
        <StateGlyph name="running" />
        {t({ id: 'projects.baseline.running', defaultMessage: 'Baseline running' })}
      </span>
      {baseline.runtime && (
        <span className="hm-rt">
          <RuntimeGlyph runtime={baseline.runtime} size={14} />
          {runtimeName(baseline.runtime)}
        </span>
      )}
      <span className="mu">{ageText(baseline.created_at, now)}</span>
    </span>
  );
}

export function ReviewBaseline({
  baseline,
  onConfirmed,
  dialog,
}: {
  baseline: ProjectBaseline;
  /** Called with the confirmed baseline, which names the lead session it opened. */
  onConfirmed?: (confirmed: unknown) => void;
  /** In the add-project dialog: Confirm sits in its footer, and a lone folder is not named again under its header. */
  dialog?: boolean;
}) {
  const [draft, setDraft] = useState(() => baselineDraft(baseline));
  const send = useSend();
  const edit = (patch: Partial<BaselineDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const folders = baselineFolders(baseline, draft);
  const extensions = baselineExtensions(draft);
  const facts = useFactsRead(baseline.project_id);
  const workstreams = workstreamRows(baselineWorkstreams(baseline, facts.read?.workstreams ?? []));
  const tasks = baseline.result?.tasks ?? [];
  // Risks before notes.
  const findings = [...(baseline.result?.findings ?? [])].sort(
    (a, b) => Number(b.severity === 'risk') - Number(a.severity === 'risk'),
  );
  const contradictions = baseline.result?.contradictions ?? [];
  const intro = useIntroRead(baseline.project_id);
  const flow = mermaidBlocks(intro.read?.intro?.body ?? '');
  const confirm = (
    <Button
      label={t({ id: 'projects.baseline.confirm', defaultMessage: 'Confirm' })}
      tone="pri"
      busy={send.busy}
      onPress={() => void send.send(baselineConfirmRequest(baseline, draft), onConfirmed)}
    />
  );
  const fields = (
    <>
      <div
        className="hm-card hm-form"
        role="group"
        aria-label={t({ id: 'projects.baseline.goal', defaultMessage: 'Goal' })}
      >
        <Field label={t({ id: 'projects.baseline.goal', defaultMessage: 'Goal' })}>
          <input value={draft.goal} onChange={(e) => edit({ goal: e.target.value })} />
        </Field>
        <Field label={t({ id: 'projects.baseline.goals', defaultMessage: 'Goals' })}>
          <textarea
            rows={3}
            value={draft.goals.join('\n')}
            onChange={(e) => edit({ goals: e.target.value.split('\n') })}
          />
        </Field>
        <Field label={t({ id: 'projects.baseline.nonGoals', defaultMessage: 'Non-goals' })}>
          <textarea
            rows={3}
            value={draft.non_goals.join('\n')}
            onChange={(e) => edit({ non_goals: e.target.value.split('\n') })}
          />
        </Field>
      </div>
      {folders.length > 0 && (
        <div
          className="hm-dirs"
          role="group"
          aria-label={t({ id: 'projects.baseline.gates', defaultMessage: 'Gate commands' })}
        >
          {folders.map((folder) => (
            <fieldset key={folder.root} className="hm-pick" aria-label={folder.root}>
              <div className="hm-dir">
                {!(dialog && folders.length === 1) && (
                  <PathText path={folder.root} className="mono" />
                )}
                <span className="mu">{folder.facts}</span>
              </div>
              {folder.gate.map((i) => {
                const item = draft.gate[i]!;
                return (
                  <label key={i} className="hm-pi">
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={(e) =>
                        edit({
                          gate: draft.gate.map((g, j) =>
                            j === i ? { ...g, checked: e.target.checked } : g,
                          ),
                        })
                      }
                    />
                    <span className="hm-line" title={item.command.name}>
                      {item.command.name}
                    </span>
                    <span className="mu mono">{item.command.argv.join(' ')}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      )}
      {extensions.length > 0 && (
        <div
          className="hm-dirs"
          role="group"
          aria-label={t({
            id: 'projects.baseline.extensions',
            defaultMessage: 'Extensions turned off automatically',
          })}
        >
          {extensions.map((group) => (
            <fieldset
              key={group.runtime}
              className="hm-pick"
              aria-label={runtimeName(group.runtime)}
            >
              <div className="hm-dir">
                <span className="hm-rt">
                  <RuntimeGlyph runtime={group.runtime} size={14} />
                  {runtimeName(group.runtime)}
                </span>
              </div>
              {group.items.map((i) => {
                const item = draft.extensions[i]!;
                return (
                  <label key={i} className="hm-pi hm-ext">
                    <input
                      type="checkbox"
                      aria-label={t(
                        {
                          id: 'projects.baseline.keepOff',
                          defaultMessage: 'Keep {runtime} {name} off',
                        },
                        { runtime: runtimeName(group.runtime), name: item.name },
                      )}
                      checked={item.checked}
                      onChange={(e) =>
                        edit({
                          extensions: draft.extensions.map((x, j) =>
                            j === i ? { ...x, checked: e.target.checked } : x,
                          ),
                        })
                      }
                    />
                    <span className="hm-line mono" title={item.name}>
                      {item.name}
                    </span>
                    <span className="mu hm-line" title={item.reason}>
                      {item.reason}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      )}
      {workstreams.length > 0 && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({ id: 'projects.baseline.workstreams', defaultMessage: 'Workstreams' })}
        >
          <WorkstreamBars rows={workstreams} />
          <WorkstreamDetails rows={baseline.result?.workstreams ?? []} />
        </div>
      )}
      {tasks.length > 0 && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({ id: 'projects.baseline.tasks.label', defaultMessage: 'Next tasks' })}
        >
          <TaskGraph tasks={tasks} workstreams={baseline.result?.workstreams ?? []} />
        </div>
      )}
      {flow && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({ id: 'projects.baseline.flow.label', defaultMessage: 'Main flow' })}
        >
          <Markdown text={flow} />
        </div>
      )}
      {findings.length > 0 && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({ id: 'projects.baseline.findings', defaultMessage: 'Findings' })}
        >
          {findings.map((finding, i) => (
            <span key={i} className="hm-row">
              <span className={finding.severity === 'risk' ? 'tr-st bad' : 'tr-st'}>
                {finding.severity === 'risk'
                  ? t({ id: 'projects.baseline.finding.risk', defaultMessage: 'Risk' })
                  : t({ id: 'projects.baseline.finding.info', defaultMessage: 'Note' })}
              </span>
              <span>{finding.text}</span>
            </span>
          ))}
        </div>
      )}
      {contradictions.length > 0 && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({
            id: 'projects.baseline.contradictions',
            defaultMessage: 'Docs the code contradicts',
          })}
        >
          {contradictions.map((entry, i) => (
            <span key={i}>{entry.text}</span>
          ))}
        </div>
      )}
      {draft.answers.length > 0 && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({ id: 'projects.baseline.questions', defaultMessage: 'Open questions' })}
        >
          {draft.answers.map((item, i) => (
            <div key={i} className="hm-why">
              <span>{item.question}</span>
              <div className="hm-opts" role="group" aria-label={item.question}>
                {item.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={item.answer === option ? 'btn sm hm-on' : 'btn sm'}
                    aria-pressed={item.answer === option}
                    onClick={() =>
                      edit({
                        answers: draft.answers.map((a, j) =>
                          j === i ? { ...a, answer: option } : a,
                        ),
                      })
                    }
                  >
                    {option}
                  </button>
                ))}
                <input
                  className="hm-other"
                  aria-label={t(
                    {
                      id: 'projects.baseline.otherAnswer',
                      defaultMessage: 'Other answer to {question}',
                    },
                    { question: item.question },
                  )}
                  placeholder={t({ id: 'projects.baseline.other', defaultMessage: 'Other' })}
                  value={
                    item.answer !== null && !item.options.includes(item.answer) ? item.answer : ''
                  }
                  onChange={(e) =>
                    edit({
                      answers: draft.answers.map((a, j) =>
                        j === i ? { ...a, answer: e.target.value || null } : a,
                      ),
                    })
                  }
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {baseline.dropped > 0 && (
        <span className="mu">
          {t(
            {
              id: 'projects.baseline.dropped',
              defaultMessage:
                '{count, plural, one {Dropped # finding without a source} other {Dropped # findings without a source}}',
            },
            { count: baseline.dropped },
          )}
        </span>
      )}
    </>
  );
  return dialog ? (
    <>
      <div className="pj-stp">{fields}</div>
      <div className="pj-df">
        <Result send={send} />
        <span style={{ flex: 1 }} />
        {confirm}
      </div>
    </>
  ) : (
    <>
      {fields}
      <span className="hm-row">{confirm}</span>
      <Result send={send} />
    </>
  );
}

export function Result({ send }: { send: Send }) {
  return (
    <>
      {send.error && (
        <div className="ps-err" role="alert">
          {send.error}
        </div>
      )}
      {send.receipt && !send.error && (
        <div className="mu hm-rc" role="status">
          {[
            t(
              { id: 'projects.receipt.recorded', defaultMessage: 'Recorded {command}' },
              { command: send.receipt.command },
            ),
            send.receipt.revision !== null && `rev ${send.receipt.revision}`,
            send.receipt.id && shortId(send.receipt.id),
            at(send.receipt.at),
          ]
            .filter(Boolean)
            .join(t({ id: 'projects.receipt.separator', defaultMessage: ', ' }))}
        </div>
      )}
    </>
  );
}
