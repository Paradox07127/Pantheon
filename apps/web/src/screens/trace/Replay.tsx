import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Pause, Play } from 'lucide-react';
import type { ProjectTrace } from '@pantheon/protocol';
import { t } from '../../i18n';
import { reducedMotion } from '../../lib/motion';
import {
  keyText,
  shortcutKeys,
  shortcutMatches,
  useShortcutOverrides,
  type ShortcutId,
} from '../../lib/shortcuts';
import { whenText } from '../board/panels-model';
import {
  replayStep,
  type ReplaySpeed,
  type traceAxis,
  type TraceTurn,
  type TraceWindow,
} from './model';
import './replay.css';

type Axis = ReturnType<typeof traceAxis>;

const SPEEDS: ReplaySpeed[] = [1, 4, 16];
/** Scrubber steps across the axis. */
export const SCRUB_MAX = 1000;

// The replay keys answer everywhere except where they type, press, select or move a control.
const KEY_OWNERS =
  'input, textarea, select, button, [contenteditable], [role="radio"], [role="slider"], [role="listbox"]';

/** A step on the scrubber: a turn's start and how the turn went. */
export interface ReplayMark {
  at: number;
  state: TraceTurn['status'];
}

/** The turns starting in the view, of the lane when it is in the view, else of every lane; by time. */
export function replayMarks(
  trace: ProjectTrace,
  view: TraceWindow,
  laneKey: string | null,
): { marks: ReplayMark[]; ofLane: boolean } {
  const lane = trace.lanes.find((row) => row.lane.key === laneKey);
  const marks = (lane ? [lane] : trace.lanes)
    .flatMap((row) => row.turns)
    .flatMap((turn) =>
      turn.start !== null && turn.start >= view.from && turn.start <= view.to
        ? [{ at: turn.start, state: turn.status }]
        : [],
    )
    .sort((a, b) => a.at - b.at);
  return { marks, ofLane: !!lane };
}

/** Runs the replay keys anywhere in the window but on a field or another control. */
export function useReplayKeys(onStep: (delta: 1 | -1) => void, onToggle: () => void) {
  const latest = useRef({ onStep, onToggle });
  latest.current = { onStep, onToggle };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target as Element | null)?.closest?.(KEY_OWNERS)) return;
      if (shortcutMatches('replay-play', e)) {
        if (!e.repeat) latest.current.onToggle();
      } else if (shortcutMatches('replay-back', e)) latest.current.onStep(-1);
      else if (shortcutMatches('replay-forward', e)) latest.current.onStep(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

const positionText = (time: number, steps: readonly number[], to: number) => {
  const when = whenText(time, to);
  if (steps.length === 0) return when;
  return t(
    {
      id: 'trace.replay.positionStep',
      defaultMessage:
        '{n, plural, =0 {Before step 1 of {total}} other {Step # of {total}}}, {time}',
    },
    { n: steps.filter((at) => at <= time).length, total: steps.length, time: when },
  );
};

export interface TraceReplay {
  /** The playhead's share of the lanes' axis; null at now. */
  share: number | null;
  /** The playhead's time; null at now. */
  time: number | null;
  playing: boolean;
  toggle: () => void;
  /** To a scrubber value; its end returns to now. */
  seek: (value: number) => void;
  /** To the step before or after the playhead; past the last step returns to now. */
  step: (delta: 1 | -1) => void;
  /** Moves the knob alone to a share, or back to the playhead's on null. */
  preview: (share: number | null) => void;
  now: () => void;
  /** The steps' times, for the scrubber's text. */
  steps: readonly number[];
  scrub: RefObject<HTMLDivElement | null>;
  thumb: RefObject<HTMLSpanElement | null>;
  fill: RefObject<HTMLElement | null>;
  at: RefObject<HTMLSpanElement | null>;
}

/**
 * Plays the view from its start to its end. A playing frame writes the playhead to `--ph` and
 * `--ph-strip` on the host and to the bar's scrubber and time, without rendering.
 */
export function useTraceReplay(
  axis: Axis,
  view: TraceWindow,
  full: TraceWindow,
  host: RefObject<HTMLElement | null>,
  speed: ReplaySpeed,
  steps: readonly number[],
): TraceReplay {
  // The playhead is held as a time, so a refreshed axis moves its share and not its time.
  const [state, setState] = useState<{ time: number | null; playing: boolean }>({
    time: null,
    playing: false,
  });
  // Where a playing frame left the playhead; equal to state.time while paused.
  const live = useRef<number | null>(null);
  const scrub = useRef<HTMLDivElement | null>(null);
  const thumb = useRef<HTMLSpanElement | null>(null);
  const fill = useRef<HTMLElement | null>(null);
  const at = useRef<HTMLSpanElement | null>(null);
  const shape = useRef({ axis, full, steps });
  shape.current = { axis, full, steps };

  const preview = useCallback((share: number | null) => {
    const shown = share ?? (live.current === null ? 1 : shape.current.axis.position(live.current));
    if (thumb.current) thumb.current.style.transform = `translateX(${shown * 100}%)`;
    if (fill.current) fill.current.style.transform = `scaleX(${shown})`;
  }, []);

  const paint = useCallback(
    (time: number, bar: boolean) => {
      const el = host.current;
      if (!el) return;
      const { axis, full, steps } = shape.current;
      const share = axis.position(time);
      el.style.setProperty('--ph', String(share));
      el.style.setProperty(
        '--ph-strip',
        String((time - full.from) / Math.max(1, full.to - full.from)),
      );
      if (!bar) return;
      preview(share);
      if (scrub.current) {
        scrub.current.setAttribute('aria-valuenow', String(Math.round(share * SCRUB_MAX)));
        scrub.current.setAttribute('aria-valuetext', positionText(time, steps, full.to));
      }
      if (at.current) at.current.textContent = whenText(time, full.to);
    },
    [host, preview],
  );

  const toggle = useCallback(
    () =>
      setState((s) => {
        if (s.playing) return { playing: false, time: live.current };
        live.current = s.time ?? shape.current.axis.time(0);
        return { playing: true, time: live.current };
      }),
    [],
  );
  const seek = useCallback((value: number) => {
    const time =
      value >= SCRUB_MAX ? null : shape.current.axis.time(Math.max(0, value / SCRUB_MAX));
    live.current = time;
    setState({ time, playing: false });
  }, []);
  const now = useCallback(() => {
    live.current = null;
    setState({ time: null, playing: false });
  }, []);
  const step = useCallback((delta: 1 | -1) => {
    const { axis, steps } = shape.current;
    const from = live.current ?? axis.time(1);
    const to = delta > 0 ? steps.find((s) => s > from) : steps.findLast((s) => s < from);
    if (to === undefined && delta < 0) return;
    live.current = to ?? null;
    setState({ time: to ?? null, playing: false });
  }, []);

  useEffect(() => {
    if (!state.playing) return;
    // Under reduced motion the playhead waits on each step instead of sliding between them.
    const reduced = reducedMotion();
    let last: number | null = null;
    const tick = (t: number) => {
      const { axis, steps } = shape.current;
      const share = live.current === null ? 0 : axis.position(live.current);
      const next = replayStep(share, last === null ? 0 : t - last, speed);
      last = t;
      if (next === null) {
        live.current = null;
        setState({ time: null, playing: false });
        return;
      }
      live.current = axis.time(next);
      const shown = reduced
        ? (steps.findLast((s) => s <= live.current!) ?? axis.time(0))
        : live.current;
      paint(shown, true);
      frame = requestAnimationFrame(tick);
    };
    let frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state.playing, speed, paint]);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    if (state.time === null) {
      el.removeAttribute('data-replay');
      el.style.removeProperty('--ph');
      el.style.removeProperty('--ph-strip');
      return;
    }
    el.setAttribute('data-replay', '');
    paint(live.current ?? state.time, false);
  }, [state.time, axis, full, host, paint]);

  // A window read up to now ends later on every refresh; only a zoomed view's end is the user's.
  const zoomedTo = view.to === full.to ? null : view.to;
  useEffect(() => {
    live.current = null;
    setState((s) => (s.time === null && !s.playing ? s : { time: null, playing: false }));
  }, [view.from, zoomedTo, full.from]);

  useEffect(() => {
    const el = host.current;
    return () => {
      el?.removeAttribute('data-replay');
      el?.style.removeProperty('--ph');
      el?.style.removeProperty('--ph-strip');
    };
  }, [host]);

  useReplayKeys(step, toggle);

  return {
    share: state.time === null ? null : axis.position(state.time),
    time: state.time,
    playing: state.playing,
    toggle,
    seek,
    step,
    preview,
    now,
    steps,
    scrub,
    thumb,
    fill,
    at,
  };
}

/** The replay speed, one value for the timeline's bar and a session's step replay. */
export function ReplaySpeedControl({
  speed,
  onSpeed,
}: {
  speed: ReplaySpeed;
  onSpeed: (speed: ReplaySpeed) => void;
}) {
  return (
    <RadioGroup<ReplaySpeed>
      className="tb-seg"
      aria-label={t({ id: 'trace.replay.speed', defaultMessage: 'Replay speed' })}
      value={speed}
      onValueChange={(value) => onSpeed(value)}
    >
      {SPEEDS.map((value) => (
        <Radio.Root
          key={value}
          value={value}
          aria-label={t(
            { id: 'trace.replay.speedOption', defaultMessage: '{speed}x speed' },
            { speed: value },
          )}
        >
          {value}x
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

const KEY_GROUPS: ShortcutId[][] = [['replay-back', 'replay-forward'], ['replay-play']];

/** The replay keys as key caps, as the user set them. */
export function ReplayKeys() {
  useShortcutOverrides();
  return KEY_GROUPS.map((ids) => (
    <span key={ids[0]} className="rpb-keys" aria-hidden="true">
      {ids.map((id) => {
        const keys = shortcutKeys(id);
        return (
          keys && (
            <span key={id} className="kbd">
              {keyText(keys)}
            </span>
          )
        );
      })}
    </span>
  ));
}

const shareAt = (x: number, box: { left: number; width: number }) =>
  Math.min(1, Math.max(0, (x - box.left) / Math.max(1, box.width)));

/** Play, scrub, the replay keys and the way back to now over the lanes' view. */
export function ReplayBar({
  replay,
  axis,
  view,
  full,
  marks,
  live,
  end,
}: {
  replay: TraceReplay;
  axis: Axis;
  view: TraceWindow;
  full: TraceWindow;
  /** Drawn on the scrubber, coloured by their state; none leaves a bare track. */
  marks: readonly { at: number; state: string }[];
  /** The time text at now; the view's end without it. */
  live?: string;
  /** Follows the time in place of the replay keys and the way back to now. */
  end?: ReactNode;
}) {
  const time = replay.time ?? view.to;
  const share = replay.share ?? 1;
  // Set from the pointer down to its release; only the knob moves meanwhile.
  const drag = useRef<{ box: { left: number; width: number }; share: number } | null>(null);
  return (
    <div
      className="trc-bar"
      role="toolbar"
      aria-label={t({ id: 'trace.replay.bar', defaultMessage: 'Replay' })}
    >
      <button
        type="button"
        className="ib"
        aria-label={
          replay.playing
            ? t({ id: 'trace.replay.pause', defaultMessage: 'Pause' })
            : t({ id: 'trace.replay.play', defaultMessage: 'Play' })
        }
        aria-keyshortcuts={shortcutKeys('replay-play') || undefined}
        onClick={replay.toggle}
      >
        {replay.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <div
        ref={replay.scrub}
        className="rpb-scrub"
        role="slider"
        tabIndex={0}
        aria-label={t({ id: 'trace.replay.position', defaultMessage: 'Replay position' })}
        aria-valuemin={0}
        aria-valuemax={SCRUB_MAX}
        aria-valuenow={Math.round(share * SCRUB_MAX)}
        aria-valuetext={positionText(time, replay.steps, full.to)}
        onKeyDown={(e) => {
          if (shortcutMatches('replay-back', e) || e.key === 'ArrowDown') replay.step(-1);
          else if (shortcutMatches('replay-forward', e) || e.key === 'ArrowUp') replay.step(1);
          else if (shortcutMatches('replay-play', e)) {
            if (!e.repeat) replay.toggle();
          } else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const box = e.currentTarget.getBoundingClientRect();
          e.currentTarget.setPointerCapture(e.pointerId);
          if (replay.playing) replay.toggle();
          drag.current = { box, share: shareAt(e.clientX, box) };
          replay.preview(drag.current.share);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          drag.current.share = shareAt(e.clientX, drag.current.box);
          replay.preview(drag.current.share);
        }}
        onPointerUp={() => {
          if (!drag.current) return;
          const value = Math.round(drag.current.share * SCRUB_MAX);
          drag.current = null;
          replay.seek(value);
        }}
        onPointerCancel={() => {
          drag.current = null;
          replay.preview(null);
        }}
      >
        <i ref={replay.fill} className="rpb-fill" style={{ transform: `scaleX(${share})` }} />
        {marks.map((mark, i) => (
          <i
            key={`${mark.at}-${i}`}
            className="rpb-mk"
            data-state={mark.state}
            style={{ left: `${axis.position(mark.at) * 100}%` }}
          />
        ))}
        <span
          ref={replay.thumb}
          className="rpb-th"
          style={{ transform: `translateX(${share * 100}%)` }}
        >
          <i />
        </span>
      </div>
      <span ref={replay.at} className="trc-at" aria-hidden="true">
        {replay.time === null && live !== undefined ? live : whenText(time, full.to)}
      </span>
      {end ?? (
        <>
          <ReplayKeys />
          <button
            type="button"
            className="btn"
            aria-label={t({ id: 'trace.replay.now', defaultMessage: 'Back to now' })}
            disabled={replay.share === null}
            onClick={replay.now}
          >
            {t({ id: 'trace.replay.now', defaultMessage: 'Back to now' })}
          </button>
        </>
      )}
    </div>
  );
}
