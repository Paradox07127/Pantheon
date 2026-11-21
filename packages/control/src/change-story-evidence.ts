import {
  hash,
  type Session,
  type StoryContext,
  type Workspace,
  type Project,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { gateCommands } from './landing.js';
import { sessionGoal } from './landing-diff.js';

/** Only a recorded run of this commit and this command configuration can support a story. */
export function storyContext(ctx: ControlContext, session: Session, commit: string): StoryContext {
  const project = ctx.store.must<Project>('projects', session.project_id);
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  const commands = gateCommands(ctx, project, workspace, session) ?? [];
  const spec_hash = hash(commands.length ? commands : undefined);
  const event = ctx.store
    .kindEvents(session.project_id, ['session.gate_checked'])
    .findLast((event) => event.aggregate_id === session.id);
  const run = event?.payload as
    | { commit?: string; check_spec_hash?: string; results?: StoryContext['checks']['results'] }
    | undefined;
  return {
    goal: sessionGoal(ctx, session),
    acceptance: [],
    contract_available: true,
    checks: {
      state: !run
        ? 'none'
        : run.commit === commit && run.check_spec_hash === spec_hash
          ? 'recorded'
          : 'stale',
      spec_hash,
      commands,
      ...(event && run
        ? {
            run_id: event.event_id,
            commit: run.commit,
            recorded_spec_hash: run.check_spec_hash,
            checked_at: event.created_at,
          }
        : {}),
      results: run?.results ?? [],
    },
  };
}
