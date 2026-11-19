import { acpProfiles, nativeRuntimes } from '@pantheon/adapters';
import { requireThat, type Principal } from '@pantheon/domain';
import { type Command } from '@pantheon/protocol';
import { userOnly, type ControlContext, type Handler } from './context.js';
import { readUserConfig, writeUserConfig } from './user-config.js';

/** Prepare before entering the command transaction: version probing performs asynchronous I/O. */
export async function prepareRuntimeConfig(
  ctx: ControlContext,
  principal: Principal,
  command: Command,
  input: {
    runtime: string;
    enabled?: boolean;
    binary?: string;
    args?: string[];
    artifacts?: boolean;
    unverified_isolation?: boolean;
  },
): Promise<Handler> {
  userOnly(principal);
  const { runtime, ...patch } = input;
  requireThat(
    (nativeRuntimes as readonly string[]).includes(runtime) || Object.hasOwn(acpProfiles, runtime),
    'invalid_input',
    `Unknown runtime ${runtime}`,
  );
  const directory = ctx.userConfigDir;
  requireThat(
    directory !== undefined && ctx.createRuntimeAdapter,
    'unsupported_capability',
    'This daemon cannot configure runtimes',
  );
  const current = readUserConfig(directory);
  const config = { ...current.runtimes?.[runtime], ...patch };
  const adapter =
    config.enabled === false ? undefined : await ctx.createRuntimeAdapter(runtime, config);
  return () => {
    writeUserConfig(directory, { runtimes: { ...current.runtimes, [runtime]: config } });
    if (adapter) ctx.adapters.set(runtime, adapter);
    else ctx.adapters.delete(runtime);
    ctx.runtimeStatus.delete(runtime);
    ctx.store.event(
      'runtime.config_set',
      { id: runtime, revision: 1 },
      '',
      input,
      command.command_id,
    );
    return { runtime, ...config };
  };
}
