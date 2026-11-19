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
import { Check, Ellipsis, RefreshCw } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { useBoard } from '../../data/board';
import { useBoardHistory } from '../../data/board-history';
import {
  PAGES,
  pickBoardPage,
  pickTaskScope,
  pickTaskView,
  useBoardPage,
  useTaskScope,
  useTaskView,
  type BoardPage,
  type TaskScope,
  type TaskView,
} from '../../data/board-page';
import { useBoardView } from '../../data/board-view';
import { ReadStatus } from '../../components/ReadStatus';
import { RUNNING, RunningFor } from '../../components/RunningFor';
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
import { dayText } from '../../lib/time-text';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import type { BaselineChoice, ProjectBaseline } from '../projects/baseline';
import { BaselinePopover } from '../projects/BaselineBlocks';
import { EditBar, EditButton, setBoardEditing, useBoardEditing } from './EditMode';
import { baselineSyncReason, type SessionDefaults } from './frame-model';
import { leadLine } from './LeadPanel';
import { LeadPlan } from './LeadPlan';
import { HistoryView } from './HistoryView';
import { FlowGroupControl, hasPlanTasks } from './MainView';
import { NewTask, planLead } from './NewTask';
import { currentMilestone } from './MilestoneCard';
import { OverviewPage } from './OverviewPage';
import { PlanPause } from './PlanPause';
import type { EvidenceTab } from './TaskFocus';
import {
  DEFAULT_LAYOUT,
  movePanel,
  setHeight,
  setHidden,
  setSpan,
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
import { TaskDrawer, type TaskDrawerProps } from './TaskDrawer';
import { TasksPage } from './TasksPage';
import './board.css';

export type BoardDays = 1 | 7 | 30 | 'all';
/** The canvas view's panel groups, each a tab of the stored layout. */
export type OverviewSection = 'progress' | 'milestones';
/** The progress panel whose task drawer is open. */
type TaskPanel = 'flow';
/** The task whose drawer is open in the panel of the project's board; null when none is. */
export const selectedIn = (
  s: Pick<ReturnType<typeof useShell.getState>, 'boardTask'>,
  projectId: string | undefined,
  panel: TaskPanel,
) =>
  s.boardTask?.projectId === (projectId ?? null) && s.boardTask.panel === panel
    ? s.boardTask.taskId
    : null;
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

// Labels are getters, so each is read in the language loaded by then.
const TASK_VIEWS: { view: TaskView; label: string }[] = [
  {
    view: 'flow',
    get label() {
      return t({ id: 'board.tasks.view.flow', defaultMessage: 'Flow' });
    },
  },
  {
    view: 'list',
    get label() {
      return t({ id: 'board.tasks.view.list', defaultMessage: 'List' });
    },
  },
  {
    view: 'timeline',
    get label() {
      return t({ id: 'board.tasks.view.timeline', defaultMessage: 'Timeline' });
    },
  },
];

const TASK_SCOPES: { scope: TaskScope; label: string }[] = [
  {
    scope: 'milestone',
    get label() {
      return t({ id: 'board.tasks.scope.milestone', defaultMessage: 'Current milestone' });
    },
  },
  {
    scope: 'all',
    get label() {
      return t({ id: 'board.tasks.scope.all', defaultMessage: 'All' });
    },
  },
];

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
    /** When this window sent the sync that runs; null while none does. */
    since: number | null;
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

/** The drawer of the task picked on the project's board. */
function BoardDrawer({
  projectId,
  ...props
}: Omit<TaskDrawerProps, 'taskId'> & { projectId?: string }) {
  const taskId = useShell((s) => selectedIn(s, projectId, 'flow'));
  return <TaskDrawer {...props} taskId={taskId} />;
}

export function BoardView(props: BoardViewProps) {
  const { loading, error, onRetry, onOpenSession, setup } = props;
  const { onOpenStory, onOpenTrace, onStartTask, sync, baseline } = props;
  const { page, onPage, projectId, actions } = props;
  const model = props.model;
  const view = useTaskView(projectId ?? null);
  const scope = useTaskScope(projectId ?? null);
  const headline = model?.headline ?? null;
  // The flow chart expanded over the requirement bar; held for this project while the page lives.
  const [graphFull, setGraphFull] = useState(false);
  // The milestone the goals opened the tasks view on, and whether they asked for the needs-you strip.
  const [picked, setPicked] = useState<string | null>(null);
  const [needsAsked, setNeedsAsked] = useState(false);
  const [selectedProject, setSelectedProject] = useState(projectId);
  if (selectedProject !== projectId) {
    setSelectedProject(projectId);
    setGraphFull(false);
    setPicked(null);
    setNeedsAsked(false);
  }
  const current =
    model && (model.milestones.find((m) => m.id === picked) ?? currentMilestone(model.milestones));
  // The tasks the tasks view shows; actions, evidence, drawers and new tasks keep every task read.
  const shown = useMemo(
    () =>
      model && scope === 'milestone' && current
        ? { ...model, tasks: model.tasks.filter((t) => t.milestone_id === current.id) }
        : model,
    [model, scope, current],
  );
  // The more menu's baseline start opens the model popover at the menu button.
  const [choosing, setChoosing] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const selectFlow = useCallback(
    (taskId: string | null) =>
      useShell.setState({
        boardTask: taskId === null ? null : { projectId: projectId ?? null, taskId, panel: 'flow' },
      }),
    [projectId],
  );
  // Leaving the project closes its drawer, so coming back opens none.
  useEffect(() => () => useShell.setState({ boardTask: null }), [projectId]);
  const scoped = actions && projectId && !props.stale ? { ...actions, projectId } : undefined;
  // A project's first read draws what is under the view tabs in one commit, once the board and
  // its sessions are in or failed; later reads update in place.
  const settled = !props.sessionsPending && (!!model || !!error || !loading);
  const [drawnProject, setDrawnProject] = useState<{ projectId?: string } | null>(null);
  const drawnBefore = drawnProject !== null && drawnProject.projectId === projectId;
  if (settled && !drawnBefore) setDrawnProject({ projectId });
  const drawn = settled || drawnBefore;
  // The approvals the overview's needs-you strip lists, folded away or not.
  const listed =
    page === 'overview' && scoped && model
      ? (model.needs ?? []).flatMap((n) =>
          n.source.table === 'approvals' ? (needsKey(n) ?? []) : [],
        )
      : [];
  // The notice cards hold an approval until the board is drawn; the board lists those of its strip.
  useEffect(() => {
    useShell.setState({ boardWaits: drawn ? new Set(listed) : null });
  }, [drawn, listed.join('\n')]);
  const pending =
    !model && (error ? <Failure error={error} onRetry={onRetry} /> : loading && <Skeleton />);
  const flow = page === 'tasks' && view === 'flow';
  const editing = useBoardEditing(projectId ?? '') && flow && !!model && !!projectId;
  const unsent =
    useDraftEdits(projectId ?? '').length +
    useUnsentEdits(model ?? NO_TASKS, projectId ?? '').length;
  // The task column's title field takes the focus once the column is drawn.
  const taskTitle = useRef<HTMLInputElement>(null);
  const [focusTask, setFocusTask] = useState(0);
  useEffect(() => {
    if (focusTask) taskTitle.current?.focus();
  }, [focusTask]);
  const openFlow = () => {
    if (!projectId) return;
    if (page !== 'tasks') onPage('tasks');
    if (view !== 'flow') pickTaskView(projectId, 'flow');
  };
  const newTask = () => {
    if (!projectId) return;
    openFlow();
    setBoardEditing(projectId, true);
    setFocusTask((n) => n + 1);
  };
  // The asked row is in the overview's needs-you strip.
  const askNeed = (key: string) => {
    if (page !== 'overview') onPage('overview');
    useShell.setState({ askedNeed: key });
  };
  // The task the page picked, docked as the body's second column.
  const drawer = model && (
    <BoardDrawer
      projectId={projectId}
      model={model}
      onSelect={selectFlow}
      onOpenSession={onOpenSession}
      onOpenStory={onOpenStory}
      onStartTask={onStartTask}
      tell={scoped && { sessions: scoped.sessions, run: scoped.run }}
      onAskNeed={actions ? askNeed : undefined}
    />
  );
  // The overview and the whole history put their controls in these elements of the bar.
  const [historyBar, setHistoryBar] = useState<HTMLElement | null>(null);
  const [goalsBar, setGoalsBar] = useState<HTMLElement | null>(null);
  const empty = !!model && isEmpty(model);
  const planner = model && planLead(model);
  const plan = model?.leads?.find((l) => l.session_id === planner);
  const busy = !!baseline?.busy;
  const syncLabel = t({ id: 'board.bar.sync', defaultMessage: 'Have the lead sync the plan' });
  const loadingPanel = (
    <section className="bd-pn bd-s12" aria-labelledby="bd-load-h">
      <div className="bd-ph">
        <h2 id="bd-load-h">{PAGES.find((p) => p.key === page)?.label}</h2>
      </div>
      {pending}
    </section>
  );
  const setupPanel = setup && setupShown(setup, model, empty) && (
    <ProjectSetup setup={setup} onOpenSession={onOpenSession} />
  );
  // The setup says a failed start in its own panel.
  const startError = !setupPanel && baseline?.error;
  // In place of the body the setup keeps only the view switches and the More menu in the bar.
  const setupOnly = !!setupPanel;
  return (
    <>
      <TopBar title={SCREEN_NAMES.board}>
        {projectId && (
          <RadioGroup<BoardPage>
            className="tb-seg bd-views"
            aria-label={t({ id: 'board.view.label', defaultMessage: 'Board view' })}
            value={page}
            onValueChange={(next) => next && onPage(next)}
          >
            {PAGES.map((p) => (
              <Radio.Root key={p.key} value={p.key} aria-label={p.label}>
                <p.icon className="ic-sm" aria-hidden="true" />
                <span className="tb-lbl">{p.label}</span>
              </Radio.Root>
            ))}
          </RadioGroup>
        )}
        {page === 'tasks' && projectId && (
          <RadioGroup<TaskView>
            className="tb-seg"
            aria-label={t({ id: 'board.tasks.view.label', defaultMessage: 'Task view' })}
            value={view}
            onValueChange={(next) => pickTaskView(projectId, next)}
          >
            {TASK_VIEWS.map((v) => (
              <Radio.Root key={v.view} value={v.view}>
                {v.label}
              </Radio.Root>
            ))}
          </RadioGroup>
        )}
        {page === 'tasks' && projectId && !setupOnly && (
          <RadioGroup<TaskScope>
            className="tb-seg"
            aria-label={t({ id: 'board.tasks.scope.label', defaultMessage: 'Task scope' })}
            value={scope}
            onValueChange={(next) => pickTaskScope(projectId, next)}
          >
            {TASK_SCOPES.map((s) => (
              <Radio.Root key={s.scope} value={s.scope}>
                {s.label}
              </Radio.Root>
            ))}
          </RadioGroup>
        )}
        {drawn && (
          <>
            {headline && (
              <LeadPlan
                headline={headline}
                sessions={actions?.sessions}
                repeated={
                  page === 'overview' && !!model?.leads?.some((l) => leadLine(l) === headline.text)
                }
              />
            )}
            <div className="tb-end">
              {flow && !setupOnly && projectId && shown && !empty && hasPlanTasks(shown) && (
                <FlowGroupControl projectId={projectId} />
              )}
              {page === 'tasks' && view !== 'flow' && projectId && model && (
                <span className="bd-slot" ref={setHistoryBar} />
              )}
              {flow && !setupOnly && projectId && model && actions && !editing && (
                <EditButton projectId={projectId} disabled={!scoped} count={unsent} />
              )}
              {!setupOnly && page === 'tasks' && projectId && actions && (
                <NewTask model={model} disabled={!scoped} onNew={newTask} />
              )}
              {sync?.busy ? (
                <RunningFor label={RUNNING.writing} since={sync.since} />
              ) : (
                plan?.plan_version !== undefined &&
                model && (
                  <PlanPause
                    projectId={projectId ?? null}
                    leadId={plan.session_id}
                    version={plan.plan_version}
                    now={model.now}
                    run={actions?.run}
                    stale={props.stale}
                  >
                    <span className="gm-pv">
                      {t(
                        {
                          id: 'board.bar.planAt',
                          defaultMessage: 'Plan v{version}, updated {time}',
                        },
                        {
                          version: plan.plan_version,
                          time: dayText(plan.updated_at, model.now, { time: true }),
                        },
                      )}
                    </span>
                  </PlanPause>
                )
              )}
              {sync &&
                (sync.off ? (
                  <>
                    <Tip content={sync.off}>
                      <button
                        type="button"
                        className="btn"
                        aria-disabled={true}
                        aria-describedby="board-sync-off"
                        aria-label={syncLabel}
                        title={syncLabel}
                      >
                        <RefreshCw className="ic-sm" aria-hidden="true" />
                        <span className="tb-lbl">{syncLabel}</span>
                      </button>
                    </Tip>
                    <span id="board-sync-off" hidden>
                      {sync.off}
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={sync.busy || props.stale}
                    aria-busy={sync.busy || undefined}
                    aria-label={syncLabel}
                    title={syncLabel}
                    onClick={sync.onSync}
                  >
                    <RefreshCw className="ic-sm" aria-hidden="true" />
                    <span className="tb-lbl">{syncLabel}</span>
                  </button>
                ))}
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
              {(sync?.error || startError || baseline?.readFailure) && (
                <div className="bd-errs">
                  {sync?.error && <Failure error={sync.error} onRetry={sync.onSync} />}
                  {startError && <Failure error={startError} onRetry={() => baseline?.onStart()} />}
                  {baseline?.readFailure && <Failure {...baseline.readFailure} />}
                </div>
              )}
              {/* The pages hold no hooks; called inline, their elements stay in this view's tree. */}
              {page === 'overview'
                ? OverviewPage({
                    model,
                    current,
                    projectId,
                    actions,
                    scoped,
                    stale: props.stale,
                    onRetry,
                    onOpenSession,
                    selectFlow,
                    setupPanel,
                    loadingPanel,
                    goalsBar,
                    onGoalsBar: setGoalsBar,
                    onOpenNeeds: () => setNeedsAsked(!!model?.needs?.length),
                    onOpenTasks: (milestoneId) => {
                      setPicked(milestoneId);
                      if (projectId) pickTaskScope(projectId, 'milestone');
                      openFlow();
                    },
                    needsAsked,
                    onNeedsAsked: () => setNeedsAsked(false),
                  })
                : TasksPage({
                    view,
                    model,
                    shown,
                    projectId,
                    scoped,
                    onRetry,
                    onOpenSession,
                    onOpenEvidence: props.onOpenEvidence,
                    onStartTask,
                    selectFlow,
                    onAskNeed: actions ? askNeed : undefined,
                    onOpenTask: (taskId) => {
                      openFlow();
                      selectFlow(taskId);
                    },
                    editing,
                    taskTitle,
                    setFocusTask,
                    setupPanel,
                    empty,
                    loadingPanel,
                    graphFull,
                    onGraphFull: () => setGraphFull((on) => !on),
                    historyBar,
                  })}
            </div>
            {!(page === 'tasks' && view === 'timeline') && drawer}
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
  const view = useBoardView(projectId, 1);
  const page = useBoardPage(projectId);
  const onPage = (next: BoardPage) => {
    if (projectId) pickBoardPage(projectId, next);
  };
  const openSession = useShell((s) => s.openSession);
  const openTaskSession = useShell((s) => s.openTaskSession);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncWait, setSyncWait] = useState<TurnWait | null>(null);
  const [syncSince, setSyncSince] = useState<number | null>(null);
  const [actionsProject, setActionsProject] = useState(projectId);
  if (actionsProject !== projectId) {
    setActionsProject(projectId);
    setSyncing(false);
    setSyncError(null);
    setSyncWait(null);
    setSyncSince(null);
  }
  const shownProject = useRef(projectId);
  shownProject.current = projectId;
  const onSync = async (project_id: string) => {
    setSyncing(true);
    setSyncError(null);
    setSyncWait(null);
    setSyncSince(Date.now());
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
  const syncBusy = syncing || syncLeft !== null;
  if (!syncBusy && syncSince !== null) setSyncSince(null);
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
            busy: syncBusy,
            error: syncError,
            onSync: () => void onSync(projectId),
            off: baselineSyncReason(setup?.baseline),
            since: syncSince,
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
