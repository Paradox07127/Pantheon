import type { CSSProperties, ReactNode } from 'react';
import { Minus } from 'lucide-react';
import type { ChangeOutcome } from '../data/change-outcomes';
import { t } from '../i18n';
import { dayText } from '../lib/time-text';
import { tokenText } from '../screens/board/panels-model';
import { Clip } from './Clip';
import { LoadError } from './LoadError';
import { Skeleton } from './Skeleton';
import './change-outcome.css';

type Side = ChangeOutcome['before'];

const VERDICT: Record<ChangeOutcome['verdict'], () => string> = {
  better: () => t({ id: 'components.changeOutcome.better', defaultMessage: 'Better' }),
  worse: () => t({ id: 'components.changeOutcome.worse', defaultMessage: 'Worse' }),
  not_enough_evidence: () =>
    t({ id: 'components.changeOutcome.notEnough', defaultMessage: 'Not enough evidence' }),
};

export const changeOutcomeTitle = () =>
  t({ id: 'components.changeOutcome.title', defaultMessage: 'Did it help?' });

const percent = (part: number, whole: number) =>
  ({ '--v': `${whole ? Math.round((part / whole) * 100) : 0}%` }) as CSSProperties;

const ofText = (count: number, total: number) =>
  t({ id: 'components.changeOutcome.of', defaultMessage: '{count} of {total}' }, { count, total });

/** Two bars, before then after, named by the row and both values. */
const bars = (
  row: string,
  before: string,
  after: string,
  was: CSSProperties,
  is: CSSProperties,
) => (
  <div
    className="co-p"
    role="img"
    aria-label={t(
      {
        id: 'components.changeOutcome.pair',
        defaultMessage: '{row}: {before} before, {after} after',
      },
      { row, before, after },
    )}
  >
    <div className="meter co-was" style={was}>
      <i />
    </div>
    <div className="meter" style={is}>
      <i />
    </div>
  </div>
);

const row = (name: string, bar: ReactNode, before: ReactNode, after: ReactNode) => (
  <div key={name} className="co-r" role="row">
    <span role="rowheader">{name}</span>
    {bar || <span />}
    {before}
    {after}
  </div>
);

/** A side's count; muted when the side has no task. */
const count = (side: Side, value: ReactNode) => (
  <span className="co-n" data-none={side.tasks === 0 || undefined}>
    {value}
  </span>
);

const tokens = ({ cost_per_accepted_task: cost }: Side) =>
  cost.input_tokens === null ? (
    <span
      className="co-n"
      data-none
      role="img"
      aria-label={t({
        id: 'components.changeOutcome.noAccepted',
        defaultMessage: 'No accepted task',
      })}
    >
      <Minus aria-hidden="true" />
    </span>
  ) : (
    <span
      className="co-n"
      title={t(
        {
          id: 'components.changeOutcome.accepted',
          defaultMessage: '{count, plural, one {# accepted task} other {# accepted tasks}}',
        },
        { count: cost.n },
      )}
    >
      {tokenText(cost.input_tokens)}
    </span>
  );

/** What the tasks after one change did against as many before it; it only reports. */
export function ChangeOutcomeCard({
  outcome,
  title,
  label,
  wide,
  error,
  onRetry,
}: {
  /** Null while the read is out. */
  outcome: ChangeOutcome | null;
  title?: string;
  /** The block's accessible name; the title when not given. */
  label?: string;
  wide?: boolean;
  /** The read failed: its message and Retry stand in for the comparison. */
  error?: string;
  onRetry?: () => void;
}) {
  const heading = title ?? changeOutcomeTitle();
  const Root = wide ? 'section' : 'div';
  const rootProps = {
    className: 'co',
    'data-wide': wide || undefined,
    role: wide ? undefined : 'group',
    'aria-label': label ?? heading,
  };
  if (error)
    return (
      <Root {...rootProps}>
        <div className="co-h">
          <Clip className="co-t" text={heading} />
        </div>
        <LoadError
          message={t(
            {
              id: 'components.changeOutcome.failed',
              defaultMessage: 'Could not load the comparison: {reason}',
            },
            { reason: error },
          )}
          onRetry={onRetry}
        />
      </Root>
    );

  const names = {
    tasks: t({ id: 'components.changeOutcome.tasks', defaultMessage: 'Tasks' }),
    firstPass: t({
      id: 'components.changeOutcome.firstPass',
      defaultMessage: 'First gate run passed',
    }),
    tokens: t({
      id: 'components.changeOutcome.tokens',
      defaultMessage: 'Input tokens per accepted task',
    }),
    stopped: t({ id: 'components.changeOutcome.stopped', defaultMessage: 'Stopped by you' }),
  };
  const tokensName = wide
    ? names.tokens
    : t({ id: 'components.changeOutcome.tokensShort', defaultMessage: 'Tokens per accepted task' });

  let tasks: ReactNode;
  let rows: ReactNode[];
  if (!outcome) {
    tasks = <Skeleton style={{ height: 8, width: 96 }} />;
    const waiting = (width: number) => (
      <span className="co-n">
        <Skeleton style={{ height: 8, width }} />
      </span>
    );
    rows = [
      row(names.tasks, null, waiting(24), waiting(24)),
      row(names.firstPass, null, waiting(40), waiting(40)),
      row(tokensName, null, waiting(32), waiting(32)),
      row(names.stopped, null, waiting(16), waiting(16)),
    ];
  } else {
    const { before: b, after: a, n, tasks_required: required } = outcome;
    tasks =
      n >= required ? (
        <span className="co-n">
          {t(
            {
              id: 'components.changeOutcome.count',
              defaultMessage: '{count, plural, one {# task} other {# tasks}}',
            },
            { count: n },
          )}
        </span>
      ) : (
        <span className="co-c">
          <div
            className="meter co-m"
            role="img"
            aria-label={t(
              {
                id: 'components.changeOutcome.needed',
                defaultMessage: '{count} of the {required} tasks needed',
              },
              { count: n, required },
            )}
            style={percent(n, required)}
          >
            <i />
          </div>
          <span className="co-n">
            {t(
              {
                id: 'components.changeOutcome.countOf',
                defaultMessage: '{count} of {required} tasks',
              },
              { count: n, required },
            )}
          </span>
        </span>
      );
    // A window with no task has nothing to draw a bar of.
    const none = b.tasks === 0 && a.tasks === 0;
    const [wasTokens, isTokens] = [
      b.cost_per_accepted_task.input_tokens,
      a.cost_per_accepted_task.input_tokens,
    ];
    const most = Math.max(wasTokens ?? 0, isTokens ?? 0);
    rows = [
      row(names.tasks, null, count(b, b.tasks), count(a, a.tasks)),
      row(
        names.firstPass,
        !none &&
          bars(
            names.firstPass,
            ofText(b.first_pass, b.tasks),
            ofText(a.first_pass, a.tasks),
            percent(b.first_pass, b.tasks),
            percent(a.first_pass, a.tasks),
          ),
        count(b, b.tasks ? ofText(b.first_pass, b.tasks) : 0),
        count(a, a.tasks ? ofText(a.first_pass, a.tasks) : 0),
      ),
      row(
        tokensName,
        wasTokens !== null &&
          isTokens !== null &&
          bars(
            names.tokens,
            tokenText(wasTokens),
            tokenText(isTokens),
            percent(wasTokens, most),
            percent(isTokens, most),
          ),
        tokens(b),
        tokens(a),
      ),
      row(
        names.stopped,
        !none &&
          bars(
            names.stopped,
            ofText(b.user_interventions, b.tasks),
            ofText(a.user_interventions, a.tasks),
            percent(b.user_interventions, b.tasks),
            percent(a.user_interventions, a.tasks),
          ),
        count(b, b.user_interventions),
        count(a, a.user_interventions),
      ),
    ];
  }
  const date =
    outcome &&
    (title
      ? dayText(outcome.at, Date.now())
      : t(
          { id: 'components.changeOutcome.since', defaultMessage: 'since {date}' },
          { date: dayText(outcome.at, Date.now()) },
        ));

  return (
    <Root {...rootProps} aria-busy={!outcome || undefined}>
      <div className="co-h">
        <Clip className="co-t" text={heading} />
        {wide && tasks}
        {date && <span className="co-d">{date}</span>}
        {outcome ? (
          <span className="chip co-v" data-v={outcome.verdict}>
            {VERDICT[outcome.verdict]()}
          </span>
        ) : (
          <span className="co-e">
            <Skeleton style={{ height: 8, width: 72 }} />
          </span>
        )}
      </div>
      {!wide && <div className="co-l">{tasks}</div>}
      <div
        role="table"
        aria-label={t({
          id: 'components.changeOutcome.table',
          defaultMessage: 'Before and after the change',
        })}
      >
        <div className="co-r" role="row">
          <span />
          <span />
          <span className="cap co-ch" role="columnheader">
            <i className="co-dot" />
            {t({ id: 'components.changeOutcome.before', defaultMessage: 'Before' })}
          </span>
          <span className="cap co-ch" role="columnheader">
            <i className="co-dot" data-after />
            {t({ id: 'components.changeOutcome.after', defaultMessage: 'After' })}
          </span>
        </div>
        {rows}
      </div>
    </Root>
  );
}
