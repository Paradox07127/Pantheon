import { useState, type CSSProperties, type ReactNode } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Search } from 'lucide-react';
import type { RuntimeDiagnostics, RuntimeFinding, RuntimeReviewHistory } from '@pantheon/domain';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../i18n';
import { shortcutKeys } from '../../lib/shortcuts';
import { clockText, durationText } from '../../lib/time-text';
import { FINDING_ICONS, FindingDetail, findingReason, runtimeFindingTitle } from './FindingDetail';
import { ReviewRecords } from './ReviewRecords';
import './diagnose.css';

export { runtimeFindingTitle };

type View = 'findings' | 'records';

export function RuntimePanel({
  overview,
  diagnostics,
  reviews,
  stale,
  titleOf,
  onEvidence,
  onAllTime,
}: {
  overview: ReactNode;
  diagnostics: RuntimeDiagnostics;
  reviews: RuntimeReviewHistory[];
  stale: boolean;
  titleOf: (lane: string) => string;
  onEvidence: (finding: RuntimeFinding) => void;
  /** Widens the window to all time; absent once it is all time. */
  onAllTime?: () => void;
}) {
  const [view, setView] = useState<View>('findings');
  const [picked, setPicked] = useState<string | null>(null);
  const { findings } = diagnostics;
  const shown = findings.find((finding) => finding.id === picked);
  const pick = (finding: RuntimeFinding) => setPicked(finding.id);
  const sessionOf = (finding: RuntimeFinding) =>
    finding.lane_key ? titleOf(finding.lane_key) : '';

  return (
    <section
      className="dg"
      aria-label={t({ id: 'trace.diagnose.label', defaultMessage: 'Diagnose' })}
    >
      <div className="dg-main">
        {overview}
        <RadioGroup<View>
          className="tb-seg dg-views"
          aria-label={t({ id: 'trace.diagnose.view', defaultMessage: 'View' })}
          value={view}
          onValueChange={(value) => setView(value)}
        >
          <Radio.Root value="findings">
            {t({ id: 'trace.diagnose.findings', defaultMessage: 'Findings' })}
            <span className="trb-ct">{findings.length}</span>
          </Radio.Root>
          <Radio.Root value="records">
            {t({ id: 'trace.diagnose.records', defaultMessage: 'Analysis records' })}
            <span className="trb-ct">{reviews.length}</span>
          </Radio.Root>
        </RadioGroup>
        {view === 'records' ? (
          <ReviewRecords
            reviews={reviews}
            findings={findings}
            stale={stale}
            titleOf={titleOf}
            onFinding={pick}
          />
        ) : findings.length ? (
          <FindingTable findings={findings} picked={picked} sessionOf={sessionOf} onPick={pick} />
        ) : (
          <NoFindings diagnostics={diagnostics} onAllTime={onAllTime} />
        )}
      </div>
      {shown && (
        <FindingDetail
          key={shown.id}
          finding={shown}
          title={sessionOf(shown)}
          onClose={() => setPicked(null)}
          onShowInTimeline={() => onEvidence(shown)}
          slowToolMs={diagnostics.slow_tool_ms}
        />
      )}
    </section>
  );
}

function FindingTable({
  findings,
  picked,
  sessionOf,
  onPick,
}: {
  findings: RuntimeFinding[];
  picked: string | null;
  sessionOf: (finding: RuntimeFinding) => string;
  onPick: (finding: RuntimeFinding) => void;
}) {
  const max = Math.max(1, ...findings.map((finding) => finding.duration_ms ?? 0));
  const label = t({ id: 'trace.diagnose.findings', defaultMessage: 'Findings' });
  return (
    <div className="dg-table">
      <div className="dg-row dg-head" aria-hidden="true">
        <span />
        <span>{t({ id: 'trace.diagnose.col.kind', defaultMessage: 'Kind' })}</span>
        <span>{t({ id: 'trace.diagnose.col.session', defaultMessage: 'Session' })}</span>
        <span>{t({ id: 'trace.diagnose.col.reason', defaultMessage: 'Reason' })}</span>
        <span />
        <span className="dg-end">
          {t({ id: 'trace.diagnose.col.duration', defaultMessage: 'Duration' })}
        </span>
        <span className="dg-end">
          {t({ id: 'trace.diagnose.col.time', defaultMessage: 'Time' })}
        </span>
      </div>
      <div className="dg-list" role="listbox" aria-label={label}>
        {findings.map((finding, index) => {
          const Icon = FINDING_ICONS[finding.kind];
          const reason = findingReason(finding);
          const share =
            finding.duration_ms === undefined
              ? null
              : Math.round((finding.duration_ms / max) * 100);
          return (
            <button
              key={finding.id}
              type="button"
              className="dg-row"
              role="option"
              aria-selected={finding.id === picked}
              style={{ '--dg-k': Math.min(index, 8) } as CSSProperties}
              onClick={() => onPick(finding)}
            >
              <Icon aria-hidden="true" />
              <span className="dg-kind">{runtimeFindingTitle(finding)}</span>
              <span className="dg-cut">{sessionOf(finding)}</span>
              <span className="dg-cut dg-mu" title={finding.error}>
                {reason ?? ''}
              </span>
              {share === null ? (
                <span />
              ) : (
                <div
                  className="meter"
                  role="img"
                  aria-label={t(
                    {
                      id: 'trace.diagnose.share',
                      defaultMessage: 'Duration is {share, number}% of the longest',
                    },
                    { share },
                  )}
                  style={{ '--v': `${share}%` } as CSSProperties}
                >
                  <i />
                </div>
              )}
              <span className="dg-end dg-num">
                {finding.duration_ms === undefined ? '—' : durationText(finding.duration_ms)}
              </span>
              {finding.ongoing ? (
                <span className="dg-end dg-on">
                  <span className="dg-st" data-layer={finding.layer} aria-hidden="true" />
                  {t({ id: 'trace.runtime.ongoing', defaultMessage: 'In progress' })}
                </span>
              ) : (
                <span className="dg-end dg-num dg-mu" data-code>
                  {clockText(finding.at, { seconds: true })}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NoFindings({
  diagnostics,
  onAllTime,
}: {
  diagnostics: RuntimeDiagnostics;
  onAllTime?: () => void;
}) {
  const keys = shortcutKeys('trace-all');
  return (
    <EmptyState
      graphic={<Search aria-hidden="true" />}
      title={t({
        id: 'trace.diagnose.empty',
        defaultMessage: 'No bottlenecks found in this window',
      })}
      note={t(
        {
          id: 'trace.diagnose.read',
          defaultMessage:
            'Read {events, plural, one {# event} other {# events}}, {calls, plural, one {# call} other {# calls}}',
        },
        {
          events: diagnostics.events_read,
          calls: diagnostics.tools_timed + diagnostics.tools_untimed,
        },
      )}
      action={
        onAllTime && {
          label: t({ id: 'trace.diagnose.allTime', defaultMessage: 'Switch to all time' }),
          keys: keys || undefined,
          onClick: onAllTime,
        }
      }
    />
  );
}
