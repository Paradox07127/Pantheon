import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from 'react';
import { flushSync } from 'react-dom';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  BaseEdge,
  EdgeLabelRenderer,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Check, Crown, Minus, Plus, Settings2, Trash, User, type LucideProps } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useNow } from '../../data/needs-you';
import {
  addDraftEdit,
  changeDraftEdit,
  removeDraftEdit,
  startPlanTasks,
  useDraftEdits,
} from '../../data/plan-draft';
import {
  connectRefusal,
  dependencies,
  editTarget,
  withDependency,
  withoutDependency,
  type PlanOp,
} from '../../data/plan-edit';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import { activityNote } from './activity';
import {
  MAX_USER_ZOOM,
  MIN_USER_ZOOM,
  NODE_HEIGHT,
  NODE_WIDTH,
  flowLayout,
  flowZoom,
  layoutKey,
  type FlowGroup,
  type FlowLayout,
} from './flow-layout';
import { TaskCard, type TaskNode } from './FlowNode';
import {
  ConnectionLine,
  DraftCard,
  ExpandGraph,
  FlowLegend,
  NeedsCount,
  chartProject,
  draftText,
  flowGraph,
  nextWaiting,
  overlayTitle,
  withDrafts,
  type DraftNode,
  type GraphExpand,
} from './FlowOverlays';
import { MergedStack, STACK_WIDTH, type StackNode } from './MergedStack';
import { currentMilestone, verifyText } from './MilestoneCard';
import { MilestoneNode, type MilestoneFlowNode } from './MilestoneNode';
import { taskStateLabel } from './status';
import type { TaskDrawerProps } from './TaskDrawer';
import { criticalPath, readyTasks } from './view-rules';
import './flow.css';
import './adaptive.css';

type Task = BoardModel['tasks'][number];
/** `blocked`: the upstream task failed. */
type EdgeState = BoardModel['edges'][number]['state'] | 'blocked';
type FlowEdge = Edge<
  {
    state: EdgeState;
    gap: number;
    /** `<upstream title> 到 <downstream title>`. */
    label: string;
    picked: boolean;
    /** Removes the dependency; absent on a read-only chart. */
    onDelete?: () => void;
  },
  'flow'
>;

/** Space around the drawn graph, in screen pixels. */
const EDGE = 24;
const EDGE_STATES: EdgeState[] = ['met', 'pending', 'active', 'blocked'];
const EDGE_COLOR: Record<EdgeState, string> = {
  met: 'var(--e-done)',
  pending: 'var(--e-str)',
  active: 'var(--e-act)',
  blocked: 'var(--bad)',
};

function StateEdge(props: EdgeProps<FlowEdge>) {
  const { state, gap, label, picked, onDelete } = props.data!;
  // Rows change in the gap after the source; the layout keeps the target's row clear up to it.
  const turn = Math.min(props.targetX, props.sourceX + gap);
  const [curve, labelX, labelY] = getBezierPath({ ...props, targetX: turn });
  const path = turn < props.targetX ? `${curve} L${props.targetX},${props.targetY}` : curve;
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={`url(#bd-ar-${state})`} />
      {/* The moving dashes of a running upstream; drawn on every edge so they fade out once it stops. */}
      <path className="bd-pulse" d={path} />
      {picked && onDelete && (
        <EdgeLabelRenderer>
          <div
            className="bd-edel nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <button
              type="button"
              className="ib"
              aria-label={t(
                { id: 'board.plan.flow.removeEdge', defaultMessage: 'Remove dependency: {edge}' },
                { edge: label },
              )}
              onClick={onDelete}
            >
              <Trash aria-hidden="true" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

type ChartNode = TaskNode | StackNode | MilestoneFlowNode | DraftNode;
type DependencyOp = Extract<PlanOp, { type: 'set_dependencies' }>;

const NODE_TYPES = {
  task: TaskCard,
  stack: MergedStack,
  milestone: MilestoneNode,
  draft: DraftCard,
};
const EDGE_TYPES = { flow: StateEdge };
// Nodes can be neither deleted nor moved; xyflow shows the keyboardDisabled text while keyboard access is on.
const nodeHint = () =>
  t({
    id: 'board.plan.flow.nodeHint',
    defaultMessage: 'Press Enter or Space to open the task details.',
  });
const ARIA_LABELS = {
  get 'node.a11yDescription.default'() {
    return nodeHint();
  },
  get 'node.a11yDescription.keyboardDisabled'() {
    return nodeHint();
  },
};

type LaneCount = 'merged' | 'running' | 'waiting' | 'stuck' | 'todo' | 'discarded';
const LANE_COUNTS: { key: Exclude<LaneCount, 'merged'>; text: (count: number) => string }[] = [
  {
    key: 'running',
    text: (count) =>
      t({ id: 'board.canvas.band.running', defaultMessage: '{count} running' }, { count }),
  },
  {
    key: 'waiting',
    text: (count) =>
      t({ id: 'board.canvas.band.waiting', defaultMessage: '{count} waiting for you' }, { count }),
  },
  {
    key: 'stuck',
    text: (count) =>
      t({ id: 'board.canvas.band.stuck', defaultMessage: '{count} stuck' }, { count }),
  },
  {
    key: 'todo',
    text: (count) =>
      t({ id: 'board.canvas.band.todo', defaultMessage: '{count} not started' }, { count }),
  },
  {
    key: 'discarded',
    text: (count) =>
      t({ id: 'board.canvas.band.discarded', defaultMessage: '{count} discarded' }, { count }),
  },
];

/** Where a task counts in its band's bar; a row without a state goes by its status. */
function laneCount(task: Task): LaneCount | null {
  if (edgeState(task) === 'met') return 'merged';
  switch (task.state ?? task.status) {
    case 'running':
    case 'claimed':
    case 'gating':
      return 'running';
    case 'waiting_approval':
    case 'awaiting_acceptance':
    case 'awaiting_merge':
    case 'waiting':
    case 'ready':
      return 'waiting';
    case 'blocked':
    case 'needs_attention':
    case 'failed':
      return 'stuck';
    case 'todo':
    case 'waiting_upstream':
    case 'idle':
      return 'todo';
    case 'discarded':
      return 'discarded';
    default:
      return null;
  }
}

type Lane = BoardModel['lanes'][number];
type Depth = NonNullable<Lane['depth']>;

const DEPTHS: { key: Depth; label: () => string }[] = [
  {
    key: 'just_do',
    label: () => t({ id: 'board.canvas.lane.depth.justDo', defaultMessage: 'Just do it' }),
  },
  {
    key: 'plan_first',
    label: () => t({ id: 'board.canvas.lane.depth.planFirst', defaultMessage: 'Plan first' }),
  },
  {
    key: 'spec_first',
    label: () => t({ id: 'board.canvas.lane.depth.specFirst', defaultMessage: 'Spec first' }),
  },
];

const CHOSEN_BY: Record<
  NonNullable<Lane['depth_by']>,
  { Icon: ComponentType<LucideProps>; label: () => string }
> = {
  lead: {
    Icon: Crown,
    label: () => t({ id: 'board.canvas.lane.by.lead', defaultMessage: 'Lead' }),
  },
  user: { Icon: User, label: () => t({ id: 'board.canvas.lane.by.user', defaultMessage: 'You' }) },
  pantheon: {
    Icon: Settings2,
    label: () => t({ id: 'board.canvas.lane.by.pantheon', defaultMessage: 'Pantheon' }),
  },
};

// Band titles, bars, counts and separators sit under the flow and follow its pan and zoom.
// A stack counts as its tasks; the milestone and drafted tasks do not count.
function Lanes({
  layout,
  tasks,
  stacks,
  heads,
  now,
  onDepth,
}: {
  layout: FlowLayout;
  tasks: ReadonlyMap<string, Task>;
  stacks: ReadonlyMap<string, readonly string[]>;
  /** The plan lanes by id, whose bands get a head with their depth; empty in another grouping. */
  heads: ReadonlyMap<string, Lane>;
  now: number;
  /** Sets a lane's depth; absent on a read-only chart. */
  onDepth?: (laneId: string, depth: Depth) => void;
}) {
  const { x, y, zoom } = useViewport();
  return (
    <div className="bd-lanes" style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}>
      {layout.lanes.map((lane) => {
        const counts = new Map<LaneCount, number>();
        const counted = lane.tasks.flatMap((id) => stacks.get(id) ?? [id]).filter(tasks.has, tasks);
        for (const id of counted) {
          const at = laneCount(tasks.get(id)!);
          if (at) counts.set(at, (counts.get(at) ?? 0) + 1);
        }
        const merged = counts.get('merged') ?? 0;
        const total = counted.length;
        const head = lane.id === null ? undefined : heads.get(lane.id);
        const by = head?.depth_by && CHOSEN_BY[head.depth_by];
        const reason =
          head?.depth_by === 'lead'
            ? head.depth_reason
            : head?.depth_by === 'pantheon'
              ? t({
                  id: 'board.canvas.lane.reason.pantheon',
                  defaultMessage: 'Holds a top-tier task',
                })
              : undefined;
        return (
          <div
            key={lane.id ?? ''}
            className="bd-lane"
            style={{ top: lane.y, height: lane.height, width: layout.width }}
            data-head={head ? layout.headRows : undefined}
            {...(lane.fanout_reason
              ? { role: 'group', 'aria-label': listText(lane.title, lane.fanout_reason) }
              : {})}
          >
            {head ? (
              <div className="bd-lane-h">
                <span className="bd-lane-ht" title={lane.title || undefined}>
                  {lane.title}
                </span>
                <RadioGroup<Depth | null>
                  className="tb-seg"
                  aria-label={t(
                    { id: 'board.canvas.lane.depth.label', defaultMessage: 'Depth of {lane}' },
                    { lane: lane.title },
                  )}
                  value={head.depth ?? null}
                  disabled={!onDepth}
                  onValueChange={(depth) => depth && onDepth?.(head.id, depth)}
                >
                  {DEPTHS.map((d) => (
                    <Radio.Root key={d.key} value={d.key}>
                      {d.label()}
                    </Radio.Root>
                  ))}
                </RadioGroup>
                <span className="bd-lane-hs">
                  {by && (
                    <span className="bd-lane-by" data-user={head.depth_by === 'user' || undefined}>
                      <by.Icon aria-hidden="true" />
                      {by.label()}
                    </span>
                  )}
                  {reason && <Clip text={reason} className="bd-lane-why" />}
                  {head.stop && (
                    <span className="bd-lane-stop">
                      {head.stop.state === 'waiting' ? (
                        <span className="chip">
                          <User aria-hidden="true" />
                          {t({
                            id: 'board.canvas.lane.stop.waiting',
                            defaultMessage: 'Waits for your plan approval',
                          })}
                        </span>
                      ) : (
                        <>
                          <Check aria-hidden="true" />
                          {t({
                            id: 'board.canvas.lane.stop.approved',
                            defaultMessage: 'Plan approved',
                          })}
                          <span className="bd-lane-at">
                            {dayText(head.stop.at, now, { time: true })}
                          </span>
                        </>
                      )}
                    </span>
                  )}
                </span>
              </div>
            ) : (
              <span className="bd-lane-t" title={lane.title || undefined}>
                {lane.title}
              </span>
            )}
            {lane.fanout_reason && <Clip text={lane.fanout_reason} className="bd-lane-r" />}
            <span
              className="bd-lane-bar"
              role="img"
              aria-label={listText(
                t(
                  { id: 'board.canvas.band.merged', defaultMessage: '{merged} / {total} merged' },
                  { merged, total },
                ),
                ...LANE_COUNTS.map((c) => !!counts.get(c.key) && c.text(counts.get(c.key)!)),
              )}
            >
              {(['merged', 'running', 'waiting', 'stuck', 'todo', 'discarded'] as const).map(
                (key) =>
                  !!counts.get(key) && (
                    <i key={key} data-count={key} style={{ flexGrow: counts.get(key) }} />
                  ),
              )}
            </span>
            <span className="bd-lane-n" aria-hidden="true">
              {t(
                { id: 'board.plan.flow.laneCount', defaultMessage: '{done} / {total}' },
                { done: merged, total },
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Steps of 10% between MIN_USER_ZOOM and MAX_USER_ZOOM; a zoom between two steps goes to the next one. */
function ZoomControls() {
  const { zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  const tenths = Math.round(zoom * 100) / 10;
  const out = Math.max(MIN_USER_ZOOM, (Math.ceil(tenths) - 1) / 10);
  const into = Math.min(MAX_USER_ZOOM, (Math.floor(tenths) + 1) / 10);
  const outText = t({ id: 'board.canvas.zoom.out', defaultMessage: 'Zoom out' });
  const inText = t({ id: 'board.canvas.zoom.in', defaultMessage: 'Zoom in' });
  return (
    <>
      <Tip content={outText}>
        <button
          type="button"
          className="ib"
          aria-label={outText}
          disabled={zoom <= MIN_USER_ZOOM}
          onClick={() => void zoomTo(out)}
        >
          <Minus aria-hidden="true" />
        </button>
      </Tip>
      <output
        className="bd-zm-v"
        aria-label={t({ id: 'board.canvas.zoom.level', defaultMessage: 'Zoom level' })}
      >
        {t(
          { id: 'board.canvas.zoom.percent', defaultMessage: '{percent}%' },
          { percent: Math.round(zoom * 100) },
        )}
      </output>
      <Tip content={inText}>
        <button
          type="button"
          className="ib"
          aria-label={inText}
          disabled={zoom >= MAX_USER_ZOOM}
          onClick={() => void zoomTo(into)}
        >
          <Plus aria-hidden="true" />
        </button>
      </Tip>
    </>
  );
}

/** The cards' heights by task id after React Flow measured some; the same map while none changed. */
function measured(heights: ReadonlyMap<string, number>, changes: NodeChange<ChartNode>[]) {
  const next = new Map(heights);
  for (const c of changes)
    if (c.type === 'dimensions' && c.dimensions) next.set(c.id, c.dimensions.height);
  return [...next].every(([id, h]) => heights.get(id) === h) ? heights : next;
}

interface FlowCanvasProps {
  model: BoardModel;
  selected: string | null;
  onSelect: (taskId: string) => void;
  /** Heads the chart together with the plan versions; without it the chart has no header. */
  title?: string;
  /** How the tasks split into bands; by lane when absent. */
  group?: FlowGroup;
  /** Runs the chart's commands and keeps its plan draft; without it the chart is read-only. */
  tell?: TaskDrawerProps['tell'];
  /** With `tell`, shows the connection points and drafts the dependencies changed on the chart. */
  editing?: boolean;
  /** Statuses at a past moment by task id; while set, the cards show them and nothing that holds only now. */
  states?: ReadonlyMap<string, Task['status']>;
  /** Present while the board's needs-you strip sits beside the chart. */
  onAskNeed?: (key: string) => void;
  /** The now view's switch between the chart under its strips and the chart in their place. */
  expand?: GraphExpand;
}

// A card at a past moment keeps its plan facts and that moment's status.
function pastTasks(tasks: readonly Task[], states: ReadonlyMap<string, Task['status']>): Task[] {
  return tasks.map(
    ({
      activity,
      state,
      done_by,
      dispatch_wait,
      claim,
      blocker_codes,
      context,
      gate_steps,
      acceptance_checks,
      external_review,
      successors,
      pending_edit,
      parallel,
      subagents,
      step_runs,
      waiting_step,
      evidence,
      retrospective,
      ...t
    }) => ({
      ...t,
      status: states.get(t.id) ?? t.status,
      blockers: [],
      checks: 'none' as const,
      additions: null,
      deletions: null,
      started_at: null,
      ended_at: null,
    }),
  );
}

// Merged stacks, milestone progress, needs and proposals hold only now.
const pastModel = (model: BoardModel, states: ReadonlyMap<string, Task['status']>): BoardModel => ({
  ...model,
  tasks: pastTasks(model.tasks, states),
  milestones: [],
  needs: [],
  proposed_edges: [],
});

function FlowCanvas({
  model: liveModel,
  selected,
  onSelect,
  title,
  group = 'lane',
  tell: liveTell,
  editing = false,
  states,
  onAskNeed,
  expand,
}: FlowCanvasProps) {
  // A past moment takes no command and no draft.
  const tell = states ? undefined : liveTell;
  const model = useMemo(
    () => (states ? pastModel(liveModel, states) : liveModel),
    [liveModel, states],
  );
  const { setViewport, getViewport } = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  // The viewport React Flow draws in; the legend and zoom row under it is not part of it.
  const pane = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  /** The edge whose delete button shows. */
  const [picked, setPicked] = useState<string | null>(null);
  /** The stacks opened to list their tasks. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const jumped = useRef<string | null>(null);
  const editable = tell !== undefined && editing;
  const projectId = useMemo(
    () => (tell && chartProject(model, tell.sessions)) ?? '',
    [model, tell],
  );
  const drafts = useDraftEdits(projectId);
  const drafted = useMemo(() => withDrafts(model, drafts), [model, drafts]);
  const milestone = currentMilestone(model.milestones ?? []);
  const graph = useMemo(
    () => flowGraph(drafted.model, group, drafted.tasks, milestone),
    [drafted, group, milestone],
  );

  useLayoutEffect(() => {
    const el = box.current!;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Refreshes that only change statuses or usage keep the layout, so the viewport stays put.
  const key = layoutKey(graph.model, group);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const layout = useMemo(
    () => flowLayout(graph.model, width - 2 * EDGE, group, heights),
    [key, width, heights],
  );
  // A graph still too wide at the smallest zoom pans; the height follows the drawn graph.
  const zoom = flowZoom(width - 2 * EDGE, layout.width);
  const height = Math.round(layout.height * zoom + 2 * EDGE);
  const fit = () => void setViewport({ x: EDGE, y: EDGE, zoom });

  useEffect(() => {
    if (width) void setViewport({ x: EDGE, y: EDGE, zoom });
  }, [width, zoom, key, setViewport]);

  const tasks = useMemo(() => new Map(drafted.model.tasks.map((t) => [t.id, t])), [drafted]);
  const heads = useMemo(
    () => new Map(group === 'lane' ? model.lanes.map((l) => [l.id, l]) : []),
    [model.lanes, group],
  );
  const stacks = useMemo(
    () =>
      new Map(
        [...graph.overlays].flatMap(([id, o]) => (o.kind === 'stack' ? [[id, o.members]] : [])),
      ),
    [graph],
  );
  const band = useMemo(
    () => new Map(layout.lanes.flatMap((lane, i) => lane.tasks.map((id) => [id, i] as const))),
    [layout],
  );
  // What the draft changes on each task against its plan: its acceptance count and its upstream tasks.
  const marks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of drafts)
      for (const op of d.ops)
        if (op.type === 'set_task' && op.patch.acceptance)
          counts.set(`${d.target.leadId}:${op.task_id}`, op.patch.acceptance.length);
    const plan = new Map(model.tasks.map((t) => [t.id, t]));
    const marks = new Map<string, NonNullable<TaskNode['data']['drafted']>>();
    for (const task of drafted.model.tasks) {
      const was = plan.get(task.id)!;
      const before = was.acceptance_checks?.length ?? 0;
      const acceptance = (counts.get(task.id) ?? before) - before;
      const deps = task.depends_on ?? [];
      const old = was.depends_on ?? [];
      const upstream = deps.length !== old.length || deps.some((id) => !old.includes(id));
      if (acceptance || upstream)
        marks.set(task.id, {
          ...(acceptance !== 0 && { acceptance }),
          ...(upstream && { upstream: true as const }),
        });
    }
    return marks;
  }, [model, drafted, drafts]);
  const critical = useMemo(() => criticalPath(model), [model]);
  const ready = useMemo(() => new Set(states ? [] : readyTasks(model)), [model, states]);
  const now = Math.max(model.now, useNow(15_000));
  // A task's drafted dependency list stays one change; it leaves the draft once it matches the plan.
  const change = (taskId: string, op: DependencyOp) => {
    const target = tell && editTarget(tasks.get(taskId)!, tell.sessions);
    if (!target) return;
    const held = drafts.find(
      (d) =>
        d.target.taskId === taskId &&
        !d.start &&
        d.ops.length === 1 &&
        d.ops[0]!.type === 'set_dependencies',
    );
    const before = dependencies(model, taskId);
    const same =
      op.depends_on.length === before.length && op.depends_on.every((id) => before.includes(id));
    if (!held) {
      if (!same) addDraftEdit(target, [op]);
    } else if (same) removeDraftEdit(target.projectId, held.key);
    else changeDraftEdit(target.projectId, held.key, { ops: [op] });
  };
  const unlink = (from: string, to: string) => {
    setPicked(null);
    change(to, withoutDependency(drafted.model, from, to) as DependencyOp);
  };
  const link = ({ source, target }: { source: string; target: string }) => {
    if (connectRefusal(drafted.model, source, target) === null)
      change(target, withDependency(drafted.model, source, target) as DependencyOp);
  };
  // Only what the jump reaches counts; a need with no task on the chart, a lead's question, is answered elsewhere.
  const needs = ((!states && model.needs) || []).filter(
    (n) => n.task_id && layout.nodes.some((x) => x.id === n.task_id),
  );
  const waiting = [...new Set(needs.map((n) => n.task_id!))];
  // Centres the next waiting task at the current zoom and focuses its node; the main view's chart
  // is as tall as the view leaves, not as the drawn graph.
  const jump = () => {
    const id = nextWaiting(waiting, jumped.current)!;
    jumped.current = id;
    const at = layout.nodes.find((x) => x.id === id)!;
    const { zoom: z } = getViewport();
    void setViewport({
      x: width / 2 - (at.x + NODE_WIDTH / 2) * z,
      y: pane.current!.clientHeight / 2 - (at.y + (heights.get(id) ?? NODE_HEIGHT) / 2) * z,
      zoom: z,
    });
    [...box.current!.querySelectorAll<HTMLElement>('.react-flow__node')]
      .find((el) => el.getAttribute('data-id') === id)
      ?.focus({ preventScroll: true });
  };
  const toggle = (id: string) =>
    setOpened((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const versions = (model.leads ?? []).filter((l) => l.plan_version !== undefined);
  // The hovered or focused task and the tasks it shares an edge with; their edges draw thicker.
  const near = useMemo(() => {
    const lit = new Set<string>();
    if (hovered === null) return lit;
    lit.add(hovered);
    for (const e of layout.edges)
      if (e.from === hovered || e.to === hovered) lit.add(e.from).add(e.to);
    return lit;
  }, [layout, hovered]);
  // Built without the selection, so picking a task hands React Flow new objects for two nodes only.
  const unselected = useMemo(
    () =>
      layout.nodes.map((n): ChartNode => {
        const place = (width: number) => ({
          id: n.id,
          position: { x: n.x, y: n.y },
          width,
          initialHeight: NODE_HEIGHT,
          // Handed back so React Flow keeps the card measured instead of measuring it anew.
          ...(heights.has(n.id) && { measured: { width, height: heights.get(n.id) } }),
        });
        const overlay = graph.overlays.get(n.id);
        if (overlay?.kind === 'stack')
          return {
            ...place(STACK_WIDTH),
            type: 'stack',
            focusable: false,
            data: {
              tasks: overlay.members.map((id) => tasks.get(id)!),
              open: opened.has(n.id),
              onToggle: () => toggle(n.id),
              onOpen: onSelect,
            },
          };
        if (overlay?.kind === 'milestone') {
          const next =
            model.tasks.find((t) => t.milestone_id === overlay.milestone.id && ready.has(t.id)) ??
            null;
          const target = next && tell && editTarget(next, tell.sessions);
          const verification = overlay.milestone.verification;
          return {
            ...place(NODE_WIDTH),
            type: 'milestone',
            focusable: false,
            ariaLabel: listText(
              overlay.milestone.title,
              verification && verification.state !== 'skipped' && verifyText(verification, now),
            ),
            data: {
              milestone: overlay.milestone,
              now,
              next,
              ...(target && { onStart: () => startPlanTasks(target, [target.planId]) }),
            },
          };
        }
        if (overlay?.kind === 'draft')
          return {
            ...place(NODE_WIDTH),
            type: 'draft',
            focusable: false,
            ariaLabel: listText(overlay.task.title, draftText()),
            data: { task: overlay.task },
          };
        const task = tasks.get(n.id)!;
        const note = states ? null : activityNote(task, now, model);
        return {
          ...place(NODE_WIDTH),
          type: 'task',
          ...(near.has(n.id) && { className: 'hl' }),
          ariaLabel: listText(
            task.title,
            taskStateLabel(task),
            task.pending_edit &&
              t({ id: 'board.plan.flow.pendingEditLabel', defaultMessage: 'Edit awaits the lead' }),
          ),
          data: {
            task,
            selected: false,
            now,
            critical: critical.includes(n.id),
            ready: ready.has(n.id),
            line: note?.text ?? null,
            ...(note?.ago && { ago: note.ago }),
            editable,
            tall: heights.get(n.id) ?? NODE_HEIGHT,
            ...(marks.has(n.id) && { drafted: marks.get(n.id) }),
            ...(tell && { actions: { tell, needs: model.needs ?? [], onAskNeed } }),
          },
        };
      }),
    [
      layout,
      graph,
      tasks,
      now,
      critical,
      ready,
      model,
      editable,
      near,
      heights,
      tell,
      opened,
      states,
      marks,
      onAskNeed,
    ],
  );
  const nodes = useMemo(
    () =>
      unselected.map((n): ChartNode =>
        n.type === 'task' && n.id === selected ? { ...n, data: { ...n.data, selected: true } } : n,
      ),
    [unselected, selected],
  );
  const edges = useMemo(() => {
    const path = new Set(critical.slice(1).map((to, i) => `${critical[i]}->${to}`));
    const title = (id: string) => tasks.get(id)?.title ?? overlayTitle(graph.overlays.get(id)!);
    const drawn = new Set(layout.nodes.map((n) => n.id));
    // A proposed dependency is not the plan's: never picked, removed or shown at a past moment.
    const suggested = (states ? [] : (model.proposed_edges ?? []))
      .filter((e) => drawn.has(e.from) && drawn.has(e.to))
      .map((e): FlowEdge => {
        const label = t(
          {
            id: 'board.plan.flow.proposedEdge',
            defaultMessage: 'Proposed dependency: {from} to {to}',
          },
          { from: title(e.from), to: title(e.to) },
        );
        return {
          id: `proposed:${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          type: 'flow',
          focusable: false,
          ariaLabel: label,
          data: { state: 'pending', gap: layout.gap, label, picked: false },
          className: `bd-e proposed${band.get(e.from) !== band.get(e.to) ? ' cross' : ''}`,
        };
      });
    const planned = layout.edges.map((e): FlowEdge => {
      const id = `${e.from}->${e.to}`;
      const from = tasks.get(e.from);
      const live = from ? edgeState(from) : e.state === 'met' ? 'met' : 'pending';
      // At a past moment an edge colours only once its upstream is done.
      const state = states && live !== 'met' ? 'pending' : live;
      // Only an edge between two tasks of the plan is a dependency the user can remove.
      const own = editable && !!from && tasks.has(e.to);
      const draft = drafted.added.has(id) || graph.overlays.get(e.to)?.kind === 'draft';
      const lit = hovered !== null && (e.from === hovered || e.to === hovered);
      const label = t(
        { id: 'board.plan.flow.edge', defaultMessage: '{from} to {to}' },
        { from: title(e.from), to: title(e.to) },
      );
      return {
        id,
        source: e.from,
        target: e.to,
        type: 'flow',
        focusable: own,
        ariaLabel: label,
        ...(own && { ariaRole: 'button', domAttributes: { 'aria-pressed': id === picked } }),
        data: {
          state,
          gap: layout.gap,
          label,
          picked: id === picked,
          ...(own && { onDelete: () => unlink(e.from, e.to) }),
        },
        className: `bd-e ${state}${draft ? ' draft' : ''}${path.has(id) ? ' crit' : ''}${lit ? ' hl' : ''}${id === picked ? ' pick' : ''}${band.get(e.from) !== band.get(e.to) ? ' cross' : ''}`,
      };
    });
    return [...planned, ...suggested];
  }, [layout, graph, drafted, band, tasks, hovered, critical, picked, editable, model, states]);

  return (
    <>
      {title !== undefined && (
        <div className="bd-ph">
          <h2 id="bd-flow-h">{title}</h2>
          <div className="bd-tools">
            {versions.map((l) => (
              <span
                key={l.session_id}
                className="bd-ver"
                aria-label={listText(
                  versions.length > 1 && l.title,
                  t(
                    { id: 'board.plan.flow.version', defaultMessage: 'Plan version {version}' },
                    { version: l.plan_version },
                  ),
                )}
              >
                v{l.plan_version}
              </span>
            ))}
          </div>
        </div>
      )}
      <div
        ref={box}
        className={hovered ? 'bd-fc hov' : 'bd-fc'}
        onFocus={(e) => {
          const id = (e.target as HTMLElement)
            .closest('.react-flow__node')
            ?.getAttribute('data-id');
          setHovered(id ?? null);
        }}
        onBlur={() => setHovered(null)}
        onKeyDown={(e) => {
          const target = e.target as HTMLElement;
          const id = target.closest('.react-flow__node')?.getAttribute('data-id');
          if (id) {
            if (tasks.has(id) && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onSelect(id);
            }
            return;
          }
          const edgeId = editable && target.closest('.react-flow__edge')?.getAttribute('data-id');
          const edge = edgeId && layout.edges.find((x) => `${x.from}->${x.to}` === edgeId);
          if (!edge) return;
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            unlink(edge.from, edge.to);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setPicked((now) => (now === edgeId ? null : edgeId));
          } else if (e.key === 'Escape') setPicked(null);
        }}
      >
        <svg className="bd-defs" aria-hidden="true">
          <defs>
            {EDGE_STATES.map((state) => (
              <marker
                key={state}
                id={`bd-ar-${state}`}
                viewBox="0 0 6 6"
                refX="6"
                refY="3"
                markerWidth="6"
                markerHeight="6"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                {state === 'blocked' ? (
                  <path
                    d="M1,1L5,5M5,1L1,5"
                    style={{ fill: 'none', stroke: EDGE_COLOR[state], strokeWidth: 1.5 }}
                  />
                ) : (
                  <path d="M0,0L6,3L0,6z" style={{ fill: EDGE_COLOR[state] }} />
                )}
              </marker>
            ))}
          </defs>
        </svg>
        <div
          ref={pane}
          className="bd-fc-pane"
          style={{ '--bd-fc-h': `${height}px` } as CSSProperties}
        >
          {width > 0 && (
            <>
              <Lanes
                layout={layout}
                tasks={tasks}
                stacks={stacks}
                heads={heads}
                now={now}
                {...(tell && {
                  // The board's lane ids are `<lead session id>:<lane id>`.
                  onDepth: async (laneId: string, depth: Depth) => {
                    const at = laneId.indexOf(':');
                    const failure = await tell.run(
                      'board.lane.depth.set',
                      {
                        project_id: projectId,
                        lead_session_id: laneId.slice(0, at),
                        lane_id: laneId.slice(at + 1),
                        depth,
                      },
                      null,
                    );
                    if (failure) toast({ title: failure, kind: 'failure' });
                  },
                })}
              />
              <ReactFlow<ChartNode, FlowEdge>
                nodes={nodes}
                edges={edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                defaultViewport={{ x: EDGE, y: EDGE, zoom }}
                // React Flow measures the cards before the frame paints; their layout lands in that frame.
                onNodesChange={(changes) =>
                  changes.some((c) => c.type === 'dimensions') &&
                  flushSync(() => setHeights((now) => measured(now, changes)))
                }
                onNodeClick={(_, node) => node.type === 'task' && onSelect(node.id)}
                onNodeMouseEnter={(_, node) => setHovered(node.id)}
                onNodeMouseLeave={() => setHovered(null)}
                onEdgeClick={
                  editable
                    ? (_, edge) =>
                        edge.data?.onDelete &&
                        setPicked((now) => (now === edge.id ? null : edge.id))
                    : undefined
                }
                onPaneClick={() => setPicked(null)}
                nodesDraggable={false}
                nodesConnectable={editable}
                isValidConnection={
                  editable
                    ? (c) => connectRefusal(drafted.model, c.source, c.target) === null
                    : undefined
                }
                onConnect={editable ? link : undefined}
                connectionLineComponent={ConnectionLine}
                deleteKeyCode={null}
                elementsSelectable={false}
                edgesFocusable={false}
                ariaLabelConfig={ARIA_LABELS}
                // A plain wheel keeps scrolling the page; pinch or the modifier key with the wheel zooms.
                zoomOnScroll={false}
                preventScrolling={false}
                minZoom={MIN_USER_ZOOM}
                maxZoom={MAX_USER_ZOOM}
                proOptions={{ hideAttribution: true }}
              />
            </>
          )}
        </div>
        {(needs.length > 0 || expand) && (
          <div className="bd-fo bd-fo-tr">
            {needs.length > 0 && <NeedsCount onNext={jump} />}
            {expand && <ExpandGraph {...expand} />}
          </div>
        )}
        <div className="bd-fo-bar">
          <FlowLegend />
          <div
            className="bd-zm"
            role="group"
            aria-label={t({ id: 'board.canvas.zoom.label', defaultMessage: 'Zoom' })}
          >
            <ZoomControls />
            <span className="bd-zm-sep" aria-hidden="true" />
            <button type="button" className="btn ghost sm" onClick={fit}>
              {t({ id: 'board.plan.flow.fit', defaultMessage: 'Fit to view' })}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Met once the upstream task merged, flowing only while it runs, blocked once it failed; a session
 * row goes by its status.
 */
export function edgeState(from: Task): EdgeState {
  if (from.state ? from.state === 'merged' : from.status === 'done') return 'met';
  if (from.state === 'failed') return 'blocked';
  return (from.state ?? from.status) === 'running' ? 'active' : 'pending';
}

/** The flow chart, under its header when titled; the caller supplies the panel and the task drawer. */
export function FlowChart(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
