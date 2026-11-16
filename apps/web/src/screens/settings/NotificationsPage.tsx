import { useState } from 'react';
import {
  NOTICE_EVENTS,
  readQuietTime,
  sendTestNotice,
  setNotificationPrefs,
  useNotificationPrefs,
  type NoticeDelivery,
  type NoticeEvent,
} from '../../data/notifications';
import { toast } from '../../components/Toast';
import { t } from '../../i18n';
import { Row, Section } from './ProjectSettingsScreen';
import './notifications-page.css';

function eventName(event: NoticeEvent): string {
  switch (event) {
    case 'approval_requested':
      return t({
        id: 'settings.notifications.approvalRequested',
        defaultMessage: 'Waiting for your approval',
      });
    case 'question_asked':
      return t({
        id: 'settings.notifications.questionAsked',
        defaultMessage: 'The agent asked a question',
      });
    case 'turn_completed':
      return t({ id: 'settings.notifications.turnCompleted', defaultMessage: 'Turn finished' });
    case 'ready_for_review':
      return t({ id: 'settings.notifications.readyForReview', defaultMessage: 'Ready for review' });
    case 'merged':
      return t({ id: 'settings.notifications.merged', defaultMessage: 'Merged' });
    case 'turn_failed':
      return t({ id: 'settings.notifications.turnFailed', defaultMessage: 'Turn failed' });
    case 'gate_failed':
      return t({
        id: 'settings.notifications.gateFailed',
        defaultMessage: 'Gate failed with no retries left',
      });
    case 'merge_blocked':
      return t({ id: 'settings.notifications.mergeBlocked', defaultMessage: 'Merge blocked' });
  }
}

function eventHint(event: NoticeEvent): string | undefined {
  switch (event) {
    case 'approval_requested':
      return t({
        id: 'settings.notifications.approvalRequestedHint',
        defaultMessage: 'A session stopped to wait for you',
      });
    case 'ready_for_review':
      return t({
        id: 'settings.notifications.readyForReviewHint',
        defaultMessage: 'Every check passed',
      });
    case 'gate_failed':
      return t({ id: 'settings.notifications.gateFailedHint', defaultMessage: 'Out of retries' });
    default:
      return undefined;
  }
}

const EVENT_SETTING: Record<NoticeEvent, string> = {
  approval_requested: 'notifications.approvalRequested',
  question_asked: 'notifications.questionAsked',
  turn_completed: 'notifications.turnCompleted',
  ready_for_review: 'notifications.readyForReview',
  merged: 'notifications.merged',
  turn_failed: 'notifications.turnFailed',
  gate_failed: 'notifications.gateFailed',
  merge_blocked: 'notifications.mergeBlocked',
};

const cellLabel = (event: string, delivery: string) =>
  t(
    { id: 'settings.notifications.cell', defaultMessage: '{event}, {delivery}' },
    { event, delivery },
  );

type QuietField = 'quiet_start' | 'quiet_end';

/** Which events show in the app, send a system notification and with what sound, and when none are sent. */
export function NotificationsPage() {
  const prefs = useNotificationPrefs();
  // What is typed into a quiet hours time until it leaves the field.
  const [typed, setTyped] = useState<Partial<Record<QuietField, string>>>({});
  const inApp = t({ id: 'settings.notifications.inApp', defaultMessage: 'In app' });
  const system = t({ id: 'settings.notifications.system', defaultMessage: 'System notification' });
  const sound = t({ id: 'settings.notifications.sound', defaultMessage: 'Sound' });
  const deliver = (event: NoticeEvent, patch: Partial<NoticeDelivery>) =>
    setNotificationPrefs({
      events: { ...prefs.events, [event]: { ...prefs.events[event], ...patch } },
    });
  const quietHours = t({ id: 'settings.notifications.quietHours', defaultMessage: 'Quiet hours' });
  // An emptied time turns quiet hours off; a time typed into either turns them on.
  const commitQuiet = (field: QuietField) => {
    const text = typed[field];
    setTyped((now) => ({ ...now, [field]: undefined }));
    if (text === undefined) return;
    const time = readQuietTime(text);
    if (!text.trim()) setNotificationPrefs({ quiet_hours: false });
    else if (time) setNotificationPrefs({ [field]: time, quiet_hours: true });
  };
  const quietTime = (field: QuietField, label: string) => (
    <input
      className="inp mono ntf-time"
      aria-label={label}
      value={typed[field] ?? (prefs.quiet_hours ? prefs[field] : '')}
      placeholder={prefs[field]}
      onChange={(e) => setTyped((now) => ({ ...now, [field]: e.target.value }))}
      onBlur={() => commitQuiet(field)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
  const badge = t({
    id: 'settings.notifications.badge',
    defaultMessage: 'Show the count on the app icon',
  });
  const test = t({ id: 'settings.notifications.test', defaultMessage: 'Send a test notification' });
  return (
    <>
      <Section>
        <table className="ps-ntf ntf-cols">
          <thead>
            <tr>
              <th scope="col">
                {t({ id: 'settings.notifications.event', defaultMessage: 'Event' })}
              </th>
              <th scope="col">{inApp}</th>
              <th scope="col">{system}</th>
              <th scope="col">{sound}</th>
            </tr>
          </thead>
          <tbody>
            {NOTICE_EVENTS.map((event) => {
              const name = eventName(event);
              const hint = eventHint(event);
              const delivery = prefs.events[event];
              return (
                <tr key={event} data-setting-id={EVENT_SETTING[event]}>
                  <th scope="row">
                    <span className="ps-row-nm">
                      {name}
                      {hint !== undefined && <span className="ps-row-hint">{hint}</span>}
                    </span>
                  </th>
                  <td>
                    <input
                      type="checkbox"
                      className="ps-sw"
                      aria-label={cellLabel(name, inApp)}
                      checked={prefs.in_app[event]}
                      onChange={(e) =>
                        setNotificationPrefs({
                          in_app: { ...prefs.in_app, [event]: e.target.checked },
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      className="ps-sw"
                      aria-label={cellLabel(name, system)}
                      checked={delivery.system}
                      onChange={(e) => deliver(event, { system: e.target.checked })}
                    />
                  </td>
                  <td>
                    {/* The sound is the system notification's own. */}
                    <input
                      type="checkbox"
                      className="ps-sw"
                      aria-label={cellLabel(name, sound)}
                      checked={delivery.system && delivery.sound}
                      disabled={!delivery.system}
                      onChange={(e) => deliver(event, { sound: e.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section
        title={t({ id: 'settings.notifications.delivery', defaultMessage: 'Delivery rules' })}
      >
        <div className="ps-rows">
          <Row
            label={quietHours}
            hint={t({
              id: 'settings.notifications.quietHoursHint',
              defaultMessage: 'Only marked in the session list',
            })}
            settingId="notifications.quietHours"
          >
            {quietTime(
              'quiet_start',
              t({ id: 'settings.notifications.quietStart', defaultMessage: 'Start' }),
            )}
            <span className="mu">
              {t({ id: 'settings.notifications.quietTo', defaultMessage: 'to' })}
            </span>
            {quietTime(
              'quiet_end',
              t({ id: 'settings.notifications.quietEnd', defaultMessage: 'End' }),
            )}
          </Row>
          <Row label={badge} settingId="notifications.badge">
            <input
              type="checkbox"
              className="ps-sw"
              aria-label={badge}
              checked={prefs.badge}
              onChange={(e) => setNotificationPrefs({ badge: e.target.checked })}
            />
          </Row>
          <Row label={test} settingId="notifications.test">
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                void sendTestNotice().then((sent) => {
                  if (sent)
                    toast({
                      title: t({
                        id: 'settings.notifications.testSent',
                        defaultMessage: 'Test notification sent',
                      }),
                    });
                })
              }
            >
              {t({ id: 'settings.notifications.send', defaultMessage: 'Send' })}
            </button>
          </Row>
        </div>
      </Section>
    </>
  );
}
