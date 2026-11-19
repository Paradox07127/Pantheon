import { useState, type CSSProperties, type ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { shortId } from '../../data/format';
import { t } from '../../i18n';
import { Empty, NumText, Panel, WarnIcon, runtimeColor } from './Charts';
import { MergeTrack } from './QualityCharts';
import { dayText } from '../../lib/time-text';
import { recentMerges, runtimeName, visibleFindings, type BoardFinding } from './panels-model';
import { BlockedIcon } from './status';
import './lists.css';

const BlockerIcon = () => <BlockedIcon className="bp-ic" />;
const MinorIcon = () => (
  <svg className="bp-ic" viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="6" cy="6" r="1.4" fill="currentColor" />
  </svg>
);

// Labels are getters, so each is read in the language loaded by then.
const SEVERITY: Record<
  BoardFinding['severity'],
  { label: string; color: string; icon: () => ReactElement }
> = {
  blocker: {
    get label() {
      return t({ id: 'board.findings.severity.blocker', defaultMessage: 'Blocker' });
    },
    color: 'var(--bad)',
    icon: BlockerIcon,
  },
  major: {
    get label() {
      return t({ id: 'board.findings.severity.major', defaultMessage: 'Major' });
    },
    color: 'var(--wait)',
    icon: WarnIcon,
  },
  minor: {
    get label() {
      return t({ id: 'board.findings.severity.minor', defaultMessage: 'Minor' });
    },
    color: 'var(--mu)',
    icon: MinorIcon,
  },
};
const FINDING_STATE: Record<BoardFinding['state'], string> = {
  get open() {
    return t({ id: 'board.findings.state.open', defaultMessage: 'Open' });
  },
  get adopted() {
    return t({ id: 'board.findings.state.adopted', defaultMessage: 'Adopted' });
  },
  get dismissed() {
    return t({ id: 'board.findings.state.dismissed', defaultMessage: 'Dismissed' });
  },
};

export function MergesPanel({
  model,
  onOpenSession,
  onOpenStory,
}: {
  model: BoardModel;
  onOpenSession: (sessionId: string) => void;
  /** Opens the change story of a merged session. */
  onOpenStory: (sessionId: string) => void;
}) {
  const merges = recentMerges(model.merges);
  return (
    <Panel
      title={t({ id: 'board.merges.title', defaultMessage: 'Local merge history' })}
      className="ql-mgp"
      num={
        <span className="bp-hn">
          {t({ id: 'board.merges.merged', defaultMessage: 'Merged' })}{' '}
          <NumText text={String(model.counts.merged)} />{' '}
          {t({ id: 'board.merges.reverted', defaultMessage: 'Reverted' })}{' '}
          <NumText text={String(model.counts.reverted)} />
        </span>
      }
    >
      {merges.length === 0 ? (
        <Empty text={t({ id: 'board.merges.empty', defaultMessage: 'No merges yet' })} />
      ) : (
        <>
          <MergeTrack
            merges={model.merges}
            since={model.since}
            now={model.now}
            onOpenSession={onOpenSession}
          />
          <div className="bp-pb bp-mgl">
            {merges.map((m) => (
              <div className="bp-mg-row" key={`${m.session_id}-${m.sha}`}>
                <span className="tm">{dayText(m.merged_at, model.now, { time: true })}</span>
                {/* The board names a deleted session with an empty title. */}
                {m.title ? (
                  <button className="nm" type="button" onClick={() => onOpenSession(m.session_id)}>
                    {m.title}
                  </button>
                ) : (
                  <span className="nm">
                    {t(
                      { id: 'board.session.fallbackTitle', defaultMessage: 'Session {id}' },
                      { id: shortId(m.session_id) },
                    )}
                  </span>
                )}
                <span className="bp-dfx">
                  <DiffCounts additions={m.additions} deletions={m.deletions} />
                </span>
                <span className="sha">{m.sha.slice(0, 7)}</span>
                {m.story_id && m.title ? (
                  <button
                    className="bp-lnk"
                    type="button"
                    aria-label={t(
                      { id: 'board.merges.openStory', defaultMessage: 'Open change story {title}' },
                      { title: m.title },
                    )}
                    onClick={() => onOpenStory(m.session_id)}
                  >
                    {t({ id: 'board.merges.story', defaultMessage: 'Change story' })}
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

type FindingOutcome = 'adopted' | 'dismissed';
/** Resolves to the failure text, or null once the command went through. */
type ResolveFinding = (finding: BoardFinding, outcome: FindingOutcome) => Promise<string | null>;

export function FindingRow({
  finding: f,
  onOpenSession,
  onResolve,
}: {
  finding: BoardFinding;
  onOpenSession: (sessionId: string) => void;
  onResolve?: ResolveFinding;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The review revision of an accepted resolve; the buttons stay off until the board moves past it.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const busy = sending || sentAt === f.review_revision;
  const resolve = async (outcome: FindingOutcome) => {
    const revision = f.review_revision;
    setSending(true);
    setError(null);
    const failure = await onResolve!(f, outcome);
    setSending(false);
    setError(failure);
    if (!failure) setSentAt(revision);
  };
  const sev = SEVERITY[f.severity];
  const Icon = sev.icon;
  const where = f.path ? `${f.path}${f.line != null ? `:${f.line}` : ''}` : '';
  const file = f.path ? `${f.path.split('/').pop()}${f.line != null ? `:${f.line}` : ''}` : '';
  return (
    <div className="bp-fd">
      <div className="l1">
        <span className="sev" style={{ '--c': sev.color } as CSSProperties}>
          <Icon />
          {sev.label}
        </span>
        <button className="tx1" type="button" onClick={() => onOpenSession(f.session_id)}>
          {f.text}
        </button>
      </div>
      <div className="l2">
        {file && (
          <span className="path" title={where}>
            {file}
          </span>
        )}
        <span className="rv">
          <i className="bp-rtd" style={{ backgroundColor: runtimeColor(f.reviewer) }} />
          {runtimeName(f.reviewer)}
        </span>
        <span className={`fs ${f.state}`}>{FINDING_STATE[f.state]}</span>
        {onResolve && f.state === 'open' && (
          <span className="fd-acts">
            <button
              className="bp-lnk"
              type="button"
              aria-label={t(
                { id: 'board.findings.adoptLabel', defaultMessage: 'Adopt {finding}' },
                { finding: f.text },
              )}
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => void resolve('adopted')}
            >
              {t({ id: 'board.findings.adopt', defaultMessage: 'Adopt' })}
            </button>
            <button
              className="bp-lnk"
              type="button"
              aria-label={t(
                { id: 'board.findings.dismissLabel', defaultMessage: 'Dismiss {finding}' },
                { finding: f.text },
              )}
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => void resolve('dismissed')}
            >
              {t({ id: 'board.findings.dismiss', defaultMessage: 'Dismiss' })}
            </button>
          </span>
        )}
      </div>
      {error && (
        <div className="bp-err" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function FindingsPanel({
  model,
  onOpenSession,
  onResolve,
}: {
  model: BoardModel;
  onOpenSession: (sessionId: string) => void;
  /** Adopts or dismisses an open finding; without it the rows offer neither. */
  onResolve?: ResolveFinding;
}) {
  const [all, setAll] = useState(false);
  const findings = visibleFindings(model.findings, all);
  return (
    <Panel
      title={t({ id: 'board.findings.title', defaultMessage: 'Review findings' })}
      className="bp-listp"
      tools={
        <div
          className="bp-seg"
          role="group"
          aria-label={t({ id: 'board.findings.filter', defaultMessage: 'Filter review findings' })}
        >
          <button type="button" aria-pressed={!all} onClick={() => setAll(false)}>
            {t({ id: 'board.findings.filterOpen', defaultMessage: 'Open' })}
          </button>
          <button type="button" aria-pressed={all} onClick={() => setAll(true)}>
            {t({ id: 'board.findings.filterAll', defaultMessage: 'All' })}
          </button>
        </div>
      }
    >
      {findings.length === 0 ? (
        <Empty text={t({ id: 'board.findings.empty', defaultMessage: 'No review findings' })} />
      ) : (
        <div className="bp-pb">
          {findings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              onOpenSession={onOpenSession}
              onResolve={onResolve}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}
