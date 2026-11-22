import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Select } from '@base-ui/react/select';
import { create } from 'zustand';
import {
  Check,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  Laptop,
  MessageSquare,
  User,
  X,
} from 'lucide-react';
import type { ReviewFinding, SessionComment } from '@pantheon/domain';
import type { BoardSnapshot, BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import { AgentTypeIcon, agentTypeName } from '../../components/AgentTypeIcon';
import { DiffCounts } from '../../components/DiffCounts';
import { DiffFiles, lineOf, type DiffNote } from '../../components/DiffReview';
import { toast } from '../../components/Toast';
import { parsePatch } from '../../data/patch';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useDevices } from '../../data/devices';
import { useSessionMcpServers } from '../../data/extensions';
import { useFactsRead } from '../../data/facts-read';
import { useFeedback, type FeedbackItem } from '../../data/feedback';
import { contextShare } from '../../data/logs';
import { useRuntimeStatus } from '../../data/runtime-status';
import { failureText } from '../../data/needs-you';
import {
  addComment,
  deleteComment,
  resolveComment,
  restoreComment,
  useSessionComments,
} from '../../data/session-comments';
import { useSessionDisplay } from '../../data/session-display';
import { subagentCall, toolLabel } from '../../data/tool-calls';
import { elapsedText, toolDuration, toolState, type Session } from '../../data/transcript';
import {
  useSessionGates,
  useSessionGatesHistory,
  useSessionPreflight,
  useSessionReviews,
} from '../../data/session-panel';
import { useSessionDiff, useTurnDiff } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { holdRootFlag } from '../../lib/root-flag';
import { useShell } from '../../store';
import {
  anchorFinding,
  endedText,
  readsDiff,
  commentItem,
  conflictItem,
  findingItem,
  findingOpen,
  gateFailing,
  gateSummary,
  inspectorTabs,
  mergeBlock,
  readOnlySession,
  reviewFindings,
  sessionRow,
  sourceBranch,
  type PanelTab,
} from './model';
import {
  detachedText,
  FINDING_OUTCOMES,
  findingOutcomeLabel,
  findingOutcomeName,
  sessionBranch,
  type ChangesView,
  type FindingOutcome,
  type Panel,
} from './inspector-model';
import { BrowserPanel } from './BrowserPanel';
import { askFix, ChecksTab, MergeBar, PlanTab, ReviewTab, StoryTab } from './panel';
import { ThreadTrace, useThreadTurns } from './trace';
import { MonitorPanel } from './MonitorPanel';
import { discardKind, fail, NO_FEEDBACK, readFailed } from './shared';
import { useTurnScope } from './TurnMenu';
import { checkpointed, MoreMenu, OpenMenu, PANELS } from './SessionHeader';
import { PanelBoundary } from '../../components/PanelBoundary';
import { tokenText } from '../../lib/number-text';
import { ContextBreakdown } from './ContextBreakdown';
import { CALL_STATE, StateMark } from './items';
import {
  dispatchedAgents,
  folderParts,
  planSteps,
  toolTally,
  type ToolKind,
} from './overview-model';
import { EmptyState } from '../../components/EmptyState';
import './overview.css';

/** The changes tab shows the whole branch under this value, else the turn whose id it is. */
const BRANCH = '';

const NO_TURNS: BoardSnapshot['session_turns'] = [];

/** The file an output asked the changes tab to show, by session. */
const useChangedFile = create<Record<string, string>>()(() => ({}));

/** Asks the changes tab for the whole branch at the file, for an output with no file left to read. */
export function showChangedFile(sessionId: string, path: string): void {
  useChangedFile.setState({ [sessionId]: path });
  useTurnScope.getState().set(sessionId, BRANCH);
}

/**
 * The whole branch, then each ended turn not rolled back, numbered among turns with a checkpoint;
 * `ran` holds the turns seen running, which tells a steer run as its own turn from one injected.
 * A session in its own folder keeps no checkpoints, so it has only its uncommitted changes.
 */
function scopeItems(
  turns: BoardSnapshot['session_turns'],
  sessionId: string,
  inPlace: boolean,
  ran: ReadonlySet<string>,
) {
  if (inPlace)
    return [
      {
        value: BRANCH,
        label: t({ id: 'sessions.screen.scopeUncommitted', defaultMessage: 'Uncommitted changes' }),
      },
    ];
  return [
    {
      value: BRANCH,
      label: t({ id: 'sessions.screen.scopeBranch', defaultMessage: 'Whole branch' }),
    },
    ...turns
      .filter(
        (turn) =>
          turn.session_id === sessionId &&
          checkpointed({ turn, started_at: ran.has(turn.id) ? 0 : null }),
      )
      .flatMap((turn, i) =>
        turn.rolled_back || turn.state === 'running' || turn.state === 'queued'
          ? []
          : [
              {
                value: turn.id,
                label: t(
                  { id: 'sessions.screen.scopeTurn', defaultMessage: 'Turn {n}' },
                  { n: i + 1 },
                ),
              },
            ],
      ),
  ];
}

const fileTotals = (files: readonly { additions: number | null; deletions: number | null }[]) => ({
  files: files.length,
  additions: files.reduce((total, f) => total + (f.additions ?? 0), 0),
  deletions: files.reduce((total, f) => total + (f.deletions ?? 0), 0),
});

/** What the session card and the inspector's summary and merge bar read of a session. */
export function useSessionCard(
  sessionId: string,
  listed: WorkbenchSession | null,
  session: Session | null,
) {
  const worktree = inspectorTabs(listed).includes('changes');
  // A session in its own folder is never gated or merged; one not listed yet may have no worktree.
  const mergeable = listed !== null && inspectorTabs(listed).includes('checks');
  const ended = endedText(listed);
  const live = listed !== null && !ended;
  // A merged session's diff is read from its source.
  const diff = useSessionDiff(readsDiff(listed) ? sessionId : null);
  const gates = useSessionGates(mergeable ? sessionId : null);
  const workspace = useBoard(
    (s) => s.board?.workspaces.find((w) => w.id === listed?.workspace_id) ?? null,
  );
  // Git cannot read a worktree that is still being set up.
  const settingUp = !!workspace?.provisioning && workspace.provisioning.state !== 'ready';
  const preflight = useSessionPreflight(mergeable && live && !settingUp ? sessionId : null);
  const projectId = session?.project_id ?? null;
  const facts = useFactsRead(projectId).read?.facts ?? null;
  const branch = sourceBranch(facts, workspace?.source ?? null);
  const files = diff.data?.files;
  const totals = files ? fileTotals(files) : (listed?.changes ?? null);
  return {
    worktree,
    mergeable,
    ended,
    live,
    diff,
    gates,
    preflight,
    projectId,
    workspace,
    facts,
    branch,
    totals,
    block: mergeBlock(listed?.merge ?? null),
    merging: listed?.state === 'merging',
    title: listed ? sessionRow(listed).title : (session?.title ?? ''),
  };
}

const TOOL_KIND: Record<ToolKind, { readonly label: string }> = {
  read: {
    get label() {
      return t({ id: 'sessions.overview.toolRead', defaultMessage: 'Read' });
    },
  },
  edit: {
    get label() {
      return t({ id: 'sessions.overview.toolEdit', defaultMessage: 'Edit' });
    },
  },
  run: {
    get label() {
      return t({ id: 'sessions.overview.toolRun', defaultMessage: 'Run' });
    },
  },
  other: {
    get label() {
      return t({ id: 'sessions.overview.toolOther', defaultMessage: 'Other' });
    },
  },
};

const foldKey = (sessionId: string) => `pantheon.overview.${sessionId}`;

const usageCount = (usage: unknown, key: string): number | null => {
  const value = usage && typeof usage === 'object' ? (usage as Record<string, unknown>)[key] : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const NO_PROJECTS: BoardSnapshot['projects'] = [];
// The toast stack keeps within the overview column while one is in the page (toast.css).
const overviewFlag = () => holdRootFlag('session-overview');

/** The session's overview, a panel at the thread's right, over its merge bar. */
export function SessionCard(props: {
  sessionId: string;
  listed: WorkbenchSession | null;
  session: Session | null;
  onTab: (tab: PanelTab) => void;
}) {
  const {
    mergeable,
    live,
    diff,
    gates,
    preflight,
    projectId,
    workspace,
    facts,
    branch,
    block,
    merging,
    title,
  } = useSessionCard(props.sessionId, props.listed, props.session);
  const projects = useBoard((s) => s.board?.projects ?? NO_PROJECTS);
  const devices = useDevices().read;
  const feedback = useFeedback((s) => s.items[props.sessionId]) ?? NO_FEEDBACK;
  const readOnly = readOnlySession(props.listed);
  const conflict =
    block?.request != null ? conflictItem({ text: block.text, request: block.request }) : null;
  const attached = conflict !== null && feedback.some((item) => item.id === conflict.id);
  const { turns, usage } = useThreadTurns(props.sessionId);
  const display = useSessionDisplay();
  // The session's own choice, else the one chosen in Session display.
  const [folded, setFolded] = useState(() => {
    try {
      const stored = localStorage.getItem(foldKey(props.sessionId));
      return stored ? stored === 'folded' : display.overview === 'folded';
    } catch {
      return display.overview === 'folded';
    }
  });
  const plan = planSteps(turns);
  const done = plan?.filter((step) => step.status === 'completed').length ?? 0;
  const current =
    plan?.find((step) => step.status === 'in_progress') ??
    plan?.find((step) => step.status === 'pending');
  const agents = dispatchedAgents(turns);
  const tools = toolTally(turns);
  const calls = tools.reduce((sum, kind) => sum + kind.count, 0);
  const context = display.context_usage ? contextShare(usage) : null;
  const input = usageCount(usage, 'input_tokens');
  const output = usageCount(usage, 'output_tokens');
  const cached = usageCount(usage, 'cached_input_tokens');
  const runtime = props.listed?.runtime ?? props.session?.runtime ?? '';
  const runtimeStatus = useRuntimeStatus('writer');
  const report =
    runtimeStatus.read.state === 'ready'
      ? runtimeStatus.read.statuses.find((s) => s.runtime === runtime)
      : undefined;
  const servers = useSessionMcpServers(props.sessionId);
  const merge = mergeable && (live || block !== null || gateSummary(gates.data) !== 'none');
  const deviceId = props.listed?.device_id ?? 'local';
  const device =
    devices.state === 'ready' ? devices.devices.find((d) => d.id === deviceId) : undefined;
  const machine = device?.name ?? (deviceId === 'local' ? null : deviceId);
  const path = workspace?.path ?? projects.find((p) => p.id === projectId)?.roots[0] ?? null;
  const folder = path === null ? null : folderParts(path, device?.home ?? null);
  // A session without a worktree runs in the project's first folder.
  const onBranch = sessionBranch(
    props.listed,
    props.listed?.workspace_id === null ? (facts?.folders[0]?.branch ?? null) : branch,
  );
  // Pantheon's own server carries its tools to every session; it is not one of the user's connectors.
  const connectors = servers.filter(
    (server) => server.state !== 'disabled' && server.name !== 'pantheon',
  );
  const outputs = diff.data?.files ?? [];
  const placed = machine !== null || folder !== null || onBranch !== null;
  if (
    !placed &&
    !context &&
    !connectors.length &&
    !outputs.length &&
    !plan &&
    !agents.length &&
    !calls &&
    !merge
  )
    return null;
  const fold = () => {
    setFolded(!folded);
    try {
      localStorage.setItem(foldKey(props.sessionId), folded ? 'open' : 'folded');
    } catch {
      // The choice still holds until the app closes.
    }
  };
  const separator = t({ id: 'sessions.parts.separator', defaultMessage: ', ' });
  const overview = t({ id: 'sessions.overview.title', defaultMessage: 'Overview' });
  const environment = t({ id: 'sessions.overview.environment', defaultMessage: 'Environment' });
  const contextTitle = t({ id: 'sessions.overview.context', defaultMessage: 'Context' });
  const connectorsTitle = t({ id: 'sessions.overview.connectors', defaultMessage: 'Connectors' });
  const outputsTitle = t({ id: 'sessions.overview.outputs', defaultMessage: 'Outputs' });
  return (
    <aside className="ov-card" aria-label={overview} ref={overviewFlag}>
      <div className="ov-hd">
        <span className="ov-t">{overview}</span>
        <button
          type="button"
          className="ib ov-tog"
          aria-label={
            folded
              ? t({ id: 'sessions.overview.expand', defaultMessage: 'Expand overview' })
              : t({ id: 'sessions.overview.collapse', defaultMessage: 'Collapse overview' })
          }
          aria-expanded={!folded}
          onClick={fold}
        >
          <ChevronDown aria-hidden="true" />
        </button>
      </div>
      {!folded && placed && (
        <section className="ov-sec" aria-label={environment}>
          <h2 className="ov-h">{environment}</h2>
          {machine !== null && (
            <div className="ov-row">
              <Laptop
                className="ov-ic"
                role="img"
                aria-label={t({ id: 'sessions.overview.machine', defaultMessage: 'Machine' })}
              />
              <span className="ov-cut">{machine}</span>
            </div>
          )}
          {folder !== null && (
            <div className="ov-row" title={path!}>
              <Folder
                className="ov-ic"
                role="img"
                aria-label={t({ id: 'sessions.overview.folder', defaultMessage: 'Folder' })}
              />
              <span className="ov-cut">{folder.name}</span>
              <span className="ov-cut mono ov-path">{folder.parent}</span>
            </div>
          )}
          {onBranch !== null && (
            <div className="ov-row">
              <GitBranch
                className="ov-ic"
                role="img"
                aria-label={t({ id: 'sessions.overview.branch', defaultMessage: 'Branch' })}
              />
              <span className="ov-cut">{onBranch.name ?? detachedText()}</span>
            </div>
          )}
        </section>
      )}
      {!folded && context && (
        <section className="ov-sec ov-cx" aria-label={contextTitle}>
          <h2 className="ov-h">{contextTitle}</h2>
          <ContextBreakdown
            usage={usage}
            runtime={runtime}
            model={props.session?.reported_model ?? props.listed?.model ?? null}
            quota={report?.quota}
          />
          {(input !== null || output !== null) && (
            <div className="ov-row ov-n">
              {input !== null && (
                <span>
                  {t(
                    { id: 'sessions.overview.input', defaultMessage: 'Input {tokens}' },
                    { tokens: tokenText(input) },
                  )}
                </span>
              )}
              {output !== null && (
                <span>
                  {t(
                    { id: 'sessions.overview.output', defaultMessage: 'Output {tokens}' },
                    { tokens: tokenText(output) },
                  )}
                </span>
              )}
              {input && cached !== null ? (
                <span className="ov-end">
                  {t(
                    { id: 'sessions.overview.cache', defaultMessage: 'Cache {share}' },
                    { share: `${Math.round((cached / input) * 100)}%` },
                  )}
                </span>
              ) : null}
            </div>
          )}
        </section>
      )}
      {!folded && connectors.length > 0 && (
        <section className="ov-sec" aria-label={connectorsTitle}>
          <h2 className="ov-h">{connectorsTitle}</h2>
          <ul className="ov-list">
            {connectors.map((server) => (
              <li key={server.name} className="ov-row">
                <span className="ov-badge" aria-hidden="true">
                  {server.name.charAt(0).toUpperCase()}
                </span>
                <span className="ov-cut">{server.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!folded && outputs.length > 0 && (
        <section className="ov-sec" aria-label={outputsTitle}>
          <h2 className="ov-h">{outputsTitle}</h2>
          <ul className="ov-list">
            {outputs.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  className="ov-row ov-file"
                  aria-label={file.path}
                  title={file.path}
                  onClick={() => {
                    showChangedFile(props.sessionId, file.path);
                    props.onTab('diff');
                  }}
                >
                  <FileText className="ov-ic" aria-hidden="true" />
                  <span className="ov-cut">{file.path.split('/').pop()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!folded && plan && (
        <button type="button" className="ov-sec ov-fs" onClick={() => props.onTab('plan')}>
          <span className="ov-row">
            <span className="ov-cap">
              {t({ id: 'sessions.overview.plan', defaultMessage: 'Plan' })}
            </span>
            <span className="ov-meter" aria-hidden="true">
              <i style={{ transform: `scaleX(${done / plan.length})` }} />
            </span>
            <span className="ov-n">
              {done} / {plan.length}
            </span>
          </span>
          {current && (
            <span className="ov-row">
              {current.status === 'in_progress' && props.listed?.state === 'waiting' ? (
                <span
                  className="ss-st"
                  data-step="in_progress"
                  data-wait
                  role="img"
                  aria-label={t({ id: 'sessions.card.waiting', defaultMessage: 'Waiting for you' })}
                />
              ) : current.status === 'in_progress' ? (
                <span className="ov-glyph" role="img" aria-label={CALL_STATE.running.label}>
                  <StateMark state="running" />
                </span>
              ) : (
                <span className="ov-glyph" aria-hidden="true" />
              )}
              <span className="ov-cut">{current.title}</span>
            </span>
          )}
        </button>
      )}
      {!folded && agents.length > 0 && (
        <div className="ov-sec">
          <div className="ov-row">
            <span className="ov-cap">
              {t({ id: 'sessions.overview.agents', defaultMessage: 'Agents' })}
            </span>
            <span className="ov-n ov-end">{agents.length}</span>
          </div>
          {agents.map(({ agent, ended }) => {
            const info = subagentCall(agent.name, agent.input)!;
            const state = toolState(agent, ended);
            const duration = toolDuration(agent);
            return (
              <div key={agent.id} className="ov-row">
                <RuntimeGlyph runtime={runtime} />
                {info.type ? <AgentTypeIcon type={info.type} /> : <span className="ov-glyph" />}
                <span className="ov-cut ov-name">
                  {info.type ? agentTypeName(info.type) : toolLabel(agent.name, agent.input).title}
                </span>
                <span className="ov-glyph" role="img" aria-label={CALL_STATE[state].label}>
                  <StateMark state={state} />
                </span>
                <span className="ov-time mono">
                  {duration === null ? '' : elapsedText(duration)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!folded && calls > 0 && (
        <div className="ov-sec">
          <div className="ov-row">
            <span className="ov-cap">
              {t({ id: 'sessions.overview.tools', defaultMessage: 'Tools' })}
            </span>
            <span className="ov-n ov-end">
              {t(
                {
                  id: 'sessions.overview.calls',
                  defaultMessage: '{count, plural, one {# call} other {# calls}}',
                },
                { count: calls },
              )}
            </span>
          </div>
          <span
            className="ov-seg"
            role="img"
            aria-label={t(
              { id: 'sessions.overview.toolsBar', defaultMessage: 'Tool calls: {parts}' },
              {
                parts: tools
                  .map(({ kind, count }) =>
                    t(
                      { id: 'sessions.overview.toolCount', defaultMessage: '{kind} {count}' },
                      { kind: TOOL_KIND[kind].label, count },
                    ),
                  )
                  .join(separator),
              },
            )}
          >
            {tools.map(({ kind, count }) => (
              <i key={kind} data-kind={kind} style={{ flexGrow: count }} />
            ))}
          </span>
          <div className="ov-lg" aria-hidden="true">
            {tools.map(({ kind, count }) => (
              <span key={kind}>
                <i className="ov-dot" data-kind={kind} />
                {TOOL_KIND[kind].label}
                <span className="ov-num">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {!folded && merge && (
        <div className="ss-pf">
          {block && (
            <div className="ss-cerr" role="alert">
              {block.text}
              {!readOnly && conflict && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="btn"
                    aria-label={t({
                      id: 'sessions.screen.attachConflict',
                      defaultMessage: 'Attach conflict',
                    })}
                    aria-pressed={attached}
                    onClick={() =>
                      attached
                        ? useFeedback.getState().remove(props.sessionId, conflict.id)
                        : useFeedback.getState().add(props.sessionId, conflict)
                    }
                  >
                    {t({ id: 'sessions.screen.attachConflict', defaultMessage: 'Attach conflict' })}
                  </button>
                </>
              )}
            </div>
          )}
          {readFailed(preflight)}
          <MergeBar
            sessionId={props.sessionId}
            revision={props.session?.revision ?? null}
            live={live}
            merging={merging}
            cancelling={props.listed?.merge?.cancel_requested}
            preflight={preflight.data}
            preflightError={preflight.error}
            onPreflight={preflight.reload}
            gates={gates.data}
            branch={branch}
            source={title}
            onChecks={() => props.onTab('checks')}
            listed={props.listed}
            head={diff.data?.head_sha ?? null}
            feedback={feedback}
            direct={!!props.session?.conductor}
          />
        </div>
      )}
    </aside>
  );
}

/**
 * The session's open panels, one column each with its own head, in the order they were opened;
 * the changes column carries the merge row of a live worktree.
 */
export function SessionInspector(props: {
  sessionId: string;
  listed: WorkbenchSession | null;
  session: Session | null;
  /** The open panels, the earliest opened first. */
  panels: readonly Panel[];
  /** What the changes panel shows; absent shows the diff. */
  view?: ChangesView;
  /** Shown as a sheet over the thread header, so it carries that header's open and session menus. */
  sheet?: boolean;
  /** Each column's width in px; a sheet's column fills the sheet. */
  widths?: Readonly<Record<Panel, number>>;
  /** The resize handle on a column's left edge. */
  grip?: (tab: Panel) => ReactNode;
  onOpen: (tab: PanelTab) => void;
  onClose: (tab: Panel) => void;
  onView: (view: ChangesView) => void;
}) {
  const {
    worktree,
    mergeable,
    ended,
    live,
    diff,
    gates,
    preflight,
    projectId,
    branch,
    totals,
    block,
    merging,
    title,
  } = useSessionCard(props.sessionId, props.listed, props.session);
  const mergedSession = props.listed?.state === 'merged';
  const sessionTurns = useBoard((s) => s.board?.session_turns ?? NO_TURNS);
  const events = useBoard((s) => s.events);
  const threadTurns = useThreadTurns(props.sessionId).turns;
  const scopes = useMemo(() => {
    if (!worktree || ended) return [];
    const ran = new Set([
      ...events.flatMap((e) => (e.kind === 'turn.running' ? [e.aggregate_id] : [])),
      ...threadTurns.flatMap((view) => (view.started_at !== null ? [view.turn.id] : [])),
    ]);
    return scopeItems(
      sessionTurns,
      props.sessionId,
      props.listed?.workspace_kind === 'in_place',
      ran,
    );
  }, [
    worktree,
    ended,
    sessionTurns,
    events,
    threadTurns,
    props.sessionId,
    props.listed?.workspace_kind,
  ]);
  const readAsked = () => useTurnScope.getState().scopes[props.sessionId];
  // zustand's own hook gives a server render the initial state, not the turn asked for.
  const asked = useSyncExternalStore(useTurnScope.subscribe, readAsked, readAsked);
  const [picked, setPicked] = useState({ sessionId: props.sessionId, turnId: BRANCH });
  useEffect(() => {
    if (asked === undefined) return;
    const turnId = useTurnScope.getState().take(props.sessionId);
    if (turnId !== undefined) setPicked({ sessionId: props.sessionId, turnId });
  }, [asked, props.sessionId]);
  const wanted = asked ?? (picked.sessionId === props.sessionId ? picked.turnId : BRANCH);
  const readFile = () => useChangedFile.getState()[props.sessionId];
  const askedFile = useSyncExternalStore(useChangedFile.subscribe, readFile, readFile);
  // Review and Explain read the whole branch, so they keep the pick for the diff.
  const scoped = (props.view ?? 'diff') === 'diff';
  const scope = scoped && scopes.some((item) => item.value === wanted) ? wanted : BRANCH;
  const turnDiff = useTurnDiff(
    scope === BRANCH ? null : props.sessionId,
    scope === BRANCH ? null : scope,
  );
  const shown = scope === BRANCH ? diff : turnDiff;
  const gatesHistory = useSessionGatesHistory(mergeable ? props.sessionId : null);
  const reviews = useSessionReviews(worktree ? props.sessionId : null);
  const comments = useSessionComments(worktree ? props.sessionId : null);
  const openSettings = useShell((s) => s.openSettings);
  const [busy, setBusy] = useState(false);
  // Shown at the foot of the column whose action failed.
  const [error, setError] = useState<{ at: Panel; text: string } | null>(null);
  const feedback = useFeedback((s) => s.items[props.sessionId]) ?? NO_FEEDBACK;
  const attached = new Set(feedback.map((item) => item.id));
  const attach = (item: FeedbackItem) => useFeedback.getState().add(props.sessionId, item);
  const toggle = (item: FeedbackItem) =>
    attached.has(item.id) ? useFeedback.getState().remove(props.sessionId, item.id) : attach(item);
  const readOnly = readOnlySession(props.listed);
  const conflict =
    block?.request != null ? conflictItem({ text: block.text, request: block.request }) : null;
  const findings = reviews.data ? reviewFindings(reviews.data) : [];
  const unresolved = findings.filter(findingOpen);
  const send = async (
    type: 'session.gates.run',
    input: Record<string, unknown>,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await runCommand(type, input, props.session?.revision ?? null).catch(fail);
    setBusy(false);
    if (!result.ok) setError({ at: 'checks', text: failureText(result.error) });
    return result.ok;
  };
  const fix = async (items: FeedbackItem[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await askFix(
      props.sessionId,
      props.listed?.state,
      props.session?.revision ?? null,
      items,
    );
    setBusy(false);
    if (!result.ok) setError({ at: 'checks', text: failureText(result.error) });
  };
  const resolve = async (finding: ReviewFinding, outcome: FindingOutcome) => {
    const review = reviews.data?.find((r) => r.id === finding.review_id);
    if (busy || !review) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'review.finding.resolve',
      { review_id: review.id, finding_id: finding.id, outcome },
      review.revision,
    ).catch(fail);
    setBusy(false);
    if (result.ok) reviews.reload();
    else setError({ at: 'changes', text: failureText(result.error) });
  };
  const patchText = diff.data && !diff.data.truncated ? diff.data.patch : null;
  const diffFiles = useMemo(() => (patchText === null ? null : parsePatch(patchText)), [patchText]);
  const turnPatch = turnDiff.data && !turnDiff.data.truncated ? turnDiff.data.patch : null;
  const turnFiles = useMemo(() => (turnPatch === null ? null : parsePatch(turnPatch)), [turnPatch]);
  const shownFiles = scope === BRANCH ? diffFiles : turnFiles;
  const commentNotes = (comments.data ?? []).map((comment): DiffNote => {
    const at = shownFiles && lineOf(shownFiles, comment);
    const item = commentItem(comment, at);
    const card = (loose: boolean) => (
      <CommentCard
        sessionId={props.sessionId}
        comment={comment}
        item={item}
        loose={loose}
        outdated={!!shownFiles && !at && comment.line_text !== undefined}
        readOnly={readOnly}
        attached={attached.has(item.id)}
        onAttach={toggle}
        onChanged={comments.reload}
      />
    );
    return {
      id: item.id,
      path: comment.path,
      side: comment.side,
      line: comment.line,
      line_text: comment.line_text,
      node: card(false),
      // A turn's diff leaves out lines the branch has, so only the branch lists the ones it cannot place.
      ...(scope === BRANCH ? { loose: card(true) } : {}),
    };
  });
  const anchored = diffFiles
    ? unresolved.flatMap((finding) => {
        const at = anchorFinding(finding, diffFiles);
        return at ? [{ finding, at }] : [];
      })
    : [];
  const plan = planSteps(useThreadTurns(props.sessionId).turns);
  const gate = gateSummary(gates.data);
  const shownTotals =
    scope === BRANCH ? totals : turnDiff.data ? fileTotals(turnDiff.data.files) : null;
  const merge = mergeable && (live || block !== null || gate !== 'none');
  const failing = gates.data?.last?.results.filter(gateFailing).length ?? 0;
  const running = props.listed?.tasks?.running ?? 0;
  const panels = props.panels.filter((tab) => inspectorTabs(props.listed).includes(tab));
  const count = (tab: Panel): { n: number; label: string } | null => {
    if (tab === 'changes' && totals && totals.files > 0)
      return {
        n: totals.files,
        label: t(
          {
            id: 'sessions.screen.filesTotal',
            defaultMessage: '{count, plural, one {# file} other {# files}}',
          },
          { count: totals.files },
        ),
      };
    if (tab === 'checks' && failing > 0)
      return {
        n: failing,
        label: t(
          {
            id: 'sessions.screen.checksFailing',
            defaultMessage: '{count, plural, one {# check not passed} other {# checks not passed}}',
          },
          { count: failing },
        ),
      };
    if (tab === 'monitor' && running > 0)
      return {
        n: running,
        label: t(
          {
            id: 'sessions.panel.monitor.running',
            defaultMessage: '{count, plural, one {# task running} other {# tasks running}}',
          },
          { count: running },
        ),
      };
    return null;
  };
  const target = preflight.data ? preflight.data.target_branch : branch;
  const against = scope === BRANCH && props.listed?.workspace_kind !== 'in_place' ? target : null;
  const filesLabel =
    shownTotals &&
    (against
      ? t(
          {
            id: 'sessions.panel.dock.filesAgainst',
            defaultMessage: '{count, plural, one {# file} other {# files}}, against {branch}',
          },
          { count: shownTotals.files, branch: against },
        )
      : t(
          {
            id: 'sessions.screen.filesTotal',
            defaultMessage: '{count, plural, one {# file} other {# files}}',
          },
          { count: shownTotals.files },
        ));
  const view = props.view ?? 'diff';
  const reviewing = view === 'review';
  const changes = (): ReactNode => {
    if (view === 'review')
      return (
        <ReviewTab
          sessionId={props.sessionId}
          runtime={props.listed?.runtime ?? props.session?.runtime ?? ''}
          reviews={reviews}
          files={diffFiles}
          readOnly={readOnly}
          attached={attached}
          onAttach={toggle}
        />
      );
    if (view === 'story')
      return (
        <StoryTab
          sessionId={props.sessionId}
          projectId={projectId}
          listed={props.listed}
          diff={diff.data}
          findings={unresolved}
        />
      );
    return ended && !mergedSession ? (
      <EmptyState inline title={ended} />
    ) : (
      <>
        {readFailed(comments)}
        <DiffFiles
          key={`${props.sessionId}\n${scope}`}
          diff={shown}
          path={scope === BRANCH ? askedFile : undefined}
          onComment={
            readOnly
              ? undefined
              : async (at, comment) => {
                  const result = await addComment(props.sessionId, {
                    path: at.path,
                    line: at.line,
                    side: at.kind === 'del' ? 'old' : 'new',
                    text: comment.trim(),
                    line_text: at.text,
                    ...(scope === BRANCH ? {} : { turn_id: scope }),
                  });
                  if (!result.ok) throw new Error(failureText(result.error));
                  comments.reload();
                  return true;
                }
          }
          notes={[
            ...(scope === BRANCH ? anchored : []).map(({ finding, at }) => ({
              id: finding.id,
              ...at,
              node: (
                <div className="df-finding">
                  <div className="ss-rvh">
                    <span className="ss-rvm">{runtimeName(finding.runtime)}</span>
                  </div>
                  <p>{finding.impact}</p>
                  {!readOnly && (
                    <div className="df-findinga">
                      {FINDING_OUTCOMES.map((outcome) => (
                        <button
                          key={outcome}
                          type="button"
                          className="btn"
                          aria-label={findingOutcomeLabel(finding, outcome)}
                          disabled={busy}
                          onClick={() => void resolve(finding, outcome)}
                        >
                          {findingOutcomeName(outcome)}
                        </button>
                      ))}
                      {!ended && (
                        <button
                          type="button"
                          className="btn"
                          aria-label={t(
                            {
                              id: 'sessions.screen.attachFinding',
                              defaultMessage: 'Attach: {impact}',
                            },
                            { impact: finding.impact },
                          )}
                          aria-pressed={attached.has(findingItem(finding).id)}
                          onClick={() => toggle(findingItem(finding))}
                        >
                          {t({ id: 'sessions.screen.attach', defaultMessage: 'Attach' })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ),
            })),
            ...commentNotes,
          ]}
        />
      </>
    );
  };
  const body = (tab: Panel): ReactNode => {
    if (tab === 'changes')
      return (
        <>
          <div className="ss-chd">
            {shownTotals && shownTotals.files > 0 && (
              <span className="mono">
                <DiffCounts additions={shownTotals.additions} deletions={shownTotals.deletions} />
              </span>
            )}
            {filesLabel && (
              <span className="ss-cn" title={filesLabel}>
                {filesLabel}
              </span>
            )}
            {scoped && scopes.length > 1 && (
              <Select.Root<string>
                items={scopes}
                value={scope}
                onValueChange={(value) => {
                  if (value !== null) setPicked({ sessionId: props.sessionId, turnId: value });
                }}
              >
                <Select.Trigger
                  className="btn tk-select"
                  aria-label={t({
                    id: 'sessions.screen.changeScope',
                    defaultMessage: 'Scope of changes',
                  })}
                >
                  <Select.Value />
                  <Select.Icon className="mu">
                    <ChevronDown className="ic-sm" aria-hidden="true" />
                  </Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner
                    side="bottom"
                    align="start"
                    sideOffset={4}
                    alignItemWithTrigger={false}
                    style={{ zIndex: 40 }}
                  >
                    <Select.Popup className="tk-menu pop">
                      <Select.List>
                        {scopes.map((item) => (
                          <Select.Item key={item.value} value={item.value} className="tk-item">
                            <Select.ItemIndicator className="tk-check">
                              <Check className="ic-sm" aria-hidden="true" />
                            </Select.ItemIndicator>
                            <Select.ItemText>{item.label}</Select.ItemText>
                          </Select.Item>
                        ))}
                      </Select.List>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            )}
            <button
              type="button"
              className="btn sm"
              aria-pressed={reviewing}
              onClick={() => props.onView(reviewing ? 'diff' : 'review')}
            >
              {t({ id: 'sessions.panel.dock.review', defaultMessage: 'Review' })}
            </button>
          </div>
          {changes()}
        </>
      );
    if (tab === 'checks')
      return (
        <ChecksTab
          sessionId={props.sessionId}
          revision={props.session?.revision ?? null}
          gates={gates}
          history={gatesHistory}
          readOnly={readOnly}
          projectId={projectId}
          merging={merging}
          busy={busy}
          attached={attached}
          onAttach={toggle}
          onFix={(items) => void fix(items)}
          onRun={() =>
            void send('session.gates.run', { session_id: props.sessionId }).then(
              (ok) => ok && gates.reload(),
            )
          }
          onSettings={() => projectId && openSettings(projectId)}
          gate={props.listed?.gate}
          reviews={reviews.data}
          onReview={() => props.onOpen('review')}
        />
      );
    if (tab === 'browser') return <BrowserPanel sessionId={props.sessionId} />;
    if (tab === 'trace') return <ThreadTrace sessionId={props.sessionId} />;
    if (tab === 'monitor') return <MonitorPanel sessionId={props.sessionId} />;
    return <PlanTab steps={plan} waiting={props.listed?.state === 'waiting'} />;
  };
  const foot = (tab: Panel): ReactNode => {
    const failed = error?.at === tab ? error.text : null;
    const merges = tab === 'changes' && merge;
    if (failed === null && !merges) return null;
    return (
      <div className="ss-pf">
        {(failed !== null || (merges && block)) && (
          <div className="ss-cerr" role="alert">
            {failed ?? block!.text}
            {failed === null && !readOnly && conflict && (
              <>
                {' '}
                <button
                  type="button"
                  className="btn"
                  aria-label={t({
                    id: 'sessions.screen.attachConflict',
                    defaultMessage: 'Attach conflict',
                  })}
                  aria-pressed={attached.has(conflict.id)}
                  onClick={() => toggle(conflict)}
                >
                  {t({ id: 'sessions.screen.attachConflict', defaultMessage: 'Attach conflict' })}
                </button>
              </>
            )}
          </div>
        )}
        {merges && (
          <>
            {readFailed(preflight)}
            <MergeBar
              sessionId={props.sessionId}
              revision={props.session?.revision ?? null}
              live={live}
              merging={merging}
              cancelling={props.listed?.merge?.cancel_requested}
              preflight={preflight.data}
              preflightError={preflight.error}
              onPreflight={preflight.reload}
              gates={gates.data}
              branch={branch}
              source={title}
              onChecks={() => props.onOpen('checks')}
              listed={props.listed}
              head={diff.data?.head_sha ?? null}
              feedback={feedback}
              direct={!!props.session?.conductor}
            />
          </>
        )}
      </div>
    );
  };
  return (
    <>
      {props.sheet && (
        <div className="ss-ph">
          <h2 className="ss-pt" title={title}>
            {title}
          </h2>
          {props.listed && (
            <>
              <OpenMenu
                listed={props.listed}
                onError={(text) =>
                  setError(text === null || !panels.length ? null : { at: panels.at(-1)!, text })
                }
              />
              <MoreMenu
                session={props.listed}
                discardable={discardKind(props.session, props.listed) !== null}
                place="sheet"
              />
            </>
          )}
        </div>
      )}
      {panels.map((tab) => {
        const { icon: Icon, label } = PANELS[tab];
        const counted = count(tab);
        return (
          <section
            key={tab}
            className="ss-col"
            aria-label={label}
            style={props.widths ? { width: props.widths[tab] } : undefined}
          >
            {props.grip?.(tab)}
            <div className="ss-colh">
              <Icon aria-hidden="true" />
              <span className="ss-colt">{label}</span>
              {counted && (
                <span className="ss-coln" role="img" aria-label={counted.label}>
                  {counted.n}
                </span>
              )}
              <span className="ss-cola">
                {tab === 'changes' && (
                  <button
                    type="button"
                    className="btn sm"
                    aria-pressed={view === 'story'}
                    onClick={() => props.onView(view === 'story' ? 'diff' : 'story')}
                  >
                    <MessageSquare aria-hidden="true" />
                    {t({ id: 'sessions.panel.dock.explain', defaultMessage: 'Explain changes' })}
                  </button>
                )}
                <button
                  type="button"
                  className="ib"
                  aria-label={t(
                    { id: 'sessions.screen.closePanel', defaultMessage: 'Close {panel}' },
                    { panel: label },
                  )}
                  onClick={() => props.onClose(tab)}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            </div>
            <div className="ss-pbody">
              <PanelBoundary>{body(tab)}</PanelBoundary>
            </div>
            {foot(tab)}
          </section>
        );
      })}
    </>
  );
}

/** A stored comment on a diff line; an open one can go to the agent, stay a note or be deleted. */
function CommentCard(props: {
  sessionId: string;
  comment: SessionComment;
  /** The comment as an item of the next message. */
  item: FeedbackItem;
  /** Names the file and line, for a comment the diff cannot place. */
  loose: boolean;
  /** The diff no longer has the line the comment was made on. */
  outdated: boolean;
  readOnly: boolean;
  attached: boolean;
  onAttach: (item: FeedbackItem) => void;
  /** Reads the comments again. */
  onChanged: () => void;
}) {
  const { comment, item } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (command: () => Promise<BridgeResult<unknown>>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await command();
    setBusy(false);
    if (!result.ok) return setError(failureText(result.error));
    done?.();
    props.onChanged();
  };
  const remove = () => {
    const attached = props.attached;
    return run(
      () => deleteComment(comment),
      () => {
        if (attached) useFeedback.getState().remove(props.sessionId, item.id);
        toast({
          title: t({ id: 'sessions.screen.commentDeleted', defaultMessage: 'Comment deleted' }),
          action: {
            label: t({ id: 'sessions.screen.commentUndo', defaultMessage: 'Undo' }),
            run: () =>
              void restoreComment(props.sessionId, comment).then((back) => {
                if (!back.ok) {
                  props.onChanged();
                  return toast({ title: failureText(back.error), kind: 'failure' });
                }
                const id = back.value.id;
                if (attached)
                  useFeedback.getState().add(props.sessionId, {
                    ...item,
                    id: `comment:${id}`,
                    comment: { id, revision: back.value.revision },
                  });
                props.onChanged();
              }),
          },
        });
      },
    );
  };
  const state =
    comment.state === 'sent'
      ? t({ id: 'sessions.screen.commentSent', defaultMessage: 'Sent to the agent' })
      : comment.state === 'kept'
        ? t({ id: 'sessions.screen.commentKept', defaultMessage: 'Kept as a note' })
        : null;
  return (
    <div className="df-cmt tr-in" data-loose={props.loose || undefined}>
      <div className="df-cmth">
        <User className="ic-sm" aria-hidden="true" />
        <span className="df-cmtw">
          {t({ id: 'sessions.screen.commentAuthor', defaultMessage: 'You' })}
        </span>
        {props.loose && (
          <span className="mono">
            {comment.path}:{comment.line}
          </span>
        )}
        <span className="mu">
          {t(
            { id: 'sessions.screen.commentLine', defaultMessage: 'Line {line}' },
            { line: comment.line },
          )}
        </span>
        {props.outdated && (
          <span className="mu">
            {t({ id: 'sessions.screen.commentOutdated', defaultMessage: 'Outdated' })}
          </span>
        )}
      </div>
      <p>{comment.text}</p>
      {error && (
        <div className="run-err" role="alert">
          {error}
        </div>
      )}
      {(state !== null || !props.readOnly) && (
        <div className="df-cmta">
          {state !== null ? (
            <span className="mu">{state}</span>
          ) : (
            <>
              <button
                type="button"
                className="btn sm"
                aria-pressed={props.attached}
                disabled={busy}
                onClick={() => props.onAttach(item)}
              >
                {t({
                  id: 'sessions.screen.commentAsk',
                  defaultMessage: 'Ask the agent to change it',
                })}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => resolveComment(comment, 'kept'),
                    () => {
                      if (props.attached) useFeedback.getState().remove(props.sessionId, item.id);
                    },
                  )
                }
              >
                {t({ id: 'sessions.screen.commentKeep', defaultMessage: 'Keep as a note' })}
              </button>
            </>
          )}
          {!props.readOnly && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t({ id: 'sessions.screen.commentDelete', defaultMessage: 'Delete' })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
