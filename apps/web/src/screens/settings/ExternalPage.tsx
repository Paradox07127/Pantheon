import { useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { CircleDot, GitPullRequest, Inbox, MessageSquare } from 'lucide-react';
import type { ExternalEvent, ExternalSourceStatus } from '@pantheon/domain';
import type { BoardSnapshot } from '@pantheon/protocol';
import { EmptyState } from '../../components/EmptyState';
import { useBoard } from '../../data/board';
import {
  approveExternal,
  setExternalMode,
  useExternalRead,
  type ExternalMode,
} from '../../data/external-requests';
import { ageText, useNow } from '../../data/needs-you';
import { clearGlobal, setGlobal, settingOf, useProjectDefaults } from '../../data/project-defaults';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { Overrides } from './Overrides';
import { failureText, Loading, Row, type Failure } from './ProjectSettingsScreen';
import { useSettingsView } from './view';
import './harness-page.css';
import './external-page.css';

type Project = BoardSnapshot['projects'][number];
type Session = BoardSnapshot['sessions'][number];

const MINUTE = 60_000;
const SOURCE_NAME: Record<string, string> = { github: 'GitHub' };
const KIND_ICON: Record<string, typeof CircleDot> = {
  review_requested: GitPullRequest,
  mention: MessageSquare,
};

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

/** How the project takes requests from its sources, and the requests it received with what became of each. */
export function ExternalPage({ project }: { project: Project }) {
  const board = useBoard((s) => s.board);
  const sessions = (board?.sessions ?? []).filter((s) => s.project_id === project.id);
  // A source is asked about once a minute; a lead that opens or is approved changes its revision.
  const now = useNow(MINUTE);
  const read = useExternalRead(
    project,
    project.revision +
      Math.floor(now / MINUTE) +
      sessions.reduce((sum, s) => sum + (s.external_subject ? s.revision : 0), 0),
  );
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);

  const send = async (command: () => ReturnType<typeof approveExternal>) => {
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

  /** What became of the request: not taken, waiting, or the lead that has it. */
  const outcome = (event: ExternalEvent, session: Session | undefined, first: boolean) => {
    const plain = (s: string, text: string) => (
      <span className="xr-out">
        <span className="hp-dot" data-s={s} aria-hidden="true" />
        <span className="xr-cut" title={text}>
          {text}
        </span>
      </span>
    );
    if (event.state === 'dropped')
      return plain(
        'idle',
        event.actor_trust === 'bot'
          ? t({ id: 'settings.external.droppedBot', defaultMessage: 'Not taken: a bot' })
          : t({
              id: 'settings.external.droppedOther',
              defaultMessage: 'Not taken: no write access',
            }),
      );
    if (event.state === 'failed') return plain('bad', event.error!);
    if (event.state === 'pending')
      return plain(
        'idle',
        t({ id: 'settings.external.settling', defaultMessage: 'Waiting for follow-ups' }),
      );
    if (!session)
      return plain(
        'idle',
        t({ id: 'settings.permissions.sessionGone', defaultMessage: 'Deleted session' }),
      );
    if (session.external_hold)
      return (
        <span className="xr-out">
          <span className="hp-dot" data-s="wait" aria-hidden="true" />
          <span className="xr-cut">
            {t({ id: 'settings.external.held', defaultMessage: 'Waiting for your approval' })}
          </span>
          {first && (
            <button
              type="button"
              className="btn sm"
              disabled={sending}
              aria-label={t(
                { id: 'settings.external.approveNamed', defaultMessage: 'Approve: {title}' },
                { title: event.title },
              )}
              onClick={() => void send(() => approveExternal(session.id))}
            >
              {t({ id: 'settings.external.approve', defaultMessage: 'Approve' })}
            </button>
          )}
        </span>
      );
    return (
      <button
        type="button"
        className="xr-out"
        onClick={() => {
          useSettingsView.getState().close();
          useShell.getState().openProjectSession(project.id, session.id);
        }}
      >
        <span
          className="hp-dot"
          data-s={session.state === 'running' ? 'run' : 'ok'}
          aria-hidden="true"
        />
        <span className="xr-cut">
          {session.state === 'running'
            ? t({ id: 'settings.external.working', defaultMessage: 'The lead is working' })
            : t({ id: 'settings.external.handed', defaultMessage: 'Handed to the lead' })}
        </span>
      </button>
    );
  };

  const modeLabel = (name: string) =>
    t(
      { id: 'settings.external.mode', defaultMessage: 'How to take requests from {source}' },
      { source: name },
    );
  // The approve button sits on the newest request of each held lead.
  const shown = new Set<string>();
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
      {read.data.events.length === 0 ? (
        <EmptyState
          graphic={<Inbox aria-hidden="true" />}
          title={t({
            id: 'settings.external.empty',
            defaultMessage: 'This project has received no request yet',
          })}
        />
      ) : (
        <div
          className="ps-grp"
          role="list"
          aria-label={t({ id: 'settings.external.requests', defaultMessage: 'Requests received' })}
        >
          <div className="xr-row xr-hd">
            <span className="cap">
              {t({ id: 'settings.external.request', defaultMessage: 'Request' })}
            </span>
            <span className="cap">
              {t({ id: 'settings.external.raisedBy', defaultMessage: 'Raised by' })}
            </span>
            <span className="cap">
              {t({ id: 'settings.external.outcome', defaultMessage: 'Outcome' })}
            </span>
            <span />
          </div>
          {read.data.events.map((event) => {
            const Icon = KIND_ICON[event.kind] ?? CircleDot;
            const session = sessions.find((s) => s.id === event.session_id);
            const first = event.session_id !== undefined && !shown.has(event.session_id);
            if (event.session_id !== undefined) shown.add(event.session_id);
            return (
              <div
                key={event.id}
                className="xr-row"
                role="listitem"
                data-dropped={event.state === 'dropped' || undefined}
              >
                <span className="xr-title">
                  <Icon className="ic-sm" aria-hidden="true" />
                  <span className="xr-cut" title={event.title}>
                    {event.title}
                  </span>
                </span>
                <span className="xr-cut xr-who">{event.actor}</span>
                {outcome(event, session, first)}
                <span className="mu xr-at">{ageText(event.received_at, now)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
