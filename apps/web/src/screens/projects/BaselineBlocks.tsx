import { useState, type RefObject } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ChevronRight } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { PathText } from '../../components/PathText';
import { QuestionCard } from '../../components/QuestionCard';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { StateGlyph } from '../../components/SessionStateIcon';
import { useAppSettings } from '../../data/app-settings';
import { useBoard } from '../../data/board';
import { useDrafts } from '../../data/drafts';
import { useFactsRead } from '../../data/facts-read';
import { shortId } from '../../data/format';
import { useIntroRead } from '../../data/intro-read';
import { useNow } from '../../data/needs-you';
import { effectiveSessionDefaults, useLastProjectDefaults } from '../../data/project-defaults';
import { useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { durationText } from '../../lib/time-text';
import { sourceText } from '../board/intro-model';
import { defaultModelFor, defaultRuntime } from '../sessions/model';
import { ModelMenu, type ModelChoice } from '../sessions/ModelMenu';
import { workstreamRows } from './facts';
import { TaskGraph } from './TaskGraph';
import { WorkstreamBars } from './WorkstreamBars';
import { WorkstreamDetails } from './WorkstreamDetails';
import { at, Button, Field, useSend, type Send } from './parts';
import {
  baselineAnswers,
  baselineConfirmRequest,
  baselineContinueRequest,
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
import './baseline-interview.css';

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
      <span className="mu">{durationText(now - baseline.created_at)}</span>
    </span>
  );
}

type AnsweredRoundData = NonNullable<ProjectBaseline['rounds']>[number];

/** An answered round as one row that opens to each question and its answer. */
export function AnsweredRound({ n, round }: { n: number; round: AnsweredRoundData }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="iv-rd"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
      >
        <ChevronRight className="iv-chev" size={14} aria-hidden="true" />
        <span className="iv-rn">
          {t({ id: 'projects.baseline.roundRow', defaultMessage: 'Round {round}' }, { round: n })}
        </span>
        <span className="mu">
          {t(
            {
              id: 'projects.baseline.roundQuestions',
              defaultMessage: '{count, plural, one {# question} other {# questions}}',
            },
            { count: round.questions.length },
          )}
        </span>
        <span className="hm-line">{listText(...round.answers.map((a) => a.answer))}</span>
        <StateGlyph name="done" />
      </button>
      {open && (
        <div className="iv-rda">
          {round.answers.map((a) => (
            <div key={a.question_id} className="iv-qa">
              <span className="mu">{a.question}</span>
              <span className="iv-a">
                {a.answer}
                {a.by === 'model' && (
                  <span className="chip">
                    {t({
                      id: 'projects.baseline.decidedForYou',
                      defaultMessage: 'Decided for you',
                    })}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The drafts key of the answers to the baseline's current round. */
export const interviewDraft = (baseline: ProjectBaseline) =>
  `baseline:${baseline.id}:${(baseline.rounds?.length ?? 0) + 1}`;

export function ReviewBaseline({
  baseline,
  onConfirmed,
  dialog,
  onOpenSession,
}: {
  baseline: ProjectBaseline;
  /** Called with the confirmed baseline, which names the lead session it opened. */
  onConfirmed?: (confirmed: unknown) => void;
  /** In the add-project dialog: Confirm sits in its footer, and a lone folder is not named again under its header. */
  dialog?: boolean;
  /** Opens the baseline's conversation; unset where the card already sits in it. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const [draft, setDraft] = useState(() => baselineDraft(baseline));
  // A draft made while a round ran holds the last round's result; each handed-back round starts it over.
  const drafted = `${interviewDraft(baseline)}:${baseline.state}`;
  const [draftOf, setDraftOf] = useState(drafted);
  if (draftOf !== drafted) {
    setDraftOf(drafted);
    setDraft(baselineDraft(baseline));
  }
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
  const body = intro.read?.intro?.body?.trim() ?? '';
  const { settings } = useAppSettings();
  const rounds = baseline.rounds ?? [];
  const round = rounds.length + 1;
  // The daemon's default until the settings are read.
  const limit = settings?.baseline_rounds ?? 5;
  const questions = baseline.result?.questions ?? [];
  const key = interviewDraft(baseline);
  const answers = useDrafts((s) => s.answers[key]) ?? draft.answers;
  const answered = baselineAnswers(questions, answers).length;
  const atLimit = round >= limit;
  const limitId = `baseline-limit-${baseline.id}`;

  const head = (
    <div className="iv-h">
      <StateGlyph name={baseline.state === 'running' ? 'running' : 'question'} />
      <h2 className="iv-t">
        {t({ id: 'projects.baseline.interview', defaultMessage: 'Baseline interview' })}
      </h2>
      <span className="iv-n">
        {t(
          { id: 'projects.baseline.round', defaultMessage: 'Round {round} of {limit}' },
          { round, limit },
        )}
      </span>
      <span
        className="iv-seg"
        role="img"
        aria-label={t(
          {
            id: 'projects.baseline.roundsBar',
            defaultMessage: 'Round {round} of {limit}, {answered} answered',
          },
          { round, limit, answered: rounds.length },
        )}
      >
        {Array.from({ length: Math.max(limit, round) }, (_, i) => (
          <i key={i} data-s={i < rounds.length ? 'ok' : i === rounds.length ? 'wait' : undefined} />
        ))}
      </span>
      {baseline.runtime && (
        <span className="hm-rt iv-rt">
          <RuntimeGlyph runtime={baseline.runtime} size={14} />
          {runtimeName(baseline.runtime)}
        </span>
      )}
      {onOpenSession && baseline.session_id && (
        <button
          type="button"
          className="btn ghost"
          onClick={() => onOpenSession(baseline.session_id!)}
        >
          {t({ id: 'projects.baseline.viewConversation', defaultMessage: 'View conversation' })}
        </button>
      )}
    </div>
  );
  const answeredRounds = rounds.length > 0 && (
    <div className="iv-rds">
      {rounds.map((r, i) => (
        <AnsweredRound key={i} n={i + 1} round={r} />
      ))}
    </div>
  );
  if (baseline.state === 'running')
    return (
      <section
        className="iv"
        aria-label={t({ id: 'projects.baseline.interview', defaultMessage: 'Baseline interview' })}
      >
        {head}
        {answeredRounds}
        <RunningBaseline baseline={baseline} />
      </section>
    );

  const askMore = questions.length > 0 && (
    <>
      <button
        type="button"
        className="btn"
        aria-disabled={atLimit || send.busy || undefined}
        aria-describedby={atLimit ? limitId : undefined}
        onClick={() => {
          if (!atLimit && !send.busy) void send.send(baselineContinueRequest(baseline, answers));
        }}
      >
        {t({ id: 'projects.baseline.askMore', defaultMessage: 'Ask me more' })}
      </button>
      {atLimit && (
        <span id={limitId} className="mu">
          {t(
            {
              id: 'projects.baseline.roundLimit',
              defaultMessage: 'Round limit reached, {round} of {limit}',
            },
            { round, limit },
          )}
        </span>
      )}
    </>
  );
  const noMoreId = `baseline-done-${baseline.id}`;
  const noMore = questions.length === 0 && baseline.state === 'submitted' && (
    <span id={noMoreId} className="mu">
      {t({ id: 'projects.baseline.noMoreQuestions', defaultMessage: 'No more questions' })}
    </span>
  );
  const confirm = (
    <Button
      label={t({ id: 'projects.baseline.confirmBaseline', defaultMessage: 'Confirm baseline' })}
      tone="pri"
      busy={send.busy}
      describedBy={noMore ? noMoreId : undefined}
      onPress={() =>
        void send.send(baselineConfirmRequest(baseline, { ...draft, answers }), onConfirmed)
      }
    />
  );
  const count = questions.length > 0 && (
    <span className="mu iv-cnt">
      {t(
        { id: 'projects.baseline.answered', defaultMessage: '{answered} of {total} answered' },
        { answered, total: questions.length },
      )}
    </span>
  );
  const interview = (
    <section
      className="iv"
      aria-label={t({ id: 'projects.baseline.interview', defaultMessage: 'Baseline interview' })}
    >
      {head}
      {answeredRounds}
      {questions.length > 0 && (
        <QuestionCard
          group
          draft={key}
          questions={questions}
          label={t({ id: 'projects.baseline.questions', defaultMessage: 'Open questions' })}
        />
      )}
      {dialog ? (
        count && <div className="iv-f">{count}</div>
      ) : (
        <div
          className="iv-f"
          role="group"
          aria-label={t({ id: 'projects.baseline.answerBar', defaultMessage: 'Answers' })}
        >
          {askMore}
          {confirm}
          {noMore}
          {count}
        </div>
      )}
      {!dialog && <Result send={send} />}
    </section>
  );
  const cellHead = (title: string, n: number) => (
    <div className="iv-ch">
      <span className="iv-ct">{title}</span>
      <span className="mu">{n}</span>
    </div>
  );
  const refs = (items: readonly string[]) =>
    items.length > 0 && (
      <span className="iv-ref">
        {items.map((ref) => (
          <span key={ref}>{sourceText(ref)}</span>
        ))}
      </span>
    );
  const results = (
    <section
      className="iv"
      aria-label={t({ id: 'projects.baseline.results', defaultMessage: 'Baseline results' })}
    >
      <div className="iv-h">
        <h2 className="iv-t">
          {t({ id: 'projects.baseline.results', defaultMessage: 'Baseline results' })}
        </h2>
      </div>
      {(workstreams.length > 0 || tasks.length > 0) && (
        <div className="iv-pnl">
          {workstreams.length > 0 && (
            <div
              className="iv-cell"
              role="group"
              aria-label={t({ id: 'projects.baseline.workstreams', defaultMessage: 'Workstreams' })}
            >
              {cellHead(
                t({ id: 'projects.baseline.workstreams', defaultMessage: 'Workstreams' }),
                workstreams.length,
              )}
              <WorkstreamBars rows={workstreams} />
              <WorkstreamDetails rows={baseline.result?.workstreams ?? []} />
            </div>
          )}
          {tasks.length > 0 && (
            <div
              className="iv-cell"
              role="group"
              aria-label={t({ id: 'projects.baseline.tasks.label', defaultMessage: 'Next tasks' })}
            >
              {cellHead(
                t({ id: 'projects.baseline.tasks.label', defaultMessage: 'Next tasks' }),
                tasks.length,
              )}
              <TaskGraph tasks={tasks} workstreams={baseline.result?.workstreams ?? []} />
            </div>
          )}
        </div>
      )}
      {(findings.length > 0 || contradictions.length > 0) && (
        <div className="iv-pnl">
          {findings.length > 0 && (
            <div
              className="iv-cell"
              role="group"
              aria-label={t({ id: 'projects.baseline.findings', defaultMessage: 'Findings' })}
            >
              {cellHead(
                t({ id: 'projects.baseline.findings', defaultMessage: 'Findings' }),
                findings.length,
              )}
              <ul className="iv-fd">
                {findings.map((finding, i) => (
                  <li key={i}>
                    <span className={finding.severity === 'risk' ? 'tr-st bad' : 'tr-st'}>
                      {finding.severity === 'risk'
                        ? t({ id: 'projects.baseline.finding.risk', defaultMessage: 'Risk' })
                        : t({ id: 'projects.baseline.finding.info', defaultMessage: 'Note' })}
                    </span>
                    <span>{finding.text}</span>
                    {refs(finding.refs)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {contradictions.length > 0 && (
            <div
              className="iv-cell"
              role="group"
              aria-label={t({
                id: 'projects.baseline.contradictions',
                defaultMessage: 'Docs the code contradicts',
              })}
            >
              {cellHead(
                t({
                  id: 'projects.baseline.contradictions',
                  defaultMessage: 'Docs the code contradicts',
                }),
                contradictions.length,
              )}
              <ul className="iv-fd" data-plain="">
                {contradictions.map((entry, i) => (
                  <li key={i}>
                    <span>{entry.text}</span>
                    {refs(entry.refs)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {body && (
        <div
          className="hm-card"
          role="group"
          aria-label={t({ id: 'projects.baseline.flow.label', defaultMessage: 'Main flow' })}
        >
          <Markdown text={body} />
        </div>
      )}
    </section>
  );
  const fields = (
    <>
      {interview}
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
      {results}
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
        {askMore}
        {confirm}
      </div>
    </>
  ) : (
    fields
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
