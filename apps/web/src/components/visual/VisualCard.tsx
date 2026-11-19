import { Component, useMemo, useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  Braces,
  ChartCandlestick,
  ChartColumn,
  ChartGantt,
  CodeXml,
  Maximize2,
  MessageSquare,
  Network,
  Pin,
  ShieldCheck,
  Table,
  Workflow,
  X,
} from 'lucide-react';
import type { Visual, VisualContent } from '@pantheon/domain';
import { canMessage } from '../../data/ask-debug';
import { useBoard } from '../../data/board';
import { failureText } from '../../data/needs-you';
import { sessionTitle, type Session } from '../../data/transcript';
import { pinVisual, unpinVisual, useVisual, type VisualSize } from '../../data/visuals';
import { currentLocale, t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { dayText } from '../../lib/time-text';
import { scrimFlag } from '../../lib/root-flag';
import { askFix } from '../../screens/sessions/panel';
import { useShell } from '../../store';
import { RUNNING, RunningFor } from '../RunningFor';
import { noticeResult, toast } from '../Toast';
import { Tip } from '../Tip';
import { GraphDiagram, GraphNodeInfo } from './GraphDiagram';
import { KlineChart } from './KlineChart';
import { MermaidDiagram } from './MermaidDiagram';
import { nativeType } from './mermaid-model';
import { SandboxFrame } from './SandboxFrame';
import { Drawing } from './shared';
import { TableVisual } from './TableVisual';
import { TimelineChart } from './TimelineChart';
import { VegaChart } from './VegaChart';
import { VisualError } from './VisualError';
import '../state-icon.css';
import './visual.css';

/** Picture heights in px. */
const HEIGHT: Record<VisualSize, number> = { S: 160, M: 280, L: 420 };
const ZOOM_HEIGHT = 640;

// Getters, so each name is read in the language loaded by then.
const KIND_NAME: Record<VisualContent['kind'], string> = {
  get kline() {
    return t({ id: 'visual.kind.kline', defaultMessage: 'Candlestick chart' });
  },
  get 'vega-lite'() {
    return t({ id: 'visual.kind.vegaLite', defaultMessage: 'Chart' });
  },
  get mermaid() {
    return t({ id: 'visual.kind.mermaid', defaultMessage: 'Mermaid diagram' });
  },
  get graph() {
    return t({ id: 'visual.kind.graph', defaultMessage: 'Graph' });
  },
  get html() {
    return t({ id: 'visual.kind.html', defaultMessage: 'Sandboxed page' });
  },
  get table() {
    return t({ id: 'visual.kind.table', defaultMessage: 'Table' });
  },
  get timeline() {
    return t({ id: 'visual.timeline.kind', defaultMessage: 'Timeline' });
  },
};

const KIND_ICON: Record<VisualContent['kind'], ReactNode> = {
  kline: <ChartCandlestick />,
  'vega-lite': <ChartColumn />,
  mermaid: <Workflow />,
  graph: <Network />,
  html: <CodeXml />,
  table: <Table />,
  timeline: <ChartGantt />,
};

const points = (count: number) =>
  t(
    { id: 'visual.card.points', defaultMessage: '{count, plural, one {# point} other {# points}}' },
    { count },
  );

/** Counts in the header: points of a chart, nodes and edges of a graph. */
function facts(content: VisualContent): string[] {
  switch (content.kind) {
    case 'kline':
      return [points(content.spec.candles.length)];
    case 'vega-lite': {
      const values = (content.spec.data as { values?: unknown } | undefined)?.values;
      return Array.isArray(values) ? [points(values.length)] : [];
    }
    case 'graph':
      return [
        t(
          {
            id: 'visual.card.nodes',
            defaultMessage: '{count, plural, one {# node} other {# nodes}}',
          },
          { count: content.spec.nodes.length },
        ),
        t(
          {
            id: 'visual.card.edges',
            defaultMessage: '{count, plural, one {# edge} other {# edges}}',
          },
          { count: content.spec.edges.length },
        ),
      ];
    case 'table':
      return [
        t(
          { id: 'visual.card.rows', defaultMessage: '{count, plural, one {# row} other {# rows}}' },
          { count: content.spec.rows.length },
        ),
        t(
          {
            id: 'visual.card.columns',
            defaultMessage: '{count, plural, one {# column} other {# columns}}',
          },
          { count: content.spec.columns.length },
        ),
      ];
    case 'timeline':
      return [
        t(
          {
            id: 'visual.timeline.items',
            defaultMessage: '{count, plural, one {# item} other {# items}}',
          },
          { count: content.spec.items.length },
        ),
      ];
    case 'mermaid':
    case 'html':
      return [];
  }
}

/** The spec as it was drawn: the source of a diagram or page, else its JSON. */
function specText(content: VisualContent, invalid: boolean): string {
  // A spec that failed its check may not have the shape of its kind.
  if (invalid) return JSON.stringify(content.spec, null, 2) ?? String(content.spec);
  switch (content.kind) {
    case 'mermaid':
      return content.spec.source;
    case 'html':
      return content.spec.html;
    default:
      return JSON.stringify(content.spec, null, 2);
  }
}

/** The `title` of a mermaid diagram's front matter. */
function diagramTitle(content: VisualContent): string | undefined {
  if (content.kind !== 'mermaid') return undefined;
  const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(String(content.spec.source))?.[1];
  const title = front && /^title:\s*(.+)$/m.exec(front)?.[1]?.trim();
  return title ? title.replace(/^(['"])(.*)\1$/, '$2') : undefined;
}

type Issue = NonNullable<Visual['error']>[number];

/** A field path as written in code, such as `series[0].data[41].high`. */
const pathText = (path: Issue['path']): string =>
  path.map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? key : `.${key}`)).join('');

/** Shows what a renderer threw in place of its picture, so the other cards keep drawing. */
export class VisualBoundary extends Component<
  {
    content: VisualContent;
    children: ReactNode;
    onViewSpec: () => void;
    onFix?: ((error: string) => Promise<string | null>) | undefined;
  },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidUpdate(previous: { content: VisualContent }) {
    if (previous.content !== this.props.content && this.state.error) this.setState({ error: null });
  }
  render() {
    const { error } = this.state;
    const { onViewSpec, onFix } = this.props;
    if (!error) return this.props.children;
    return (
      <VisualError
        message={t({ id: 'visual.error.failed', defaultMessage: 'The visual could not be drawn' })}
        error={error.message}
        onFix={onFix}
        onViewSpec={onViewSpec}
      />
    );
  }
}

function picture(
  content: VisualContent,
  height: number,
  /** A graph taller than the height grows the card, as a conversation visual does. */
  grows: boolean,
  network: boolean,
  onBlocked: (url: string) => void,
  onViewSpec: () => void,
  onFix: ((error: string) => Promise<string | null>) | undefined,
  /** Set in the Enlarge dialog: a graph draws at full size and reports the node picked. */
  onInspect?: (id: string | undefined) => void,
): ReactNode {
  switch (content.kind) {
    case 'kline':
      return <KlineChart spec={content.spec} height={height} />;
    case 'vega-lite':
      return <VegaChart spec={content.spec} height={height} />;
    case 'mermaid':
      return (
        <MermaidDiagram
          spec={content.spec}
          height={height}
          grows={grows}
          {...(onInspect && { full: true })}
        />
      );
    case 'graph':
      return (
        <GraphDiagram
          spec={content.spec}
          height={height}
          grows={grows}
          {...(onInspect && { full: true, onSelect: onInspect })}
        />
      );
    case 'html':
      return (
        <SandboxFrame
          spec={content.spec}
          height={height}
          network={network}
          onBlocked={onBlocked}
          onFix={onFix}
          onViewSpec={onViewSpec}
        />
      );
    case 'table':
      return <TableVisual spec={content.spec} />;
    case 'timeline':
      return <TimelineChart spec={content.spec} height={height} grows={grows} />;
  }
}

/**
 * A titled picture with its counts and the zoom and spec actions, shown on hover; `facts` follow
 * the counts, `meta` adds facts and controls at the end of the header, `action` adds buttons before
 * the zoom.
 */
export function VisualFrame({
  title,
  content,
  size,
  facts: more,
  meta,
  action,
  footer,
  replace,
  inline = false,
  stale = false,
  source,
  issues,
  onFix,
}: {
  /** Absent for a block in a message, which is named by its diagram's own title, else its kind. */
  title?: string;
  content: VisualContent;
  size: VisualSize;
  facts?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  /** Shown instead of the picture, such as the source of a block in a message. */
  replace?: ReactNode;
  /** Conversation visuals share the message surface. */
  inline?: boolean;
  /** The picture is out of date, so it shows greyed. */
  stale?: boolean;
  /** Where the data came from, as the drawing session named it. */
  source?: string | undefined;
  /** Why the spec failed its kind check; the picture is not drawn. */
  issues?: Issue[] | undefined;
  /** Asks the session that drew the picture to fix the error it failed with; absent when it cannot. */
  onFix?: ((error: string) => Promise<string | null>) | undefined;
}) {
  const kind = KIND_NAME[content.kind];
  const titled = title ?? diagramTitle(content);
  const name = titled ?? kind;
  const first = issues?.[0];
  const invalid = first !== undefined;
  const counts = invalid ? [] : facts(content);
  const label =
    titled === undefined
      ? kind
      : counts.length === 0
        ? t({ id: 'visual.card.label', defaultMessage: '{title}, {kind}' }, { title: titled, kind })
        : t(
            { id: 'visual.card.labelCounts', defaultMessage: '{title}, {kind}, {counts}' },
            {
              title: titled,
              kind,
              counts: new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(counts),
            },
          );
  // Network access holds for this card only while it stays open; nothing is saved.
  const [network, setNetwork] = useState(false);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [inspected, setInspected] = useState<string | undefined>(undefined);
  const onBlocked = (url: string) => {
    const host = new URL(url).host;
    setBlocked((hosts) => (hosts.includes(host) ? hosts : [...hosts, host]));
  };
  // The candlestick chart holds its range control, a table its rows, and a graph and a timeline
  // their focusable items, which a picture would hide.
  const role =
    inline ||
    invalid ||
    content.kind === 'kline' ||
    content.kind === 'table' ||
    content.kind === 'graph' ||
    content.kind === 'timeline' ||
    (content.kind === 'mermaid' &&
      /^(?:flowchart|state)$/.test(nativeType(content.spec.source) ?? ''))
      ? 'group'
      : 'img';
  const viewSpecOpen = () => setSpecOpen(true);
  const spec = specText(content, invalid);
  // The fix sends every issue, though the card shows the first.
  const issueText = issues?.map((issue) => `${pathText(issue.path)}: ${issue.message}`).join('\n');
  const drawn = (height: number, grows: boolean, onInspect?: (id: string | undefined) => void) =>
    first ? (
      <VisualError
        message={t(
          { id: 'visual.error.invalid', defaultMessage: 'The spec failed its check: {message}' },
          { message: first.message },
        )}
        error={pathText(first.path)}
        onFix={onFix && (() => onFix(issueText!))}
        onViewSpec={viewSpecOpen}
      />
    ) : (
      <VisualBoundary content={content} onViewSpec={viewSpecOpen} onFix={onFix}>
        {picture(content, height, grows, network, onBlocked, viewSpecOpen, onFix, onInspect)}
      </VisualBoundary>
    );
  const body = (height: number, grows = false, onInspect?: (id: string | undefined) => void) =>
    replace ?? (
      <div
        className="vis-body"
        role={role}
        aria-label={label}
        data-stale={stale || undefined}
        style={
          grows &&
          (content.kind === 'graph' || content.kind === 'mermaid' || content.kind === 'timeline')
            ? { minHeight: height }
            : { height }
        }
      >
        {drawn(height, grows, onInspect)}
      </div>
    );
  const zoom = t({ id: 'visual.card.zoom', defaultMessage: 'Enlarge' });
  const viewSpec = t({ id: 'visual.card.viewSpec', defaultMessage: 'View spec' });
  const close = t({ id: 'visual.card.close', defaultMessage: 'Close' });
  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (!open) setInspected(undefined);
      }}
    >
      <section className="vis" data-inline={inline || undefined} aria-label={name}>
        <div className="vis-h">
          <span className="vis-ic" aria-hidden="true">
            {KIND_ICON[content.kind]}
          </span>
          <span className="vis-t">{name}</span>
          {content.kind === 'html' && (
            <>
              <span className="chip">
                <ShieldCheck aria-hidden="true" />
                {t({ id: 'visual.card.sandbox', defaultMessage: 'Sandbox' })}
              </span>
              <span className="vis-meta">
                {network
                  ? t({ id: 'visual.card.online', defaultMessage: 'Network allowed once' })
                  : t({ id: 'visual.card.offline', defaultMessage: 'Offline' })}
              </span>
            </>
          )}
          {(counts.length > 0 || more) && (
            <span className="vis-meta">
              {counts.map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
              {more}
            </span>
          )}
          <span className="vis-end">
            {meta}
            <span className="vis-acts">
              {action}
              <Tip content={zoom}>
                <Dialog.Trigger className="ib vis-hov" aria-label={zoom}>
                  <Maximize2 aria-hidden="true" />
                </Dialog.Trigger>
              </Tip>
              <Dialog.Root open={specOpen} onOpenChange={setSpecOpen}>
                <Tip content={viewSpec}>
                  <Dialog.Trigger className="ib vis-hov" aria-label={viewSpec}>
                    <Braces aria-hidden="true" />
                  </Dialog.Trigger>
                </Tip>
                <Dialog.Portal>
                  <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
                  <Dialog.Popup className="vis-dlg pop">
                    <div className="vis-h">
                      <span className="vis-ic" aria-hidden="true">
                        <Braces />
                      </span>
                      <Dialog.Title className="vis-t">
                        {t({ id: 'visual.card.specOf', defaultMessage: 'Spec: {name}' }, { name })}
                      </Dialog.Title>
                      <span className="vis-acts">
                        <Dialog.Close className="ib" aria-label={close}>
                          <X aria-hidden="true" />
                        </Dialog.Close>
                      </span>
                    </div>
                    <pre className="vis-spec">{spec}</pre>
                  </Dialog.Popup>
                </Dialog.Portal>
              </Dialog.Root>
            </span>
          </span>
        </div>
        {blocked.length > 0 && !network && !offline && (
          <div
            className="vis-ask"
            role="group"
            aria-label={t({
              id: 'visual.sandbox.ask',
              defaultMessage: 'The page wants the network',
            })}
          >
            <span className="ss-dot waiting" aria-hidden="true" />
            <span className="vis-ask-t">
              {t({ id: 'visual.sandbox.wantsToReach', defaultMessage: 'The page wants to reach' })}
            </span>
            {blocked.map((host) => (
              <code key={host}>{host}</code>
            ))}
            <button type="button" className="btn sm pri" onClick={() => setNetwork(true)}>
              {t({ id: 'visual.sandbox.allowOnce', defaultMessage: 'Allow once' })}
            </button>
            <button type="button" className="btn sm" onClick={() => setOffline(true)}>
              {t({ id: 'visual.sandbox.deny', defaultMessage: 'Deny' })}
            </button>
          </div>
        )}
        {body(HEIGHT[size], inline)}
        {footer && <div className="vis-f">{footer}</div>}
      </section>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <Dialog.Popup className="vis-dlg pop">
          <div className="vis-h">
            <span className="vis-ic" aria-hidden="true">
              {KIND_ICON[content.kind]}
            </span>
            <Dialog.Title className="vis-t">{name}</Dialog.Title>
            {counts.length > 0 && (
              <span className="vis-meta">
                {counts.map((fact) => (
                  <span key={fact}>{fact}</span>
                ))}
              </span>
            )}
            <span className="vis-acts">
              <span className="kbd" aria-hidden="true">
                {keyText('Escape')}
              </span>
              <Dialog.Close className="ib" aria-label={close}>
                <X aria-hidden="true" />
              </Dialog.Close>
            </span>
          </div>
          <div className="vis-zoom">
            {body(ZOOM_HEIGHT, false, setInspected)}
            <aside
              className="vis-insp"
              style={{ height: ZOOM_HEIGHT }}
              aria-label={t({ id: 'visual.card.inspector', defaultMessage: 'Spec and source' })}
            >
              {inspected !== undefined && content.kind === 'graph' && (
                <GraphNodeInfo spec={content.spec} id={inspected} />
              )}
              <section>
                <h2 className="cap">{t({ id: 'visual.card.spec', defaultMessage: 'Spec' })}</h2>
                <pre className="vis-spec">{spec}</pre>
              </section>
              {source && (
                <section>
                  <h2 className="cap">
                    {t({ id: 'visual.card.dataSource', defaultMessage: 'Source' })}
                  </h2>
                  <pre className="vis-insp-src">{source}</pre>
                </section>
              )}
            </aside>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Says the visual went onto its project's diagrams, with the way there and an undo. */
function noticePinned(visual: Visual) {
  noticeResult({
    tone: 'done',
    heading: t(
      { id: 'visual.card.pinned', defaultMessage: 'Pinned to Diagrams: {title}' },
      { title: visual.title },
    ),
    actions: [
      {
        label: t({ id: 'visual.card.openDiagrams', defaultMessage: 'Open Diagrams' }),
        run: () => useShell.getState().openProjectMemory(visual.project_id, 'diagrams'),
      },
      {
        label: t({ id: 'visual.card.undoPin', defaultMessage: 'Undo' }),
        run: () =>
          void unpinVisual(visual.id).then((failed) => {
            if (failed) toast({ title: failed, kind: 'failure' });
          }),
      },
    ],
  });
}

/** Sends the session that drew the visual its title, kind and error; resolves to why that failed. */
async function askToFix(session: Session, visual: Visual, error: string): Promise<string | null> {
  const result = await askFix(session.id, session.state, session.revision, [
    {
      id: `visual:${visual.id}:${visual.revision}`,
      kind: 'reference',
      label: visual.title,
      // Sent to the model, so it stays in one language.
      text: `The visual "${visual.title}" (${visual.kind}) failed to draw:\n\n${error}\n\nFix its spec and draw it again.`,
    },
  ]);
  return result.ok ? null : failureText(result.error);
}

/**
 * A drawn visual with its update time and the pin action; `size` is the picture height and the
 * size it pins at. Off the conversation it names its source session.
 */
export function VisualCard({
  visual,
  size,
  footer,
  inline,
  onRefresh,
  redrawable = true,
  refreshing = false,
  redrawSince = null,
  failed = false,
}: {
  visual: Visual;
  size: VisualSize;
  footer?: ReactNode;
  inline?: boolean;
  /** Asks the source session to draw this visual again; absent where a visual is not redrawn. */
  onRefresh?: () => void;
  /** False once the source session is deleted: the redraw stays, turned off. */
  redrawable?: boolean;
  refreshing?: boolean;
  /** When the turn asking the running redraw was sent. */
  redrawSince?: number | null;
  /** The last redraw asked ended without drawing it again. */
  failed?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const board = useBoard((s) => s.board);
  const drawer = board?.sessions.find((session) => session.id === visual.session_id);
  const source = inline ? undefined : drawer;
  const sourceTitle = source && sessionTitle(source, board!);
  const pinned = visual.pin !== undefined;
  const label = pinned
    ? t({ id: 'visual.card.unpin', defaultMessage: 'Pinned to Diagrams; click to unpin' })
    : t({ id: 'visual.card.pin', defaultMessage: 'Pin to Diagrams' });
  const toggle = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (pinned ? unpinVisual(visual.id) : pinVisual(visual.id, size)).then((failed) => {
      setBusy(false);
      setError(failed);
      if (!pinned && !failed) noticePinned(visual);
    });
  };
  const time = (
    <time dateTime={new Date(visual.updated_at).toISOString()}>
      {inline
        ? t(
            { id: 'visual.card.updated', defaultMessage: 'Updated {time}' },
            { time: dayText(visual.updated_at, Date.now(), { time: true }) },
          )
        : t(
            { id: 'visual.card.drawnAt', defaultMessage: 'Drawn {time}' },
            { time: dayText(visual.updated_at, Date.now(), { time: true }) },
          )}
    </time>
  );
  const held = refreshing || !redrawable;
  return (
    <VisualFrame
      title={visual.title}
      content={visual}
      size={size}
      inline={inline}
      source={visual.source}
      issues={visual.error}
      onFix={
        drawer && canMessage(drawer) ? (failure) => askToFix(drawer, visual, failure) : undefined
      }
      stale={failed}
      facts={
        failed ? (
          <span className="vis-fail" role="status">
            <span className="ss-dot failed" aria-hidden="true" />
            {t({ id: 'visual.card.redrawFailed', defaultMessage: 'Redraw failed' })}
          </span>
        ) : inline && !refreshing ? (
          time
        ) : undefined
      }
      meta={
        <>
          {source && (
            <button
              type="button"
              className="chip vis-from"
              aria-label={t(
                { id: 'visual.card.source', defaultMessage: 'Source session: {title}' },
                { title: sourceTitle },
              )}
              onClick={() => useShell.getState().openProjectSession(visual.project_id, source.id)}
            >
              <MessageSquare aria-hidden="true" />
              <span>{sourceTitle}</span>
            </button>
          )}
          {(refreshing || !inline) && (
            <span className="vis-meta">
              {refreshing ? <RunningFor label={RUNNING.redrawing} since={redrawSince} /> : time}
            </span>
          )}
          {onRefresh && !redrawable && (
            <span className="vis-meta" role="status">
              {t({ id: 'visual.card.cannotRedraw', defaultMessage: "Can't redraw" })}
            </span>
          )}
          {onRefresh && redrawable && failed && (
            <button type="button" className="btn sm" onClick={onRefresh}>
              {t({ id: 'visual.card.retry', defaultMessage: 'Retry' })}
            </button>
          )}
          {onRefresh && !(redrawable && failed) && (
            <button
              type="button"
              className="btn sm"
              aria-disabled={held || undefined}
              onClick={() => {
                if (!held) onRefresh();
              }}
            >
              {t({ id: 'visual.card.redraw', defaultMessage: 'Redraw' })}
            </button>
          )}
        </>
      }
      action={
        <Tip content={label}>
          <button
            type="button"
            className="ib vis-hov"
            aria-label={label}
            aria-pressed={pinned}
            aria-disabled={busy || undefined}
            onClick={toggle}
          >
            <Pin aria-hidden="true" />
          </button>
        </Tip>
      }
      footer={
        error || footer ? (
          <>
            {error && (
              <span className="vis-msg" role="alert">
                {error}
              </span>
            )}
            {footer}
          </>
        ) : undefined
      }
    />
  );
}

/**
 * The visual with this id as a card at the size it was drawn for, read and kept current; a line
 * says so once it is deleted.
 */
export function VisualById({ visualId }: { visualId: string }) {
  const read = useVisual(visualId);
  if (read.data) return <VisualCard visual={read.data} size={read.data.size ?? 'M'} inline />;
  if (read.gone)
    return (
      <p className="vis-gone">
        {t({ id: 'visual.card.deleted', defaultMessage: 'This visual was deleted' })}
      </p>
    );
  if (read.error)
    return (
      <p className="vis-gone" role="alert">
        {read.error}
      </p>
    );
  return (
    <div className="vis" data-inline>
      <div className="vis-fill" style={{ height: HEIGHT.M }}>
        <Drawing />
      </div>
    </div>
  );
}

/**
 * A placeholder for each visual the session's current turn is still drawing, with how much of its
 * spec has arrived; one goes once its draw call completes.
 */
export function VisualsDrawing({ sessionId }: { sessionId: string }) {
  const events = useBoard((s) => s.events);
  const drawing = useMemo(() => {
    const received = new Map<string, number>();
    const done = new Set<string>();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.aggregate_id !== sessionId) continue;
      if (event.kind === 'agent.turn.started') break;
      const payload = (event.payload ?? {}) as { tool_call_id?: unknown; received_bytes?: unknown };
      const call = payload.tool_call_id;
      if (typeof call !== 'string') continue;
      if (event.kind === 'agent.tool.completed') done.add(call);
      else if (
        event.kind === 'visual.drawing' &&
        typeof payload.received_bytes === 'number' &&
        !done.has(call) &&
        !received.has(call)
      )
        received.set(call, payload.received_bytes);
    }
    return [...received].reverse();
  }, [events, sessionId]);
  return drawing.map(([call, bytes]) => (
    <div key={`drawing-${call}`} className="vis" data-inline>
      <div className="vis-fill" style={{ height: HEIGHT.M }}>
        <Drawing received={bytes} />
      </div>
    </div>
  ));
}
