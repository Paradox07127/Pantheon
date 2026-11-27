import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Tabs } from '@base-ui/react/tabs';
import { ArrowLeft, Check, ChevronRight, ClipboardList, ListFilter, Play, X } from 'lucide-react';
import { DiffCounts } from '../../components/DiffCounts';
import { ReadStatus } from '../../components/ReadStatus';
import { SessionStateIcon, sessionStateLabel } from '../../components/SessionStateIcon';
import { Skeleton as Placeholder } from '../../components/Skeleton';
import { TopBar } from '../../components/TopBar';
import type { TraceTimeEvidence } from '@pantheon/domain';
import type {
  ProjectHeatmap,
  ProjectTimeline,
  ProjectTrace,
  TraceStats,
  WorkbenchSession,
} from '@pantheon/protocol';
import { useEventHistory } from '../../data/logs';
import {
  laneWallMs,
  stateIntervals,
  useProjectCollab,
  useProjectHeatmap,
  useProjectTimeline,
  useProjectTrace,
  useSessionTrace,
  useTraceTime,
  useTurnSteps,
  waitingMs,
  type StateInterval,
} from '../../data/trace';
import { runCommand } from '../../data/commands';
import { useDecisionsToday } from '../../data/decisions-for-user';
import { reasonText, useNow } from '../../data/needs-you';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { listedTitle } from '../../lib/daemon-text';
import { listText } from '../../lib/list-text';
import { useShortcut } from '../../lib/shortcuts';
import { useDelayed } from '../../lib/use-delayed';
import { SCREEN_NAMES } from '../../screens';
import { BREAK_SHARE } from '../../lib/time-axis';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { Empty, useSize } from '../../components/ChartParts';
import { dayText, durationText } from '../../lib/time-text';

import { runtimeName } from '../../components/RuntimeGlyph';
import { tokenText } from '../../lib/number-text';
import { ActivityList, eventText, eventTone, KIND_TEXT } from './ActivityList';
import {
  dayLabel,
  dayName,
  dayOf,
  dayWindow,
  eventWindow,
  firstError,
  heatCells,
  hourCells,
  hourWindow,
  laneAnalysis,
  laneStats,
  MIN_VIEW_MS,
  panWindow,
  presetWindow,
  replayTotals,
  ROW_HEIGHT,
  keepTraceEvent,
  namedLanes,
  sessionPurposes,
  subagentName,
  stripBars,
  traceAxis,
  traceEvents,
  traceRows,
  TRACE_EVENT_KINDS,
  turnSpan,
  turnWindow,
  visibleWindow,
  windowLanes,
  zoomWindow,
  type TraceEvent,
  type TraceEventKind,
  type ReplayMode,
  type ReplaySpeed,
  type TracePreset,
  type TraceRow,
  type TraceSpan,
  type TraceSteps,
  type TraceSubagent,
  type TraceTurn,
  type TraceWindow,
} from './model';
import { useShell, type TraceTab } from '../../store';
import { RunsView } from '../runtime/RuntimeScreen';
import {
  ReplayBar,
  replayMarks,
  ReplayModeControl,
  ReplaySpeedControl,
  useTraceReplay,
  type ReplayMark,
  type ReplayTick,
} from './Replay';
import { StepReplay } from './StepReplay';
import { AnalyzeMenu } from './AnalyzeMenu';
import { ApprovedForYou } from './ApprovedForYou';
import { WorkflowPath } from './WorkflowPath';
import { type ReviewRange, StatusReview } from './StatusReview';
import { RuntimePanel } from './RuntimeDiagnostics';
import { TraceTimeChart } from './TraceTimeChart';
import { EventTable } from './EventTable';
import { eventClock, LaneLegend, LaneOverlay } from './LaneOverlay';
import './trace.css';
import './trace-bar.css';

/** Tallest activity bar, px. */
const STRIP_HEIGHT = 40;
/** Pointer travel, px, below which a press on the strip selects nothing. */
const DRAG_MIN_PX = 3;
/** Activity bucket of a one-day window. */
const DAY_BUCKET_MS = 900_000;
/** Below this screen width the session analysis lies over the lanes. */
const SIDE_MIN_PX = 1000;
/** Width of a heatmap day cell plus its gap, px. */
const HEAT_CELL_PX = 20;
/** How often the windows that run up to now move on without new events. */
const CLOCK_MS = 60_000;

// Labels are getters, so each is read in the language loaded by then.
const STATUS_TEXT: Record<TraceTurn['status'], string> = {
  get ok() {
    return t({ id: 'trace.turnStatus.ok', defaultMessage: 'Done' });
  },
  get error() {
    return t({ id: 'trace.turnStatus.error', defaultMessage: 'Error' });
  },
  get running() {
    return t({ id: 'trace.turnStatus.running', defaultMessage: 'Running' });
  },
  get unknown() {
    return t({ id: 'trace.turnStatus.unknown', defaultMessage: 'Unknown' });
  },
};
type StepKind = Exclude<TraceSpan['kind'], 'turn'>;
const STEP_TEXT = {
  get llm() {
    return t({ id: 'trace.step.llm', defaultMessage: 'Model' });
  },
  get compact() {
    return t({ id: 'trace.step.compact', defaultMessage: 'Compaction' });
  },
} as const;
/** Step kinds by the segment colour they borrow. */
const STEP_COLOR: Record<StepKind, string> = {
  llm: 'llm',
  tool: 'tool',
  subagent: 'subagent',
  compact: 'wait',
};
/** What a lane draws a session state as; a terminal state takes no time and draws nothing. */
type LaneState = 'run' | 'wait' | 'review' | 'merge' | 'idle' | 'queue';
const LANE_STATE: Record<StateInterval['state'], LaneState | null> = {
  starting: 'run',
  running: 'run',
  waiting: 'wait',
  ready: 'review',
  merging: 'merge',
  merged: 'merge',
  idle: 'idle',
  queued: 'queue',
  discarded: null,
  failed: null,
};
const LANE_STATE_TEXT: Record<LaneState, string> = {
  get run() {
    return t({ id: 'trace.laneState.run', defaultMessage: 'Working' });
  },
  get wait() {
    return t({ id: 'trace.laneState.wait', defaultMessage: 'Waiting on you' });
  },
  get review() {
    return t({ id: 'trace.laneState.review', defaultMessage: 'Ready for review' });
  },
  get merge() {
    return t({ id: 'trace.laneState.merge', defaultMessage: 'Merging' });
  },
  get idle() {
    return t({ id: 'trace.laneState.idle', defaultMessage: 'Idle' });
  },
  get queue() {
    return t({ id: 'trace.laneState.queue', defaultMessage: 'Queued' });
  },
};
type SegmentKind = TraceTurn['segments'][number]['kind'];
/** What a session row's now column calls the turn segment under the playhead. */
const DOING_TEXT: Record<SegmentKind, string> = {
  get llm() {
    return STEP_TEXT.llm;
  },
  get tool() {
    return t({ id: 'trace.now.tool', defaultMessage: 'Tool' });
  },
  get subagent() {
    return t({ id: 'trace.now.subagent', defaultMessage: 'Subagent' });
  },
  get wait() {
    return LANE_STATE_TEXT.wait;
  },
  get error() {
    return STATUS_TEXT.error;
  },
};
/** Sessions whose title the lanes grey out. */
const ENDED: readonly WorkbenchSession['state'][] = ['done', 'merged', 'discarded'];
/** Moments the lanes' head names, from the view's start to its end. */
const TICKS = 6;
const SHARES = Array.from({ length: TICKS }, (_, i) => i / (TICKS - 1));

/** The head's moments to the minute, or to the second when two neighbours share a minute; a repeat stays blank. */
function tickTexts(times: readonly number[], end: number): string[] {
  const minutes = times.map((time) => dayText(time, end, { time: true }));
  const texts = minutes.some((text, i) => text === minutes[i - 1])
    ? times.map((time) => eventClock(time, end))
    : minutes;
  return texts.map((text, i) => (text === texts[i - 1] ? '' : text));
}
/** Wheel deltaY beyond this zooms no faster. */
const WHEEL_MAX = 100;
const ZOOM_RATE = 0.01;

const TABS: { tab: TraceTab; label: string }[] = [
  {
    tab: 'timeline',
    get label() {
      return t({ id: 'trace.tab.timeline', defaultMessage: 'Timeline' });
    },
  },
  {
    tab: 'runs',
    get label() {
      return t({ id: 'trace.tab.runs', defaultMessage: 'Runs' });
    },
  },
  {
    tab: 'activity',
    get label() {
      return t({ id: 'trace.tab.activity', defaultMessage: 'Activity' });
    },
  },
  {
    tab: 'diagnose',
    get label() {
      return t({ id: 'trace.tab.diagnose', defaultMessage: 'Diagnose' });
    },
  },
  {
    tab: 'approved',
    get label() {
      return t({ id: 'trace.tab.approved', defaultMessage: 'Decided for you' });
    },
  },
  {
    tab: 'workflow',
    get label() {
      return t({ id: 'trace.tab.workflow', defaultMessage: 'Workflow' });
    },
  },
];
type Mode = 'timeline' | 'heatmap';
type HeatDays = '7' | '30' | '90';
type HeatBy = 'session' | 'hour';
const MODES: { mode: Mode; label: string }[] = [
  {
    mode: 'timeline',
    get label() {
      return t({ id: 'trace.mode.timeline', defaultMessage: 'Timeline' });
    },
  },
  {
    mode: 'heatmap',
    get label() {
      return t({ id: 'trace.mode.heatmap', defaultMessage: 'Heatmap' });
    },
  },
];
const HEAT_RANGES: HeatDays[] = ['7', '30', '90'];
/** Heatmap days whose commits cover a preset window. */
const COMMIT_DAYS: Record<TracePreset, HeatDays> = {
  '1h': '7',
  '24h': '7',
  '7d': '7',
  '30d': '30',
};
const HEAT_BYS: { by: HeatBy; label: string }[] = [
  {
    by: 'session',
    get label() {
      return t({ id: 'trace.heatBy.session', defaultMessage: 'Session' });
    },
  },
  {
    by: 'hour',
    get label() {
      return t({ id: 'trace.heatBy.hour', defaultMessage: 'Hour' });
    },
  },
];
/** Hours whose row writes its hour. */
const HOUR_MARKS = new Set([0, 6, 12, 18]);
const PRESETS: { preset: TracePreset; label: string }[] = [
  {
    preset: '1h',
    get label() {
      return t({ id: 'trace.preset.hour', defaultMessage: '1 hour' });
    },
  },
  {
    preset: '24h',
    get label() {
      return t({ id: 'trace.preset.day', defaultMessage: '24 hours' });
    },
  },
  {
    preset: '7d',
    get label() {
      return t({ id: 'trace.preset.week', defaultMessage: '7 days' });
    },
  },
  {
    preset: '30d',
    get label() {
      return t({ id: 'trace.preset.month', defaultMessage: '30 days' });
    },
  },
];
const presetText = (preset: TracePreset) => PRESETS.find((p) => p.preset === preset)!.label;
/** The window read while the timeline's opening window is still to be fitted. */
const WIDEST_PRESET: TracePreset = '30d';
/** The smallest preset whose window holds every turn the trace read; the widest without one. */
const fitPreset = (trace: ProjectTrace, now: number): TracePreset => {
  const starts = trace.lanes.flatMap((row) =>
    row.turns.flatMap((turn) => (turn.start === null ? [] : [turn.start])),
  );
  if (!starts.length) return WIDEST_PRESET;
  const first = Math.min(...starts);
  return PRESETS.find((p) => presetWindow(p.preset, now).from <= first)?.preset ?? WIDEST_PRESET;
};
const untitledText = () => t({ id: 'trace.session.untitled', defaultMessage: 'Untitled session' });
/** The window the runs and diagnose tabs read, apart from the timeline's. */
type Period = '1h' | 'today' | 'all';
const PERIODS: { period: Period; label: string }[] = [
  {
    period: '1h',
    get label() {
      return t({ id: 'trace.preset.hour', defaultMessage: '1 hour' });
    },
  },
  {
    period: 'today',
    get label() {
      return t({ id: 'trace.bar.today', defaultMessage: 'Today' });
    },
  },
  {
    period: 'all',
    get label() {
      return t({ id: 'trace.bar.all', defaultMessage: 'All' });
    },
  },
];
/** Activity bucket of all time; the widest a project trace takes. */
const ALL_BUCKET_MS = 86_400_000;
const periodWindow = (period: Period, now: number): { from: number; bucketMs: number } =>
  period === '1h'
    ? presetWindow('1h', now)
    : period === 'today'
      ? { from: new Date(now).setHours(0, 0, 0, 0), bucketMs: DAY_BUCKET_MS }
      : { from: 0, bucketMs: ALL_BUCKET_MS };
type RunsView = 'now' | 'history';
/** Sessions a listing counts as running now. */
const RUNNING: readonly WorkbenchSession['state'][] = ['starting', 'running', 'waiting'];

/** A lane picked for the analysis. */
interface Picked {
  key: string;
  title: string;
}

const pct = (share: number) => `${share * 100}%`;
/** A bar's place on the axis, with its ends' shares for the replay to grow it by. */
const barStyle = (x: number, to: number) =>
  ({ left: pct(x), width: pct(Math.max(0, to - x)), '--seg-s': x, '--seg-e': to }) as CSSProperties;

type Axis = ReturnType<typeof traceAxis>;
type Lane = ProjectTrace['lanes'][number]['lane'];

/** The Git commit count is left out while it is unknown (null). */
const statNums = (
  s: TraceStats,
  commits: number | null,
): { head: [string, string][]; tail: [string, string][] } => ({
  head: [
    [t({ id: 'trace.stat.duration', defaultMessage: 'Duration' }), durationText(s.active_ms)],
    [t({ id: 'trace.stat.turns', defaultMessage: 'Turns' }), String(s.turns)],
    [t({ id: 'trace.stat.modelCalls', defaultMessage: 'Model calls' }), String(s.llm)],
    [t({ id: 'trace.stat.toolCalls', defaultMessage: 'Tool calls' }), String(s.tool)],
  ],
  tail: [
    ['token', tokenText(s.tokens.input + s.tokens.output)],
    ...(commits === null
      ? []
      : [
          [t({ id: 'trace.stat.commits', defaultMessage: 'Commits' }), String(commits)] as [
            string,
            string,
          ],
        ]),
  ],
});

/** Git commits a session is known to have made within the trace's window. */
const sessionCommits = (
  commits: ProjectHeatmap['commits'],
  trace: ProjectTrace,
  until: number | null = null,
) => {
  const from = Date.parse(trace.from);
  const to = until ?? Date.parse(trace.to);
  return commits.filter((c) => c.lane_key !== null && c.at >= from && c.at <= to).length;
};

const num = ([label, value]: [string, string]) => (
  <div key={label} className="trc-num" role="img" aria-label={`${label} ${value}`}>
    <b aria-hidden="true">{value}</b>
    <span aria-hidden="true">{label}</span>
  </div>
);

/**
 * A cell of the screen's number row, its label over its value and a dot of the status it counts;
 * a null value is still being read and holds the cell's place.
 */
const kpi = (label: string, value: string | null, dot?: 'bad' | 'wait', spoken = value) => (
  <div
    key={label}
    className="trc-kpi"
    role="img"
    aria-label={spoken === null ? label : `${label} ${spoken}`}
    aria-busy={value === null || undefined}
  >
    <span aria-hidden="true">{label}</span>
    <b aria-hidden="true">
      {value ?? <Placeholder style={{ width: 32, height: 20 }} />}
      {dot && <i className="trc-kdot" data-tone={dot} />}
    </b>
  </div>
);

/** The window's tokens: a dash when no turn reported usage, a known part with a plus when count turns did not. */
function tokensKpi(tokens: number, count: number) {
  const label = t({ id: 'trace.stat.tokens', defaultMessage: 'Tokens' });
  if (count === 0) return kpi(label, tokenText(tokens));
  if (tokens === 0)
    return kpi(
      label,
      '—',
      undefined,
      t(
        {
          id: 'trace.stat.tokensUnreported',
          defaultMessage:
            '{count, plural, one {# turn did not report usage} other {# turns did not report usage}}',
        },
        { count },
      ),
    );
  return kpi(
    label,
    `${tokenText(tokens)}+`,
    undefined,
    t(
      {
        id: 'trace.stat.tokensPartial',
        defaultMessage:
          '{tokens}, and {count, plural, one {# turn did not report usage} other {# turns did not report usage}}',
      },
      { tokens: tokenText(tokens), count },
    ),
  );
}

/** Every session of the project, Pantheon's and the CLI's, by turn over a window or by day. */
export function TraceScreen({
  projectId,
  sessions,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
}) {
  return <TraceView key={projectId ?? ''} projectId={projectId} sessions={sessions} />;
}

function TraceView({
  projectId,
  sessions: listed,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
}) {
  const tab = useShell((s) => s.traceTab);
  const setTab = useShell((s) => s.setTraceTab);
  const runsView = useShell((s) => s.runsView);
  const runsSession = useShell((s) => s.runsSession);
  const [period, setPeriod] = useState<Period>('today');
  const [mode, setMode] = useState<Mode>('timeline');
  // The session whose step replay shows in place of the timeline.
  const [replaying, setReplaying] = useState<string | null>(null);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [replayMode, setReplayMode] = useState<ReplayMode>('event');
  // The time the numbers and the event table show while the timeline replays; null at now.
  const [replayAt, setReplayAt] = useState<number | null>(null);
  // Event kinds the event table leaves out.
  const [hidden, setHidden] = useState<ReadonlySet<TraceEventKind>>(() => new Set());
  const [shownEvent, setShownEvent] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [heatDays, setHeatDays] = useState<HeatDays>('30');
  const [heatBy, setHeatBy] = useState<HeatBy>('session');
  const [range, setRange] = useState<TraceWindow | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [recap, setRecap] = useState(false);
  const [recapRange, setRecapRange] = useState<ReviewRange>('today');
  // Null until the timeline's opening window is fitted to the first trace read.
  const [preset, setPreset] = useState<TracePreset | null>(null);
  const readPreset = preset ?? WIDEST_PRESET;
  // The turn whose steps are open; its ids are kept apart, not parsed back out of the row key.
  const [steps, setSteps] = useState<{ lane: string; turn: string } | null>(null);
  const pending = useRef<string | null>(null);
  const main = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const now = useNow(CLOCK_MS);
  const dayBounds = day ? dayWindow(day) : null;
  const periodShown = tab === 'runs' || tab === 'diagnose';
  const bounds = periodShown
    ? { ...periodWindow(period, now), to: null }
    : dayBounds
      ? {
          from: dayBounds.from,
          // Today runs up to now, not to the coming midnight.
          to: dayBounds.to > now ? null : dayBounds.to,
          bucketMs: DAY_BUCKET_MS,
        }
      : { ...presetWindow(readPreset, now), to: null };
  const heatShown = tab === 'timeline' && mode === 'heatmap';
  const lanesShown = tab === 'timeline' && !heatShown;
  const trace = useProjectTrace(projectId, bounds);
  const time = useTraceTime(
    tab === 'diagnose' || lanesShown ? projectId : null,
    undefined,
    bounds,
    now,
  );
  const timeline = useProjectTimeline(lanesShown ? projectId : null, bounds.from);
  // A moved window keeps the last state intervals on screen while the next ones load.
  const [keptLine, setKeptLine] = useState<ProjectTimeline | null>(null);
  if (timeline.data && keptLine !== timeline.data) setKeptLine(timeline.data);
  const shownLine = timeline.data ?? (timeline.loading ? keptLine : null);
  const intervals = useMemo(() => shownLine && stateIntervals(shownLine), [shownLine]);
  const lineSettled = !!intervals || !!timeline.error;
  const laneTimes = useMemo(
    () => laneWallMs(lanesShown ? time.data : null),
    [lanesShown, time.data],
  );
  const heat = useProjectHeatmap(
    projectId,
    heatShown ? heatDays : day ? '90' : COMMIT_DAYS[readPreset],
  );
  const history = useEventHistory({
    key: projectId && `trace:${projectId}`,
    project_id: projectId,
    after: 0,
    keep: keepTraceEvent,
  });
  const sessions = useSessionList(projectId);
  const events = useMemo(() => history.events && traceEvents(history.events), [history.events]);
  // A window the clock moved keeps its last trace on screen while the next one loads.
  if (preset === null && !periodShown && !day && trace.data) setPreset(fitPreset(trace.data, now));
  const scope = `${projectId}:${periodShown ? `period:${period}` : (day ?? readPreset)}`;
  const [kept, setKept] = useState<{
    scope: string;
    data: ProjectTrace;
    readAt?: number | null;
  } | null>(null);
  if (trace.data && (kept?.data !== trace.data || kept.scope !== scope))
    setKept({ scope, data: trace.data, readAt: trace.readAt });
  const readTrace = trace.data ?? (trace.loading && kept?.scope === scope ? kept.data : null);
  const purposes = useMemo(
    () => (history.events ? sessionPurposes(history.events) : null),
    [history.events],
  );
  const shownTrace = useMemo(
    () => (readTrace && purposes ? namedLanes(readTrace, purposes, runtimeName) : readTrace),
    [readTrace, purposes],
  );
  const { reload: reloadTrace } = trace;
  const { reload: reloadHeat } = heat;
  const clock = useRef({ now, from: bounds.from });
  useEffect(() => {
    const was = clock.current;
    clock.current = { now, from: bounds.from };
    if (was.now === now) return;
    // A moved start already reads again.
    if (bounds.to === null && was.from === bounds.from) reloadTrace();
    if (new Date(was.now).toDateString() !== new Date(now).toDateString()) reloadHeat();
  }, [now, bounds.from, bounds.to, reloadTrace, reloadHeat]);
  const turnSteps = useTurnSteps(projectId, steps?.lane ?? null, steps?.turn ?? null);
  const stepSpans = turnSteps.data?.spans;
  const shownSteps = useMemo(
    (): TraceSteps | null =>
      steps && stepSpans ? { turnKey: `${steps.lane}/${steps.turn}`, spans: stepSpans } : null,
    [steps, stepSpans],
  );
  const [measure, size] = useSize();
  // The external session being taken over, and why the last take-over failed.
  const [adopting, setAdopting] = useState<string | null>(null);
  const [adoptFailure, setAdoptFailure] = useState<{ lane: Lane; text: string } | null>(null);
  const adopt = async (lane: Lane) => {
    if (!projectId || adopting) return;
    setAdopting(lane.key);
    setAdoptFailure(null);
    const result = await runCommand(
      'session.adopt',
      { project_id: projectId, runtime: lane.runtime, native_session_id: lane.native_id },
      null,
    );
    setAdopting(null);
    if (!result.ok) return setAdoptFailure({ lane, text: reasonText(result.error.code) });
    const id = (result.value as { id?: unknown } | null)?.id;
    if (typeof id === 'string') useShell.getState().openSession(id);
  };

  const pickedKey = picked?.key ?? null;
  useLayoutEffect(() => {
    if (!pickedKey) return;
    const active = document.activeElement;
    if (panel.current?.contains(active)) return;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [pickedKey]);
  // Focus inside the panel goes back to the control that opened it, else to the lanes.
  const closeAnalysis = useCallback(() => {
    if (panel.current?.contains(document.activeElement))
      (opener.current?.isConnected ? opener.current : main.current)?.focus({ preventScroll: true });
    setPicked(null);
  }, []);

  useEffect(() => {
    if (!recap && (replaying || (!picked && !range))) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (recap) setRecap(false);
      else if (picked) closeAnalysis();
      else setRange(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recap, replaying, picked, range, closeAnalysis]);

  const data = lanesShown ? shownTrace : null;
  const error = data && firstError(data);
  const toggle = (key: string) => {
    if (open.has(key) && steps?.lane === key) setSteps(null);
    setOpen((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const toggleSteps = (lane: string, turn: string) =>
    setSteps((now) => (now?.lane === lane && now.turn === turn ? null : { lane, turn }));
  const showError = () => {
    if (!error) return;
    const key = error.turnId === null ? error.laneKey : `${error.laneKey}/${error.turnId}`;
    pending.current = key;
    setFocus(key);
    setRange(null);
    setOpen((now) => new Set(now).add(error.laneKey));
  };
  const openDay = (lane: Picked, at: string) => {
    pending.current = lane.key;
    setMode('timeline');
    setDay(at);
    setRange(null);
    setOpen((now) => new Set(now).add(lane.key));
    setPicked(lane);
  };
  const openHour = (at: string, hour: number) => {
    const { from, to } = hourWindow(at, hour);
    const end = Math.min(to, Date.now());
    setMode('timeline');
    setDay(at);
    // Today's trace ends at now; an hour still to come opens the day so far.
    setRange(end > from ? { from, to: end } : null);
  };
  const replayFrom = useCallback((key: string) => {
    pending.current = key;
    setFocus(key);
    setReplaying(key);
  }, []);
  // The timeline comes back on its view, scrolled to the replayed session's row.
  const closeReplay = () => {
    pending.current = replaying;
    setReplaying(null);
  };
  const pickPreset = (next: TracePreset) => {
    setDay(null);
    setRange(null);
    setPreset(next);
  };

  const sessionList = sessions.data;
  const titles = useMemo(() => {
    const byId = new Map<string, string>();
    for (const lane of shownTrace?.lanes ?? [])
      byId.set(lane.lane.session_id ?? lane.lane.key, listedTitle(lane.lane));
    for (const session of sessionList ?? []) byId.set(session.id, listedTitle(session));
    return byId;
  }, [shownTrace, sessionList]);
  const titleOf = useCallback((id: string) => (titles.get(id) ?? id) || untitledText(), [titles]);
  const sessionsById = useMemo(
    () => new Map((sessionList ?? []).map((s) => [s.id, s])),
    [sessionList],
  );
  const full = shownTrace && { from: Date.parse(shownTrace.from), to: Date.parse(shownTrace.to) };
  const collab = useProjectCollab(lanesShown ? projectId : null, full);
  // The now column reads calls from the picked lane's spans only.
  const pickedTrace = useSessionTrace(lanesShown ? projectId : null, picked?.key ?? null);
  const windowEvents = useMemo(() => {
    if (!shownTrace || !events) return null;
    const [from, to] = [Date.parse(shownTrace.from), Date.parse(shownTrace.to)];
    return events.filter((e) => e.at >= from && e.at <= to);
  }, [events, shownTrace]);
  const eventKinds = TRACE_EVENT_KINDS.filter((kind) => windowEvents?.some((e) => e.kind === kind));
  const tableEvents = useMemo(
    () => windowEvents?.filter((e) => !hidden.has(e.kind)) ?? null,
    [windowEvents, hidden],
  );
  const shownEvents = useMemo(
    () =>
      tableEvents && replayAt !== null ? tableEvents.filter((e) => e.at <= replayAt) : tableEvents,
    [tableEvents, replayAt],
  );
  const toggleKind = (kind: TraceEventKind) =>
    setHidden((now) => {
      const next = new Set(now);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  const showEvent = (event: TraceEvent) => {
    if (!shownTrace || !full) return;
    setShownEvent(event.id);
    setRange(eventWindow(event.at, range, full));
    const lane = shownTrace.lanes.find(
      (l) => l.lane.key === event.sessionId || l.lane.session_id === event.sessionId,
    );
    if (!lane) return;
    pending.current = lane.lane.key;
    setFocus(lane.lane.key);
  };

  const showRuntimeEvidence = (finding: {
    lane_key?: string;
    turn_id?: string;
    span_id?: string;
    at: number;
  }) => {
    if (!shownTrace || !full || !finding.lane_key) return;
    setTab('timeline');
    setReplaying(null);
    setMode('timeline');
    setRange(eventWindow(finding.at, range, full));
    const lane = shownTrace.lanes.find((row) => row.lane.key === finding.lane_key);
    if (!lane) {
      if (!finding.lane_key.startsWith('native:'))
        useShell.getState().openSession(finding.lane_key);
      return;
    }
    setPicked(null);
    setFocus(lane.lane.key);
    pending.current = lane.lane.key;
    const turn = lane.turns.find((row) => row.id === finding.turn_id);
    setSteps(turn ? { lane: lane.lane.key, turn: turn.id } : null);
    if (turn) {
      setOpen((current) => new Set(current).add(lane.lane.key));
      pending.current = `${lane.lane.key}/${turn.id}${finding.span_id ? '/' + finding.span_id : ''}`;
      setFocus(pending.current);
    }
  };
  const showOnDay = (spot: {
    lane_key: string;
    turn_id?: string;
    span_id?: string;
    at: number;
  }) => {
    setTab('timeline');
    setReplaying(null);
    setDay(dayOf(spot.at));
    setRange(null);
    setMode('timeline');
    setPicked(null);
    if (spot.turn_id) {
      setOpen((current) => new Set(current).add(spot.lane_key));
      setSteps({ lane: spot.lane_key, turn: spot.turn_id });
    }
    const key = spot.turn_id
      ? `${spot.lane_key}/${spot.turn_id}${spot.span_id ? '/' + spot.span_id : ''}`
      : spot.lane_key;
    pending.current = key;
    setFocus(key);
  };
  const showSessionTimeEvidence = (evidence: TraceTimeEvidence) => {
    if (!full || evidence.at < full.from || evidence.at > full.to) return showOnDay(evidence);
    showRuntimeEvidence(evidence);
  };
  // The diagnose window is not the timeline's, so a finding opens on its own day.
  const showFinding = (finding: Parameters<typeof showRuntimeEvidence>[0]) => {
    const laneKey = finding.lane_key;
    if (!shownTrace || !laneKey) return;
    if (shownTrace.lanes.some((row) => row.lane.key === laneKey))
      showOnDay({ ...finding, lane_key: laneKey });
    else if (!laneKey.startsWith('native:')) useShell.getState().openSession(laneKey);
  };
  const runningNow = listed?.filter((s) => RUNNING.includes(s.state)).length ?? 0;
  // The range applies to the runs tab's history view only.
  const periodHeld = tab === 'runs' && runsView === 'now';
  const setRunsView = (view: RunsView) => useShell.setState({ runsView: view });
  useShortcut(
    'trace-view',
    () => setRunsView(runsView === 'now' ? 'history' : 'now'),
    tab === 'runs',
  );
  useShortcut('trace-all', () => setPeriod('all'), periodShown && !periodHeld);
  // All time starts at its first turn; without one it names no window.
  const turnStarts =
    shownTrace?.lanes.flatMap((row) =>
      row.turns.flatMap((turn) => (turn.start === null ? [] : [turn.start])),
    ) ?? [];
  const lanesWindow = lanesShown && full ? (range ?? full) : null;
  const windowEnd = lanesWindow ? lanesWindow.to : shownTrace && Date.parse(shownTrace.to);
  const windowStart = lanesWindow
    ? lanesWindow.from
    : shownTrace && (period === 'all' ? Math.min(...turnStarts) : Date.parse(shownTrace.from));
  const windowText =
    windowEnd !== null && windowStart !== null && Number.isFinite(windowStart)
      ? t(
          { id: 'trace.bar.window', defaultMessage: '{from} to {to}' },
          {
            from: dayText(windowStart, windowEnd, { time: true }),
            to: dayText(windowEnd, windowEnd, { time: true }),
          },
        )
      : null;

  const indexing =
    data?.indexing && data.indexing.done_files < data.indexing.total_files ? data.indexing : null;
  const totalsAt = useMemo(
    () => data && replayTotals(data, { from: Date.parse(data.from), to: Date.parse(data.to) }),
    [data],
  );
  const asOf = replayAt !== null && totalsAt ? totalsAt(replayAt) : null;
  const commits = data && heat.data && sessionCommits(heat.data.commits, data, replayAt);
  const gateFailures =
    windowEvents?.filter((e) => e.what === 'gate_failed' && (replayAt === null || e.at <= replayAt))
      .length ?? null;
  const waited = full && intervals ? waitingMs(intervals, full.from, replayAt ?? full.to) : null;
  // Shown data a read is already replacing gets its status bar only once that read runs long.
  const traceReading = !!(trace.loading || trace.refreshing);
  const heatReading = !!(heat.loading || heat.refreshing);
  const lineReading = !!(timeline.loading || timeline.refreshing);
  const traceSlow = useDelayed(traceReading);
  const heatSlow = useDelayed(heatReading);
  const lineSlow = useDelayed(lineReading);
  const approvedToday = useDecisionsToday(projectId ? [projectId] : [])[projectId ?? ''] ?? 0;

  const tabList = (
    <Tabs.List
      className="tb-tabs"
      aria-label={t({ id: 'trace.tabs.label', defaultMessage: 'Trace views' })}
    >
      {TABS.map((v) => (
        <Tabs.Tab key={v.tab} className="tb-tab" value={v.tab}>
          {v.tab === 'approved' && approvedToday > 0 ? (
            <>
              {v.label}
              <span className="tb-ct">{approvedToday}</span>
            </>
          ) : (
            v.label
          )}
        </Tabs.Tab>
      ))}
    </Tabs.List>
  );
  const recapName = t({ id: 'trace.recap.title', defaultMessage: 'Recap' });
  const recapButton = projectId && (
    <button
      type="button"
      className="btn ghost sm"
      aria-label={recapName}
      title={recapName}
      aria-pressed={recap}
      onClick={() => setRecap((on) => !on)}
    >
      <ClipboardList className="ic-sm" aria-hidden="true" />
      <span className="tb-lbl">{recapName}</span>
    </button>
  );
  const recapPanel = recap && projectId && (
    <StatusReview
      projectId={projectId}
      titleOf={titleOf}
      hasSession={(id) => sessionsById.has(id)}
      range={recapRange}
      onRange={setRecapRange}
      onClose={() => setRecap(false)}
    />
  );
  if (tab === 'approved')
    return (
      <Tabs.Root className="tb-pg" value={tab} onValueChange={(value) => setTab(value as TraceTab)}>
        <ApprovedForYou projectId={projectId} tabs={tabList} end={recapButton} />
        {recapPanel}
      </Tabs.Root>
    );
  if (tab === 'workflow')
    return (
      <Tabs.Root className="tb-pg" value={tab} onValueChange={(value) => setTab(value as TraceTab)}>
        <TopBar title={SCREEN_NAMES.trace}>
          {tabList}
          <div className="tb-end">{recapButton}</div>
        </TopBar>
        <main className="trc">
          <Tabs.Panel className="trc-body" value={tab}>
            {projectId ? <WorkflowPath key={projectId} projectId={projectId} /> : <Skeleton />}
          </Tabs.Panel>
        </main>
        {recapPanel}
      </Tabs.Root>
    );
  return (
    <Tabs.Root className="tb-pg" value={tab} onValueChange={(value) => setTab(value as TraceTab)}>
      <TopBar title={SCREEN_NAMES.trace}>
        {tabList}
        {lanesShown && replaying && (
          <button type="button" className="btn ghost sm" onClick={closeReplay}>
            <ArrowLeft className="ic-sm" aria-hidden="true" />
            {t({ id: 'trace.replay.back', defaultMessage: 'Back to timeline' })}
          </button>
        )}
        {(tab === 'diagnose' || (lanesShown && !replaying)) && windowText && (
          <span className="trb-win">{windowText}</span>
        )}
        <div className="tb-end">
          {tab === 'runs' && (
            <RadioGroup<RunsView>
              className="tb-seg"
              aria-label={t({ id: 'trace.bar.view', defaultMessage: 'Run view' })}
              value={runsView}
              onValueChange={(value) => setRunsView(value)}
            >
              <Radio.Root
                value="now"
                aria-label={t(
                  {
                    id: 'trace.bar.nowCount',
                    defaultMessage:
                      'Now, {count, plural, =0 {no sessions running} one {# session running} other {# sessions running}}',
                  },
                  { count: runningNow },
                )}
              >
                {t({ id: 'trace.bar.now', defaultMessage: 'Now' })}
                <span className="trb-ct" aria-hidden="true">
                  {runningNow}
                </span>
              </Radio.Root>
              <Radio.Root value="history">
                {t({ id: 'trace.bar.history', defaultMessage: 'History' })}
              </Radio.Root>
            </RadioGroup>
          )}
          {periodShown && !periodHeld && (
            <RadioGroup<Period>
              className="tb-seg"
              aria-label={t({ id: 'trace.bar.range', defaultMessage: 'Time range' })}
              value={period}
              onValueChange={(value) => setPeriod(value)}
            >
              {PERIODS.map((p) => (
                <Radio.Root key={p.period} value={p.period}>
                  {p.label}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {lanesShown && !replaying && (
            <RadioGroup<TracePreset | null>
              className="tb-seg"
              aria-label={t({ id: 'trace.window', defaultMessage: 'Time window' })}
              value={day ? null : preset}
              onValueChange={(value) => pickPreset(value!)}
            >
              {PRESETS.map((p) => (
                <Radio.Root key={p.preset} value={p.preset}>
                  {p.label}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {heatShown && (
            <RadioGroup<HeatBy>
              className="tb-seg"
              aria-label={t({ id: 'trace.heatBy.label', defaultMessage: 'Heatmap grouping' })}
              value={heatBy}
              onValueChange={(value) => setHeatBy(value)}
            >
              {HEAT_BYS.map((b) => (
                <Radio.Root key={b.by} value={b.by}>
                  {b.label}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {heatShown && (
            <RadioGroup<HeatDays>
              className="tb-seg"
              aria-label={t({ id: 'trace.heatRange.label', defaultMessage: 'Time range' })}
              value={heatDays}
              onValueChange={(value) => setHeatDays(value)}
            >
              {HEAT_RANGES.map((days) => (
                <Radio.Root key={days} value={days}>
                  {t(
                    {
                      id: 'trace.heatRange.days',
                      defaultMessage: '{days, plural, one {# day} other {# days}}',
                    },
                    { days: Number(days) },
                  )}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {lanesShown && !replaying && eventKinds.length > 0 && (
            <Menu.Root>
              <Menu.Trigger className="btn ghost sm">
                <ListFilter className="ic-sm" aria-hidden="true" />
                {t({ id: 'trace.events.kinds', defaultMessage: 'Event types' })}
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
                  <Menu.Popup className="wmenu pjm pop trc-km">
                    {eventKinds.map((kind) => (
                      <Menu.CheckboxItem
                        key={kind}
                        checked={!hidden.has(kind)}
                        onCheckedChange={() => toggleKind(kind)}
                      >
                        <span className="pjm-ck">
                          <Menu.CheckboxItemIndicator>
                            <Check className="ic-sm" aria-hidden="true" />
                          </Menu.CheckboxItemIndicator>
                        </span>
                        {KIND_TEXT[kind]}
                      </Menu.CheckboxItem>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          )}
          {tab === 'timeline' && !replaying && (
            <RadioGroup<Mode>
              className="tb-seg"
              aria-label={t({ id: 'trace.view', defaultMessage: 'View' })}
              value={mode}
              onValueChange={(value) => setMode(value)}
            >
              {MODES.map((m) => (
                <Radio.Root key={m.mode} value={m.mode}>
                  {m.label}
                </Radio.Root>
              ))}
            </RadioGroup>
          )}
          {lanesShown && !replaying && (
            <ReplayModeControl mode={replayMode} onMode={setReplayMode} />
          )}
          {lanesShown && <ReplaySpeedControl speed={speed} onSpeed={setSpeed} />}
          {recapButton}
          {tab === 'diagnose' && projectId && shownTrace?.diagnostics && (
            <AnalyzeMenu
              projectId={projectId}
              diagnostics={shownTrace.diagnostics}
              runtimes={shownTrace.reflection_runtimes ?? []}
              windowText={windowText}
              stale={!!trace.stale}
            />
          )}
        </div>
      </TopBar>
      {tab === 'runs' ? (
        <Tabs.Panel value={tab}>
          <RunsView
            projectId={projectId}
            sessions={listed}
            view={runsView}
            range={{ from: bounds.from, to: bounds.to }}
            sessionId={runsSession}
            slowMs={shownTrace?.diagnostics?.slow_tool_ms}
            onShowInTimeline={showOnDay}
          />
        </Tabs.Panel>
      ) : lanesShown && replaying && projectId ? (
        <Tabs.Panel className="rpb-session" value={tab}>
          <StepReplay key={replaying} sessionId={replaying} projectId={projectId} speed={speed} />
        </Tabs.Panel>
      ) : (
        <main className="trc" ref={measure}>
          {(lanesShown || tab === 'diagnose') &&
            shownTrace &&
            (trace.error || !traceReading || traceSlow) && (
              <ReadStatus
                label="Trace"
                {...trace}
                stale={trace.stale || !trace.data}
                readAt={trace.readAt ?? kept?.readAt}
              />
            )}
          {tab !== 'activity' && heat.data && (heat.error || !heatReading || heatSlow) && (
            <ReadStatus
              label={
                heatShown
                  ? t({ id: 'trace.mode.heatmap', defaultMessage: 'Heatmap' })
                  : t({ id: 'trace.read.commits', defaultMessage: 'Commit history' })
              }
              {...heat}
              inner={!heatShown}
            />
          )}
          {lanesShown && !heat.data && heat.error && (
            <ReadStatus
              label={t({ id: 'trace.read.commits', defaultMessage: 'Commit history' })}
              {...heat}
            />
          )}
          {lanesShown && (timeline.error || (shownLine && (!lineReading || lineSlow))) && (
            <ReadStatus
              label={t({ id: 'trace.read.states', defaultMessage: 'Session states' })}
              {...timeline}
              inner
            />
          )}
          {indexing && (
            <div
              className="trc-idx"
              role="progressbar"
              aria-label={t({ id: 'trace.indexing', defaultMessage: 'Indexing progress' })}
              aria-valuemin={0}
              aria-valuemax={indexing.total_files}
              aria-valuenow={indexing.done_files}
            >
              <i style={{ transform: `scaleX(${indexing.done_files / indexing.total_files})` }} />
            </div>
          )}
          {data && lineSettled && (
            <div className="trc-kpis">
              {kpi(
                t({ id: 'trace.stat.duration', defaultMessage: 'Duration' }),
                durationText(asOf ? asOf.activeMs : data.stats.active_ms),
              )}
              {asOf
                ? kpi(
                    t({ id: 'trace.stat.running', defaultMessage: 'Running' }),
                    String(asOf.running),
                  )
                : kpi(
                    t({ id: 'trace.stat.sessions', defaultMessage: 'Sessions' }),
                    String(data.stats.sessions),
                  )}
              {kpi(
                t({ id: 'trace.stat.calls', defaultMessage: 'Calls' }),
                String(asOf ? asOf.calls : data.stats.llm + data.stats.tool),
              )}
              {(gateFailures !== null || !history.error) &&
                kpi(
                  t({ id: 'trace.stat.gateFailures', defaultMessage: 'Gate failures' }),
                  gateFailures === null ? null : String(gateFailures),
                  gateFailures ? 'bad' : undefined,
                )}
              {waited !== null &&
                kpi(
                  t({ id: 'trace.stat.waited', defaultMessage: 'Time waiting on you' }),
                  durationText(waited),
                  'wait',
                )}
              {asOf
                ? tokensKpi(asOf.tokens, asOf.unreported)
                : tokensKpi(
                    data.stats.tokens.input + data.stats.tokens.output,
                    data.stats.turns_without_usage ?? 0,
                  )}
              <button
                type="button"
                className="trc-kpi"
                aria-label={t(
                  { id: 'trace.stat.errorCount', defaultMessage: 'Errors {count}' },
                  { count: asOf ? asOf.errors : data.stats.error },
                )}
                disabled={!error}
                onClick={showError}
              >
                <span aria-hidden="true">
                  {t({ id: 'trace.stat.errors', defaultMessage: 'Errors' })}
                </span>
                <b aria-hidden="true">{asOf ? asOf.errors : data.stats.error}</b>
              </button>
              {(commits !== null || !heat.error) &&
                kpi(
                  t({ id: 'trace.stat.commits', defaultMessage: 'Commits' }),
                  commits === null ? null : String(commits),
                )}
            </div>
          )}
          <Tabs.Panel className="trc-body" value={tab}>
            {tab === 'diagnose' ? (
              shownTrace?.diagnostics && projectId ? (
                <RuntimePanel
                  key={projectId}
                  overview={<TraceTimeChart query={time} titleOf={titleOf} />}
                  diagnostics={shownTrace.diagnostics}
                  reviews={shownTrace.runtime_reviews ?? []}
                  stale={!!trace.stale}
                  titleOf={titleOf}
                  onEvidence={showFinding}
                  onAllTime={period === 'all' ? undefined : () => setPeriod('all')}
                />
              ) : trace.error ? (
                <Failure error={trace.error} onRetry={trace.reload} />
              ) : shownTrace ? (
                <Empty
                  text={t({
                    id: 'trace.runtime.unavailable',
                    defaultMessage: 'Runtime diagnostics unavailable.',
                  })}
                />
              ) : (
                <Skeleton />
              )
            ) : tab === 'activity' ? (
              <ActivityList
                rows={events}
                error={history.error}
                onRetry={history.reload}
                titleOf={titleOf}
                now={now}
                onOpen={(id) => useShell.getState().openSession(id)}
              />
            ) : (
              <>
                <div className="trc-main" ref={main} tabIndex={-1}>
                  {heatShown ? (
                    heat.data ? (
                      heatBy === 'hour' ? (
                        <HourHeatmap heatmap={heat.data} onOpenHour={openHour} />
                      ) : (
                        <Heatmap
                          heatmap={heat.data}
                          picked={picked?.key ?? null}
                          onPick={setPicked}
                          onOpenDay={openDay}
                        />
                      )
                    ) : heat.error ? (
                      <Failure error={heat.error} onRetry={heat.reload} />
                    ) : (
                      <Skeleton />
                    )
                  ) : shownTrace && lineSettled ? (
                    <Lanes
                      trace={shownTrace}
                      sessions={sessionsById}
                      states={intervals}
                      times={laneTimes}
                      bucketMs={bounds.bucketMs}
                      label={day ? dayName(day) : presetText(readPreset)}
                      empty={
                        day
                          ? t(
                              {
                                id: 'trace.lanes.emptyDay',
                                defaultMessage: 'No sessions on {day}',
                              },
                              { day: dayName(day) },
                            )
                          : t(
                              {
                                id: 'trace.lanes.emptyRecent',
                                defaultMessage: 'No sessions in the last {window}',
                              },
                              { window: presetText(readPreset) },
                            )
                      }
                      indexing={!!indexing}
                      speed={speed}
                      mode={replayMode}
                      onReplayAt={setReplayAt}
                      at={replayAt}
                      subagents={collab.data?.subagents ?? NO_SUBAGENTS}
                      calls={pickedTrace.data?.spans ?? null}
                      titleOf={titleOf}
                      onReplay={replayFrom}
                      range={range}
                      onRange={setRange}
                      open={open}
                      onToggle={toggle}
                      expanded={steps && `${steps.lane}/${steps.turn}`}
                      steps={shownSteps}
                      onSteps={toggleSteps}
                      focus={focus}
                      picked={picked?.key ?? null}
                      onPick={setPicked}
                      pending={pending}
                      host={main}
                      adopting={adopting}
                      onAdopt={adopt}
                      events={tableEvents}
                      now={now}
                    />
                  ) : trace.error ? (
                    <Failure error={trace.error} onRetry={trace.reload} />
                  ) : (
                    <Skeleton />
                  )}
                  {lanesShown && adoptFailure && (
                    <Failure
                      error={adoptFailure.text}
                      onRetry={() => void adopt(adoptFailure.lane)}
                    />
                  )}
                  {lanesShown &&
                    steps &&
                    (turnSteps.data ? (
                      <ReadStatus
                        label={t({ id: 'trace.read.turn', defaultMessage: 'Turn trace' })}
                        {...turnSteps}
                        inner
                      />
                    ) : (
                      turnSteps.error && (
                        <Failure error={turnSteps.error} onRetry={turnSteps.reload} />
                      )
                    ))}
                  {lanesShown && shownTrace && lineSettled && (
                    <EventTable
                      rows={shownEvents}
                      current={replayAt === null ? null : (shownEvents?.[0]?.id ?? null)}
                      error={history.error}
                      onRetry={history.reload}
                      titleOf={titleOf}
                      to={Date.parse(shownTrace.to)}
                      shown={shownEvent}
                      onShow={showEvent}
                      history={history.events}
                      lanes={shownTrace.lanes}
                      now={now}
                    />
                  )}
                </div>
                {picked && (
                  <Analysis
                    key={picked.key}
                    projectId={projectId}
                    lane={picked}
                    over={size.w < SIDE_MIN_PX}
                    now={now}
                    panel={panel}
                    onClose={closeAnalysis}
                    onTimeEvidence={showSessionTimeEvidence}
                  />
                )}
              </>
            )}
          </Tabs.Panel>
        </main>
      )}
      {recapPanel}
    </Tabs.Root>
  );
}

/** The activity strip over the fetched window and one lane per session under it. */
function Lanes({
  trace,
  sessions,
  states,
  times,
  bucketMs,
  label,
  empty,
  indexing,
  speed,
  mode,
  onReplayAt,
  at,
  subagents,
  calls,
  titleOf,
  onReplay,
  range,
  onRange,
  open,
  onToggle,
  expanded,
  steps,
  onSteps,
  focus,
  picked,
  onPick,
  pending,
  host,
  adopting,
  onAdopt,
  events,
  now,
}: {
  trace: ProjectTrace;
  /** Listed Pantheon sessions by id. */
  sessions: ReadonlyMap<string, WorkbenchSession>;
  /** Pantheon sessions' state intervals by session id; null when they could not be read. */
  states: ReadonlyMap<string, StateInterval[]> | null;
  /** Each lane's wall-clock time by lane key. */
  times: ReadonlyMap<string, number>;
  bucketMs: number;
  /** The fetched window in words. */
  label: string;
  empty: string;
  indexing: boolean;
  speed: ReplaySpeed;
  mode: ReplayMode;
  /** Hears the time the page's numbers show while the replay bar plays; null at now. */
  onReplayAt: (time: number | null) => void;
  /** The time the page's numbers show; null at now. */
  at: number | null;
  /** The window's subagents of Pantheon sessions. */
  subagents: readonly TraceSubagent[];
  /** The picked lane's spans; null until read. */
  calls: readonly TraceSpan[] | null;
  titleOf: (sessionId: string) => string;
  /** Opens a session's step replay from its row. */
  onReplay: (key: string) => void;
  range: TraceWindow | null;
  onRange: (range: TraceWindow | null) => void;
  open: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Key of the turn row whose steps are open. */
  expanded: string | null;
  steps: TraceSteps | null;
  onSteps: (lane: string, turn: string) => void;
  focus: string | null;
  picked: string | null;
  onPick: (lane: Picked) => void;
  /** Key of the row to scroll to once it is laid out. */
  pending: RefObject<string | null>;
  /** Takes the wheel that zooms and pans the strip and the lanes. */
  host: RefObject<HTMLDivElement | null>;
  /** Key of the external session being taken over. */
  adopting: string | null;
  onAdopt: (lane: Lane) => void;
  /** The window's events the table shows; null until read. */
  events: readonly TraceEvent[] | null;
  now: number;
}) {
  const full = useMemo(
    () => ({ from: Date.parse(trace.from), to: Date.parse(trace.to) }),
    [trace.from, trace.to],
  );
  const view = range ?? full;
  const shown = useMemo(() => windowLanes(trace, view), [trace, view]);
  const axis = useMemo(() => traceAxis(shown, view), [shown, view]);
  const rows = useMemo(
    () => traceRows(shown, open, steps, subagents),
    [shown, open, steps, subagents],
  );
  const moment = at ?? full.to;

  // React's wheel listener is passive, so it cannot keep the page from scrolling.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // The replay layer spans the track column even when the view holds no rows.
      const track = el.querySelector('.trc-phc')?.getBoundingClientRect();
      if (!track) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const strip = e.target instanceof Element ? e.target.closest('.trc-strip') : null;
        const share = (box: DOMRect) =>
          Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
        const at = strip
          ? full.from + share(strip.getBoundingClientRect()) * (full.to - full.from)
          : axis.time(share(track));
        const delta = Math.min(WHEEL_MAX, Math.max(-WHEEL_MAX, e.deltaY));
        onRange(zoomWindow(view, full, at, Math.exp(delta * ZOOM_RATE), trace));
        return;
      }
      const delta =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : null;
      if (delta === null || !range) return;
      e.preventDefault();
      onRange(panWindow(view, full, (delta / Math.max(1, track.width)) * (view.to - view.from)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [host, trace, axis, view, full, range, onRange]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const [measure, size] = useSize();
  const lanesRef = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      measure(el);
    },
    [measure],
  );
  const [top, setTop] = useState(0);
  const { first, last } = visibleWindow(rows.length, top, size.h);
  const toggleRow = useCallback(
    (row: TraceRow) => {
      if (row.kind === 'turn') {
        const { turn } = row;
        // Opening a turn's steps frames that turn, so its steps are wide enough to read.
        const span = row.key !== expanded && turnSpan(turn, full);
        if (span) {
          onRange(turnWindow(...span, full));
          pending.current = row.key;
        }
        return onSteps(row.lane.lane.key, turn.id);
      }
      if (row.kind === 'more') return onToggle(row.lane.lane.key);
      onToggle(row.key);
      onPick({ key: row.key, title: row.lane.lane.title || untitledText() });
    },
    [expanded, full, onRange, onSteps, onToggle, onPick, pending],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!pending.current || !el) return;
    const index = rows.findIndex((row) => row.key === pending.current);
    if (index < 0) return;
    pending.current = null;
    el.scrollTop = Math.max(0, index * ROW_HEIGHT - (el.clientHeight - ROW_HEIGHT) / 2);
  }, [rows, pending]);

  return (
    <>
      <Strip
        trace={trace}
        full={full}
        bucketMs={bucketMs}
        label={label}
        range={range}
        onRange={onRange}
      />
      {trace.lanes.length === 0 && !indexing ? (
        <Empty text={empty} />
      ) : (
        <div className="trc-lcard">
          <div className="trc-axis" aria-hidden="true">
            <span>{t({ id: 'trace.lanes.label', defaultMessage: 'Sessions' })}</span>
            <span className="trc-ticks">
              {tickTexts(
                SHARES.map((share) => axis.time(share)),
                view.to,
              ).map((tick, i) => (
                <span key={SHARES[i]} className="trc-tick" style={{ left: pct(SHARES[i]!) }}>
                  {tick}
                </span>
              ))}
            </span>
          </div>
          <div className="trc-gaps">
            <span className="trc-gapc">
              {axis.breaks.map((gap) => (
                <span
                  key={gap.at}
                  className="trc-gap"
                  role="img"
                  aria-label={t(
                    { id: 'trace.gap.label', defaultMessage: 'Idle {duration}' },
                    { duration: durationText(gap.ms) },
                  )}
                  style={{ left: pct(gap.at + BREAK_SHARE / 2) }}
                >
                  {durationText(gap.ms)}
                </span>
              ))}
            </span>
          </div>
          <div
            className="trc-lanes"
            ref={lanesRef}
            onScroll={(e) => setTop(e.currentTarget.scrollTop)}
          >
            {/* Stays over the viewport and takes no room; the rows scroll under it. */}
            <div
              className="trc-ph"
              aria-hidden="true"
              style={{ height: size.h, marginBottom: -size.h }}
            >
              <span className="trc-phc">
                <i className="trc-phl" />
              </span>
            </div>
            <div
              className="trc-rows"
              role="list"
              aria-label={t({ id: 'trace.lanes.label', defaultMessage: 'Sessions' })}
              style={{ height: rows.length * ROW_HEIGHT }}
            >
              {rows.slice(first, last + 1).map((row, i) => {
                const id = row.kind === 'session' ? row.lane.lane.session_id : undefined;
                return (
                  <Row
                    key={row.key}
                    row={row}
                    index={first + i}
                    count={rows.length}
                    axis={axis}
                    view={view}
                    open={row.kind === 'turn' ? row.key === expanded : open.has(row.key)}
                    focused={row.key === focus || (row.kind === 'session' && row.key === picked)}
                    session={id === undefined ? undefined : sessions.get(id)}
                    states={id === undefined ? undefined : states?.get(id)}
                    time={row.kind === 'session' ? times.get(row.key) : undefined}
                    at={moment}
                    calls={row.kind === 'session' && row.key === picked ? calls : undefined}
                    adopting={adopting}
                    onAdopt={onAdopt}
                    onReplay={onReplay}
                    onToggle={toggleRow}
                  />
                );
              })}
            </div>
            <LaneOverlay
              rows={rows.slice(first, last + 1)}
              first={first}
              count={rows.length}
              axis={axis}
              view={view}
              events={events}
              now={now}
            />
          </div>
          {states && <LaneLegend />}
        </div>
      )}
      <Replayer
        trace={shown}
        picked={picked}
        axis={axis}
        view={view}
        full={full}
        host={host}
        speed={speed}
        mode={mode}
        bucketMs={bucketMs}
        events={events}
        titleOf={titleOf}
        onMoment={onReplayAt}
      />
    </>
  );
}

const NO_MARKS: ReplayMark[] = [];
const NO_SUBAGENTS: TraceSubagent[] = [];

/**
 * The replay bar over the view's activity, with the table's events in the view as ticks; its steps
 * are those events and the picked session's turns, else every turn in the view. Without events in
 * the view the picked session's turns are marked instead.
 */
function Replayer({
  trace,
  picked,
  axis,
  view,
  full,
  host,
  speed,
  mode,
  bucketMs,
  events,
  titleOf,
  onMoment,
}: {
  trace: ProjectTrace;
  picked: string | null;
  axis: Axis;
  view: TraceWindow;
  full: TraceWindow;
  host: RefObject<HTMLDivElement | null>;
  speed: ReplaySpeed;
  mode: ReplayMode;
  bucketMs: number;
  events: readonly TraceEvent[] | null;
  titleOf: (sessionId: string) => string;
  onMoment: (time: number | null) => void;
}) {
  const { marks, ofLane } = useMemo(() => replayMarks(trace, view, picked), [trace, view, picked]);
  const ticks = useMemo(
    () =>
      (events ?? [])
        .filter((e) => e.at >= view.from && e.at <= view.to)
        .sort((a, b) => a.at - b.at)
        .map((e): ReplayTick => ({
          id: e.id,
          at: e.at,
          tone: eventTone(e),
          label: listText(eventClock(e.at, full.to), titleOf(e.sessionId), eventText(e)),
        })),
    [events, view, full.to, titleOf],
  );
  const steps = useMemo(
    () => [...new Set([...ticks, ...marks].map((step) => step.at))].sort((a, b) => a - b),
    [ticks, marks],
  );
  const replay = useTraceReplay(axis, view, full, host, speed, steps, { mode, onMoment });
  const density = useMemo(() => ({ buckets: trace.buckets, bucketMs }), [trace.buckets, bucketMs]);
  return (
    <ReplayBar
      replay={replay}
      axis={axis}
      view={view}
      full={full}
      marks={ofLane && ticks.length === 0 ? marks : NO_MARKS}
      density={density}
      ticks={ticks}
    />
  );
}

const Row = memo(function Row({
  row,
  index,
  count,
  axis,
  view,
  open,
  focused,
  session,
  states,
  time,
  at,
  calls,
  onToggle,
  adopting,
  onAdopt,
  onReplay,
}: {
  row: TraceRow;
  index: number;
  count: number;
  axis: Axis;
  view: TraceWindow;
  open: boolean;
  focused: boolean;
  /** The listed Pantheon session of a session row. */
  session?: WorkbenchSession;
  /** The state intervals of a session row's Pantheon session. */
  states?: readonly StateInterval[];
  /** A session row's wall-clock time. */
  time?: number;
  /** The time the now column shows. */
  at: number;
  /** The picked session row's spans, whose call at that time its now column names. */
  calls?: readonly TraceSpan[] | null;
  onToggle: (row: TraceRow) => void;
  adopting: string | null;
  onAdopt: (lane: Lane) => void;
  onReplay: (key: string) => void;
}) {
  // Under replay the row shows once the playhead reaches first, its first activity.
  const placed = (first: number | null) =>
    ({
      top: index * ROW_HEIGHT,
      height: ROW_HEIGHT,
      ...(first !== null && { '--row-s': axis.position(Math.max(first, view.from)) }),
    }) as CSSProperties;
  const lane = row.lane.lane;
  if (row.kind === 'session') {
    const kind =
      lane.source === 'external'
        ? t({ id: 'trace.row.external', defaultMessage: 'External session' })
        : t({ id: 'trace.row.pantheon', defaultMessage: 'Pantheon session' });
    const shown = states?.length ? states : undefined;
    const stateTimes = new Map<LaneState, number>();
    for (const s of shown ?? []) {
      const kind = LANE_STATE[s.state];
      const ms = Math.min(s.to ?? view.to, view.to) - Math.max(s.from, view.from);
      if (kind && ms > 0) stateTimes.set(kind, (stateTimes.get(kind) ?? 0) + ms);
    }
    const first = Math.min(
      ...row.lane.turns.flatMap((turn) => (turn.start === null ? [] : [turn.start])),
      ...(shown ?? []).flatMap((s) => (LANE_STATE[s.state] ? [s.from] : [])),
    );
    const call = calls ? callAt(calls, at) : null;
    const doing = call ? null : segmentAt(row.lane.turns, at);
    return (
      <div
        className="trc-row"
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={count}
        data-sel={focused || undefined}
        style={placed(Number.isFinite(first) ? first : null)}
      >
        <button
          type="button"
          className="trc-head"
          aria-expanded={open}
          aria-label={listText(
            t(
              {
                id: 'trace.row.session',
                defaultMessage:
                  '{title}, {runtime}, {kind}, {turns, plural, one {# turn} other {# turns}}{errors, plural, =0 {} one {, # error} other {, # errors}}',
              },
              {
                title: lane.title || untitledText(),
                runtime: runtimeName(lane.runtime),
                kind,
                turns: row.stats.turns,
                errors: row.stats.error,
              },
            ),
            session && sessionStateLabel(session),
            time !== undefined && durationText(time),
            ...(Object.keys(LANE_STATE_TEXT) as LaneState[]).flatMap((state) => {
              const ms = stateTimes.get(state);
              return ms === undefined
                ? []
                : [
                    t(
                      { id: 'trace.laneState.time', defaultMessage: '{state} {duration}' },
                      { state: LANE_STATE_TEXT[state], duration: durationText(ms) },
                    ),
                  ];
            }),
          )}
          onClick={() => onToggle(row)}
        >
          <span className="trc-name">
            <ChevronRight className="trc-chev" aria-hidden="true" />
            {session ? (
              <SessionStateIcon session={session} place="list" />
            ) : (
              <i className="trc-rt" data-rt={lane.runtime} data-src={lane.source} />
            )}
            <span
              className="trc-title"
              data-ended={(session && ENDED.includes(session.state)) || undefined}
            >
              {lane.title || untitledText()}
            </span>
            {time !== undefined && <span className="trc-dur">{durationText(time)}</span>}
          </span>
          <Track turns={row.lane.turns} states={shown} axis={axis} view={view} />
        </button>
        <span className="trc-now" data-kind={doing ?? undefined}>
          {call ? (
            <code className="trc-call">
              {call.input_summary ? `${call.name} ${call.input_summary}` : call.name}
            </code>
          ) : (
            doing && DOING_TEXT[doing]
          )}
        </span>
        <span className="trc-acts">
          <button
            type="button"
            className="ib trc-replay"
            aria-label={t({ id: 'trace.row.replay', defaultMessage: 'Replay' })}
            onClick={() => onReplay(row.key)}
          >
            <Play aria-hidden="true" />
          </button>
          {lane.source === 'external' && (
            <button
              type="button"
              className="btn trc-adopt"
              disabled={adopting !== null}
              aria-disabled={adopting !== null || undefined}
              onClick={() => onAdopt(lane)}
            >
              {t({ id: 'trace.row.adopt', defaultMessage: 'Continue in Pantheon' })}
            </button>
          )}
        </span>
      </div>
    );
  }
  if (row.kind === 'step') {
    const { span, depth } = row;
    const text = span.kind === 'llm' || span.kind === 'compact' ? STEP_TEXT[span.kind] : span.name;
    // Only a running step grows with the clock; any other without an end has no length to draw.
    const end = span.end ?? (span.status === 'running' ? view.to : null);
    const bar =
      span.start === null || end === null || end < view.from || span.start > view.to
        ? null
        : {
            x: axis.position(Math.max(span.start, view.from)),
            to: axis.position(Math.min(end, view.to)),
            label: t(
              { id: 'trace.step.bar', defaultMessage: '{name} {when}, {duration}, {status}' },
              {
                name: text,
                when: dayText(span.start, view.to, { time: true }),
                duration: durationText(end - span.start),
                status: STATUS_TEXT[span.status],
              },
            ),
          };
    return (
      <div
        className="trc-row"
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={count}
        data-sel={focused || undefined}
        style={placed(span.start)}
      >
        <div className="trc-line">
          <span className="trc-sn" data-depth={depth} aria-hidden={bar ? true : undefined}>
            {text}
          </span>
          <span className="trc-track">
            {axis.breaks.map((gap) => (
              <i
                key={gap.at}
                className="trc-brk"
                style={{ left: pct(gap.at), width: pct(BREAK_SHARE) }}
              />
            ))}
            {bar && (
              <i
                className="trc-seg trc-step"
                data-kind={span.status === 'error' ? 'error' : STEP_COLOR[span.kind as StepKind]}
                data-live={span.status === 'running' || undefined}
                role="img"
                aria-label={bar.label}
                style={barStyle(bar.x, bar.to)}
              />
            )}
          </span>
        </div>
      </div>
    );
  }
  if (row.kind === 'more') {
    const label = t(
      {
        id: 'trace.row.moreSubagents',
        defaultMessage: '{count, plural, one {# more subagent} other {# more subagents}}',
      },
      { count: row.agents.length },
    );
    return (
      <div
        className="trc-row"
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={count}
        style={placed(row.agents[0]!.start)}
      >
        <button
          type="button"
          className="trc-head"
          aria-expanded={false}
          aria-label={label}
          onClick={() => onToggle(row)}
        >
          <span className="trc-sa" aria-hidden="true">
            {t(
              { id: 'trace.row.moreCount', defaultMessage: '+{count}' },
              { count: row.agents.length },
            )}
          </span>
        </button>
      </div>
    );
  }
  if (row.kind === 'subagent') {
    const { agent } = row;
    const running = agent.status === 'running';
    const end = running ? view.to : agent.start + (agent.duration_ms ?? 0);
    const bar =
      end < view.from || agent.start > view.to
        ? null
        : {
            x: axis.position(Math.max(agent.start, view.from)),
            to: axis.position(Math.min(end, view.to)),
          };
    const busy = agent.start <= at && (running || at <= end);
    return (
      <div
        className="trc-row"
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={count}
        data-sel={focused || undefined}
        style={placed(agent.start)}
      >
        <div className="trc-line">
          <span className="trc-sa" aria-hidden={bar ? true : undefined}>
            <i className="trc-st" data-status={agent.status} />
            <span>{subagentName(agent.name)}</span>
          </span>
          <span className="trc-track">
            {axis.breaks.map((gap) => (
              <i
                key={gap.at}
                className="trc-brk"
                style={{ left: pct(gap.at), width: pct(BREAK_SHARE) }}
              />
            ))}
            {bar && (
              <>
                <i
                  className="trc-fork"
                  aria-hidden="true"
                  style={{ left: pct(bar.x), height: row.below * ROW_HEIGHT }}
                />
                <i
                  className="trc-seg"
                  data-kind="subagent"
                  data-live={running || undefined}
                  role="img"
                  aria-label={t(
                    { id: 'trace.step.bar', defaultMessage: '{name} {when}, {duration}, {status}' },
                    {
                      name: subagentName(agent.name),
                      when: dayText(agent.start, view.to, { time: true }),
                      duration: durationText(end - agent.start),
                      status: STATUS_TEXT[agent.status],
                    },
                  )}
                  style={barStyle(bar.x, bar.to)}
                />
              </>
            )}
          </span>
        </div>
        <span className="trc-now" data-kind={busy ? 'subagent' : undefined}>
          {busy && subagentName(agent.name)}
        </span>
      </div>
    );
  }
  const { turn } = row;
  const start =
    turn.start === null
      ? t({ id: 'trace.turn.unknownStart', defaultMessage: 'Unknown' })
      : dayText(turn.start, view.to, { time: true });
  const end = turn.end ?? (turn.status === 'running' ? view.to : null);
  const length = turn.start === null || end === null ? null : durationText(end - turn.start);
  return (
    <div
      className="trc-row"
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      data-sel={focused || undefined}
      style={placed(turn.start)}
    >
      <button
        type="button"
        className="trc-head"
        aria-expanded={open}
        aria-label={
          length === null
            ? t(
                { id: 'trace.row.turn', defaultMessage: '{title} turn {start}, {status}' },
                { title: lane.title || untitledText(), start, status: STATUS_TEXT[turn.status] },
              )
            : t(
                {
                  id: 'trace.row.turnLasting',
                  defaultMessage: '{title} turn {start}, {duration}, {status}',
                },
                {
                  title: lane.title || untitledText(),
                  start,
                  duration: length,
                  status: STATUS_TEXT[turn.status],
                },
              )
        }
        onClick={() => onToggle(row)}
      >
        <span className="trc-tn">
          <ChevronRight className="trc-chev" aria-hidden="true" />
          <span>{start}</span>
          {turn.status !== 'ok' && (
            <i className="trc-st" data-status={turn.status} aria-hidden="true" />
          )}
        </span>
        <Track turns={[turn]} axis={axis} view={view} />
      </button>
    </div>
  );
});

/**
 * The session's states on the shared axis when they are known, else the turns' bars colored by
 * segment, over the axis's break marks.
 */
function Track({
  turns,
  states,
  axis,
  view,
}: {
  turns: readonly TraceTurn[];
  states?: readonly StateInterval[];
  axis: Axis;
  view: TraceWindow;
}) {
  const place = (from: number, to: number) => barStyle(axis.position(from), axis.position(to));
  return (
    <span className="trc-track" aria-hidden="true">
      {axis.breaks.map((gap) => (
        <i
          key={gap.at}
          className="trc-brk"
          style={{ left: pct(gap.at), width: pct(BREAK_SHARE) }}
        />
      ))}
      {states?.map((s, i) => {
        const kind = LANE_STATE[s.state];
        const from = Math.max(s.from, view.from);
        const to = Math.min(s.to ?? view.to, view.to);
        return kind && to > from ? (
          <i
            key={i}
            className="trc-seg"
            data-state={kind}
            data-live={(kind === 'run' && s.to === null) || undefined}
            style={place(from, to)}
          />
        ) : null;
      })}
      {!states &&
        turns.map((turn) => {
          const span = turnSpan(turn, view);
          if (!span) return null;
          return (
            <span key={turn.id}>
              <i className="trc-turn" style={place(...span)} />
              {turn.segments.map((seg, i) => {
                const from = Math.max(seg.from, view.from);
                const to = Math.min(seg.to, view.to);
                const live = turn.status === 'running' && i === turn.segments.length - 1;
                return to > from ? (
                  <i
                    key={i}
                    className="trc-seg"
                    data-kind={seg.kind}
                    data-live={live || undefined}
                    style={place(from, to)}
                  />
                ) : null;
              })}
            </span>
          );
        })}
    </span>
  );
}

/** The kind of the turn segment covering at; a running turn's last segment runs on to now. */
function segmentAt(turns: readonly TraceTurn[], at: number): SegmentKind | null {
  let found: SegmentKind | null = null;
  for (const turn of turns)
    turn.segments.forEach((seg, i) => {
      const end = turn.status === 'running' && i === turn.segments.length - 1 ? Infinity : seg.to;
      if (seg.from <= at && at <= end) found = seg.kind;
    });
  return found;
}

/** The model or tool call covering at that started last; a running call runs on to now. */
function callAt(spans: readonly TraceSpan[], at: number): TraceSpan | null {
  let found: TraceSpan | null = null;
  for (const span of spans) {
    if ((span.kind !== 'llm' && span.kind !== 'tool') || span.start === null) continue;
    const end = span.end ?? (span.status === 'running' ? Infinity : span.start);
    if (span.start <= at && at <= end && (!found || span.start >= found.start!)) found = span;
  }
  return found;
}

/** The window's activity by bucket; dragging across it picks the window the lanes show. */
function Strip({
  trace,
  full,
  bucketMs,
  label,
  range,
  onRange,
}: {
  trace: ProjectTrace;
  full: TraceWindow;
  bucketMs: number;
  label: string;
  range: TraceWindow | null;
  onRange: (range: TraceWindow | null) => void;
}) {
  const bars = useMemo(() => stripBars(trace.buckets, STRIP_HEIGHT), [trace.buckets]);
  const [drag, setDrag] = useState<{ x: number; a: number; b: number } | null>(null);
  const span = Math.max(1, full.to - full.from);
  const share = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
  };
  const sel = drag
    ? [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)]
    : range
      ? [(range.from - full.from) / span, (range.to - full.from) / span]
      : null;
  const [from, to] = range ? [range.from, range.to] : [full.from, full.to];
  const edgeKey =
    (edge: 'from' | 'to', value: number) => (e: ReactKeyboardEvent<HTMLSpanElement>) => {
      const moves: Partial<Record<string, number>> = {
        ArrowLeft: value - bucketMs,
        ArrowDown: value - bucketMs,
        ArrowRight: value + bucketMs,
        ArrowUp: value + bucketMs,
        Home: full.from,
        End: full.to,
      };
      const at = moves[e.key];
      if (at === undefined) return;
      e.preventDefault();
      const next =
        edge === 'from'
          ? { from: Math.max(full.from, Math.min(at, to - MIN_VIEW_MS)), to }
          : { from, to: Math.min(full.to, Math.max(at, from + MIN_VIEW_MS)) };
      onRange(next.from <= full.from && next.to >= full.to ? null : next);
    };
  return (
    <div
      className="trc-strip"
      role="group"
      aria-label={
        range
          ? t(
              {
                id: 'trace.strip.labelPicked',
                defaultMessage:
                  '{window} activity, {llm, plural, one {# model call} other {# model calls}}, {tool, plural, one {# tool call} other {# tool calls}}, selected {from} to {to}',
              },
              {
                window: label,
                llm: trace.stats.llm,
                tool: trace.stats.tool,
                from: dayText(range.from, full.to, { time: true }),
                to: dayText(range.to, full.to, { time: true }),
              },
            )
          : t(
              {
                id: 'trace.strip.label',
                defaultMessage:
                  '{window} activity, {llm, plural, one {# model call} other {# model calls}}, {tool, plural, one {# tool call} other {# tool calls}}',
              },
              { window: label, llm: trace.stats.llm, tool: trace.stats.tool },
            )
      }
      style={{ height: STRIP_HEIGHT }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const at = share(e);
        setDrag({ x: e.clientX, a: at, b: at });
      }}
      onPointerMove={(e) => {
        if (drag) setDrag({ ...drag, b: share(e) });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        setDrag(null);
        if (Math.abs(e.clientX - drag.x) < DRAG_MIN_PX) return;
        const b = share(e);
        onRange({
          from: full.from + Math.min(drag.a, b) * span,
          to: full.from + Math.max(drag.a, b) * span,
        });
      }}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={() => onRange(null)}
    >
      {bars.map((bar) => (
        <span
          key={bar.at}
          className="trc-bk"
          style={{ left: pct((bar.at - full.from) / span), width: pct(bucketMs / span) }}
        >
          {bar.error && <i className="trc-be" />}
          <i className="trc-bl" style={{ height: bar.llm }} />
          <i className="trc-bt" style={{ height: bar.tool }} />
        </span>
      ))}
      {sel && (
        <i className="trc-sel" style={{ left: pct(sel[0]!), width: pct(sel[1]! - sel[0]!) }} />
      )}
      <i className="trc-sph" />
      <span
        className="trc-edge"
        role="slider"
        tabIndex={0}
        aria-label={t({ id: 'trace.strip.from', defaultMessage: 'Selection start' })}
        aria-valuemin={full.from}
        aria-valuemax={to - MIN_VIEW_MS}
        aria-valuenow={from}
        aria-valuetext={dayText(from, full.to, { time: true })}
        style={{ left: pct((from - full.from) / span) }}
        onKeyDown={edgeKey('from', from)}
      />
      <span
        className="trc-edge"
        role="slider"
        tabIndex={0}
        aria-label={t({ id: 'trace.strip.to', defaultMessage: 'Selection end' })}
        aria-valuemin={from + MIN_VIEW_MS}
        aria-valuemax={full.to}
        aria-valuenow={to}
        aria-valuetext={dayText(to, full.to, { time: true })}
        style={{ right: pct((full.to - to) / span) }}
        onKeyDown={edgeKey('to', to)}
      />
    </div>
  );
}

/** Sessions by day: the project's commits on top, then one row of call levels per session. */
function Heatmap({
  heatmap,
  picked,
  onPick,
  onOpenDay,
}: {
  heatmap: ProjectHeatmap;
  picked: string | null;
  onPick: (lane: Picked) => void;
  onOpenDay: (lane: Picked, day: string) => void;
}) {
  const grid = useMemo(() => heatCells(heatmap), [heatmap]);
  const [measure, size] = useSize();
  const [top, setTop] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const heatRef = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      measure(el);
    },
    [measure],
  );
  // Today is the last column; keep it in view when the range or the width changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [grid.days.length, size.w]);
  // The header and the commit row, one row height each, sit above the session rows.
  const { first, last } = visibleWindow(
    grid.lanes.length,
    Math.max(0, top - 2 * ROW_HEIGHT),
    size.h,
  );
  const days = { gridTemplateColumns: `repeat(${grid.days.length}, minmax(0, 1fr))` };
  const width = {
    minWidth: `calc(220px + 3 * var(--sp-3) + ${grid.days.length * HEAT_CELL_PX}px)`,
  };
  if (grid.lanes.length === 0 && grid.commits.every((c) => c.count === 0))
    return (
      <Empty
        text={t(
          {
            id: 'trace.heat.empty',
            defaultMessage:
              '{days, plural, one {No sessions in the last day} other {No sessions in the last # days}}',
          },
          { days: grid.days.length },
        )}
      />
    );
  return (
    <div className="trc-heat" ref={heatRef} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
      <div className="trc-hh" style={width} aria-hidden="true">
        <span className="trc-hn" />
        <span className="trc-hds" style={days}>
          {grid.days.map((d) => (
            <span key={d} className="trc-hd" data-m={d.endsWith('-01') || undefined}>
              {dayLabel(d)}
            </span>
          ))}
        </span>
      </div>
      <div className="trc-hc" style={width}>
        <span className="trc-hn" />
        <span className="trc-hds" style={days}>
          {grid.commits.map((c) =>
            c.count ? (
              <span
                key={c.day}
                className="trc-hk"
                role="img"
                aria-label={t(
                  {
                    id: 'trace.heat.commits',
                    defaultMessage: '{day} {count, plural, one {# commit} other {# commits}}',
                  },
                  { day: dayName(c.day), count: c.count },
                )}
              >
                <i />
              </span>
            ) : (
              <span key={c.day} className="trc-hk" />
            ),
          )}
        </span>
      </div>
      <div
        className="trc-hrows"
        role="list"
        aria-label={t({ id: 'trace.lanes.label', defaultMessage: 'Sessions' })}
        style={{ ...width, height: grid.lanes.length * ROW_HEIGHT }}
      >
        {grid.lanes.slice(first, last + 1).map((lane, i) => {
          const index = first + i;
          const at = { key: lane.key, title: lane.title || untitledText() };
          return (
            <div
              key={lane.key}
              className="trc-hr"
              role="listitem"
              aria-posinset={index + 1}
              aria-setsize={grid.lanes.length}
              data-sel={lane.key === picked || undefined}
              style={{ top: index * ROW_HEIGHT }}
            >
              <button type="button" className="trc-hn" onClick={() => onPick(at)}>
                <span>{at.title}</span>
              </button>
              <span className="trc-hds" style={days}>
                {lane.cells.map((c) => (
                  <button
                    key={c.day}
                    type="button"
                    className="trc-hx"
                    data-level={c.level}
                    aria-label={t(
                      {
                        id: 'trace.heat.cell',
                        defaultMessage:
                          '{title} {day} {calls, plural, one {# call} other {# calls}}{errors, plural, =0 {} one {, # error} other {, # errors}}{commits, plural, =0 {} one {, # commit} other {, # commits}}',
                      },
                      {
                        title: at.title,
                        day: dayName(c.day),
                        calls: c.calls,
                        errors: c.errors,
                        commits: c.commits,
                      },
                    )}
                    onClick={() => onOpenDay(at, c.day)}
                  >
                    {c.error && <i className="trc-hxe" />}
                    {c.commits > 0 && <i className="trc-hxc" />}
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The project's calls by local hour: one row per hour under the same day columns. */
function HourHeatmap({
  heatmap,
  onOpenHour,
}: {
  heatmap: ProjectHeatmap;
  onOpenHour: (day: string, hour: number) => void;
}) {
  const grid = useMemo(() => hourCells(heatmap), [heatmap]);
  const [measure, size] = useSize();
  const scroller = useRef<HTMLDivElement | null>(null);
  const heatRef = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      measure(el);
    },
    [measure],
  );
  // Today is the last column; keep it in view when the range or the width changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [grid.days.length, size.w]);
  const days = { gridTemplateColumns: `repeat(${grid.days.length}, minmax(0, 1fr))` };
  const width = {
    minWidth: `calc(48px + var(--sp-3) + ${grid.days.length * HEAT_CELL_PX}px)`,
  };
  if (grid.hours.every((d) => d.cells.every((c) => c.calls === 0 && c.errors === 0)))
    return (
      <Empty
        text={t(
          {
            id: 'trace.hours.empty',
            defaultMessage:
              '{days, plural, one {No calls in the last day} other {No calls in the last # days}}',
          },
          { days: grid.days.length },
        )}
      />
    );
  return (
    <div className="trc-heat" ref={heatRef}>
      <div className="trc-hh" data-by="hour" style={width} aria-hidden="true">
        <span className="trc-hn" />
        <span className="trc-hds" style={days}>
          {grid.days.map((d) => (
            <span key={d} className="trc-hd" data-m={d.endsWith('-01') || undefined}>
              {dayLabel(d)}
            </span>
          ))}
        </span>
      </div>
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} className="trc-hy" style={width}>
          <span className="trc-hl" aria-hidden="true">
            {HOUR_MARKS.has(hour)
              ? t({ id: 'trace.hours.mark', defaultMessage: '{hour}:00' }, { hour })
              : ''}
          </span>
          <span className="trc-hds" style={days}>
            {grid.hours.map(({ day, cells }) => {
              const c = cells[hour]!;
              return (
                <button
                  key={day}
                  type="button"
                  className="trc-hx"
                  data-level={c.level}
                  aria-label={t(
                    {
                      id: 'trace.hours.cell',
                      defaultMessage:
                        '{day} {hour}:00 {calls, plural, one {# call} other {# calls}}{errors, plural, =0 {} one {, # error} other {, # errors}}',
                    },
                    { day: dayName(day), hour, calls: c.calls, errors: c.errors },
                  )}
                  onClick={() => onOpenHour(day, hour)}
                >
                  {c.errors > 0 && <i className="trc-hxe" />}
                </button>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One lane's totals, busiest tools and files, and commits. */
function Analysis({
  projectId,
  lane,
  over,
  now,
  panel,
  onClose,
  onTimeEvidence,
}: {
  projectId: string | null;
  lane: Picked;
  /** Lies over the lanes instead of beside them. */
  over: boolean;
  /** Where an open turn ends. */
  now: number;
  panel: RefObject<HTMLElement | null>;
  onClose: () => void;
  onTimeEvidence: (evidence: TraceTimeEvidence) => void;
}) {
  const trace = useSessionTrace(projectId, lane.key);
  const heat = useProjectHeatmap(projectId, 'all');
  const spans = trace.data?.spans;
  const live = spans?.some((span) => span.kind === 'turn' && span.status === 'running');
  const time = useTraceTime(projectId, lane.key, undefined, live ? now : undefined);
  const commits = heat.data?.commits;
  const stats = useMemo(() => spans && laneStats(spans, now), [spans, now]);
  const found = useMemo(
    () => spans && laneAnalysis(spans, commits ?? [], lane.key),
    [spans, commits, lane.key],
  );
  const nums = stats && found && statNums(stats, commits ? found.commits.length : null);
  return (
    <aside
      ref={panel}
      className="trc-an"
      aria-label={t({ id: 'trace.analysis.label', defaultMessage: 'Session analysis' })}
      data-over={over || undefined}
    >
      <div className="trc-an-h">
        <h2>{trace.data ? listedTitle(trace.data.lane) : lane.title}</h2>
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'trace.analysis.close', defaultMessage: 'Close session analysis' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      {trace.data && (
        <ReadStatus
          label={t({ id: 'trace.read.session', defaultMessage: 'Session trace' })}
          {...trace}
          inner
        />
      )}
      <TraceTimeChart query={time} titleOf={() => lane.title} onEvidence={onTimeEvidence} />
      {nums && stats && found ? (
        <>
          <div className="trc-nums">
            {nums.head.map(num)}
            {num([t({ id: 'trace.stat.errors', defaultMessage: 'Errors' }), String(stats.error)])}
            {nums.tail.map(num)}
          </div>
          {heat.data ? (
            <ReadStatus
              label={t({ id: 'trace.read.commits', defaultMessage: 'Commit history' })}
              {...heat}
              inner
            />
          ) : (
            heat.error && <Failure error={heat.error} onRetry={heat.reload} />
          )}
          {found.tools.length > 0 && (
            <ul
              className="trc-an-l"
              aria-label={t({ id: 'trace.analysis.tools', defaultMessage: 'Tools' })}
            >
              {found.tools.map((t) => (
                <li key={t.name}>
                  <span className="trc-an-t">{t.name}</span>
                  <b>{t.count}</b>
                </li>
              ))}
            </ul>
          )}
          {found.files.length > 0 && (
            <ul
              className="trc-an-l"
              aria-label={t({ id: 'trace.analysis.files', defaultMessage: 'Files' })}
            >
              {found.files.map((f) => (
                <li key={f.path}>
                  <span className="trc-an-p" title={f.path}>
                    <bdi>{f.path}</bdi>
                  </span>
                  <b>{f.count}</b>
                </li>
              ))}
            </ul>
          )}
          {found.commits.length > 0 && (
            <ul
              className="trc-an-l"
              aria-label={t({ id: 'trace.analysis.commits', defaultMessage: 'Commits' })}
            >
              {found.commits.map((c) => (
                <li key={c.sha}>
                  <code className="trc-an-sha">{c.sha.slice(0, 7)}</code>
                  <span className="trc-an-t" title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="trc-an-d">
                    <DiffCounts additions={c.added} deletions={c.removed} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : trace.error ? (
        <Failure error={trace.error} onRetry={trace.reload} />
      ) : (
        <Skeleton />
      )}
    </aside>
  );
}
