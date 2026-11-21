import { useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { ExternalSourceStatus } from '@pantheon/domain';
import type { BoardSnapshot } from '@pantheon/protocol';
import { setExternalMode, useExternalRead, type ExternalMode } from '../../data/external-requests';
import { ageText, useNow } from '../../data/needs-you';
import { clearGlobal, setGlobal, settingOf, useProjectDefaults } from '../../data/project-defaults';
import { t } from '../../i18n';
import { Overrides } from './Overrides';
import { failureText, Loading, Row, type Failure } from './ProjectSettingsScreen';
import './harness-page.css';
import './external-page.css';

type Project = BoardSnapshot['projects'][number];

const MINUTE = 60_000;
const SOURCE_NAME: Record<string, string> = { github: 'GitHub' };

/** The source's dot and what it says: when it last answered, or why it could not. */
function sourceStatus(source: ExternalSourceStatus, now: number) {
  if (source.error !== undefined) return { s: 'bad', text: source.error };
  if (source.polled_at === undefined)
    return {
      s: 'idle',
      text: t({ id: 'settings.external.neverChecked', defaultMessage: 'Not checked yet' }),
    };
  return {
    s: 'ok',
    text: t(
      { id: 'settings.external.checked', defaultMessage: 'Last checked {age}' },
      { age: ageText(source.polled_at, now) },
    ),
  };
}

export const MODE_LABEL: Record<ExternalMode, () => string> = {
  off: () => t({ id: 'settings.external.off', defaultMessage: 'Off' }),
  approve: () => t({ id: 'settings.external.ask', defaultMessage: 'Ask me first' }),
  auto: () => t({ id: 'settings.external.auto', defaultMessage: 'Start my own issues' }),
};
const modeRadios = () =>
  (Object.keys(MODE_LABEL) as ExternalMode[]).map((mode) => (
    <Radio.Root key={mode} value={mode}>
      {MODE_LABEL[mode]()}
    </Radio.Root>
  ));

/** How every project without a choice of its own takes requests from its sources. */
export function GlobalExternal() {
  const defaults = useProjectDefaults();
  const setting = settingOf(defaults.data, 'external_events');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const label = t({ id: 'settings.external.takeRequests', defaultMessage: 'How to take requests' });
  const save = async (mode: ExternalMode) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await setGlobal('external_events', mode);
    setBusy(false);
    if (!result.ok) setFailure(result.error);
  };
  return (
    <div className="ps-grp" data-setting-id="external.mode">
      <div className="ps-rows">
        <Row label={label}>
          <RadioGroup<ExternalMode>
            className="seg"
            aria-label={label}
            aria-busy={!setting || undefined}
            value={setting?.global ?? setting?.builtin ?? 'off'}
            disabled={busy || !setting}
            onValueChange={(mode) => void save(mode)}
          >
            {modeRadios()}
          </RadioGroup>
          <Overrides
            name={label}
            setting="external_events"
            valueText={(mode) => MODE_LABEL[mode]()}
            clearGlobal={
              setting?.global === undefined ? undefined : () => clearGlobal('external_events')
            }
            editor={(project) => <ExternalPage project={project} />}
          />
        </Row>
        {failure && (
          <div className="ps-err" role="alert">
            {failureText(failure)}
          </div>
        )}
      </div>
    </div>
  );
}

/** How the project takes requests from its sources. */
export function ExternalPage({ project }: { project: Project }) {
  // A source is asked about once a minute.
  const now = useNow(MINUTE);
  const read = useExternalRead(project, project.revision + Math.floor(now / MINUTE));
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);

  const send = async (command: () => ReturnType<typeof setExternalMode>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    const result = await command();
    inFlight.current = false;
    setSending(false);
    if (!result.ok) setFailure(result.error);
    read.reload();
  };

  if (read.data === null)
    return (
      <div className="xr-pg" data-setting-id="external.mode">
        {read.error !== null ? (
          <div className="ps-err" role="alert">
            {read.error}
          </div>
        ) : (
          <Loading />
        )}
      </div>
    );

  const modeLabel = (name: string) =>
    t(
      { id: 'settings.external.mode', defaultMessage: 'How to take requests from {source}' },
      { source: name },
    );
  return (
    <div className="xr-pg" data-setting-id="external.mode">
      <div className="ps-grp">
        {read.data.sources.map((source, index) => {
          const name = SOURCE_NAME[source.id] ?? source.id,
            status = sourceStatus(source, now);
          return (
            <div key={source.id} className="xr-src" role="group" aria-label={name}>
              <b>{name}</b>
              <span className="hp-st" role={status.s === 'bad' ? 'status' : undefined}>
                <span className="hp-dot" data-s={status.s} aria-hidden="true" />
                <span className="xr-cut">{status.text}</span>
              </span>
              {index === 0 && (
                <RadioGroup<ExternalMode>
                  className="seg"
                  aria-label={modeLabel(name)}
                  value={read.data!.mode ?? 'off'}
                  disabled={sending}
                  onValueChange={(mode) => void send(() => setExternalMode(project, mode))}
                >
                  {modeRadios()}
                </RadioGroup>
              )}
            </div>
          );
        })}
      </div>
      {failure && (
        <div className="ps-err" role="alert">
          {failureText(failure)}
        </div>
      )}
    </div>
  );
}
