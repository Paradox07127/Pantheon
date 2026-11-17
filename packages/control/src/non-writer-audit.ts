import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Session, SessionSpec, Workspace } from '@pantheon/domain';
import { gitFolderAsync, type ControlContext, type Handler } from './context.js';
import { runGit, type GitResult } from './git.js';
import { isolationWaived } from './admission.js';

interface WriteSnapshot {
  turn_id: string;
  roots: string[];
  status: Record<string, string>;
  fingerprints: Record<string, string>;
  /** Set for a writer without verified isolation; roots then hold its source checkout. */
  worktree?: string;
}

interface HashedSnapshot {
  turn_id: string;
  hashes: Record<string, string>;
}

function currentSnapshot(ctx: ControlContext, sessionId: string) {
  const row = ctx.store.db
    .prepare(
      "SELECT sequence, kind, payload FROM events WHERE aggregate_id=? AND kind IN ('session.write_snapshot','session.write_audit_disabled') ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId) as { sequence: number; kind: string; payload: string } | undefined;
  return row?.kind === 'session.write_snapshot'
    ? {
        sequence: row.sequence,
        snapshot: JSON.parse(row.payload) as WriteSnapshot | HashedSnapshot,
      }
    : undefined;
}

const STATUS = ['status', '--porcelain=v1', '-z'];

export type WrittenState = Pick<WriteSnapshot, 'status' | 'fingerprints'>;

/** Tracked changes as git reported them per root, plus a stat fingerprint per changed path; no contents are read. */
function worktreeState(roots: string[], results: GitResult[]): WrittenState {
  const status: Record<string, string> = {};
  const fingerprints: Record<string, string> = {};
  for (const [rootIndex, root] of roots.entries()) {
    const result = results[rootIndex]!;
    if (result.exit_code !== 0) throw new Error(result.stderr.toString() || result.error);
    const fields = result.stdout.toString().split('\0');
    for (let index = 0; index < fields.length; index++) {
      const entry = fields[index]!;
      if (!entry) continue;
      const code = entry.slice(0, 2);
      status[path.join(root, entry.slice(3))] = code;
      // A rename or copy entry is followed by its source path.
      if (/[RC]/.test(code)) status[path.join(root, fields[++index]!)] = code;
    }
  }
  for (const file of Object.keys(status)) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    fingerprints[file] = stat
      ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      : 'missing';
  }
  return { status, fingerprints };
}

async function currentState(roots: string[], untracked: boolean) {
  const args = [...STATUS, `--untracked-files=${untracked ? 'all' : 'no'}`];
  return worktreeState(
    roots,
    await Promise.all(roots.map((root) => runGit(root, args, undefined, true))),
  );
}

/** The baseline is durable so a reconciled session can still be audited after a daemon restart. */
export async function startWriteAudit(
  ctx: ControlContext,
  spec: SessionSpec,
  turnId: string,
  readOnly: boolean,
): Promise<void> {
  const previous = currentSnapshot(ctx, spec.platform_session_id);
  if (previous?.snapshot.turn_id === turnId) return;
  const session = ctx.store.must<Session>('sessions', spec.platform_session_id);
  if (!readOnly) {
    const workspace = spec.workspace && ctx.store.get<Workspace>('workspaces', spec.workspace.id);
    if (
      isolationWaived(ctx, spec.runtime) &&
      workspace?.kind === 'linked_worktree' &&
      workspace.source
    ) {
      const roots = [workspace.source];
      const snapshot: WriteSnapshot = {
        turn_id: turnId,
        roots,
        ...(await currentState(roots, true)),
        worktree: spec.cwd,
      };
      ctx.store.event(
        'session.write_snapshot',
        ctx.store.must<Session>('sessions', session.id),
        session.project_id,
        snapshot,
      );
      return;
    }
    if (previous) ctx.store.event('session.write_audit_disabled', session, session.project_id, {});
    return;
  }
  // Protected entries outside the project are kept unwritable by the runtime sandbox.
  const candidates = spec.project_roots?.map((root) => root.path) ?? [spec.cwd];
  const git = await Promise.all(candidates.map(gitFolderAsync));
  const roots = candidates.filter((_, index) => git[index]);
  const snapshot: WriteSnapshot = { turn_id: turnId, roots, ...(await currentState(roots, false)) };
  ctx.store.event(
    'session.write_snapshot',
    ctx.store.must<Session>('sessions', session.id),
    session.project_id,
    snapshot,
  );
}

/** Compare tracked files and the session's persisted tool trace, including calls whose writes were undone. */
export async function finishWriteAudit(ctx: ControlContext, sessionId: string): Promise<void> {
  const baseline = currentSnapshot(ctx, sessionId);
  if (!baseline) return;
  const { snapshot } = baseline;
  // A hashed baseline also covered protected entries and cannot be retaken now, so only tools are checked.
  const current =
    'hashes' in snapshot
      ? undefined
      : await currentState(snapshot.roots, snapshot.worktree !== undefined);
  recordWriteAudit(ctx, sessionId, baseline, current);
}

/** The roots a reconciled session's audit reads git status in, and whether it lists untracked files; no roots without a status baseline. */
export function reconciledWriteRoots(
  ctx: ControlContext,
  sessionId: string,
): { roots: string[]; untracked: boolean } {
  const snapshot = currentSnapshot(ctx, sessionId)?.snapshot;
  return !snapshot || 'hashes' in snapshot
    ? { roots: [], untracked: false }
    : { roots: snapshot.roots, untracked: snapshot.worktree !== undefined };
}

/** The handler of a reconciled close, given the tracked state its audit compares read before the transaction. */
export function withReconciledState(
  ctx: ControlContext,
  sessionId: string,
  handler: (...args: [...Parameters<Handler>, WrittenState?]) => unknown,
): Handler | Promise<Handler> {
  const { roots, untracked } = reconciledWriteRoots(ctx, sessionId);
  if (!roots.length) return handler;
  return currentState(roots, untracked).then(
    (state): Handler =>
      (ctx, p, c) =>
        handler(ctx, p, c, state),
  );
}

/** The tracked state of each session's reconciledWriteRoots, read before the transaction that closes them. */
export async function reconciledStates(
  ctx: ControlContext,
  sessionIds: string[],
): Promise<Map<string, WrittenState>> {
  const read = await Promise.all(
    sessionIds.map(async (id) => {
      const { roots, untracked } = reconciledWriteRoots(ctx, id);
      return roots.length ? ([[id, await currentState(roots, untracked)]] as const) : [];
    }),
  );
  return new Map(read.flat());
}

/** finishWriteAudit inside the caller's transaction, against the state of reconciledWriteRoots read before it. */
export function finishReconciledWriteAudit(
  ctx: ControlContext,
  sessionId: string,
  current: WrittenState | undefined,
): void {
  const baseline = currentSnapshot(ctx, sessionId);
  if (!baseline) return;
  recordWriteAudit(ctx, sessionId, baseline, current);
}

/** The tool name, by its last segment or its title, of a call that writes files. */
export function writesFiles(tool: string): boolean {
  const name = tool
    .split(/__|[.:/]/)
    .at(-1)!
    .replace(/[_-]/g, '')
    .toLowerCase();
  return (
    /^(write|writefile|writetextfile|edit|editfile|multiedit|notebookedit|applypatch|filechange|delete|deletefile|move|movefile|execute)$/.test(
      name,
    ) || /^(write|edit|delete|move|execute)(?:\s|:)/i.test(tool)
  );
}

/** The resolved path a file tool's input names, when it lies outside the worktree. */
export function outsideWorktree(
  worktree: string,
  input: Record<string, unknown>,
): string | undefined {
  const target = [input.file_path, input.path, input.filePath, input.notebook_path].find(
    (field): field is string => typeof field === 'string',
  );
  if (target === undefined) return;
  const resolved = path.resolve(worktree, target);
  const relative = path.relative(worktree, resolved);
  return relative.startsWith('..') || path.isAbsolute(relative) ? resolved : undefined;
}

function recordWriteAudit(
  ctx: ControlContext,
  sessionId: string,
  { sequence, snapshot }: NonNullable<ReturnType<typeof currentSnapshot>>,
  current: WrittenState | undefined,
): void {
  let paths: string[] = [];
  if (current && !('hashes' in snapshot))
    paths = [...new Set([...Object.keys(snapshot.status), ...Object.keys(current.status)])]
      .filter(
        (file) =>
          snapshot.status[file] !== current.status[file] ||
          snapshot.fingerprints[file] !== current.fingerprints[file],
      )
      .sort();
  const session = ctx.store.must<Session>('sessions', sessionId);
  const tools = new Set<string>();
  const outside = new Set<string>();
  const worktree = 'hashes' in snapshot ? undefined : snapshot.worktree;
  for (const event of ctx.store.kindEvents(session.project_id, ['agent.tool.started'])) {
    if (event.aggregate_id !== sessionId || event.sequence <= sequence) continue;
    const call = event.payload as Extract<AgentEvent, { kind: 'tool.started' }>;
    if (writesFiles(call.name)) {
      tools.add(call.name);
      if (worktree === undefined) continue;
      const resolved = outsideWorktree(worktree, (call.input ?? {}) as Record<string, unknown>);
      if (resolved !== undefined) outside.add(resolved);
    }
  }
  const result = {
    snapshot: sequence,
    turn_id: snapshot.turn_id,
    paths,
    tools: [...tools].sort(),
    ...(worktree !== undefined && { outside_paths: [...outside].sort() }),
  };
  const last = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE aggregate_id=? AND kind='session.write_audited' ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId) as { payload: string } | undefined;
  if (last && last.payload === JSON.stringify(result)) return;
  ctx.store.event('session.write_audited', session, session.project_id, result);
  if (worktree !== undefined ? paths.length || outside.size : paths.length || tools.size) {
    const marked = ctx.store.update('sessions', session, session.revision);
    ctx.store.event('session.write_detected', marked, marked.project_id, {
      ...result,
      reason:
        worktree !== undefined ? 'outside_worktree_write_detected' : 'non_writer_write_detected',
    });
  }
}
