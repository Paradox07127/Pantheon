import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireThat, type Project } from '@pantheon/domain';
import { inputSchemas, type HiddenChecksRead } from '@pantheon/protocol';
import {
  projectAccess,
  projectFolder,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';

/** Kept in the project's folder beside its worktrees, never in a worktree or a project root. */
const checksFile = (ctx: ControlContext, projectId: string) =>
  path.join(projectFolder(ctx, projectId), 'checks', 'hidden.json');

/** The checks only milestone verification runs; none without managed worktrees. */
export function hiddenChecks(ctx: ControlContext, projectId: string): HiddenChecksRead['checks'] {
  if (!ctx.workspaceRoot) return [];
  const file = checksFile(ctx, projectId);
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Pick<HiddenChecksRead, 'checks'>).checks
    : [];
}

export const milestoneCheckHandlers: Handlers = {
  'milestone.checks.get': (ctx, p, c): HiddenChecksRead => {
    userOnly(p);
    const input = inputSchemas['milestone.checks.get'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    return { project_id: input.project_id, checks: hiddenChecks(ctx, input.project_id) };
  },
  'milestone.checks.set': (ctx, p, c): HiddenChecksRead => {
    userOnly(p);
    const input = inputSchemas['milestone.checks.set'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    requireThat(
      ctx.workspaceRoot !== undefined,
      'unsupported_capability',
      'Hidden checks are kept in the managed worktree folder, which this daemon has none of',
    );
    const file = checksFile(ctx, input.project_id);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.next`, `${JSON.stringify({ checks: input.checks }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(`${file}.next`, file);
    return { project_id: input.project_id, checks: input.checks };
  },
};
