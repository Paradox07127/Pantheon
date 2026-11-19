import {
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Position, getBezierPath } from '@xyflow/react';
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  FileDiff,
  Flag,
  GitMerge,
  MessageCircle,
  Play,
  Route,
  Workflow,
  type LucideProps,
} from 'lucide-react';
import type { BoardModel, PlanReplayFrame, PlanReplayTaskStatus } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { LoadError } from '../../components/LoadError';
import { Select } from '../../components/Select';
import { Skeleton } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import { usePlanReplay } from '../../data/plan-replay';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { clockText, dayText } from '../../lib/time-text';
import { NODE_WIDTH, flowLayout } from './flow-layout';
import { planLead } from './NewTask';
import { StateIcon } from './status';
import './plan-replay.css';

/** A replay card's height; every card is one title line over its status. */
const NODE_H = 56;
const SHOWN_EVENTS = 10;
const STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -10,
  PageUp: 10,
};

const pct = (share: number) => `${share * 100}%`;

const STATUS: Record<
  PlanReplayTaskStatus,
  { label: () => string; Icon: ComponentType<LucideProps> }
> = {
  planned: {
    label: () => t({ id: 'board.replay.status.planned', defaultMessage: 'Planned' }),
    Icon: Circle,
  },
  dispatched: {
    label: () => t({ id: 'board.replay.status.dispatched', defaultMessage: 'Dispatched' }),
    Icon: Play,
  },
  merged: {
    label: () => t({ id: 'board.replay.status.merged', defaultMessage: 'Merged' }),
    Icon: GitMerge,
  },
  accepted: {
    label: () => t({ id: 'board.replay.status.accepted', defaultMessage: 'Accepted' }),
    Icon: CircleCheck,
  },
};

/** Counts in the chart's name, most advanced first. */
const COUNTS: { status: PlanReplayTaskStatus; text: (count: number) => string }[] = [
  {
    status: 'accepted',
    text: (count) =>
      t({ id: 'board.replay.count.accepted', defaultMessage: '{count} accepted' }, { count }),
  },
  {
    status: 'merged',
    text: (count) =>
      t({ id: 'board.replay.count.merged', defaultMessage: '{count} merged' }, { count }),
  },
  {
    status: 'dispatched',
    text: (count) =>
      t({ id: 'board.replay.count.dispatched', defaultMessage: '{count} dispatched' }, { count }),
  },
  {
    status: 'planned',
    text: (count) =>
      t({ id: 'board.replay.count.planned', defaultMessage: '{count} planned' }, { count }),
  },
];

const isReplan = (frame: PlanReplayFrame) =>
  frame.kind === 'board.replan_triggered' || frame.replan === true;

function kindText(frame: PlanReplayFrame): string {
  switch (frame.kind) {
    case 'board.plan_updated':
      return frame.replan
        ? t({ id: 'board.replay.kind.replanned', defaultMessage: 'Re-planned' })
        : t({ id: 'board.replay.kind.planUpdated', defaultMessage: 'Plan updated' });
    case 'board.replan_triggered':
      return t({
        id: 'board.replay.kind.replanTriggered',
        defaultMessage: 'Re-plan condition met',
      });
    case 'lead.question_asked':
      return t({ id: 'board.replay.kind.questionAsked', defaultMessage: 'Question asked' });
    case 'lead.question_answered':
      return t({ id: 'board.replay.kind.questionAnswered', defaultMessage: 'Question answered' });
    case 'lead.question_overruled':
      return t({ id: 'board.replay.kind.answerOverruled', defaultMessage: 'Answer overruled' });
    case 'board.plan_proposed':
      return t({ id: 'board.replay.kind.proposed', defaultMessage: 'Plan change proposed' });
    case 'board.plan_proposal_resolved':
      return frame.decision === 'accepted'
        ? t({ id: 'board.replay.kind.proposalAccepted', defaultMessage: 'Proposal accepted' })
        : frame.decision === 'rejected'
          ? t({ id: 'board.replay.kind.proposalRejected', defaultMessage: 'Proposal rejected' })
          : t({ id: 'board.replay.kind.proposalResolved', defaultMessage: 'Proposal resolved' });
    case 'board.plan_proposal_withdrawn':
      return t({ id: 'board.replay.kind.proposalWithdrawn', defaultMessage: 'Proposal withdrawn' });
    case 'task.dispatched':
      return t({ id: 'board.replay.kind.dispatched', defaultMessage: 'Dispatched' });
    case 'session.merged':
      return t({ id: 'board.replay.kind.merged', defaultMessage: 'Merged' });
    case 'task.accepted':
      return t({ id: 'board.replay.kind.accepted', defaultMessage: 'Accepted' });
    case 'milestone.accepted':
      return t({ id: 'board.replay.kind.milestoneAccepted', defaultMessage: 'Milestone accepted' });
  }
}

function kindIcon(frame: PlanReplayFrame): ComponentType<LucideProps> {
  if (isReplan(frame)) return Route;
  if (frame.kind.startsWith('lead.question_')) return MessageCircle;
  if (frame.kind.startsWith('board.plan_propos')) return FileDiff;
  if (frame.kind === 'task.dispatched') return Play;
  if (frame.kind === 'session.merged') return GitMerge;
  if (frame.kind === 'task.accepted') return CircleCheck;
  if (frame.kind === 'milestone.accepted') return Flag;
  return Workflow;
}

/** The frame's text, else the title of the task it is of. */
const subjectOf = (frame: PlanReplayFrame) =>
  frame.text ?? frame.tasks.find((task) => task.id === frame.task_id)?.title ?? '';

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** The frame's tasks placed by the flow chart's layout, lanes titled by the board's lanes. */
function chartOf(frame: PlanReplayFrame, leadId: string, lanes: BoardModel['lanes']) {
  const titles = new Map(lanes.map((lane) => [lane.id, lane.title]));
  const shape = {
    tasks: frame.tasks.map((task) => ({ id: task.id, lane_id: task.lane })),
    // The board's lane ids are `<lead session id>:<lane id>`; a lane the board no longer has shows its id.
    lanes: [...new Set(frame.tasks.map((task) => task.lane))].map((id) => ({
      id,
      title: titles.get(`${leadId}:${id}`) ?? id,
    })),
    edges: frame.tasks.flatMap((task) => task.depends_on.map((from) => ({ from, to: task.id }))),
  } as unknown as BoardModel;
  return flowLayout(shape, 0, 'lane', new Map(frame.tasks.map((task) => [task.id, NODE_H])));
}

/** A lead plan's events one by one, with its tasks as they stood at each; it only reads. */
export function PlanReplay({ model, onClose }: { model: BoardModel; onClose: () => void }) {
  const leads = model.leads ?? [];
  const [leadId, setLeadId] = useState(() => planLead(model) ?? leads[0]?.session_id ?? '');
  const replay = usePlanReplay(leadId);
  const { frames, total } = replay;
  // The frame the playhead is on, by sequence, so pages landing before it keep it; none is the newest.
  const [at, setAt] = useState<{ lead: string; sequence: number } | null>(null);
  const [all, setAll] = useState(false);
  const drag = useRef<DOMRect | null>(null);
  const eventsHead = useId();
  const now = model.now;

  const found = at?.lead === leadId ? frames.findIndex((f) => f.sequence === at.sequence) : -1;
  const index = found >= 0 ? found : frames.length - 1;
  const frame = frames[index];
  const position = total - frames.length + index + 1;
  const go = (next: number) => {
    const to = frames[Math.min(frames.length - 1, Math.max(0, next))];
    if (to)
      setAt((was) =>
        was?.lead === leadId && was.sequence === to.sequence
          ? was
          : { lead: leadId, sequence: to.sequence },
      );
  };

  // Positions are by time over the plan's whole span, so frames already drawn stay put as pages land.
  const from = replay.firstAt ?? frames[0]?.at ?? now;
  const end = Math.max(now, replay.lastAt ?? from);
  const span = Math.max(1, end - from);
  const place = (time: number) => Math.min(1, Math.max(0, (time - from) / span));
  const loadedFrom = frames[0] ? place(frames[0].at) : 0;
  const days = useMemo(() => {
    const marks: number[] = [];
    const day = new Date(from);
    day.setHours(24, 0, 0, 0);
    for (; day.getTime() < end; day.setDate(day.getDate() + 1)) marks.push(day.getTime());
    const stride = Math.max(1, Math.ceil(marks.length / 7));
    return marks.filter((_, i) => i % stride === 0);
  }, [from, end]);

  const seek = (x: number) => {
    const box = drag.current!;
    const time = from + ((x - box.left) / Math.max(1, box.width)) * span;
    let best = 0;
    frames.forEach((f, i) => {
      if (Math.abs(f.at - time) < Math.abs(frames[best]!.at - time)) best = i;
    });
    go(best);
  };

  const chart = useMemo(
    () => (frame?.tasks.length ? chartOf(frame, leadId, model.lanes) : null),
    [frame, leadId, model.lanes],
  );
  const lead = leads.find((l) => l.session_id === leadId);
  const subject = frame && subjectOf(frame);
  const empty = !replay.loading && !replay.error && total === 0;
  const past = frame ? frames.slice(0, index + 1).reverse() : [];
  const busy = replay.loading || replay.loadingEarlier;

  const valueText = frame
    ? subject
      ? t(
          {
            id: 'board.replay.positionOf',
            defaultMessage: '{time}, {kind} {subject}, event {n} of {total}',
          },
          {
            time: dayText(frame.at, now, { time: true }),
            kind: kindText(frame),
            subject,
            n: position,
            total,
          },
        )
      : t(
          { id: 'board.replay.position', defaultMessage: '{time}, {kind}, event {n} of {total}' },
          {
            time: dayText(frame.at, now, { time: true }),
            kind: kindText(frame),
            n: position,
            total,
          },
        )
    : replay.loading
      ? t({ id: 'board.replay.loading', defaultMessage: 'Loading' })
      : t({ id: 'board.replay.none', defaultMessage: 'No events' });

  let body: ReactNode;
  if (replay.loading)
    body = (
      <div className="bd-prp-sk" aria-busy="true">
        <Skeleton style={{ width: 240, height: 12 }} />
        <Skeleton style={{ width: 144, height: 12 }} />
      </div>
    );
  else if (replay.error)
    body = (
      <div className="bd-prp-sk">
        <LoadError
          message={t(
            {
              id: 'board.replay.failed',
              defaultMessage: "Could not load the plan's events: {reason}",
            },
            { reason: replay.error },
          )}
          onRetry={replay.retry}
        />
      </div>
    );
  else if (!chart || !frame)
    body = (
      <div className="bd-prp-sk">
        <span className="bd-prp-none">
          {t({ id: 'board.replay.empty', defaultMessage: 'This lead has not written a plan yet' })}
        </span>
      </div>
    );
  else {
    const tasks = new Map(frame.tasks.map((task) => [task.id, task]));
    const places = new Map(chart.nodes.map((node) => [node.id, node]));
    const counts = COUNTS.map((c) => {
      const count = frame.tasks.filter((task) => task.status === c.status).length;
      return count > 0 && c.text(count);
    });
    body = (
      <div className="bd-prp-cv">
        <div
          className="bd-prp-fl"
          role="list"
          aria-label={t(
            {
              id: 'board.replay.chart',
              defaultMessage:
                'Plan at {time}: {count, plural, one {# task} other {# tasks}}, {states}',
            },
            {
              time: dayText(frame.at, now, { time: true }),
              count: frame.tasks.length,
              states: listText(...counts),
            },
          )}
          style={{ width: chart.width, height: chart.height }}
        >
          {chart.lanes.map((lane) => (
            <div
              key={lane.id ?? ''}
              className="bd-prp-ln"
              style={{ top: lane.y, height: lane.height }}
            >
              <span className="bd-prp-lt">{lane.title}</span>
            </div>
          ))}
          <svg className="bd-prp-ed" width={chart.width} height={chart.height} aria-hidden="true">
            {chart.edges.map((edge) => {
              const source = places.get(edge.from)!;
              const target = places.get(edge.to)!;
              const sourceX = source.x + NODE_WIDTH;
              const sourceY = source.y + NODE_H / 2;
              const targetY = target.y + NODE_H / 2;
              // Rows change in the gap after the source, as in the flow chart.
              const turn = Math.min(target.x, sourceX + chart.gap);
              const [curve] = getBezierPath({
                sourceX,
                sourceY,
                sourcePosition: Position.Right,
                targetX: turn,
                targetY,
                targetPosition: Position.Left,
              });
              const status = tasks.get(edge.from)!.status;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={turn < target.x ? `${curve} L${target.x},${targetY}` : curve}
                  data-met={status === 'merged' || status === 'accepted' || undefined}
                />
              );
            })}
          </svg>
          {chart.nodes.map((node) => {
            const task = tasks.get(node.id)!;
            const { label, Icon } = STATUS[task.status];
            return (
              <div
                key={node.id}
                className="bd-prp-n"
                role="listitem"
                data-status={task.status}
                data-at={task.id === frame.task_id || undefined}
                aria-label={t(
                  { id: 'board.replay.node', defaultMessage: '{title}, {status}' },
                  { title: task.title, status: label() },
                )}
                style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_H }}
              >
                <Clip text={task.title} className="bd-prp-nt" />
                <span className="bd-prp-ns">
                  <Icon aria-hidden="true" />
                  {label()}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section
      className="bd-prp"
      aria-label={t({ id: 'board.replay.label', defaultMessage: 'Plan replay' })}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        // The plan menu's list is portaled out of the section and closes on its own Escape.
        if (e.key !== 'Escape' || !e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className="bd-prp-c">
        {leads.length > 1 ? (
          <Select
            value={leadId}
            onChange={(next) => {
              setLeadId(next);
              setAll(false);
            }}
            options={leads.map((l) => ({ value: l.session_id, label: l.title }))}
            aria-label={t(
              { id: 'board.replay.plan', defaultMessage: 'Plan: {title}' },
              { title: lead?.title ?? '' },
            )}
          />
        ) : (
          <span className="bd-prp-pk">{lead?.title}</span>
        )}
        <span className="bd-prp-step">
          <button
            type="button"
            className="ib"
            aria-label={t({ id: 'board.replay.previous', defaultMessage: 'Previous event' })}
            disabled={!frame || index === 0}
            onClick={() => go(index - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ib"
            aria-label={t({ id: 'board.replay.next', defaultMessage: 'Next event' })}
            disabled={!frame || index === frames.length - 1}
            onClick={() => go(index + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </span>
        <div className="bd-prp-w">
          <div
            className="bd-prp-tr"
            role="slider"
            tabIndex={frame ? 0 : -1}
            aria-label={t({ id: 'board.replay.slider', defaultMessage: 'Plan time' })}
            aria-orientation="horizontal"
            aria-valuemin={frame ? total - frames.length + 1 : 1}
            aria-valuemax={frame ? total : 1}
            aria-valuenow={frame ? position : 1}
            aria-valuetext={valueText}
            aria-disabled={!frame || undefined}
            aria-busy={busy || undefined}
            onKeyDown={(e) => {
              if (!frame) return;
              if (e.key in STEPS) go(index + STEPS[e.key]!);
              else if (e.key === 'Home') go(0);
              else if (e.key === 'End') go(frames.length - 1);
              else return;
              e.preventDefault();
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !frame) return;
              drag.current = e.currentTarget.getBoundingClientRect();
              e.currentTarget.setPointerCapture(e.pointerId);
              seek(e.clientX);
            }}
            onPointerMove={(e) => drag.current && seek(e.clientX)}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <i className="bd-prp-rail" />
            {frames.length < total && (
              <i className="bd-prp-un" data-unloaded="" style={{ width: pct(loadedFrom) }} />
            )}
            {frame && (
              <i
                className="bd-prp-fill"
                style={{ left: pct(loadedFrom), width: pct(place(frame.at) - loadedFrom) }}
              />
            )}
            {frames.map((f) => (
              <i
                key={f.sequence}
                className="bd-prp-tk"
                data-mark={
                  isReplan(f) ? 'replan' : f.kind === 'board.plan_updated' ? 'plan' : undefined
                }
                style={{ left: pct(place(f.at)) }}
              />
            ))}
            {frame && <span className="bd-prp-k" style={{ left: pct(place(frame.at)) }} />}
          </div>
          <div className="bd-prp-ax" aria-hidden="true">
            {frame &&
              days.map((day) => (
                <span key={day} style={{ left: pct(place(day)) }}>
                  {dayText(day, now)}
                </span>
              ))}
          </div>
          {replay.earlierError && (
            <LoadError
              message={t(
                {
                  id: 'board.replay.earlierFailed',
                  defaultMessage: 'Could not load the events before {time}',
                },
                { time: dayText(replay.earlierError.before.at, now, { time: true }) },
              )}
              onRetry={replay.retry}
            />
          )}
          {replay.held && (
            <button type="button" className="btn sm bd-prp-more" onClick={replay.loadEarlier}>
              {t({ id: 'board.replay.loadEarlier', defaultMessage: 'Load earlier events' })}
            </button>
          )}
        </div>
        <span className="bd-prp-at">
          {replay.loadingEarlier && (
            <span
              className="bd-prp-ld"
              role="img"
              aria-label={t({
                id: 'board.replay.loadingEarlier',
                defaultMessage: 'Loading earlier events',
              })}
            >
              <StateIcon state="running" />
            </span>
          )}
          {frame && (
            <>
              <time className="bd-prp-tm" dateTime={new Date(frame.at).toISOString()}>
                {dayText(frame.at, now, { time: true })}
              </time>
              <span className="bd-prp-pos">
                {t(
                  { id: 'board.replay.of', defaultMessage: '{n} / {total}' },
                  { n: position, total },
                )}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="bd-prp-g">
        {body}
        {!replay.error && !empty && (
          <section className="bd-prp-ev" aria-labelledby={eventsHead}>
            <div className="bd-prp-evh">
              <h2 id={eventsHead}>
                {t({ id: 'board.replay.events', defaultMessage: 'Events at this point' })}
              </h2>
              {frame && <span className="bd-prp-evn">{position}</span>}
            </div>
            <ol className="bd-prp-el">
              {replay.loading
                ? [0, 1, 2].map((row) => (
                    <li key={row} className="bd-prp-skr">
                      <Skeleton style={{ width: '70%' }} />
                    </li>
                  ))
                : (all ? past : past.slice(0, SHOWN_EVENTS)).map((f) => {
                    const Icon = kindIcon(f);
                    const text = subjectOf(f);
                    return (
                      <li key={f.sequence}>
                        <button
                          type="button"
                          className="bd-prp-er"
                          aria-current={f === frame || undefined}
                          onClick={() => go(frames.indexOf(f))}
                        >
                          <time className="bd-prp-et" dateTime={new Date(f.at).toISOString()}>
                            {sameDay(f.at, frame!.at) ? clockText(f.at) : dayText(f.at, now)}
                          </time>
                          <Icon aria-hidden="true" />
                          <span className="bd-prp-em">
                            <span className="bd-prp-ek">{kindText(f)}</span>
                            {text && <span className="bd-prp-es">{text}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
            </ol>
            {past.length > SHOWN_EVENTS && (
              <button
                type="button"
                className="btn ghost sm bd-prp-more"
                aria-expanded={all}
                onClick={() => setAll((on) => !on)}
              >
                {t(
                  { id: 'board.replay.showAll', defaultMessage: 'Show all {count} events' },
                  { count: past.length },
                )}
              </button>
            )}
          </section>
        )}
      </div>
    </section>
  );
}

/**
 * The timeline's Replay toggle in the board bar, and the plan replay in place of `children` while
 * it is on; a board without a lead plan has nothing to replay.
 */
export function ReplaySwitch({
  model,
  bar,
  children,
}: {
  model: BoardModel;
  /** The board bar's element the toggle goes in. */
  bar: HTMLElement | null;
  children: ReactNode;
}) {
  const [on, setOn] = useState(false);
  const why = useId();
  const can = !!model.leads?.length;
  const name = t({ id: 'board.replay.toggle', defaultMessage: 'Replay' });
  const none = t({ id: 'board.replay.noPlan', defaultMessage: 'No plan to replay' });
  const button = (
    <button
      type="button"
      className="btn"
      aria-pressed={on && can}
      aria-disabled={can ? undefined : true}
      aria-describedby={can ? undefined : why}
      aria-label={name}
      title={name}
      onClick={() => can && setOn((was) => !was)}
    >
      <Play className="ic-sm" aria-hidden="true" />
      <span className="tb-lbl">{name}</span>
    </button>
  );
  return (
    <>
      {bar &&
        createPortal(
          can ? (
            button
          ) : (
            <>
              <Tip content={none}>{button}</Tip>
              <span id={why} className="bd-vh">
                {none}
              </span>
            </>
          ),
          bar,
        )}
      {on && can ? <PlanReplay model={model} onClose={() => setOn(false)} /> : children}
    </>
  );
}
