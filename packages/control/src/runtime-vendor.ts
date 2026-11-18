import { DomainError, type Project } from '@pantheon/domain';
import { runtime } from './admission.js';
import type { ControlContext } from './context.js';
import { sessionDefaults } from './user-config.js';

/** Only runtimes that run a single vendor's models; multi-model clients stay unknown. */
export const RUNTIME_VENDOR: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
};

export function runtimeVendor(name: string): string {
  return Object.hasOwn(RUNTIME_VENDOR, name) ? RUNTIME_VENDOR[name]! : 'unknown';
}

const INDEPENDENCE = ['other_vendor', 'other_runtime', 'same_runtime'] as const;
type Independence = (typeof INDEPENDENCE)[number];

/**
 * The first admitted reviewer runtime of another vendor than every writer, else one that is not a
 * writer, else a writer's own. The reviewer default, then its fallback, wins when it is admitted
 * and no worse; a single-model project's runtime wins when it is admitted.
 */
export function verifierRuntime(
  ctx: ControlContext,
  projectId: string,
  writers: string[],
): { runtime: string; independence: Independence } | undefined {
  const admitted = (name: string) => {
    try {
      runtime(ctx, name, 'reviewer');
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  };
  const writerVendors = writers.map(runtimeVendor);
  // A writer of unknown vendor may run any vendor's model, so no runtime counts as another vendor.
  const independence = (name: string): Independence => {
    const vendor = runtimeVendor(name);
    if (
      writers.length > 0 &&
      vendor !== 'unknown' &&
      writerVendors.every((writer) => writer !== 'unknown' && writer !== vendor)
    )
      return 'other_vendor';
    return writers.includes(name) ? 'same_runtime' : 'other_runtime';
  };
  const rank = (name: string) => INDEPENDENCE.indexOf(independence(name));
  let best: string | undefined;
  for (const name of ctx.adapters.keys())
    if ((best === undefined || rank(name) < rank(best)) && admitted(name)) best = name;
  const defaults = sessionDefaults(ctx, ctx.store.must<Project>('projects', projectId));
  const single = !defaults?.reviewer && defaults?.single_model;
  const preferred = defaults?.reviewer ?? (single ? defaults : undefined);
  const chosen = [preferred, preferred && defaults?.fallbacks?.reviewer].find(
    (choice) =>
      choice &&
      admitted(choice.runtime) &&
      (single || best === undefined || rank(choice.runtime) <= rank(best)),
  );
  if (chosen) best = chosen.runtime;
  return best === undefined ? undefined : { runtime: best, independence: independence(best) };
}
