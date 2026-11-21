import { useState, type CSSProperties } from 'react';
import { Clock } from 'lucide-react';
import type { LeadQuestion } from '@pantheon/domain';
import { blocksText } from '../data/attention';
import { ageText } from '../data/needs-you';
import { t } from '../i18n';
import type { NeedItem } from '../data/need-actions';
import { durationText } from '../lib/time-text';
import { type RunBoardCommand } from '../lib/snapshot-types';
import { Clip } from './Clip';
import { Tip } from './Tip';
import './request-card.css';

export interface QuestionBatchProps {
  /** The lead's open questions of one plan, two or more, each with its question. */
  items: readonly NeedItem[];
  /** The lead. */
  who: string;
  now: number;
  run: RunBoardCommand;
  /** The data is old: commands wait for a refresh. */
  stale?: boolean;
  selected?: boolean;
  /** The longest wait of the list, the full length of the row's wait bar. */
  waitScale?: number;
  /** Called once the answers were taken, so the list can move on to its next item. */
  onActed?: () => void;
  /** Gets the row's Answer all button, which a list moves the focus to. */
  primaryRef?: (el: HTMLButtonElement | null) => void;
}

/** The open questions of one plan as one row, each with its recommended answer picked, answered together. */
export function QuestionBatch({
  items,
  who,
  now,
  run,
  stale,
  selected,
  waitScale,
  onActed,
  primaryRef,
}: QuestionBatchProps) {
  const first = items[0]!;
  const questions = items.map((item) => item.question!);
  // By question id: the option picked in place of the recommended one, and typed words that replace either.
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = (q: LeadQuestion) => picked[q.id] ?? q.recommended;
  const answer = (q: LeadQuestion) => typed[q.id]?.trim() || choice(q);
  const complete = questions.every((q) => answer(q) !== '');
  const plan = first.plan_title ?? who;
  const title = t(
    {
      id: 'components.questionBatch.title',
      defaultMessage: '{count, plural, one {# decision} other {# decisions}} for {plan}',
    },
    { count: items.length, plan },
  );
  const staleText = t({
    id: 'components.requestCard.stale',
    defaultMessage: 'Data is out of date; refresh before acting',
  });

  const send = async () => {
    if (busy || stale || !complete) return;
    setBusy(true);
    setError(null);
    const failure = await run(
      'lead.questions.answer_batch',
      {
        project_id: first.project_id,
        lead_session_id: first.session_id,
        answers: questions.map((q) => ({ question_id: q.id, answer: answer(q) })),
      },
      null,
    );
    // Taken answers keep the button off until the row leaves.
    if (!failure) return onActed?.();
    setBusy(false);
    setError(
      t(
        {
          id: 'components.questionBatch.failed',
          defaultMessage: "Couldn't send {count} answers: {error}. Your choices are kept.",
        },
        { count: questions.length, error: failure },
      ),
    );
  };
  const keepOpen = async (q: LeadQuestion) => {
    if (busy || stale) return;
    setBusy(true);
    setError(null);
    const failure = await run(
      'lead.question.keep_open',
      { project_id: first.project_id, lead_session_id: first.session_id, question_id: q.id },
      null,
    );
    setBusy(false);
    setError(failure);
  };

  const oldest = Math.min(...items.map((item) => item.created_at));
  const waited = Math.max(0, now - oldest);
  const blocks = blocksText(new Set(questions.flatMap((q) => q.blocks)).size);
  const label = t({ id: 'components.questionBatch.answerAll', defaultMessage: 'Answer all' });
  const off = busy || stale || !complete;
  const answerAll = (
    <button
      ref={primaryRef}
      type="button"
      className={selected ? 'btn pri' : 'btn'}
      aria-disabled={off || undefined}
      aria-busy={busy || undefined}
      onClick={() => void send()}
    >
      {label}
    </button>
  );
  const keepLabel = t({ id: 'components.requestCard.keepOpen', defaultMessage: 'Keep open' });
  return (
    <article className="rq" aria-label={title} data-on={selected || undefined}>
      <div className="rq-hd">
        <span className="ss-dot waiting" aria-hidden="true" />
        <div className="rq-main">
          <div className="rq-l1">
            <span className="rq-kind">
              <Clip
                text={t({ id: 'components.questionBatch.kind', defaultMessage: 'Decisions' })}
              />
            </span>
            <span className="rq-what">
              <Clip text={title} />
              <b className="rq-who">
                <Clip text={who} />
              </b>
            </span>
          </div>
          {blocks && (
            <div className="rq-l2">
              <span className="rq-blk">{blocks}</span>
            </div>
          )}
        </div>
        <span className="rq-wt">
          <span
            className="meter"
            role="img"
            aria-label={t(
              {
                id: 'board.needs.waitBar',
                defaultMessage: 'Waited {duration}, scale 0 to {longest}',
              },
              {
                duration: durationText(waited),
                longest: durationText(Math.max(waited, waitScale ?? 0)),
              },
            )}
            style={
              {
                '--v': `${waitScale ? Math.min(100, (waited / waitScale) * 100) : 100}%`,
                '--c': 'var(--wait)',
              } as CSSProperties
            }
          >
            <i />
          </span>
          <span className="rq-age">{ageText(oldest, now)}</span>
        </span>
        <span className="rq-acts">
          {stale ? <Tip content={staleText}>{answerAll}</Tip> : answerAll}
        </span>
      </div>
      <div className="rq-sub">
        <ul className="rqb">
          {items.map((item, i) => {
            const q = questions[i]!;
            const options = q.options.includes(q.recommended)
              ? [q.recommended, ...q.options.filter((option) => option !== q.recommended)]
              : q.options;
            const own = typed[q.id] ?? '';
            return (
              <li key={q.id} className="rqb-q">
                <span className="rqb-t">
                  <Clip text={q.question} lines={3} />
                </span>
                <span className="rqb-n">{blocksText(q.blocks.length)}</span>
                <div className="rqb-opts" role="radiogroup" aria-label={q.question}>
                  {options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="btn sm"
                      role="radio"
                      aria-checked={!own.trim() && choice(q) === option}
                      onClick={() => {
                        setPicked({ ...picked, [q.id]: option });
                        setTyped({ ...typed, [q.id]: '' });
                      }}
                    >
                      {option}
                      {option === q.recommended && (
                        <span className="rqb-rec">
                          {t({
                            id: 'components.questionCard.recommended',
                            defaultMessage: 'Recommended',
                          })}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <input
                  className="rqb-in"
                  type="text"
                  spellCheck
                  placeholder={t({ id: 'components.questionCard.other', defaultMessage: 'Other' })}
                  aria-label={t({
                    id: 'components.questionCard.otherAnswer',
                    defaultMessage: 'Other answer',
                  })}
                  value={own}
                  onChange={(e) => setTyped({ ...typed, [q.id]: e.target.value })}
                />
                {item.default_at !== undefined && (
                  <span className="rq-dl">
                    <Clock className="ic-sm" aria-hidden="true" />
                    <span>
                      {t(
                        {
                          id: 'components.requestCard.defaultAt',
                          defaultMessage: 'Recommended answer takes effect in {duration}',
                        },
                        { duration: durationText(Math.max(0, item.default_at - now)) },
                      )}
                    </span>
                    <button
                      type="button"
                      className="btn sm"
                      aria-disabled={busy || stale || undefined}
                      onClick={() => void keepOpen(q)}
                    >
                      {keepLabel}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {error && (
          <span className="tr-err rq-err" role="alert">
            {error}
          </span>
        )}
      </div>
    </article>
  );
}
