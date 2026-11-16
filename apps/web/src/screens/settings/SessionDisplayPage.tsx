import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { setLook, useLook, type Transcript } from '../../data/layout';
import {
  setSessionDisplay,
  useSessionDisplay,
  type OverviewStart,
  type RunningSend,
  type SessionDisplay,
  type StateMotion,
  type TimelineShow,
  type VendorMarks,
} from '../../data/session-display';
import { t } from '../../i18n';
import { Row, Section } from './ProjectSettingsScreen';

type DisplaySwitch = 'plan_bar' | 'reasoning' | 'context_usage';

/** What a session's page shows: its glyphs' motion, timeline, overview, bar, thread and composer. */
export function SessionDisplayPage() {
  const display = useSessionDisplay();
  const look = useLook();
  const off = () => t({ id: 'settings.sessionDisplay.off', defaultMessage: 'Off' });
  const stateMotion = t({
    id: 'settings.sessionDisplay.stateMotion',
    defaultMessage: 'Status animation',
  });
  const timeline = t({ id: 'settings.sessionDisplay.timeline', defaultMessage: 'Timeline' });
  const overview = t({
    id: 'settings.sessionDisplay.overview',
    defaultMessage: 'Overview card',
  });
  const toolCalls = t({ id: 'settings.sessionDisplay.toolCalls', defaultMessage: 'Tool calls' });
  const runningSend = t({
    id: 'settings.sessionDisplay.runningSend',
    defaultMessage: 'Messages sent while running',
  });
  const vendorMarks = t({
    id: 'settings.sessionDisplay.vendorMarks',
    defaultMessage: 'Vendor icons',
  });
  const toggle = (pref: DisplaySwitch, label: string, settingId: string) => (
    <Row label={label} settingId={settingId}>
      <input
        type="checkbox"
        className="ps-sw"
        aria-label={label}
        checked={display[pref]}
        onChange={(e) => setSessionDisplay({ [pref]: e.target.checked })}
      />
    </Row>
  );
  const choose =
    <K extends keyof SessionDisplay>(key: K) =>
    (value: SessionDisplay[K]) =>
      setSessionDisplay({ [key]: value });
  return (
    <Section>
      <div className="ps-rows">
        <Row label={stateMotion} settingId="sessionDisplay.stateMotion">
          <RadioGroup<StateMotion>
            className="seg"
            aria-label={stateMotion}
            value={display.state_motion}
            onValueChange={choose('state_motion')}
          >
            <Radio.Root value="all">
              {t({ id: 'settings.sessionDisplay.stateMotionAll', defaultMessage: 'All' })}
            </Radio.Root>
            <Radio.Root value="waiting">
              {t({
                id: 'settings.sessionDisplay.stateMotionWaiting',
                defaultMessage: 'Only waiting on you',
              })}
            </Radio.Root>
            <Radio.Root value="off">{off()}</Radio.Root>
          </RadioGroup>
        </Row>
        <Row label={timeline} settingId="sessionDisplay.timeline">
          <RadioGroup<TimelineShow>
            className="seg"
            aria-label={timeline}
            value={display.timeline}
            onValueChange={choose('timeline')}
          >
            <Radio.Root value="labels">
              {t({ id: 'settings.sessionDisplay.timelineLabels', defaultMessage: 'With labels' })}
            </Radio.Root>
            <Radio.Root value="marks">
              {t({ id: 'settings.sessionDisplay.timelineMarks', defaultMessage: 'Marks only' })}
            </Radio.Root>
            <Radio.Root value="off">{off()}</Radio.Root>
          </RadioGroup>
        </Row>
        <Row label={overview} settingId="sessionDisplay.overview">
          <RadioGroup<OverviewStart>
            className="seg"
            aria-label={overview}
            value={display.overview}
            onValueChange={choose('overview')}
          >
            <Radio.Root value="open">
              {t({ id: 'settings.sessionDisplay.overviewOpen', defaultMessage: 'Open' })}
            </Radio.Root>
            <Radio.Root value="folded">
              {t({
                id: 'settings.sessionDisplay.overviewFolded',
                defaultMessage: 'Folded to one line',
              })}
            </Radio.Root>
            <Radio.Root value="off">{off()}</Radio.Root>
          </RadioGroup>
        </Row>
        {toggle(
          'plan_bar',
          t({
            id: 'settings.sessionDisplay.planBar',
            defaultMessage: 'Plan progress in the session bar',
          }),
          'sessionDisplay.planBar',
        )}
        <Row label={toolCalls} settingId="sessionDisplay.toolCalls">
          <RadioGroup<Transcript>
            className="seg"
            aria-label={toolCalls}
            value={look.transcript}
            onValueChange={(transcript) => setLook({ transcript })}
          >
            <Radio.Root value="folded">
              {t({ id: 'settings.sessionDisplay.toolCallsFolded', defaultMessage: 'All folded' })}
            </Radio.Root>
            <Radio.Root value="open-failed">
              {t({
                id: 'settings.sessionDisplay.toolCallsOpenFailed',
                defaultMessage: 'Open when failed',
              })}
            </Radio.Root>
            <Radio.Root value="expanded">
              {t({ id: 'settings.sessionDisplay.toolCallsExpanded', defaultMessage: 'All open' })}
            </Radio.Root>
          </RadioGroup>
        </Row>
        <Row label={runningSend} settingId="sessionDisplay.runningSend">
          <RadioGroup<RunningSend>
            className="seg"
            aria-label={runningSend}
            value={display.running_send}
            onValueChange={choose('running_send')}
          >
            <Radio.Root value="queue">
              {t({ id: 'sessions.composer.queue', defaultMessage: 'Queue' })}
            </Radio.Root>
            <Radio.Root value="steer">
              {t({ id: 'sessions.composer.steer', defaultMessage: 'Steer' })}
            </Radio.Root>
          </RadioGroup>
        </Row>
        {toggle(
          'reasoning',
          t({ id: 'settings.sessionDisplay.reasoning', defaultMessage: 'Show reasoning' }),
          'sessionDisplay.reasoning',
        )}
        <Row label={vendorMarks} settingId="sessionDisplay.vendorMarks">
          <RadioGroup<VendorMarks>
            className="seg"
            aria-label={vendorMarks}
            value={display.vendor_marks}
            onValueChange={choose('vendor_marks')}
          >
            <Radio.Root value="brand">
              {t({
                id: 'settings.sessionDisplay.vendorMarksBrand',
                defaultMessage: 'Brand colours',
              })}
            </Radio.Root>
            <Radio.Root value="mono">
              {t({ id: 'settings.sessionDisplay.vendorMarksMono', defaultMessage: 'One colour' })}
            </Radio.Root>
          </RadioGroup>
        </Row>
        {toggle(
          'context_usage',
          t({
            id: 'settings.sessionDisplay.contextUsage',
            defaultMessage: 'Context and usage',
          }),
          'sessionDisplay.contextUsage',
        )}
      </div>
    </Section>
  );
}
