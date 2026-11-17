import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Bot, ChevronDown, Paperclip } from 'lucide-react';
import type { SessionTurn } from '@pantheon/domain';
import type { BoardModel, BridgeResult, CommandType } from '@pantheon/protocol';
import { Menu, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../components/Menu';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { Tip } from '../../components/Tip';
import { useAgents } from '../../data/agents';
import { useBoard } from '../../data/board';
import { EMPTY_DRAFT, useDrafts, whenUploaded } from '../../data/drafts';
import { failureText } from '../../data/needs-you';
import {
  ASSISTANT,
  chooseRequestTarget,
  choiceKey,
  useRequestTarget,
  type RequestChoice,
} from '../../data/request-target';
import { useRuntimeStatus } from '../../data/runtime-status';
import type { DaemonEvent } from '../../data/sync';
import { t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { defaultRuntime } from '../sessions/model';
import { AttachmentStrip, useAttachments } from '../sessions/parts';
import {
  requirementSessionInput,
  requirementTarget,
  requirementTargets,
  type BoardLead,
  type RequirementTarget,
  type SessionDefaults,
} from './frame-model';
import type { SnapshotSession } from './panels-model';
import { StatusIcon } from './status';
import './frame.css';

/** Runs one command; resolves to the daemon's reply. */
export type PublishCommand = (
  type: CommandType,
  input: Record<string, unknown>,
  expectedRevision: number | null,
) => Promise<BridgeResult<unknown>>;

type BoardTask = BoardModel['tasks'][number];

/** The requirement the bar sent last, kept until the next one or a project change. */
interface Receipt {
  key: number;
  title: string;
  at: number;
  /** The session the requirement went to. */
  session: string;
  /** The turn the reply named; a created session's turn is its first one. */
  turn: string | null;
  /** The newest event sequence when it was sent. */
  after: number;
  /** The board's task ids when it was sent. */
  before: ReadonlySet<string>;
}

const STEPS = [
  {
    get label() {
      return t({ id: 'board.lead.publish.stepReceived', defaultMessage: 'Received' });
    },
  },
  {
    get label() {
      return t({ id: 'board.lead.publish.stepQueued', defaultMessage: 'Queued' });
    },
  },
  {
    get label() {
      return t({ id: 'board.lead.publish.stepPlanning', defaultMessage: 'Planning' });
    },
  },
  {
    get label() {
      return t({ id: 'board.lead.publish.stepTasks', defaultMessage: 'Creating tasks' });
    },
  },
];
const cancelledText = () => t({ id: 'board.lead.publish.cancelled', defaultMessage: 'Cancelled' });
const failedText = () => t({ id: 'board.lead.publish.failed', defaultMessage: 'Failed' });
const NO_TURNS: readonly SessionTurn[] = [];
const NO_TASKS: readonly BoardTask[] = [];

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const TURN_END: Record<string, SessionTurn['state']> = {
  'turn.completed': 'completed',
  'turn.failed': 'failed',
  'turn.cancelled': 'cancelled',
};

/**
 * Which step the requirement reached: reply 收到, waiting turn 排队, running turn 拆计划, a later
 * plan update 建任务; 4 once the turn ended. A steer ends with the running turn that takes it.
 */
function progress(
  receipt: Receipt,
  turns: readonly SessionTurn[],
  events: readonly DaemonEvent[],
): { step: number; failure: string | null } {
  const turn = receipt.turn
    ? turns.find((t) => t.id === receipt.turn)
    : turns.find((t) => t.session_id === receipt.session);
  if (!turn) return { step: 0, failure: null };
  const ran = events.find((e) => e.kind === 'turn.running' && e.aggregate_id === turn.id);
  const began = ran?.sequence ?? receipt.after;
  const planned =
    turn.state !== 'queued' &&
    events.some(
      (e) =>
        e.kind === 'board.plan_updated' && e.aggregate_id === receipt.session && e.sequence > began,
    );
  const step = planned ? 3 : turn.state === 'queued' ? 1 : 2;
  if (turn.state === 'cancelled') return { step, failure: cancelledText() };
  if (turn.state === 'failed' || turn.delivery === 'failed')
    return {
      step,
      failure: turn.delivery_reason
        ? t(
            { id: 'board.lead.publish.failedFor', defaultMessage: 'Failed: {reason}' },
            { reason: turn.delivery_reason },
          )
        : failedText(),
    };
  if (turn.state !== 'completed') return { step, failure: null };
  // A steer that ran as a turn of its own ended with it; one delivered into a running turn ends with that turn.
  if (turn.kind !== 'steer' || ran) return { step: STEPS.length, failure: null };
  const others = turns.filter((t) => t.session_id === receipt.session && t.id !== turn.id);
  const end = events.find(
    (e) =>
      e.sequence > receipt.after &&
      e.kind in TURN_END &&
      others.some((t) => t.id === e.aggregate_id),
  );
  const ended = end ? TURN_END[end.kind] : undefined;
  if (ended === 'cancelled') return { step, failure: cancelledText() };
  if (ended === 'failed') return { step, failure: failedText() };
  // Without the end event, the turn it joined ended once no turn of the session runs.
  return {
    step: ended || !others.some((t) => t.state === 'running') ? STEPS.length : step,
    failure: null,
  };
}

function ReceiptCard({
  receipt,
  turns,
  events,
  tasks,
}: {
  receipt: Receipt;
  turns: readonly SessionTurn[];
  events: readonly DaemonEvent[];
  tasks: readonly BoardTask[];
}) {
  const { step, failure } = progress(receipt, turns, events);
  const created = step >= 3 ? tasks.filter((t) => !receipt.before.has(t.id)) : NO_TASKS;
  return (
    <section
      className="pb-rc-in"
      aria-label={t(
        { id: 'board.lead.publish.receipt', defaultMessage: 'Receipt: {title}' },
        { title: receipt.title },
      )}
      aria-live="polite"
    >
      <div className="pb-rc-hd">
        <span className="pb-rc-t" title={receipt.title}>
          {receipt.title}
        </span>
        <time className="pb-rc-at" dateTime={new Date(receipt.at).toISOString()}>
          {clock(receipt.at)}
        </time>
      </div>
      <ol
        className="pb-steps"
        aria-label={t({ id: 'board.lead.publish.progress', defaultMessage: 'Progress' })}
      >
        {STEPS.map(({ label }, i) => (
          <li
            key={label}
            data-st={i < step ? 'done' : i === step ? (failure ? 'bad' : 'cur') : undefined}
            aria-current={i === step && !failure ? 'step' : undefined}
          >
            <i className="pb-sd" aria-hidden="true" />
            <span>{label}</span>
            {i < STEPS.length - 1 && <i className="pb-sl" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {failure && (
        <span className="tr-err" role="alert">
          {failure}
        </span>
      )}
      {created.length > 0 && (
        <ul
          className="pb-tasks"
          aria-label={t({ id: 'board.lead.publish.created', defaultMessage: 'Created tasks' })}
        >
          {created.map((t) => (
            <li key={t.id}>
              <StatusIcon status={t.status} />
              {t.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The menu's sections: residents, sessions, then a new lead. */
const section = (target: RequirementTarget) =>
  target.choice.kind === 'assistant' || target.choice.kind === 'agent'
    ? 'resident'
    : target.choice.kind;

/** A resident's mark, else the runtime the session or the new lead runs on. */
function TargetIcon({ choice, runtime }: { choice: RequestChoice; runtime: string | undefined }) {
  if (choice.kind === 'assistant' || choice.kind === 'agent') return <Bot aria-hidden="true" />;
  return runtime ? <RuntimeGlyph runtime={runtime} /> : null;
}

/**
 * Lines of input that go to the target chosen in its menu, the project's Assistant by default; the
 * last requirement sent leaves its receipt under the bar.
 */
export function PublishBar({
  projectId,
  leads,
  sessions,
  tasks,
  defaults,
  run,
  disabled = false,
}: {
  projectId: string;
  leads: readonly BoardLead[] | undefined;
  sessions: readonly SnapshotSession[];
  /** The board's tasks; those a receipt's plan update adds are listed on it. */
  tasks: readonly BoardTask[] | undefined;
  defaults: SessionDefaults;
  run: PublishCommand;
  /** Sends nothing while on; the draft stays. */
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [draftProject, setDraftProject] = useState(projectId);
  if (draftProject !== projectId) {
    setDraftProject(projectId);
    setText('');
    setBusy(false);
    setError(null);
    setReceipt(null);
  }
  const shownProject = useRef(projectId);
  shownProject.current = projectId;
  const key = JSON.stringify([projectId, 'publish']);
  const attachments = useAttachments(projectId, key);
  const turns = useBoard((s) => s.board?.session_turns) ?? NO_TURNS;
  const events = useBoard((s) => s.events);
  const { runtimes, unavailable } = useRuntimeStatus('writer');
  const box = useRef<HTMLTextAreaElement>(null);
  const sentCount = useRef(0);
  const refocus = useRef(false);
  useEffect(() => {
    // The input takes focus only once it is enabled again.
    if (busy || !refocus.current) return;
    refocus.current = false;
    box.current?.focus();
  }, [busy]);
  const targets = requirementTargets(leads, sessions, useAgents(projectId));
  const target = requirementTarget(useRequestTarget(projectId), targets);
  const creating = target.choice.kind === 'create';
  const leadRuntime = defaultRuntime(runtimes, defaults?.runtime, unavailable);
  const runtime = creating ? leadRuntime : target.session?.runtime;
  const input = text.trim();
  const cannotCreate = creating && unavailable[leadRuntime] !== undefined;
  // A resident with no session that takes input is opened first, as the sidebar opens it.
  const request = async (ids: string[]): Promise<BridgeResult<unknown>> => {
    let session = target.session?.id;
    if (target.choice.kind === 'agent' && !session) {
      const opened = await run('resident.open', { agent_id: target.choice.agent_id }, null);
      if (!opened.ok) return opened;
      const id = (opened.value as { id?: unknown } | null)?.id;
      if (typeof id === 'string') session = id;
    }
    return run(
      'request.send',
      {
        project_id: projectId,
        input,
        ...(ids.length ? { attachments: ids } : {}),
        ...(target.choice.kind !== 'assistant' && session
          ? { target: { kind: 'session', session_id: session } }
          : {}),
      },
      null,
    );
  };
  const send = async () => {
    if (busy || disabled || cannotCreate || !input) return;
    setBusy(true);
    setError(null);
    if (useDrafts.getState().drafts[key]?.uploading) await whenUploaded(key);
    const ids = (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).attachments.map((a) => a.id);
    const after = useBoard.getState().cursor;
    const before = new Set((tasks ?? NO_TASKS).map((t) => t.id));
    const result = creating
      ? await run(
          'session.create',
          // The lead starts on the runtime the bar shows.
          requirementSessionInput(projectId, defaults, input, [leadRuntime], ids),
          null,
        )
      : await request(ids);
    if (creating && result.ok) chooseRequestTarget(projectId, ASSISTANT);
    // The bar shows another project's draft by now.
    if (shownProject.current !== projectId) return;
    refocus.current = true;
    setBusy(false);
    if (!result.ok) return setError(failureText(result.error));
    useDrafts.getState().sent(key, { text: '', attachments: ids, skills: [] });
    const value = result.value as { id?: unknown; session_id?: unknown; turn_id?: unknown } | null;
    const session = creating ? value?.id : value?.session_id;
    if (typeof session === 'string')
      setReceipt({
        key: ++sentCount.current,
        title: input.split('\n')[0]!.trim(),
        at: Date.now(),
        session,
        turn: !creating && typeof value?.turn_id === 'string' ? value.turn_id : null,
        after,
        before,
      });
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };
  return (
    <div className="pb" data-debug-region="board.publish-bar">
      <form
        // Empty and unfocused it is one line; focus or a draft opens it.
        className="pb-f pb-grow"
        data-open={text !== '' || attachments.items.length > 0 || undefined}
        aria-label={t({ id: 'board.lead.publish.label', defaultMessage: 'Requirement' })}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send();
        }}
      >
        <AttachmentStrip
          items={attachments.items}
          pending={attachments.pending}
          onRemove={attachments.remove}
          onRetry={(id) => void attachments.retry(id)}
        />
        <div className="pb-in">
          <textarea
            ref={box}
            aria-label={t({ id: 'board.lead.publish.label', defaultMessage: 'Requirement' })}
            aria-keyshortcuts="Meta+Enter"
            rows={2}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="pb-bar">
          <button
            type="button"
            className="ib"
            aria-label={t({ id: 'board.lead.publish.attach', defaultMessage: 'Add attachment' })}
            onClick={() => void attachments.choose()}
          >
            <Paperclip aria-hidden="true" />
          </button>
          <Menu
            label={t({ id: 'board.lead.publish.targets', defaultMessage: 'Send to' })}
            align="end"
            trigger={
              <button
                type="button"
                className="btn ghost pb-to"
                aria-label={t(
                  { id: 'board.lead.publish.target', defaultMessage: 'Send to {name}' },
                  { name: target.name },
                )}
                title={target.name}
              >
                <TargetIcon choice={target.choice} runtime={runtime} />
                <span>{target.name}</span>
                <ChevronDown aria-hidden="true" />
              </button>
            }
          >
            <MenuRadioGroup
              value={choiceKey(target.choice)}
              onChange={(value) => {
                const next = targets.find((each) => choiceKey(each.choice) === value);
                if (next) chooseRequestTarget(projectId, next.choice);
              }}
            >
              {targets.map((each, i) => [
                i > 0 && section(each) !== section(targets[i - 1]!) && (
                  <MenuSeparator key={`sep:${section(each)}`} />
                ),
                <MenuRadioItem
                  key={choiceKey(each.choice)}
                  value={choiceKey(each.choice)}
                  icon={
                    <TargetIcon
                      choice={each.choice}
                      runtime={each.choice.kind === 'create' ? leadRuntime : each.session?.runtime}
                    />
                  }
                >
                  {each.name}
                </MenuRadioItem>,
              ])}
            </MenuRadioGroup>
          </Menu>
          <Tip content={keyText('Meta+Enter')}>
            <button
              type="submit"
              className="btn pri"
              aria-keyshortcuts="Meta+Enter"
              aria-busy={busy || undefined}
              disabled={busy || disabled || cannotCreate || !input}
            >
              {t({ id: 'board.lead.publish.send', defaultMessage: 'Send' })}
            </button>
          </Tip>
        </div>
      </form>
      {(error ?? attachments.error) && (
        <span className="tr-err" role="alert">
          {error ?? attachments.error}
        </span>
      )}
      {receipt && (
        <ReceiptCard
          key={receipt.key}
          receipt={receipt}
          turns={turns}
          events={events}
          tasks={tasks ?? NO_TASKS}
        />
      )}
    </div>
  );
}
