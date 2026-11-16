import {
  Bot,
  Brain,
  ChartGantt,
  Copy,
  FileText,
  MessageSquare,
  Minimize2,
  Pencil,
  Route,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { SessionTrace } from '@pantheon/protocol';
import { LoadError } from '../../components/LoadError';
import { StateGlyph, type GlyphName } from '../../components/SessionStateIcon';
import { toast } from '../../components/Toast';
import { useEventHistory } from '../../data/logs';
import type { DaemonEvent } from '../../data/sync';
import { toolLabel, toolOutputText } from '../../data/tool-calls';
import { elapsedText } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { useShell } from '../../store';
import { tokenText, usdText } from '../board/panels-model';
import { json } from '../sessions/parts';
import { callVerb, type CallVerb } from './call-rows';
import type { RunCall } from './run-tree';
import './call-detail.css';

type TraceSpan = SessionTrace['spans'][number];

// Labels are getters, so each is read in the language loaded by then.
const CALL_STATUS: Record<RunCall['status'], string> = {
  get running() {
    return t({ id: 'runtime.callStatus.running', defaultMessage: 'Running' });
  },
  get ok() {
    return t({ id: 'runtime.callStatus.ok', defaultMessage: 'Done' });
  },
  get error() {
    return t({ id: 'runtime.callStatus.error', defaultMessage: 'Failed' });
  },
  get unknown() {
    return t({ id: 'runtime.callStatus.unknown', defaultMessage: 'Unknown' });
  },
};

const STATUS_GLYPH: Record<RunCall['status'], GlyphName> = {
  running: 'running',
  ok: 'done',
  error: 'failed',
  unknown: 'idle',
};

// Names are getters, so each is read in the language loaded by then; without one a tool keeps its readable name.
const KIND: Record<CallVerb, { Icon: LucideIcon; name?: string }> = {
  think: {
    Icon: Brain,
    get name() {
      return t({ id: 'runs.detail.kind.think', defaultMessage: 'Think' });
    },
  },
  compact: {
    Icon: Minimize2,
    get name() {
      return t({ id: 'runs.detail.kind.compact', defaultMessage: 'Compact' });
    },
  },
  run: {
    Icon: Terminal,
    get name() {
      return t({ id: 'runs.detail.kind.run', defaultMessage: 'Run' });
    },
  },
  edit: {
    Icon: Pencil,
    get name() {
      return t({ id: 'runs.detail.kind.edit', defaultMessage: 'Edit' });
    },
  },
  read: {
    Icon: FileText,
    get name() {
      return t({ id: 'runs.detail.kind.read', defaultMessage: 'Read' });
    },
  },
  search: {
    Icon: Search,
    get name() {
      return t({ id: 'runs.detail.kind.search', defaultMessage: 'Search' });
    },
  },
  subagent: {
    Icon: Bot,
    get name() {
      return t({ id: 'runs.detail.kind.subagent', defaultMessage: 'Subagent' });
    },
  },
  dispatch: { Icon: Route },
  tool: { Icon: Wrench },
};

/** The kind of a call as the call table names it. */
function callKind(call: RunCall): { Icon: LucideIcon; name: string } {
  const kind = KIND[callVerb(call.kind, call.name)];
  return { Icon: kind.Icon, name: kind.name ?? toolLabel(call.name, undefined).title };
}

const clock = (at: number) =>
  new Intl.DateTimeFormat(currentLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(at);

// The cross a test runner prints before a failure; only it takes the error colour.
const CROSS = String.fromCodePoint(0x2717);
const crossed = (text: string) =>
  text.split(CROSS).flatMap((part, i) =>
    i === 0
      ? [part]
      : [
          <span key={i} className="cd-bad">
            {CROSS}
          </span>,
          part,
        ],
  );

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast({
      title: t({ id: 'runs.detail.copyFailed', defaultMessage: 'Could not copy the command' }),
      kind: 'failure',
    });
  }
}

/** The payload fields of agent.tool.started and agent.tool.completed. */
interface ToolPayload {
  tool_call_id?: unknown;
  input?: unknown;
  output?: unknown;
  ok?: unknown;
}

const isToolEvent = (event: DaemonEvent) =>
  event.kind === 'agent.tool.started' || event.kind === 'agent.tool.completed';

const NONE = '—';

// The trace cuts an input summary to this many characters.
const SUMMARY_CAP = 200;

/** The whole shell command a tool input holds, the script of a `sh -c` argv; null without one. */
function fullCommand(input: unknown): string | null {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const value = i.command ?? i.cmd;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every((part) => typeof part === 'string')) return null;
  return value.length === 3 && /^-l?c$/.test(value[1]!) ? value[2]! : value.join(' ');
}

/**
 * The side panel of the selected call: what the trace knows of it, its input excerpt included, and
 * for a Pantheon session its input and output, read from the session's events while the panel is open.
 */
export function CallDetail({
  call,
  span,
  turnCost,
  session,
  title,
  turn,
  projectId,
  events,
  now,
  onClose,
  onShowInTimeline,
}: {
  call: RunCall;
  /** The call's trace span, for what the run tree leaves out. */
  span?: TraceSpan;
  /** USD; the cost of the turn the call ran in. */
  turnCost?: number;
  session: string;
  /** The session's title. */
  title: string;
  /** The session's turn the call ran in, from 1. */
  turn: number | null;
  projectId: string | null;
  /** Whether the session records its tool events, so input and output can be read. */
  events: boolean;
  /** What a running call is timed up to. */
  now: number;
  onClose: () => void;
  /** Absent while there is no timeline to show the call in. */
  onShowInTimeline?: () => void;
}) {
  const history = useEventHistory({
    key: events ? session : null,
    project_id: projectId,
    after: 0,
    keep: (e) =>
      e.aggregate_id === session &&
      isToolEvent(e) &&
      (e.payload as ToolPayload).tool_call_id === call.id,
  });
  const payload = (kind: string) =>
    history.events?.find((e) => e.kind === kind)?.payload as ToolPayload | undefined;
  const started = payload('agent.tool.started');
  const completed = payload('agent.tool.completed');
  const failed = completed !== undefined && completed.ok !== true;
  const summary = span?.input_summary;
  const command =
    callVerb(call.kind, call.name) !== 'run'
      ? null
      : started?.input === undefined
        ? summary !== undefined && Array.from(summary).length < SUMMARY_CAP
          ? summary
          : null
        : fullCommand(started.input);
  const input =
    command ??
    (started?.input === undefined
      ? (summary ?? null)
      : toolLabel(call.name, started.input).detail || json(started.input));
  const end = call.end ?? (call.status === 'running' ? now : null);
  const kind = callKind(call);
  return (
    <aside
      className="cd"
      aria-label={t({ id: 'runs.detail.label', defaultMessage: 'Call detail' })}
    >
      <div className="cd-h">
        <kind.Icon aria-hidden="true" />
        <span className="cd-kind">{kind.name}</span>
        <span className="cd-ses">{title}</span>
        {turn !== null && (
          <span className="cd-turn">
            {t({ id: 'runs.detail.turn', defaultMessage: 'Turn {turn}' }, { turn })}
          </span>
        )}
        <button
          type="button"
          className="ib cd-close"
          aria-label={t({ id: 'runs.detail.close', defaultMessage: 'Close detail' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="panel cd-facts">
        <div className="cell">
          <span className="cap">{t({ id: 'runtime.call.status', defaultMessage: 'Status' })}</span>
          <span className="cd-v">
            <span className="cd-st" aria-hidden="true">
              <StateGlyph name={STATUS_GLYPH[call.status]} />
            </span>
            {CALL_STATUS[call.status]}
          </span>
        </div>
        <div className="cell">
          <span className="cap">{t({ id: 'runtime.call.start', defaultMessage: 'Start' })}</span>
          <span className="cd-v cd-at">{call.start === null ? NONE : clock(call.start)}</span>
        </div>
        <div className="cell">
          <span className="cap">{t({ id: 'runtime.call.end', defaultMessage: 'End' })}</span>
          <span className="cd-v cd-at">{call.end === null ? NONE : clock(call.end)}</span>
        </div>
        <div className="cell">
          <span className="cap">
            {t({ id: 'runs.detail.duration', defaultMessage: 'Duration' })}
          </span>
          <span className="cd-v">
            {call.start === null || end === null ? NONE : elapsedText(end - call.start)}
          </span>
        </div>
        {span?.retry_count === undefined ? (
          <div className="cell" aria-hidden="true" />
        ) : (
          <div className="cell">
            <span className="cap">
              {t({ id: 'runs.detail.retries', defaultMessage: 'Retries' })}
            </span>
            <span className="cd-v">
              {t(
                {
                  id: 'runs.detail.retryCount',
                  defaultMessage: '{count, plural, one {# time} other {# times}}',
                },
                { count: span.retry_count },
              )}
            </span>
          </div>
        )}
        <div className="cell">
          <span className="cap">{t({ id: 'runs.detail.tokens', defaultMessage: 'Tokens' })}</span>
          <span className="cd-v">{call.tokens > 0 ? tokenText(call.tokens) : NONE}</span>
        </div>
        {span?.exit_code !== undefined && (
          <div className="cell">
            <span className="cap">
              {t({ id: 'runs.detail.exitCode', defaultMessage: 'Exit code' })}
            </span>
            <span className={span.exit_code === 0 ? 'cd-v' : 'cd-v cd-bad'}>{span.exit_code}</span>
          </div>
        )}
        {turnCost !== undefined && (
          <div className="cell">
            <span className="cap">
              {t({ id: 'runs.detail.turnCost', defaultMessage: 'Turn cost' })}
            </span>
            <span className="cd-v">{usdText(turnCost)}</span>
          </div>
        )}
      </div>
      {history.error && <LoadError message={history.error} onRetry={history.reload} />}
      {input !== null && (
        <div className="cd-sec">
          <span className="cap">{t({ id: 'runtime.call.input', defaultMessage: 'Input' })}</span>
          <pre className="cd-code">{input}</pre>
        </div>
      )}
      {completed?.output !== undefined && (
        <div className="cd-sec">
          <span className="cap">
            {failed
              ? t({ id: 'runtime.call.error', defaultMessage: 'Error' })
              : t({ id: 'runtime.call.output', defaultMessage: 'Output' })}
          </span>
          {failed ? (
            <pre className="cd-code cd-term">
              {crossed(toolOutputText(completed.output) || json(completed.output))}
            </pre>
          ) : (
            <pre className="cd-code">
              {toolOutputText(completed.output) || json(completed.output)}
            </pre>
          )}
        </div>
      )}
      <div className="cd-foot">
        {onShowInTimeline && (
          <button type="button" className="btn" onClick={onShowInTimeline}>
            <ChartGantt aria-hidden="true" />
            {t({ id: 'runs.detail.showInTimeline', defaultMessage: 'Show in timeline' })}
          </button>
        )}
        {!session.startsWith('native:') && (
          <button
            type="button"
            className="btn"
            onClick={() => useShell.getState().openSession(session)}
          >
            <MessageSquare aria-hidden="true" />
            {t({ id: 'runs.detail.showInThread', defaultMessage: 'Show in conversation' })}
          </button>
        )}
        {command !== null && (
          <button
            type="button"
            className="ib cd-copy"
            aria-label={t({ id: 'runs.detail.copy', defaultMessage: 'Copy command' })}
            onClick={() => void copy(command)}
          >
            <Copy aria-hidden="true" />
          </button>
        )}
      </div>
    </aside>
  );
}
