import type { ReactElement, ReactNode } from 'react';
import type { ApprovalQuestion } from '@pantheon/domain';
import { useDrafts, type Answers } from '../data/drafts';
import { t } from '../i18n';
import { StateGlyph } from './SessionStateIcon';
import { Tip } from './Tip';
import './question-card.css';

const KEYS = 'ABCDEFGHIJ';

export interface QuestionCardProps {
  /** Keys the unfinished answers in the drafts store. */
  draft: string;
  questions: readonly ApprovalQuestion[];
  /** The card's accessible name. */
  label: string;
  /** The row above the questions. */
  source?: ReactNode;
  /** Shown under the questions. */
  note?: ReactNode;
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
export function QuestionCard({
  draft,
  questions,
  label,
  source,
  note,
  reason,
  busy,
  error,
  onSend,
  onDeny,
  actions,
}: QuestionCardProps) {
  const blank: Answers = { picked: questions.map(() => []), typed: questions.map(() => '') };
  // Unfinished answers outlive the card.
  const { picked, typed } = useDrafts((s) => s.answers[draft]) ?? blank;
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
  const complete = questions.length > 0 && questions.every((_, i) => answer(i) !== '');
  const off = busy || reason !== null;

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
      {questions.map((q, i) => {
        const multi = q.multiSelect;
        const own = {
          value: typed[i] ?? '',
          onChange: (e: { target: { value: string } }) => write(i, e.target.value),
        };
        return (
          <div key={q.question} className="qc-ask">
            <p className="qc-q">
              <StateGlyph name="question" />
              <span>{q.question}</span>
            </p>
            {q.options.length > 0 ? (
              <div
                className="qc-opts"
                role={multi ? 'group' : 'radiogroup'}
                aria-label={q.question}
              >
                {q.options.map((o, k) => (
                  <button
                    key={o.label}
                    type="button"
                    className="qc-opt"
                    role={multi ? 'checkbox' : 'radio'}
                    aria-checked={picked[i]?.includes(o.label) ?? false}
                    onClick={() => pick(i, o.label, multi)}
                  >
                    <span className="qc-k" aria-hidden="true">
                      {KEYS[k]}
                    </span>
                    <span className="qc-l">{o.label}</span>
                    {q.recommended && o.label === q.recommended && (
                      <span className="chip qc-rec">
                        {t({
                          id: 'components.questionCard.recommended',
                          defaultMessage: 'Recommended',
                        })}
                      </span>
                    )}
                    {o.description && <span className="qc-d">{o.description}</span>}
                  </button>
                ))}
                {q.other !== false && (
                  <label className="qc-other">
                    <span className="qc-k" aria-hidden="true">
                      {KEYS[q.options.length]}
                    </span>
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
                )}
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
      })}
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
