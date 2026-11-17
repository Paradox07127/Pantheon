import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import {
  AppWindow,
  ArrowUp,
  Check,
  ChevronRight,
  FileText,
  Flag,
  Folder,
  List,
  Mic,
  Plus,
  Route,
  Square,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { RuntimeStatus, WorkbenchSession } from '@pantheon/protocol';
import { Equalizer } from '../../components/Equalizer';
import { runtimeName } from '../../components/RuntimeGlyph';
import { KeyHint } from '../../components/Shortcuts';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import {
  draftKey,
  EMPTY_DRAFT,
  githubRefKey,
  useDrafts,
  whenUploaded,
  type Draft,
  type GithubRef,
  type SkillRef,
} from '../../data/drafts';
import { useFeedback, withFeedback, type FeedbackItem } from '../../data/feedback';
import { failureText } from '../../data/needs-you';
import { useBackends } from '../../data/backends';
import { getLook } from '../../data/layout';
import { useConnectors, useRuntimeModels, useSkills } from '../../data/runtime-models';
import { offeredRuntimes, supports, useRuntimeStatus } from '../../data/runtime-status';
import { useSessionDisplay } from '../../data/session-display';
import type { Session, SessionTurn, TurnView } from '../../data/transcript';
import { insertVoiceText, useVoice } from '../../data/voice';
import { t } from '../../i18n';
import { durationText } from '../../lib/time-text';
import { keyText, onMac, shortcutKeys, shortcutMatches, useShortcut } from '../../lib/shortcuts';
import { useShell } from '../../store';
import { useSettingsView } from '../settings/view';
import { GithubRefMenu, markSend, MAX_REFS, sessionRefMenu, WindowSnapshots } from './attachments';
import { ContextBreakdown } from './ContextBreakdown';
import {
  defaultModelFor,
  defaultPermissionMode,
  endedText,
  modelPermissionModes,
  permissionModes,
  turnStatus,
  type TurnStatus,
} from './model';
import {
  AttachmentStrip,
  CompletionPopup,
  ModelMenu,
  SendButton,
  useAttachments,
  useCompletion,
  useCompose,
  usePickedSkills,
  useQueued,
  type ModelChoice,
} from './parts';
import { commentSent, refsInput, type ComposeNotice } from './compose';
import { QueueDock } from './QueueDock';
import { contextRing } from './run-model';
import { fail, FIT_MENU, NO_FEEDBACK, ON, useFileInput, useSecondTick } from './shared';
import { statusTicks, turnStatusLabel } from './thread-model';
import { VoiceBar } from './VoiceBar';
import './compose.css';

/** How long a turn runs before the status line shows. */
const STATUS_DELAY_MS = 1_000;

const NO_SESSIONS: readonly WorkbenchSession[] = [];
const NO_GITHUB: readonly GithubRef[] = [];
const NO_TURNS: readonly SessionTurn[] = [];

/** The stored comments of the draft and of the attached items, each once. */
function carriedComments(
  drafted: NonNullable<Draft['comments']>,
  carried: readonly FeedbackItem[],
) {
  const all = [...drafted, ...carried.flatMap((item) => (item.comment ? [item.comment] : []))];
  return all.filter((c, i) => all.findIndex((o) => o.id === c.id) === i);
}

/** What the waiting approval would do, with its target set apart wherever the language puts it. */
function askText(tool: string, detail: string) {
  const at = '\u0000';
  const [before, after] = (
    ['Bash', 'commandExecution', 'local_shell_call', 'shell'].includes(tool)
      ? t(
          { id: 'sessions.composeDock.askRun', defaultMessage: 'Wants to run {command}' },
          { command: at },
        )
      : ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'fileChange'].includes(tool)
        ? t(
            { id: 'sessions.composeDock.askEdit', defaultMessage: 'Wants to edit {file}' },
            { file: at },
          )
        : tool === 'Read'
          ? t(
              { id: 'sessions.composeDock.askRead', defaultMessage: 'Wants to read {file}' },
              { file: at },
            )
          : t(
              {
                id: 'sessions.composeDock.askTool',
                defaultMessage: 'Wants to use {tool}: {target}',
              },
              { tool, target: at },
            )
  ).split(at);
  return (
    <>
      {before}
      <span className="cp-sti">{detail}</span>
      {after}
    </>
  );
}

/**
 * The line above the box while a turn runs or waits for you: what the turn does, or what Esc did,
 * and the keys that act on the turn now.
 */
function ComposeStatus(props: {
  status: TurnStatus | null;
  notice: ComposeNotice;
  steer: boolean;
  stop: boolean;
}) {
  const { status, notice } = props;
  const steerFirst = useSessionDisplay().running_send === 'steer';
  const ticking = notice === null && status !== null && statusTicks(status.kind);
  const retryAt = notice === null ? (status?.retry?.at ?? null) : null;
  useSecondTick(ticking || retryAt !== null);
  const waiting =
    status?.kind === 'approval' || status?.kind === 'question' || status?.kind === 'retrying';
  const shown = notice === null ? status : null;
  const agents = shown?.agents;
  // What the turn has done so far: no total is known but the subagents'.
  const done = [
    retryAt !== null
      ? t(
          {
            id: 'sessions.compose.retryIn',
            defaultMessage:
              '{seconds, plural, one {Retrying in # second} other {Retrying in # seconds}}',
          },
          { seconds: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) },
        )
      : null,
    agents ? `${agents.done} / ${agents.total}` : null,
    ticking && shown && shown.since !== null ? durationText(Date.now() - shown.since) : null,
    shown?.steps
      ? t(
          {
            id: 'sessions.composeDock.steps',
            defaultMessage: '{count, plural, one {# step} other {# steps}}',
          },
          { count: shown.steps },
        )
      : null,
  ].filter((part) => part !== null);
  // The Esc key sits inside the sentence, wherever the language puts it.
  const [beforeKey, afterKey] = t(
    { id: 'sessions.compose.escAgain', defaultMessage: 'Press {key} again to interrupt' },
    { key: '\u0000' },
  ).split('\u0000');
  const text =
    notice === 'armed' ? (
      <>
        {beforeKey}
        <span className="kbd">Esc</span>
        {afterKey}
      </>
    ) : notice === 'interrupted' ? (
      t({ id: 'sessions.compose.interrupted', defaultMessage: 'Interrupted; changes kept' })
    ) : shown?.ask ? (
      askText(shown.ask.tool, shown.ask.detail)
    ) : status?.kind === 'approval' ? (
      t({
        id: 'sessions.compose.approval',
        defaultMessage: 'Continues after your approval',
      })
    ) : shown?.kind === 'agents' ? (
      t({ id: 'sessions.composeDock.agents', defaultMessage: 'Waiting for agents' })
    ) : (
      shown && (shown.line || turnStatusLabel(shown))
    );
  const kind =
    notice === 'interrupted'
      ? 'idle'
      : waiting || notice
        ? 'waiting'
        : ticking || status?.kind === 'compacting'
          ? 'running'
          : status?.kind;
  return (
    <div className="cp-st">
      <span className="cp-stg" data-kind={kind} aria-hidden="true">
        {kind === 'running' && <Equalizer />}
      </span>
      <span className="cp-stt">{text}</span>
      {shown?.line && <span className="cp-crt" aria-hidden="true" />}
      {agents && (
        <span className="cp-sgb" aria-hidden="true">
          {Array.from({ length: agents.total }, (_, i) => (
            <i key={i} data-done={i < agents.done || undefined} />
          ))}
        </span>
      )}
      {done.length > 0 && (
        <span className="cp-stn">
          {done.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      )}
      {notice === null && (props.steer || props.stop) && (
        <span className="cp-stk hk" aria-hidden="true">
          {props.steer && (
            <span>
              <span className="kbd">{keyText('Meta+Enter')}</span>
              {steerFirst
                ? t({ id: 'sessions.composer.queue', defaultMessage: 'Queue' })
                : t({ id: 'sessions.composer.steer', defaultMessage: 'Steer' })}
            </span>
          )}
          {props.stop && (
            <span>
              <KeyHint id="stop-turn" />
              {t({ id: 'sessions.compose.interruptKey', defaultMessage: 'Interrupt' })}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/** A 16px ring of the context window with its share, opening what fills the window; nothing without a context window. */
function ContextRing({
  usage,
  compacting,
  ...head
}: {
  usage: unknown;
  compacting: boolean;
  runtime: string;
  model: string | null;
  quota: RuntimeStatus['quota'];
}) {
  const ring = contextRing(usage);
  if (ring.tone === 'none') return null;
  return (
    <Popover.Root>
      <Popover.Trigger
        className="cp-ring"
        data-tone={ring.tone}
        aria-label={t(
          { id: 'sessions.run.context.share', defaultMessage: 'Context {share}' },
          { share: ring.text },
        )}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          className={compacting ? 'si-spin' : undefined}
          aria-hidden="true"
        >
          <circle className="cp-rgt" cx="8" cy="8" r="6.5" />
          {ring.sweep > 0 && (
            <circle
              className="cp-rgf"
              cx="8"
              cy="8"
              r="6.5"
              pathLength={100}
              strokeDasharray={`${ring.sweep * 100} 100`}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
        <span aria-hidden="true">{ring.text}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} style={{ zIndex: 40 }}>
          <Popover.Popup className="pop cp-cxp" style={FIT_MENU}>
            <ContextBreakdown usage={usage} {...head} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SessionCompose({
  session,
  listed,
  title,
  usage = null,
  running = null,
  waiting = null,
  active = true,
  sessions = NO_SESSIONS,
  asks = null,
}: {
  session: Session;
  /** Shown on top of the composer: the way to the thread's unanswered questions. */
  asks?: ReactNode;
  listed: WorkbenchSession | null;
  title: string;
  /** The project's open sessions, offered for the message to refer to. */
  sessions?: readonly WorkbenchSession[];
  /** The newest agent.usage.updated payload of the session's turns. */
  usage?: unknown;
  /** The session's running turn. */
  running?: TurnView | null;
  /** What a request of the session waits for. */
  waiting?: 'approval' | 'question' | null;
  /** Whether the window's keys act on this composer; false in the pane that is not current. */
  active?: boolean;
}) {
  const key = draftKey(session.project_id, session.id);
  const attachments = useAttachments(session.project_id, key);
  const skills = usePickedSkills(key);
  const refs = useDrafts((s) => s.drafts[key]?.refs) ?? NO_SESSIONS;
  // A referenced session as the list shows it now.
  const referred = refs.map((r) => sessions.find((s) => s.id === r.id) ?? r);
  const refer = (s: WorkbenchSession) =>
    useDrafts
      .getState()
      .update(key, (draft) =>
        draft.refs.some((r) => r.id === s.id) || draft.refs.length + draft.github.length >= MAX_REFS
          ? {}
          : { refs: [...draft.refs, s] },
      );
  const unrefer = (id: string) =>
    useDrafts.getState().update(key, (draft) => ({ refs: draft.refs.filter((r) => r.id !== id) }));
  const github = useDrafts((s) => s.drafts[key]?.github) ?? NO_GITHUB;
  const referGithub = (ref: GithubRef) =>
    useDrafts
      .getState()
      .update(key, (draft) =>
        draft.github.some((r) => githubRefKey(r) === githubRefKey(ref)) ||
        draft.refs.length + draft.github.length >= MAX_REFS
          ? {}
          : { github: [...draft.github, ref] },
      );
  const unreferGithub = (ref: GithubRef) =>
    useDrafts.getState().update(key, (draft) => ({
      github: draft.github.filter((r) => githubRefKey(r) !== githubRefKey(ref)),
    }));
  const attachedItems = useFeedback((s) => s.items[session.id]) ?? NO_FEEDBACK;
  const mentions = useDrafts((s) => s.drafts[key]?.mentions) ?? NO_FEEDBACK;
  // What the next message carries besides its text: the attached items, then the referred files.
  const feedback = mentions.length ? [...attachedItems, ...mentions] : attachedItems;
  const clearFeedback = (ids: readonly string[]) => useFeedback.getState().clear(session.id, ids);
  const removeFeedback = (id: string) =>
    mentions.some((m) => m.id === id)
      ? useDrafts
          .getState()
          .update(key, (draft) => ({ mentions: draft.mentions?.filter((m) => m.id !== id) }))
      : useFeedback.getState().remove(session.id, id);
  const box = useRef<HTMLTextAreaElement>(null);
  const runtime = listed?.runtime ?? session.runtime;
  const runtimeStatus = useRuntimeStatus('writer');
  const report =
    runtimeStatus.read.state === 'ready'
      ? runtimeStatus.read.statuses.find((s) => s.runtime === runtime)
      : undefined;
  const compaction =
    report && supports(report, 'manual_compaction')
      ? { runtime, instructions: supports(report, 'compaction_instructions') }
      : null;
  const {
    input,
    change,
    busy,
    error,
    setError,
    sending,
    notice,
    state,
    empty,
    submit,
    interrupt,
    interruptible,
    onKeyDown,
  } = useCompose(
    session,
    skills,
    { items: feedback, clear: clearFeedback },
    box,
    () => void enqueue(),
    compaction,
  );
  const send = state.send.enabled;
  const display = useSessionDisplay();
  const steerFirst = display.running_send === 'steer';
  const stop = !send && empty && interruptible;
  const status = session.state === 'running' && running ? turnStatus(running, waiting) : null;
  // A turn without a known start shows its status at once.
  const statusFrom =
    status !== null && status.kind !== 'ended'
      ? (running?.started_at ?? running?.at ?? 0) + STATUS_DELAY_MS
      : null;
  const [, recheck] = useState(0);
  useEffect(() => {
    if (statusFrom === null || statusFrom <= Date.now()) return;
    const timer = setTimeout(() => recheck((n) => n + 1), statusFrom - Date.now());
    return () => clearTimeout(timer);
  }, [statusFrom]);
  const statusShown = notice !== null || (statusFrom !== null && statusFrom <= Date.now());
  const ended = endedText(listed);
  const attachable = ended === null;
  const [modeError, setModeError] = useState<string | null>(null);
  // A file picked or a message sent clears an older mode or backend error, so what it reports shows.
  useEffect(() => {
    if (busy !== null) setModeError(null);
  }, [busy]);
  const files = useFileInput(
    {
      addFiles: (list) => {
        setModeError(null);
        return attachments.addFiles(list);
      },
      addText: (text) => {
        setModeError(null);
        return attachments.addText(text);
      },
    },
    attachable,
  );
  // Window snapshots ask for macOS screen recording access, so they are offered only there.
  const snapshottable = attachable && onMac() && !!window.pantheon;
  const [snapshots, setSnapshots] = useState(false);
  // A model of another runtime: the next message opens a new session on it.
  const [handoff, setHandoff] = useState<ModelChoice | null>(null);
  const completion = useCompletion({
    project_id: session.project_id,
    session_id: session.id,
    runtime,
    // A handoff's message goes to the other runtime, so it takes that runtime's skills.
    skillsOf: handoff?.runtime,
    text: input,
    onText: change,
    onSkill: skills.add,
    box,
    compactable: compaction !== null,
  });
  const runtimes = offeredRuntimes(runtimeStatus.read, [runtime]);
  const inPlace = listed?.workspace_kind === 'in_place';
  // The daemon forks only a worktree session, and a running one only from a turn that completed.
  const completedTurn = useBoard((s) =>
    (s.board?.session_turns ?? NO_TURNS).some(
      (turn) =>
        turn.session_id === session.id &&
        turn.kind === 'send' &&
        turn.state === 'completed' &&
        !turn.rolled_back,
    ),
  );
  const unforkable = inPlace
    ? t({
        id: 'sessions.compose.handoffInPlace',
        defaultMessage: 'Only a worktree session can switch runtime',
      })
    : session.state === 'running' && !completedTurn
      ? t({
          id: 'sessions.compose.handoffFirstTurn',
          defaultMessage: 'Can switch once the first turn ends',
        })
      : null;
  const unavailable = {
    ...(unforkable === null
      ? {}
      : Object.fromEntries(runtimes.filter((r) => r !== runtime).map((r) => [r, unforkable]))),
    ...Object.fromEntries(
      Object.entries(runtimeStatus.unavailable).filter(([other]) => other !== runtime),
    ),
  };
  const models = useRuntimeModels(session.project_id, runtimes);
  const skillCount = useSkills(session.project_id, handoff?.runtime ?? runtime).length;
  const connectors = useConnectors(session.project_id, runtime);
  // Without its own list the session uses every connector the project turned on.
  const connected = listed?.enabled_user_connectors ?? connectors.map((c) => c.name);
  const backends = useBackends();
  const [switching, setSwitching] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  // The mode plan mode was turned on from, which turning it off goes back to.
  const beforePlan = useRef<WorkbenchSession['permission_mode'] | null>(null);
  // The session the composer shows; a fork answered after a switch leaves the view alone.
  const shown = useRef<string | null>(session.id);
  useEffect(() => {
    shown.current = session.id;
    return () => {
      shown.current = null;
    };
  }, [session.id]);
  const writable = state.send.enabled || state.steer.enabled;
  // Where the caret goes once the box shows text the add menu put in.
  const caretTo = useRef<number | null>(null);
  useEffect(() => {
    const to = caretTo.current;
    caretTo.current = null;
    if (to !== null) box.current?.setSelectionRange(to, to);
  }, [input]);
  const voice = useVoice((text) => {
    const el = box.current;
    const next = insertVoiceText(
      input,
      text,
      el ? { start: el.selectionStart, end: el.selectionEnd } : null,
    );
    caretTo.current = next.caret;
    change(next.value);
    el?.focus();
  });
  // ⌘U opens the add menu, which takes files, references and commands.
  const [adding, setAdding] = useState(false);
  useShortcut(
    'attach',
    () => setAdding(true),
    active && (attachable || writable) && voice.state.phase === 'idle',
  );

  /** Puts the trigger of a completion into the box, which opens its options. */
  function begin(text: string, caret: number) {
    caretTo.current = caret;
    change(text);
    completion.moved(caret);
  }

  async function switchMode(permission_mode: WorkbenchSession['permission_mode']) {
    setSwitching(true);
    setModeError(null);
    const result = await runCommand(
      'session.setPermissionMode',
      { session_id: session.id, permission_mode },
      session.revision,
    ).catch(fail);
    setSwitching(false);
    if (!result.ok) setModeError(failureText(result.error));
  }

  async function switchConnector(name: string, on: boolean) {
    setConnecting(true);
    setModeError(null);
    const rest = connected.filter((n) => n !== name);
    const result = await runCommand(
      'session.setConnectors',
      { session_id: session.id, enabled: on ? [...rest, name] : rest },
      session.revision,
    ).catch(fail);
    setConnecting(false);
    if (!result.ok) setModeError(failureText(result.error));
  }

  /** Turns fast mode on or off; answers with why it was refused, else null. */
  async function switchFast(fast: boolean): Promise<string | null> {
    const result = await runCommand(
      'session.setFastMode',
      { session_id: session.id, fast },
      session.revision,
    ).catch(fail);
    return result.ok ? null : failureText(result.error);
  }

  /** Turns ultracode on or off; answers with why it was refused, else null. */
  async function switchUltracode(ultracode: boolean): Promise<string | null> {
    const result = await runCommand(
      'session.setUltracode',
      { session_id: session.id, ultracode },
      session.revision,
    ).catch(fail);
    return result.ok ? null : failureText(result.error);
  }

  async function switchBackend(next: ModelChoice) {
    setSwitching(true);
    setModeError(null);
    const result = await runCommand(
      'session.setBackend',
      {
        session_id: session.id,
        backend: next.backend,
        ...(next.model !== null ? { model: next.model } : {}),
        ...(next.effort ? { effort: next.effort } : {}),
      },
      session.revision,
    ).catch(fail);
    setSwitching(false);
    if (!result.ok) setModeError(failureText(result.error));
  }

  async function switchModel(next: ModelChoice) {
    if (next.backend !== (listed?.backend_id ?? null)) return switchBackend(next);
    // session.setModel needs a model; the runtime default cannot be chosen again.
    if (next.model === null) return;
    setSwitching(true);
    setModeError(null);
    const result = await runCommand(
      'session.setModel',
      {
        session_id: session.id,
        model: next.model,
        ...(next.effort ? { effort: next.effort } : {}),
      },
      session.revision,
    ).catch(fail);
    setSwitching(false);
    if (!result.ok) setModeError(failureText(result.error));
  }

  function choose(next: ModelChoice) {
    setForkError(null);
    if (next.runtime !== runtime) return setHandoff(next);
    // Back on the session's runtime: the switch is off and the session keeps its model.
    if (handoff) return setHandoff(null);
    void switchModel(next);
  }

  /** The names of the skills a message sent with text took off; one the newer text names stays. */
  function spentSkills(text: string, picked: readonly SkillRef[]) {
    const now = (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).text;
    const named = skills.inText(now === text ? '' : now).map((skill) => skill.name);
    return picked.filter((skill) => !named.includes(skill.name)).map((skill) => skill.name);
  }

  /** Opens a new session on the handoff's model with the message, then shows it. */
  async function fork(to: ModelChoice) {
    if (forking || empty) return;
    setForking(true);
    setForkError(null);
    setModeError(null);
    const text = input;
    const carried = feedback;
    // What the message carries is taken with its text; what is added while it waits is the next one's.
    const {
      refs: carriedRefs,
      github: carriedGithub,
      comments: drafted = [],
      mentions: carriedMentions = [],
    } = useDrafts.getState().drafts[key] ?? EMPTY_DRAFT;
    const picked = skills.inText(text);
    const files = markSend(key);
    if (useDrafts.getState().drafts[key]?.uploading) await whenUploaded(key);
    const failed = files.failure();
    if (failed) {
      setForking(false);
      return setForkError(failed);
    }
    const ids = files.ids();
    const comments = carriedComments(drafted, carried);
    const result = await runCommand(
      'session.fork',
      {
        session_id: session.id,
        runtime: to.runtime,
        ...(to.model !== null ? { model: to.model } : {}),
        ...(to.effort ? { effort: to.effort } : {}),
        input: withFeedback(text, carried),
        ...(ids.length ? { attachments: ids } : {}),
        ...(picked.length ? { skills: picked } : {}),
        ...refsInput(carriedRefs, carriedGithub),
      },
      // The fork is a new session; the source's revision would be refused.
      null,
    ).catch(fail);
    setForking(false);
    if (!result.ok) return setForkError(failureText(result.error));
    useDrafts.getState().sent(key, {
      text,
      attachments: ids,
      skills: spentSkills(text, picked),
      refs: carriedRefs.map((r) => r.id),
      github: carriedGithub.map(githubRefKey),
      comments: drafted.map((c) => c.id),
      mentions: carriedMentions.map((m) => m.id),
    });
    // An item taken off and attached again while the fork was on its way stays.
    const attached = useFeedback.getState().items[session.id] ?? [];
    clearFeedback(carried.filter((item) => attached.includes(item)).map((item) => item.id));
    for (const comment of comments) void commentSent(comment);
    setHandoff(null);
    const id = (result.value as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && shown.current === session.id) useShell.getState().openSession(id);
  }

  async function enqueue() {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    setModeError(null);
    const text = input;
    const carried = feedback;
    const {
      refs: carriedRefs,
      github: carriedGithub,
      comments: drafted = [],
      mentions: carriedMentions = [],
    } = useDrafts.getState().drafts[key] ?? EMPTY_DRAFT;
    const picked = skills.inText(text);
    const files = markSend(key);
    if (useDrafts.getState().drafts[key]?.uploading) await whenUploaded(key);
    sending.current = false;
    const failed = files.failure();
    if (failed) return setError(failed);
    const all = (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).attachments;
    const ids = files.ids();
    const comments = carriedComments(drafted, carried);
    useQueued.getState().add(session.id, {
      text: withFeedback(text, carried),
      attachments: all.filter((a) => ids.includes(a.id)),
      skills: picked,
      ...(carriedRefs.length ? { refs: carriedRefs } : {}),
      ...(carriedGithub.length ? { github: carriedGithub } : {}),
      ...(comments.length ? { comments } : {}),
    });
    useDrafts.getState().sent(key, {
      text,
      attachments: ids,
      skills: spentSkills(text, picked),
      refs: carriedRefs.map((r) => r.id),
      github: carriedGithub.map(githubRefKey),
      comments: drafted.map((c) => c.id),
      mentions: carriedMentions.map((m) => m.id),
    });
    const attached = useFeedback.getState().items[session.id] ?? [];
    clearFeedback(carried.filter((item) => attached.includes(item)).map((item) => item.id));
  }

  useShortcut(
    'permission-mode',
    () => {
      if (!listed || ended !== null || switching) return;
      const own = models[listed.runtime];
      const offered = modelPermissionModes(
        listed.runtime,
        own?.state === 'ready' ? defaultModelFor(own.models, listed.model ?? undefined) : null,
      );
      // A session without a workspace is read-only: it only asks or plans.
      const modes: WorkbenchSession['permission_mode'][] =
        listed.workspace_id !== null ? offered : offered.includes('plan') ? ['ask', 'plan'] : [];
      if (modes.length === 0) return;
      const at = modes.indexOf(listed.permission_mode);
      void switchMode(modes[(at + 1) % modes.length]!);
    },
    active,
  );

  const plannable =
    ended === null && permissionModes(runtime).some((mode) => mode.value === 'plan');
  const planning = listed?.permission_mode === 'plan';
  function plan(on: boolean) {
    if (!listed || switching) return;
    if (on) beforePlan.current = listed.permission_mode;
    const back = beforePlan.current;
    void switchMode(
      on
        ? 'plan'
        : back && back !== 'plan'
          ? back
          : listed.workspace_id === null
            ? 'ask'
            : defaultPermissionMode(runtime),
    );
  }

  const shownError = modeError ?? error ?? attachments.error;
  const mention = () => {
    const lead = input === '' || /\s$/.test(input) ? input : `${input} `;
    begin(`${lead}@`, lead.length + 1);
  };
  // A command is completed only at the start of the message.
  const command = () => begin(input.trim() === '' ? '/' : `/ ${input}`, 1);
  const connect = () => {
    useSettingsView.getState().setPage('connections');
    useShell.getState().openSettings(null);
  };
  return (
    <div className="cp-dock" data-debug-region="sessions.composer">
      <div className="cp-col">
        <div className="cp-sts">
          {statusShown && (
            <ComposeStatus
              status={status}
              notice={notice}
              steer={!send && state.steer.enabled && getLook().send_key !== 'meta-enter'}
              stop={interruptible}
            />
          )}
        </div>
        {handoff && (
          <div className="cp-fork">
            <TriangleAlert className="cp-fork-i" aria-hidden="true" />
            <span className="cp-fork-t">
              {t(
                {
                  id: 'sessions.compose.handoff',
                  defaultMessage:
                    'Switching to {runtime} opens a new session with only a text handoff',
                },
                { runtime: runtimeName(handoff.runtime) },
              )}
            </span>
            {forkError && (
              <span className="cp-fork-err" role="alert" title={forkError}>
                {forkError}
              </span>
            )}
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setHandoff(null);
                setForkError(null);
              }}
            >
              {t({ id: 'sessions.compose.handoffCancel', defaultMessage: 'Cancel' })}
            </button>
          </div>
        )}
        {asks}
        <div className="cp-stack">
          <QueueDock session={session} />
          <div className="cp-box" {...files.box}>
            <AttachmentStrip
              items={attachments.items}
              pending={attachments.pending}
              onRemove={attachments.remove}
              onRetry={(id) => void attachments.retry(id)}
              feedback={feedback}
              onRemoveFeedback={removeFeedback}
              refs={referred}
              onRemoveRef={unrefer}
              github={github}
              onRemoveGithub={unreferGithub}
            />
            <CompletionPopup
              id={completion.id}
              items={completion.items}
              active={completion.active}
              onPick={completion.pick}
            />
            <textarea
              {...completion.textarea}
              rows={2}
              spellCheck
              aria-label={t(
                { id: 'sessions.composer.sendTo', defaultMessage: 'Message to {title}' },
                { title },
              )}
              placeholder={
                ended ??
                (send
                  ? t({ id: 'sessions.composer.reply', defaultMessage: 'Reply…' })
                  : waiting === 'approval'
                    ? t({
                        id: 'sessions.composeDock.approvalPlaceholder',
                        defaultMessage: 'Add a requirement, or answer the approval',
                      })
                    : steerFirst
                      ? t({
                          id: 'sessions.composer.steerTurnPlaceholder',
                          defaultMessage: 'Steer the running turn…',
                        })
                      : t({
                          id: 'sessions.composeDock.queuePlaceholder',
                          defaultMessage: 'Queue, until this turn ends',
                        }))
              }
              value={input}
              disabled={!writable}
              onChange={(e) => {
                change(e.target.value);
                completion.moved(e.target.selectionStart ?? e.target.value.length);
              }}
              onPaste={files.onPaste}
              onKeyDown={(e) => {
                if (completion.onKeyDown(e)) return;
                if (
                  handoff &&
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  (getLook().send_key !== 'meta-enter' || shortcutMatches('send', e))
                ) {
                  e.preventDefault();
                  void fork(handoff);
                  return;
                }
                onKeyDown(e);
              }}
            />
            {voice.state.phase !== 'idle' ? (
              <VoiceBar
                state={voice.state}
                slow={voice.slow}
                now={Date.now()}
                onStop={voice.stop}
                onCancel={voice.cancel}
                onRetry={voice.retry}
                onOpenSettings={() => void voice.openSettings()}
              />
            ) : (
              <div className="cp-row">
                {(attachable || writable) && (
                  <Menu.Root open={adding} onOpenChange={(next) => setAdding(next)}>
                    <Menu.Trigger
                      className="cp-add"
                      aria-label={t({
                        id: 'sessions.composer.addMenu',
                        defaultMessage: 'Add, reference, command',
                      })}
                      aria-keyshortcuts={shortcutKeys('attach') || undefined}
                    >
                      <Plus aria-hidden="true" />
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner
                        side="top"
                        align="start"
                        sideOffset={4}
                        style={{ zIndex: 40 }}
                      >
                        <Menu.Popup className="pop cp-am" finalFocus={box}>
                          {attachable && (
                            <Menu.Group className="cp-amg">
                              <Menu.GroupLabel className="cp-cap">
                                {t({ id: 'sessions.composer.addGroup', defaultMessage: 'Add' })}
                              </Menu.GroupLabel>
                              <Menu.Item
                                className="cp-mi"
                                onClick={() => {
                                  setModeError(null);
                                  void attachments.choose();
                                }}
                              >
                                <FileText className="cp-mic" aria-hidden="true" />
                                <span className="cp-mil">
                                  {t({
                                    id: 'sessions.composer.addFile',
                                    defaultMessage: 'File or image',
                                  })}
                                </span>
                              </Menu.Item>
                              {snapshottable && (
                                <Menu.Item className="cp-mi" onClick={() => setSnapshots(true)}>
                                  <AppWindow className="cp-mic" aria-hidden="true" />
                                  <span className="cp-mil">
                                    {t({
                                      id: 'sessions.composer.addWindowSnapshot',
                                      defaultMessage: 'App window snapshot',
                                    })}
                                  </span>
                                </Menu.Item>
                              )}
                            </Menu.Group>
                          )}
                          {writable && (
                            <>
                              <Menu.Group className="cp-amg">
                                <Menu.GroupLabel className="cp-cap">
                                  {t({
                                    id: 'sessions.composer.referenceGroup',
                                    defaultMessage: 'Reference',
                                  })}
                                </Menu.GroupLabel>
                                <Menu.Item className="cp-mi" onClick={mention}>
                                  <Folder className="cp-mic" aria-hidden="true" />
                                  <span className="cp-mil">
                                    {t({
                                      id: 'sessions.composer.mentionFile',
                                      defaultMessage: 'File',
                                    })}
                                  </span>
                                  <span className="kbd" aria-hidden="true">
                                    @
                                  </span>
                                </Menu.Item>
                                {sessionRefMenu({
                                  sessions: sessions.filter((s) => s.id !== session.id),
                                  refs,
                                  full: refs.length + github.length >= MAX_REFS,
                                  onRefer: refer,
                                  finalFocus: box,
                                })}
                                {(['pr', 'issue'] as const).map((kind) => (
                                  <GithubRefMenu
                                    key={kind}
                                    kind={kind}
                                    project_id={session.project_id}
                                    refs={github}
                                    full={refs.length + github.length >= MAX_REFS}
                                    onRefer={referGithub}
                                    onConnect={connect}
                                    finalFocus={box}
                                  />
                                ))}
                              </Menu.Group>
                              <Menu.Group className="cp-amg">
                                <Menu.GroupLabel className="cp-cap">
                                  {t({
                                    id: 'sessions.composer.abilityGroup',
                                    defaultMessage: 'Capabilities',
                                  })}
                                </Menu.GroupLabel>
                                <Menu.Item className="cp-mi" onClick={command}>
                                  <Zap className="cp-mic" aria-hidden="true" />
                                  <span className="cp-mil">
                                    {t({
                                      id: 'sessions.composer.command',
                                      defaultMessage: 'Command',
                                    })}
                                  </span>
                                  <span className="kbd" aria-hidden="true">
                                    /
                                  </span>
                                </Menu.Item>
                                {skillCount > 0 && (
                                  <Menu.Item className="cp-mi" onClick={command}>
                                    <Flag className="cp-mic" aria-hidden="true" />
                                    <span className="cp-mil">
                                      {t({
                                        id: 'sessions.composeDock.skills',
                                        defaultMessage: 'Skills',
                                      })}
                                    </span>
                                    <span className="cp-ct">{skillCount}</span>
                                  </Menu.Item>
                                )}
                                {attachable && connectors.length > 0 && (
                                  <Menu.SubmenuRoot>
                                    <Menu.SubmenuTrigger className="cp-mi">
                                      <Route className="cp-mic" aria-hidden="true" />
                                      <span className="cp-mil">
                                        {t({
                                          id: 'sessions.composer.connectors',
                                          defaultMessage: 'Connectors',
                                        })}
                                      </span>
                                      <ChevronRight className="cp-mic" aria-hidden="true" />
                                    </Menu.SubmenuTrigger>
                                    <Menu.Portal>
                                      <Menu.Positioner sideOffset={4} style={{ zIndex: 40 }}>
                                        <Menu.Popup className="pop cp-am" finalFocus={box}>
                                          {connectors.map((c) => (
                                            <Menu.CheckboxItem
                                              key={c.name}
                                              className="cp-mi"
                                              checked={connected.includes(c.name)}
                                              disabled={connecting}
                                              onCheckedChange={(on) =>
                                                void switchConnector(c.name, on)
                                              }
                                            >
                                              <span className="cp-mil">{c.title ?? c.name}</span>
                                              <Menu.CheckboxItemIndicator className="cp-ck">
                                                <Check aria-hidden="true" />
                                              </Menu.CheckboxItemIndicator>
                                            </Menu.CheckboxItem>
                                          ))}
                                        </Menu.Popup>
                                      </Menu.Positioner>
                                    </Menu.Portal>
                                  </Menu.SubmenuRoot>
                                )}
                              </Menu.Group>
                            </>
                          )}
                          {plannable && (
                            <>
                              <Menu.Separator className="cp-sep" />
                              <Menu.CheckboxItem
                                className="cp-mi cp-plan"
                                checked={planning}
                                disabled={switching}
                                onCheckedChange={plan}
                              >
                                <List className="cp-mic" aria-hidden="true" />
                                <span className="cp-mil">
                                  {t({
                                    id: 'sessions.composeDock.planMode',
                                    defaultMessage: 'Plan mode',
                                  })}
                                </span>
                                <Menu.CheckboxItemIndicator className="cp-ck">
                                  <Check aria-hidden="true" />
                                </Menu.CheckboxItemIndicator>
                              </Menu.CheckboxItem>
                            </>
                          )}
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                )}
                {snapshottable && (
                  <WindowSnapshots
                    open={snapshots}
                    anchor={box}
                    onOpenChange={setSnapshots}
                    onPick={(id) => {
                      setSnapshots(false);
                      setModeError(null);
                      void attachments.snapshot(id);
                    }}
                  />
                )}
                <ModelMenu
                  runtimes={runtimes}
                  unavailable={unavailable}
                  disconnected={runtimeStatus.disconnected}
                  models={models}
                  value={
                    handoff ?? {
                      runtime,
                      backend: listed?.backend_id ?? null,
                      model: listed?.model ?? null,
                      effort: listed?.effort ?? null,
                    }
                  }
                  // session.fork takes no backend.
                  backends={handoff ? [] : backends}
                  backendLocked={
                    inPlace
                      ? t({
                          id: 'sessions.compose.backendInPlace',
                          defaultMessage: 'A session in your folder keeps its backend',
                        })
                      : undefined
                  }
                  disabled={ended !== null || !listed?.workspace_id || switching || forking}
                  onChange={choose}
                  // The fork takes the source's mode, so the target's menu offers none to change.
                  mode={listed?.workspace_id && !handoff ? listed.permission_mode : null}
                  onMode={(mode) => void switchMode(mode)}
                  fast={handoff ? null : (listed?.fast_mode ?? null)}
                  onFast={switchFast}
                  ultracode={handoff ? null : (listed?.ultracode ?? null)}
                  onUltracode={switchUltracode}
                  inSession
                  {...(active ? {} : { keys: false })}
                />
                {planning && (
                  <span className="chip cp-chip">
                    {t({ id: 'sessions.composeDock.planMode', defaultMessage: 'Plan mode' })}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {display.context_usage && (
                  <ContextRing
                    usage={usage}
                    compacting={status?.kind === 'compacting'}
                    runtime={runtime}
                    model={session.reported_model ?? listed?.model ?? null}
                    quota={report?.quota}
                  />
                )}
                {voice.available && writable && (
                  <button
                    type="button"
                    className="vc-mic"
                    aria-label={t({ id: 'sessions.voice.start', defaultMessage: 'Voice input' })}
                    onClick={voice.start}
                  >
                    <Mic aria-hidden="true" />
                  </button>
                )}
                <SendButton
                  label={
                    stop
                      ? t({ id: 'sessions.composer.interrupt', defaultMessage: 'Stop this turn' })
                      : send || ended || handoff
                        ? t({ id: 'sessions.composer.send', defaultMessage: 'Send' })
                        : steerFirst
                          ? t({ id: 'sessions.composer.steer', defaultMessage: 'Steer' })
                          : t({ id: 'sessions.composer.queue', defaultMessage: 'Queue' })
                  }
                  icon={
                    stop ? (
                      <Square className="cp-sq" aria-hidden="true" />
                    ) : (
                      <ArrowUp aria-hidden="true" />
                    )
                  }
                  busyLabel={
                    busy === 'session.interrupt'
                      ? t({ id: 'sessions.composer.interrupting', defaultMessage: 'Interrupting…' })
                      : undefined
                  }
                  busy={busy !== null || forking}
                  steers={!stop && !handoff && !send && state.steer.enabled}
                  state={stop || handoff ? ON : send ? state.send : state.steer}
                  empty={empty && !stop}
                  onPress={() =>
                    void (stop
                      ? interrupt()
                      : handoff
                        ? fork(handoff)
                        : send
                          ? submit('session.send', state.send)
                          : steerFirst
                            ? submit('session.steer', state.steer)
                            : busy === null && enqueue())
                  }
                />
              </div>
            )}
          </div>
        </div>
        {shownError && (
          <span className="tr-err" role="alert">
            {shownError}
          </span>
        )}
      </div>
    </div>
  );
}
