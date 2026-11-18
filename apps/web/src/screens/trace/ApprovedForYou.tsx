import { useEffect, useState, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Tabs } from '@base-ui/react/tabs';
import { Bell, Crown, KeyRound, MessageSquare, ScrollText, User, Workflow, X } from 'lucide-react';
import { decisionType, type DecisionType } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { TopBar } from '../../components/TopBar';
import { useAppSettings } from '../../data/app-settings';
import { useBoard } from '../../data/board';
import {
  decisionRow,
  rangeSince,
  useDecisionsForUser,
  type DecisionRange,
  type DecisionRow,
} from '../../data/decisions-for-user';
import { shortId } from '../../data/format';
import { sendProjectCommand } from '../../data/project-read';
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

type TypeFilter = DecisionType | 'all';

const TYPES: { type: TypeFilter; label: string }[] = [
  {
    type: 'all',
    get label() {
      return t({ id: 'trace.approved.type.all', defaultMessage: 'All' });
    },
  },
  {
    type: 'permission',
    get label() {
      return t({ id: 'trace.approved.type.permission', defaultMessage: 'Permissions' });
    },
  },
  {
    type: 'answer',
    get label() {
      return t({ id: 'trace.approved.type.answer', defaultMessage: 'Answers' });
    },
  },
  {
    type: 'plan_change',
    get label() {
      return t({ id: 'trace.approved.type.planChange', defaultMessage: 'Plan changes' });
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
  const [type, setType] = useState<TypeFilter>('all');
  // The type another page opened the list on, taken once.
  const asked = useShell((s) => s.approvedType);
  const askedSince = useShell((s) => s.approvedSince);
  useEffect(() => {
    if (!asked) return;
    setType(asked);
    // The shortest range that reaches back to the time the asking page counted from.
    if (askedSince !== null)
      setRange(
        RANGES.find(({ range }) => rangeSince(range, Date.now()) <= askedSince)?.range ?? 'month',
      );
    useShell.setState({ approvedType: null, approvedSince: null });
  }, [asked, askedSince]);
  const [notifying, setNotifying] = useState(false);
  // The open overrule dialog: its row, the typed answer, and the last failure.
  const [overruling, setOverruling] = useState<{
    key: string;
    text: string;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const read = useDecisionsForUser(projectId, range);
  const board = useBoard((s) => s.board);
  const items = read.read?.items ?? null;
  const counts = items && {
    all: items.length,
    permission: items.filter((item) => decisionType(item) === 'permission').length,
    answer: items.filter((item) => decisionType(item) === 'answer').length,
    plan_change: items.filter((item) => decisionType(item) === 'plan_change').length,
  };
  const rows =
    items?.filter((item) => type === 'all' || decisionType(item) === type).map(decisionRow) ?? null;
  const now = Date.now();
  const titleOf = (sessionId: string) => {
    const session = board?.sessions.find((s) => s.id === sessionId);
    return session && board ? sessionTitle(session, board) : shortId(sessionId);
  };
  const overrule = async (row: DecisionRow, answer: string) => {
    setOverruling((s) => s && { ...s, busy: true, error: null });
    const result = await sendProjectCommand(
      'lead.question.overrule',
      {
        project_id: projectId,
        lead_session_id: row.answer!.leadSessionId,
        question_id: row.answer!.questionId,
        answer,
      },
      null,
    );
    setOverruling((s) =>
      s?.key !== row.key ? s : result.ok ? null : { ...s, busy: false, error: result.error },
    );
  };
  const label = t({ id: 'trace.approved.label', defaultMessage: 'Approved for you' });
  const lead = t({ id: 'trace.approved.by.lead', defaultMessage: 'Lead' });
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
            <RadioGroup<TypeFilter>
              className="tb-seg afy-type"
              aria-label={t({ id: 'trace.approved.type', defaultMessage: 'Type' })}
              aria-busy={counts === null || undefined}
              disabled={counts === null}
              value={type}
              onValueChange={(value) => setType(value)}
            >
              {TYPES.map((k) => (
                <Radio.Root
                  key={k.type}
                  value={k.type}
                  aria-label={
                    counts
                      ? t(
                          { id: 'trace.approved.type.count', defaultMessage: '{type}: {count}' },
                          { type: k.label, count: counts[k.type] },
                        )
                      : k.label
                  }
                >
                  {k.label}
                  {counts && <span className="tb-ct">{counts[k.type]}</span>}
                </Radio.Root>
              ))}
            </RadioGroup>
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
                    {t({ id: 'trace.approved.column.reason', defaultMessage: 'Reason' })}
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
                  <span role="columnheader" />
                </div>
                {rows.map((row) => (
                  <div key={row.key} className="afy-r" role="row">
                    <span role="cell" className="afy-a">
                      {row.answer !== null ||
                      (row.kind === 'personal_answer' && row.subject === null) ? (
                        <MessageSquare className="ic-sm" aria-hidden="true" />
                      ) : row.subject === null ? (
                        <KeyRound className="ic-sm" aria-hidden="true" />
                      ) : (
                        <Workflow className="ic-sm" aria-hidden="true" />
                      )}
                      <span className="afy-what">
                        <Clip text={row.action} className={row.code ? 'mono' : undefined} />
                        {row.subject !== null && <Clip text={row.subject} className="mono mu" />}
                        {row.answer !== null &&
                          (row.answer.overruled ? (
                            <span className="afy-ans">
                              <User className="ic-sm" aria-hidden="true" />
                              <Clip text={row.answer.text} />
                            </span>
                          ) : (
                            <Clip text={row.answer.text} className="mu" />
                          ))}
                        {row.decision !== null && <Clip text={row.decision} className="mu" />}
                      </span>
                    </span>
                    <span role="cell" className="afy-by">
                      {row.kind === 'prompt_by_rule' ? (
                        <ScrollText className="ic-sm" aria-hidden="true" />
                      ) : row.kind === 'personal_answer' ? (
                        <KeyRound className="ic-sm" aria-hidden="true" />
                      ) : (
                        <Crown className="ic-sm" aria-hidden="true" />
                      )}
                      {row.by}
                    </span>
                    <span role="cell" className="afy-c">
                      {row.reason !== null && <Clip text={row.reason} />}
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
                    <span role="cell" className="afy-x">
                      {row.answer?.overruled ? (
                        <span className="chip afy-ovd">
                          {t({ id: 'trace.approved.overruled', defaultMessage: 'Overruled' })}
                        </span>
                      ) : (
                        row.answer !== null && (
                          <Popover.Root
                            open={overruling?.key === row.key}
                            onOpenChange={(open) =>
                              setOverruling(
                                open ? { key: row.key, text: '', busy: false, error: null } : null,
                              )
                            }
                          >
                            <Popover.Trigger className="btn ghost sm">
                              {t({ id: 'trace.approved.overrule', defaultMessage: 'Overrule' })}
                            </Popover.Trigger>
                            <Popover.Portal>
                              <Popover.Positioner
                                side="bottom"
                                align="end"
                                sideOffset={4}
                                style={{ zIndex: 40 }}
                              >
                                <Popover.Popup
                                  className="pop afy-ov"
                                  aria-label={t({
                                    id: 'trace.approved.overrule.label',
                                    defaultMessage: 'Overrule answer',
                                  })}
                                >
                                  <span className="afy-ov-q">{row.action}</span>
                                  <span className="afy-ov-l">
                                    <Crown className="ic-sm" aria-hidden="true" />
                                    <span className="mu">{lead}</span>
                                    <span>{row.answer.text}</span>
                                  </span>
                                  <label className="afy-ov-f">
                                    <span className="cap">
                                      {t({
                                        id: 'trace.approved.overrule.yours',
                                        defaultMessage: 'Your answer',
                                      })}
                                    </span>
                                    <textarea
                                      rows={3}
                                      value={overruling?.text ?? ''}
                                      readOnly={overruling?.busy}
                                      onChange={(e) => {
                                        const text = e.target.value;
                                        setOverruling((s) => s && { ...s, text });
                                      }}
                                    />
                                  </label>
                                  {overruling?.error && (
                                    <div className="afy-ov-err" role="alert">
                                      {overruling.error}
                                    </div>
                                  )}
                                  <span className="afy-ov-b">
                                    <Popover.Close className="btn sm">
                                      {t({
                                        id: 'trace.approved.overrule.cancel',
                                        defaultMessage: 'Cancel',
                                      })}
                                    </Popover.Close>
                                    <button
                                      type="button"
                                      className="btn pri sm"
                                      aria-busy={overruling?.busy || undefined}
                                      disabled={!overruling?.text.trim() || overruling.busy}
                                      onClick={() => void overrule(row, overruling!.text.trim())}
                                    >
                                      {t({
                                        id: 'trace.approved.overrule.send',
                                        defaultMessage: 'Overrule',
                                      })}
                                    </button>
                                  </span>
                                </Popover.Popup>
                              </Popover.Positioner>
                            </Popover.Portal>
                          </Popover.Root>
                        )
                      )}
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
