import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardSnapshot, BridgeResult, DesktopBridge, McpStatus } from '@pantheon/protocol';
import { KNOWN_RUNTIMES, runtimeTraits } from '../components/RuntimeGlyph';
import { t } from '../i18n';
import { useBoard } from './board';
import { runCommand } from './commands';
import { readQuery } from './workbench-sessions';

type Project = BoardSnapshot['projects'][number];
export type ExtensionOverrides = NonNullable<Project['extension_overrides']>[string];

/** GET /v1/extensions.inventory: what the runtime finds for the project on this machine. */
export interface ExtensionInventory {
  runtime: string;
  mcp_servers: { name: string; enabled: boolean; plugin?: string; user?: boolean }[];
  plugins: { id: string; enabled: boolean }[];
  skills: {
    id: string;
    name: string;
    enabled: boolean;
    path?: string;
    plugin?: string;
    user?: boolean;
  }[];
  apps: boolean;
  connectors: { name: string; enabled: boolean; title?: string }[];
  hooks: { event: string; plugin?: string }[];
  hooks_enabled?: boolean;
}

export const RUNTIMES = KNOWN_RUNTIMES.filter((runtime) => runtimeTraits(runtime).extensions);
export type Runtime = string;

/** Override fields that list identifiers; skill IDs are runtime-specific. */
export type ListField = 'disabled_mcp_servers' | 'disabled_plugins' | 'disabled_skills';
export type FlagField = 'disable_apps' | 'disable_hooks';
const LIST_FIELDS: readonly ListField[] = [
  'disabled_mcp_servers',
  'disabled_plugins',
  'disabled_skills',
];
const FLAG_FIELDS: readonly FlagField[] = ['disable_apps', 'disable_hooks'];
/** Override fields that list the user-level items the project opens; unset opens none. */
export type OpenField = 'enabled_user_connectors';
// Claude denies a connector by its server name, so an opened one leaves the server closing list too.
const OPEN_FIELDS: Record<OpenField, ListField> = {
  enabled_user_connectors: 'disabled_mcp_servers',
};
const opened = (overrides: ExtensionOverrides, field: OpenField): string[] =>
  overrides[field] ?? [];

const NOTHING: ExtensionOverrides = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: [],
  disable_apps: false,
  disable_hooks: false,
};

/** The project's closing list for the runtime; empty when it has saved none. */
export function savedOverrides(
  project: Pick<Project, 'extension_overrides'>,
  runtime: string,
): ExtensionOverrides {
  const saved = project.extension_overrides?.[runtime];
  if (!saved || !('enabled_user_apps' in saved)) return saved ?? NOTHING;
  // The command refuses the retired connector switch, which opened nothing on its own.
  const { enabled_user_apps: _, ...kept } = saved as ExtensionOverrides & {
    enabled_user_apps?: unknown;
  };
  return kept;
}

const KIND_FIELD: Record<NonNullable<Project['extension_auto']>[number]['kind'], ListField> = {
  mcp_server: 'disabled_mcp_servers',
  plugin: 'disabled_plugins',
  skill: 'disabled_skills',
};

/** Why an assessment turned the entry off; undefined once the user turned it back on. */
export function autoClosedReason(
  project: Pick<Project, 'extension_auto'>,
  runtime: string,
  field: ListField,
  entry: string,
): string | undefined {
  return project.extension_auto?.find(
    (item) =>
      !item.restored &&
      item.runtime === runtime &&
      KIND_FIELD[item.kind] === field &&
      item.name === entry,
  )?.reason;
}

/** How many items the closing list turns off, entries the machine no longer lists included. */
export const closedCount = (overrides: ExtensionOverrides): number =>
  LIST_FIELDS.reduce((n, field) => n + overrides[field].length, 0) +
  FLAG_FIELDS.filter((field) => overrides[field]).length;

/** Why an item cannot be switched for the project. */
export type Lock = { reason: 'machine_off' } | { reason: 'plugin'; plugin: string };

/** An inventory item and whether the project's sessions load it. */
export type Loaded<T> = T & { loaded: boolean; lock: Lock | null };

export interface LoadState {
  mcp_servers: Loaded<ExtensionInventory['mcp_servers'][number]>[];
  plugins: Loaded<ExtensionInventory['plugins'][number]>[];
  skills: Loaded<ExtensionInventory['skills'][number]>[];
  connectors: Loaded<ExtensionInventory['connectors'][number]>[];
  hooks: { loaded: boolean; lock: Lock | null };
}

const MACHINE_OFF: Lock = { reason: 'machine_off' };

/** The machine's setup minus the project's closing list, in inventory order. */
export function loadState(inventory: ExtensionInventory, overrides: ExtensionOverrides): LoadState {
  const closed = (field: ListField, id: string) => overrides[field].includes(id);
  return {
    mcp_servers: inventory.mcp_servers.map((s) => ({
      ...s,
      // A server a plugin provides goes with that plugin.
      loaded:
        s.enabled &&
        !closed('disabled_mcp_servers', s.name) &&
        !(
          s.plugin !== undefined &&
          (closed('disabled_plugins', s.plugin) ||
            inventory.plugins.some((p) => p.id === s.plugin && !p.enabled))
        ),
      lock: !s.enabled
        ? MACHINE_OFF
        : s.plugin !== undefined
          ? { reason: 'plugin', plugin: s.plugin }
          : null,
    })),
    plugins: inventory.plugins.map((p) => ({
      ...p,
      loaded: p.enabled && !closed('disabled_plugins', p.id),
      lock: p.enabled ? null : MACHINE_OFF,
    })),
    skills: inventory.skills.map((s) => ({
      ...s,
      loaded:
        s.enabled &&
        !closed('disabled_skills', s.id) &&
        !(
          s.plugin !== undefined &&
          (closed('disabled_plugins', s.plugin) ||
            inventory.plugins.some((p) => p.id === s.plugin && !p.enabled))
        ),
      lock: !s.enabled
        ? MACHINE_OFF
        : s.plugin !== undefined &&
            (closed('disabled_plugins', s.plugin) ||
              inventory.plugins.some((p) => p.id === s.plugin && !p.enabled))
          ? { reason: 'plugin', plugin: s.plugin }
          : null,
    })),
    connectors: inventory.connectors.map((c) => ({
      ...c,
      loaded:
        c.enabled &&
        !overrides.disable_apps &&
        opened(overrides, 'enabled_user_connectors').includes(c.name),
      lock: c.enabled ? null : MACHINE_OFF,
    })),
    // hooks_enabled is absent when the runtime does not report its machine-level switch.
    hooks: {
      loaded: inventory.hooks_enabled !== false && !overrides.disable_hooks,
      lock: inventory.hooks_enabled === false ? MACHINE_OFF : null,
    },
  };
}

/** The skills a session loads, for `/` completion. */
export function completionSkills(
  inventory: ExtensionInventory,
  overrides: ExtensionOverrides,
): ExtensionInventory['skills'] {
  return loadState(inventory, overrides).skills.filter((s) => s.loaded);
}

/** Closing-list entries the inventory does not list, such as an uninstalled plugin. */
export function missingFromInventory(
  overrides: ExtensionOverrides,
  inventory: ExtensionInventory,
): Record<ListField, string[]> {
  const listed: Record<ListField, Set<string>> = {
    disabled_mcp_servers: new Set(inventory.mcp_servers.map((s) => s.name)),
    disabled_plugins: new Set(inventory.plugins.map((p) => p.id)),
    disabled_skills: new Set(inventory.skills.map((s) => s.id)),
  };
  return {
    disabled_mcp_servers: overrides.disabled_mcp_servers.filter(
      (name) => !listed.disabled_mcp_servers.has(name),
    ),
    disabled_plugins: overrides.disabled_plugins.filter((id) => !listed.disabled_plugins.has(id)),
    disabled_skills: overrides.disabled_skills.filter((id) => !listed.disabled_skills.has(id)),
  };
}

/** The closing list with one entry added or removed. */
export function setClosed(
  overrides: ExtensionOverrides,
  field: ListField,
  entry: string,
  closed: boolean,
): ExtensionOverrides {
  const rest = overrides[field].filter((e) => e !== entry);
  return { ...overrides, [field]: closed ? [...rest, entry] : rest };
}

/** The overrides with one user-level item opened, which also drops it from the closing list, or shut. */
export function setOpened(
  overrides: ExtensionOverrides,
  field: OpenField,
  entry: string,
  open: boolean,
): ExtensionOverrides {
  const rest = opened(overrides, field).filter((e) => e !== entry);
  return {
    ...(open ? setClosed(overrides, OPEN_FIELDS[field], entry, false) : overrides),
    // An opened connector also lifts the project's switch that shuts them all.
    ...(open && field === 'enabled_user_connectors' ? { disable_apps: false } : {}),
    [field]: open ? [...rest, entry] : rest,
  };
}

export function setFlag(
  overrides: ExtensionOverrides,
  field: FlagField,
  closed: boolean,
): ExtensionOverrides {
  return { ...overrides, [field]: closed };
}

/** One difference between two closing lists; entry is null for disable_apps and disable_hooks. */
export interface SelectionChange {
  field: ListField | FlagField | OpenField;
  entry: string | null;
  closed: boolean;
}

/** What saving after would change against before; list order does not count. */
export function selectionChanges(
  before: ExtensionOverrides,
  after: ExtensionOverrides,
): SelectionChange[] {
  const changes: SelectionChange[] = [];
  for (const field of LIST_FIELDS) {
    const was = new Set(before[field]);
    const now = new Set(after[field]);
    for (const entry of now) if (!was.has(entry)) changes.push({ field, entry, closed: true });
    for (const entry of was) if (!now.has(entry)) changes.push({ field, entry, closed: false });
  }
  for (const field of Object.keys(OPEN_FIELDS) as OpenField[]) {
    const was = new Set(opened(before, field));
    const now = new Set(opened(after, field));
    for (const entry of now) if (!was.has(entry)) changes.push({ field, entry, closed: false });
    for (const entry of was) if (!now.has(entry)) changes.push({ field, entry, closed: true });
  }
  if (before.disable_apps !== after.disable_apps)
    changes.push({ field: 'disable_apps', entry: null, closed: after.disable_apps });
  if (before.disable_hooks !== after.disable_hooks)
    changes.push({ field: 'disable_hooks', entry: null, closed: after.disable_hooks });
  return changes;
}

/** What the runtime calls its apps switch. */
export const appsLabel = (runtime: string): string => runtimeTraits(runtime).appsLabel;

export const KIND_LABEL: Record<ListField, string> = {
  disabled_mcp_servers: 'MCP',
  get disabled_plugins() {
    return t({ id: 'data.extensions.plugin', defaultMessage: 'Plugin' });
  },
  get disabled_skills() {
    return t({ id: 'data.extensions.skill', defaultMessage: 'Skill' });
  },
};

/** A change as the save preview shows it; a skill goes by its name when the inventory lists it. */
export function changeLine(
  change: SelectionChange,
  inventory: ExtensionInventory,
  runtime: string,
): { action: string; what: string } {
  const action = change.closed
    ? t({ id: 'data.extensions.turnOff', defaultMessage: 'Turn off' })
    : t({ id: 'data.extensions.restore', defaultMessage: 'Restore' });
  if (change.entry === null)
    return { action, what: change.field === 'disable_apps' ? appsLabel(runtime) : 'Hooks' };
  if (change.field === 'enabled_user_connectors') {
    const listed = inventory.connectors.find((c) => c.name === change.entry);
    return { action, what: `${appsLabel(runtime)} ${listed?.title ?? change.entry}` };
  }
  const field = change.field as ListField;
  const name =
    field === 'disabled_skills'
      ? (inventory.skills.find((s) => s.id === change.entry)?.name ?? change.entry)
      : change.entry;
  return { action, what: `${KIND_LABEL[field]} ${name}` };
}

export const canSave = (before: ExtensionOverrides, after: ExtensionOverrides): boolean =>
  selectionChanges(before, after).length > 0;

export type InventoryState =
  | { state: 'loading' }
  | { state: 'ready'; inventory: ExtensionInventory }
  | { state: 'unsupported' }
  | { state: 'error'; code: string; message: string };

/** The tab's state after a read; a runtime without an inventory disables its tab. */
export function inventoryState(result: BridgeResult<ExtensionInventory>): InventoryState {
  if (result.ok) return { state: 'ready', inventory: result.value };
  if (result.error.code === 'unsupported_capability') return { state: 'unsupported' };
  return { state: 'error', code: result.error.code, message: result.error.message };
}

export async function readInventory(
  bridge: Pick<DesktopBridge, 'query'> | undefined,
  project_id: string,
  runtime: string,
): Promise<BridgeResult<ExtensionInventory>> {
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('extensions.inventory', { project_id, runtime })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  const value = result.value as Partial<ExtensionInventory> | null;
  if (
    !Array.isArray(value?.mcp_servers) ||
    !Array.isArray(value.plugins) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.hooks) ||
    !Array.isArray(value.connectors) ||
    typeof value.apps !== 'boolean'
  )
    return {
      ok: false,
      error: { code: 'bad_response', message: 'extensions.inventory result is incomplete' },
    };
  return { ok: true, value: value as ExtensionInventory };
}

/** Counts the times the stream went live, so a disconnect alone reads nothing. */
function useReconnects(): number {
  const live = useBoard((s) => s.status.state === 'live');
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  return reconnects.current.count;
}

const loadingAll = (): Record<Runtime, InventoryState> =>
  Object.fromEntries(RUNTIMES.map((runtime) => [runtime, { state: 'loading' }]));

/** Each runtime's inventory for the project, refreshed on retry, on reconnect and whenever `refresh` changes. */
export function useInventories(project_id: string, refresh = 0) {
  const reconnected = useReconnects();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const [states, setStates] = useState(loadingAll);
  const asked = useRef({ project_id, attempt, refresh });
  useEffect(() => {
    let current = true;
    const was = asked.current;
    asked.current = { project_id, attempt, refresh };
    // A reconnect keeps what shows until the new reads land.
    if (was.project_id !== project_id || was.attempt !== attempt || was.refresh !== refresh)
      setStates(loadingAll());
    for (const runtime of RUNTIMES)
      void readInventory(window.pantheon, project_id, runtime).then((result) => {
        if (current) setStates((s) => ({ ...s, [runtime]: inventoryState(result) }));
      });
    return () => {
      current = false;
    };
  }, [project_id, attempt, refresh, reconnected]);
  return { states, reload };
}

export type McpServerState = NonNullable<McpStatus['servers']>[number];

export async function readMcpStatus(
  bridge: Pick<DesktopBridge, 'query'> | undefined,
  project_id: string,
  runtime: string,
): Promise<BridgeResult<McpStatus>> {
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('mcp.status', { project_id, runtime })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  const value = result.value as Partial<McpStatus> | null;
  if (
    typeof value?.runtime !== 'string' ||
    !(value.servers === undefined || Array.isArray(value.servers))
  )
    return {
      ok: false,
      error: { code: 'bad_response', message: 'mcp.status result is incomplete' },
    };
  return { ok: true, value: value as McpStatus };
}

const NO_SERVERS: ReadonlyMap<string, McpServerState> = new Map();

/** Each MCP server's connection state by name, read again on reconnect; empty until read, and when the runtime reports none. */
export function useMcpStatus(project_id: string, runtime: Runtime) {
  const reconnected = useReconnects();
  const [servers, setServers] = useState<ReadonlyMap<string, McpServerState>>(NO_SERVERS);
  useEffect(() => {
    let current = true;
    setServers(NO_SERVERS);
    void readMcpStatus(window.pantheon, project_id, runtime).then((result) => {
      if (current && result.ok && result.value.servers)
        setServers(new Map(result.value.servers.map((s) => [s.name, s])));
    });
    return () => {
      current = false;
    };
  }, [project_id, runtime, reconnected]);
  return servers;
}

/** Whether the session can reconnect its MCP servers, as its mcp.status says; false until read. */
export function useMcpReconnectable(session_id: string | undefined): boolean {
  const reconnected = useReconnects();
  const [read, setRead] = useState<{ session_id: string; available: boolean } | null>(null);
  useEffect(() => {
    if (!session_id) return;
    let current = true;
    void readQuery('mcp.status', { session_id }).then((result) => {
      if (current)
        setRead({
          session_id,
          available:
            result.ok && (result.value as Partial<McpStatus> | null)?.reconnect_available === true,
        });
    });
    return () => {
      current = false;
    };
  }, [session_id, reconnected]);
  return session_id !== undefined && read?.session_id === session_id && read.available;
}

const SERVER_EVENTS = new Set(['agent.session.started', 'agent.extensions.applied']);

/** The MCP servers the session's own events name; read again when the session reports new ones and on reconnect. */
export function useSessionMcpServers(session_id: string) {
  const reconnected = useReconnects();
  const [servers, setServers] = useState<readonly McpServerState[]>([]);
  const reported = useBoard(
    (s) =>
      s.events.findLast((e) => e.aggregate_id === session_id && SERVER_EVENTS.has(e.kind))
        ?.sequence ?? 0,
  );
  useEffect(() => setServers([]), [session_id]);
  useEffect(() => {
    let current = true;
    void readQuery('session.mcp_servers', { session_id }).then((result) => {
      if (current && result.ok && Array.isArray(result.value))
        setServers(result.value as McpServerState[]);
    });
    return () => {
      current = false;
    };
  }, [session_id, reported, reconnected]);
  return servers;
}

type Session = BoardSnapshot['sessions'][number];

/** The session a reconnect goes through: the project's running session on the runtime, else an open one. */
export function reconnectSession(
  sessions: readonly Pick<Session, 'id' | 'project_id' | 'runtime' | 'state'>[],
  project_id: string,
  runtime: Runtime,
): string | undefined {
  const own = sessions.filter((s) => s.project_id === project_id && s.runtime === runtime);
  return (own.find((s) => s.state === 'running') ?? own.find((s) => s.state === 'open'))?.id;
}

/** Reconnects an MCP server inside a live session. */
export const reconnectMcp = (session_id: string, server: string) =>
  runCommand('mcp.reconnect', { session_id, server }, null);
