import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { Tabs } from '@base-ui/react/tabs';
import { Lock as LockIcon, RefreshCw } from 'lucide-react';
import { createStore } from 'zustand/vanilla';
import type { BoardSnapshot } from '@pantheon/protocol';
import { PathText } from '../../components/PathText';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import {
  appsLabel,
  autoClosedReason,
  canSave,
  changeLine,
  KIND_LABEL,
  loadState,
  missingFromInventory,
  reconnectMcp,
  reconnectSession,
  RUNTIMES,
  savedOverrides,
  selectionChanges,
  setClosed,
  setFlag,
  setOpened,
  useInventories,
  useMcpReconnectable,
  useMcpStatus,
  type ExtensionInventory,
  type ExtensionOverrides,
  type InventoryState,
  type ListField,
  type Lock,
  type McpServerState,
  type OpenField,
  type Runtime,
} from '../../data/extensions';
import { t } from '../../i18n';
import {
  failureText,
  Loading,
  noChanges,
  runtimeLabel,
  saveLabel,
  Section,
  type Failure,
} from './ProjectSettingsScreen';
import { registerPageHeader } from './settings-header';
import { useSettingsView } from './view';
import { EmptyState } from '../../components/EmptyState';
import './extensions-page.css';

type Project = BoardSnapshot['projects'][number];

const toolsTitle = (runtime: string) =>
  t({ id: 'settings.extensions.tools', defaultMessage: '{runtime} tools' }, { runtime });
const unsupportedText = () =>
  t({
    id: 'settings.extensions.unsupported',
    defaultMessage: 'This runtime does not list its extensions',
  });
const readingInventory = () =>
  t({ id: 'settings.extensions.reading', defaultMessage: "Reading this machine's inventory" });
const mcpTitle = () => t({ id: 'settings.extensions.mcp', defaultMessage: 'MCP servers' });
const pluginsTitle = () => t({ id: 'settings.extensions.plugins', defaultMessage: 'Plugins' });
const skillsTitle = () => t({ id: 'settings.extensions.skills', defaultMessage: 'Skills' });
const hooksTitle = () => t({ id: 'settings.extensions.hooks', defaultMessage: 'Hooks' });
const impactTitle = () =>
  t({ id: 'settings.extensions.impact', defaultMessage: 'Effect of saving' });

/** How many times the header asked to read the inventory again. */
const refreshes = createStore(() => ({ asked: 0 }));
const askedCount = () => refreshes.getState().asked;

/** The projects page header's refresh, while a project's page with its extensions is open. */
function RefreshInventory() {
  // The settings screen renders again when the open project changes.
  if (!useSettingsView.getState().detail) return null;
  return (
    <button
      type="button"
      className="btn ghost sm"
      data-setting-id="extensions.refresh"
      onClick={() => refreshes.setState((s) => ({ asked: s.asked + 1 }))}
    >
      <RefreshCw aria-hidden="true" />
      {t({ id: 'settings.extensions.refresh', defaultMessage: 'Refresh inventory' })}
    </button>
  );
}

registerPageHeader('projects', { tools: RefreshInventory });

export function ExtensionsPage({ project }: { project: Project }) {
  const asked = useSyncExternalStore(refreshes.subscribe, askedCount, askedCount);
  const { states: inventories, reload } = useInventories(project.id, asked);
  // The inventory reads every project folder, so saved folders it has not read make it stale.
  const roots = project.roots.join('\0');
  const readRoots = useRef(roots);
  useEffect(() => {
    if (readRoots.current === roots) return;
    readRoots.current = roots;
    reload();
  }, [roots, reload]);
  const runtime = useSettingsView((s) => s.runtime);
  const setRuntime = useSettingsView((s) => s.setRuntime);
  const [drafts, setDrafts] = useState<Partial<Record<Runtime, ExtensionOverrides>>>({});
  const [failures, setFailures] = useState<Partial<Record<Runtime, Failure>>>({});
  const [saving, setSaving] = useState<Runtime | null>(null);
  const sending = useRef(false);
  // Keep the submitted version until the board catches up; edits made meanwhile stay drafts.
  const [savedAt, setSavedAt] = useState<{
    runtime: Runtime;
    revision: number;
    draft: ExtensionOverrides;
  } | null>(null);

  useEffect(() => {
    if (!savedAt || project.revision < savedAt.revision) return;
    setDrafts((d) =>
      d[savedAt.runtime] === savedAt.draft ? { ...d, [savedAt.runtime]: undefined } : d,
    );
    setSavedAt(null);
  }, [project.revision, savedAt]);

  const state: InventoryState = inventories[runtime] ?? { state: 'loading' };
  const initial = savedOverrides(project, runtime);
  const draft = drafts[runtime] ?? initial;
  const edit = (next: ExtensionOverrides) => setDrafts((d) => ({ ...d, [runtime]: next }));

  const save = async () => {
    if (sending.current || savedAt) return;
    sending.current = true;
    const revision = project.revision;
    setSaving(runtime);
    const result = await runCommand(
      'project.extensions.set',
      { project_id: project.id, runtime, overrides: draft },
      revision,
    );
    sending.current = false;
    setSaving(null);
    setFailures((f) => ({ ...f, [runtime]: result.ok ? undefined : result.error }));
    if (result.ok)
      setSavedAt({ runtime, revision: (result.value as Project).revision ?? revision + 1, draft });
  };

  let panel: ReactNode;
  let footer: ReactNode = null;
  if (state.state === 'unsupported')
    panel = (
      <Section title={toolsTitle(runtimeName(runtime))}>
        <EmptyState inline title={unsupportedText()} />
      </Section>
    );
  else if (state.state === 'error')
    panel = (
      <Section title={toolsTitle(runtimeName(runtime))}>
        <LoadError message={failureText(state)} onRetry={reload} />
      </Section>
    );
  else if (state.state === 'loading')
    panel = [mcpTitle(), pluginsTitle(), skillsTitle(), appsLabel(runtime), hooksTitle()].map(
      (title) => (
        <Section key={title} title={title} meta={readingInventory()}>
          <Loading />
        </Section>
      ),
    );
  else {
    const changes = selectionChanges(initial, draft);
    const busy = saving === runtime || savedAt?.runtime === runtime;
    const enabled = saving === null && savedAt === null && canSave(initial, draft);
    const failure = failures[runtime];
    panel = (
      <>
        <Groups
          project={project}
          inventory={state.inventory}
          runtime={runtime}
          draft={draft}
          onEdit={edit}
        />
        <Missing
          missing={missingFromInventory(initial, state.inventory)}
          draft={draft}
          onEdit={edit}
        />
      </>
    );
    // Stays at the bottom of the scrolling page while the list scrolls under it.
    footer = (
      <div className="ex-ft" role="group" aria-label={impactTitle()}>
        <span className="ex-ft-main">
          <span className="ex-ft-hd">
            <b>{impactTitle()}</b>
            <span className="mu">{runtimeName(runtime)}</span>
          </span>
          {failure && (
            <span className="ps-err" role="alert">
              {failureText(failure)}
            </span>
          )}
          {changes.length === 0 ? (
            <span className="mu">{noChanges()}</span>
          ) : (
            <span className="ex-ch">
              {changes.map((c) => {
                const line = changeLine(c, state.inventory, runtime);
                return (
                  <span key={`${c.field}:${c.entry ?? ''}`} className="mono">
                    <span className={c.closed ? 'ex-del' : 'ex-add'}>{line.action}</span>{' '}
                    {line.what}
                  </span>
                );
              })}
            </span>
          )}
        </span>
        <span className="ex-ft-end">
          {changes.length > 0 && (
            <span className="mu ex-n">
              {t(
                {
                  id: 'settings.extensions.changes',
                  defaultMessage: '{count, plural, one {# change} other {# changes}}',
                },
                { count: changes.length },
              )}
            </span>
          )}
          <button
            type="button"
            className="btn pri"
            disabled={!enabled}
            aria-disabled={!enabled}
            onClick={enabled ? () => void save() : undefined}
          >
            {saveLabel(busy)}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="ex-pg">
      <Tabs.Root
        className="ps-bar"
        value={runtime}
        onValueChange={(value) => setRuntime(value as Runtime)}
      >
        <Tabs.List className="tb-tabs" aria-label={runtimeLabel()}>
          {RUNTIMES.map((r) => (
            <RuntimeTab key={r} runtime={r} state={inventories[r] ?? { state: 'loading' }} />
          ))}
        </Tabs.List>
      </Tabs.Root>
      <div aria-label={toolsTitle(runtimeName(runtime))} role="group" className="ps-col">
        {panel}
      </div>
      {footer}
    </div>
  );
}

/** A runtime's mark and name; why a tab is off shows in its panel, or on hover once disabled. */
function RuntimeTab(props: { runtime: Runtime; state: InventoryState }) {
  const unsupported = props.state.state === 'unsupported';
  return (
    <Tabs.Tab
      className="tb-tab"
      value={props.runtime}
      disabled={unsupported}
      title={unsupported ? unsupportedText() : undefined}
    >
      <RuntimeGlyph runtime={props.runtime} />
      {runtimeName(props.runtime)}
    </Tabs.Tab>
  );
}

function lockText(lock: Lock): ReactNode {
  if (lock.reason === 'machine_off')
    return t({ id: 'settings.extensions.machineOff', defaultMessage: 'Off on this machine' });
  // The plugin name is set in monospace where the placeholder stood.
  const [before, after] = t(
    { id: 'settings.extensions.withPlugin', defaultMessage: 'With plugin {plugin}' },
    { plugin: '\u0000' },
  ).split('\u0000');
  return (
    <>
      {before}
      <span className="mono">{lock.plugin}</span>
      {after}
    </>
  );
}

/** A switch for whether the project's sessions load an item; a locked item cannot be switched. */
function Entry(props: {
  loaded: boolean;
  lock: Lock | null;
  onChange: (loaded: boolean) => void;
  name: string;
  /** Ids are set in monospace. */
  mono?: boolean;
  children?: ReactNode;
  onRemove?: () => void;
  /** The MCP server's connection state, when the runtime reports one. */
  status?: McpServerState;
  /** The live session a reconnect of the MCP server goes through. */
  reconnectVia?: string;
}) {
  const status = props.status && mcpState(props.status.state);
  return (
    <div className="ps-row">
      <span className="ps-row-nm">
        <span className={props.mono ? 'mono' : undefined}>{props.name}</span>
        {props.children}
      </span>
      <span className="ps-row-ct">
        {status && (
          <span className="hp-st">
            <span className="hp-dot" data-s={status.s} aria-hidden="true" />
            <span>{status.text}</span>
          </span>
        )}
        {props.status && props.status.state !== 'connected' && props.reconnectVia !== undefined && (
          <McpReconnect sessionId={props.reconnectVia} server={props.status.name} />
        )}
        {props.lock && props.onRemove && (
          <button type="button" className="btn ghost sm" onClick={props.onRemove}>
            {t({
              id: 'settings.extensions.removeOverride',
              defaultMessage: "Remove from the project's off list",
            })}
          </button>
        )}
        {props.lock && (
          <span className="chip">
            <LockIcon aria-hidden="true" />
            {lockText(props.lock)}
          </span>
        )}
        <input
          type="checkbox"
          className="ps-sw"
          aria-label={t(
            { id: 'settings.extensions.load', defaultMessage: 'Load {name}' },
            { name: props.name },
          )}
          checked={props.loaded}
          disabled={props.lock !== null}
          onChange={(e) => props.onChange(e.target.checked)}
        />
      </span>
      {props.status?.reason !== undefined && <span className="ex-why">{props.status.reason}</span>}
    </div>
  );
}

/** Reconnects an MCP server that is not connected; a refusal shows beside the button. */
export function McpReconnect({ sessionId, server }: { sessionId: string; server: string }) {
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const run = async () => {
    setRunning(true);
    setFailure(null);
    const result = await reconnectMcp(sessionId, server);
    setRunning(false);
    if (!result.ok) setFailure(result.error);
  };
  return (
    <>
      {failure && (
        <span className="ps-err" role="alert">
          {failureText(failure)}
        </span>
      )}
      <button
        type="button"
        className="btn sm"
        disabled={running}
        aria-busy={running || undefined}
        aria-label={t(
          { id: 'settings.extensions.reconnectServer', defaultMessage: 'Reconnect {name}' },
          { name: server },
        )}
        onClick={() => void run()}
      >
        {t({ id: 'settings.extensions.reconnect', defaultMessage: 'Reconnect' })}
      </button>
    </>
  );
}

function mcpState(state: McpServerState['state']): { s: string; text: string } {
  if (state === 'connected')
    return {
      s: 'ok',
      text: t({ id: 'settings.extensions.mcpConnected', defaultMessage: 'Connected' }),
    };
  if (state === 'failed')
    return {
      s: 'bad',
      text: t({ id: 'settings.extensions.mcpFailed', defaultMessage: 'Failed' }),
    };
  if (state === 'needs_sign_in')
    return {
      s: 'wait',
      text: t({ id: 'settings.connections.needsSignIn', defaultMessage: 'Needs sign-in' }),
    };
  if (state === 'pending')
    return {
      s: 'wait',
      text: t({ id: 'settings.extensions.mcpPending', defaultMessage: 'Connecting' }),
    };
  if (state === 'disabled')
    return {
      s: 'idle',
      text: t({ id: 'settings.extensions.mcpDisabled', defaultMessage: 'Off' }),
    };
  return {
    s: 'unknown',
    text: t({ id: 'settings.extensions.mcpUnknown', defaultMessage: 'Status unknown' }),
  };
}

const fromPlugin = (plugin: string | undefined) =>
  plugin && (
    <span className="mono mu">
      {t(
        { id: 'settings.extensions.fromPlugin', defaultMessage: 'From plugin {plugin}' },
        { plugin },
      )}
    </span>
  );

const countText = (items: readonly { loaded: boolean }[]) => (
  <span className="mu ex-n">
    {t(
      { id: 'settings.extensions.loaded', defaultMessage: '{loaded} / {total} loaded' },
      { loaded: items.filter((e) => e.loaded).length, total: items.length },
    )}
  </span>
);

function Groups(props: {
  project: Project;
  inventory: ExtensionInventory;
  runtime: Runtime;
  draft: ExtensionOverrides;
  onEdit: (next: ExtensionOverrides) => void;
}) {
  const { project, inventory, runtime, draft, onEdit } = props;
  const state = loadState(inventory, draft);
  // Mounted with each inventory read, so a refreshed inventory reads the states again.
  const mcp = useMcpStatus(project.id, runtime);
  const via = useBoard((s) => reconnectSession(s.board?.sessions ?? [], project.id, runtime));
  const reconnectVia = useMcpReconnectable(via) ? via : undefined;
  const toggle = (field: ListField, entry: string) => (loaded: boolean) =>
    onEdit(setClosed(draft, field, entry, !loaded));
  const open = (field: OpenField, entry: string) => (loaded: boolean) =>
    onEdit(setOpened(draft, field, entry, loaded));
  const why = (field: ListField, entry: string) => {
    const reason = autoClosedReason(project, runtime, field, entry);
    return reason && <span className="mu">{reason}</span>;
  };
  const apps = appsLabel(runtime);
  return (
    <>
      <Section title={mcpTitle()} action={countText(state.mcp_servers)} settingId="extensions.mcp">
        {state.mcp_servers.length === 0 ? (
          <EmptyState
            inline
            title={t({
              id: 'settings.extensions.noMcp',
              defaultMessage: "No MCP servers in this machine's inventory",
            })}
          />
        ) : (
          <div className="ps-rows">
            {state.mcp_servers.map((s) => (
              <Entry
                key={s.name}
                loaded={s.loaded}
                lock={s.lock}
                onChange={
                  s.user
                    ? open('enabled_user_mcp_servers', s.name)
                    : toggle('disabled_mcp_servers', s.name)
                }
                onRemove={
                  draft.disabled_mcp_servers.includes(s.name)
                    ? () => onEdit(setClosed(draft, 'disabled_mcp_servers', s.name, false))
                    : undefined
                }
                name={s.name}
                mono
                status={mcp.get(s.name)}
                reconnectVia={reconnectVia}
              >
                {why('disabled_mcp_servers', s.name)}
              </Entry>
            ))}
          </div>
        )}
      </Section>
      <Section
        title={pluginsTitle()}
        action={countText(state.plugins)}
        settingId="extensions.plugins"
      >
        {state.plugins.length === 0 ? (
          <EmptyState
            inline
            title={t({
              id: 'settings.extensions.noPlugins',
              defaultMessage: "No plugins in this machine's inventory",
            })}
          />
        ) : (
          <div className="ps-rows">
            {state.plugins.map((p) => (
              <Entry
                key={p.id}
                loaded={p.loaded}
                lock={p.lock}
                onChange={toggle('disabled_plugins', p.id)}
                onRemove={
                  draft.disabled_plugins.includes(p.id)
                    ? () => onEdit(setClosed(draft, 'disabled_plugins', p.id, false))
                    : undefined
                }
                name={p.id}
                mono
              >
                {why('disabled_plugins', p.id)}
              </Entry>
            ))}
          </div>
        )}
      </Section>
      <Section title={skillsTitle()} action={countText(state.skills)} settingId="extensions.skills">
        {state.skills.length === 0 ? (
          <EmptyState
            inline
            title={t({
              id: 'settings.extensions.noSkills',
              defaultMessage: "No skills in this machine's inventory",
            })}
          />
        ) : (
          <div className="ps-rows">
            {state.skills.map((s) => (
              <Entry
                key={s.id}
                loaded={s.loaded}
                lock={s.lock}
                onChange={
                  s.user ? open('enabled_user_skills', s.id) : toggle('disabled_skills', s.id)
                }
                onRemove={
                  draft.disabled_skills.includes(s.id)
                    ? () => onEdit(setClosed(draft, 'disabled_skills', s.id, false))
                    : undefined
                }
                name={s.name}
              >
                {s.path && <PathText path={s.path} className="mono mu" />}
                {fromPlugin(s.plugin)}
                {why('disabled_skills', s.id)}
              </Entry>
            ))}
          </div>
        )}
      </Section>
      <Section title={apps} action={countText(state.connectors)} settingId="extensions.apps">
        {state.connectors.length === 0 ? (
          <EmptyState
            inline
            title={t(
              {
                id: 'settings.extensions.noApps',
                defaultMessage: "No {apps} in this machine's inventory",
              },
              { apps },
            )}
          />
        ) : (
          <div className="ps-rows">
            {state.connectors.map((c) => (
              <Entry
                key={c.name}
                loaded={c.loaded}
                lock={c.lock}
                onChange={open('enabled_user_connectors', c.name)}
                name={c.title ?? c.name}
              />
            ))}
          </div>
        )}
      </Section>
      <Section title={hooksTitle()} settingId="extensions.hooks">
        <div className="ps-rows">
          <Entry
            loaded={state.hooks.loaded}
            lock={state.hooks.lock}
            onChange={(loaded) => onEdit(setFlag(draft, 'disable_hooks', !loaded))}
            name={hooksTitle()}
            onRemove={
              draft.disable_hooks ? () => onEdit(setFlag(draft, 'disable_hooks', false)) : undefined
            }
          >
            <span className="ex-hk">
              <span className="mu">
                {inventory.hooks.length > 0
                  ? t(
                      {
                        id: 'settings.extensions.hooksCount',
                        defaultMessage: '{count} on this machine, turned on and off together',
                      },
                      { count: inventory.hooks.length },
                    )
                  : t({
                      id: 'settings.extensions.hooksUnlisted',
                      defaultMessage: 'This machine lists no details',
                    })}
              </span>
              {inventory.hooks.length > 0 && (
                <span
                  className="ex-hk-l"
                  role="list"
                  aria-label={t({
                    id: 'settings.extensions.hooksList',
                    defaultMessage: 'Hooks on this machine',
                  })}
                >
                  {inventory.hooks.map((h, i) => (
                    <span key={i} role="listitem" className="chip mono">
                      {h.event}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </Entry>
        </div>
      </Section>
    </>
  );
}

/** Saved closing-list entries the machine no longer lists; each can leave the list. */
function Missing(props: {
  missing: Record<ListField, string[]>;
  draft: ExtensionOverrides;
  onEdit: (next: ExtensionOverrides) => void;
}) {
  const { missing, draft, onEdit } = props;
  const rows = (['disabled_mcp_servers', 'disabled_plugins', 'disabled_skills'] as const).flatMap(
    (field) => missing[field].map((entry) => ({ field, entry })),
  );
  if (rows.length === 0) return null;
  return (
    <Section
      title={t({
        id: 'settings.extensions.missing',
        defaultMessage: "Not in this machine's inventory",
      })}
      action={
        <span className="mu ex-n">
          {t(
            {
              id: 'settings.extensions.missingCount',
              defaultMessage: '{count, plural, one {# item} other {# items}}',
            },
            { count: rows.length },
          )}
        </span>
      }
    >
      <div className="ps-rows">
        {rows.map(({ field, entry }) => {
          const listed = draft[field].includes(entry);
          return (
            <div key={`${field}:${entry}`} className="ps-row">
              <span className="ex-mi">
                <span className="chip">{KIND_LABEL[field]}</span>
                {field === 'disabled_skills' ? (
                  <PathText path={entry} className="mono" />
                ) : (
                  <span className="mono">{entry}</span>
                )}
              </span>
              <span className="ps-row-ct">
                {!listed && (
                  <span className="mu">
                    {t({ id: 'settings.extensions.removed', defaultMessage: 'Removed' })}
                  </span>
                )}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => onEdit(setClosed(draft, field, entry, !listed))}
                >
                  {listed
                    ? t({
                        id: 'settings.extensions.removeFromList',
                        defaultMessage: 'Remove from list',
                      })
                    : t({ id: 'settings.extensions.undo', defaultMessage: 'Undo' })}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
