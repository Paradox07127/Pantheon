import { useEffect, useRef, useState } from 'react';
import type { BridgeResult, DesktopBridge, ProjectHead, RuntimeModel } from '@pantheon/protocol';
import { useBoard } from './board';
import {
  completionSkills,
  loadState,
  readInventory,
  savedOverrides,
  type ExtensionInventory,
} from './extensions';
import { failureText } from './needs-you';
import { REPOSITORY_KINDS, useProjectQuery } from './project-read';

export type ModelsState =
  | { state: 'loading' }
  | { state: 'ready'; models: RuntimeModel[] }
  | { state: 'failed'; text: string };

export async function readModels(
  bridge: Pick<DesktopBridge, 'query'> | undefined,
  project_id: string,
  runtime: string,
): Promise<BridgeResult<RuntimeModel[]>> {
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('runtime.models', { project_id, runtime })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok)
    return result.error.code === 'unsupported_capability' ? { ok: true, value: [] } : result;
  const value = result.value as Partial<RuntimeModel>[] | null;
  if (
    !Array.isArray(value) ||
    !value.every(
      (m) => typeof m?.id === 'string' && typeof m.label === 'string' && Array.isArray(m.efforts),
    )
  )
    return {
      ok: false,
      error: { code: 'bad_response', message: 'runtime.models result is incomplete' },
    };
  return { ok: true, value: value as RuntimeModel[] };
}

interface ModelsRead {
  state: ModelsState;
  done: Promise<ModelsState>;
  /** When the read succeeded; null while it runs. */
  at: number | null;
}

/** A successful read older than this is done again on the next mount; its result shows meanwhile. */
const MAX_AGE_MS = 60_000;
const fresh = (read: { at: number | null }) =>
  read.at === null || Date.now() - read.at < MAX_AGE_MS;

// One read per project and runtime shared across mounts; a failed read is tried again on the next
// mount or reconnect.
const reads = new Map<string, ModelsRead>();
const readKey = (project_id: string, runtime: string) => JSON.stringify([project_id, runtime]);

function readOnce(project_id: string, runtime: string): ModelsRead {
  const key = readKey(project_id, runtime);
  const known = reads.get(key);
  if (known && fresh(known)) return known;
  const read: ModelsRead = {
    state: known?.state ?? { state: 'loading' },
    at: null,
    done: readModels(window.pantheon, project_id, runtime).then((result) => {
      read.state = result.ok
        ? { state: 'ready', models: result.value }
        : { state: 'failed', text: failureText(result.error) };
      read.at = Date.now();
      if (!result.ok) reads.delete(key);
      return read.state;
    }),
  };
  reads.set(key, read);
  return read;
}

/** Counts the times the stream went live, so a disconnect alone reads nothing. */
function useReconnects(): number {
  const live = useBoard((s) => s.status.state === 'live');
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  return reconnects.current.count;
}

/** GET /v1/runtime.models for each runtime of the project, kept across mounts for MAX_AGE_MS. */
export function useRuntimeModels(
  project_id: string | null,
  runtimes: readonly string[],
): Record<string, ModelsState> {
  const [settled, setSettled] = useState<Readonly<Record<string, ModelsState>>>({});
  const names = runtimes.join('\n');
  const reconnected = useReconnects();

  useEffect(() => {
    if (!project_id) return;
    let current = true;
    for (const runtime of runtimes)
      void readOnce(project_id, runtime).done.then((state) => {
        if (current) setSettled((now) => ({ ...now, [readKey(project_id, runtime)]: state }));
      });
    return () => {
      current = false;
    };
  }, [project_id, names, reconnected]);

  return Object.fromEntries(
    runtimes.map((runtime): [string, ModelsState] => {
      const key = project_id ? readKey(project_id, runtime) : '';
      return [runtime, settled[key] ?? reads.get(key)?.state ?? { state: 'loading' }];
    }),
  );
}

/** GET /v1/files.search: up to 50 paths best matching q, in the session's worktree when given. */
export async function searchFiles(
  project_id: string,
  session_id: string | null,
  q: string,
): Promise<BridgeResult<string[]>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('files.search', { project_id, ...(session_id ? { session_id } : {}), q })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  const value = result.value;
  if (!Array.isArray(value) || !value.every((path) => typeof path === 'string'))
    return {
      ok: false,
      error: { code: 'bad_response', message: 'files.search result is not a list of paths' },
    };
  return { ok: true, value: value as string[] };
}

type Skill = ExtensionInventory['skills'][number];
type Connector = ExtensionInventory['connectors'][number];

interface InventoryRead {
  inventory: ExtensionInventory | null;
  done: Promise<ExtensionInventory | null>;
  /** When the read succeeded; null while it runs. */
  at: number | null;
}

// One inventory read per project and runtime, done again like the models; a failed read is tried again on the next mount or reconnect.
const inventoryReads = new Map<string, InventoryRead>();
const NO_SKILLS: Skill[] = [];
const NO_CONNECTORS: Connector[] = [];

function readInventoryOnce(project_id: string, runtime: string): InventoryRead {
  const key = readKey(project_id, runtime);
  const known = inventoryReads.get(key);
  if (known && fresh(known)) return known;
  const read: InventoryRead = {
    inventory: known?.inventory ?? null,
    at: null,
    done: readInventory(window.pantheon, project_id, runtime).then((result) => {
      read.inventory = result.ok ? result.value : null;
      read.at = Date.now();
      if (!result.ok) inventoryReads.delete(key);
      return read.inventory;
    }),
  };
  inventoryReads.set(key, read);
  return read;
}

/** The runtime's skills the project's sessions load; empty until read. */
export function useSkills(project_id: string, runtime: string): Skill[] {
  const [settled, setSettled] = useState<Readonly<Record<string, ExtensionInventory>>>({});
  const key = readKey(project_id, runtime);
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === project_id));
  const reconnected = useReconnects();

  useEffect(() => {
    let current = true;
    void readInventoryOnce(project_id, runtime).done.then((inventory) => {
      if (current && inventory) setSettled((now) => ({ ...now, [key]: inventory }));
    });
    return () => {
      current = false;
    };
  }, [key, reconnected]);

  const inventory = settled[key] ?? inventoryReads.get(key)?.inventory;
  return inventory
    ? completionSkills(inventory, savedOverrides(project ?? {}, runtime))
    : NO_SKILLS;
}

/** The runtime's connectors the project turned on; empty until read. */
export function useConnectors(project_id: string, runtime: string): Connector[] {
  const [inventory, setInventory] = useState<ExtensionInventory | null>(null);
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === project_id));
  const reconnected = useReconnects();
  useEffect(() => {
    let current = true;
    void readInventoryOnce(project_id, runtime).done.then((read) => {
      if (current) setInventory(read);
    });
    return () => {
      current = false;
    };
  }, [project_id, runtime, reconnected]);
  return inventory
    ? loadState(inventory, savedOverrides(project ?? {}, runtime)).connectors.filter(
        (c) => c.loaded,
      )
    : NO_CONNECTORS;
}

const isHead = (value: unknown): boolean => {
  const head = value as Partial<ProjectHead> | null;
  return (
    !!head &&
    typeof head.sha === 'string' &&
    typeof head.subject === 'string' &&
    (head.branch === null || typeof head.branch === 'string')
  );
};

/**
 * GET /v1/project.head: the branch and commit the project's first folder has checked out; read
 * again after repository events and on window focus.
 */
export const useProjectHead = (project_id: string | null) =>
  useProjectQuery<ProjectHead>('project.head', project_id, isHead, undefined, {
    kinds: REPOSITORY_KINDS,
  });
