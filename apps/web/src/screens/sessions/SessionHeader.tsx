import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  Activity,
  ChartNoAxesGantt,
  ChevronDown,
  Columns2,
  Crown,
  Ellipsis,
  FileDiff,
  Gauge,
  GitBranch,
  GitFork,
  GitPullRequest,
  Globe,
  ListTodo,
  PanelRight,
  RefreshCw,
  Search,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { SessionTurn } from '@pantheon/domain';
import type { BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import {
  GateMark,
  LastTurnMark,
  SessionStateIcon,
  StateGlyph,
  lastTurnLabel,
  recapLine,
} from '../../components/SessionStateIcon';
import { KeyHint } from '../../components/Shortcuts';
import { Clip } from '../../components/Clip';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useFactsRead } from '../../data/facts-read';
import { failureText } from '../../data/needs-you';
import { useSessionDisplay } from '../../data/session-display';
import { useSessionGates } from '../../data/session-panel';
import { type Session } from '../../data/transcript';
import { useSessionTrace } from '../../data/trace';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { revealText } from '../../lib/platform-text';
import { shortcutKeys, useShortcut } from '../../lib/shortcuts';
import { durationText } from '../../lib/time-text';
import { useShell } from '../../store';
import { tokenText } from '../../lib/number-text';
import { laneStats } from '../trace/model';
import {
  gateFailing,
  gateOutcome,
  inspectorTabs,
  sessionRow,
  sourceBranch,
  turnErrorText,
  turnLogin,
  worktreeReason,
} from './model';
import { appDisplay, useAppDisplay } from './app-display';
import {
  aheadText,
  detachedText,
  gateCounts,
  hasBrowser,
  sessionBranch,
  type Panel,
} from './inspector-model';
import { MemoryDelivery } from './MemoryUsed';
import { DiscardDialog } from './parts';
import { conductorLabel, liveWorktree } from './session-groups';
import {
  baselineDiscard,
  discardDescription,
  discardKind,
  fail,
  FIT_MENU,
  menuEntry,
  useSecondTick,
  useSessionMenu,
} from './shared';
import { useThreadFind } from './ThreadFind';
import { useThreadTurns } from './trace';
import { ForkDialog, RollbackDialog } from './TurnMenu';
import './header.css';

/** Where one step of the session's plan stands. */
export type PlanStep = 'completed' | 'in_progress' | 'pending';

/** The menu entry that picks a session to show beside this one, and why it is off now. */
export interface SplitEntry {
  open: () => void;
  reason?: string;
}

/** Whether the terminal shows, whether a command in it runs, and the switch. */
export interface TerminalToggle {
  open: boolean;
  busy: boolean;
  onToggle: () => void;
}

// Labels are getters, so each is read in the language loaded by then.
export const PANELS: Record<Panel, { icon: LucideIcon; label: string }> = {
  changes: {
    icon: FileDiff,
    get label() {
      return t({ id: 'sessions.screen.tabChanges', defaultMessage: 'Changes' });
    },
  },
  checks: {
    icon: ShieldCheck,
    get label() {
      return t({ id: 'sessions.screen.tabChecks', defaultMessage: 'Checks' });
    },
  },
  plan: {
    icon: ListTodo,
    get label() {
      return t({ id: 'sessions.panel.dock.plan', defaultMessage: 'Plan' });
    },
  },
  browser: {
    icon: Globe,
    get label() {
      return t({ id: 'sessions.panel.dock.browser', defaultMessage: 'Browser' });
    },
  },
  trace: {
    icon: ChartNoAxesGantt,
    get label() {
      return t({ id: 'sessions.panel.dock.trace', defaultMessage: 'Trace' });
    },
  },
  monitor: {
    icon: Activity,
    get label() {
      return t({ id: 'sessions.panel.dock.monitor', defaultMessage: 'Monitor' });
    },
  },
};

export function SessionHeader({
  session,
  listed,
  title,
  parent = null,
  plan = null,
  panels,
  recent,
  onPanel,
  overview,
  onOverview,
  onDiscarded,
  split,
  terminal,
}: {
  session: Session | null;
  listed: WorkbenchSession | null;
  title: string;
  /** The listed session this one was opened or forked from. */
  parent?: WorkbenchSession | null;
  /** The steps of the session's plan; null without a plan. */
  plan?: readonly PlanStep[] | null;
  /** The open panels. */
  panels: readonly Panel[];
  /** The panel last opened or closed; the details shortcut toggles it. */
  recent?: Panel;
  /** Opens or closes a panel. */
  onPanel: (tab: Panel) => void;
  overview: boolean;
  /** Shows or hides the overview panel; absent for a session without one. */
  onOverview?: () => void;
  onDiscarded?: () => void;
  /** Opens the picker of a session to show beside this one; absent where none can. */
  split?: SplitEntry;
  /** The terminal under the thread and panels; absent where none can run. */
  terminal?: TerminalToggle;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const [discarding, setDiscarding] = useState(false);
  const discard = discardKind(session, listed);
  // The daemon renames every session but a baseline one.
  const renamable = !!session && !session.baseline;
  const changes = listed?.changes ?? null;
  // A session on this machine has no device mark.
  const device = listed?.device_id && listed.device_id !== 'local' ? listed.device_id : null;
  const pull = listed?.remote_pull;
  const login = listed ? turnLogin(listed) : null;
  const tabs = inspectorTabs(listed);
  // A session in its own folder is never gated.
  const gates = useSessionGates(listed && tabs.includes('checks') ? listed.id : null).data;
  const results = gates?.last?.results ?? [];
  const passed = results.filter((result) => gateOutcome(result) === 'passed').length;
  const counts =
    gateCounts(listed?.gate) ??
    (results.length > 0
      ? {
          passed,
          failed: results.filter(gateFailing).length,
          skipped: results.filter((result) => gateOutcome(result) === 'skipped').length,
          running: 0,
          notRun: 0,
          total: results.length,
        }
      : null);
  const uncounted = listed?.gate && UNCOUNTED_GATE.has(listed.gate.state) ? listed.gate : null;
  const workspace = useBoard(
    (s) => s.board?.workspaces.find((w) => w.id === listed?.workspace_id) ?? null,
  );
  const facts = useFactsRead(session?.project_id ?? null).read?.facts ?? null;
  // A session without a worktree runs in the project's first folder.
  const branch = sessionBranch(
    listed,
    listed?.workspace_id === null
      ? (facts?.folders[0]?.branch ?? null)
      : sourceBranch(facts, workspace?.source ?? null),
  );
  const done = plan?.filter((step) => step === 'completed').length ?? 0;
  const current = (plan?.indexOf('in_progress') ?? -1) + 1;
  const display = useSessionDisplay();
  const sessionId = session?.id ?? listed?.id ?? null;
  // Whether a docked interface shows; null without one.
  const docked = useAppDisplay((s) => {
    const place = sessionId && s.hosted === sessionId ? s.places[sessionId] : undefined;
    return place?.mode === 'pip' ? !place.hidden : null;
  });

  useShortcut('details', () => onPanel(recent && tabs.includes(recent) ? recent : tabs[0]!));
  useShortcut('overview', () => onOverview?.(), !!onOverview);

  const rename = () => {
    setDraft(title);
    setError(null);
    setEditing(true);
  };
  const renaming = useShell((s) => renamable && s.renaming === session?.id);
  useEffect(() => {
    if (!renaming) return;
    useShell.getState().renameSession(null);
    rename();
  }, [renaming]);

  async function save() {
    if (!session || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.rename',
      { session_id: session.id, title: draft },
      session.revision,
    ).catch(fail);
    saving.current = false;
    setBusy(false);
    if (result.ok) setEditing(false);
    else setError(failureText(result.error));
  }

  async function logIn(runtime: 'claude' | 'codex') {
    const bridge = window.pantheon;
    if (!bridge) return;
    setError(null);
    const result = await bridge.runtimeLogin(runtime).catch(fail);
    if (!result.ok) setError(failureText(result.error));
  }

  const overviewLabel = t({ id: 'sessions.header.overview', defaultMessage: 'Overview' });
  const recap = listed && recapLine(listed.recap, listed.state === 'waiting');
  const terminalLabel = t({ id: 'sessions.terminal.title', defaultMessage: 'Terminal' });
  return (
    <header className="sh-bar">
      {listed && <SessionStateIcon session={listed} place="header" />}
      {listed && <LastTurn session={listed} />}
      {parent && parentLink(parent, !!listed?.spawned_by && !listed.forked_from)}
      {session?.conductor && (
        <Crown className="ic-sm sh-agent" role="img" aria-label={conductorLabel()} />
      )}
      {editing ? (
        <input
          ref={titleInput}
          className="sh-input"
          aria-label={t({ id: 'sessions.screen.sessionTitle', defaultMessage: 'Session title' })}
          type="text"
          value={draft}
          disabled={busy}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (!saving.current) setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
        />
      ) : renamable ? (
        <h1 className="sh-title sh-h1">
          <button
            type="button"
            className="sh-title sh-rn"
            aria-label={t({
              id: 'sessions.screen.editTitle',
              defaultMessage: 'Edit session title',
            })}
            onClick={rename}
          >
            <Clip text={title} />
          </button>
        </h1>
      ) : (
        <h1 className="sh-title" title={title}>
          {title}
        </h1>
      )}
      {recap && (
        <span className="sh-cut sh-recap" title={recap}>
          {recap}
        </span>
      )}
      {listed && lastTurnLabel(listed) && login && (
        <button type="button" className="btn" onClick={() => void logIn(login)}>
          {t({ id: 'sessions.screen.logIn', defaultMessage: 'Sign in' })}
        </button>
      )}
      {error && (
        <span className="sh-err" role="alert" title={error}>
          {error}
        </span>
      )}
      {device && (
        <span className="chip mono sh-dev">
          <Terminal aria-hidden="true" />
          <span className="sh-cut">{device}</span>
        </span>
      )}
      {listed && device && pull && pull.status !== 'not_needed' && (
        <RemotePull sessionId={listed.id} device={device} pull={pull} />
      )}
      {branch && (
        <span className="sh-chip">
          <GitBranch aria-hidden="true" />
          <Clip className="sh-cut" text={branch.name ?? detachedText()} />
          {aheadText(branch).map((count) => (
            <span key={count} className="sh-ahead">
              {count}
            </span>
          ))}
        </span>
      )}
      {changes && changes.additions + changes.deletions > 0 && (
        <Tip
          content={t(
            {
              id: 'sessions.screen.fileCount',
              defaultMessage: '{count, plural, one {# file} other {# files}}',
            },
            { count: changes.files },
          )}
        >
          <span className="sh-diff" tabIndex={0}>
            <DiffCounts additions={changes.additions} deletions={changes.deletions} />
          </span>
        </Tip>
      )}
      {counts && (
        <span
          className="sh-gate"
          role="img"
          aria-label={listText(
            uncounted && GATE_NAME[uncounted.state],
            t(
              { id: 'sessions.header.checks', defaultMessage: '{passed} of {total} checks passed' },
              { passed: counts.passed, total: counts.total },
            ),
          )}
        >
          {uncounted && <GateMark gate={uncounted} />}
          <GateSeg {...counts} />
          {`${counts.passed} / ${counts.total}`}
        </span>
      )}
      <span className="sh-fill" />
      {session && <MemoryDelivery projectId={session.project_id} sessionId={session.id} />}
      {listed && working(listed) && <RunClock since={Date.parse(listed.created_at)} />}
      <div
        className="sh-tools"
        role="toolbar"
        aria-label={t({ id: 'sessions.header.panels', defaultMessage: 'Panels' })}
      >
        {TOGGLED.filter((each) => each !== 'browser' || hasBrowser()).map((each) => {
          const { icon: Icon, label } = PANELS[each];
          const pressed = panels.includes(each);
          const off = !tabs.includes(each);
          return (
            <Tip key={each} content={off ? offReason(each) : label}>
              <button
                type="button"
                className="ib"
                aria-label={label}
                aria-pressed={pressed}
                aria-disabled={off ? 'true' : undefined}
                onClick={off ? undefined : () => onPanel(each)}
              >
                <Icon aria-hidden="true" />
              </button>
            </Tip>
          );
        })}
        {terminal && (
          <Tip content={terminalLabel}>
            <button
              type="button"
              className="ib sh-term"
              aria-label={
                terminal.busy
                  ? t({
                      id: 'sessions.terminal.running',
                      defaultMessage: 'Terminal, a command is running',
                    })
                  : terminalLabel
              }
              aria-pressed={terminal.open}
              onClick={terminal.onToggle}
            >
              <SquareTerminal aria-hidden="true" />
              {terminal.busy && <i className="sh-pip" aria-hidden="true" />}
            </button>
          </Tip>
        )}
        {docked !== null && sessionId && (
          <Tip content={t({ id: 'sessions.app.docked', defaultMessage: 'Docked app' })}>
            <button
              type="button"
              className="ib"
              aria-label={t({ id: 'sessions.app.docked', defaultMessage: 'Docked app' })}
              aria-pressed={docked}
              onClick={() => appDisplay.getState().toggleDock(sessionId)}
            >
              <PanelRight aria-hidden="true" />
            </button>
          </Tip>
        )}
      </div>
      <span className="sh-vr" aria-hidden="true" />
      {onOverview && (
        <Tip content={overviewLabel}>
          <button
            type="button"
            className="ib"
            aria-label={overviewLabel}
            aria-pressed={overview}
            onClick={onOverview}
          >
            <Gauge aria-hidden="true" />
            <KeyHint id="overview" />
          </button>
        </Tip>
      )}
      {listed && (
        <MoreMenu
          session={listed}
          discardable={discard !== null}
          finalFocus={() => titleInput.current ?? true}
          onRename={rename}
          onDiscard={() => setDiscarding(true)}
          {...(split ? { split } : {})}
        >
          {session && display.context_usage && (
            <LiveTokens projectId={session.project_id} sessionId={session.id} />
          )}
        </MoreMenu>
      )}
      {plan && display.plan_bar && (
        <div
          className="sh-plan"
          role="img"
          aria-label={
            current > 0
              ? t(
                  {
                    id: 'sessions.header.plan',
                    defaultMessage:
                      'Plan of {total, plural, one {# step} other {# steps}}, {done} done, step {current} now',
                  },
                  { total: plan.length, done, current },
                )
              : t(
                  {
                    id: 'sessions.header.planDone',
                    defaultMessage:
                      'Plan of {total, plural, one {# step} other {# steps}}, {done} done',
                  },
                  { total: plan.length, done },
                )
          }
          data-wait={listed?.state === 'waiting' || undefined}
        >
          {plan.map((step, i) => (
            <i key={i} data-step={step} />
          ))}
        </div>
      )}
      {discard === 'baseline' && session && (
        <DiscardDialog
          open={discarding}
          title={title}
          sessionId={session.id}
          revision={session.revision}
          description={baselineDiscard()}
          onClose={() => setDiscarding(false)}
          onDiscarded={onDiscarded}
        />
      )}
      {(discard === 'worktree' || discard === 'folder') && listed && (
        <DiscardDialog
          open={discarding}
          title={title}
          sessionId={listed.id}
          revision={session?.revision ?? null}
          {...discardDescription(discard)}
          listed={listed}
          onClose={() => setDiscarding(false)}
          onDiscarded={onDiscarded}
        />
      )}
    </header>
  );
}

const TOGGLED: readonly Panel[] = ['changes', 'checks', 'plan', 'browser', 'trace', 'monitor'];

/** Why the session lacks a panel; only changes and checks can be missing. */
const offReason = (panel: Panel): string =>
  panel === 'changes'
    ? t({
        id: 'sessions.header.readOnly',
        defaultMessage: 'This session reads the project folder and changes no files',
      })
    : t({ id: 'sessions.header.ungated', defaultMessage: 'Only a worktree session runs gates' });

/** Each gate state's name. */
export const GATE_NAME = {
  get running() {
    return t({ id: 'sessions.screen.gateRunning', defaultMessage: 'Gates running' });
  },
  get cancelling() {
    return t({ id: 'sessions.screen.gateCancelling', defaultMessage: 'Cancelling gates' });
  },
  get cancelled() {
    return t({ id: 'sessions.screen.gateCancelled', defaultMessage: 'Gates cancelled' });
  },
  get passed() {
    return t({ id: 'sessions.screen.gatePassed', defaultMessage: 'Gates passed' });
  },
  get failed() {
    return t({ id: 'sessions.screen.gateFailed', defaultMessage: 'Gates failed' });
  },
  get stale() {
    return t({ id: 'sessions.screen.gateStale', defaultMessage: 'Gates out of date' });
  },
};

/** Gate states the counts do not tell: a run that no longer holds for the code, or one being stopped. */
export const UNCOUNTED_GATE: ReadonlySet<string> = new Set(['stale', 'cancelled', 'cancelling']);

/** The checks as a bar of passed, skipped, failed, running and not run parts, each as wide as its count. */
export function GateSeg(props: {
  passed: number;
  failed: number;
  skipped: number;
  running: number;
  notRun?: number;
  /** Fills the width it is given instead of 40px. */
  grow?: boolean;
}) {
  return (
    <span className="sh-seg" data-grow={props.grow || undefined} aria-hidden="true">
      {props.passed > 0 && <i data-tone="ok" style={{ '--n': props.passed } as CSSProperties} />}
      {props.skipped > 0 && (
        <i data-tone="skip" style={{ '--n': props.skipped } as CSSProperties} />
      )}
      {props.failed > 0 && <i data-tone="bad" style={{ '--n': props.failed } as CSSProperties} />}
      {props.running > 0 && <i data-tone="run" style={{ '--n': props.running } as CSSProperties} />}
      {!!props.notRun && <i data-tone="none" style={{ '--n': props.notRun } as CSSProperties} />}
    </span>
  );
}

/** Whether the session is at work or waiting on the user, as the list preview counts its time. */
const working = (s: WorkbenchSession): boolean =>
  s.stopping || ['starting', 'running', 'waiting', 'merging'].includes(s.state);

/** The session's time so far; only it re-renders as the seconds pass. */
function RunClock({ since }: { since: number }) {
  useSecondTick(true);
  return <span className="sh-clock">{durationText(Date.now() - since)}</span>;
}

/** The session this one was forked from or spawned by, before the title; it opens that session. */
export function parentLink(parent: WorkbenchSession, spawned = false) {
  const title = sessionRow(parent).title;
  return (
    <>
      <button
        type="button"
        className="sh-lead"
        aria-label={
          spawned
            ? t(
                { id: 'sessions.header.spawnedBy', defaultMessage: 'Spawned by {title}' },
                { title },
              )
            : t(
                { id: 'sessions.header.forkedFrom', defaultMessage: 'Forked from {title}' },
                { title },
              )
        }
        onClick={() => useShell.getState().openSession(parent.id)}
      >
        <GitFork className="sh-fork" aria-hidden="true" />
        <span className="sh-cut">{title}</span>
      </button>
      <span className="sh-faint" aria-hidden="true">
        /
      </span>
    </>
  );
}

type Pull = NonNullable<WorkbenchSession['remote_pull']>;

/** Whether the last turn's changes are back from the device; a failed pull can be retried. */
function RemotePull({
  sessionId,
  device,
  pull,
}: {
  sessionId: string;
  device: string;
  pull: Pull;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnect = async () => {
    setBusy(true);
    setError(null);
    const result = await runCommand('session.reconnect', { session_id: sessionId }, null).catch(
      fail,
    );
    setBusy(false);
    if (!result.ok)
      setError(
        result.error.code === 'remote_pull_failed'
          ? result.error.message
          : failureText(result.error),
      );
  };
  const label =
    pull.status === 'failed'
      ? t(
          {
            id: 'sessions.header.pullFailed',
            defaultMessage: 'The changes are still on {device}: {reason}',
          },
          { device, reason: pull.reason },
        )
      : pull.status === 'running'
        ? t({ id: 'sessions.header.pullRunning', defaultMessage: 'Pulling the changes back' })
        : t({ id: 'sessions.header.pullDone', defaultMessage: 'Changes pulled back' });
  const glyph =
    pull.status === 'failed' ? 'failed' : pull.status === 'running' ? 'starting' : 'done';
  return (
    <span className="sh-pull">
      <span aria-hidden="true">
        <StateGlyph name={glyph} />
      </span>
      <span className="sh-pull-text" title={label}>
        {label}
      </span>
      {pull.status === 'failed' && (
        <button
          type="button"
          className="btn sm"
          aria-busy={busy}
          disabled={busy}
          onClick={() => void reconnect()}
        >
          <RefreshCw aria-hidden="true" />
          {t({ id: 'sessions.header.reconnect', defaultMessage: 'Reconnect' })}
        </button>
      )}
      {error && (
        <span className="sh-err" role="alert" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}

/** The failed or interrupted last turn beside the state glyph, its error in the tip. */
function LastTurn({ session }: { session: WorkbenchSession }) {
  const label = lastTurnLabel(session);
  if (!label) return null;
  return (
    <Tip content={turnErrorText(session) ?? label}>
      <span className="sh-mark" tabIndex={0}>
        <LastTurnMark session={session} />
      </span>
    </Tip>
  );
}

/** The session's tokens so far, running turns included, as a read-only row of the more menu. */
function LiveTokens({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const trace = useSessionTrace(projectId, sessionId);
  if (!trace.data && trace.error)
    return (
      <>
        <Tip content={trace.error}>
          <button type="button" className="sh-tok" onClick={trace.reload}>
            {t({
              id: 'sessions.screen.tokensFailed',
              defaultMessage: "Couldn't read tokens; retry",
            })}
          </button>
        </Tip>
        <Menu.Separator className="wmenu-sep" />
      </>
    );
  if (!trace.data) return null;
  const { input, output } = laneStats(trace.data.spans, Date.now()).tokens;
  if (input + output === 0) return null;
  return (
    <>
      <Tip
        content={
          trace.stale
            ? t(
                {
                  id: 'sessions.screen.tokensTipStale',
                  defaultMessage: 'Out of date. Input {input, number}, output {output, number}',
                },
                { input, output },
              )
            : t(
                {
                  id: 'sessions.screen.tokensTip',
                  defaultMessage: 'Input {input, number}, output {output, number}',
                },
                { input, output },
              )
        }
      >
        <span className="sh-tok" tabIndex={0}>
          {trace.stale
            ? t(
                { id: 'sessions.screen.tokensStale', defaultMessage: '{tokens} tokens (old)' },
                { tokens: tokenText(input + output) },
              )
            : t(
                { id: 'sessions.screen.tokens', defaultMessage: '{tokens} tokens' },
                { tokens: tokenText(input + output) },
              )}
        </span>
      </Tip>
      <Menu.Separator className="wmenu-sep" />
    </>
  );
}

type Bridge = NonNullable<typeof window.pantheon>;

const OPEN_ACTIONS: readonly {
  label: string;
  open: (bridge: Bridge, workspace: { id: string; path: string }) => Promise<BridgeResult<unknown>>;
}[] = [
  {
    get label() {
      return t({ id: 'sessions.screen.openInEditor', defaultMessage: 'Open in editor' });
    },
    open: (bridge, w) => bridge.openInEditor(w.id),
  },
  {
    get label() {
      return t({ id: 'sessions.screen.openInTerminal', defaultMessage: 'Open in terminal' });
    },
    open: (bridge, w) => bridge.openInTerminal(w.id),
  },
  {
    get label() {
      return revealText();
    },
    open: (bridge, w) => bridge.revealPath(w.path),
  },
  {
    get label() {
      return t({ id: 'sessions.screen.copyPath', defaultMessage: 'Copy path' });
    },
    open: (_bridge, w) =>
      navigator.clipboard
        .writeText(w.path)
        .then((): BridgeResult<null> => ({ ok: true, value: null })),
  },
];

/** The menu items that open the session's worktree while it exists, whether or not the session ended. */
function OpenItems({
  listed,
  onError,
}: {
  listed: WorkbenchSession | null;
  onError: (error: string | null) => void;
}) {
  const workspace = useBoard(
    (s) => s.board?.workspaces.find((w) => w.id === listed?.workspace_id) ?? null,
  );
  const reason =
    (listed ? worktreeReason(listed, workspace) : null) ??
    (workspace
      ? null
      : t({ id: 'sessions.screen.noWorktree', defaultMessage: 'This session has no worktree' }));
  const run = async (action: (typeof OPEN_ACTIONS)[number]) => {
    const bridge = window.pantheon;
    if (!workspace || !bridge) return;
    onError(null);
    const result = await action.open(bridge, workspace).catch(fail);
    if (!result.ok) onError(failureText(result.error));
  };
  return OPEN_ACTIONS.map((action) =>
    menuEntry({ label: action.label, ...(reason ? { reason } : {}) }, () => void run(action)),
  );
}

/** Opens the session's worktree. */
export function OpenMenu(props: {
  listed: WorkbenchSession | null;
  onError: (error: string | null) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="btn ss-hbtn">
        {t({ id: 'sessions.screen.open', defaultMessage: 'Open' })}
        <ChevronDown aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="mn mn-menu pop">
            <OpenItems {...props} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * Whether the daemon took a checkpoint before the turn: compaction and reflection turns have none,
 * nor a steer injected into a running turn, which never starts running itself.
 */
export const checkpointed = (view: {
  turn: Pick<SessionTurn, 'kind' | 'origin'>;
  started_at: number | null;
}): boolean =>
  view.turn.origin !== 'compaction' &&
  view.turn.origin !== 'reflection' &&
  (view.turn.kind !== 'steer' || view.started_at !== null);

/**
 * The row menu of the session, renaming in the title and discarding with the header's dialogs;
 * without them it uses its own dialogs.
 */
export function MoreMenu(props: {
  session: WorkbenchSession;
  discardable: boolean;
  /** Where the focus goes once the menu closes; rename moves it to the title input. */
  finalFocus?: () => HTMLElement | boolean;
  onRename?: () => void;
  onDiscard?: () => void;
  /** The panel sheet leaves opening the worktree to the Open menu beside it. */
  place?: 'header' | 'sheet';
  /** Read-only rows above the session's items. */
  children?: ReactNode;
  split?: SplitEntry;
}) {
  const { items, error, clearError, dialog, onOpenChange } = useSessionMenu(props.session, {
    rename: props.onRename,
    discard: props.onDiscard,
    discardable: props.discardable,
  });
  const s = props.session;
  const trigger = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<'fork' | 'checkpoint' | null>(null);
  const turns = useThreadTurns(s.id).turns;
  const sent = turns.filter(checkpointed);
  const checkpoint = sent.find((view) => view.turn.id === s.checkpoint_turn_id);
  const busy = s.stopping || ['running', 'merging', 'waiting'].includes(s.state);
  // A running session forks from the end of its last completed turn.
  const forkBusy =
    s.stopping ||
    s.state === 'merging' ||
    (busy && !sent.some((view) => view.turn.state === 'completed' && !view.turn.rolled_back));
  const busyText = () =>
    t({ id: 'sessions.header.busy', defaultMessage: 'Wait until the session stops working' });
  const forkReason = !liveWorktree(s)
    ? t({
        id: 'sessions.header.noFork',
        defaultMessage: 'Only an open worktree session can be forked',
      })
    : forkBusy
      ? busyText()
      : null;
  const checkpointReason = !liveWorktree(s)
    ? t({
        id: 'sessions.header.noCheckpoints',
        defaultMessage: 'Only an open worktree session has checkpoints',
      })
    : busy
      ? busyText()
      : checkpoint
        ? null
        : t({
            id: 'sessions.header.noCheckpointSinceMerge',
            defaultMessage: 'No checkpoint since the last merge',
          });
  const checkpointLabel = t({
    id: 'sessions.header.checkpoint',
    defaultMessage: 'Return to checkpoint',
  });
  const pull =
    useBoard(
      (b) =>
        b.events.findLast((e) => e.kind === 'session.pr_created' && e.aggregate_id === s.id)
          ?.payload as { number: number; url: string } | undefined,
    ) ?? s.pull_request;
  const workspace = useBoard(
    (b) => b.board?.workspaces.find((w) => w.id === s.workspace_id) ?? null,
  );
  // The daemon pushes a pull request only from a worktree on a source branch.
  const createReason =
    (s.workspace_id === null
      ? t({ id: 'sessions.model.worktree.none', defaultMessage: 'This session has no worktree' })
      : worktreeReason(s, workspace)) ??
    (!workspace || s.workspace_kind === 'in_place'
      ? t({ id: 'sessions.model.worktree.none', defaultMessage: 'This session has no worktree' })
      : workspace.source_branch
        ? null
        : t({
            id: 'sessions.model.mergeBlock.detachedHead',
            defaultMessage: 'The source repository is not on a branch',
          }));
  const [pullError, setPullError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const openPull = async (url: string) => {
    clearError();
    const result = await window.pantheon?.openLink(url).catch(fail);
    if (result && !result.ok) setPullError(failureText(result.error));
  };
  const createPull = async () => {
    clearError();
    setPullError(null);
    setCreating(true);
    const result = await runCommand('github.pr.create', { session_id: s.id }, null)
      .catch(fail)
      .finally(() => setCreating(false));
    if (!result.ok) {
      setPullError(failureText(result.error));
      return;
    }
    const created = result.value as { number: number; url: string };
    toast({
      title: t(
        { id: 'sessions.header.pullCreated', defaultMessage: 'Pull request #{number} is open' },
        { number: created.number },
      ),
      action: {
        label: t({ id: 'sessions.header.openPull', defaultMessage: 'Open' }),
        run: () => void openPull(created.url),
      },
    });
  };
  const shownError = error ?? pullError;
  return (
    <>
      <Menu.Root onOpenChange={onOpenChange}>
        <Menu.Trigger
          ref={trigger}
          className="ib"
          aria-label={t({
            id: 'sessions.screen.sessionActions',
            defaultMessage: 'Session actions',
          })}
        >
          <Ellipsis aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
            <Menu.Popup className="mn mn-menu pop" style={FIT_MENU} finalFocus={props.finalFocus}>
              {props.children}
              {props.split &&
                menuEntry(
                  {
                    label: t({
                      id: 'sessions.split.openSession',
                      defaultMessage: 'Open session beside',
                    }),
                    keys: shortcutKeys('session-split') || undefined,
                    ...(props.split.reason ? { reason: props.split.reason } : {}),
                  },
                  props.split.open,
                  `header-split-${props.session.id}`,
                  <Columns2 aria-hidden="true" />,
                )}
              {menuEntry(
                {
                  label: t({ id: 'sessions.header.fork', defaultMessage: 'Fork' }),
                  ...(forkReason ? { reason: forkReason } : {}),
                },
                () => setAsking('fork'),
                `header-fork-${s.id}`,
                <GitFork aria-hidden="true" />,
              )}
              {menuEntry(
                {
                  label: t({ id: 'sessions.thread.find', defaultMessage: 'Search in session' }),
                  keys: shortcutKeys('thread-find') || undefined,
                },
                () => useThreadFind.getState().show(s.id, trigger.current),
                undefined,
                <Search aria-hidden="true" />,
              )}
              {menuEntry(
                {
                  label: checkpointLabel,
                  ...(checkpointReason ? { reason: checkpointReason } : {}),
                },
                () => setAsking('checkpoint'),
                `header-checkpoint-${s.id}`,
                <Undo2 aria-hidden="true" />,
              )}
              {pull
                ? menuEntry(
                    {
                      label: t(
                        {
                          id: 'sessions.header.openPullNumber',
                          defaultMessage: 'Open PR #{number}',
                        },
                        { number: pull.number },
                      ),
                    },
                    () => void openPull(pull.url),
                    undefined,
                    <GitPullRequest aria-hidden="true" />,
                  )
                : menuEntry(
                    {
                      label: t({
                        id: 'sessions.header.createPull',
                        defaultMessage: 'Create pull request',
                      }),
                      // An empty reason turns the entry off without a note.
                      ...(createReason ? { reason: createReason } : creating ? { reason: '' } : {}),
                    },
                    () => void createPull(),
                    `header-pull-${s.id}`,
                    <GitPullRequest aria-hidden="true" />,
                  )}
              <Menu.Separator className="mn-sep" />
              {items(props.place ?? 'header')}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {shownError && (
        <span className="tr-err" role="alert" title={shownError}>
          {shownError}
        </span>
      )}
      {dialog}
      <ForkDialog
        open={asking === 'fork'}
        sessionId={s.id}
        before={null}
        input=""
        attachments={[]}
        skills={[]}
        onClose={() => setAsking(null)}
      />
      {checkpoint && (
        <RollbackDialog
          open={asking === 'checkpoint'}
          rewrite={false}
          copy={{
            title: t(
              {
                id: 'sessions.header.checkpointTitle',
                defaultMessage: 'Return “{title}” to the checkpoint before turn {turn}?',
              },
              { title: sessionRow(s).title, turn: sent.indexOf(checkpoint) + 1 },
            ),
            body: t(
              {
                id: 'sessions.header.checkpointBody',
                defaultMessage:
                  "The worktree's files and commits go back to where they were before turn {turn} began. Every change since then is discarded and can't be restored; the conversation stays as it is.",
              },
              { turn: sent.indexOf(checkpoint) + 1 },
            ),
          }}
          sessionId={s.id}
          turnId={checkpoint.turn.id}
          input=""
          attachments={[]}
          skills={[]}
          onClose={() => setAsking(null)}
        />
      )}
    </>
  );
}
