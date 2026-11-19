import {
  id,
  requireThat,
  type Playbook,
  type PlaybookSections,
  type Project,
} from '@pantheon/domain';
import { inputSchemas, type PlaybookRead } from '@pantheon/protocol';
import { LEAD_PLAYBOOK } from './agent-prompts.js';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';

/** The project's playbook for runtime, or its default playbook without runtime. */
const storedPlaybook = (ctx: ControlContext, projectId: string, runtime: string | undefined) =>
  ctx.store
    .list<Playbook>('playbooks')
    .find((row) => row.project_id === projectId && row.runtime === runtime);

function playbookRead(
  ctx: ControlContext,
  projectId: string,
  runtime: string | undefined,
): PlaybookRead {
  const own = storedPlaybook(ctx, projectId, runtime);
  const used =
    own ?? (runtime === undefined ? undefined : storedPlaybook(ctx, projectId, undefined));
  return {
    project_id: projectId,
    ...(runtime === undefined ? {} : { runtime }),
    version: own?.version ?? 0,
    source: !used ? 'code' : used.runtime === undefined ? 'default' : 'runtime',
    sections: used ? used.versions[used.version]! : { ...LEAD_PLAYBOOK },
  };
}

/** The behaviour sections a lead of runtime gets in the project. */
export const leadPlaybook = (
  ctx: ControlContext,
  projectId: string,
  runtime: string,
): PlaybookSections => playbookRead(ctx, projectId, runtime).sections;

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

export const playbookHandlers: Handlers = {
  'playbook.get': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['playbook.get'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    return playbookRead(ctx, input.project_id, input.runtime);
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
};
