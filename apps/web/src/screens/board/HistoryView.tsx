import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ChevronDown, ChevronRight, Flag, RotateCcw, Route, Undo2 } from 'lucide-react';
import type { BoardHistory, BoardTaskState } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { ModelMark, RuntimeGlyph } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { currentProject, useCurrentProject } from '../../data/current-project';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import {
  currentMilestone,
  dayNumber,
  historyLayout,
  historySummary,
  LABEL_W,
  sparkPath,
  type HistoryBands,
  type HistoryDecision,
  type HistoryRange,
  type HistoryRow,
  type HistoryTask,
} from './history-model';
import { durationText } from './panels-model';
import {
  runtimeName,
  STATE,
  StateIcon,
  StatusIcon,
  TASK_STATE_TONE,
  TASK_TYPE,
  type TaskType,
} from './status';
import './history.css';

const BANDS: { key: HistoryBands; label: () => string }[] = [
  {
    key: 'lanes',
    label: () => t({ id: 'board.history.bands.lanes', defaultMessage: 'Work lines' }),
  },
  { key: 'type', label: () => t({ id: 'board.history.bands.type', defaultMessage: 'Type' }) },
  { key: 'model', label: () => t({ id: 'board.history.bands.model', defaultMessage: 'Model' }) },
];

const RANGES: { key: HistoryRange; label: () => string }[] = [
  { key: 'all', label: () => t({ id: 'board.history.range.all', defaultMessage: 'All' }) },
  {
    key: 'month',
    label: () => t({ id: 'board.history.range.month', defaultMessage: 'Last 30 days' }),
  },
  {
    key: 'milestone',
    label: () => t({ id: 'board.history.range.milestone', defaultMessage: 'Current milestone' }),
  },
];

export interface HistoryRangeControlProps {
  value: HistoryRange;
  onValueChange: (range: HistoryRange) => void;
  /** Whether a milestone is open; the current milestone range needs one. */
  hasMilestone: boolean;
}

/** The whole history's range: all, the last 30 days or the current milestone. */
export function HistoryRangeControl({
  value,
  onValueChange,
  hasMilestone,
}: HistoryRangeControlProps) {
  return (
    <RadioGroup<HistoryRange>
      className="tb-seg"
      aria-label={t({ id: 'board.history.range', defaultMessage: 'Range' })}
      value={value}
      onValueChange={onValueChange}
    >
      {RANGES.map((r) => (
        <Radio.Root key={r.key} value={r.key} disabled={r.key === 'milestone' && !hasMilestone}>
          {r.label()}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

const CARD_W = 248;

/** An axis tick: the month, with the day on the first tick. */
const tickText = (at: number, day: boolean) =>
  new Intl.DateTimeFormat(
    currentLocale(),
    day ? { month: 'short', day: 'numeric' } : { month: 'short' },
  ).format(at);

const glyph = (task: HistoryTask): BoardTaskState =>
  task.state === 'removed' ? 'merged' : task.state;

const sessionOf = (task: HistoryTask) => task.session_id ?? task.owner_session_id;

/** The card's commit, changed lines and time taken; null when none is known. */
function taskFacts(task: HistoryTask) {
  const took =
    task.started_at !== null && task.merged_at !== null ? task.merged_at - task.started_at : null;
  if (task.commit === null && task.additions === null && task.deletions === null && took === null)
    return null;
  return (
    <span className="bd-hs-cm">
      {task.commit !== null && <span className="bd-hs-sha">{task.commit.slice(0, 7)}</span>}
      <DiffCounts additions={task.additions} deletions={task.deletions} />
      {took !== null && <span className="bd-hs-took">{durationText(took)}</span>}
    </span>
  );
}

function taskLabel(task: HistoryTask, now: number): string {
  if (task.merged_at === null) return task.title;
  return task.handbacks
    ? t(
        {
          id: 'board.history.dotReworked',
          defaultMessage:
            '{title}, merged {date}, reworked {count, plural, one {# time} other {# times}}',
        },
        { title: task.title, date: dayText(task.merged_at, now), count: task.handbacks },
      )
    : t(
        { id: 'board.history.dot', defaultMessage: '{title}, merged {date}' },
        { title: task.title, date: dayText(task.merged_at, now) },
      );
}

function decisionText({ kind, title }: HistoryDecision): string {
  if (kind === 'plan')
    return title ?? t({ id: 'board.history.decision.plan', defaultMessage: 'Plan' });
  if (kind === 'start')
    return title === undefined
      ? t({ id: 'board.history.decision.startMany', defaultMessage: 'Start several tasks' })
      : t({ id: 'board.history.decision.start', defaultMessage: 'Start {title}' }, { title });
  if (kind === 'stop')
    return title === undefined
      ? t({ id: 'board.history.decision.stopMany', defaultMessage: 'Stop several tasks' })
      : t({ id: 'board.history.decision.stop', defaultMessage: 'Stop {title}' }, { title });
  return title === undefined
    ? t({ id: 'board.history.decision.acceptMany', defaultMessage: 'Accept several tasks' })
    : t({ id: 'board.history.decision.accept', defaultMessage: 'Accept {title}' }, { title });
}

/** How often the task was handed back, and why when that is known. */
function reworkText(task: HistoryTask): string {
  const total = t(
    {
      id: 'board.history.rework',
      defaultMessage: 'Reworked {count, plural, one {# time} other {# times}}',
    },
    { count: task.handbacks },
  );
  const why = task.handback_reasons;
  if (!why) return total;
  return t(
    { id: 'board.history.reworkWhy', defaultMessage: '{total}: {reasons}' },
    {
      total,
      reasons: listText(
        why.gate > 0 &&
          t(
            {
              id: 'board.history.reason.gate',
              defaultMessage: '{count, plural, one {gate # time} other {gate # times}}',
            },
            { count: why.gate },
          ),
        why.review > 0 &&
          t(
            {
              id: 'board.history.reason.review',
              defaultMessage:
                '{count, plural, one {sent back in review # time} other {sent back in review # times}}',
            },
            { count: why.review },
          ),
        why.other > 0 &&
          t(
            {
              id: 'board.history.reason.other',
              defaultMessage: '{count, plural, one {other # time} other {other # times}}',
            },
            { count: why.other },
          ),
      ),
    },
  );
}

const percentText = (share: number) =>
  new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(
    share,
  );

const SPARK_W = 160;
const SPARK_H = 28;

interface HistoryViewProps {
  history: BoardHistory;
  lanes: readonly { id: string; title: string }[];
  now: number;
  /** The board's milestones, for the due days of the ones not reached yet. */
  milestones: readonly { id: string; due_on?: string }[];
  onOpenSession: (sessionId: string) => void;
  /** Shows the task in the now view. */
  onOpenTask: (taskId: string) => void;
  /** The board bar's element the range control goes in, once it is in. */
  bar?: HTMLElement | null;
}

/** The project from its first day to now: merges by work line, milestones, idle stretches. */
export function HistoryView({
  history,
  lanes,
  now,
  milestones,
  onOpenSession,
  onOpenTask,
  bar,
}: HistoryViewProps) {
  const storedProject = useCurrentProject((s) => s.projectId);
  const project = useBoard((s) => currentProject(s.board, storedProject)?.name ?? null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState<HistoryRange>('all');
  const [bands, setBands] = useState<HistoryBands>('lanes');
  const [critical, setCritical] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** The task whose card shows; pinned by a click, else it follows hover and focus. */
  const [card, setCard] = useState<{ id: string; pinned: boolean } | null>(null);
  const [titleWidth, setTitleWidth] = useState(0);
  const cardBox = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = box.current!;
    setWidth(el.clientWidth);
    // The plot's padding lies outside the drawn width.
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (card?.pinned) cardBox.current?.querySelector('button')?.focus();
  }, [card?.id, card?.pinned]);

  const due = useMemo(
    () => new Map(milestones.flatMap((m) => (m.due_on ? [[m.id, m.due_on] as const] : []))),
    [milestones],
  );
  const layout = useMemo(
    () =>
      historyLayout({
        history,
        lanes,
        width,
        now,
        range,
        expanded,
        due,
        bands,
        critical,
        titleWidth,
      }),
    [history, lanes, width, now, range, expanded, due, bands, critical, titleWidth],
  );
  useLayoutEffect(() => {
    // A title's scroll width is its full width, however far its pill cuts it.
    const titles = box.current!.querySelectorAll<HTMLElement>('.bd-hs-pt');
    setTitleWidth(Math.max(0, ...[...titles].map((el) => el.scrollWidth)));
  }, [layout]);
  const summary = useMemo(() => historySummary(history, due, now), [history, due, now]);
  const current = currentMilestone(history);
  const titles = new Map(lanes.map((lane) => [lane.id, lane.title]));
  const rowTitle = (row: HistoryRow) =>
    bands === 'type'
      ? row.key
        ? TASK_TYPE[row.key as TaskType].label
        : t({ id: 'board.history.noType', defaultMessage: 'No type' })
      : bands === 'model'
        ? row.key || t({ id: 'board.history.noModel', defaultMessage: 'No model' })
        : (row.laneId !== null && titles.get(row.laneId)) ||
          t({ id: 'board.history.noLane', defaultMessage: 'No work line' });
  const rowIcon = (row: HistoryRow) => {
    if (!row.key) return null;
    if (bands === 'type') {
      const Icon = TASK_TYPE[row.key as TaskType].icon;
      return <Icon aria-hidden="true" />;
    }
    if (bands === 'model')
      return (
        <>
          {row.runtime && <RuntimeGlyph runtime={row.runtime} size={12} />}
          <ModelMark model={row.key} beside={row.runtime} size={12} />
        </>
      );
    return null;
  };

  const places = new Map<string, { task: HistoryTask; x: number; y: number; open: boolean }>();
  for (const row of layout.rows) {
    for (const dot of row.dots)
      places.set(dot.task.id, { task: dot.task, x: dot.x, y: row.y, open: false });
    for (const pill of row.pills)
      places.set(pill.task.id, { task: pill.task, x: layout.now + 36, y: pill.y, open: true });
  }
  const shown = card && places.get(card.id);

  const pin = (id: string) =>
    setCard((c) => (c?.id === id && c.pinned ? null : { id, pinned: true }));
  const hover = (id: string) => ({
    'data-task': id,
    onMouseEnter: () => setCard((c) => (c?.pinned ? c : { id, pinned: false })),
    onMouseLeave: () => setCard((c) => (c?.pinned ? c : null)),
    onFocus: () => setCard((c) => (c?.pinned ? c : { id, pinned: false })),
    onBlur: () => setCard((c) => (c?.pinned ? c : null)),
    onClick: () => pin(id),
  });
  /** The plot's dots, folds and pills in tab order. */
  const stops = () => [
    ...box.current!.querySelectorAll<HTMLElement | SVGElement>(
      '.bd-hs-dot, .bd-hs-fold, .bd-hs-pill',
    ),
  ];
  // The pinned card sits right after its dot or pill in the tab order.
  const onPlotKey = (e: KeyboardEvent) => {
    if (!card?.pinned) {
      if (e.key === 'Escape') setCard(null);
      return;
    }
    const all = stops();
    const at = all.findIndex((el) => el.dataset.task === card.id);
    if (e.key === 'Escape') {
      // Focus first: the dot's own focus handler then finds the card still pinned.
      all[at]?.focus();
      setCard(null);
      return;
    }
    if (e.key !== 'Tab') return;
    const buttons = [...(cardBox.current?.querySelectorAll('button') ?? [])];
    const next = e.shiftKey
      ? e.target === buttons[0] && all[at]
      : e.target === all[at]
        ? buttons[0]
        : e.target === buttons.at(-1) && all[at + 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  const toggle = (key: string) =>
    setExpanded((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const nowDay = dayNumber(history.started_at, now);
  const weekTotal = summary.weeks.reduce((sum, n) => sum + n, 0);
  const weekMost = Math.max(1, ...summary.weeks);
  const gate = summary.gate;
  const gateKnown = gate?.weeks.filter((v): v is number => v !== null) ?? [];
  const [gateFrom, gateTo] = [gateKnown[0], gateKnown.at(-1)];

  return (
    <section
      className="bd-hs"
      aria-label={t({ id: 'board.history.label', defaultMessage: 'Whole history' })}
    >
      <div className="bd-hs-top">
        <span className="bd-hs-since">
          {t(
            {
              id: 'board.history.since',
              defaultMessage: '{date} to now, {days, plural, one {# day} other {# days}}',
            },
            { date: dayText(history.started_at, now), days: nowDay },
          )}
        </span>
        {history.truncated && (
          <span className="bd-hs-cut">
            {t({
              id: 'board.history.truncated',
              defaultMessage: 'Only the first 2000 tasks are shown',
            })}
          </span>
        )}
        {bar &&
          createPortal(
            <>
              <HistoryRangeControl
                value={range}
                onValueChange={(value) => {
                  setRange(value);
                  setCard(null);
                }}
                hasMilestone={!!current}
              />
              <RadioGroup<HistoryBands>
                className="tb-seg"
                aria-label={t({ id: 'board.history.bands', defaultMessage: 'Bands' })}
                value={bands}
                onValueChange={(value) => {
                  setBands(value);
                  setCard(null);
                }}
              >
                {BANDS.map((b) => (
                  <Radio.Root key={b.key} value={b.key}>
                    {b.label()}
                  </Radio.Root>
                ))}
              </RadioGroup>
              <button
                type="button"
                className="ib bd-hs-crit"
                aria-pressed={critical}
                aria-label={t({
                  id: 'board.history.critical',
                  defaultMessage: 'Only the critical path',
                })}
                onClick={() => setCritical((on) => !on)}
              >
                <Route aria-hidden="true" />
              </button>
            </>,
            bar,
          )}
      </div>
      <section
        className="bd-hs-prog"
        aria-label={t({ id: 'board.history.progressSection', defaultMessage: 'Whole progress' })}
      >
        {project !== null && <b className="bd-hs-name">{project}</b>}
        <b className="bd-hs-num">
          {summary.merged} / {summary.total}
        </b>
        <div
          className="bd-hs-bar"
          role="img"
          aria-label={t(
            {
              id: 'board.history.progress',
              defaultMessage: '{total, plural, one {# task} other {# tasks}}: {states}',
            },
            {
              total: summary.total,
              states: listText(
                ...summary.states.map(({ state, count }) =>
                  t(
                    { id: 'board.history.progressState', defaultMessage: '{count} {state}' },
                    { count, state: STATE[state].label },
                  ),
                ),
              ),
            },
          )}
        >
          {summary.states.map(({ state, count }) => (
            <i
              key={state}
              data-state={state}
              style={{ flexGrow: count, background: `var(${TASK_STATE_TONE[state]})` }}
            />
          ))}
        </div>
        {summary.milestoneCount > 0 && (
          <span className="bd-hs-chip">
            <StatusIcon status="done" />
            {t(
              { id: 'board.history.milestones', defaultMessage: 'Milestones {reached} / {total}' },
              { reached: summary.reached, total: summary.milestoneCount },
            )}
          </span>
        )}
        <span className="bd-hs-chip">
          <Undo2 aria-hidden="true" />
          {t(
            {
              id: 'board.history.rework',
              defaultMessage: 'Reworked {count, plural, one {# time} other {# times}}',
            },
            { count: summary.handbacks },
          )}
        </span>
        <ul
          className="bd-hs-lg"
          aria-label={t({ id: 'board.history.legend', defaultMessage: 'Legend' })}
        >
          <li>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <circle className="bd-hs-c" cx={6} cy={6} r={4} />
            </svg>
            {t({ id: 'board.history.legend.merged', defaultMessage: 'Merged' })}
          </li>
          <li>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <circle className="bd-hs-rw" cx={6} cy={6} r={4} />
            </svg>
            {t({ id: 'board.history.legend.reworked', defaultMessage: 'Reworked' })}
          </li>
          <li>
            <StateIcon state="running" />
            {t({ id: 'board.history.legend.running', defaultMessage: 'In progress' })}
          </li>
          <li>
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect
                className="bd-hs-dec"
                x={2}
                y={2}
                width={8}
                height={8}
                transform="rotate(45 6 6)"
              />
            </svg>
            {t({ id: 'board.history.legend.decisions', defaultMessage: 'Your decisions' })}
          </li>
          <li>
            <Flag aria-hidden="true" />
            {t({ id: 'board.history.legend.milestones', defaultMessage: 'Milestones' })}
          </li>
        </ul>
      </section>
      <div className="bd-hs-plot" ref={box} onKeyDown={onPlotKey}>
        <div className="bd-hs-canvas" style={{ width: layout.width, height: layout.height }}>
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label={t({ id: 'board.history.chart', defaultMessage: 'Merges over time' })}
          >
            {layout.ticks.map((tick) => (
              <line
                key={tick.at}
                className="bd-hs-grid"
                x1={tick.x}
                x2={tick.x}
                y1={36}
                y2={layout.rowsEnd}
              />
            ))}
            {layout.milestones.map((m) => (
              <line
                key={m.id}
                className={m.due ? 'bd-hs-due' : 'bd-hs-ms'}
                x1={m.x}
                x2={m.x}
                y1={24}
                y2={layout.rowsEnd}
              />
            ))}
            <line
              className="bd-hs-nowl"
              x1={layout.now}
              x2={layout.now}
              y1={24}
              y2={layout.height - 24}
            />
            {layout.breaks.map((b) => (
              <path
                key={b.x}
                className="bd-hs-brk"
                d={`M${b.x + b.width / 2} 40 l4 8 l-8 8 l8 8 l-8 8 l4 8`}
              />
            ))}
            <g aria-hidden="true">
              {layout.edges.map((e) => (
                <path
                  key={e.key}
                  className="bd-hs-dep"
                  data-crit={e.critical || undefined}
                  d={`M${e.x1} ${e.y1} C${e.x1 + 24} ${e.y1} ${e.x2 - 24} ${e.y2} ${e.x2} ${e.y2}`}
                />
              ))}
            </g>
            {layout.rows.map((row) => {
              const end = row.line?.x2 ?? layout.left;
              return (
                <g key={row.key}>
                  {row.line && (
                    <path className="bd-hs-line" d={`M${row.line.x1} ${row.y} H${row.line.x2}`} />
                  )}
                  {row.pills.length > 0 ? (
                    <>
                      <path className="bd-hs-live" d={`M${end} ${row.y} H${layout.now}`} />
                      {row.pills.map((pill) => (
                        <path
                          key={pill.task.id}
                          className="bd-hs-live"
                          data-state={pill.task.state}
                          d={`M${layout.now} ${row.y} C${layout.now + 16} ${row.y} ${layout.now + 16} ${pill.y} ${layout.now + 36} ${pill.y}`}
                        />
                      ))}
                    </>
                  ) : (
                    row.line && (
                      <path className="bd-hs-end" d={`M${end} ${row.y - 6} V${row.y + 6}`} />
                    )
                  )}
                  {row.dots.map((dot) => (
                    <g
                      key={dot.task.id}
                      className="bd-hs-dot"
                      data-off={(layout.critical && !layout.critical.has(dot.task.id)) || undefined}
                      role="button"
                      tabIndex={0}
                      aria-label={taskLabel(dot.task, now)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        pin(dot.task.id);
                      }}
                      {...hover(dot.task.id)}
                    >
                      {dot.reworked && <circle className="bd-hs-rw" cx={dot.x} cy={row.y} r={9} />}
                      <circle className="bd-hs-c" cx={dot.x} cy={row.y} r={5} />
                    </g>
                  ))}
                </g>
              );
            })}
            {layout.marks.map((m) => (
              <circle
                key={`${m.kind}:${m.at}`}
                className={m.kind === 'failed' ? 'bd-hs-bad' : 'bd-hs-wait'}
                role="img"
                aria-label={
                  m.kind === 'failed'
                    ? t(
                        {
                          id: 'board.history.failed',
                          defaultMessage:
                            '{date}: {count, plural, one {# failed attempt} other {# failed attempts}}',
                        },
                        { date: dayText(m.at, now), count: m.count },
                      )
                    : t(
                        {
                          id: 'board.history.waited',
                          defaultMessage:
                            '{date}: {count, plural, one {# request waiting on you} other {# requests waiting on you}}',
                        },
                        { date: dayText(m.at, now), count: m.count },
                      )
                }
                cx={m.x}
                cy={layout.rowsEnd + 12}
                r={3}
              />
            ))}
            {layout.decisions.map((d) => {
              const items = d.items.map(decisionText);
              return (
                <g
                  key={d.key}
                  className="bd-hs-dec"
                  role="img"
                  aria-label={t(
                    { id: 'board.history.decisionList', defaultMessage: '{date}: {items}' },
                    { date: dayText(d.at, now), items: listText(...items) },
                  )}
                >
                  <title>{items.join('\n')}</title>
                  <rect
                    x={d.x - 4}
                    y={d.y - 4}
                    width={8}
                    height={8}
                    transform={`rotate(45 ${d.x} ${d.y})`}
                  />
                  {d.count > 1 && (
                    <text className="bd-hs-dn" x={d.x + 8} y={d.y + 4}>
                      {d.count}
                    </text>
                  )}
                </g>
              );
            })}
            {layout.bars.map((bar) => (
              <rect
                key={bar.x}
                className="bd-hs-day"
                x={bar.x}
                y={layout.rowsEnd + 52 - bar.height}
                width={bar.width}
                height={bar.height}
                rx={2}
              />
            ))}
          </svg>
          {layout.ticks.map((tick) => (
            <span key={tick.at} className="bd-hs-tick" style={{ left: tick.x + 4, top: 36 }}>
              {tickText(tick.at, tick.first)}
            </span>
          ))}
          {layout.milestones.map((m) => (
            <span key={m.id} className="bd-hs-mk" style={{ left: m.x }}>
              {m.due ? <Flag aria-hidden="true" /> : <StatusIcon status="done" />}
              {m.title}
            </span>
          ))}
          {layout.breaks.map((b) => (
            <span key={b.x} className="bd-hs-tick" style={{ left: b.x + b.width / 2 + 8, top: 48 }}>
              {t(
                {
                  id: 'board.history.idle',
                  defaultMessage: 'Folded {count, plural, one {# quiet day} other {# quiet days}}',
                },
                { count: b.days },
              )}
            </span>
          ))}
          {layout.rows.map((row) => (
            <div
              key={row.key}
              className="bd-hs-lane"
              style={{ top: row.y - 20, width: LABEL_W - 16 }}
            >
              <span className="bd-hs-lt">
                {rowIcon(row)}
                {rowTitle(row)}
              </span>
              <span className="bd-hs-ln">
                {row.merged} / {row.total}
              </span>
            </div>
          ))}
          {layout.rows.map(
            (row) =>
              row.fold && (
                <button
                  key={row.key}
                  type="button"
                  className="bd-hs-fold"
                  aria-expanded={row.fold.open}
                  aria-label={t(
                    {
                      id: 'board.history.fold',
                      defaultMessage:
                        '{lane}: {count, plural, one {# early task} other {# early tasks}}',
                    },
                    { lane: rowTitle(row), count: row.fold.count },
                  )}
                  style={{
                    left: row.fold.x1,
                    top: row.y - 12,
                    width: row.fold.open ? 24 : row.fold.x2 - row.fold.x1 - 8,
                  }}
                  onClick={() => toggle(row.key)}
                >
                  {row.fold.open ? (
                    <ChevronDown aria-hidden="true" />
                  ) : (
                    <>
                      <ChevronRight aria-hidden="true" />
                      <span className="bd-hs-fn">
                        {t(
                          {
                            id: 'board.history.foldCount',
                            defaultMessage: '{count, plural, one {# task} other {# tasks}}',
                          },
                          { count: row.fold.count },
                        )}
                      </span>
                      <span className="bd-hs-sqs" aria-hidden="true">
                        {Array.from({ length: Math.min(row.fold.count, 10) }, (_, i) => (
                          <i key={i} />
                        ))}
                      </span>
                    </>
                  )}
                </button>
              ),
          )}
          {layout.rows.flatMap((row) =>
            row.pills.map((pill) => (
              <button
                key={pill.task.id}
                type="button"
                className="bd-hs-pill"
                data-state={pill.task.state}
                data-off={(layout.critical && !layout.critical.has(pill.task.id)) || undefined}
                style={{ left: layout.now + 36, top: pill.y - 12, maxWidth: layout.openW - 36 }}
                aria-label={pill.task.title}
                {...hover(pill.task.id)}
              >
                <StateIcon state={pill.task.state} />
                <span className="bd-hs-pt">{pill.task.title}</span>
              </button>
            )),
          )}
          <span className="bd-hs-side" style={{ top: layout.rowsEnd + 4 }}>
            {t({ id: 'board.history.problems', defaultMessage: 'Failed and waiting on you' })}
          </span>
          <span className="bd-hs-side" style={{ top: layout.rowsEnd + 36 }}>
            {t({ id: 'board.history.perDay', defaultMessage: 'Merged per day' })}
          </span>
          <span className="bd-hs-now" style={{ left: layout.now, top: layout.height - 24 }}>
            {t({ id: 'board.history.now', defaultMessage: 'Now, day {day}' }, { day: nowDay })}
          </span>
          {shown && (
            <div
              ref={cardBox}
              className="bd-hs-card"
              role="dialog"
              aria-label={shown.task.title}
              style={{
                left: Math.max(0, Math.min(shown.x + 12, layout.width - CARD_W)),
                top: shown.y + 12,
                width: CARD_W,
              }}
            >
              <span className="bd-hs-ch">
                <StateIcon state={glyph(shown.task)} />
                <b>{shown.task.title}</b>
                {shown.task.merged_at !== null && <span>{dayText(shown.task.merged_at, now)}</span>}
              </span>
              {(shown.task.runtime || shown.task.model) && (
                <span className="bd-hs-rt">
                  {shown.task.runtime && (
                    <>
                      <RuntimeGlyph runtime={shown.task.runtime} size={12} />
                      <span>{runtimeName(shown.task.runtime)}</span>
                    </>
                  )}
                  {shown.task.model && <span className="bd-hs-sha">{shown.task.model}</span>}
                </span>
              )}
              {taskFacts(shown.task)}
              {shown.task.handbacks > 0 && (
                <span className="bd-hs-cr">
                  <Undo2 aria-hidden="true" />
                  {reworkText(shown.task)}
                </span>
              )}
              {/* attempts counts the first try too. */}
              {shown.task.attempts > 1 && (
                <span className="bd-hs-cr">
                  <RotateCcw aria-hidden="true" />
                  {t(
                    {
                      id: 'board.history.retried',
                      defaultMessage: 'Retried {count, plural, one {# time} other {# times}}',
                    },
                    { count: shown.task.attempts - 1 },
                  )}
                </span>
              )}
              <span className="bd-hs-acts">
                {shown.task.session_id !== null && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      useShell.getState().showRuns(shown.task.session_id);
                      useShell.setState({ runsView: 'history' });
                    }}
                  >
                    {t({ id: 'board.history.replay', defaultMessage: 'Replay' })}
                  </button>
                )}
                {shown.task.session_id !== null && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      useShell.getState().openSession(shown.task.session_id!, 'changes')
                    }
                  >
                    {t({ id: 'board.history.openChanges', defaultMessage: 'View changes' })}
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => onOpenSession(sessionOf(shown.task))}
                >
                  {t({ id: 'board.history.openSession', defaultMessage: 'Open session' })}
                </button>
                {shown.open && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => onOpenTask(shown.task.id)}
                  >
                    {t({ id: 'board.history.showNow', defaultMessage: 'Show in now view' })}
                  </button>
                )}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="bd-hs-sum">
        {summary.milestones.length > 0 && (
          <div className="bd-hs-cell">
            <span className="bd-hs-cap">
              {t({ id: 'board.milestones.title', defaultMessage: 'Milestones' })}
            </span>
            {summary.milestones.map((m) => (
              <span key={m.id} className="bd-hs-sr">
                <StatusIcon status={m.day !== null ? 'done' : 'running'} />
                <span className="bd-hs-st">{m.title}</span>
                {m.day !== null ? (
                  <span className="bd-hs-sn">
                    {t({ id: 'board.history.day', defaultMessage: 'Day {day}' }, { day: m.day })}
                  </span>
                ) : (
                  m.left !== null && (
                    <span className="bd-hs-sn">
                      {m.left > 0
                        ? t(
                            {
                              id: 'board.history.daysLeft',
                              defaultMessage:
                                '{count, plural, one {# day left} other {# days left}}',
                            },
                            { count: m.left },
                          )
                        : m.left === 0
                          ? t({ id: 'board.history.dueToday', defaultMessage: 'Due today' })
                          : t(
                              {
                                id: 'board.history.overdue',
                                defaultMessage:
                                  '{count, plural, one {# day overdue} other {# days overdue}}',
                              },
                              { count: -m.left },
                            )}
                    </span>
                  )
                )}
              </span>
            ))}
          </div>
        )}
        {gate && (
          <div className="bd-hs-cell">
            <span className="bd-hs-cap">
              {t({ id: 'board.history.gate', defaultMessage: 'Gate passed first run' })}
            </span>
            <span className="bd-hs-sr">
              <b className="bd-hs-sn">{percentText(gate.share)}</b>
              {gateFrom !== undefined && (
                <svg
                  className="bd-hs-spark"
                  width={SPARK_W}
                  height={SPARK_H}
                  viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={t(
                    {
                      id: 'board.history.gateTrend',
                      defaultMessage:
                        'First-run gate pass rate over {weeks, plural, one {# week} other {# weeks}}: {from} to {to}',
                    },
                    {
                      weeks: gate.weeks.length,
                      from: percentText(gateFrom),
                      to: percentText(gateTo!),
                    },
                  )}
                >
                  <path d={sparkPath(gate.weeks, SPARK_W, SPARK_H)} />
                </svg>
              )}
              <span className="bd-hs-sn bd-hs-span">
                {t(
                  {
                    id: 'board.history.weekSpan',
                    defaultMessage: '{count, plural, one {# week} other {# weeks}}',
                  },
                  { count: gate.weeks.length },
                )}
              </span>
            </span>
          </div>
        )}
        <div className="bd-hs-cell">
          <span className="bd-hs-cap">
            {t({ id: 'board.history.weekly', defaultMessage: 'Merged per week' })}
          </span>
          <span className="bd-hs-sr">
            <b className="bd-hs-sn">{weekTotal}</b>
            <span
              className="bd-hs-wk"
              role="img"
              aria-label={t(
                {
                  id: 'board.history.weeks',
                  defaultMessage:
                    '{count, plural, one {# merge} other {# merges}} in {weeks, plural, one {# week} other {# weeks}}',
                },
                { count: weekTotal, weeks: summary.weeks.length },
              )}
            >
              {summary.weeks.map((n, i) => (
                <i key={i} style={{ height: `${(n / weekMost) * 100}%` }} />
              ))}
            </span>
            <span className="bd-hs-sn bd-hs-span">
              {t(
                {
                  id: 'board.history.weekSpan',
                  defaultMessage: '{count, plural, one {# week} other {# weeks}}',
                },
                { count: summary.weeks.length },
              )}
            </span>
          </span>
        </div>
        {summary.reworked.length > 0 && (
          <div className="bd-hs-cell">
            <span className="bd-hs-cap">
              {t({ id: 'board.history.mostReworked', defaultMessage: 'Most reworked' })}
            </span>
            {summary.reworked.map(({ task, share }) => (
              <span key={task.id} className="bd-hs-sr">
                <span className="bd-hs-st">{task.title}</span>
                <span className="bd-hs-meter" aria-hidden="true">
                  <i style={{ width: `${share * 100}%` }} />
                </span>
                <span className="bd-hs-sn">
                  {t(
                    {
                      id: 'board.history.times',
                      defaultMessage: '{count, plural, one {# time} other {# times}}',
                    },
                    { count: task.handbacks },
                  )}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
