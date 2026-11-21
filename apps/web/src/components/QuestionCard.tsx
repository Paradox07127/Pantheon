import { useId, type ReactElement, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { ApprovalQuestion } from '@pantheon/domain';
import { useDrafts, type Answers } from '../data/drafts';
import { t } from '../i18n';
import { Clip } from './Clip';
import { StateGlyph } from './SessionStateIcon';
import { Tip } from './Tip';
import './question-card.css';

const KEYS = 'ABCDEFGHIJ';

interface CommonProps {
  /** Keys the unfinished answers in the drafts store. */
  draft: string;
  questions: readonly ApprovalQuestion[];
  /** The card's accessible name. */
  label: string;
  /** The row above the questions. */
  source?: ReactNode;
  /** Shown under the questions. */
  note?: ReactNode;
}

export interface QuestionCardProps extends CommonProps {
  /** Why the card takes no answer now; null while it does. */
  reason: string | null;
  busy: boolean;
  error: string | null;
  /** Question text to its answer. */
  onSend: (answers: Record<string, string>) => void;
  /** Absent where the question cannot be refused. */
  onDeny?: () => void;
  /** Buttons after Send and Deny. */
  actions?: ReactNode;
}

/** A runtime's or a lead's questions: options under letter keys, a free answer, then Send. */
export function QuestionCard(props: QuestionCardProps) {
  const { draft, questions, label, source, note } = props;
  const blank: Answers = { picked: questions.map(() => []), typed: questions.map(() => '') };
  // Unfinished answers outlive the card.
  const { picked, typed } = useDrafts((s) => s.answers[draft]) ?? blank;
  // An option's description sits beside its button, so its "Show more" is no button in a button.
  const about = useId();
  const change = (next: (now: Answers) => Partial<Answers>) => {
    const now = useDrafts.getState().answers[draft] ?? blank;
    useDrafts.getState().answer(draft, { ...now, ...next(now) });
  };
  const answer = (i: number): string => {
    const own = typed[i]?.trim();
    if (own) return own;
    const chosen = picked[i] ?? [];
    return questions[i]!.options.map((o) => o.label)
      .filter((label) => chosen.includes(label))
      .join(', ');
  };
  // A typed answer and picked options exclude each other, so what is shown is what is sent.
  const pick = (i: number, label: string, multi: boolean) =>
    change((now) => ({
      typed: now.typed.map((text, j) => (j === i ? '' : text)),
      picked: now.picked.map((chosen, j) =>
        j !== i
          ? chosen
          : chosen.includes(label)
            ? chosen.filter((l) => l !== label)
            : multi
              ? [...chosen, label]
              : [label],
      ),
    }));
  const write = (i: number, value: string) =>
    change((now) => ({
      typed: now.typed.map((text, j) => (j === i ? value : text)),
      ...(value.trim() ? { picked: now.picked.map((chosen, j) => (j === i ? [] : chosen)) } : {}),
    }));

  const recommended = (q: ApprovalQuestion, option: string, className: string) =>
    q.recommended &&
    option === q.recommended && (
      <span className={className}>
        {t({
          id: 'components.questionCard.recommended',
          defaultMessage: 'Recommended',
        })}
      </span>
    );

  const ask = (q: ApprovalQuestion, i: number) => {
    const multi = q.multiSelect;
    // A multiple choice key is a box that shows a tick once picked; a single choice key is round.
    const key = (k: number, on = false) => (
      <span className="qc-k" data-multi={multi || undefined} aria-hidden="true">
        {multi && on ? <Check /> : KEYS[k]}
      </span>
    );
    const own = {
      value: typed[i] ?? '',
      onChange: (e: { target: { value: string } }) => write(i, e.target.value),
    };
    const other = q.other !== false && (
      <label className="qc-other">
        {key(q.options.length)}
        <input
          className="qc-in"
          type={q.secret ? 'password' : 'text'}
          autoComplete={q.secret ? 'off' : undefined}
          spellCheck={!q.secret}
          placeholder={t({
            id: 'components.questionCard.other',
            defaultMessage: 'Other',
          })}
          aria-label={t({
            id: 'components.questionCard.otherAnswer',
            defaultMessage: 'Other answer',
          })}
          {...own}
        />
      </label>
    );
    const role = multi ? 'checkbox' : 'radio';
    return (
      <div key={q.question} className="qc-ask" data-open={answer(i) === '' || undefined}>
        <p className="qc-q">
          <StateGlyph name="question" />
          <span>
            <Clip text={q.question} lines={6} />
          </span>
        </p>
        {q.options.length > 0 ? (
          <div className="qc-opts" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
            {q.options.map((o, k) => (
              <div key={o.label} className="qc-o">
                <button
                  type="button"
                  className="qc-opt"
                  role={role}
                  aria-checked={picked[i]?.includes(o.label) ?? false}
                  aria-describedby={o.description ? `${about}-${i}-${k}` : undefined}
                  onClick={() => pick(i, o.label, multi)}
                >
                  {key(k, picked[i]?.includes(o.label))}
                  <span className="qc-l">{o.label}</span>
                  {recommended(q, o.label, 'chip qc-rec')}
                </button>
                {o.description && (
                  <div className="qc-d">
                    <Clip id={`${about}-${i}-${k}`} text={o.description} lines={6} />
                  </div>
                )}
              </div>
            ))}
            {other}
          </div>
        ) : q.secret ? (
          <input
            className="qc-sec"
            type="password"
            autoComplete="off"
            aria-label={t({
              id: 'components.questionCard.answer',
              defaultMessage: 'Your answer',
            })}
            {...own}
          />
        ) : (
          <textarea
            className="qc-ta"
            rows={2}
            spellCheck
            aria-label={t({
              id: 'components.questionCard.answer',
              defaultMessage: 'Your answer',
            })}
            {...own}
          />
        )}
      </div>
    );
  };

  const { reason, busy, error, onSend, onDeny, actions } = props;
  const complete = questions.length > 0 && questions.every((_, i) => answer(i) !== '');
  const off = busy || reason !== null;
  const tip = (el: ReactElement) => (reason ? <Tip content={reason}>{el}</Tip> : el);
  const send = (
    <button
      type="button"
      className="btn pri"
      aria-disabled={off || !complete || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (off || !complete) return;
        onSend(Object.fromEntries(questions.map((q, i) => [q.question, answer(i)])));
      }}
    >
      {t({ id: 'components.questionCard.send', defaultMessage: 'Send' })}
    </button>
  );
  const deny = onDeny && (
    <button
      type="button"
      className="btn ghost"
      aria-disabled={off || undefined}
      onClick={() => {
        if (!off) onDeny();
      }}
    >
      {t({ id: 'components.questionCard.deny', defaultMessage: 'Deny' })}
    </button>
  );

  return (
    <section className="qc" role="group" aria-label={label}>
      {source}
      {questions.map(ask)}
      {note}
      <div className="qc-f">
        {tip(send)}
        {deny && tip(deny)}
        {actions}
      </div>
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
