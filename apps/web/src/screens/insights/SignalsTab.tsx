import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { LoadError } from '../../components/LoadError';
import { toast } from '../../components/Toast';
import { agentName, SOURCE_ICONS, useAgents } from '../../data/agents';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { useSignalIssues, type ListedSignal } from '../../data/signals';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { clockText, dayText } from '../../lib/time-text';
import './signals.css';

type IssueFilter = 'open' | 'muted' | 'resolved';
type State = ListedSignal['state'];

const FILTERS: readonly IssueFilter[] = ['open', 'muted', 'resolved'];

const filterOf = (issue: ListedSignal): IssueFilter =>
  issue.state === 'muted' || issue.state === 'resolved' ? issue.state : 'open';

function filterName(filter: IssueFilter): string {
  switch (filter) {
    case 'open':
      return t({ id: 'insights.signals.filter.open', defaultMessage: 'Open' });
    case 'muted':
      return t({ id: 'insights.signals.filter.muted', defaultMessage: 'Muted' });
    default:
      return t({ id: 'insights.signals.filter.resolved', defaultMessage: 'Resolved' });
  }
}

function listName(filter: IssueFilter): string {
  switch (filter) {
    case 'open':
      return t({ id: 'insights.signals.list.open', defaultMessage: 'Open signals' });
    case 'muted':
      return t({ id: 'insights.signals.list.muted', defaultMessage: 'Muted signals' });
    default:
      return t({ id: 'insights.signals.list.resolved', defaultMessage: 'Resolved signals' });
  }
}

function emptyText(filter: IssueFilter): string {
  switch (filter) {
    case 'open':
      return t({ id: 'insights.signals.empty.open', defaultMessage: 'No open signals.' });
    case 'muted':
      return t({ id: 'insights.signals.empty.muted', defaultMessage: 'No muted signals.' });
    default:
      return t({ id: 'insights.signals.empty.resolved', defaultMessage: 'No resolved signals.' });
  }
}

function stateName(state: State): string {
  switch (state) {
    case 'new':
      return t({ id: 'insights.signals.state.new', defaultMessage: 'New' });
    case 'ongoing':
      return t({ id: 'insights.signals.state.ongoing', defaultMessage: 'Ongoing' });
    case 'escalating':
      return t({ id: 'insights.signals.state.escalating', defaultMessage: 'Escalating' });
    case 'regressed':
      return t({ id: 'insights.signals.state.regressed', defaultMessage: 'Regressed' });
    case 'holding':
      return t({ id: 'insights.signals.state.holding', defaultMessage: 'Holding' });
    case 'resolved':
      return t({ id: 'insights.signals.state.resolved', defaultMessage: 'Resolved' });
    default:
      return t({ id: 'insights.signals.state.muted', defaultMessage: 'Muted' });
  }
}

function priorityName(priority: ListedSignal['priority']): string {
  switch (priority) {
    case 'interrupt':
      return t({ id: 'insights.signals.priority.interrupt', defaultMessage: 'Interrupt' });
    case 'digest':
      return t({ id: 'insights.signals.priority.digest', defaultMessage: 'Digest' });
    default:
      return t({ id: 'insights.signals.priority.record', defaultMessage: 'Record' });
  }
}

function sourceName(source: ListedSignal['source']): string {
  switch (source) {
    case 'gate_failures':
      return t({ id: 'insights.signals.source.gate', defaultMessage: 'Gate' });
    case 'flaky_tests':
      return t({ id: 'insights.signals.source.flaky', defaultMessage: 'Flaky test' });
    case 'app_errors':
      return t({ id: 'insights.signals.source.app', defaultMessage: 'App error' });
    case 'session_failures':
      return t({ id: 'insights.signals.source.session', defaultMessage: 'Session failure' });
    default:
      return t({ id: 'insights.signals.source.trace', defaultMessage: 'Trace finding' });
  }
}

/** The status colour of the state's glyph; a muted issue draws none. */
function tone(issue: ListedSignal): string | undefined {
  switch (issue.state) {
    case 'new':
      return issue.priority === 'interrupt' ? 'bad' : 'idle';
    case 'regressed':
      return 'bad';
    case 'escalating':
      return 'wait';
    case 'holding':
      return 'hold';
    case 'resolved':
      return 'ok';
    case 'muted':
      return undefined;
    default:
      return 'idle';
  }
}

/** The time of day for today, else the day. */
const shortWhen = (at: number, now: number) =>
  new Date(at).toDateString() === new Date(now).toDateString() ? clockText(at) : dayText(at, now);

/** The issues of every state on the engineering board: open, muted under their cause, resolved. */
export function SignalsTab({ projectId }: { projectId: string }) {
  const issues = useSignalIssues(projectId);
  const agents = useAgents(projectId);
  const [filter, setFilter] = useState<IssueFilter>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const all = issues.read ?? [];
  const nameOf = (agentId: string) => {
    const agent = agents?.find((each) => each.id === agentId);
    return agent ? agentName(agent) : null;
  };
  const sentTo = (issue: ListedSignal) => {
    const last = issue.routed.at(-1);
    return last ? { name: nameOf(last.agent_id), at: last.at } : null;
  };
  const mutedBy = (issue: ListedSignal) =>
    all.filter((each) => each.state === 'muted' && each.muted_by === issue.id);
  const count = (each: IssueFilter) => all.filter((issue) => filterOf(issue) === each).length;
  // Open issues nest the ones they mute; the muted list shows every muted issue.
  const shown = all.filter((issue) => filterOf(issue) === filter);
  const current = all.find((issue) => issue.id === selected) ?? null;

  const act = async (command: 'signal.mute' | 'signal.resolve', id: string) => {
    if (busy) return;
    setBusy(true);
    const result = await runCommand(command, { id }, null);
    setBusy(false);
    if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
  };

  const row = (issue: ListedSignal) => {
    const Icon = SOURCE_ICONS[issue.source];
    const sent = sentTo(issue);
    const state = stateName(issue.state);
    const when = shortWhen(issue.last_seen, now);
    return (
      <button
        key={issue.id}
        type="button"
        role="option"
        className="sg-row"
        aria-selected={issue.id === selected}
        aria-label={listText(
          issue.title,
          state,
          sourceName(issue.source),
          t(
            {
              id: 'insights.signals.count',
              defaultMessage: '{count, plural, one {# signal} other {# signals}}',
            },
            { count: issue.count },
          ),
          t(
            { id: 'insights.signals.lastSeenAt', defaultMessage: 'last seen {time}' },
            { time: when },
          ),
          priorityName(issue.priority),
          sent?.name &&
            t(
              { id: 'insights.signals.sentToName', defaultMessage: 'sent to {name}' },
              { name: sent.name },
            ),
        )}
        onClick={() => setSelected(issue.id === selected ? null : issue.id)}
      >
        <span className="sg-st" data-st={tone(issue)} aria-hidden="true" />
        <span className="sg-sw">{state}</span>
        <Icon className="sg-ic" aria-hidden="true" />
        <Clip text={issue.title} />
        <span className="sg-n">{issue.count}</span>
        <span className="sg-n">{when}</span>
        <span className="sg-pr">{priorityName(issue.priority)}</span>
        <Clip className="sg-to" text={sent?.name ?? ''} />
      </button>
    );
  };

  const fact = (label: string, value: ReactNode) => [
    <dt key={`${label}-l`}>{label}</dt>,
    <dd key={label}>{value}</dd>,
  ];

  const inspector = (issue: ListedSignal) => {
    const Icon = SOURCE_ICONS[issue.source];
    const sent = sentTo(issue);
    const muted = mutedBy(issue).length;
    const history = [
      ...issue.history.map((entry) => ({ at: entry.at, text: stateName(entry.state) })),
      ...issue.routed.flatMap((entry) => {
        const name = nameOf(entry.agent_id);
        return name
          ? [
              {
                at: entry.at,
                text: t(
                  { id: 'insights.signals.sentTo', defaultMessage: 'Sent to {name}' },
                  { name },
                ),
              },
            ]
          : [];
      }),
    ].sort((a, b) => a.at - b.at);
    return (
      <aside
        className="sg-insp"
        aria-label={t({ id: 'insights.signals.details', defaultMessage: 'Signal details' })}
      >
        <div className="sg-ih">
          <Icon aria-hidden="true" />
          <h2>{issue.title}</h2>
          <button
            type="button"
            className="ib sg-end"
            aria-label={t({ id: 'insights.signals.close', defaultMessage: 'Close details' })}
            onClick={() => setSelected(null)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <div className="sg-ib">
          <section
            className="sg-sec"
            aria-label={t({ id: 'insights.signals.facts', defaultMessage: 'Facts' })}
          >
            <dl className="sg-kv">
              {fact(
                t({ id: 'insights.signals.fact.source', defaultMessage: 'Source' }),
                sourceName(issue.source),
              )}
              {fact(
                t({ id: 'insights.signals.fact.fingerprint', defaultMessage: 'Fingerprint' }),
                <span className="mono">{issue.fingerprint}</span>,
              )}
              {fact(
                t({ id: 'insights.signals.fact.firstSeen', defaultMessage: 'First seen' }),
                <span className="sg-tm">{dayText(issue.first_seen, now, { time: true })}</span>,
              )}
              {fact(
                t({ id: 'insights.signals.fact.lastSeen', defaultMessage: 'Last seen' }),
                <span className="sg-tm">{dayText(issue.last_seen, now, { time: true })}</span>,
              )}
              {fact(
                t({ id: 'insights.signals.fact.priority', defaultMessage: 'Priority' }),
                priorityName(issue.priority),
              )}
              {sent?.name &&
                fact(
                  t({ id: 'insights.signals.fact.sentTo', defaultMessage: 'Sent to' }),
                  <span className="sg-pair">
                    <span>{sent.name}</span>
                    <span className="sg-tm">{shortWhen(sent.at, now)}</span>
                  </span>,
                )}
            </dl>
          </section>
          {muted > 0 && (
            <section className="sg-sec" aria-labelledby="sg-muted-h">
              <div className="sg-sh">
                <span className="cap" id="sg-muted-h">
                  {t({ id: 'insights.signals.mutedByThis', defaultMessage: 'Muted by this' })}
                </span>
                <span className="sg-n sg-end">{muted}</span>
              </div>
            </section>
          )}
          <section className="sg-sec" aria-labelledby="sg-history-h">
            <div className="sg-sh">
              <span className="cap" id="sg-history-h">
                {t({ id: 'insights.signals.history', defaultMessage: 'History' })}
              </span>
            </div>
            <ol className="sg-hist">
              {history.map((entry, i) => (
                <li key={i}>
                  <span className="sg-tm">{shortWhen(entry.at, now)}</span>
                  <span>{entry.text}</span>
                </li>
              ))}
            </ol>
          </section>
          {issue.state !== 'resolved' && (
            <section className="sg-sec sg-acts">
              {issue.state !== 'muted' && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void act('signal.mute', issue.id)}
                >
                  {t({ id: 'insights.signals.mute', defaultMessage: 'Mute' })}
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void act('signal.resolve', issue.id)}
              >
                {t({ id: 'insights.signals.resolve', defaultMessage: 'Resolve' })}
              </button>
            </section>
          )}
        </div>
      </aside>
    );
  };

  return (
    <section
      className="sg"
      data-open={current ? '' : undefined}
      aria-label={t({ id: 'insights.sections.signals', defaultMessage: 'Signals' })}
    >
      <div className="sg-list" aria-busy={(!issues.read && issues.loading) || undefined}>
        <div
          className="seg sg-seg"
          role="radiogroup"
          aria-label={t({ id: 'insights.signals.filter.label', defaultMessage: 'Signal state' })}
        >
          {FILTERS.map((each) => (
            <button
              key={each}
              type="button"
              role="radio"
              aria-checked={filter === each}
              data-checked={filter === each || undefined}
              disabled={!issues.read}
              onClick={() => setFilter(each)}
            >
              {filterName(each)}
              <span className="sg-n">{issues.read ? count(each) : ''}</span>
            </button>
          ))}
        </div>
        {!issues.read && issues.error ? (
          <LoadError message={issues.error} onRetry={issues.reload} />
        ) : issues.read && shown.length === 0 ? (
          <EmptyState inline title={emptyText(filter)} />
        ) : (
          <div className="sg-rows" role="listbox" aria-label={listName(filter)}>
            {shown.map((issue) => {
              const nested = filter === 'open' ? mutedBy(issue) : [];
              return nested.length > 0
                ? [
                    row(issue),
                    <div
                      key={`${issue.id}-muted`}
                      className="sg-sub"
                      role="group"
                      aria-label={t({
                        id: 'insights.signals.mutedGroup',
                        defaultMessage: 'Muted by this signal',
                      })}
                    >
                      {nested.map(row)}
                    </div>,
                  ]
                : row(issue);
            })}
          </div>
        )}
      </div>
      {current && inspector(current)}
    </section>
  );
}
