import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  id,
  requireThat,
  type Playbook,
  type PlaybookSections,
  type Project,
  type Session,
} from '@pantheon/domain';
import { inputSchemas, type PlaybookExport, type PlaybookRead } from '@pantheon/protocol';
import { LEAD_PLAYBOOK } from './agent-prompts.js';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';

/** The project's playbook for runtime, or its default playbook without runtime. */
export const storedPlaybook = (
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
) =>
  ctx.store
    .list<Playbook>('playbooks')
    .find((row) => row.project_id === projectId && row.runtime === runtime);

function playbookRead(
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
  version?: number,
): PlaybookRead {
  const own = storedPlaybook(ctx, projectId, runtime);
  const used =
    own ?? (runtime === undefined ? undefined : storedPlaybook(ctx, projectId, undefined));
  requireThat(
    version === undefined || own?.versions[version] !== undefined,
    'not_found',
    `playbooks/${runtime ?? 'default'}/versions/${version}`,
  );
  return {
    project_id: projectId,
    ...(runtime === undefined ? {} : { runtime }),
    version: own?.version ?? 0,
    versions: Object.keys(own?.versions ?? {})
      .map(Number)
      .sort((a, b) => a - b),
    source: !used ? 'code' : used.runtime === undefined ? 'default' : 'runtime',
    sections: used ? used.versions[version ?? used.version]! : { ...LEAD_PLAYBOOK },
    built_in: { ...LEAD_PLAYBOOK },
  };
}

/** The behaviour sections a lead of runtime gets in the project. */
export const leadPlaybook = (
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
): PlaybookSections => playbookRead(ctx, projectId, runtime).sections;

/** The behaviour sections a lead session starts its process with; records on it which version that is. */
export function startedLeadPlaybook(ctx: ControlContext, session: Session): PlaybookSections {
  const used =
    storedPlaybook(ctx, session.project_id, session.runtime) ??
    storedPlaybook(ctx, session.project_id, undefined);
  const playbook = {
    ...(used?.runtime === undefined ? {} : { runtime: used.runtime }),
    version: used?.version ?? 0,
  };
  const current = ctx.store.must<Session>('sessions', session.id);
  if (
    current.playbook?.runtime !== playbook.runtime ||
    current.playbook?.version !== playbook.version
  )
    ctx.store.update('sessions', { ...current, playbook }, current.revision);
  return leadPlaybook(ctx, session.project_id, session.runtime);
}

/** The current version of the project's playbook for runtime, or of its default without runtime; 0 while none is stored. */
export const playbookVersion = (
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
): number => storedPlaybook(ctx, projectId, runtime)?.version ?? 0;

/** Makes a stored version of the playbook current for the leads that start afterwards. */
export function setPlaybookVersion(
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
  version: number,
  causationId = '',
): Playbook {
  const old = storedPlaybook(ctx, projectId, runtime);
  requireThat(
    old?.versions[version] !== undefined,
    'invalid_input',
    `Playbook version ${version} is not stored`,
  );
  const next = ctx.store.update('playbooks', { ...old!, version }, old!.revision);
  ctx.store.event('playbook.changed', next, projectId, { runtime, version }, causationId);
  return next;
}

/** Where playbook.export writes a stored version of the project's playbook for runtime. */
export const playbookExportPath = (
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
  version: number,
) =>
  path.join(
    path.dirname(ctx.files.directory),
    'playbooks',
    projectId,
    `${runtime ?? 'default'}-${version}.json`,
  );

/** Writes a stored version as the eval condition playbook=file:<path> reads it; returns the path. */
export function exportPlaybook(
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
  version: number,
): string {
  const { sections } = playbookRead(ctx, projectId, runtime, version);
  const file = playbookExportPath(ctx, projectId, runtime, version);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version, sections }, null, 2)}\n`);
  return file;
}

export const playbookHandlers: Handlers = {
  'playbook.export': (ctx, p, c): PlaybookExport => {
    userOnly(p);
    const input = inputSchemas['playbook.export'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    return { path: exportPlaybook(ctx, input.project_id, input.runtime, input.version) };
  },
  'playbook.get': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['playbook.get'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    return playbookRead(ctx, input.project_id, input.runtime, input.version);
  },
  'playbook.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['playbook.set'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const old = storedPlaybook(ctx, input.project_id, input.runtime);
    requireThat(
      input.base_version === (old?.version ?? 0),
      'version_conflict',
      'Supply the current playbook base_version',
    );
    // A version made current again keeps the later ones, so the next number follows the highest.
    const version = Math.max(0, ...Object.keys(old?.versions ?? {}).map(Number)) + 1;
    const value: Playbook = {
      id: old?.id ?? id(),
      revision: old?.revision ?? 1,
      project_id: input.project_id,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      version,
      versions: { ...old?.versions, [version]: input.sections },
    };
    const stored = old
      ? ctx.store.update('playbooks', value, old.revision)
      : ctx.store.insert('playbooks', value);
    ctx.store.event(
      'playbook.changed',
      stored,
      input.project_id,
      { runtime: input.runtime, version },
      c.command_id,
    );
    return playbookRead(ctx, input.project_id, input.runtime);
  },
  'playbook.remove': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['playbook.remove'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const old = storedPlaybook(ctx, input.project_id, input.runtime);
    requireThat(old, 'not_found', `playbooks/${input.runtime ?? 'default'}`);
    requireThat(
      input.base_version === old.version,
      'version_conflict',
      'Supply the current playbook base_version',
    );
    ctx.store.remove('playbooks', old.id, old.revision);
    ctx.store.event(
      'playbook.changed',
      old,
      input.project_id,
      { runtime: input.runtime, version: 0 },
      c.command_id,
    );
    return playbookRead(ctx, input.project_id, input.runtime);
  },
};
