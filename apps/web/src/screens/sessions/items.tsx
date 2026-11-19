import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { Dialog } from '@base-ui/react/dialog';
import {
  AppWindow,
  Brain,
  CheckIcon,
  ChevronRight,
  ExternalLink,
  FoldVertical,
  GitFork,
  Minus,
  PanelRight,
  Unplug,
  X,
} from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import type {
  AgentChapterStartedPayload,
  FilesReadResult,
  SessionToolImage,
} from '@pantheon/protocol';
import { appToolName } from '../../components/mcp-app/AppFrame';
import { DiffCounts } from '../../components/DiffCounts';
import { Equalizer } from '../../components/Equalizer';
import { LoadError } from '../../components/LoadError';
import { Markdown } from '../../components/Markdown';
import { Skeleton } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { VisualById, VisualsDrawing } from '../../components/visual/VisualCard';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { diffLines, type DiffLine } from '../../lib/text-diff';
import { useLook } from '../../data/layout';
import { eventSummary } from '../../data/logs';
import { failureText } from '../../data/needs-you';
import { useSessionDisplay } from '../../data/session-display';
import type { DaemonEvent } from '../../data/sync';
import {
  drawSource,
  isImageFile,
  isTruncated,
  orchestrationLabel,
  pantheonTool,
  subagentCall,
  toolGroupLabel,
  toolLabel,
  toolOutcome,
  toolFiles,
  toolOutputText,
  workspaceFile,
  type ToolLabel,
} from '../../data/tool-calls';
import {
  elapsedText,
  groupToolCalls,
  isQuietEvent,
  mcpStartFailure,
  outcomeText,
  subagentRun,
  toolDuration,
  toolState,
  type ReasoningItem,
  type RequestItem,
  type ToolImage,
  type ToolItem,
  type ToolState,
  type TranscriptItem,
  type TurnEnd,
} from '../../data/transcript';
import { t } from '../../i18n';
import { readQuery } from '../../data/workbench-sessions';
import { AgentProposalCall } from './AgentProposal';
import { appModeOf, useAppDisplay } from './app-display';
import { InlineApp } from './AppPanels';
import { showUrl } from './BrowserPanel';
import { showFile } from './FilesPanel';
import { hasBrowser } from './inspector-model';
import { itemId } from './model';
import { openMemory } from './MemoryUsed';
import { clockText } from '../../lib/time-text';
import { scrimFlag } from '../../lib/root-flag';
import { OrchestrationRow } from './orchestration';
import { SubagentFan } from './SubagentFan';
import { ForkDialog, forkStepLabel } from './TurnMenu';

export const CALL_STATE: Record<ToolState, { label: string }> = {
  running: {
    get label() {
      return t({ id: 'sessions.parts.callRunning', defaultMessage: 'Running' });
    },
  },
  ok: {
    get label() {
      return t({ id: 'sessions.parts.callOk', defaultMessage: 'Succeeded' });
    },
  },
  failed: {
    get label() {
      return t({ id: 'sessions.parts.callFailed', defaultMessage: 'Failed' });
    },
  },
  none: {
    get label() {
      return t({ id: 'sessions.parts.callNone', defaultMessage: 'No result' });
    },
  },
};

export const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? String(value);

// Shown in the composer's status line while they last, not as rows of the turn.
const STATUS_EVENTS: ReadonlySet<string> = new Set([
  'agent.turn.retrying',
  'agent.context.compacting',
]);

/** Message text, one folded row per tool call or run of calls, and the other agent events, in order. */
export function Items(props: {
  items: TranscriptItem[];
  verbose: boolean;
  ended: boolean;
  folders: readonly string[];
  /** The session whose thread shows the items; its orchestration calls name tasks of its plan. */
  sessionId: string;
  /** The whole list `items` is a part of; ids are counted in it. Defaults to `items`. */
  all?: readonly TranscriptItem[];
  /** The turn id, or 'loose', that names the items. */
  owner?: string;
  /** Item ids that arrived after the history loaded; they play their entry once. */
  fresh?: ReadonlySet<string>;
  /** Renders each request in place, waiting ones included; without it only answered ones show. */
  request?: (item: RequestItem, className: string) => ReactNode;
  /** The main agent's tool calls offer a fork from before them. */
  forkSteps?: boolean;
}) {
  const parents = new Map<string, string>();
  for (const item of props.items)
    if (item.kind === 'tool' && item.parent) parents.set(item.id, item.parent);
  const depth = (item: ToolItem) => {
    let d = 0;
    for (let p = item.parent; p !== undefined && d < 3; p = parents.get(p)) d++;
    return d;
  };
  const all = props.all ?? props.items;
  const ids = new Map(
    props.items.map((item) => [item, itemId(props.owner ?? '', all, all.indexOf(item))]),
  );
  const enter = (item: TranscriptItem) => (props.fresh?.has(ids.get(item)!) ? ' tr-in' : '');
  const openFailed = useLook().transcript === 'open-failed';
  const reasoning = useSessionDisplay().reasoning;
  // Folded calls open by themselves when they failed and failures open; keys follow, so they mount again.
  const opens = (calls: ToolItem[]) =>
    props.verbose || (openFailed && calls.some((c) => toolState(c, props.ended) === 'failed'));
  // Without `request`, a waiting request is shown as its card below the thread.
  const shown = props.items.filter((item) =>
    item.kind === 'event'
      ? props.verbose || !(isQuietEvent(item.event) || STATUS_EVENTS.has(item.event.kind))
      : item.kind === 'reasoning'
        ? reasoning
        : item.kind !== 'request' || item.outcome !== undefined || props.request !== undefined,
  );
  const call = (item: ToolItem, i: number, under = 0) => (
    <ToolCall
      key={`tool-${item.id}-${opens([item])}`}
      item={item}
      state={toolState(item, props.ended)}
      depth={depth(item) - under}
      open={opens([item])}
      folders={props.folders}
      sessionId={props.sessionId}
      enter={i === 0 ? '' : enter(item)}
      {...(props.forkSteps && !item.parent && { forkFrom: props.sessionId })}
    />
  );
  // A run keeps its first call's key as it grows, so that call is not mounted again.
  const run = (calls: ToolItem[]) => (
    <ToolCalls
      key={`run-${calls[0]!.id}-${opens(calls)}`}
      calls={calls}
      ended={props.ended}
      open={opens(calls)}
      enter={enter(calls[0]!)}
    >
      {calls.map((c, i) => call(c, i))}
    </ToolCalls>
  );
  // The subagents a run dispatches show as one fan, each with its own calls; the other calls keep their runs.
  const block = (calls: ToolItem[]) => {
    const agents = calls.filter((c) => !c.parent && subagentCall(c.name, c.input));
    if (!agents.length) return run(calls);
    const own = new Map(agents.map((a) => [a.id, [] as ToolItem[]]));
    const before: ToolItem[] = [];
    const after: ToolItem[] = [];
    for (const c of calls) {
      if (own.has(c.id)) continue;
      let p = c.parent;
      while (p !== undefined && !own.has(p)) p = parents.get(p);
      if (p !== undefined) own.get(p)!.push(c);
      else (calls.indexOf(c) < calls.indexOf(agents[0]!) ? before : after).push(c);
    }
    return [
      before.length > 0 && run(before),
      <SubagentFan
        key={`fan-${agents[0]!.id}-${props.verbose}`}
        agents={agents.map((a) => subagentRun(a, all.slice(all.indexOf(a) + 1)))}
        calls={own}
        ended={props.ended}
        open={props.verbose}
        enter={enter(agents[0]!)}
        sessionId={props.sessionId}
        renderCalls={(mine) => mine.map((c, i) => call(c, i, 1))}
      />,
      after.length > 0 && run(after),
    ];
  };
  const drawn = groupToolCalls(shown).map((item, i) => {
    if (item.kind === 'text')
      return (
        <div
          key={`text-${i}`}
          className={`tr-msg${enter(item)}`}
          data-find={props.owner === 'loose' ? undefined : all.indexOf(item)}
        >
          <Markdown text={item.text} />
        </div>
      );
    if (item.kind === 'reasoning')
      return (
        <Reasoning
          key={`reasoning-${i}-${props.verbose}`}
          item={item}
          open={props.verbose}
          enter={enter(item)}
        />
      );
    if (item.kind === 'tool' && pantheonTool(item.name) === 'propose_agent')
      return (
        <AgentProposalCall
          key={`tool-${item.id}`}
          item={item}
          state={toolState(item, props.ended)}
          depth={depth(item)}
          open={props.verbose}
          enter={enter(item)}
          sessionId={props.sessionId}
        />
      );
    if (item.kind === 'tool')
      return orchestrationLabel(item.name, item.input) ? (
        <OrchestrationRow
          key={`tool-${item.id}-${props.verbose}`}
          item={item}
          state={toolState(item, props.ended)}
          depth={depth(item)}
          open={props.verbose}
          enter={enter(item)}
          sessionId={props.sessionId}
        />
      ) : (
        block([item])
      );
    if (item.kind === 'group') return block(item.calls);
    if (item.kind === 'request')
      return props.request ? (
        props.request(item, enter(item))
      ) : (
        <AnsweredRequest
          key={`request-${item.id}`}
          item={item}
          folders={props.folders}
          enter={enter(item)}
        />
      );
    if (item.kind === 'visual')
      return <VisualById key={`visual-${item.visual_id}`} visualId={item.visual_id} />;
    if (item.event.kind === 'agent.context.compacted')
      return <CompactNotice key={item.event.event_id} event={item.event} enter={enter(item)} />;
    if (!props.verbose && mcpStartFailure(item.event))
      return <McpStartNotice key={item.event.event_id} event={item.event} enter={enter(item)} />;
    return (
      <AgentEvent
        key={item.event.event_id}
        event={item.event}
        verbose={props.verbose}
        enter={enter(item)}
      />
    );
  });
  return props.ended
    ? drawn
    : [...drawn, <VisualsDrawing key="drawing" sessionId={props.sessionId} />];
}

/** A call's state as a 14px glyph: bars while it runs, a check, a cross, or a dash for no result. */
export function StateMark({ state }: { state: ToolState }) {
  return (
    <span className="ss-tok" data-state={state} aria-hidden="true">
      {state === 'ok' ? (
        <CheckIcon aria-hidden="true" />
      ) : state === 'failed' ? (
        <X aria-hidden="true" />
      ) : state === 'none' ? (
        <Minus aria-hidden="true" />
      ) : state === 'running' ? (
        <Equalizer />
      ) : null}
    </span>
  );
}

/** An event of the thread drawn as a ruled line: its glyph, its words and its time. */
export function ThreadMark(props: {
  glyph: ReactNode;
  at: number | null;
  enter?: string;
  children: ReactNode;
}) {
  return (
    <div className={`ss-mark${props.enter ?? ''}`} role="note">
      <span className="ss-markg" aria-hidden="true">
        {props.glyph}
      </span>
      {props.children}
      {props.at !== null && <span className="ss-markt">{clockText(props.at)}</span>}
    </div>
  );
}

const SHOWN_LINES = 12;

/** A call's input or output in a code block; past its first lines, a button shows the rest. */
export function ToolText(props: { text: string; label: string; input?: boolean }) {
  const [all, setAll] = useState(false);
  const lines = props.text.split('\n');
  const more = all ? 0 : lines.length - SHOWN_LINES;
  return (
    <>
      <pre className={props.input ? 'ss-tin' : undefined} aria-label={props.label}>
        {more > 0 ? lines.slice(0, SHOWN_LINES).join('\n') : props.text}
      </pre>
      {more > 0 && (
        <button type="button" className="btn ghost ss-tmore" onClick={() => setAll(true)}>
          {t(
            {
              id: 'sessions.parts.moreLines',
              defaultMessage: '{count, plural, one {# more line} other {# more lines}}',
            },
            { count: more },
          )}
        </button>
      )}
    </>
  );
}

const GROUP_STATE: readonly ToolState[] = ['failed', 'running', 'ok', 'none'];

function ToolCalls(props: {
  calls: ToolItem[];
  ended: boolean;
  open: boolean;
  enter: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.open);
  const lone = props.calls.length === 1;
  const states = props.calls.map((c) => toolState(c, props.ended));
  const state = GROUP_STATE.find((s) => states.includes(s)) ?? 'none';
  const durations = props.calls.map(toolDuration).filter((d) => d !== null);
  const total = durations.length ? elapsedText(durations.reduce((a, d) => a + d, 0)) : '';
  const label = toolGroupLabel(props.calls);
  // A lone call shows without the group row; the group it grows into opens as that call was left.
  const children = Children.map(props.children, (child, i) =>
    lone && i === 0 && isValidElement<{ onOpenChange?: (open: boolean) => void }>(child)
      ? cloneElement(child, { onOpenChange: setOpen })
      : child,
  );
  return (
    <Collapsible.Root
      className={`ss-tgroup${props.enter}`}
      open={lone || open}
      onOpenChange={setOpen}
    >
      {!lone && (
        <Collapsible.Trigger
          className="ss-trow"
          aria-label={[label, CALL_STATE[state].label, total]
            .filter(Boolean)
            .join(t({ id: 'sessions.parts.separator', defaultMessage: ', ' }))}
        >
          <span className="ss-tchev" aria-hidden="true">
            <ChevronRight aria-hidden="true" />
          </span>
          <span className="ss-tgl">{label}</span>
          <span />
          <StateMark state={state} />
          <span className="ss-td mono">{total}</span>
        </Collapsible.Trigger>
      )}
      <Collapsible.Panel className={lone ? undefined : 'ss-tlist'}>{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** A finished turn's calls and narration behind one folded row. */
export function TurnWork(props: {
  work: TranscriptItem[];
  end: TurnEnd | null;
  started_at: number | null;
  ended_at: number | null;
  children: ReactNode;
}) {
  const calls = props.work.filter((item): item is ToolItem => item.kind === 'tool');
  const states = calls.map((c) => toolState(c, true));
  const state: ToolState =
    props.end?.state === 'failed' || states.includes('failed')
      ? 'failed'
      : states.includes('none')
        ? 'none'
        : 'ok';
  const took =
    props.started_at !== null && props.ended_at !== null
      ? elapsedText(props.ended_at - props.started_at)
      : null;
  const stopped = props.end?.state === 'cancelled';
  const summary = stopped
    ? took
      ? t(
          { id: 'sessions.parts.stoppedAfter', defaultMessage: 'You stopped after {took}' },
          { took },
        )
      : t({ id: 'sessions.parts.stopped', defaultMessage: 'You stopped' })
    : took
      ? t({ id: 'sessions.parts.workedFor', defaultMessage: 'Worked for {took}' }, { took })
      : t({ id: 'sessions.parts.worked', defaultMessage: 'Worked' });
  const label = toolGroupLabel(calls);
  const openFailed = useLook().transcript === 'open-failed';
  return (
    <Collapsible.Root className="ss-twork" defaultOpen={openFailed && states.includes('failed')}>
      <Collapsible.Trigger
        className="ss-trow"
        aria-label={[summary, label, CALL_STATE[state].label].join(
          t({ id: 'sessions.parts.separator', defaultMessage: ', ' }),
        )}
      >
        <span className="ss-tchev" aria-hidden="true">
          <ChevronRight aria-hidden="true" />
        </span>
        <span className="ss-twl">
          <span className="ss-tws">{summary}</span>
          <span className="ss-tgl">{label}</span>
        </span>
        <span />
        <StateMark state={state} />
        <span className="ss-td" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="ss-twp">{props.children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** The model's reasoning folded to its first line; opened, the whole text. */
function Reasoning(props: { item: ReasoningItem; open: boolean; enter: string }) {
  const [open, setOpen] = useState(props.open);
  const line = props.item.text
    .trim()
    .split('\n')[0]!
    .replace(/\*\*|^[#>\s]+/g, '');
  return (
    <Collapsible.Root className={`ss-rsn${props.enter}`} open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        className="ss-trow"
        aria-label={t(
          {
            id: 'sessions.parts.reasoning',
            defaultMessage:
              '{summary, select, yes {Reasoning summary: {line}} other {Reasoning: {line}}}',
          },
          { summary: props.item.summary ? 'yes' : 'no', line },
        )}
      >
        <span className="ss-tchev" aria-hidden="true">
          <ChevronRight aria-hidden="true" />
        </span>
        <Brain className="ic-sm" aria-hidden="true" />
        <span className="ss-rsl">{line}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="ss-rsp">
        <Markdown text={props.item.text} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ToolCall(props: {
  item: ToolItem;
  state: ToolState;
  depth: number;
  open: boolean;
  folders: readonly string[];
  sessionId: string;
  enter: string;
  onOpenChange?: (open: boolean) => void;
  /** The session a fork from before this call is opened from. */
  forkFrom?: string;
}) {
  const { item } = props;
  const [open, setOpen] = useState(props.open);
  const [forking, setForking] = useState<boolean | null>(null);
  // Only the session the sessions screen shows can dock its interface or show it full screen.
  const hosted = useAppDisplay((s) => !!item.app && s.hosted === props.sessionId);
  const mode = useAppDisplay((s) =>
    hosted ? appModeOf(s.places, props.sessionId, item.id) : 'inline',
  );
  const label: ToolLabel = item.app
    ? { title: appToolName(item.name), detail: item.app.server }
    : toolLabel(item.name, item.input, props.folders);
  const state = CALL_STATE[props.state];
  const result =
    item.ok !== undefined
      ? toolOutcome(item.output, item.ok)
      : props.state === 'none'
        ? state.label
        : '';
  const duration = toolDuration(item);
  const elapsed = duration === null ? '' : elapsedText(duration);
  const cut = isTruncated(item.input) || isTruncated(item.output);
  const output =
    item.output === undefined ? null : toolOutputText(item.output) || json(item.output);
  const source = drawSource(item.name, item.input);
  const files = toolFiles(item.name, item.input, item.output, props.folders);
  // A returned image stands for the file the call saved it to.
  const pictures = item.images?.length ? [] : files.filter(isImageFile);
  return (
    <Collapsible.Root
      className={`ss-tool${props.depth ? ` d${props.depth}` : ''}${props.enter}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        props.onOpenChange?.(next);
      }}
    >
      <Collapsible.Trigger
        className="ss-trow"
        data-app={item.app ? mode : undefined}
        data-app-call={item.app ? item.id : undefined}
        aria-label={[label.title, label.detail, result || state.label, elapsed]
          .filter(Boolean)
          .join(t({ id: 'sessions.parts.separator', defaultMessage: ', ' }))}
      >
        <span className="ss-tchev" aria-hidden="true">
          <ChevronRight aria-hidden="true" />
        </span>
        {item.app &&
          (mode === 'pip' ? (
            <PanelRight className="apd-ic" aria-hidden="true" />
          ) : (
            <AppWindow className="apd-ic" aria-hidden="true" />
          ))}
        <span className="ss-tn">{label.title}</span>
        <span className={label.prose ? 'ss-ta' : 'ss-ta mono'}>{label.detail}</span>
        <span className="ss-ts">
          {result}
          {cut && (
            <span className="tr-cut">
              {t({ id: 'sessions.parts.truncated', defaultMessage: 'Truncated' })}
            </span>
          )}
        </span>
        <StateMark state={props.state} />
        <span className="ss-td mono">{elapsed}</span>
      </Collapsible.Trigger>
      {props.forkFrom !== undefined && (
        <button
          type="button"
          className="ib ss-ab ss-tfk"
          aria-label={forkStepLabel()}
          onClick={() => setForking(true)}
        >
          <GitFork aria-hidden="true" />
        </button>
      )}
      {props.forkFrom !== undefined && forking !== null && (
        <ForkDialog
          open={forking}
          sessionId={props.forkFrom}
          before={null}
          beforeSpan={item.id}
          input=""
          attachments={[]}
          skills={[]}
          onClose={() => setForking(false)}
        />
      )}
      {item.app && mode === 'inline' && (
        <InlineApp
          sessionId={props.sessionId}
          call={{ item, state: props.state }}
          hosted={hosted}
        />
      )}
      {(item.images?.length || pictures.length > 0) && (
        <ToolImages images={item.images ?? []} files={pictures} sessionId={props.sessionId} />
      )}
      {item.artifact && (
        <ArtifactCard
          artifact={item.artifact}
          folders={props.folders}
          sessionId={props.sessionId}
        />
      )}
      {(item.input !== undefined || output !== null) && (
        <Collapsible.Panel className="ss-tio">
          {files.length > 0 && (
            <ToolFiles files={files} base={props.folders[0]} sessionId={props.sessionId} />
          )}
          {source && (
            <ToolText
              text={source}
              label={t({ id: 'visual.card.dataSource', defaultMessage: 'Source' })}
            />
          )}
          {item.input !== undefined && (
            <ToolText
              text={json(item.input)}
              label={t({ id: 'sessions.parts.input', defaultMessage: 'Input' })}
              input
            />
          )}
          {output !== null && (
            <ToolText
              text={output}
              label={t({ id: 'sessions.parts.output', defaultMessage: 'Output' })}
            />
          )}
        </Collapsible.Panel>
      )}
    </Collapsible.Root>
  );
}

/** The files a call touched, each opening in the files panel, or with ⌘ or the button beside it in the editor. */
export function ToolFiles(props: {
  files: string[];
  /** The folder the paths are in. */
  base: string | undefined;
  sessionId: string;
}) {
  const bridge = window.pantheon;
  const editor = (path: string) =>
    void bridge?.openFile({ path, base: props.base }).then((r) => {
      if (!r.ok) toast({ title: failureText(r.error), kind: 'failure' });
    });
  return (
    <ul className="ss-tfiles">
      {props.files.map((path) => {
        const label = t(
          { id: 'sessions.parts.openInEditor', defaultMessage: 'Open {path} in the editor' },
          { path },
        );
        return (
          <li key={path}>
            <button
              type="button"
              className="ss-tfile mono"
              onClick={(e: MouseEvent) =>
                (e.metaKey || e.ctrlKey) && bridge ? editor(path) : showFile(props.sessionId, path)
              }
            >
              {path}
            </button>
            {bridge?.openFile && (
              <Tip content={label}>
                <button
                  type="button"
                  className="ib"
                  aria-label={label}
                  onClick={() => editor(path)}
                >
                  <ExternalLink aria-hidden="true" />
                </button>
              </Tip>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The page an Artifact call published, which opens in the browser panel, and its file in the worktree. */
export function ArtifactCard(props: {
  artifact: NonNullable<ToolItem['artifact']>;
  folders: readonly string[];
  sessionId: string;
}) {
  const { url, path, title, version } = props.artifact;
  const local = workspaceFile(path, props.folders);
  const name = title ?? path.split('/').pop() ?? url;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // An address the URL parser refuses is shown whole.
  }
  return (
    <div className="ss-art" role="group" aria-label={name}>
      <span className="ss-art-tx">
        <span className="ss-art-tt">{name}</span>
        {version !== undefined && (
          <span className="ss-art-mt">
            {t(
              { id: 'sessions.parts.artifactVersion', defaultMessage: 'Version {version}' },
              { version },
            )}
          </span>
        )}
        <span className="ss-art-mt mono">{host}</span>
      </span>
      {hasBrowser() && (
        <button type="button" className="btn sm" onClick={() => showUrl(props.sessionId, url)}>
          {t({ id: 'sessions.parts.artifactOpen', defaultMessage: 'Open' })}
        </button>
      )}
      {local !== null && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => showFile(props.sessionId, local)}
        >
          {t({ id: 'sessions.parts.artifactPreviewLocal', defaultMessage: 'Preview local' })}
        </button>
      )}
    </div>
  );
}

/**
 * Thumbnails of the images a call returned, which open large, and of the image files it wrote,
 * which open in the files panel.
 */
export function ToolImages(props: { images: ToolImage[]; files: string[]; sessionId: string }) {
  const scope = useBoard((s) => {
    const session = s.board?.sessions.find((each) => each.id === props.sessionId);
    return session
      ? JSON.stringify({ project_id: session.project_id, session_id: session.id })
      : null;
  });
  const [read, setRead] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string>>({});
  const [large, setLarge] = useState<string | null>(null);
  const files = props.files.join('\0');
  const hashes = props.images.flatMap((image) => ('hash' in image ? [image.hash] : [])).join(' ');
  useEffect(() => {
    let live = true;
    for (const hash of hashes ? hashes.split(' ') : [])
      void readQuery('session.tool_image', { session_id: props.sessionId, hash }).then((result) => {
        const image = result.ok ? (result.value as SessionToolImage) : null;
        if (live && image)
          setStored((now) => ({ ...now, [hash]: `data:${image.mime};base64,${image.data}` }));
      });
    return () => {
      live = false;
    };
  }, [props.sessionId, hashes]);
  useEffect(() => {
    if (!scope) return;
    let live = true;
    for (const path of props.files)
      void readQuery('files.read', { ...JSON.parse(scope), path }).then((result) => {
        const file = result.ok ? (result.value as FilesReadResult) : null;
        if (live && file?.mime?.startsWith('image/') && file.data)
          setRead((now) => ({ ...now, [path]: `data:${file.mime};base64,${file.data}` }));
      });
    return () => {
      live = false;
    };
  }, [scope, files]);
  const name = t({ id: 'sessions.parts.image', defaultMessage: 'Image' });
  const openLabel = t({ id: 'sessions.parts.openImage', defaultMessage: 'Open image' });
  return (
    <div className="ss-timgs">
      {props.images.map((image, i) => {
        const src =
          'hash' in image ? stored[image.hash] : `data:${image.mime};base64,${image.data}`;
        return (
          src && (
            <button
              key={i}
              type="button"
              className="ss-timg"
              aria-label={openLabel}
              onClick={() => setLarge(src)}
            >
              <img src={src} alt="" draggable={false} />
            </button>
          )
        );
      })}
      {props.files.map(
        (path) =>
          read[path] && (
            <button
              key={path}
              type="button"
              className="ss-timg"
              aria-label={t(
                { id: 'sessions.parts.openImageFile', defaultMessage: 'Open {path}' },
                { path },
              )}
              onClick={() => showFile(props.sessionId, path)}
            >
              <img src={read[path]} alt="" draggable={false} />
            </button>
          ),
      )}
      {large !== null && (
        <Dialog.Root open onOpenChange={(open) => !open && setLarge(null)}>
          <Dialog.Portal>
            <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
            <Dialog.Popup className="pj-dlg ss-timgdlg" aria-label={name}>
              <img src={large} alt={name} draggable={false} />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}

/** One line per answered request: the tool and its argument, or each question, and the answer. */
export function AnsweredRequest(props: {
  item: RequestItem;
  folders: readonly string[];
  enter?: string;
  /** Set on the first row, which takes focus when the user's own answer folds the card. */
  rowRef?: Ref<HTMLDivElement>;
}) {
  const { item, folders } = props;
  const ok = item.outcome === 'approve' || item.outcome === 'approve_session';
  const mark = (
    <span className={ok ? 'ok' : 'bad'} aria-hidden="true">
      {ok ? <CheckIcon aria-hidden="true" /> : <X aria-hidden="true" />}
    </span>
  );
  const row = `ss-resolved${props.enter ?? ''}`;
  const focus = props.rowRef ? { ref: props.rowRef, tabIndex: -1 } : {};
  const asked = item.questions.length ? item.questions : Object.keys(item.answers ?? {});
  if (asked.length && ok && item.answers)
    return asked.map((question, i) => (
      <div key={question} className={row} {...(i === 0 ? focus : {})}>
        {mark}
        <span className="ss-tn">{question}</span>
        <span className="ss-ra">{item.answers?.[question] ?? ''}</span>
      </div>
    ));
  const label = asked.length
    ? { title: asked[0]!, detail: '' }
    : toolLabel(item.tool, item.input, folders);
  return (
    <div className={row} {...focus}>
      {mark}
      <span className="ss-tn">{label.title}</span>
      {label.detail && (
        <span className="ss-ta mono" title={label.detail}>
          {label.detail}
        </span>
      )}
      <span className="ss-ra">{outcomeText(item)}</span>
    </div>
  );
}

/** The runtime compacted the context; the event gives the size before it, when known. */
function CompactNotice(props: { event: DaemonEvent; enter: string }) {
  const before = (props.event.payload as { pre_tokens?: unknown } | null)?.pre_tokens;
  return (
    <ThreadMark glyph={<FoldVertical />} at={props.event.created_at} enter={props.enter}>
      <span>{t({ id: 'sessions.thread.compacted', defaultMessage: 'Context compacted' })}</span>
      {typeof before === 'number' && (
        <span>
          {t(
            { id: 'sessions.thread.compactedFrom', defaultMessage: '{tokens} tokens before' },
            { tokens: before >= 1000 ? `${Math.round(before / 1000)}k` : String(before) },
          )}
        </span>
      )}
    </ThreadMark>
  );
}

/** An MCP server of the runtime failed to start; the error is cut to one line. */
function McpStartNotice(props: { event: DaemonEvent; enter: string }) {
  const { server, error } = mcpStartFailure(props.event)!;
  return (
    <ThreadMark glyph={<Unplug />} at={props.event.created_at} enter={props.enter}>
      <span>
        {t(
          {
            id: 'sessions.thread.mcpStartFailed',
            defaultMessage: 'MCP server {name} did not start',
          },
          { name: server },
        )}
      </span>
      {error && (
        <span className="ss-marki" title={error}>
          {error}
        </span>
      )}
    </ThreadMark>
  );
}

/** A resident session took over from the one before it; its button shows how the handoff note changed. */
export function ChapterMark({ event }: { event: DaemonEvent }) {
  const {
    chapter,
    handoff_memory_id: handoff,
    previous_memory_id: previous,
  } = event.payload as AgentChapterStartedPayload;
  const [notes, setNotes] = useState<{ lines: DiffLine[] } | { error: string } | null>(null);
  // The note it replaced is no longer current, so memory.get refuses it; the key's history has it.
  const load = async () => {
    setNotes(null);
    const note = await runCommand('memory.get', { memory_id: handoff }, null);
    if (!note.ok) return setNotes({ error: failureText(note.error) });
    const { key, text } = note.value as { key: string; text: string };
    const history = await runCommand(
      'memory.history',
      { project_id: event.project_id, key, limit: 50 },
      null,
    );
    if (!history.ok) return setNotes({ error: failureText(history.error) });
    const before = (history.value as { items: { id: string; text: string }[] }).items.find(
      (item) => item.id === previous,
    );
    setNotes({ lines: diffLines(before?.text ?? '', text) });
  };
  const lines = notes && 'lines' in notes ? notes.lines : null;
  const noteLabel = t({ id: 'sessions.thread.handoffNote', defaultMessage: 'Handoff note' });
  return (
    <ThreadMark glyph={<span className="ss-gmile" />} at={event.created_at}>
      <span>
        {t(
          { id: 'sessions.thread.chapter', defaultMessage: 'Chapter {chapter} started' },
          { chapter },
        )}
      </span>
      {handoff && previous ? (
        <Popover.Root
          onOpenChange={(open) => {
            if (open && !lines) void load();
          }}
        >
          <Popover.Trigger className="btn sm">
            {t({ id: 'sessions.thread.handoffChanges', defaultMessage: 'Handoff changes' })}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" sideOffset={6} style={{ zIndex: 40 }}>
              <Popover.Popup
                className="pop ss-hop"
                aria-label={t({
                  id: 'sessions.thread.handoffDiff',
                  defaultMessage: 'Handoff note changes',
                })}
              >
                <div className="ss-hoh">
                  <span>{noteLabel}</span>
                  {lines && (
                    <span className="ss-hoc">
                      <DiffCounts
                        additions={lines.filter((line) => line.kind === 'add').length}
                        deletions={lines.filter((line) => line.kind === 'del').length}
                      />
                    </span>
                  )}
                  <Popover.Close
                    className="ib"
                    aria-label={t({ id: 'sessions.thread.handoffClose', defaultMessage: 'Close' })}
                  >
                    <X aria-hidden="true" />
                  </Popover.Close>
                </div>
                {lines ? (
                  <div className="ss-hod">
                    {lines.map((line, i) => (
                      <div key={i} data-kind={line.kind}>
                        <span>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
                        <span>{line.text}</span>
                      </div>
                    ))}
                  </div>
                ) : notes && 'error' in notes ? (
                  <LoadError message={notes.error} onRetry={() => void load()} />
                ) : (
                  <div className="ss-hod" aria-busy="true">
                    <Skeleton style={{ height: 10, width: '70%' }} />
                    <Skeleton style={{ height: 10, width: '45%' }} />
                  </div>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        handoff && (
          <button type="button" className="btn sm" onClick={() => openMemory(handoff)}>
            {noteLabel}
          </button>
        )
      )}
    </ThreadMark>
  );
}

function AgentEvent(props: { event: DaemonEvent; verbose: boolean; enter: string }) {
  const { event, verbose } = props;
  const row = (
    <div className={verbose ? 'tr-evt' : `tr-evt${props.enter}`}>
      <span className="mono mu">{event.kind.slice('agent.'.length)}</span>
      <span>{eventSummary(event)}</span>
    </div>
  );
  return verbose ? (
    <div className={`tr-evd${props.enter}`}>
      {row}
      <pre className="tr-pre">{json(event.payload)}</pre>
    </div>
  ) : (
    row
  );
}
