import { useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { AttentionDelivery, AttentionKind } from '@pantheon/protocol';
import { useAppSettings } from '../../data/app-settings';
import {
  DECISION_NAME,
  DELIVERY_NAME,
  readQuietTime,
  sendTestNotice,
  setNotificationPrefs,
  useNotificationPrefs,
} from '../../data/notifications';
import { toast } from '../../components/Toast';
import { t } from '../../i18n';
import { Row, Section } from './ProjectSettingsScreen';
import './notifications-page.css';

// Every rule key, in the order the names are listed.
const KINDS = Object.keys(DECISION_NAME) as AttentionKind[];
const DELIVERIES = Object.keys(DELIVERY_NAME) as AttentionDelivery[];

type QuietField = 'from' | 'to';
// What a first typed time pairs with.
const QUIET_PLACEHOLDER = { from: '22:00', to: '08:00' };

function DeliveryChoice(props: {
  label: string;
  value: AttentionDelivery | null;
  disabled: boolean;
  title?: string;
  onChange?: (delivery: AttentionDelivery) => void;
}) {
  return (
    // Null keeps the group controlled with nothing chosen while the settings load.
    <RadioGroup<AttentionDelivery | null>
      className="tb-seg"
      aria-label={props.label}
      title={props.title}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(delivery) => delivery && props.onChange?.(delivery)}
    >
      {DELIVERIES.map((delivery) => (
        <Radio.Root key={delivery} value={delivery}>
          {t(DELIVERY_NAME[delivery])}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** How each kind of decision and merges reach the user, the quiet hours, and this computer's sound and badge. */
export function NotificationsPage() {
  const prefs = useNotificationPrefs();
  const { settings, save } = useAppSettings();
  // What is typed into a quiet hours time until it leaves the field.
  const [typed, setTyped] = useState<Partial<Record<QuietField, string>>>({});
  const quiet = settings?.quiet_hours;
  const quietHours = t({ id: 'settings.notifications.quietHours', defaultMessage: 'Quiet hours' });
  // An emptied time clears quiet hours; a time typed into either sets them.
  const commitQuiet = (field: QuietField) => {
    const text = typed[field];
    setTyped((now) => ({ ...now, [field]: undefined }));
    if (text === undefined) return;
    const time = readQuietTime(text);
    if (!text.trim()) {
      if (quiet) void save({ quiet_hours: null });
    } else if (time) void save({ quiet_hours: { ...(quiet ?? QUIET_PLACEHOLDER), [field]: time } });
  };
  const quietTime = (field: QuietField, label: string) => (
    <input
      className="inp mono ntf-time"
      aria-label={label}
      value={typed[field] ?? quiet?.[field] ?? ''}
      placeholder={QUIET_PLACEHOLDER[field]}
      disabled={!settings}
      onChange={(e) => setTyped((now) => ({ ...now, [field]: e.target.value }))}
      onBlur={() => commitQuiet(field)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
  const overdue = t({
    id: 'settings.notifications.overdueQuestion',
    defaultMessage: 'Question waiting over 4 hours',
  });
  const sound = t({ id: 'settings.notifications.sound', defaultMessage: 'Sound' });
  const badge = t({
    id: 'settings.notifications.badge',
    defaultMessage: 'Show the count on the app icon',
  });
  const test = t({ id: 'settings.notifications.test', defaultMessage: 'Send a test notification' });
  return (
    <>
      <Section>
        <div className="ps-rows" aria-busy={!settings || undefined}>
          {KINDS.map((kind) => {
            const name = t(DECISION_NAME[kind]);
            return (
              <Row key={kind} label={name} settingId={`notifications.${kind}`}>
                <DeliveryChoice
                  label={name}
                  value={settings?.attention_delivery[kind] ?? null}
                  disabled={!settings}
                  onChange={(delivery) => void save({ attention_delivery: { [kind]: delivery } })}
                />
              </Row>
            );
          })}
          <Row label={overdue}>
            <DeliveryChoice
              label={overdue}
              value="now"
              disabled
              title={t({
                id: 'settings.notifications.overdueReason',
                defaultMessage: 'Always notifies: a question this old holds its plan',
              })}
            />
          </Row>
        </div>
      </Section>
      <Section
        title={t({ id: 'settings.notifications.delivery', defaultMessage: 'Delivery rules' })}
      >
        <div className="ps-rows">
          <Row label={quietHours} settingId="notifications.quietHours">
            {quietTime(
              'from',
              t({ id: 'settings.notifications.quietStart', defaultMessage: 'Start' }),
            )}
            <span className="mu">
              {t({ id: 'settings.notifications.quietTo', defaultMessage: 'to' })}
            </span>
            {quietTime('to', t({ id: 'settings.notifications.quietEnd', defaultMessage: 'End' }))}
            {quiet && (
              <button
                type="button"
                className="btn ghost sm"
                aria-label={t({
                  id: 'settings.notifications.clearQuietHours',
                  defaultMessage: 'Clear quiet hours',
                })}
                onClick={() => void save({ quiet_hours: null })}
              >
                {t({ id: 'settings.notifications.clear', defaultMessage: 'Clear' })}
              </button>
            )}
          </Row>
          <Row label={sound}>
            <input
              type="checkbox"
              className="ps-sw"
              aria-label={sound}
              checked={prefs.sound}
              onChange={(e) => setNotificationPrefs({ sound: e.target.checked })}
            />
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
