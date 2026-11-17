import {
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { GitCommitHorizontal, GitMerge } from 'lucide-react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { RepoLane, RepoTimeline } from '@pantheon/protocol';
import { runtimeName } from '../../../components/RuntimeGlyph';
import { ageText, useNow } from '../../../data/needs-you';
import { startRangeStory, useRangeStories, type RangeStory } from '../../../data/range-story';
import { useRepoTimeline } from '../../../data/repo';
import { elapsedText } from '../../../data/transcript';
import { currentLocale, t } from '../../../i18n';
import { listText } from '../../../lib/list-text';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { Empty, useSize } from '../../board/Charts';
import { shortSha } from '../history/CommitGraph';
import { openRepoView } from '../route';
import {
  axisTicks,
  DAY,
  fittedRange,
  openingSpan,
  laneBands,
  NAMED_SHARE,
  overviewDomain,
  readTimelineGroup,
  releaseLabels,
  readTimelineZoom,
  share,
  shiftedEnd,
  stackSpans,
  WEEK,
  ZOOMS,
  type LaneSpan,
  type TimelineGroup,
  type TimelineZoom,
} from './lanes-model';
import './timeline.css';

const zoomKey = (projectId: string) => `pantheon.repo.timeline-zoom.${projectId}`;

/** The stored zoom; null when none was ever picked. */
function storedZoom(projectId: string): TimelineZoom | null {
  try {
    const raw = localStorage.getItem(zoomKey(projectId));
    return raw === null ? null : readTimelineZoom(raw);
  } catch {
    return null;
  }
}

// The zoom picked on each project's lanes while the app runs.
let pickedZoom: Readonly<Record<string, TimelineZoom>> = {};
const zoomListeners = new Set<() => void>();
const subscribeZoom = (listener: () => void) => {
  zoomListeners.add(listener);
  return () => void zoomListeners.delete(listener);
};

export function pickTimelineZoom(projectId: string, zoom: TimelineZoom) {
  pickedZoom = { ...pickedZoom, [projectId]: zoom };
  zoomListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(zoomKey(projectId), zoom);
  } catch {
    // The choice still holds until the app closes.
  }
}

function useTimelineZoom(projectId: string): TimelineZoom | null {
  const read = () => pickedZoom[projectId];
  return useSyncExternalStore(subscribeZoom, read, read) ?? storedZoom(projectId);
}

const groupKey = (projectId: string) => `pantheon.repo.timeline-group.${projectId}`;

function storedGroup(projectId: string): TimelineGroup | null {
  try {
    return readTimelineGroup(localStorage.getItem(groupKey(projectId)));
  } catch {
    return null;
  }
}

// The grouping picked on each project's lanes while the app runs.
let pickedGroup: Readonly<Record<string, TimelineGroup>> = {};
const groupListeners = new Set<() => void>();
const subscribeGroup = (listener: () => void) => {
  groupListeners.add(listener);
  return () => void groupListeners.delete(listener);
};

export function pickTimelineGroup(projectId: string, group: TimelineGroup) {
  pickedGroup = { ...pickedGroup, [projectId]: group };
  groupListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(groupKey(projectId), group);
  } catch {
    // The choice still holds until the app closes.
  }
}

function useTimelineGroup(projectId: string): TimelineGroup | null {
  const read = () => pickedGroup[projectId];
  return useSyncExternalStore(subscribeGroup, read, read) ?? storedGroup(projectId);
}

const SPAN_STATES: Record<LaneSpan['state'], { tone: string; readonly label: string }> = {
  merged: {
    tone: '--ok',
    get label() {
      return t({ id: 'repo.timeline.state.merged', defaultMessage: 'Merged' });
    },
  },
  running: {
    tone: '--run',
    get label() {
      return t({ id: 'repo.timeline.state.running', defaultMessage: 'Running' });
    },
  },
  review: {
    tone: '--wait',
    get label() {
      return t({ id: 'repo.timeline.state.review', defaultMessage: 'Waiting for you' });
    },
  },
  failed: {
    tone: '--bad',
    get label() {
      return t({ id: 'repo.timeline.state.failed', defaultMessage: 'Failed' });
    },
  },
  idle: {
    tone: '--idle',
    get label() {
      return t({ id: 'repo.timeline.state.idle', defaultMessage: 'Idle' });
    },
  },
  archived: {
    tone: '--idle',
    get label() {
      return t({ id: 'repo.timeline.state.archived', defaultMessage: 'Archived' });
    },
  },
};

const tone = (token: string) => ({ '--rl-c': `var(${token})` }) as CSSProperties;

const stamp = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

const day = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(at);

function rangeText(from: number, to: number) {
  const format = new Intl.DateTimeFormat(
    currentLocale(),
    to - from <= DAY
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { month: 'short', day: 'numeric' },
  );
  return t(
    { id: 'repo.timeline.range', defaultMessage: '{from} to {to}' },
    { from: format.format(from), to: format.format(to) },
  );
}

type Picked = { kind: 'span'; span: LaneSpan } | { kind: 'commit'; sha: string; at: number };

const pct = (value: number) => `${value * 100}%`;

/** The project's lanes over the zoomed range, the whole history under them and the range's facts. */
export function RepoLanes({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const chosen = useTimelineZoom(projectId);
  const zoom = chosen ?? 'fortnight';
  const group = useTimelineGroup(projectId) ?? ZOOMS[zoom].group;
  const now = useNow(60_000);
  const [end, setEnd] = useState(() => Date.now());
  // The span set by fitting the whole history; null while the zoom sets it.
  const [fitted, setFitted] = useState<number | null>(null);
  // Until a zoom is picked, the first reads open on the newest story, or fit a young history's range to its commits.
  const [opened, setOpened] = useState(false);
  const span = fitted ?? ZOOMS[zoom].span;
  const from = end - span;
  const timeline = useRepoTimeline(projectId, from, end, group);
  const stories = useRangeStories(projectId);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [lanesRef, lanesSize] = useSize();
  const [drag, setDrag] = useState<{ x: number; width: number; by: number } | null>(null);
  // sending is true while the start request is out.
  const [asked, setAsked] = useState<{
    from: number;
    to: number;
    error: string | null;
    sending: boolean;
  } | null>(null);
  const read = timeline.read;
  if (read && (stories.read || stories.error) && !opened) {
    setOpened(true);
    const newest = stories.read?.reduce<RangeStory | null>(
      (best, s) => (!best || Date.parse(s.created_at) > Date.parse(best.created_at) ? s : best),
      null,
    );
    if (chosen === null && newest) {
      setFitted(newest.to - newest.from);
      setEnd(newest.to);
    } else {
      const opening = chosen === null ? openingSpan(read.extent, end) : null;
      if (opening !== null) setFitted(opening);
    }
  }
  const domain = overviewDomain(read?.overview ?? [], from, end, Math.max(now, end));
  const brushEnd = drag
    ? shiftedEnd(end, span, (drag.by / drag.width) * (domain.hi - domain.lo), domain)
    : end;
  const range = rangeText(from, end);

  const pickZoom = (next: TimelineZoom) => {
    pickTimelineZoom(projectId, next);
    setFitted(null);
    setEnd(Date.now());
  };
  const fitAll = (extent: { first: number; last: number }) => {
    const fit = fittedRange(extent);
    setFitted(fit.to - fit.from);
    setEnd(fit.to);
  };
  const moveBrush = (by: number) => setEnd(shiftedEnd(end, span, by, domain));
  const onBrushKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'ArrowLeft') moveBrush(-span / 4);
    else if (e.key === 'ArrowRight') moveBrush(span / 4);
    else return;
    e.preventDefault();
  };
  const brushHandlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const width = e.currentTarget.parentElement?.clientWidth || 1;
      setDrag({ x: e.clientX, width, by: 0 });
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (drag) setDrag({ ...drag, by: e.clientX - drag.x });
    },
    onPointerUp: () => {
      if (!drag) return;
      setEnd(brushEnd);
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  };

  const story = stories.read?.find((s) => s.from === from && s.to === end) ?? null;
  const askedHere = asked && asked.from === from && asked.to === end ? asked : null;
  const generate = async () => {
    setAsked({ from, to: end, error: null, sending: true });
    const result = await startRangeStory(projectId, from, end);
    setAsked({ from, to: end, error: result.ok ? null : result.error, sending: false });
    if (result.ok) stories.reload();
  };

  const current = read && read.from === from && read.to === end ? read : null;
  const mainLane = current?.lanes.find((lane) => lane.kind === 'main');
  // The story explains the range's merges, or else its commits on the main line.
  const untold =
    !!current && (mainLane ? laneCommits(mainLane) : 0) === 0 && current.totals.merges === 0;

  const brushFrom = brushEnd - span;
  return (
    <div className="rl-wrap">
      <div className="rl-bar">
        <RadioGroup<TimelineZoom | ''>
          className="tb-seg"
          aria-label={t({ id: 'repo.timeline.zoom', defaultMessage: 'Time range' })}
          value={fitted === null ? zoom : ''}
          onValueChange={(next) => pickZoom(next as TimelineZoom)}
        >
          <Radio.Root value="quarter">
            {t({ id: 'repo.timeline.quarter', defaultMessage: 'Quarter' })}
          </Radio.Root>
          <Radio.Root value="fortnight">
            {t({ id: 'repo.timeline.fortnight', defaultMessage: 'Two weeks' })}
          </Radio.Root>
          <Radio.Root value="today">
            {t({ id: 'repo.timeline.today', defaultMessage: 'Today' })}
          </Radio.Root>
        </RadioGroup>
        <span className="rl-b rl-num">{range}</span>
        <span className="rl-sep" />
        <RadioGroup<TimelineGroup>
          className="tb-seg"
          aria-label={t({ id: 'repo.timeline.group', defaultMessage: 'Group lanes by' })}
          value={group}
          onValueChange={(next) => pickTimelineGroup(projectId, next)}
        >
          <Radio.Root value="workstream">
            {t({ id: 'repo.timeline.groupWorkstream', defaultMessage: 'Workstream' })}
          </Radio.Root>
          <Radio.Root value="branch">
            {t({ id: 'repo.timeline.groupBranch', defaultMessage: 'Branch' })}
          </Radio.Root>
          <Radio.Root value="author">
            {t({ id: 'repo.timeline.groupAuthor', defaultMessage: 'Author' })}
          </Radio.Root>
        </RadioGroup>
        <span className="rl-end">
          <span className="legend">
            {(['merged', 'running', 'review'] as const).map((state) => (
              <span key={state}>
                <i className="rl-dot" style={tone(SPAN_STATES[state].tone)} />
                {SPAN_STATES[state].label}
              </span>
            ))}
            <span>
              <i className="rl-dot" style={tone('--bad')} />
              {t({ id: 'repo.timeline.legendBad', defaultMessage: 'Failed or reverted' })}
            </span>
          </span>
          <button
            type="button"
            className="btn ghost sm"
            disabled={!read?.extent}
            onClick={() => read?.extent && fitAll(read.extent)}
          >
            {t({ id: 'repo.timeline.fitAll', defaultMessage: 'Fit all' })}
          </button>
        </span>
      </div>
      <section
        className="rl-main"
        aria-label={t({ id: 'repo.timeline.label', defaultMessage: 'Project timeline' })}
      >
        {read ? (
          lanesPart(
            read,
            read.from !== from || read.to !== end,
            picked,
            setPicked,
            lanesRef,
            lanesSize.w,
          )
        ) : timeline.error ? (
          <Failure error={timeline.error} onRetry={timeline.reload} />
        ) : (
          <Skeleton />
        )}
        <div className="rl-mm">
          <span className="rl-lh mu">
            {t({ id: 'repo.timeline.history', defaultMessage: 'All history' })}
          </span>
          <div className="rl-mmt">
            {read && overviewBars(read.overview, domain)}
            <span
              className="rl-brush"
              role="slider"
              tabIndex={0}
              aria-label={t({ id: 'repo.timeline.brush', defaultMessage: 'Current range' })}
              aria-valuemin={domain.lo}
              aria-valuemax={domain.hi}
              aria-valuenow={brushEnd}
              aria-valuetext={rangeText(brushFrom, brushEnd)}
              data-dragging={drag ? '' : undefined}
              style={{
                left: pct(share(brushFrom, domain.lo, domain.hi)),
                width: pct(span / Math.max(1, domain.hi - domain.lo)),
              }}
              onKeyDown={onBrushKey}
              {...brushHandlers}
            />
          </div>
        </div>
      </section>
      <aside
        className="rl-side"
        aria-label={t({ id: 'repo.timeline.side', defaultMessage: 'Range and selection' })}
      >
        <section className="rl-sec">
          <div className="rl-sh">
            <span className="rl-b rl-num">{range}</span>
            <span className="legend">
              <span>
                <i className="rl-dot" style={tone('--series-1')} />
                {t({ id: 'repo.timeline.agent', defaultMessage: 'agent' })}
              </span>
              <span>
                <i className="rl-dot" style={tone('--series-5')} />
                {t({ id: 'repo.timeline.you', defaultMessage: 'You' })}
              </span>
            </span>
          </div>
          {totalsPanel(current?.totals ?? null)}
          {storyPart({
            story,
            now,
            busy: !!askedHere && (askedHere.sending || (!askedHere.error && !story)),
            untold,
            error: askedHere?.error ?? null,
            onGenerate: () => void generate(),
          })}
        </section>
        {picked && pickedPart(picked, projectId, onOpenSession)}
      </aside>
    </div>
  );
}

function lanesPart(
  timeline: RepoTimeline,
  busy: boolean,
  picked: Picked | null,
  onPick: (picked: Picked) => void,
  ref: (el: HTMLElement | null) => void,
  width: number,
) {
  if (timeline.lanes.length === 0)
    return (
      <Empty
        text={t({ id: 'repo.timeline.empty', defaultMessage: 'Nothing on the timeline yet' })}
      />
    );
  const { from, to } = timeline;
  const ticks = axisTicks(from, to);
  const tickFormat = new Intl.DateTimeFormat(
    currentLocale(),
    ticks.unit === 'hour'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : ticks.unit === 'day'
        ? { month: 'numeric', day: 'numeric' }
        : { month: 'short' },
  );
  // The track is the lanes' width less the name column and the right gap, as .rl-rel places it.
  const named = releaseLabels(timeline.releases, from, to, Math.max(0, width - 176));
  return (
    <div className="rl-lanes" aria-busy={busy || undefined} ref={ref}>
      <div className="rl-ax">
        <span className="rl-lh mu">
          {timeline.lanes.some((l) => l.kind === 'author' || l.kind === 'runtime')
            ? t({ id: 'repo.timeline.byAuthor', defaultMessage: 'Authors' })
            : timeline.lanes.some((l) => l.kind === 'branch')
              ? t({ id: 'repo.timeline.byBranch', defaultMessage: 'Branches' })
              : t({ id: 'repo.timeline.byWorkstream', defaultMessage: 'Workstreams' })}
        </span>
        <div className="rl-trk">
          {ticks.at.map((at) => (
            <span key={at} className="rl-tk" style={{ left: pct(share(at, from, to)) }}>
              {tickFormat.format(at)}
            </span>
          ))}
        </div>
      </div>
      {timeline.lanes.map((lane) => laneRow(lane, timeline, picked, onPick))}
      {timeline.releases.map((release, i) => (
        <i
          key={release.sha + release.name}
          className="rl-rel"
          title={listText(release.name, stamp(release.at))}
          style={{ '--rl-at': share(release.at, from, to) } as CSSProperties}
        >
          {named[i] && <span className="mono">{release.name}</span>}
        </i>
      ))}
    </div>
  );
}

const laneCommits = (lane: RepoLane) =>
  lane.points?.length ?? (lane.bins ?? []).reduce((n, b) => n + b.commits, 0);
const laneMerges = (lane: RepoLane) =>
  lane.points?.filter((p) => p.kind === 'merge').length ??
  (lane.bins ?? []).reduce((n, b) => n + b.merges, 0);

function laneRow(
  lane: RepoLane,
  timeline: RepoTimeline,
  picked: Picked | null,
  onPick: (picked: Picked) => void,
) {
  const { from, to, bin_ms } = timeline;
  const range = Math.max(1, to - from);
  const at = (time: number) => pct(share(time, from, to));
  const stacked = stackSpans(lane.spans, to);
  const bands = laneBands(lane, stacked.rows);
  const isMain = lane.kind === 'main';
  const name =
    lane.kind === 'other'
      ? t({ id: 'repo.timeline.otherLane', defaultMessage: 'Other' })
      : lane.kind === 'runtime'
        ? runtimeName(lane.label)
        : lane.label;
  const commits = laneCommits(lane);
  const meta = isMain
    ? t(
        {
          id: 'repo.timeline.merges',
          defaultMessage: '{count, plural, one {# merge} other {# merges}}',
        },
        { count: laneMerges(lane) },
      )
    : t(
        {
          id: 'repo.timeline.commits',
          defaultMessage: '{count, plural, one {# commit} other {# commits}}',
        },
        { count: commits },
      );
  const toneOf = (sessionId?: string) => {
    const owner = sessionId ? lane.spans.find((s) => s.session_id === sessionId) : undefined;
    return owner ? SPAN_STATES[owner.state].tone : isMain ? '--ok' : '--tx2';
  };
  const bins = lane.bins ?? [];
  const binTime = (time: number) => (bin_ms >= DAY ? day(time) : stamp(time));
  const binValue = (b: { commits: number; merges: number }) => (isMain ? b.merges : b.commits);
  const binMax = Math.max(1, ...bins.map(binValue));
  return (
    <div key={lane.key} className="rl-ln" role="group" aria-label={name}>
      <div className="rl-lh">
        <span className={lane.kind === 'other' ? 'rl-cut mu' : 'rl-b rl-cut'} title={name}>
          <span className={lane.kind === 'main' || lane.kind === 'branch' ? 'mono' : undefined}>
            {name}
          </span>
        </span>
        <span className="rl-cut mu rl-num">
          {lane.merged_lanes
            ? listText(
                t(
                  {
                    id: 'repo.timeline.mergedLanes',
                    defaultMessage:
                      '{count, plural, one {# lane folded in} other {# lanes folded in}}',
                  },
                  { count: lane.merged_lanes },
                ),
                meta,
              )
            : meta}
        </span>
      </div>
      <div className="rl-trk" style={{ height: bands.height }}>
        <div
          className="rl-marks"
          role="img"
          aria-label={t(
            {
              id: 'repo.timeline.laneLabel',
              defaultMessage:
                '{lane}: {commits, plural, one {# commit} other {# commits}}, {sessions, plural, one {# session} other {# sessions}}, {gates, plural, one {# gate run} other {# gate runs}}',
            },
            { lane: name, commits, sessions: lane.spans.length, gates: lane.gates.length },
          )}
        >
          {bands.turns !== null &&
            lane.turns!.map((turn) => (
              <i
                key={turn.turn_id}
                className="rl-turn"
                title={t(
                  { id: 'repo.timeline.turnTitle', defaultMessage: 'Turn started, {time}' },
                  { time: stamp(turn.at) },
                )}
                style={{ left: at(turn.at), top: bands.turns! }}
              />
            ))}
          {bands.bins !== null &&
            bins.map((bin) => {
              const value = binValue(bin);
              const height = value ? Math.max(2, Math.round((value / binMax) * 28)) : 0;
              return (
                <i
                  key={bin.start}
                  className="rl-bin"
                  title={
                    isMain
                      ? t(
                          {
                            id: 'repo.timeline.binMerges',
                            defaultMessage:
                              '{time}: {count, plural, one {# merge} other {# merges}}',
                          },
                          { time: binTime(bin.start), count: value },
                        )
                      : t(
                          {
                            id: 'repo.timeline.binCommits',
                            defaultMessage:
                              '{time}: {count, plural, one {# commit} other {# commits}}',
                          },
                          { time: binTime(bin.start), count: value },
                        )
                  }
                  style={{
                    ...tone(isMain ? '--ok' : '--tx2'),
                    left: at(bin.start),
                    width: pct(bin_ms / range),
                    top: bands.bins! + 28 - height,
                    height,
                  }}
                />
              );
            })}
          {bands.gates !== null &&
            lane.gates.map((gate, i) => (
              <i
                key={i}
                className="rl-gate"
                data-failed={gate.passed ? undefined : ''}
                title={t(
                  {
                    id: 'repo.timeline.gateTitle',
                    defaultMessage:
                      '{result, select, passed {Gate passed} other {Gate failed}}, {time}',
                  },
                  { result: gate.passed ? 'passed' : 'failed', time: stamp(gate.at) },
                )}
                style={{
                  ...tone(gate.passed ? '--ok' : '--bad'),
                  left: at(gate.at),
                  top: bands.gates!,
                }}
              />
            ))}
        </div>
        {stacked.placed.map(({ span, row }) => {
          const start = Math.max(span.start, from);
          const width = (Math.min(span.end ?? to, to) - start) / range;
          const state = SPAN_STATES[span.state];
          const label = listText(span.title, state.label, span.branch);
          return (
            <button
              key={span.session_id}
              type="button"
              className="rl-span"
              aria-label={label}
              title={label}
              aria-pressed={picked?.kind === 'span' && picked.span.session_id === span.session_id}
              style={{
                ...tone(state.tone),
                left: at(start),
                width: pct(Math.max(0.006, width)),
                top: bands.spans! + row * 20,
              }}
              onClick={() => onPick({ kind: 'span', span })}
            >
              {width >= NAMED_SHARE ? span.title : null}
            </button>
          );
        })}
        {stacked.hidden > 0 && (
          <span
            className="rl-more mu"
            style={{ top: bands.spans! + (stacked.rows - 1) * 20 }}
            title={t(
              {
                id: 'repo.timeline.moreSpans',
                defaultMessage:
                  '{count, plural, one {# more session} other {# more sessions}} not drawn',
              },
              { count: stacked.hidden },
            )}
          >
            +{stacked.hidden}
          </span>
        )}
        {bands.points !== null &&
          lane.points!.map((point) => {
            const label = t(
              {
                id: 'repo.timeline.pointTitle',
                defaultMessage:
                  '{kind, select, merge {Merge {sha}} revert {Revert {sha}} other {Commit {sha}}}, {time}',
              },
              { kind: point.kind, sha: shortSha(point.sha), time: stamp(point.at) },
            );
            return (
              <button
                key={point.sha}
                type="button"
                className={point.kind === 'revert' ? 'rl-revert' : 'rl-point'}
                aria-label={label}
                title={label}
                aria-pressed={picked?.kind === 'commit' && picked.sha === point.sha}
                style={{
                  ...tone(point.kind === 'revert' ? '--bad' : toneOf(point.session_id)),
                  left: at(point.at),
                  top: bands.points!,
                }}
                onClick={() => onPick({ kind: 'commit', sha: point.sha, at: point.at })}
              />
            );
          })}
      </div>
    </div>
  );
}

function overviewBars(overview: RepoTimeline['overview'], domain: { lo: number; hi: number }) {
  const width = Math.max(1, domain.hi - domain.lo);
  const max = Math.max(1, ...overview.map((w) => w.agent + w.user));
  const sum = (key: 'agent' | 'user') => overview.reduce((n, w) => n + w[key], 0);
  const height = (n: number) => Math.round((n / max) * 40);
  return (
    <div
      className="rl-mmbars"
      role="img"
      aria-label={t(
        {
          id: 'repo.timeline.overviewLabel',
          defaultMessage:
            'Commits by week over the whole history: {agent} by agents, {user} by you',
        },
        { agent: sum('agent'), user: sum('user') },
      )}
    >
      {overview.map((week) => (
        <span
          key={week.start}
          className="rl-mb"
          title={listText(
            day(week.start),
            t(
              { id: 'repo.timeline.weekAgent', defaultMessage: 'agent {count}' },
              { count: week.agent },
            ),
            t(
              { id: 'repo.timeline.weekUser', defaultMessage: 'you {count}' },
              { count: week.user },
            ),
          )}
          style={{
            left: pct((week.start - domain.lo) / width),
            width: pct(WEEK / width),
          }}
        >
          <i className="rl-user" style={{ height: height(week.user) }} />
          <i className="rl-agent" style={{ height: height(week.agent) }} />
        </span>
      ))}
    </div>
  );
}

function totalsPanel(totals: RepoTimeline['totals'] | null) {
  const number = new Intl.NumberFormat(currentLocale());
  const cells = [
    {
      key: 'commits',
      cap: t({ id: 'repo.timeline.kpiCommits', defaultMessage: 'Commits' }),
      value: totals ? number.format(totals.commits) : null,
    },
    {
      key: 'merges',
      cap: t({ id: 'repo.timeline.kpiMerges', defaultMessage: 'Merges' }),
      value: totals ? number.format(totals.merges) : null,
    },
    {
      key: 'gate',
      cap: t({ id: 'repo.timeline.kpiGate', defaultMessage: 'Gate first-pass rate' }),
      // Without a merge in the range there is nothing a first pass let through.
      value: totals
        ? totals.gate_first_pass === null || totals.merges === 0
          ? '—'
          : new Intl.NumberFormat(currentLocale(), { style: 'percent' }).format(
              totals.gate_first_pass,
            )
        : null,
    },
  ];
  return (
    <div className="panel rl-kpis" aria-busy={totals ? undefined : true}>
      {cells.map((cell) => (
        <div key={cell.key} className="cell">
          <span className="cap">{cell.cap}</span>
          <span className="kpi">{cell.value ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

function storyPart({
  story,
  now,
  busy,
  untold,
  error,
  onGenerate,
}: {
  story: RangeStory | null;
  now: number;
  busy: boolean;
  /** The range has no merges and no main-line commits to explain. */
  untold: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const title = t({ id: 'repo.timeline.story', defaultMessage: 'Range story' });
  const failure = error ?? (story?.state === 'failed' ? (story.error ?? null) : null);
  const alert = failure && (
    <p className="rl-err" role="alert">
      {failure}
    </p>
  );
  if (story?.state === 'ready') {
    // A story without a source told merges.
    const commits = story.source === 'commits';
    const Mark = commits ? GitCommitHorizontal : GitMerge;
    return (
      <div className="rl-story">
        <div className="rl-sh">
          <span className="rl-sth">
            <span className="rl-b">{title}</span>
            <span className="chip">
              <Mark size={12} aria-hidden="true" />
              {commits
                ? t({ id: 'repo.timeline.storyFromCommits', defaultMessage: 'From commits' })
                : t({ id: 'repo.timeline.storyFromMerges', defaultMessage: 'From merges' })}
            </span>
          </span>
          <time className="mu" dateTime={story.created_at}>
            {ageText(Date.parse(story.created_at), now)}
          </time>
        </div>
        {story.lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
        <div className="rl-acts">
          <button type="button" className="btn ghost sm" disabled={busy} onClick={onGenerate}>
            {t({ id: 'repo.timeline.storyAgain', defaultMessage: 'Interpret again' })}
          </button>
        </div>
        {alert}
      </div>
    );
  }
  if (story?.state === 'running')
    return (
      <div className="rl-story" aria-busy="true">
        <div className="rl-sh">
          <span className="rl-b">{title}</span>
          <StoryElapsed since={Date.parse(story.created_at)} />
        </div>
      </div>
    );
  return (
    <div className="rl-story">
      <div className="rl-acts">
        <button
          type="button"
          className="btn sm"
          disabled={busy || untold}
          aria-busy={busy || undefined}
          onClick={onGenerate}
        >
          {t({ id: 'repo.timeline.storyStart', defaultMessage: 'Interpret this range' })}
        </button>
      </div>
      {alert}
    </div>
  );
}

function StoryElapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <span className="mu rl-num">
      {t(
        { id: 'repo.timeline.storyRunning', defaultMessage: 'Interpreting, {elapsed}' },
        { elapsed: elapsedText(Math.floor(Math.max(0, now - since) / 1000) * 1000) },
      )}
    </span>
  );
}

function pickedPart(picked: Picked, projectId: string, onOpenSession: (sessionId: string) => void) {
  if (picked.kind === 'commit')
    return (
      <section
        className="rl-sec"
        aria-label={t({ id: 'repo.timeline.picked', defaultMessage: 'Selected' })}
      >
        <span className="cap">{t({ id: 'repo.timeline.picked', defaultMessage: 'Selected' })}</span>
        <dl className="rl-kv">
          <dt>{t({ id: 'repo.timeline.commit', defaultMessage: 'Commit' })}</dt>
          <dd className="mono">{shortSha(picked.sha)}</dd>
          <dt>{t({ id: 'repo.timeline.time', defaultMessage: 'Time' })}</dt>
          <dd>
            <time dateTime={new Date(picked.at).toISOString()}>{stamp(picked.at)}</time>
          </dd>
        </dl>
        <div className="rl-acts">
          <button
            type="button"
            className="btn sm"
            onClick={() => openRepoView(projectId, { kind: 'commit', sha: picked.sha })}
          >
            {t({ id: 'repo.timeline.openCommit', defaultMessage: 'Open commit' })}
          </button>
        </div>
      </section>
    );
  const { span } = picked;
  const state = SPAN_STATES[span.state];
  return (
    <section
      className="rl-sec"
      aria-label={t({ id: 'repo.timeline.picked', defaultMessage: 'Selected' })}
    >
      <span className="cap">{t({ id: 'repo.timeline.picked', defaultMessage: 'Selected' })}</span>
      <div className="rl-sh">
        <span className="rl-b rl-cut">{span.title}</span>
        <span className="chip rl-state" style={tone(state.tone)}>
          {state.label}
        </span>
      </div>
      <dl className="rl-kv">
        <dt>{t({ id: 'repo.timeline.branch', defaultMessage: 'Branch' })}</dt>
        <dd className="mono">{span.branch ?? '—'}</dd>
      </dl>
      <div className="rl-acts">
        <button
          type="button"
          className="btn sm"
          onClick={() => openRepoView(projectId, { kind: 'session', sessionId: span.session_id })}
        >
          {t({ id: 'repo.timeline.openPassage', defaultMessage: 'Open branch passage' })}
        </button>
        <button type="button" className="btn sm" onClick={() => onOpenSession(span.session_id)}>
          {t({ id: 'repo.timeline.openSession', defaultMessage: 'Open session' })}
        </button>
      </div>
    </section>
  );
}
