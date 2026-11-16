import type { ReactNode } from 'react';
import { Check, Mic, RefreshCw, X } from 'lucide-react';
import { VOICE_BARS, voiceClock, voiceLevel, type VoiceState } from '../../data/voice';
import { t } from '../../i18n';
import './voice.css';

/** A bar from 4px for no sound to 20px for a full level, in 2px steps. */
const barHeight = (value: number) => `${4 + 2 * Math.round(voiceLevel(value) * 8)}px`;

const Dots = () => (
  <span className="vc-ell" aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

/** An icon button as an element of the row, so the row stays one tree of plain elements. */
function iconButton(props: { label: string; icon: ReactNode; ink?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={props.ink ? 'vc-done' : 'ib'}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.icon}
    </button>
  );
}

/** The row that stands in for the composer's tools while voice input records, transcribes or cannot go on. */
export function VoiceBar(props: {
  state: VoiceState;
  /** Preparing has lasted long enough to name it. */
  slow: boolean;
  now: number;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const { state } = props;
  const x = <X aria-hidden="true" />;
  const close = iconButton({
    label: t({ id: 'sessions.voice.close', defaultMessage: 'Close voice input' }),
    icon: x,
    onClick: props.onCancel,
  });
  const clock = (ms: number, quiet = false) => (
    <span className="vc-clk" data-quiet={quiet || undefined}>
      {voiceClock(ms)}
    </span>
  );
  const recorded =
    state.startedAt !== null && state.endedAt !== null ? state.endedAt - state.startedAt : null;
  let status: ReactNode = null;
  let actions: ReactNode = null;
  switch (state.phase) {
    case 'idle':
      return null;
    case 'preparing':
      status = props.slow && (
        <span className="vc-tx" data-quiet role="status">
          {t({
            id: 'sessions.voice.preparing',
            defaultMessage: 'Preparing the recognition model',
          })}
          <Dots />
        </span>
      );
      actions = iconButton({
        label: t({ id: 'sessions.voice.cancelPreparing', defaultMessage: 'Cancel voice input' }),
        icon: x,
        onClick: props.onCancel,
      });
      break;
    case 'listening':
    case 'silent': {
      const silent = state.phase === 'silent';
      const silentText = t({ id: 'sessions.voice.silent', defaultMessage: 'No sound heard' });
      const label = silent
        ? silentText
        : t({
            id: 'sessions.voice.level',
            defaultMessage: 'Microphone level, newest on the right',
          });
      const bars = Array<number>(VOICE_BARS - state.levels.length)
        .fill(0)
        .concat(state.levels);
      status = (
        <>
          <span className="vc-vu" data-flat={silent} role="img" aria-label={label}>
            {bars.map((value, i) => (
              <i key={i} style={{ height: barHeight(value) }} />
            ))}
          </span>
          <span className="vc-vl" role="img" aria-label={label}>
            <i
              style={{ transform: `scaleX(${silent ? 0 : voiceLevel(state.levels.at(-1) ?? 0)})` }}
            />
          </span>
          {clock(props.now - (state.startedAt ?? props.now))}
          {silent && (
            <span className="vc-tx" data-quiet role="status">
              {silentText}
            </span>
          )}
        </>
      );
      actions = (
        <>
          {iconButton({
            label: t({ id: 'sessions.voice.cancelRecording', defaultMessage: 'Cancel recording' }),
            icon: x,
            onClick: props.onCancel,
          })}
          {iconButton({
            label: t({ id: 'sessions.voice.finish', defaultMessage: 'Finish recording' }),
            icon: <Check aria-hidden="true" />,
            ink: true,
            onClick: props.onStop,
          })}
        </>
      );
      break;
    }
    case 'transcribing':
      status = (
        <>
          <span className="vc-tx" data-quiet role="status">
            {t({ id: 'sessions.voice.transcribing', defaultMessage: 'Transcribing' })}
            <Dots />
          </span>
          {recorded !== null && clock(recorded, true)}
        </>
      );
      actions = iconButton({
        label: t({
          id: 'sessions.voice.cancelTranscribing',
          defaultMessage: 'Cancel transcription',
        }),
        icon: x,
        onClick: props.onCancel,
      });
      break;
    case 'denied':
      status = (
        <>
          <Mic className="vc-ic" aria-hidden="true" />
          {state.settingsError !== null ? (
            <span className="vc-tx vc-err" role="alert">
              {state.settingsError}
            </span>
          ) : (
            <span className="vc-tx" role="status">
              {state.denied === 'speech'
                ? t({
                    id: 'sessions.voice.speechDenied',
                    defaultMessage:
                      'No speech recognition permission; turn it on in System Settings',
                  })
                : t({
                    id: 'sessions.voice.microphoneDenied',
                    defaultMessage: 'No microphone permission; turn it on in System Settings',
                  })}
            </span>
          )}
        </>
      );
      actions = (
        <>
          {close}
          <button type="button" className="btn" onClick={props.onOpenSettings}>
            {t({ id: 'sessions.voice.openSettings', defaultMessage: 'Open System Settings' })}
          </button>
        </>
      );
      break;
    case 'failed':
      status = (
        <>
          <span className="vc-dot" aria-hidden="true" />
          <span className="vc-tx" role="status">
            {state.startedAt === null
              ? t({ id: 'sessions.voice.startFailed', defaultMessage: 'Voice input did not start' })
              : t({
                  id: 'sessions.voice.failed',
                  defaultMessage: 'Transcription failed; the recording is kept',
                })}
          </span>
          {recorded !== null && clock(recorded, true)}
        </>
      );
      actions = (
        <>
          {state.startedAt === null
            ? close
            : iconButton({
                label: t({
                  id: 'sessions.voice.discard',
                  defaultMessage: 'Discard this recording',
                }),
                icon: x,
                onClick: props.onCancel,
              })}
          <button type="button" className="btn" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t({ id: 'sessions.voice.retry', defaultMessage: 'Retry' })}
          </button>
        </>
      );
      break;
    case 'unavailable':
      status = (
        <>
          <Mic className="vc-ic" aria-hidden="true" />
          <span className="vc-tx" role="status">
            {t({
              id: 'sessions.voice.unavailable',
              defaultMessage: 'Speech recognition is not available on this computer',
            })}
          </span>
        </>
      );
      actions = close;
      break;
  }
  return (
    <div className="vc-bar">
      <div className="vc-st">{status}</div>
      {actions}
    </div>
  );
}
