import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import { PreviewCard } from '@base-ui/react/preview-card';
import { Ellipsis, FolderOpen } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { DiffStat } from '../../components/DiffReview';
import { LeadCrown } from '../../components/LeadCrown';
import { ModelMark, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import {
  GateMark,
  MergeBlockedMark,
  lastTurnLabel,
  recapLine,
  sessionGlyphName,
  sessionStateLabel,
  sessionStateTone,
} from '../../components/SessionStateIcon';
import { KeyHint } from '../../components/Shortcuts';
import { ageText } from '../../data/needs-you';
import { type ModelsState } from '../../data/runtime-models';
import { elapsedText } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { shortcutMatches } from '../../lib/shortcuts';
import { useShell } from '../../store';
import { tokenText } from '../board/panels-model';
import {
  EFFORT_LABEL,
  needsAttention,
  permissionModeLabel,
  sessionRow,
  turnErrorText,
  type TreeLine,
} from './model';
import { aheadText, gateCounts, sessionBranch } from './inspector-model';
import { ringTone } from './run-model';
import { runningModel } from './thread-model';
import { GATE_NAME, GateSeg, UNCOUNTED_GATE } from './SessionHeader';
import { FIT_MENU, useSessionMenu } from './shared';
import './session-row.css';

/** A corner mark: its kind, its name and, for a session state, the colour the state glyph has. */
interface Badge {
  kind: string;
  label: string;
  tone?: string;
}

/**
 * The one corner mark of a listed session, first match in this order; a state is named and coloured
 * as SessionStateIcon draws it. An idle read session has none.
 */
function badgeOf(s: WorkbenchSession, unread: boolean): Badge | null {
  const state = {
    kind: sessionGlyphName(s),
    label: sessionStateLabel(s),
    tone: sessionStateTone(s),
  };
  if (s.stopping || s.reconciling) return state;
  if (s.merge?.failure_class === 'environment')
    return {
      kind: 'environment',
      label: t({ id: 'sessions.sidebar.badge.environment', defaultMessage: 'Environment broken' }),
      tone: '--bad',
    };
  if (s.state === 'waiting' || s.state === 'failed') return state;
  if (needsAttention(s) || s.last_turn?.state === 'failed')
    return {
      kind: 'failed',
      label: t({ id: 'sessions.row.badge.failed', defaultMessage: 'Failed' }),
      tone: '--bad',
    };
  if (['starting', 'running', 'merging'].includes(s.state)) return state;
  if (s.last_turn?.state === 'queued')
    return {
      kind: 'queued',
      label: t({ id: 'sessions.row.badge.queued', defaultMessage: 'Queued' }),
    };
  if (s.state === 'ready') return state;
  if (unread)
    return {
      kind: 'unread',
      label: t({ id: 'sessions.sidebar.badge.unread', defaultMessage: 'New result' }),
      tone: '--ink',
    };
  return null;
}

/** The runtime glyph with the session's status mark on its corner. */
function Avatar({ session, unread = false }: { session: WorkbenchSession; unread?: boolean }) {
  const badge = badgeOf(session, unread);
  return (
    <span className="ss-av">
      <RuntimeGlyph runtime={session.runtime} />
      {badge && (
        <span
          className="ss-badge"
          role="img"
          aria-label={badge.label}
          data-badge={badge.kind}
          style={badge.tone ? ({ '--c': `var(${badge.tone})` } as CSSProperties) : undefined}
        />
      )}
    </span>
  );
}

/** When the session opened, with the day unless it is the day of `now`. */
function openedText(s: WorkbenchSession, now: number): string {
  const at = Date.parse(s.created_at);
  const today = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(today ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

export function SessionRowButton(props: {
  session: WorkbenchSession;
  on: boolean;
  unread?: boolean;
  now: number;
  onSelect: (e: MouseEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  /** The tree columns before a session listed under the one it came from. */
  tree?: readonly TreeLine[];
  /** Whether board task sessions were opened from this one. */
  lead?: boolean;
  /** Its place among the rows ⌘1 to ⌘9 open. */
  number?: number;
  /** Picked with the list's select key; apart from the shown session and the keyboard focus. */
  selected?: boolean;
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { session } = props;
  const row = sessionRow(session);
  // A session on this machine has no device mark.
  const device = session.device_id && session.device_id !== 'local' ? session.device_id : null;
  const blocked = session.merge?.state === 'blocked';
  const turnResult = lastTurnLabel(session);
  const recap = recapLine(session.recap, session.state === 'waiting');
  const inPlace = session.workspace_kind === 'in_place';
  const name = [
    row.title,
    ...(inPlace
      ? [t({ id: 'sessions.screen.inPlace', defaultMessage: 'Session in its own folder' })]
      : []),
    runtimeName(session.runtime),
    ...(device
      ? [t({ id: 'sessions.row.device', defaultMessage: 'On {device}' }, { device })]
      : []),
    sessionStateLabel(session),
    ...(turnResult ? [turnResult] : []),
    ...(recap ? [recap] : []),
    ...(session.waiting > 0
      ? [
          t(
            { id: 'sessions.screen.waiting', defaultMessage: '{count} waiting' },
            { count: session.waiting },
          ),
        ]
      : []),
    ...(session.gate ? [GATE_NAME[session.gate.state]] : []),
    ...(blocked
      ? [t({ id: 'sessions.screen.mergeBlocked', defaultMessage: 'Merge blocked' })]
      : []),
    ...(props.lead
      ? [t({ id: 'components.leadCrown.label', defaultMessage: 'Lead session' })]
      : []),
    ...(props.unread ? [t({ id: 'sessions.screen.unread', defaultMessage: 'Unread' })] : []),
    ...(props.selected ? [t({ id: 'sessions.row.selected', defaultMessage: 'Selected' })] : []),
  ].join(t({ id: 'sessions.screen.separator', defaultMessage: ', ' }));
  const fork = !!session.forked_from;
  return (
    <button
      type="button"
      className={`ss-row${props.on ? ' on' : ''}`}
      aria-current={props.on || undefined}
      aria-label={name}
      data-unread={props.unread || undefined}
      data-selected={props.selected || undefined}
      data-session={session.id}
      tabIndex={props.tabIndex}
      onClick={props.onSelect}
      onKeyDown={props.onKeyDown}
      onContextMenu={props.onContextMenu}
    >
      {props.tree?.map((line, i) => (
        <span
          key={i}
          className="ss-tw"
          data-line={line}
          data-fork={(fork && i === props.tree!.length - 1) || undefined}
          aria-hidden="true"
        />
      ))}
      <Avatar session={session} unread={props.unread} />
      {recap ? (
        <span className="ss-two">
          <span className="ss-ttl">{row.title}</span>
          <span className="ss-sub">{recap}</span>
        </span>
      ) : (
        <span className="ss-ttl">{row.title}</span>
      )}
      {props.lead && <LeadCrown />}
      {device && <span className="chip mono ss-dev">{device}</span>}
      <span className="ss-time">{ageText(Date.parse(session.last_activity_at), props.now)}</span>
      {props.number !== undefined && <KeyHint id="session-number" digit={props.number} />}
    </button>
  );
}

const LIVE = ['starting', 'running', 'waiting', 'merging'];

const CONTEXT_TONE = { none: '--run', ac2: '--run', wait: '--wait', bad: '--bad' };

/**
 * What the row leaves out, beside it on hover or keyboard focus: model and effort, permissions,
 * changes, checks and merge, where it came from and how long it has run.
 */
export function SessionPreview(props: {
  session: WorkbenchSession;
  now: number;
  /** The model list of the session's runtime, which names a default model and effort. */
  models?: ModelsState;
  /** The title of the session it was opened or forked from. */
  source?: string;
}) {
  const { session: s } = props;
  const changed = s.changes && s.changes.files > 0 ? s.changes : null;
  const mode = permissionModeLabel(s.runtime, s.permission_mode);
  const turn = s.last_turn?.state === 'failed' ? (turnErrorText(s) ?? lastTurnLabel(s)) : null;
  const end = LIVE.includes(s.state) || s.stopping ? props.now : Date.parse(s.last_activity_at);
  // The preview reads no folder facts: a detached worktree shows only how far it is ahead and behind.
  const branch = sessionBranch(s, null);
  const branchText =
    branch && [...(branch.name === null ? [] : [branch.name]), ...aheadText(branch)].join(' ');
  const counts = gateCounts(s.gate);
  const contextShare = s.context ? s.context.used_tokens / s.context.window_tokens : null;
  const contextPercent = Math.min(100, Math.round((contextShare ?? 0) * 100));
  const approval =
    s.waiting_request && (s.waiting_kind ?? 'approval') === 'approval'
      ? t(
          {
            id: 'sessions.row.preview.waitingApproval',
            defaultMessage: 'Waiting for approval: {detail}',
          },
          { detail: s.waiting_request.detail ?? s.waiting_request.tool },
        )
      : null;
  const running =
    props.models?.state === 'ready' && !s.backend_id
      ? runningModel(props.models.models, s.model, s.effort)
      : { name: s.model ?? runtimeName(s.runtime), effort: s.effort };
  const modelLine = listText(running.name, running.effort && EFFORT_LABEL[running.effort], mode);
  const facts: [string, ReactNode][] = [
    ...(s.workspace_kind === 'in_place'
      ? [
          [
            t({ id: 'sessions.row.preview.where', defaultMessage: 'Where' }),
            <span className="ss-hc-v">
              <FolderOpen className="ic-sm" aria-hidden="true" />
              {t({ id: 'sessions.screen.inPlace', defaultMessage: 'Session in its own folder' })}
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(branchText
      ? [
          [
            t({ id: 'sessions.row.preview.branch', defaultMessage: 'Branch' }),
            <span className="ss-hc-cut mono">{branchText}</span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(changed
      ? [
          [
            t({ id: 'sessions.row.preview.changes', defaultMessage: 'Changes' }),
            <span className="ss-hc-v">
              <span className="ss-chg">
                <DiffCounts additions={changed.additions} deletions={changed.deletions} />
              </span>
              <DiffStat additions={changed.additions} deletions={changed.deletions} />
              <span className="ss-hc-mu">
                {t(
                  {
                    id: 'sessions.row.preview.files',
                    defaultMessage: '{count, plural, one {# file} other {# files}}',
                  },
                  { count: changed.files },
                )}
              </span>
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(s.gate
      ? [
          [
            t({ id: 'sessions.row.preview.checks', defaultMessage: 'Checks' }),
            counts ? (
              <span className="ss-hc-v">
                {UNCOUNTED_GATE.has(s.gate.state) && (
                  <>
                    <GateMark gate={s.gate} />
                    {GATE_NAME[s.gate.state]}
                  </>
                )}
                <GateSeg {...counts} grow />
                <span className="ss-hc-mu ss-hc-n">{`${counts.passed} / ${counts.total}`}</span>
              </span>
            ) : (
              <span className="ss-hc-v">
                <GateMark gate={s.gate} />
                {GATE_NAME[s.gate.state]}
              </span>
            ),
          ] as [string, ReactNode],
        ]
      : []),
    ...(s.merge?.state === 'blocked'
      ? [
          [
            t({ id: 'sessions.row.preview.merge', defaultMessage: 'Merge' }),
            <span className="ss-hc-v">
              <MergeBlockedMark merge={s.merge} />
              {t({ id: 'sessions.screen.mergeBlocked', defaultMessage: 'Merge blocked' })}
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(s.context
      ? [
          [
            t({ id: 'sessions.row.preview.context', defaultMessage: 'Context' }),
            <span className="ss-hc-v">
              <span
                className="meter"
                role="meter"
                aria-label={t({ id: 'sessions.row.preview.context', defaultMessage: 'Context' })}
                aria-valuenow={contextPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                style={
                  {
                    '--v': `${contextPercent}%`,
                    '--c': `var(${CONTEXT_TONE[ringTone(contextShare)]})`,
                  } as CSSProperties
                }
              >
                <i />
              </span>
              <span className="ss-hc-mu ss-hc-n">{tokenText(s.context.used_tokens)}</span>
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(props.source
      ? [
          [
            t({ id: 'sessions.row.preview.source', defaultMessage: 'From' }),
            s.lead
              ? t(
                  {
                    id: 'sessions.sidebar.preview.openedBy',
                    defaultMessage: 'Opened by {source}, {time}',
                  },
                  { source: props.source, time: openedText(s, props.now) },
                )
              : t(
                  {
                    id: 'sessions.sidebar.preview.forkedFrom',
                    defaultMessage: 'Forked from {source}, {time}',
                  },
                  { source: props.source, time: openedText(s, props.now) },
                ),
          ] as [string, ReactNode],
        ]
      : []),
    [
      t({ id: 'sessions.row.preview.elapsed', defaultMessage: 'Time' }),
      <span className="ss-hc-n">{elapsedText(end - Date.parse(s.created_at))}</span>,
    ],
  ];
  return (
    <>
      <div className="ss-hc-h">
        <span className="ss-hc-v">
          <Avatar session={s} />
          <b className="ss-hc-cut">{sessionRow(s).title}</b>
        </span>
        {approval ? (
          <span className="ss-hc-mu ss-hc-cut" title={approval}>
            {approval}
          </span>
        ) : (
          <span className="ss-hc-mu">
            {listText(
              sessionStateLabel(s),
              turn,
              s.waiting > 0 &&
                t(
                  { id: 'sessions.screen.waiting', defaultMessage: '{count} waiting' },
                  { count: s.waiting },
                ),
            )}
          </span>
        )}
      </div>
      <span className="ss-hc-v">
        <RuntimeGlyph runtime={s.runtime} />
        <ModelMark model={s.model} beside={s.runtime} />
        <span className="ss-hc-cut" title={modelLine}>
          {modelLine}
        </span>
      </span>
      <dl className="ss-hc-kv">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** A sidebar row with its menu, opened by right-click or by its menu button, and its preview. */
export function SessionListRow(props: {
  session: WorkbenchSession;
  on: boolean;
  unread?: boolean;
  now: number;
  onSelect: () => void;
  /** 0 on the list's one tab stop, -1 on the other rows. */
  tabIndex?: number;
  /** Called as either menu of the row opens or closes. */
  onMenu?: (open: boolean) => void;
  tree?: readonly TreeLine[];
  lead?: boolean;
  number?: number;
  selected?: boolean;
  /** The title of the session it was opened or forked from. */
  source?: string;
  models?: ModelsState;
}) {
  const { session } = props;
  const {
    items,
    popupMenu,
    error,
    dialog,
    askDelete,
    askRename,
    archive,
    openWindow,
    openBeside,
    onOpenChange,
  } = useSessionMenu(session);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const renaming = useShell((s) => s.renaming === session.id && !props.on);
  useEffect(() => {
    if (!renaming) return;
    useShell.getState().renameSession(null);
    askRename();
  }, [renaming]);
  const contextMenu = (open: boolean) => {
    onOpenChange(open);
    props.onMenu?.(open);
  };
  const openMenu = (open: boolean) => {
    setMenu(open);
    contextMenu(open);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (shortcutMatches('list-menu', e)) openMenu(true);
    else if (shortcutMatches('list-delete', e)) askDelete();
    else if (shortcutMatches('session-archive', e)) archive?.();
    else return;
    e.preventDefault();
  };
  // ⌘-click opens the session in a window of its own and leaves this window as it is; ⌥-click beside the shown one.
  const select = (e: MouseEvent<HTMLButtonElement>) =>
    e.metaKey && openWindow
      ? openWindow()
      : e.altKey && openBeside
        ? openBeside()
        : props.onSelect();
  const nativeMenu =
    popupMenu &&
    ((e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      contextMenu(true);
      void popupMenu('row').finally(() => contextMenu(false));
    });
  const rowButton = (
    <SessionRowButton
      session={session}
      on={props.on}
      unread={props.unread}
      now={props.now}
      onSelect={select}
      tabIndex={props.tabIndex}
      onKeyDown={onKeyDown}
      tree={props.tree}
      lead={props.lead}
      number={props.number}
      selected={props.selected}
      onContextMenu={nativeMenu ?? undefined}
    />
  );

  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger
        delay={400}
        closeDelay={150}
        render={<div ref={box} className="sb-row" />}
      >
        {nativeMenu ? (
          rowButton
        ) : (
          <ContextMenu.Root onOpenChange={contextMenu}>
            <ContextMenu.Trigger>{rowButton}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              {/* Without an explicit flip a context menu shifts over the list instead of opening upward. */}
              <ContextMenu.Positioner
                style={{ zIndex: 40 }}
                collisionAvoidance={{ side: 'flip', fallbackAxisSide: 'none' }}
              >
                <ContextMenu.Popup className="mn mn-menu pop" style={FIT_MENU}>
                  {items('row')}
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        )}
        <Menu.Root open={menu} onOpenChange={openMenu}>
          <Menu.Trigger
            className="ib sb-more"
            aria-label={t({
              id: 'sessions.screen.sessionActions',
              defaultMessage: 'Session actions',
            })}
            tabIndex={-1}
          >
            <Ellipsis aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
              {/* The menu button is out of the tab order; the row holds the list's keys. */}
              <Menu.Popup
                className="mn mn-menu pop"
                style={FIT_MENU}
                finalFocus={() => box.current?.querySelector<HTMLElement>('[data-session]') ?? true}
              >
                {items('more')}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {error && (
          <span className="tr-err" role="alert" title={error}>
            {error}
          </span>
        )}
        {dialog}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="right" align="start" sideOffset={8} style={{ zIndex: 40 }}>
          <PreviewCard.Popup className="pop ss-hc">
            <SessionPreview
              session={session}
              now={props.now}
              source={props.source}
              models={props.models}
            />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
