import { useState, type ReactNode } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Tabs } from '@base-ui/react/tabs';
import { Bell, Crown, KeyRound, ScrollText, Workflow, X } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { TopBar } from '../../components/TopBar';
import { useAppSettings } from '../../data/app-settings';
import { useBoard } from '../../data/board';
import {
  decisionRow,
  useDecisionsForUser,
  type DecisionRange,
} from '../../data/decisions-for-user';
import { shortId } from '../../data/format';
import { sessionTitle } from '../../data/transcript';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import { Failure, Skeleton } from '../board/BoardScreen';
import { decisionDeliveryRows } from '../settings/NotificationsPage';
import './approved-for-you.css';

const RANGES: { range: DecisionRange; label: string }[] = [
  {
    range: 'today',
    get label() {
      return t({ id: 'trace.approved.range.today', defaultMessage: 'Today' });
    },
  },
  {
    range: 'week',
    get label() {
      return t({ id: 'trace.approved.range.week', defaultMessage: '7 days' });
    },
  },
  {
    range: 'month',
    get label() {
      return t({ id: 'trace.approved.range.month', defaultMessage: '30 days' });
    },
  },
];

/** The delivery rules by decision, as the notifications settings page has them. */
function DeliveryRules() {
  const { settings, save } = useAppSettings();
  return decisionDeliveryRows(settings, save);
}

/**
 * What a lead or a stored rule decided without the user in the project, over a range of days, with
 * the delivery rules beside it on demand; `tabs` are the trace's own.
 */
export function ApprovedForYou({ projectId, tabs }: { projectId: string | null; tabs: ReactNode }) {
  const [range, setRange] = useState<DecisionRange>('today');
  const [notifying, setNotifying] = useState(false);
  const read = useDecisionsForUser(projectId, range);
  const board = useBoard((s) => s.board);
  const rows = read.read?.items.map(decisionRow) ?? null;
  const now = Date.now();
  const titleOf = (sessionId: string) => {
    const session = board?.sessions.find((s) => s.id === sessionId);
    return session && board ? sessionTitle(session, board) : shortId(sessionId);
  };
  const label = t({ id: 'trace.approved.label', defaultMessage: 'Approved for you' });
  const notifications = t({ id: 'trace.approved.notifications', defaultMessage: 'Notifications' });
  return (
    <>
      <TopBar title={SCREEN_NAMES.trace}>
        {tabs}
        <div className="tb-end">
          <RadioGroup<DecisionRange>
            className="tb-seg"
            aria-label={t({ id: 'trace.approved.range', defaultMessage: 'Time range' })}
            value={range}
            onValueChange={(value) => setRange(value)}
          >
            {RANGES.map((r) => (
              <Radio.Root key={r.range} value={r.range}>
                {r.label}
              </Radio.Root>
            ))}
          </RadioGroup>
          <button
            type="button"
            className="btn ghost sm"
            aria-pressed={notifying}
            onClick={() => setNotifying((on) => !on)}
          >
            <Bell className="ic-sm" aria-hidden="true" />
            {notifications}
          </button>
        </div>
      </TopBar>
      <main className="trc">
        <Tabs.Panel className="trc-body" value="approved">
          <div className="trc-main afy">
            {read.error && <Failure error={read.error} onRetry={read.reload} />}
            {rows === null ? (
              !read.error && <Skeleton />
            ) : rows.length === 0 ? (
              <EmptyState
                inline
                title={t({
                  id: 'trace.approved.empty',
                  defaultMessage: 'Nothing was approved for you.',
                })}
              />
            ) : (
              <div className="afy-t" role="table" aria-label={label}>
                <div className="afy-r afy-hd" role="row">
                  <span role="columnheader">
                    {t({ id: 'trace.approved.column.action', defaultMessage: 'Action' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'trace.approved.column.by', defaultMessage: 'Approved by' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'trace.approved.column.rule', defaultMessage: 'Rule' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'trace.approved.column.task', defaultMessage: 'Task' })}
                  </span>
                  <span role="columnheader">
                    {t({ id: 'trace.approved.column.when', defaultMessage: 'When' })}
                  </span>
                </div>
                {rows.map((row) => (
                  <div key={row.key} className="afy-r" role="row">
                    <span role="cell" className="afy-a">
                      {row.subject === null ? (
                        <KeyRound className="ic-sm" aria-hidden="true" />
                      ) : (
                        <Workflow className="ic-sm" aria-hidden="true" />
                      )}
                      <span className="afy-what">
                        <Clip text={row.action} className={row.code ? 'mono' : undefined} />
                        {row.subject !== null && <Clip text={row.subject} className="mono mu" />}
                      </span>
                    </span>
                    <span role="cell" className="afy-by">
                      {row.rule === null ? (
                        <Crown className="ic-sm" aria-hidden="true" />
                      ) : (
                        <ScrollText className="ic-sm" aria-hidden="true" />
                      )}
                      {row.by}
                    </span>
                    <span role="cell" className="afy-c">
                      {row.rule !== null && <Clip text={row.rule} className="mono" />}
                    </span>
                    <span role="cell" className="afy-c">
                      {row.sessionId !== null && (
                        <button
                          type="button"
                          className="afy-ref"
                          onClick={() => useShell.getState().openSession(row.sessionId!)}
                        >
                          <Clip text={titleOf(row.sessionId)} />
                        </button>
                      )}
                    </span>
                    <span role="cell" className="afy-when">
                      {dayText(row.at, now, { time: true })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {notifying && (
            <aside className="afy-pnl" aria-label={notifications}>
              <div className="afy-pnl-h">
                <Bell className="ic-sm" aria-hidden="true" />
                <h2>{notifications}</h2>
                <button
                  type="button"
                  className="ib"
                  aria-label={t({
                    id: 'trace.approved.closeNotifications',
                    defaultMessage: 'Close notifications',
                  })}
                  onClick={() => setNotifying(false)}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <DeliveryRules />
            </aside>
          )}
        </Tabs.Panel>
      </main>
    </>
  );
}
