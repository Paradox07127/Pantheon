import type { ExternalSourceStatus, Project } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { externalEvents } from './user-config.js';

export interface ExternalSource {
  id: string;
  /**
   * Reads the source for the projects that take external events and hands what it finds to
   * receiveExternalEvent; resolves to the milliseconds until it wants the next poll.
   */
  poll(ctx: ControlContext, projects: Project[]): Promise<number>;
}

const RETRY_MS = 60_000;

interface Polling extends ExternalSourceStatus {
  next_poll_at: number;
  running: boolean;
}
const pollings = new WeakMap<ControlContext, Map<string, Polling>>();

function pollingOf(ctx: ControlContext, id: string): Polling {
  let all = pollings.get(ctx);
  if (!all) pollings.set(ctx, (all = new Map()));
  let polling = all.get(id);
  if (!polling) all.set(id, (polling = { id, next_poll_at: 0, running: false }));
  return polling;
}

/** Polls each source that is due and not being polled; a source that fails keeps its error and is asked again later. */
export async function pollExternalSources(ctx: ControlContext): Promise<void> {
  const due = (ctx.externalSources ?? []).filter((source) => {
    const polling = pollingOf(ctx, source.id);
    return !polling.running && ctx.store.now() >= polling.next_poll_at;
  });
  if (!due.length) return;
  const projects = ctx.store
    .list<Project>('projects')
    .filter(
      (project) =>
        externalEvents(ctx, project) !== 'off' &&
        !project.removed_at &&
        project.kind !== 'personal',
    );
  await Promise.all(
    due.map(async (source) => {
      const polling = pollingOf(ctx, source.id);
      let wait = RETRY_MS;
      if (projects.length) {
        polling.running = true;
        try {
          wait = await source.poll(ctx, projects);
          polling.polled_at = ctx.store.now();
          delete polling.error;
        } catch (error) {
          polling.error = error instanceof Error ? error.message : String(error);
        }
        polling.running = false;
        ctx.changed();
      }
      polling.next_poll_at = ctx.store.now() + wait;
    }),
  );
}

/** Starts the due polls; the daemon tick does not wait for a source to answer. */
export function tickExternalSources(ctx: ControlContext): void {
  const work: Promise<void> = pollExternalSources(ctx).finally(() => ctx.completions.delete(work));
  ctx.completions.add(work);
}

export function externalSourceStatuses(ctx: ControlContext): ExternalSourceStatus[] {
  return (ctx.externalSources ?? []).map((source) => {
    const { id, polled_at, error } = pollingOf(ctx, source.id);
    return {
      id,
      ...(polled_at !== undefined && { polled_at }),
      ...(error !== undefined && { error }),
    };
  });
}
