import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Bot, Check, CircleDashed, Crown, Flag, Square, X } from 'lucide-react';
import {
  decisionType,
  type BoardModel,
  type DecisionForUser,
  type ProjectBrief,
  type ProjectBriefItem,
} from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { RUNNING, RunningFor } from '../../components/RunningFor';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useAgentProposal } from '../../data/agents';
import { useAppSettings } from '../../data/app-settings';
import { useBoard } from '../../data/board';
import { decisionRow, useDecisionsAfter } from '../../data/decisions-for-user';
import { reasonText } from '../../data/needs-you';
import { markProjectSeen, useProjectBrief, writeBriefProse } from '../../data/project-brief';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { clockText, dayText, durationText } from '../../lib/time-text';
import { useShell } from '../../store';
import { needSession } from './frame-model';
import { verifyText } from './MilestoneCard';
import { tellLeadDraft, type RunBoardCommand, type SnapshotSession } from './panels-model';
import { StatusIcon } from './status';
import { RungLabel } from './TaskRecovery';
import { TellLead } from './TellLead';
import './brief-lanes.css';
import './frame.css';

type Of<K extends ProjectBriefItem['kind']> = Extract<ProjectBriefItem, { kind: K }>;

const HOUR = 3_600_000;
// The daemon gives up on the paragraph after this long without saying so.
const PROSE_WAIT = 20_000;

/** The whole hours to mark between the ends, about four at most, none crowding an end's label. */
function hourMarks(from: number, to: number): number[] {
  const span = to - from;
  const step = Math.max(1, Math.ceil(span / HOUR / 4));
  const start = new Date(from);
  start.setMinutes(0, 0, 0);
  const marks: number[] = [];
  for (let at = start.getTime() + HOUR; at < to; at += HOUR)
    if (new Date(at).getHours() % step === 0 && at - from > span * 0.08 && to - at > span * 0.08)
      marks.push(at);
  return marks;
}

/** One event on a lane: where it sits, how it is drawn and named, and what pressing it opens. */
interface LanePoint {
  key: string;
  at: number;
  kind: 'merge' | 'failure' | 'decided' | 'assumption' | 'proposal';
  glyph: ReactNode;
  type: string;
  title: string;
  open?: () => void;
}

/** The axis the lanes share: from leaving to now. */
interface Axis {
  from: number;
  span: number;
  now: number;
}

const percent = (at: number, axis: Axis) =>
  `${axis.span > 0 ? Math.min(100, Math.max(0, ((at - axis.from) / axis.span) * 100)) : 100}%`;

function pointButton(point: LanePoint, axis: Axis) {
  const time = dayText(point.at, axis.now, { time: true });
  return (
    <Tip key={point.key} content={listText(point.title, point.type, time)}>
      <button
        type="button"
        className="bl-pt"
        data-kind={point.kind}
        style={{ left: percent(point.at, axis) }}
        aria-label={t(
          { id: 'board.brief.point', defaultMessage: '{time} {type}: {title}' },
          { time, type: point.type, title: point.title },
        )}
        aria-disabled={!point.open || undefined}
        onClick={() => point.open?.()}
      >
        {point.glyph}
      </button>
    </Tip>
  );
}

/** An agent's proposal on the plan lane, named and opened once its proposal is read. */
function ProposalPoint({
  point,
  axis,
  openSession,
}: {
  point: LanePoint;
  axis: Axis;
  openSession: (sessionId: string) => void;
}) {
  const stored = useAgentProposal(point.key);
  return pointButton(
    {
      ...point,
      title: stored?.fields.name || point.title,
      open: stored ? () => openSession(stored.session_id) : undefined,
    },
    axis,
  );
}

/** What happened in the project since the user last marked it read, on a time track and as links. */
export function BriefCard({
  projectId,
  model,
  sessions,
  onOpenTask,
  run,
}: {
  projectId: string;
  model: BoardModel;
  sessions: readonly SnapshotSession[];
  onOpenTask: (taskId: string) => void;
  /** Sends a message to a lead; absent where the board takes no commands. */
  run?: RunBoardCommand;
}) {
  const { read: brief, reload } = useProjectBrief(projectId);
  const { read: decidedAfter } = useDecisionsAfter(
    brief?.items.some((item) => item.kind === 'decided') ? projectId : null,
    brief?.since ?? 0,
  );
  const events = useBoard((s) => s.events);
  const openSession = useShell((s) => s.openSession);
  const openApproved = useShell((s) => s.openProjectApproved);
  // The read the user marked read stays hidden until the brief is read again.
  const [seen, setSeen] = useState<ProjectBrief | null>(null);
  const { settings } = useAppSettings();
  const proseOn = settings !== null && settings.brief_prose !== false;
  // The briefs the paragraph was asked for, by their items, so each is asked for once.
  const asked = useRef(new Set<string>());
  // When the daemon started writing the paragraph of this project's brief.
  const [writing, setWriting] = useState<{ projectId: string; at: number } | null>(null);
  if (writing && brief?.prose) setWriting(null);
  useEffect(() => {
    if (!writing) return;
    const timer = setTimeout(() => setWriting(null), writing.at + PROSE_WAIT - Date.now());
    return () => clearTimeout(timer);
  }, [writing]);
  useEffect(() => {
    if (!brief || brief === seen || brief.prose || !proseOn) return;
    // The decided count is not part of the paragraph, so a new count asks for no new one.
    const about = brief.items.filter((item) => item.kind !== 'decided');
    if (about.length === 0) return;
    const key = JSON.stringify([projectId, brief.since, about]);
    if (asked.current.has(key)) return;
    asked.current.add(key);
    void writeBriefProse(projectId).then(
      (started) => started && setWriting({ projectId, at: Date.now() }),
    );
  }, [brief, seen, proseOn, projectId]);
  if (!brief || brief === seen || brief.items.length === 0) return null;

  const of = <K extends ProjectBriefItem['kind']>(kind: K) =>
    brief.items.filter((item): item is Of<K> => item.kind === kind);
  const sessionTitle = (id: string) =>
    sessions.find((s) => s.id === id)?.title ||
    model.merges.find((m) => m.session_id === id)?.title;
  // An event ref is the source's newest event; its aggregate is the session, or the plan's lead.
  const eventSession = (id: string) => events.findLast((e) => e.event_id === id)?.aggregate_id;
  const untitled = () =>
    t({ id: 'board.brief.untitledSession', defaultMessage: 'Untitled session' });
  const row = (key: string, icon: ReactNode, title: string) => (
    <span key={key} className="bf-brief-lk">
      {icon}
      <span>{title}</span>
    </span>
  );

  /** Where a sentence that cites the item links to, as the item's own link elsewhere in the card. */
  const proseTarget = (item: ProjectBriefItem) => {
    const ref = item.ref;
    if (ref.kind === 'task')
      return {
        title: model.tasks.find((task) => task.id === ref.id)?.title,
        open: () => onOpenTask(ref.id),
      };
    const session =
      item.kind === 'decisions'
        ? needSession(item.top)
        : item.kind === 'merge'
          ? ref.id
          : (item.kind === 'failure' || item.kind === 'assumption') && ref.kind === 'event'
            ? eventSession(ref.id)
            : undefined;
    if (!session) return null;
    return {
      title: item.kind === 'assumption' ? item.text : sessionTitle(session),
      open: () => openSession(session),
    };
  };
  /** The sentence with each cited item's title as its link, or all of it as the first one's link when no title is in it. */
  const sentence = (text: string, refs: ProjectBriefItem['ref'][], index: number) => {
    const targets = refs.flatMap((ref) => {
      const item = brief.items.find((each) => each.ref.kind === ref.kind && each.ref.id === ref.id);
      const target = item && proseTarget(item);
      return target ? [target] : [];
    });
    const found: { at: number; end: number; open: () => void }[] = [];
    for (const { title, open } of targets) {
      const at = title ? text.indexOf(title) : -1,
        end = at + (title?.length ?? 0);
      if (at >= 0 && found.every((part) => at >= part.end || end <= part.at))
        found.push({ at, end, open });
    }
    if (!found.length && targets[0]) found.push({ at: 0, end: text.length, open: targets[0].open });
    found.sort((a, b) => a.at - b.at);
    const parts: ReactNode[] = [];
    let from = 0;
    for (const part of found) {
      parts.push(text.slice(from, part.at));
      parts.push(
        <a
          key={part.at}
          className="bf-brief-ref"
          href="#"
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            part.open();
          }}
        >
          {text.slice(part.at, part.end)}
        </a>,
      );
      from = part.end;
    }
    parts.push(text.slice(from));
    return (
      <span key={index}>
        {index > 0 ? ' ' : null}
        {parts}
      </span>
    );
  };

  /** The task a failure is about: its own ref, or the plan task of the session its event came from. */
  const failedTask = (item: Of<'failure'>) => {
    if (item.ref.kind === 'task') {
      const id = item.ref.id;
      return model.tasks.find((task) => task.id === id);
    }
    const session = sessions.find(
      (s) => item.ref.kind === 'event' && s.id === eventSession(item.ref.id),
    );
    return (
      session?.task &&
      model.tasks.find((task) => task.id === `${session.task!.lead_session_id}:${session.task!.id}`)
    );
  };
  const failureOpen = (item: Of<'failure'>) => {
    const task = failedTask(item);
    if (task) return () => onOpenTask(task.id);
    const session = item.ref.kind === 'event' ? eventSession(item.ref.id) : undefined;
    return session ? () => openSession(session) : undefined;
  };
  const failureTitle = (item: Of<'failure'>) => {
    const session = item.ref.kind === 'event' ? eventSession(item.ref.id) : undefined;
    return failedTask(item)?.title || (session && sessionTitle(session)) || reasonText(item.reason);
  };

  const merges = of('merge');
  const failures = of('failure');
  const delivered: LanePoint[] = [
    ...merges.map((item): LanePoint => ({
      key: `merge:${item.ref.id}`,
      at: item.at,
      kind: 'merge',
      glyph: <Check aria-hidden="true" />,
      type: t({ id: 'board.brief.merged', defaultMessage: 'Merged' }),
      title:
        (item.ref.kind === 'task'
          ? model.tasks.find((task) => task.id === item.ref.id)?.title
          : sessionTitle(item.ref.id)) || untitled(),
      open:
        item.ref.kind === 'task' ? () => onOpenTask(item.ref.id) : () => openSession(item.ref.id),
    })),
    ...failures.map((item): LanePoint => ({
      key: `failure:${item.ref.kind}:${item.ref.id}`,
      at: item.at,
      kind: 'failure',
      glyph: <X aria-hidden="true" />,
      type: reasonText(item.reason),
      title: failureTitle(item),
      open: failureOpen(item),
    })),
  ];

  const decidedItems: readonly DecisionForUser[] = of('decided').length
    ? (decidedAfter?.items ?? [])
    : [];
  const decisionTypes = {
    permission: t({ id: 'board.brief.type.permission', defaultMessage: 'Permission approved' }),
    answer: t({ id: 'board.brief.type.answer', defaultMessage: 'Question answered' }),
    plan_change: t({ id: 'board.brief.type.planChange', defaultMessage: 'Plan changed' }),
  };
  const decided: LanePoint[] = decidedItems.map((item) => {
    const type = decisionType(item);
    const shown = decisionRow(item);
    return {
      key: `decided:${shown.key}`,
      at: item.at,
      kind: 'decided',
      glyph: <span className="bl-dot" aria-hidden="true" />,
      type: type
        ? decisionTypes[type]
        : t({ id: 'board.brief.type.other', defaultMessage: 'Decided' }),
      title: shown.action,
      open: () => openApproved(projectId, type ?? undefined, brief.since),
    };
  });
  const typeCount = (type: ReturnType<typeof decisionType>) =>
    decidedItems.filter((item) => decisionType(item) === type).length;

  const assumptions = of('assumption');
  const proposals = of('proposal');
  const planned: LanePoint[] = [
    ...assumptions.map((item): LanePoint => {
      const lead = eventSession(item.ref.id);
      return {
        key: `assumption:${item.ref.id}:${item.text}`,
        at: item.at,
        kind: 'assumption',
        glyph: <CircleDashed aria-hidden="true" />,
        type: t({ id: 'board.brief.type.assumption', defaultMessage: 'New assumption' }),
        title: item.text,
        open: lead ? () => openSession(lead) : undefined,
      };
    }),
    ...proposals.map((item): LanePoint => ({
      key: item.ref.id,
      at: item.at,
      kind: 'proposal',
      glyph: <Square aria-hidden="true" />,
      type: t({ id: 'board.brief.type.proposal', defaultMessage: 'Agent proposal' }),
      title: t({ id: 'board.brief.untitledProposal', defaultMessage: 'Untitled proposal' }),
    })),
  ];

  const times = [...delivered, ...decided, ...planned].map((point) => point.at);
  // Without a seen cursor the track starts at the first event.
  const from = brief.since > 0 ? brief.since : Math.min(model.now - HOUR, ...times);
  const axis: Axis = { from, span: model.now - from, now: model.now };
  const marks = hourMarks(from, model.now);
  const lanes: { key: string; name: string; parts: (string | false)[]; points: ReactNode[] }[] = [
    {
      key: 'delivered',
      name: t({ id: 'board.brief.lane.delivered', defaultMessage: 'Delivered' }),
      parts: [
        merges.length > 0 &&
          t(
            { id: 'board.brief.mergedCount', defaultMessage: '{count} merged' },
            { count: merges.length },
          ),
        failures.length > 0 &&
          t(
            { id: 'board.brief.failedCount', defaultMessage: '{count} failed' },
            { count: failures.length },
          ),
      ],
      points: delivered.map((point) => pointButton(point, axis)),
    },
    {
      key: 'decided',
      name: t({ id: 'board.brief.decided', defaultMessage: 'Decided for you' }),
      parts: [
        typeCount('permission') > 0 &&
          t(
            {
              id: 'board.brief.decidedPermissions',
              defaultMessage: '{count, plural, one {# permission} other {# permissions}}',
            },
            { count: typeCount('permission') },
          ),
        typeCount('answer') > 0 &&
          t(
            {
              id: 'board.brief.decidedAnswers',
              defaultMessage: '{count, plural, one {# answer} other {# answers}}',
            },
            { count: typeCount('answer') },
          ),
        typeCount('plan_change') > 0 &&
          t(
            {
              id: 'board.brief.decidedPlanChanges',
              defaultMessage: '{count, plural, one {# plan change} other {# plan changes}}',
            },
            { count: typeCount('plan_change') },
          ),
        typeCount(null) > 0 &&
          t(
            {
              id: 'board.brief.decidedOther',
              defaultMessage: '{count, plural, one {# other} other {# others}}',
            },
            { count: typeCount(null) },
          ),
      ],
      points: decided.map((point) => pointButton(point, axis)),
    },
    {
      key: 'planned',
      name: t({ id: 'board.brief.lane.plan', defaultMessage: 'Plan' }),
      parts: [
        assumptions.length > 0 &&
          t(
            {
              id: 'board.brief.assumptionsCount',
              defaultMessage: '{count, plural, one {# new assumption} other {# new assumptions}}',
            },
            { count: assumptions.length },
          ),
        proposals.length > 0 &&
          t(
            {
              id: 'board.brief.proposalsCount',
              defaultMessage: '{count, plural, one {# agent proposal} other {# agent proposals}}',
            },
            { count: proposals.length },
          ),
      ],
      points: planned.map((point) =>
        point.kind === 'proposal' ? (
          <ProposalPoint key={point.key} point={point} axis={axis} openSession={openSession} />
        ) : (
          pointButton(point, axis)
        ),
      ),
    },
  ];

  const rows: ReactNode[] = [];
  const decisions = of('decisions')[0];
  if (decisions)
    rows.push(
      row(
        'decisions',
        <span className="ss-dot waiting" aria-hidden="true" />,
        t(
          {
            id: 'board.brief.waitingCount',
            defaultMessage:
              '{count, plural, one {# decision waiting on you} other {# decisions waiting on you}}',
          },
          { count: decisions.count },
        ),
      ),
    );
  // A milestone's move has no time, so it stays a line under the track.
  for (const item of of('milestone'))
    rows.push(row(`milestone:${item.ref.id}`, <Flag aria-hidden="true" />, item.title));
  for (const item of decidedItems) {
    if (
      item.kind !== 'power_used' ||
      item.power !== 'accept_milestone' ||
      !item.verification ||
      !item.reason
    )
      continue;
    const milestone =
      model.milestones.find((each) => each.id === item.subject)?.title ?? item.subject;
    const title = t(
      { id: 'board.brief.leadAccepted', defaultMessage: '{lead} accepted {milestone}' },
      { lead: sessionTitle(item.session_id) || untitled(), milestone },
    );
    rows.push(
      <div
        key={`${item.subject}:${item.at}`}
        className="bf-brief-it bf-brief-ov"
        role="group"
        aria-label={title}
      >
        <span className="bf-brief-lk">
          <Crown aria-hidden="true" />
          <span>{title}</span>
        </span>
        {/* The decision keeps the state the run had then, not when the run started. */}
        <span className="bf-brief-n">
          {/* The record has no start time to count a running verification from. */}
          {item.verification.state === 'pending' || item.verification.state === 'running'
            ? t({ id: 'board.verify.badge.runningNoTime', defaultMessage: 'Verifying' })
            : verifyText(
                { started_at: item.at, ...item.verification } as Parameters<typeof verifyText>[0],
                item.at,
              )}
        </span>
        <Clip as="div" lines={3} className="bf-brief-why" text={item.reason} />
        {run && (
          <TellLead
            className="btn bf-brief-tell"
            lead={sessions.find((s) => s.id === item.session_id)}
            draft={tellLeadDraft('milestone', milestone, item.subject)}
            label={milestone}
            run={run}
            text={t({ id: 'board.verify.card.tellLead', defaultMessage: 'Tell lead' })}
          />
        )}
      </div>,
    );
  }

  const failRow = (item: Of<'failure'>) => {
    const task = failedTask(item);
    const open = failureOpen(item);
    const steps = (task?.gate_steps ?? []).filter((step) => step.state === 'failed');
    const content = (
      <>
        <StatusIcon status="failed" />
        <span className="bf-brief-fn">{failureTitle(item)}</span>
        {steps.length > 0 && (
          <span className="bf-brief-fs">{listText(...steps.map((step) => step.name))}</span>
        )}
        {task?.rung && <RungLabel rung={task.rung} />}
      </>
    );
    const key = `${item.ref.kind}:${item.ref.id}`;
    return open ? (
      <a
        key={key}
        className="bf-brief-fail"
        href="#"
        onClick={(e: MouseEvent) => {
          e.preventDefault();
          open();
        }}
      >
        {content}
      </a>
    ) : (
      <span key={key} className="bf-brief-fail">
        {content}
      </span>
    );
  };

  const read = async () => {
    const result = await markProjectSeen(projectId);
    if (!result.ok) {
      toast({ title: result.error, kind: 'failure' });
      return;
    }
    setSeen(brief);
    reload();
  };
  const title = t({ id: 'board.brief.label', defaultMessage: 'Since you left' });
  return (
    <section className="bf-brief" role="group" aria-label={title}>
      <div className="bd-ph">
        <h2>{title}</h2>
        {brief.since > 0 && (
          <time className="bf-brief-at" dateTime={new Date(brief.since).toISOString()}>
            {t(
              { id: 'board.brief.away', defaultMessage: 'Away {duration}' },
              { duration: durationText(model.now - brief.since) },
            )}
          </time>
        )}
        <button type="button" className="btn bf-brief-read" onClick={() => void read()}>
          {t({ id: 'board.brief.read', defaultMessage: 'Mark as read' })}
        </button>
      </div>
      <div className="bf-brief-box">
        {!brief.prose && writing?.projectId === projectId && (
          <div className="bf-brief-p">
            <RunningFor label={RUNNING.writing} since={writing.at} />
          </div>
        )}
        {brief.prose && (
          <div className="bf-brief-p">
            <p className="bf-brief-prose">
              {brief.prose.sentences.map((each, i) => sentence(each.text, each.refs, i))}
            </p>
            <span className="bf-brief-who">
              <Bot aria-hidden="true" />
              <span>{t({ id: 'board.brief.assistant', defaultMessage: 'Assistant' })}</span>
              <time className="bf-brief-at" dateTime={new Date(brief.prose.at).toISOString()}>
                {t(
                  { id: 'board.brief.writtenAt', defaultMessage: 'Written at {time}' },
                  { time: dayText(brief.prose.at, model.now, { time: true }) },
                )}
              </time>
            </span>
          </div>
        )}
        <div className="bl-tl">
          <div className="bl-ls" aria-hidden="true">
            {lanes.map((lane) => (
              <span key={lane.key} className="bl-l">
                {lane.name}
                <span className="bl-n">{lane.points.length}</span>
              </span>
            ))}
          </div>
          <div className="bl-tr">
            {marks.map((at) => (
              <i key={at} className="bl-g" style={{ left: percent(at, axis) }} aria-hidden="true" />
            ))}
            <i className="bl-g" data-now="" style={{ left: '100%' }} aria-hidden="true" />
            {lanes.map((lane) => (
              <div
                key={lane.key}
                className="bl-k"
                role="group"
                aria-label={
                  lane.points.length
                    ? t(
                        {
                          id: 'board.brief.laneLabel',
                          defaultMessage:
                            '{lane}, {count, plural, one {# item} other {# items}}: {parts}',
                        },
                        {
                          lane: lane.name,
                          count: lane.points.length,
                          parts: listText(...lane.parts),
                        },
                      )
                    : t(
                        { id: 'board.brief.laneEmpty', defaultMessage: '{lane}, nothing' },
                        { lane: lane.name },
                      )
                }
              >
                {lane.points}
              </div>
            ))}
            <div className="bl-ax" aria-hidden="true">
              <span style={{ left: 0 }}>{dayText(from, model.now, { time: true })}</span>
              {marks.map((at) => (
                <span key={at} style={{ left: percent(at, axis) }}>
                  {axis.span > 24 * HOUR ? dayText(at, model.now) : clockText(at)}
                </span>
              ))}
              <span style={{ left: '100%' }}>
                {t({ id: 'board.brief.now', defaultMessage: 'Now' })}
              </span>
            </div>
          </div>
        </div>
        {rows.length > 0 && <div className="bf-brief-rows">{rows}</div>}
        {failures.length > 0 && <div className="bf-brief-rows">{failures.map(failRow)}</div>}
      </div>
    </section>
  );
}
