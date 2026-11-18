import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LoadError } from '../../components/LoadError';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Check, Ellipsis } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { useBoard } from '../../data/board';
import { useBoardHistory } from '../../data/board-history';
import { PAGES, pickBoardPage, useBoardPage, type BoardPage } from '../../data/board-page';
import { useBoardView } from '../../data/board-view';
import { ReadStatus } from '../../components/ReadStatus';
import { Skeleton as LoadingBlock } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import { TopBar } from '../../components/TopBar';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { needsKey } from '../../data/notice-tiers';
import { useDraftEdits } from '../../data/plan-draft';
import { useUnsentEdits } from '../../data/plan-edit';
import { effectiveSessionDefaults, useLastProjectDefaults } from '../../data/project-defaults';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import type { BaselineChoice, ProjectBaseline } from '../projects/baseline';
import { BaselinePopover } from '../projects/BaselineBlocks';
import { BoardDevices } from './BoardDevices';
import { CanvasPage } from './CanvasPage';
import { Milestones } from './Charts';
import { EditBar, EditButton, setBoardEditing, useBoardEditing } from './EditMode';
import { baselineSyncReason, type SessionDefaults } from './frame-model';
import { leadLine } from './LeadPanel';
import { LeadPlan } from './LeadPlan';
import { HistoryPage } from './HistoryPage';
import { HistoryView } from './HistoryView';
import { RisksPanel } from './Lists';
import { FlowGroupControl, hasPlanTasks } from './MainView';
import { NewTask, planLead } from './NewTask';
import { NowPage } from './NowPage';
import { currentMilestone } from './MilestoneCard';
import type { EvidenceTab } from './TaskFocus';
import {
  canvasOrder,
  DEFAULT_LAYOUT,
  movePanel,
  saveCanvasOrder,
  saveLayout,
  setHeight,
  setHidden,
  setSpan,
  useBoardLayout,
  useCanvasOrder,
  visualOf,
  type BoardLayout,
  type PanelHeight,
  type PanelPlace,
  type PanelSpan,
} from './panel-layout';
import { type RunBoardCommand, type SnapshotMilestone, type SnapshotSession } from './panels-model';
import {
  endedTurns,
  setupShown,
  useProjectSetup,
  waitAfter,
  type ProjectSetupRead,
  type TurnWait,
} from './project-setup';
import { ProjectSetup } from './ProjectSetup';
import { CyclePanel, StallPanel, TrendPanel } from './ProgressCharts';
import { ProgressTable } from './ProgressTable';
import { PublishBar } from './PublishBar';
import { TaskDrawer } from './TaskDrawer';
import './board.css';

export type BoardDays = 1 | 7 | 30 | 'all';
/** The canvas view's panel groups, each a tab of the stored layout. */
export type OverviewSection = 'progress' | 'milestones';
/** The progress panel whose task drawer is open. */
type TaskPanel = 'flow';

const CANVAS_TABS: readonly OverviewSection[] = ['progress', 'milestones'];
const NO_TASKS: Pick<BoardModel, 'tasks' | 'leads'> = { tasks: [] };

export const RANGES: { days: BoardDays; label: string }[] = [
  {
    days: 1,
    get label() {
      return t({ id: 'board.ranges.today', defaultMessage: 'Today' });
    },
  },
  {
    days: 7,
    get label() {
      return t({ id: 'board.ranges.days', defaultMessage: '{days} days' }, { days: 7 });
    },
  },
  {
    days: 30,
    get label() {
      return t({ id: 'board.ranges.days', defaultMessage: '{days} days' }, { days: 30 });
    },
  },
  {
    days: 'all',
    get label() {
      return t({ id: 'board.ranges.all', defaultMessage: 'All' });
    },
  },
];

/** The project board's range: the unfinished tasks of today's read, or the last 3 or 7 days. */
export type BoardRange = 'active' | 3 | 7;

const BOARD_RANGES: { range: BoardRange; label: string }[] = [
  {
    range: 'active',
    get label() {
      return t({ id: 'board.ranges.active', defaultMessage: 'In progress' });
    },
  },
  {
    range: 3,
    get label() {
      return t({ id: 'board.ranges.last', defaultMessage: 'Last {days} days' }, { days: 3 });
    },
  },
  {
    range: 7,
    get label() {
      return t({ id: 'board.ranges.last', defaultMessage: 'Last {days} days' }, { days: 7 });
    },
  },
];

/** Whether a task is over: merged, accepted or discarded; a failed one stays, as it waits for a retry. */
const over = (task: BoardModel['tasks'][number]) =>
  task.state ? task.state === 'merged' : task.status === 'done' || task.status === 'discarded';

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const day = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const LINK: Partial<Record<ProjectBaseline['state'], (baseline: ProjectBaseline) => string>> = {
  running: () => t({ id: 'board.baseline.running', defaultMessage: 'Baseline running' }),
  submitted: () =>
    t({ id: 'board.baseline.submitted', defaultMessage: 'Baseline awaiting confirmation' }),
  confirmed: ({ created_at }) =>
    t(
      { id: 'board.baseline.confirmed', defaultMessage: 'Baseline {day} {time}' },
      { day: day(created_at), time: clock(created_at) },
    ),
};

export interface BoardBaseline {
  link: { label: string; session_id: string } | null;
  start: string | null;
}

/** The headline bar's link to the newest baseline session and its start button label. */
export function boardBaseline(baseline: ProjectBaseline | null): BoardBaseline {
  const label = baseline && LINK[baseline.state];
  const link =
    label && baseline.session_id
      ? { label: label(baseline), session_id: baseline.session_id }
      : null;
  if (!baseline)
    return { link, start: t({ id: 'board.baseline.start', defaultMessage: 'Build baseline' }) };
  const open =
    baseline.state === 'running' || (baseline.state === 'submitted' && !!baseline.session_id);
  return {
    link,
    start: open ? null : t({ id: 'board.baseline.restart', defaultMessage: 'Rebuild baseline' }),
  };
}

export const isEmpty = ({
  tasks,
  counts,
  risks,
  milestones,
  burnup,
  findings,
}: BoardModel): boolean =>
  !tasks.length &&
  !risks.length &&
  !findings.length &&
  !milestones.length &&
  burnup.every((d) => !d.scope && !d.done) &&
  !counts.running &&
  !counts.waiting &&
  !counts.ready &&
  !counts.failed &&
  !counts.merged &&
  !counts.tokens;

export interface BoardViewProps {
  model: BoardModel | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  stale?: boolean;
  readAt?: number | null;
  range: BoardRange;
  onRange: (range: BoardRange) => void;
  page: BoardPage;
  onPage: (page: BoardPage) => void;
  /** Reads the review metrics and role usage tables; absent without a project. */
  projectId?: string;
  onOpenSession: (sessionId: string) => void;
  onOpenStory: (sessionId: string) => void;
  onOpenEvidence?: (sessionId: string, tab: EvidenceTab) => void;
  onOpenTrace: () => void;
  onStartTask?: (task: BoardModel['tasks'][number]) => void;
  /** The bar's update action; absent without a project. */
  sync?: {
    busy: boolean;
    error: string | null;
    onSync: () => void;
    /** Why the update is off; absent while it can run. */
    off?: string | null;
  };
  /** The project's setup, shown in place of an empty board; absent without a project. */
  setup?: ProjectSetupRead;
  /** The bar's baseline link and start action; absent without a project. */
  baseline?: BoardBaseline & {
    busy: boolean;
    error: string | null;
    onStart: (choice?: BaselineChoice) => void;
    /** The baseline read failed before any read of the project went through. */
    readFailure?: { error: string; onRetry: () => void };
  };
  /** Snapshot rows and the command runner behind the commitment and review actions; absent without a project. */
  actions?: {
    milestones: readonly SnapshotMilestone[];
    sessions: readonly SnapshotSession[];
    run: RunBoardCommand;
    /** The project's session defaults, under which the requirement box opens a lead. */
    defaults?: SessionDefaults;
  };
  /** The sessions behind `actions` are on their first read, neither in nor failed. */
  sessionsPending?: boolean;
}

export function Failure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <LoadError message={error} onRetry={onRetry} />;
}

interface PanelBoundaryProps {
  /** Absent where the place keeps its own heading: the failure line then stands alone. */
  title?: string;
  className?: string;
  /** A new value clears the failure. */
  model?: unknown;
  onRetry?: () => void;
  /** Shown after the failure line, for what other panels still need from the failed one. */
  withFailure?: ReactNode;
  children: ReactNode;
}

interface PanelBoundaryState {
  error: Error | null;
  model: unknown;
}

/** Puts one failure line in place of a panel that throws while rendering. */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  state: PanelBoundaryState = { error: null, model: this.props.model };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: PanelBoundaryProps,
    state: PanelBoundaryState,
  ): PanelBoundaryState | null {
    return props.model === state.model ? null : { error: null, model: props.model };
  }

  retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const line = (
      <Failure
        error={
          error.message || t({ id: 'board.panel.renderFailed', defaultMessage: 'Failed to render' })
        }
        onRetry={this.retry}
      />
    );
    const failure = this.props.title ? (
      <section className={`bd-pn${this.props.className ? ` ${this.props.className}` : ''}`}>
        <div className="bd-ph">
          <h2>{this.props.title}</h2>
        </div>
        {line}
      </section>
    ) : (
      line
    );
    return this.props.withFailure ? (
      <>
        {failure}
        {this.props.withFailure}
      </>
    ) : (
      failure
    );
  }
}

export function Skeleton() {
  return (
    <div className="bd-sk" aria-busy="true">
      <LoadingBlock style={{ height: 10, width: '60%' }} />
      <LoadingBlock style={{ height: 10, width: '40%' }} />
    </div>
  );
}

export function HistoryTab({
  projectId,
  empty,
  ...rest
}: {
  projectId: string;
  /** Shown for a board with nothing in its range, unless the history keeps tasks or milestones. */
  empty: ReactNode;
} & Omit<Parameters<typeof HistoryView>[0], 'history'>) {
  const read = useBoardHistory(projectId);
  if (read.data)
    return empty && !read.data.tasks.length && !read.data.milestones.length ? (
      empty
    ) : (
      <>
        {read.error && <Failure error={read.error} onRetry={read.reload} />}
        <HistoryView history={read.data} {...rest} />
      </>
    );
  if (empty && !read.error) return empty;
  return (
    <section className="bd-pn bd-s12">
      {read.error ? <Failure error={read.error} onRetry={read.reload} /> : <Skeleton />}
    </section>
  );
}

export type ChangeLayout = (change: (layout: BoardLayout) => BoardLayout) => void;
export type BoardPanels = Partial<
  Record<string, { title: string; node: ReactNode; sub?: true; withFailure?: ReactNode }>
>;

// Functions, so each label is read in the language loaded by then.
const spanItems = (): [PanelSpan, string][] => [
  [6, t({ id: 'board.layout.halfWidth', defaultMessage: 'Half width' })],
  [12, t({ id: 'board.layout.fullWidth', defaultMessage: 'Full width' })],
];
const heightItems = (): [PanelHeight, string][] => [
  ['auto', t({ id: 'board.layout.auto', defaultMessage: 'Auto' })],
  ['S', t({ id: 'board.layout.small', defaultMessage: 'Small' })],
  ['M', t({ id: 'board.layout.medium', defaultMessage: 'Medium' })],
  ['L', t({ id: 'board.layout.large', defaultMessage: 'Large' })],
];

function LayoutRadio({
  value,
  label,
  onPick,
}: {
  value: string;
  label: string;
  onPick: () => void;
}) {
  return (
    <Menu.RadioItem value={value} closeOnClick onClick={onPick}>
      <span className="pjm-ck">
        <Menu.RadioItemIndicator>
          <Check className="ic-sm" aria-hidden="true" />
        </Menu.RadioItemIndicator>
      </span>
      {label}
    </Menu.RadioItem>
  );
}

/** The panel header's menu: width, height, order and hiding. */
function PanelMenu({
  name,
  place,
  first,
  last,
  onLayout,
}: {
  name: string;
  place: PanelPlace;
  first: boolean;
  last: boolean;
  onLayout: ChangeLayout;
}) {
  const { key } = place;
  return (
    <Menu.Root>
      <Menu.Trigger
        className="ib bd-pmenu"
        aria-label={t(
          { id: 'board.layout.menu', defaultMessage: '{panel} panel options' },
          { panel: name },
        )}
      >
        <Ellipsis aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="wmenu pjm pop bd-lmenu">
            <Menu.RadioGroup
              value={String(place.span)}
              aria-label={t({ id: 'board.layout.width', defaultMessage: 'Width' })}
            >
              {spanItems().map(([span, label]) => (
                <LayoutRadio
                  key={span}
                  value={String(span)}
                  label={label}
                  onPick={() => onLayout((l) => setSpan(l, key, span))}
                />
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="pjm-sep" />
            <Menu.RadioGroup
              value={place.height}
              aria-label={t({ id: 'board.layout.height', defaultMessage: 'Height' })}
            >
              {heightItems().map(([height, label]) => (
                <LayoutRadio
                  key={height}
                  value={height}
                  label={label}
                  onPick={() => onLayout((l) => setHeight(l, key, height))}
                />
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="pjm-sep" />
            <Menu.Item disabled={first} onClick={() => onLayout((l) => movePanel(l, key, -1))}>
              <span className="bd-lmi" />
              {t({ id: 'board.layout.moveUp', defaultMessage: 'Move up' })}
            </Menu.Item>
            <Menu.Item disabled={last} onClick={() => onLayout((l) => movePanel(l, key, 1))}>
              <span className="bd-lmi" />
              {t({ id: 'board.layout.moveDown', defaultMessage: 'Move down' })}
            </Menu.Item>
            <Menu.Item onClick={() => onLayout((l) => setHidden(l, key, true))}>
              <span className="bd-lmi" />
              {t({ id: 'board.layout.hide', defaultMessage: 'Hide' })}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Whether the page's tabs differ from their default layout. */
export const layoutChanged = (layout: BoardLayout, tabs: readonly (keyof BoardLayout)[]) =>
  tabs.some((tab) => JSON.stringify(layout[tab]) !== JSON.stringify(DEFAULT_LAYOUT[tab]));

/** The tab bar's list of the tab's hidden panels, each shown again on click, and the reset of the page's tabs. */
export function HiddenMenu({
  hidden,
  tabs,
  onLayout,
  onReset,
}: {
  hidden: { key: string; title: string }[];
  tabs: readonly (keyof BoardLayout)[];
  onLayout: ChangeLayout;
  /** Puts back what the page keeps beside the layout, such as the canvas order. */
  onReset?: () => void;
}) {
  const reset = () => {
    onLayout((l) => ({
      ...l,
      ...Object.fromEntries(tabs.map((tab) => [tab, DEFAULT_LAYOUT[tab]])),
    }));
    onReset?.();
  };
  if (!hidden.length)
    return (
      <button type="button" className="bd-hid" onClick={reset}>
        {t({ id: 'board.layout.reset', defaultMessage: 'Restore default layout' })}
      </button>
    );
  return (
    <Menu.Root>
      <Menu.Trigger className="bd-hid">
        {t(
          { id: 'board.layout.hidden', defaultMessage: '{count} hidden' },
          { count: hidden.length },
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="wmenu pop">
            {hidden.map((p) => (
              <Menu.Item key={p.key} onClick={() => onLayout((l) => setHidden(l, p.key, false))}>
                {t({ id: 'board.layout.show', defaultMessage: 'Show {panel}' }, { panel: p.title })}
              </Menu.Item>
            ))}
            <Menu.Separator className="pjm-sep" />
            <Menu.Item onClick={reset}>
              {t({ id: 'board.layout.reset', defaultMessage: 'Restore default layout' })}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The tab's shown panels in layout order, each in its cell with its menu and failure boundary. */
export function laidPanels({
  places,
  panels,
  model,
  projectId,
  onRetry,
  onLayout,
}: {
  places: PanelPlace[];
  panels: BoardPanels;
  model: BoardModel;
  projectId?: string;
  onRetry: () => void;
  onLayout: ChangeLayout;
}) {
  return places.map((place, i, list) => {
    const panel = panels[place.key]!;
    return (
      <div
        key={place.key}
        className={`bd-s${place.span}${panel.sub ? ' bd-sub' : ''}`}
        data-h={place.height === 'auto' ? undefined : place.height}
      >
        {projectId && (
          <PanelMenu
            name={panel.title}
            place={place}
            first={i === 0}
            last={i === list.length - 1}
            onLayout={onLayout}
          />
        )}
        <PanelBoundary
          title={panel.title}
          model={model}
          onRetry={onRetry}
          withFailure={panel.withFailure}
        >
          {panel.node}
        </PanelBoundary>
      </div>
    );
  });
}

export function BoardView(props: BoardViewProps) {
  const { loading, error, onRetry, range, onRange, onOpenSession, setup } = props;
  const { onOpenStory, onOpenTrace, onStartTask, sync, baseline } = props;
  const { page, onPage, projectId, actions } = props;
  const model = props.model;
  // The task collections shown; actions, evidence, drawers and new tasks keep every task read.
  const shown = useMemo(
    () =>
      model && range === 'active'
        ? { ...model, tasks: model.tasks.filter((t) => !over(t)) }
        : model,
    [model, range],
  );
  const headline = model?.headline ?? null;
  const [selected, setSelected] = useState<{ taskId: string; panel: TaskPanel } | null>(null);
  const [selectedProject, setSelectedProject] = useState(projectId);
  if (selectedProject !== projectId) {
    setSelectedProject(projectId);
    setSelected(null);
  }
  // The more menu's baseline start opens the model popover at the menu button.
  const [choosing, setChoosing] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const selectFlow = useCallback(
    (taskId: string | null) => setSelected(taskId === null ? null : { taskId, panel: 'flow' }),
    [],
  );
  const selectedIn = (panel: TaskPanel) => (selected?.panel === panel ? selected.taskId : null);
  const scoped = actions && projectId && !props.stale ? { ...actions, projectId } : undefined;
  // A project's first read draws what is under the view tabs in one commit, once the board and
  // its sessions are in or failed; later reads update in place.
  const settled = !props.sessionsPending && (!!model || !!error || !loading);
  const [drawnProject, setDrawnProject] = useState<{ projectId?: string } | null>(null);
  const drawnBefore = drawnProject !== null && drawnProject.projectId === projectId;
  if (settled && !drawnBefore) setDrawnProject({ projectId });
  const drawn = settled || drawnBefore;
  // The approvals the now view's needs-you strip lists, folded away or not.
  const listed =
    page === 'now' && scoped && shown
      ? (shown.needs ?? []).flatMap((n) =>
          n.source.table === 'approvals' ? (needsKey(n) ?? []) : [],
        )
      : [];
  // The notice cards hold an approval until the board is drawn; the board lists those of its strip.
  useEffect(() => {
    useShell.setState({ boardWaits: drawn ? new Set(listed) : null });
  }, [drawn, listed.join('\n')]);
  const pending =
    !model && (error ? <Failure error={error} onRetry={onRetry} /> : loading && <Skeleton />);
  const current = model && currentMilestone(model.milestones);
  const layout = useBoardLayout(projectId);
  const onLayout: ChangeLayout = (change) => {
    if (projectId) saveLayout(projectId, change(layout));
  };
  const editing = useBoardEditing(projectId ?? '') && page === 'now' && !!model && !!projectId;
  const unsent =
    useDraftEdits(projectId ?? '').length +
    useUnsentEdits(model ?? NO_TASKS, projectId ?? '').length;
  // The task column's title field takes the focus once the column is drawn.
  const taskTitle = useRef<HTMLInputElement>(null);
  const [focusTask, setFocusTask] = useState(0);
  useEffect(() => {
    if (focusTask) taskTitle.current?.focus();
  }, [focusTask]);
  const newTask = () => {
    if (!projectId) return;
    if (page !== 'now') onPage('now');
    setBoardEditing(projectId, true);
    setFocusTask((n) => n + 1);
  };
  // The task the now or canvas view picked, docked as the body's second column.
  const askNeed = (key: string) => useShell.setState({ askedNeed: key });
  const drawer = model && (
    <TaskDrawer
      model={model}
      taskId={selectedIn('flow')}
      onSelect={selectFlow}
      onOpenSession={onOpenSession}
      onOpenStory={onOpenStory}
      onStartTask={onStartTask}
      tell={scoped && { sessions: scoped.sessions, run: scoped.run }}
      onAskNeed={page === 'now' && actions ? askNeed : undefined}
    />
  );
  const panels: BoardPanels =
    model && shown
      ? {
          table: {
            title: t({ id: 'board.progress.title', defaultMessage: 'Progress table' }),
            node: (
              <ProgressTable model={shown} onOpenTask={selectFlow} projectId={scoped?.projectId} />
            ),
          },
          trend: {
            title: t({ id: 'board.trend.title', defaultMessage: 'Completion trend' }),
            node: <TrendPanel model={shown} />,
          },
          cycle: {
            title: t({ id: 'board.cycle.title', defaultMessage: 'Cycle time distribution' }),
            node: <CyclePanel model={shown} />,
          },
          stall: {
            title: t({ id: 'board.stalls.title', defaultMessage: 'Blocked and stalled' }),
            node: <StallPanel model={shown} onOpenTask={selectFlow} />,
          },
          milestones: {
            title: t({ id: 'board.milestones.title', defaultMessage: 'Milestones' }),
            node: <Milestones model={model} actions={scoped} />,
          },
          risks: {
            title: t({ id: 'board.risks.title', defaultMessage: 'Risks and assumptions' }),
            node: <RisksPanel model={shown} />,
          },
        }
      : {};
  // The main view is the now view's canvas; the canvas view lays out the rest.
  const placed = (tab: OverviewSection) => layout[tab].filter((p) => panels[p.key]);
  // The canvas and whole history views put their controls in these elements of the bar.
  const [canvasBar, setCanvasBar] = useState<HTMLElement | null>(null);
  const [historyBar, setHistoryBar] = useState<HTMLElement | null>(null);
  const canvasPanels = CANVAS_TABS.flatMap(placed).map((place) => ({
    place,
    title: panels[place.key]!.title,
    node: (
      <PanelBoundary
        title={panels[place.key]!.title}
        model={model}
        onRetry={onRetry}
        withFailure={panels[place.key]!.withFailure}
      >
        {panels[place.key]!.node}
      </PanelBoundary>
    ),
  }));
  const hidden = CANVAS_TABS.flatMap((tab) => placed(tab).filter((p) => p.hidden)).map((p) => ({
    key: p.key,
    title: panels[p.key]!.title,
  }));
  // The canvas keeps its card order apart from the layout; a visual's key stands for its place.
  const canvasStored = useCanvasOrder(projectId);
  const canvasKeys = canvasPanels.map((p) => p.place.key);
  const placedVisuals = canvasStored.flatMap((key) => visualOf(key) ?? []);
  const reordered =
    canvasOrder(canvasStored, canvasKeys, placedVisuals).join() !==
    canvasOrder([], canvasKeys, placedVisuals).join();
  const changed = layoutChanged(layout, CANVAS_TABS) || reordered;
  const empty = !!shown && isEmpty(shown);
  const planner = model && planLead(model);
  const version = model?.leads?.find((l) => l.session_id === planner)?.plan_version;
  const busy = !!sync?.busy || !!baseline?.busy;
  const loadingPanel = (
    <section className="bd-pn bd-s12" aria-labelledby="bd-load-h">
      <div className="bd-ph">
        <h2 id="bd-load-h">{PAGES.find((p) => p.key === page)!.label}</h2>
      </div>
      {pending}
    </section>
  );
  const setupPanel = setup && setupShown(setup, shown, empty) && (
    <ProjectSetup setup={setup} onOpenSession={onOpenSession} />
  );
  // The setup says a failed start in its own panel.
  const startError = !setupPanel && baseline?.error;
  // In place of the body the setup keeps only the view switch and the More menu in the bar.
  const setupOnly = !!setupPanel && page !== 'canvas';
  return (
    <>
      <TopBar title={SCREEN_NAMES.board}>
        {projectId && (
          <RadioGroup<BoardPage>
            className="tb-seg bd-views"
            aria-label={t({ id: 'board.view.label', defaultMessage: 'Board view' })}
            value={page}
            onValueChange={onPage}
          >
            {PAGES.map((p) => (
              <Radio.Root key={p.key} value={p.key} aria-label={p.label}>
                <p.icon className="ic-sm" aria-hidden="true" />
                <span className="tb-lbl">{p.label}</span>
              </Radio.Root>
            ))}
          </RadioGroup>
        )}
        {drawn && (
          <>
            {version !== undefined && (
              <span className="bd-bar-v">
                {t({ id: 'board.bar.planVersion', defaultMessage: 'Plan v{version}' }, { version })}
              </span>
            )}
            {headline && (
              <LeadPlan
                headline={headline}
                sessions={actions?.sessions}
                repeated={
                  page === 'now' && !!model?.leads?.some((l) => leadLine(l) === headline.text)
                }
              />
            )}
            <div className="tb-end">
              {(page === 'now' || page === 'canvas') && !setupOnly && (
                <RadioGroup<BoardRange>
                  className="tb-seg"
                  aria-label={t({ id: 'board.headline.range', defaultMessage: 'Time range' })}
                  value={range}
                  onValueChange={onRange}
                >
                  {BOARD_RANGES.map((r) => (
                    <Radio.Root key={r.range} value={r.range}>
                      {r.label}
                    </Radio.Root>
                  ))}
                </RadioGroup>
              )}
              {page === 'now' &&
                !setupOnly &&
                projectId &&
                shown &&
                !empty &&
                hasPlanTasks(shown) && <FlowGroupControl projectId={projectId} />}
              {page === 'history' && projectId && model && (
                <span className="bd-slot" ref={setHistoryBar} />
              )}
              {page === 'canvas' && projectId && model && (hidden.length > 0 || changed) && (
                <HiddenMenu
                  hidden={hidden}
                  tabs={CANVAS_TABS}
                  onLayout={onLayout}
                  onReset={() => saveCanvasOrder(projectId, [])}
                />
              )}
              {page === 'canvas' && projectId && model && (
                <span className="cv-bar" ref={setCanvasBar} />
              )}
              {page === 'now' && !setupOnly && projectId && model && actions && !editing && (
                <EditButton projectId={projectId} disabled={!scoped} count={unsent} />
              )}
              {!setupOnly && projectId && actions && (
                <NewTask model={model} disabled={!scoped} onNew={newTask} />
              )}
              <BoardDevices />
              <Menu.Root>
                <Menu.Trigger
                  ref={moreButton}
                  className="ib bd-more"
                  aria-label={t({ id: 'board.bar.more', defaultMessage: 'More' })}
                  aria-busy={busy || undefined}
                >
                  <Ellipsis aria-hidden="true" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
                    <Menu.Popup className="wmenu pop">
                      {sync &&
                        (sync.off ? (
                          <>
                            <Tip content={sync.off}>
                              <Menu.Item disabled aria-describedby="board-sync-off">
                                {t({ id: 'board.headline.sync', defaultMessage: 'Update board' })}
                              </Menu.Item>
                            </Tip>
                            <span id="board-sync-off" hidden>
                              {sync.off}
                            </span>
                          </>
                        ) : (
                          <Menu.Item
                            disabled={sync.busy || props.stale}
                            aria-busy={sync.busy || undefined}
                            onClick={sync.onSync}
                          >
                            {t({ id: 'board.headline.sync', defaultMessage: 'Update board' })}
                          </Menu.Item>
                        ))}
                      {baseline?.link && (
                        <Menu.Item onClick={() => onOpenSession(baseline.link!.session_id)}>
                          {baseline.link.label}
                        </Menu.Item>
                      )}
                      {baseline?.start && (
                        <Menu.Item
                          disabled={baseline.busy || props.stale}
                          aria-busy={baseline.busy || undefined}
                          onClick={() => setChoosing(true)}
                        >
                          {baseline.start}
                        </Menu.Item>
                      )}
                      <Menu.Item onClick={onOpenTrace}>
                        {t({ id: 'board.headline.trace', defaultMessage: 'Trace' })}
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
              {choosing && projectId && baseline?.start && (
                <BaselinePopover
                  project_id={projectId}
                  anchor={moreButton}
                  label={baseline.start}
                  busy={baseline.busy}
                  onClose={() => setChoosing(false)}
                  onStart={baseline.onStart}
                />
              )}
            </div>
          </>
        )}
      </TopBar>
      <main className="bd bd-paged">
        {model && (
          <ReadStatus
            label={t({ id: 'board.readStatus', defaultMessage: 'Board' })}
            stale={props.stale}
            loading={loading}
            error={error}
            readAt={props.readAt}
            reload={onRetry}
          />
        )}
        {drawn && editing && model && projectId && <EditBar model={model} projectId={projectId} />}
        {drawn ? (
          <div className="bd-split">
            <div className="bd-split-main">
              {scoped && !setupOnly && (
                <div className="bd-pub">
                  <PublishBar
                    projectId={scoped.projectId}
                    leads={model?.leads}
                    sessions={scoped.sessions}
                    tasks={model?.tasks}
                    defaults={scoped.defaults}
                    run={runCommand}
                    // Without the board read the newest lead is unknown.
                    disabled={!model}
                  />
                </div>
              )}
              {(sync?.error || startError || baseline?.readFailure) && (
                <div className="bd-errs">
                  {sync?.error && <Failure error={sync.error} onRetry={sync.onSync} />}
                  {startError && <Failure error={startError} onRetry={() => baseline?.onStart()} />}
                  {baseline?.readFailure && <Failure {...baseline.readFailure} />}
                </div>
              )}
              {/* The pages hold no hooks; called inline, their elements stay in this view's tree. */}
              {page === 'now'
                ? NowPage({
                    model,
                    shown,
                    current,
                    projectId,
                    actions,
                    scoped,
                    stale: props.stale,
                    onRetry,
                    onOpenSession,
                    onOpenEvidence: props.onOpenEvidence,
                    onStartTask,
                    selectedIn,
                    selectFlow,
                    onAskNeed: actions ? askNeed : undefined,
                    editing,
                    taskTitle,
                    setFocusTask,
                    setupPanel,
                    empty,
                    loadingPanel,
                  })
                : shown && (page === 'canvas' || !projectId)
                  ? CanvasPage({
                      model,
                      shown,
                      projectId,
                      canvasBar,
                      canvasPanels,
                      empty,
                      onLayout,
                      onRetry,
                      selectFlow,
                    })
                  : HistoryPage({
                      model,
                      projectId,
                      setupPanel,
                      loadingPanel,
                      onOpenSession,
                      onPage,
                      selectFlow,
                      historyBar,
                    })}
            </div>
            {page !== 'history' && drawer}
          </div>
        ) : (
          <div className="bd-cv" aria-busy="true">
            <LoadingBlock style={{ flex: 1 }} />
          </div>
        )}
      </main>
    </>
  );
}

export const runBoardCommand: RunBoardCommand = async (type, input, expectedRevision) => {
  const result = await runCommand(type, input, expectedRevision);
  return result.ok ? null : failureText(result.error);
};

/** The bar's baseline link, start button and start action, over the project's shared setup. */
export function baselineBar(setup: ProjectSetupRead): NonNullable<BoardViewProps['baseline']> {
  return {
    ...(setup.state !== null ? boardBaseline(setup.baseline) : { link: null, start: null }),
    busy: setup.busy,
    error: setup.error,
    onStart: setup.start,
    ...(setup.readFailure && { readFailure: setup.readFailure }),
  };
}

export function BoardScreen({
  projectId,
  onOpenSession,
}: {
  projectId: string | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [range, setRange] = useState<BoardRange>('active');
  // The in-progress range reads today's board and leaves the ended tasks out.
  const view = useBoardView(projectId, range === 'active' ? 1 : range);
  const page = useBoardPage(projectId);
  const onPage = (next: BoardPage) => {
    if (projectId) pickBoardPage(projectId, next);
  };
  const openSession = useShell((s) => s.openSession);
  const openTaskSession = useShell((s) => s.openTaskSession);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncWait, setSyncWait] = useState<TurnWait | null>(null);
  const [actionsProject, setActionsProject] = useState(projectId);
  if (actionsProject !== projectId) {
    setActionsProject(projectId);
    setSyncing(false);
    setSyncError(null);
    setSyncWait(null);
  }
  const shownProject = useRef(projectId);
  shownProject.current = projectId;
  const onSync = async (project_id: string) => {
    setSyncing(true);
    setSyncError(null);
    setSyncWait(null);
    const ended = endedTurns(useBoard.getState().board?.session_turns);
    const result = await runCommand('board.sync', { project_id }, null);
    // The board shows another project by now.
    if (shownProject.current !== project_id) return;
    setSyncing(false);
    if (!result.ok) return setSyncError(failureText(result.error));
    const sessions = (result.value as { session_ids: string[] }).session_ids;
    setSyncWait({ sessions, ended, origins: ['sync', 'baseline'] });
  };
  const snapshot = useBoard((s) => s.board);
  // Until the reset above lands, syncWait is still the last project's.
  const syncLeft = actionsProject !== projectId ? null : waitAfter(syncWait, snapshot);
  if (syncLeft !== syncWait) setSyncWait(syncLeft);
  const offline = useBoard((s) => s.status.state === 'offline');
  const globalDefaults = useLastProjectDefaults();
  const setup = useProjectSetup(projectId);
  return (
    <div className="tb-pg">
      <BoardView
        model={view.data}
        loading={view.loading || view.refreshing === true}
        error={view.error}
        onRetry={view.reload}
        stale={view.stale}
        readAt={view.readAt}
        range={range}
        onRange={setRange}
        page={page}
        onPage={onPage}
        onOpenSession={onOpenSession}
        onOpenStory={(sessionId) => openSession(sessionId, 'story')}
        onOpenEvidence={(sessionId, tab) => openSession(sessionId, tab)}
        onOpenTrace={() => useShell.getState().setScreen('trace')}
        onStartTask={({ id, title, goal }) => openTaskSession({ id, title, goal })}
        {...(projectId && {
          projectId,
          sync: {
            busy: syncing || syncLeft !== null,
            error: syncError,
            onSync: () => void onSync(projectId),
            off: baselineSyncReason(setup?.baseline),
          },
          setup,
          baseline: setup && baselineBar(setup),
          actions: snapshot
            ? {
                milestones: snapshot.milestones ?? [],
                sessions: snapshot.sessions,
                run: runBoardCommand,
                defaults: effectiveSessionDefaults(
                  snapshot.projects?.find((p) => p.id === projectId),
                  globalDefaults,
                ),
              }
            : undefined,
          sessionsPending: !snapshot && !offline,
        })}
      />
    </div>
  );
}
