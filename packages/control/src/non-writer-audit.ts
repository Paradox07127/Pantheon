import { lstatSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Session, SessionSpec } from '@pantheon/domain';
import { gitFolder, type ControlContext } from './context.js';
import { runGit } from './git.js';

interface WriteSnapshot {
  turn_id: string;
  roots: string[];
  status: Record<string, string>;
  fingerprints: Record<string, string>;
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

/** Tracked changes as git reports them, plus a stat fingerprint per changed path; no contents are read. */
function worktreeState(roots: string[]): Pick<WriteSnapshot, 'status' | 'fingerprints'> {
  const status: Record<string, string> = {};
  const fingerprints: Record<string, string> = {};
  for (const root of roots) {
    const result = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
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

/** The baseline is durable so a reconciled session can still be audited after a daemon restart. */
export function startWriteAudit(
  ctx: ControlContext,
  spec: SessionSpec,
  turnId: string,
  readOnly: boolean,
): void {
  const previous = currentSnapshot(ctx, spec.platform_session_id);
  if (previous?.snapshot.turn_id === turnId) return;
  const session = ctx.store.must<Session>('sessions', spec.platform_session_id);
  if (!readOnly) {
    if (previous) ctx.store.event('session.write_audit_disabled', session, session.project_id, {});
    return;
  }
  // Protected entries outside the project are kept unwritable by the runtime sandbox.
  const roots = (spec.project_roots?.map((root) => root.path) ?? [spec.cwd]).filter(gitFolder);
  const snapshot: WriteSnapshot = { turn_id: turnId, roots, ...worktreeState(roots) };
  ctx.store.event('session.write_snapshot', session, session.project_id, snapshot);
}

/** Compare tracked files and the session's persisted tool trace, including calls whose writes were undone. */
export function finishWriteAudit(ctx: ControlContext, sessionId: string): void {
  const baseline = currentSnapshot(ctx, sessionId);
  if (!baseline) return;
  const { sequence, snapshot } = baseline;
  let paths: string[] = [];
  // A hashed baseline also covered protected entries and cannot be retaken now, so only tools are checked.
  if (!('hashes' in snapshot)) {
    const current = worktreeState(snapshot.roots);
    paths = [...new Set([...Object.keys(snapshot.status), ...Object.keys(current.status)])]
      .filter(
        (file) =>
          snapshot.status[file] !== current.status[file] ||
          snapshot.fingerprints[file] !== current.fingerprints[file],
      )
      .sort();
  }
  const session = ctx.store.must<Session>('sessions', sessionId);
  const tools = new Set<string>();
  for (const event of ctx.store.kindEvents(session.project_id, ['agent.tool.started'])) {
    if (event.aggregate_id !== sessionId || event.sequence <= sequence) continue;
    const call = event.payload as Extract<AgentEvent, { kind: 'tool.started' }>;
    const name = call.name
      .split(/__|[.:/]/)
      .at(-1)!
      .replace(/[_-]/g, '')
      .toLowerCase();
    if (
      /^(write|writefile|writetextfile|edit|editfile|multiedit|notebookedit|applypatch|filechange|delete|deletefile|move|movefile|execute)$/.test(
        name,
      ) ||
      /^(write|edit|delete|move|execute)(?:\s|:)/i.test(call.name)
    )
      tools.add(call.name);
  }
  const result = { snapshot: sequence, turn_id: snapshot.turn_id, paths, tools: [...tools].sort() };
  const last = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE aggregate_id=? AND kind='session.write_audited' ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId) as { payload: string } | undefined;
  if (last && last.payload === JSON.stringify(result)) return;
  ctx.store.event('session.write_audited', session, session.project_id, result);
  if (paths.length || tools.size) {
    const marked = ctx.store.update('sessions', session, session.revision);
    ctx.store.event('session.write_detected', marked, marked.project_id, {
      ...result,
      reason: 'non_writer_write_detected',
    });
  }
}
