import type { CSSProperties } from 'react';
import type { BoardModel, BoardTaskState } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { useBoardHistory } from '../../data/board-history';
import { useProjectTimeline } from '../../data/trace';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import { Empty, useFloatTip, type TipContent } from './Charts';
import { taskLanes, type TaskLane } from './history-model';
import { durationText, timeTicks, tokenText, type BoardTask } from './panels-model';
import {
  STATE,
  StateIcon,
  TASK_STATE_TONE,
  TASK_STATUS_TONE,
  TaskStateIcon,
  taskStateLabel,
} from './status';
import './task-timeline.css';

const pct = (share: number) => `${(share * 100).toFixed(3)}%`;

const periodText = (from: number, to: number, now: number) =>
  t(
    { id: 'board.history.lanes.period', defaultMessage: '{from} to {to}' },
    { from: dayText(from, now, { time: true }), to: dayText(to, now, { time: true }) },
  );

/** The current milestone's tasks, one lane each from the first start to now; long idle stretches are cut. */
export function TaskTimelineView({
  model,
  projectId,
}: {
  model: Pick<BoardModel, 'tasks' | 'now'>;
  projectId: string;
}) {
  const now = model.now;
  const first = taskLanes(model.tasks, now, null).from;
  const timeline = useProjectTimeline(projectId, first);
  const history = useBoardHistory(projectId);
  const tip = useFloatTip();
  const { from, lanes, breaks, share } = taskLanes(
    model.tasks,
    now,
    timeline.data?.sessions ?? null,
  );
  if (!lanes.length)
    return (
      <Empty
        text={t({
          id: 'board.history.lanes.empty',
          defaultMessage: 'No task of this milestone has started',
        })}
      />
    );
  const handbacks = new Map(history.data?.tasks.map((task) => [task.id, task.handbacks]));
  const ticks = timeTicks(from, now).filter(
    (tk) => tk.at > from && !breaks.some((b) => tk.at > b.from && tk.at < b.to),
  );
  const states = [
    ...new Set(lanes.flatMap((l) => (l.task.state ? [l.task.state] : []))),
  ] as BoardTaskState[];
  const tone = (task: BoardTask) =>
    `var(${task.state ? TASK_STATE_TONE[task.state] : TASK_STATUS_TONE[task.status]})`;

  const laneLabel = (lane: TaskLane<BoardTask>) => {
    const waited = lane.parts.filter((p) => p.wait).reduce((sum, p) => sum + p.to - p.from, 0);
    return listText(
      lane.task.title,
      ...lane.spans.map((s) => periodText(s.from, s.to, now)),
      taskStateLabel(lane.task),
      waited > 0 &&
        t(
          { id: 'board.history.lanes.waited', defaultMessage: 'waited {duration}' },
          { duration: durationText(waited) },
        ),
      t(
        { id: 'board.history.lanes.total', defaultMessage: '{duration} in all' },
        { duration: durationText(lane.total) },
      ),
    );
  };
  const laneTip = (lane: TaskLane<BoardTask>): TipContent => {
    const back = handbacks.get(lane.task.id);
    return {
      head: lane.task.title,
      rows: [
        {
          label: t({ id: 'board.history.lanes.tip.period', defaultMessage: 'Period' }),
          value: listText(...lane.spans.map((s) => periodText(s.from, s.to, now))),
        },
        {
          label: 'Token',
          value: tokenText(lane.spans.reduce((sum, s) => sum + s.tokens, 0)),
        },
        ...(back === undefined
          ? []
          : [
              {
                label: t({
                  id: 'board.history.lanes.tip.handbacks',
                  defaultMessage: 'Handed back',
                }),
                value: t(
                  {
                    id: 'board.history.lanes.tip.handbackCount',
                    defaultMessage: '{count, plural, one {# time} other {# times}}',
                  },
                  { count: back },
                ),
              },
            ]),
      ],
    };
  };
  const breakMarks = breaks.map((b) => (
    <i key={b.from} className="btt-brk" style={{ left: pct(b.x), width: pct(b.w) }} />
  ));

  return (
    <section className="btt">
      <div className="btt-hd">
        <span className="btt-rg">
          {t(
            { id: 'board.history.lanes.range', defaultMessage: '{from} to now, {duration}' },
            { from: dayText(from, now, { time: true }), duration: durationText(now - from) },
          )}
        </span>
        <div className="legend btt-lg">
          {states.map((state) => (
            <span key={state}>
              <StateIcon state={state} />
              {STATE[state].label}
            </span>
          ))}
          <span>
            <i className="btt-sw" />
            {t({ id: 'board.history.lanes.waiting', defaultMessage: 'Waiting' })}
          </span>
        </div>
      </div>
      <div
        className="btt-box"
        role="group"
        aria-label={listText(
          t(
            {
              id: 'board.history.lanes.label',
              defaultMessage: 'Timeline of {count, plural, one {# task} other {# tasks}}',
            },
            { count: lanes.length },
          ),
          ...breaks.map((b) =>
            t(
              {
                id: 'board.history.lanes.cut',
                defaultMessage: 'nothing from {from} to {to}, {duration}, cut short',
              },
              {
                from: dayText(b.from, now, { time: true }),
                to: dayText(b.to, now, { time: true }),
                duration: durationText(b.to - b.from),
              },
            ),
          ),
        )}
      >
        <div className="btt-row">
          <span />
          <div className="btt-tk btt-ax" aria-hidden="true">
            <span className="btt-tl" style={{ left: 0 }}>
              {dayText(from, now, { time: true })}
            </span>
            {ticks.map((tk) => (
              <span key={tk.at} className="btt-tl" style={{ left: pct(share(tk.at)) }}>
                {tk.label}
              </span>
            ))}
            {breaks.map((b) => (
              <span
                key={b.from}
                className="btt-brk"
                data-gap={b.to - b.from}
                style={{ left: pct(b.x), width: pct(b.w) }}
              >
                {durationText(b.to - b.from)}
              </span>
            ))}
          </div>
        </div>
        {lanes.map((lane) => (
          <div key={lane.task.id} className="btt-row">
            <span className="btt-name">
              <span className="btt-st" role="img" aria-label={taskStateLabel(lane.task)}>
                <TaskStateIcon task={lane.task} />
              </span>
              <Clip text={lane.task.title} />
              <span className="btt-tot">{durationText(lane.total)}</span>
            </span>
            <div className="btt-tk">
              {breakMarks}
              <div
                className="btt-lane"
                role="img"
                tabIndex={0}
                aria-label={laneLabel(lane)}
                aria-describedby={tip.describedBy(lane.task.id)}
                style={{ '--c': tone(lane.task) } as CSSProperties}
                onPointerMove={(e) => tip.show(e, laneTip(lane), lane.task.id)}
                onPointerLeave={tip.hide}
                onFocus={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  tip.show({ clientX: r.left, clientY: r.top }, laneTip(lane), lane.task.id);
                }}
                onBlur={tip.hide}
              >
                {lane.parts.map((p) => (
                  <i
                    key={p.from}
                    className="btt-p"
                    data-part={p.wait ? 'wait' : 'work'}
                    style={{ left: pct(p.x), width: pct(p.w) }}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      {tip.node}
    </section>
  );
}
