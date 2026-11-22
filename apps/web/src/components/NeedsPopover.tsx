import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { CircleCheck, Ellipsis } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { decisionText, nextKey, primaryAction } from '../data/attention';
import { useBoard } from '../data/board';
import { runCommand } from '../data/commands';
import { useCurrentProject } from '../data/current-project';
import { useDecisionsToday } from '../data/decisions-for-user';
import {
  ageText,
  failureText,
  needRowKey,
  reasonText,
  useNow,
  type NeedsYouItem,
} from '../data/needs-you';
import { visibleProjects } from '../data/projects';
import { sessionTitle } from '../data/transcript';
import { t } from '../i18n';
import { listText } from '../lib/list-text';
import { holdRootFlag } from '../lib/root-flag';
import type { SnapshotSession } from '../lib/snapshot-types';
import { needActions, needCommand, type NeedAction } from '../data/need-actions';
import { durationText } from '../lib/time-text';
import { openSettingsPage } from '../screens/settings/settings-jump';
import { runningSince, useProjectSessions } from '../shell/TrayPopover';
import { useShell } from '../store';
import { DiffCounts } from './DiffCounts';
import { ProjectMonogram } from './ProjectMonogram';
import { RuntimeGlyph } from './RuntimeGlyph';
import { GateMark, MergeBlockedGlyph, StateGlyph } from './SessionStateIcon';
import { Tip } from './Tip';
import './needs-popover.css';

interface ListRow {
  key: string;
  projectId: string;
  /** The session the row opens; without one it opens the project. */
  sessionId: string | undefined;
  /** Opens what the row is about instead of the session. */
  open?: () => void;
  /** Unix milliseconds the wait or run began; the oldest comes first. */
  since: number;
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  /** The files the item is about, under the detail. */
  files?: string;
  /** Shown under the row, outside its open button. */
  body?: ReactNode;
  actions?: ReactNode;
  end?: ReactNode;
  dim?: boolean;
  /** The row the user is on. */
  on?: boolean;
}

const STEPS: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };

/** Up, down, J and K move the focus between the rows' open buttons. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const step = STEPS[e.key];
  if (!step || e.metaKey || e.ctrlKey || e.altKey) return;
  const opens = [...e.currentTarget.querySelectorAll<HTMLElement>('.np-open')];
  const at = opens.findIndex((open) => open.parentElement?.contains(e.target as Node));
  const next = opens[at < 0 ? 0 : at + step];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

function openRow(row: ListRow) {
  if (row.open) row.open();
  else if (row.sessionId) useShell.getState().openProjectSession(row.projectId, row.sessionId);
  else useShell.getState().openProject(row.projectId);
}

/** The rows by project; projects and their rows in the order of their first row: oldest first. */
function byProject(rows: readonly ListRow[]): Map<string, ListRow[]> {
  const groups = new Map<string, ListRow[]>();
  for (const row of [...rows].sort((a, b) => a.since - b.since))
    groups.set(row.projectId, [...(groups.get(row.projectId) ?? []), row]);
  return groups;
}

function listPopover(props: {
  trigger: ReactElement;
  open: boolean;
  setOpen: (open: boolean) => void;
  label: string;
  rows: readonly ListRow[];
  projects: readonly { id: string; name: string }[];
  opener?: Ref<HTMLButtonElement>;
  /** Shown in place of the rows when there are none. */
  empty?: string;
  /** Shown after the rows. */
  footer?: ReactNode;
}) {
  const groups = byProject(props.rows);
  return (
    <Popover.Root open={props.open} onOpenChange={props.setOpen}>
      <Popover.Trigger ref={props.opener} render={props.trigger} />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Popover.Popup className="pop np" aria-label={props.label} onKeyDown={moveFocus}>
            {groups.size === 0 && props.empty && <p className="np-x">{props.empty}</p>}
            {[...groups].map(([projectId, rows]) => {
              const name = props.projects.find((p) => p.id === projectId)?.name ?? '';
              return (
                <div key={projectId} role="group" aria-label={name} className="np-grp">
                  <div className="np-g">
                    <ProjectMonogram id={projectId} name={name} />
                    <b>{name}</b>
                    <span className="np-n">{rows.length}</span>
                  </div>
                  <ul className="np-l">
                    {rows.map((row) => (
                      <li
                        key={row.key}
                        className="np-r"
                        data-dim={row.dim || undefined}
                        data-on={row.on || undefined}
                      >
                        <span className="np-ic">{row.icon}</span>
                        <button
                          type="button"
                          className="np-open"
                          onClick={() => {
                            props.setOpen(false);
                            openRow(row);
                          }}
                        >
                          <span className="np-h">
                            <span className="np-t">{row.title}</span>
                          </span>
                          {row.detail && <span className="np-d">{row.detail}</span>}
                          {row.files && <span className="np-fs">{row.files}</span>}
                        </button>
                        <span className="np-e">{row.end}</span>
                        <span className="np-a">{row.actions}</span>
                        {row.body && <div className="np-b">{row.body}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {props.footer}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function needsGlyph(item: NeedsYouItem): ReactNode {
  switch (item.kind) {
    case 'permission':
      return <StateGlyph name={item.questions?.length ? 'question' : 'approval'} />;
    case 'session.reconciling':
      return <StateGlyph name="reconciling" />;
    case 'session.failed':
    case 'session.gate_failed':
      return <StateGlyph name="failed" />;
    case 'session.merge_blocked':
      return <MergeBlockedGlyph />;
    default:
      return <StateGlyph name="baseline_review" />;
  }
}

// A session item's source is the session itself.
const itemSession = (item: NeedsYouItem): string | undefined =>
  item.session_id ?? (item.source.table === 'sessions' ? item.source.id : undefined);

/** A permission request answered with allow or deny; one that asks questions opens instead. */
const answerable = (item: NeedsYouItem) =>
  item.kind === 'permission' &&
  item.reason === 'permission_requested' &&
  !item.questions?.length &&
  item.actions.find((a) => a.command === 'approval.respond')?.allowed === true;

// Every file shows: the approval lands all of them.
const filesText = (files: readonly string[]) => listText(...files);

/** The short name of the setting a proposal changes; an unknown command shows as it is. */
function settingName(command: string): string {
  switch (command) {
    case 'project.gate.set':
      return t({ id: 'components.needsPopover.setting.gate', defaultMessage: 'Gate commands' });
    case 'workflow.policy.set':
      return t({ id: 'components.needsPopover.setting.budget', defaultMessage: 'Budget' });
    case 'project.sessionDefaults.set':
      return t({
        id: 'components.needsPopover.setting.sessionDefaults',
        defaultMessage: 'Session defaults',
      });
    case 'project.extensions.set':
      return t({
        id: 'components.needsPopover.setting.extensions',
        defaultMessage: 'Extensions',
      });
    default:
      return command;
  }
}

const NONE = '—';

/** The row label of a field a proposal changes; an unknown field shows as it is. */
function fieldName(key: string): string {
  switch (key) {
    case 'commands':
      return settingName('project.gate.set');
    case 'protected_paths':
      return t({
        id: 'components.needsPopover.setting.protectedPaths',
        defaultMessage: 'Protected paths',
      });
    case 'project_budget':
      return settingName('workflow.policy.set');
    case 'session_defaults':
      return settingName('project.sessionDefaults.set');
    case 'inherited':
      return t({ id: 'components.needsPopover.setting.inherited', defaultMessage: 'Inherited' });
    case 'overrides':
      return t({
        id: 'components.needsPopover.setting.overrides',
        defaultMessage: 'Extension switches',
      });
    default:
      return key;
  }
}

const empty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && Object.keys(value).length === 0);

function shortText(value: unknown): string {
  if (empty(value)) return NONE;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return listText(...value);
  return JSON.stringify(value);
}

interface GateCommand {
  name: string;
  argv: string[];
  timeout_ms?: number;
}

const gateCommands = (value: unknown): value is GateCommand[] =>
  Array.isArray(value) &&
  value.every(
    (v) => typeof v === 'object' && v !== null && Array.isArray((v as { argv?: unknown }).argv),
  );

/** A gate command per line; an object's fields as key and value per line. */
function valueText(value: unknown): ReactNode {
  if (gateCommands(value) && value.length > 0)
    return value.map((command, index) => (
      <span key={index} className="np-ln">
        <span>{command.name}</span>
        <span>{command.argv.join(' ')}</span>
        {command.timeout_ms !== undefined && <span>{durationText(command.timeout_ms)}</span>}
      </span>
    ));
  if (!empty(value) && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value as object).map(([key, field]) => (
      <span key={key} className="np-ln">
        <span>{key}</span>
        <span>{shortText(field)}</span>
      </span>
    ));
  return shortText(value);
}

/** The root, the agent's reason and each changed field now and after the change. */
function settingBody(setting: NonNullable<NeedsYouItem['setting']>, name: string): ReactNode {
  const before = setting.before ?? {};
  const after = setting.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => !empty(before[key]) || !empty(after[key]),
  );
  return (
    <>
      {setting.root && <span className="np-rt">{setting.root}</span>}
      <p className="np-why">{setting.reason}</p>
      {keys.length > 0 && (
        <table
          className="np-tb"
          aria-label={t(
            { id: 'components.needsPopover.setting.change', defaultMessage: 'Change: {name}' },
            { name },
          )}
        >
          <thead>
            <tr>
              <td />
              <th scope="col" className="np-th">
                {t({ id: 'components.needsPopover.setting.now', defaultMessage: 'Now' })}
              </th>
              <th scope="col" className="np-th">
                {t({ id: 'components.needsPopover.setting.after', defaultMessage: 'After' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row" className="np-k">
                  {fieldName(key)}
                </th>
                <td className="np-v">{valueText(before[key])}</td>
                <td className="np-v">{valueText(after[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const ANSWERING = '';
const NO_PROJECTS: readonly never[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

/** Allow and deny for a request answered here; else the item's own buttons. */
function itemActions(item: NeedsYouItem, session?: SnapshotSession): NeedAction[] {
  if (!answerable(item)) return needActions(item, session);
  return [
    {
      key: 'approve',
      label: t({ id: 'projects.needs.allow', defaultMessage: 'Allow' }),
      reason: null,
    },
    {
      key: 'reject',
      label: t({ id: 'projects.needs.deny', defaultMessage: 'Deny' }),
      reason: null,
    },
  ];
}

/** What needs you across the projects, by project, the longest wait first. */
export function NeedsPopover({
  items,
  trigger,
  titleBar = false,
}: {
  items: readonly NeedsYouItem[];
  trigger: ReactElement;
  /** The title bar's list, which the toast stack moves aside for while it is open. */
  titleBar?: boolean;
}) {
  const board = useBoard((s) => s.board);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  useEffect(() => (titleBar && open ? holdRootFlag('needs-open') : undefined), [titleBar, open]);
  // By row: ANSWERING while the command is out, else why it failed.
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  // The rows settled since the daemon last listed the items; its next list shows what still waits.
  const [settled, setSettled] = useState<{
    of: readonly NeedsYouItem[];
    keys: ReadonlySet<string>;
  }>({ of: items, keys: NO_KEYS });
  const done = settled.of === items ? settled.keys : NO_KEYS;
  const [current, setCurrent] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const primaries = useRef(new Map<string, HTMLElement>());
  const focusing = useRef(false);
  useEffect(() => {
    if (!focusing.current) return;
    focusing.current = false;
    (current === null ? opener.current : primaries.current.get(current))?.focus();
  });

  async function act(row: ListRow, item: NeedsYouItem, action: NeedAction, order: string[]) {
    if (action.reason !== null || answers[row.key] === ANSWERING) return;
    // A reply needs the answers its card asks for.
    const command = action.key === 'reply' ? null : needCommand(item, action.key);
    if (!command) {
      setOpen(false);
      openRow(row);
      return;
    }
    setAnswers((all) => ({ ...all, [row.key]: ANSWERING }));
    const result = await runCommand(command.type, command.input, command.revision);
    setAnswers(({ [row.key]: _, ...rest }) =>
      result.ok ? rest : { ...rest, [row.key]: failureText(result.error) },
    );
    if (!result.ok) return;
    focusing.current = true;
    setCurrent(nextKey(order, row.key));
    setSettled((was) => ({
      of: items,
      keys: new Set(was.of === items ? was.keys : NO_KEYS).add(row.key),
    }));
  }

  const listed = items.map((item) => {
    const sessionId = itemSession(item);
    const session = sessionId ? board?.sessions.find((s) => s.id === sessionId) : undefined;
    const reason = reasonText(item.reason);
    const key = needRowKey(item);
    const failed = answers[key];
    const kind = decisionText(item.decision);
    const named = session && board ? sessionTitle(session, board) : undefined;
    const setting = item.setting && settingName(item.setting.command);
    const row: ListRow = {
      key,
      projectId: item.project_id,
      sessionId,
      ...(item.kind === 'project.over_budget' && {
        open: () => openSettingsPage(item.project_id, 'project'),
      }),
      since: item.created_at,
      icon: needsGlyph(item),
      title: setting ?? kind ?? named ?? reason,
      detail: failed ? (
        <span role="alert">{failed}</span>
      ) : kind || setting ? (
        (named ?? reason)
      ) : named ? (
        reason
      ) : undefined,
      ...(item.files?.length ? { files: filesText(item.files) } : {}),
      ...(item.setting && setting ? { body: settingBody(item.setting, setting) } : {}),
      end: ageText(item.created_at, now),
      on: key === current,
    };
    return { item, row, session };
  });
  const shown = listed.filter(({ row }) => !done.has(row.key));
  const order = [...byProject(shown.map(({ row }) => row)).values()].flat().map((row) => row.key);

  const rows = shown.map(({ item, row, session }): ListRow => {
    const actions = itemActions(item, session);
    const lead = primaryAction(actions, item.primary);
    const rest = actions.filter((action) => action !== lead);
    const busy = answers[row.key] === ANSWERING;
    const primary = lead && (
      <button
        type="button"
        className="btn sm"
        ref={(el) => {
          if (el) primaries.current.set(row.key, el);
          else primaries.current.delete(row.key);
        }}
        aria-disabled={busy || lead.reason !== null || undefined}
        onClick={() => void act(row, item, lead, order)}
      >
        {lead.label}
      </button>
    );
    return {
      ...row,
      actions: (
        <>
          {primary && lead?.reason ? <Tip content={lead.reason}>{primary}</Tip> : primary}
          {rest.length > 0 && (
            <Menu.Root>
              <Menu.Trigger
                className="ib"
                aria-label={t(
                  { id: 'components.needsPopover.more', defaultMessage: 'More actions: {name}' },
                  { name: row.title },
                )}
              >
                <Ellipsis aria-hidden="true" />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
                  <Menu.Popup className="wmenu pop">
                    {rest.map((action) => (
                      <Menu.Item
                        key={action.key}
                        disabled={busy || action.reason !== null}
                        onClick={() => void act(row, item, action, order)}
                      >
                        {action.label}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          )}
        </>
      ),
    };
  });

  const shownIds = board ? visibleProjects(board.projects).map((p) => p.id) : NO_PROJECTS;
  const decided = useDecisionsToday(open ? shownIds : NO_PROJECTS);
  const decidedIn = shownIds.filter((id) => (decided[id] ?? 0) > 0);
  const decidedCount = decidedIn.reduce((sum, id) => sum + decided[id]!, 0);

  const empty = t({ id: 'components.needsPopover.empty', defaultMessage: 'Nothing needs you.' });
  return listPopover({
    trigger,
    open,
    setOpen,
    rows,
    projects: board?.projects ?? NO_PROJECTS,
    opener,
    empty,
    footer: decidedCount > 0 && (
      <button
        type="button"
        className="np-f"
        onClick={() => {
          setOpen(false);
          const here = useCurrentProject.getState().projectId;
          useShell
            .getState()
            .openProjectApproved(here && decidedIn.includes(here) ? here : decidedIn[0]!);
        }}
      >
        <CircleCheck className="ic-sm" aria-hidden="true" />
        <span className="np-ft">
          {t(
            {
              id: 'components.needsPopover.approved',
              defaultMessage: '{count, plural, other {# approved for you}}',
            },
            { count: decidedCount },
          )}
        </span>
        <span className="np-c">{t({ id: 'lib.time.today', defaultMessage: 'Today' })}</span>
      </button>
    ),
    label: rows.length
      ? t(
          {
            id: 'projects.needs.label',
            defaultMessage: '{count, plural, one {# thing needs you} other {# things need you}}',
          },
          { count: rows.length },
        )
      : empty,
  });
}

const RUNNING: readonly WorkbenchSession['state'][] = ['starting', 'running', 'merging'];

/** The running and queued, or the ready sessions of the projects, read while the list is open. */
export function SessionsPopover({
  show,
  projectIds,
  trigger,
}: {
  show: 'running' | 'ready';
  projectIds: readonly string[];
  trigger: ReactElement;
}) {
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const listed = useProjectSessions(open ? projectIds : NO_PROJECTS);

  const titleOf = (session: WorkbenchSession) => {
    const known = board?.sessions.find((s) => s.id === session.id);
    return known && board ? sessionTitle(known, board) : session.title;
  };
  const rows = listed.flatMap(({ project_id, session }): ListRow[] => {
    if (session.archived_at) return [];
    const base = { key: session.id, projectId: project_id, sessionId: session.id };
    const activity = Date.parse(session.last_activity_at);
    if (show === 'ready') {
      if (session.state !== 'ready') return [];
      const { additions = 0, deletions = 0 } = session.changes ?? {};
      return [
        {
          ...base,
          since: activity,
          icon: <StateGlyph name="ready" />,
          title: titleOf(session),
          detail: (
            <>
              <span className="mono">
                <DiffCounts additions={additions} deletions={deletions} />
              </span>
              <GateMark gate={session.gate} />
            </>
          ),
          actions: (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setOpen(false);
                useShell.getState().openProjectSession(project_id, session.id);
              }}
            >
              {t({ id: 'projects.ready.review', defaultMessage: 'Review' })}
            </button>
          ),
        },
      ];
    }
    const running = session.reconciling || RUNNING.includes(session.state);
    if (!running && session.last_turn?.state !== 'queued') return [];
    const since = running && board ? runningSince(session.id, board, events, session) : null;
    return [
      {
        ...base,
        since: since ?? activity,
        icon: <RuntimeGlyph runtime={session.runtime} />,
        title: titleOf(session),
        end: !running ? (
          <StateGlyph name="idle" />
        ) : (
          since !== null && durationText(Math.max(0, now - since))
        ),
        dim: !running,
      },
    ];
  });

  return listPopover({
    trigger,
    open,
    setOpen,
    rows,
    projects: board?.projects ?? NO_PROJECTS,
    label:
      show === 'ready'
        ? t(
            {
              id: 'projects.ready.label',
              defaultMessage:
                '{count, plural, one {# session ready to merge} other {# sessions ready to merge}}',
            },
            { count: rows.length },
          )
        : t(
            {
              id: 'projects.running.label',
              defaultMessage: '{count, plural, one {# running session} other {# running sessions}}',
            },
            { count: rows.length },
          ),
  });
}
