import { useState, type CSSProperties, type FormEvent } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  BookOpen,
  Check,
  Crown,
  FlaskConical,
  MessageSquare,
  Minus,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { CommandType } from '@pantheon/protocol';
import type { RuntimeFinding, RuntimeReviewHistory } from '@pantheon/domain';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { runCommand } from '../../data/commands';
import { useMemoryView } from '../../data/memory-view';
import { reasonText } from '../../data/needs-you';
import { currentLocale, t } from '../../i18n';
import { useShell } from '../../store';
import { whenText } from '../board/panels-model';
import { FINDING_ICONS, runtimeDuration, runtimeFindingTitle } from './FindingDetail';
import './review-records.css';

type Outcome = NonNullable<RuntimeReviewHistory['verification']>['outcome'];
const OUTCOMES: readonly Outcome[] = ['improved', 'unchanged', 'regressed'];

const OUTCOME_ICONS: Record<Outcome, LucideIcon> = {
  improved: Check,
  unchanged: Minus,
  regressed: X,
};

const outcomeText = (outcome: Outcome) =>
  t(
    {
      id: 'trace.reviews.outcome',
      defaultMessage:
        '{outcome, select, improved {Improved} unchanged {Unchanged} regressed {Regressed} other {Recorded}}',
    },
    { outcome },
  );

const numberText = (value: number) => new Intl.NumberFormat(currentLocale()).format(value);

/** The window's start, then its end without the day when it ends on the day it starts. */
function windowText(from: number, to: number, now: number): string {
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  return t(
    { id: 'trace.reviews.window', defaultMessage: '{from} to {to}' },
    { from: whenText(from, now), to: whenText(to, sameDay ? to : now) },
  );
}

/** Opens the memory entries with the draft selected, where it waits for confirmation. */
function openMemory(memoryId: string) {
  const shell = useShell.getState();
  shell.setMemoryTab('entries');
  useMemoryView.getState().select(memoryId);
  shell.setScreen('memory');
}

/** Runs one command. Resolves to why it failed, or to what it returned once it went through. */
async function send(
  type: CommandType,
  input: Record<string, unknown>,
): Promise<{ failure: string } | { value: unknown }> {
  const result = await runCommand(type, input, null);
  return result.ok ? { value: result.value } : { failure: reasonText(result.error.code) };
}

export interface ReviewRecordsProps {
  reviews: RuntimeReviewHistory[];
  /** The findings of the shown window; a cited finding outside it is left out. */
  findings: RuntimeFinding[];
  leads: { id: string; title: string }[];
  /** The lead picked for new analyses, used when a record has no lead of its own. */
  leadId?: string;
  stale: boolean;
  titleOf: (lane: string) => string;
  onFinding: (finding: RuntimeFinding) => void;
}

export function ReviewRecords({ reviews, ...rest }: ReviewRecordsProps) {
  if (!reviews.length) return null;
  return (
    <section
      className="rvr"
      aria-label={t({ id: 'trace.reviews.label', defaultMessage: 'Analysis records' })}
    >
      {reviews.map((review, index) => (
        <ReviewCard key={review.session_id} review={review} index={index} {...rest} />
      ))}
    </section>
  );
}

function ReviewCard({
  review,
  index,
  findings,
  leads,
  leadId,
  stale,
  titleOf,
  onFinding,
}: Omit<ReviewRecordsProps, 'reviews'> & { review: RuntimeReviewHistory; index: number }) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const now = Date.now();
  const { report, verification } = review;
  const phase = verification?.outcome ?? review.state;
  const lead =
    review.lead_session_id ??
    (leadId && leads.some((row) => row.id === leadId)
      ? leadId
      : leads.length === 1
        ? leads[0]!.id
        : undefined);
  const cited = (report?.finding_ids ?? []).flatMap((id) =>
    findings.filter((finding) => finding.id === id),
  );
  const plan = report
    ? [
        [t({ id: 'trace.reviews.change', defaultMessage: 'Change' }), report.change],
        [
          t({ id: 'trace.reviews.baseline', defaultMessage: 'Baseline to compare' }),
          report.baseline,
        ],
        [t({ id: 'trace.reviews.metric', defaultMessage: 'Metric to watch' }), report.metric],
        [
          t({ id: 'trace.reviews.rollback', defaultMessage: 'Rollback condition' }),
          report.rollback,
        ],
      ].filter(([, value]) => value)
    : [];
  const run = async (type: CommandType, input: Record<string, unknown>) => {
    setBusy(true);
    const sent = await send(type, input);
    setBusy(false);
    setFailure('failure' in sent ? sent.failure : null);
    return sent;
  };
  const OutcomeIcon = verification && OUTCOME_ICONS[verification.outcome];

  return (
    <article className="rvr-card" style={{ '--rvr-k': Math.min(index, 6) } as CSSProperties}>
      <div className="rvr-head">
        <span className="chip rvr-phase" data-phase={phase}>
          {t(
            {
              id: 'trace.reviews.phase',
              defaultMessage:
                '{phase, select, running {Analyzing} waiting {Waiting for you} ready {Conclusion ready} failed {No conclusion} improved {Verified effective} unchanged {Verified, no change} regressed {Verified, regressed} other {Unknown}}',
            },
            { phase },
          )}
        </span>
        <span className="rvr-rt">
          <RuntimeGlyph runtime={review.runtime} />
          {runtimeName(review.runtime)}
        </span>
        <span className="rvr-win">{windowText(review.from, review.to, now)}</span>
        <span className="rvr-at">{whenText(review.created_at, now)}</span>
      </div>
      {report && <p className="rvr-summary">{report.summary}</p>}
      {cited.length > 0 && (
        <div className="rvr-cited">
          {cited.map((finding) => {
            const Icon = FINDING_ICONS[finding.kind];
            return (
              <button
                key={finding.id}
                type="button"
                className="rvr-rf"
                disabled={!finding.lane_key}
                onClick={() => onFinding(finding)}
              >
                <Icon aria-hidden="true" />
                <b>{runtimeFindingTitle(finding)}</b>
                <span>{finding.lane_key ? titleOf(finding.lane_key) : ''}</span>
                <span>
                  {finding.duration_ms === undefined ? '' : runtimeDuration(finding.duration_ms)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {plan.length > 0 && (
        <dl className="rvr-xp">
          {plan.map(([label, value]) => (
            <div key={label}>
              <dt className="cap">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {verification && OutcomeIcon && (
        <div className="rvr-result">
          <OutcomeIcon aria-hidden="true" data-outcome={verification.outcome} />
          <span>{outcomeText(verification.outcome)}</span>
          <span className="cap">
            {t({ id: 'trace.reviews.baselineValue', defaultMessage: 'Baseline' })}
          </span>
          <span className="rvr-num">{numberText(verification.baseline)}</span>
          <span className="cap">
            {t({ id: 'trace.reviews.trialValue', defaultMessage: 'Trial' })}
          </span>
          <span className="rvr-num">{numberText(verification.trial)}</span>
          <span className="rvr-ev">{verification.evidence}</span>
        </div>
      )}
      <div className="rvr-acts">
        <button
          type="button"
          className="btn"
          onClick={() => useShell.getState().openSession(review.session_id)}
        >
          <MessageSquare aria-hidden="true" />
          {t({ id: 'trace.reviews.open', defaultMessage: 'Open analysis session' })}
        </button>
        {report &&
          (review.shared_at ? (
            <button type="button" className="btn" disabled>
              <Check aria-hidden="true" />
              {t({ id: 'trace.reviews.shared', defaultMessage: 'Sent to Lead' })}
            </button>
          ) : (
            lead && (
              <button
                type="button"
                className="btn"
                disabled={stale || busy}
                onClick={() =>
                  void run('trace.share', { session_id: review.session_id, lead_session_id: lead })
                }
              >
                <Crown aria-hidden="true" />
                {t({ id: 'trace.reviews.share', defaultMessage: 'Send conclusion to Lead' })}
              </button>
            )
          ))}
        {report?.disposition === 'experiment' && !review.memory_id && (
          <button
            type="button"
            className="btn ghost"
            aria-expanded={recording}
            disabled={stale}
            onClick={() => setRecording(!recording)}
          >
            <FlaskConical aria-hidden="true" />
            {t({ id: 'trace.reviews.record', defaultMessage: 'Record experiment result' })}
          </button>
        )}
        {verification?.outcome === 'improved' && !review.memory_id && (
          <button
            type="button"
            className="btn"
            disabled={stale || busy}
            onClick={() =>
              void run('trace.remember', { session_id: review.session_id }).then(
                (sent) =>
                  'value' in sent && openMemory((sent.value as { memory_id: string }).memory_id),
              )
            }
          >
            <BookOpen aria-hidden="true" />
            {t({ id: 'trace.reviews.remember', defaultMessage: 'Put in memory' })}
          </button>
        )}
        {review.memory_id && (
          <span className="rvr-nb">
            <BookOpen aria-hidden="true" />
            <span>
              {t({
                id: 'trace.reviews.remembered',
                defaultMessage: 'In memory, waiting for confirmation',
              })}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => openMemory(review.memory_id!)}
            >
              {t({ id: 'trace.reviews.confirm', defaultMessage: 'Review' })}
            </button>
          </span>
        )}
      </div>
      {failure && (
        <span className="tr-err" role="alert">
          {failure}
        </span>
      )}
      {recording && (
        <ExperimentForm
          sessionId={review.session_id}
          stale={stale}
          onSaved={() => setRecording(false)}
        />
      )}
    </article>
  );
}

function ExperimentForm({
  sessionId,
  stale,
  onSaved,
}: {
  sessionId: string;
  stale: boolean;
  onSaved: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>('improved');
  const [baseline, setBaseline] = useState('');
  const [trial, setTrial] = useState('');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const measured = [baseline, trial].map((value) => (value.trim() ? Number(value) : NaN));
  const ready = measured.every(Number.isFinite) && !!evidence.trim();
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving || stale) return;
    setSaving(true);
    const sent = await send('trace.verify', {
      session_id: sessionId,
      outcome,
      baseline: measured[0],
      trial: measured[1],
      evidence: evidence.trim(),
    });
    setSaving(false);
    setFailure('failure' in sent ? sent.failure : null);
    if (!('failure' in sent)) onSaved();
  };
  const resultLabel = t({ id: 'trace.reviews.result', defaultMessage: 'Result' });

  return (
    <form
      className="rvr-form"
      aria-label={t({ id: 'trace.reviews.record', defaultMessage: 'Record experiment result' })}
      onSubmit={(event) => void save(event)}
    >
      <div>
        <span className="cap">{resultLabel}</span>
        <RadioGroup<Outcome>
          className="tb-seg"
          aria-label={resultLabel}
          value={outcome}
          onValueChange={(value) => setOutcome(value)}
        >
          {OUTCOMES.map((value) => (
            <Radio.Root key={value} value={value}>
              {outcomeText(value)}
            </Radio.Root>
          ))}
        </RadioGroup>
        <span className="cap">
          {t({ id: 'trace.reviews.baselineValue', defaultMessage: 'Baseline' })}
        </span>
        <input
          className="inp rvr-val"
          inputMode="decimal"
          value={baseline}
          onChange={(event) => setBaseline(event.currentTarget.value)}
          aria-label={t({ id: 'trace.reviews.baselineInput', defaultMessage: 'Baseline value' })}
        />
        <span className="cap">
          {t({ id: 'trace.reviews.trialValue', defaultMessage: 'Trial' })}
        </span>
        <input
          className="inp rvr-val"
          inputMode="decimal"
          value={trial}
          onChange={(event) => setTrial(event.currentTarget.value)}
          aria-label={t({ id: 'trace.reviews.trialInput', defaultMessage: 'Trial value' })}
        />
      </div>
      <div>
        <span className="cap">
          {t({ id: 'trace.reviews.evidence', defaultMessage: 'Evidence' })}
        </span>
        <input
          className="inp rvr-evin"
          maxLength={512}
          value={evidence}
          placeholder={t({
            id: 'trace.reviews.evidenceHint',
            defaultMessage: 'Session, turn or event id',
          })}
          onChange={(event) => setEvidence(event.currentTarget.value)}
          aria-label={t({ id: 'trace.reviews.evidence', defaultMessage: 'Evidence' })}
        />
        <button type="submit" className="btn" disabled={!ready || saving || stale}>
          {t({ id: 'trace.reviews.save', defaultMessage: 'Save' })}
        </button>
      </div>
      {failure && (
        <span className="tr-err" role="alert">
          {failure}
        </span>
      )}
    </form>
  );
}
