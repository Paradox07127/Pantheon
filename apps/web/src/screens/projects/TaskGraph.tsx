import { useMemo, useState, type CSSProperties } from 'react';
import type { BaselineTask, BaselineWorkstream } from '@pantheon/domain';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { archLayout, sourceText } from '../memory/intro-model';
import { WORKSTREAM_STATUS } from './facts';
import './task-graph.css';

/** A task node holds its title over its workstream's status dot and title. */
const TASK_NODE = { w: 220, h: 56 } as const;

/** Tasks in columns from the tasks they depend on; a node picks the task detailed below. */
export function TaskGraph({
  tasks,
  workstreams,
}: {
  tasks: readonly BaselineTask[];
  workstreams: readonly BaselineWorkstream[];
}) {
  const edges = tasks.flatMap((x) => x.depends_on.map((from) => ({ from, to: x.id })));
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  // Tasks with no dependency either way wrap in a grid under the drawn graph.
  const laid = useMemo(
    () =>
      archLayout(
        {
          nodes: tasks.filter((x) => linked.has(x.id)).map((x) => ({ id: x.id, label: x.title })),
          edges,
        },
        TASK_NODE,
      ),
    [tasks],
  );
  const [picked, setPicked] = useState(tasks[0]!.id);
  const task = tasks.find((x) => x.id === picked) ?? tasks[0]!;
  const node = (item: BaselineTask, style?: CSSProperties) => {
    const ws = workstreams.find((w) => w.id === item.workstream);
    const tone = ws ? WORKSTREAM_STATUS[ws.status].tone : '';
    return (
      <button
        key={item.id}
        type="button"
        className="tg-nd"
        aria-pressed={item.id === task.id}
        onClick={() => setPicked(item.id)}
        style={style}
      >
        <span className="tg-ttl">{item.title}</span>
        {ws && <span className={tone ? `tr-st tg-ws ${tone}` : 'tr-st tg-ws'}>{ws.title}</span>}
      </button>
    );
  };
  const loose = tasks.filter((x) => !linked.has(x.id));
  return (
    <>
      <div
        className="tg-dag"
        role="group"
        aria-label={t(
          {
            id: 'projects.baseline.tasks.graph',
            defaultMessage:
              'Next task dependencies: {tasks, plural, one {# task} other {# tasks}}, {deps, plural, one {# dependency} other {# dependencies}}',
          },
          { tasks: tasks.length, deps: laid.edges.length },
        )}
      >
        {linked.size > 0 && (
          <div className="tg-map" style={{ width: laid.width, height: laid.height }}>
            <svg
              width={laid.width}
              height={laid.height}
              viewBox={`0 0 ${laid.width} ${laid.height}`}
              aria-hidden="true"
            >
              {laid.edges.map((edge) => (
                <path key={`${edge.from}:${edge.to}`} className="tg-eg" d={edge.d} />
              ))}
            </svg>
            {laid.nodes.map((at) =>
              node(
                tasks.find((x) => x.id === at.id)!,
                {
                  position: 'absolute',
                  left: at.x,
                  top: at.y,
                  width: TASK_NODE.w,
                  height: TASK_NODE.h,
                },
              ),
            )}
          </div>
        )}
        {loose.length > 0 && <div className="tg-grid">{loose.map((x) => node(x))}</div>}
      </div>
      <div className="tg-det" aria-live="polite">
        <span>{t({ id: 'projects.baseline.tasks.why', defaultMessage: 'Why' })}</span>
        <span className="tg-why">{task.why}</span>
        <span>{t({ id: 'projects.baseline.tasks.scope', defaultMessage: 'Scope' })}</span>
        <span className="mono">{listText(...task.scope)}</span>
        <span>{t({ id: 'projects.baseline.tasks.acceptance', defaultMessage: 'Acceptance' })}</span>
        <span className="mono tg-cmds">
          {task.acceptance.map((command, i) => (
            <span key={i}>{command}</span>
          ))}
        </span>
        <span>{t({ id: 'projects.baseline.tasks.sources', defaultMessage: 'Sources' })}</span>
        <span className="mono mu">{listText(...task.sources.map(sourceText))}</span>
      </div>
    </>
  );
}
