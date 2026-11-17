import { useState, type MouseEvent, type ReactNode } from 'react';
import { Flag, GitMerge, Lightbulb } from 'lucide-react';
import type { BoardModel, ProjectBrief, ProjectBriefItem } from '@pantheon/protocol';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { reasonText } from '../../data/needs-you';
import { markProjectSeen, useProjectBrief } from '../../data/project-brief';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import { needSession, needWhat } from './frame-model';
import type { SnapshotSession } from './panels-model';
import { StatusIcon } from './status';
import './frame.css';

type Of<K extends ProjectBriefItem['kind']> = Extract<ProjectBriefItem, { kind: K }>;

/** What happened in the project since the user last marked it read, as counts and links. */
export function BriefCard({
  projectId,
  model,
  sessions,
  onOpenTask,
}: {
  projectId: string;
  model: BoardModel;
  sessions: readonly SnapshotSession[];
  onOpenTask: (taskId: string) => void;
}) {
  const { read: brief, reload } = useProjectBrief(projectId);
  const events = useBoard((s) => s.events);
  const openSession = useShell((s) => s.openSession);
  // The read the user marked read stays hidden until the brief is read again.
  const [seen, setSeen] = useState<ProjectBrief | null>(null);
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
      rows: (
        <>
          {target(
            'top',
            <StatusIcon status="waiting" />,
            decisions.ref,
            needSession(decisions.top),
            needWhat(decisions.top),
          )}
          {decisions.top.blocks > 0 && (
            <span className="bf-brief-n">
              {t(
                {
                  id: 'board.brief.blocks',
                  defaultMessage: 'Blocks {count, plural, one {# task} other {# tasks}}',
                },
                { count: decisions.top.blocks },
              )}
            </span>
          )}
        </>
      ),
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
          <span className="bf-brief-frac">
            {t(
              { id: 'board.brief.milestoneDone', defaultMessage: '{done} / {total}' },
              { done: item.done, total: item.total },
            )}
          </span>
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
      {cells.map((cell) => (
        <div key={cell.key} className="cell bf-brief-c" role="group" aria-label={cell.label}>
          <span className="cap">{cell.cap}</span>
          <span className="kpi">{cell.count}</span>
          {cell.rows}
        </div>
      ))}
    </section>
  );
}
