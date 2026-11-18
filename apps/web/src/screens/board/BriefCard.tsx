import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import {
  Bot,
  Crown,
  Ellipsis,
  Flag,
  GitMerge,
  KeyRound,
  Lightbulb,
  MessageSquare,
  Workflow,
} from 'lucide-react';
import type { BoardModel, ProjectBrief, ProjectBriefItem } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { toast } from '../../components/Toast';
import { useAppSettings } from '../../data/app-settings';
import { useBoard } from '../../data/board';
import { useDecisionsAfter } from '../../data/decisions-for-user';
import { reasonText } from '../../data/needs-you';
import { markProjectSeen, useProjectBrief, writeBriefProse } from '../../data/project-brief';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import { needSession } from './frame-model';
import { verifyText } from './MilestoneCard';
import { tellLeadDraft, type RunBoardCommand, type SnapshotSession } from './panels-model';
import { StatusIcon } from './status';
import { TellLead } from './TellLead';
import './frame.css';

type Of<K extends ProjectBriefItem['kind']> = Extract<ProjectBriefItem, { kind: K }>;

/** What happened in the project since the user last marked it read, as counts and links. */
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
  // The cell whose items show in its popover.
  const [open, setOpen] = useState<string | null>(null);
  const { settings } = useAppSettings();
  const proseOn = settings !== null && settings.brief_prose !== false;
  // The briefs the paragraph was asked for, by their items, so each is asked for once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!brief || brief === seen || brief.prose || !proseOn) return;
    // The decided count is not part of the paragraph, so a new count asks for no new one.
    const about = brief.items.filter((item) => item.kind !== 'decided');
    if (about.length === 0) return;
    const key = JSON.stringify([projectId, brief.since, about]);
    if (asked.current.has(key)) return;
    asked.current.add(key);
    void writeBriefProse(projectId);
  }, [brief, seen, proseOn, projectId]);
  if (!brief || brief === seen || brief.items.length === 0) return null;

  const of = <K extends ProjectBriefItem['kind']>(kind: K) =>
    brief.items.filter((item): item is Of<K> => item.kind === kind);
  const sessionTitle = (id: string) =>
    sessions.find((s) => s.id === id)?.title ||
    model.merges.find((m) => m.session_id === id)?.title;
  // An event ref is the source's newest event; its aggregate is the session, or the plan's lead.
  const eventSession = (id: string) => events.findLast((e) => e.event_id === id)?.aggregate_id;
  const link = (key: string, icon: ReactNode, title: string, open: () => void) => (
    <a
      key={key}
      className="bf-brief-lk"
      href="#"
      onClick={(e: MouseEvent) => {
        e.preventDefault();
        setOpen(null);
        open();
      }}
    >
      {icon}
      <span>{title}</span>
    </a>
  );
  const row = (key: string, icon: ReactNode, title: string) => (
    <span key={key} className="bf-brief-lk">
      {icon}
      <span>{title}</span>
    </span>
  );
  /** A link to the task in the board's drawer or to the session; a plain row without either. */
  const target = (
    key: string,
    icon: ReactNode,
    ref: ProjectBriefItem['ref'],
    session: string | null | undefined,
    fallback: string,
  ) => {
    if (ref.kind === 'task') {
      const title = model.tasks.find((task) => task.id === ref.id)?.title || fallback;
      return link(key, icon, title, () => onOpenTask(ref.id));
    }
    if (!session) return row(key, icon, fallback);
    return link(key, icon, sessionTitle(session) || fallback, () => openSession(session));
  };

  /** Where a sentence that cites the item links to, as the item's own link in its cell. */
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

  const decisions = of('decisions')[0];
  const cells: { key: string; cap: string; label: string; count: number; rows: ReactNode }[] = [];
  if (decisions)
    cells.push({
      key: 'decisions',
      cap: t({ id: 'board.brief.waiting', defaultMessage: 'Waiting on you' }),
      label: t(
        {
          id: 'board.brief.waitingCount',
          defaultMessage:
            '{count, plural, one {# decision waiting on you} other {# decisions waiting on you}}',
        },
        { count: decisions.count },
      ),
      count: decisions.count,
      rows: null,
    });
  const milestones = of('milestone');
  if (milestones.length)
    cells.push({
      key: 'milestones',
      cap: t({ id: 'board.brief.milestones', defaultMessage: 'Milestones moved' }),
      label: t(
        {
          id: 'board.brief.milestonesCount',
          defaultMessage: '{count, plural, one {# milestone moved} other {# milestones moved}}',
        },
        { count: milestones.length },
      ),
      count: milestones.length,
      rows: milestones.map((item) => (
        <span key={item.ref.id} className="bf-brief-lk">
          <Flag aria-hidden="true" />
          <span>{item.title}</span>
        </span>
      )),
    });
  const merges = of('merge');
  if (merges.length)
    cells.push({
      key: 'merges',
      cap: t({ id: 'board.brief.merged', defaultMessage: 'Merged' }),
      label: t(
        { id: 'board.brief.mergedCount', defaultMessage: '{count} merged' },
        { count: merges.length },
      ),
      count: merges.length,
      rows: merges.map((item) =>
        target(
          item.ref.id,
          <GitMerge aria-hidden="true" />,
          item.ref,
          item.ref.id,
          t({ id: 'board.brief.untitledSession', defaultMessage: 'Untitled session' }),
        ),
      ),
    });
  const failures = of('failure');
  if (failures.length)
    cells.push({
      key: 'failures',
      cap: t({ id: 'board.brief.failed', defaultMessage: 'Failed' }),
      label: t(
        { id: 'board.brief.failedCount', defaultMessage: '{count} failed' },
        { count: failures.length },
      ),
      count: failures.length,
      rows: failures.map((item) => {
        const key = `${item.ref.kind}:${item.ref.id}`;
        const why = reasonText(item.reason);
        const session = item.ref.kind === 'event' ? eventSession(item.ref.id) : undefined;
        if (item.ref.kind !== 'task' && !session)
          return row(key, <StatusIcon status="failed" />, why);
        return (
          <span key={key} className="bf-brief-it">
            {target('item', <StatusIcon status="failed" />, item.ref, session, why)}
            <span className="bf-brief-n">{why}</span>
          </span>
        );
      }),
    });
  const decided = of('decided')[0];
  if (decided) {
    const other =
      decided.count - (decided.types.permission + decided.types.answer + decided.types.plan_change);
    cells.push({
      key: 'decided',
      cap: t({ id: 'board.brief.decided', defaultMessage: 'Decided for you' }),
      label: t(
        { id: 'board.brief.decidedCount', defaultMessage: '{count} decided for you' },
        { count: decided.count },
      ),
      count: decided.count,
      rows: (
        [
          [
            'permission',
            <KeyRound aria-hidden="true" />,
            t(
              {
                id: 'board.brief.decidedPermissions',
                defaultMessage: '{count, plural, one {# permission} other {# permissions}}',
              },
              { count: decided.types.permission },
            ),
          ],
          [
            'answer',
            <MessageSquare aria-hidden="true" />,
            t(
              {
                id: 'board.brief.decidedAnswers',
                defaultMessage: '{count, plural, one {# answer} other {# answers}}',
              },
              { count: decided.types.answer },
            ),
          ],
          [
            'plan_change',
            <Workflow aria-hidden="true" />,
            t(
              {
                id: 'board.brief.decidedPlanChanges',
                defaultMessage: '{count, plural, one {# plan change} other {# plan changes}}',
              },
              { count: decided.types.plan_change },
            ),
          ],
        ] as const
      )
        .filter(([type]) => decided.types[type] > 0)
        .map(([type, icon, title]) =>
          link(type, icon, title, () => openApproved(projectId, type, brief.since)),
        )
        .concat(
          other > 0
            ? [
                link(
                  'other',
                  <Ellipsis aria-hidden="true" />,
                  t(
                    {
                      id: 'board.brief.decidedOther',
                      defaultMessage: '{count, plural, one {# other} other {# others}}',
                    },
                    { count: other },
                  ),
                  () => openApproved(projectId, undefined, brief.since),
                ),
              ]
            : [],
        )
        .concat(
          (decidedAfter?.items ?? []).flatMap((item) => {
            if (
              item.kind !== 'power_used' ||
              item.power !== 'accept_milestone' ||
              !item.verification ||
              !item.reason
            )
              return [];
            const milestone =
              model.milestones.find((each) => each.id === item.subject)?.title ?? item.subject;
            const title = t(
              { id: 'board.brief.leadAccepted', defaultMessage: '{lead} accepted {milestone}' },
              {
                lead:
                  sessionTitle(item.session_id) ||
                  t({ id: 'board.brief.untitledSession', defaultMessage: 'Untitled session' }),
                milestone,
              },
            );
            return [
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
                        { started_at: item.at, ...item.verification } as Parameters<
                          typeof verifyText
                        >[0],
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
            ];
          }),
        ),
    });
  }
  const assumptions = of('assumption');
  if (assumptions.length)
    cells.push({
      key: 'assumptions',
      cap: t({ id: 'board.brief.assumptions', defaultMessage: 'New assumptions' }),
      label: t(
        {
          id: 'board.brief.assumptionsCount',
          defaultMessage: '{count, plural, one {# new assumption} other {# new assumptions}}',
        },
        { count: assumptions.length },
      ),
      count: assumptions.length,
      rows: assumptions.map((item) => {
        const lead = eventSession(item.ref.id);
        const icon = <Lightbulb aria-hidden="true" />;
        return lead
          ? link(`${item.ref.id}:${item.text}`, icon, item.text, () => openSession(lead))
          : row(`${item.ref.id}:${item.text}`, icon, item.text);
      }),
    });
  const proposals = of('proposal');
  if (proposals.length)
    cells.push({
      key: 'proposals',
      cap: t({ id: 'board.brief.proposals', defaultMessage: 'Agent proposals' }),
      label: t(
        {
          id: 'board.brief.proposalsCount',
          defaultMessage: '{count, plural, one {# agent proposal} other {# agent proposals}}',
        },
        { count: proposals.length },
      ),
      count: proposals.length,
      rows: null,
    });

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
    <section
      className="panel bf-brief"
      role="group"
      aria-label={title}
      style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
    >
      <div className="cell bf-brief-h">
        <span className="bf-brief-t">{title}</span>
        {brief.since > 0 && (
          <time className="bf-brief-at" dateTime={new Date(brief.since).toISOString()}>
            {dayText(brief.since, model.now, { time: true })}
          </time>
        )}
        <button type="button" className="btn bf-brief-read" onClick={() => void read()}>
          {t({ id: 'board.brief.read', defaultMessage: 'Mark as read' })}
        </button>
      </div>
      {cells.map((cell) =>
        cell.rows === null ? (
          <div key={cell.key} className="cell bf-brief-c" role="group" aria-label={cell.label}>
            <span className="cap">{cell.cap}</span>
            <span className="kpi">{cell.count}</span>
          </div>
        ) : (
          <Popover.Root
            key={cell.key}
            open={open === cell.key}
            onOpenChange={(next) => setOpen(next ? cell.key : null)}
          >
            <Popover.Trigger
              className="cell bf-brief-c"
              aria-label={cell.label}
              aria-haspopup="dialog"
              aria-expanded={open === cell.key}
            >
              <span className="cap">{cell.cap}</span>
              <span className="kpi">{cell.count}</span>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
                <Popover.Popup className="pop bf-brief-pop" aria-label={cell.label}>
                  {cell.rows}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ),
      )}
      {brief.prose && (
        <div className="cell bf-brief-p">
          <span className="bf-brief-who">
            <Bot aria-hidden="true" />
            <span>{t({ id: 'board.brief.assistant', defaultMessage: 'Assistant' })}</span>
          </span>
          <p className="bf-brief-prose">
            {brief.prose.sentences.map((each, i) => sentence(each.text, each.refs, i))}
          </p>
        </div>
      )}
    </section>
  );
}
