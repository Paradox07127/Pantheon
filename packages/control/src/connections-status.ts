import { z } from 'zod';
import { DomainError, type Principal } from '@pantheon/domain';
import type { ConnectionsStatus } from '@pantheon/protocol';
import { userOnly, type ControlContext } from './context.js';
import type { LocalCommand } from './local-command.js';

const cached = new WeakMap<ControlContext, { at: number; value: ConnectionsStatus }>();
const accountSchema = z.union([
  z.object({
    state: z.literal('success'),
    active: z.literal(true),
    host: z.string(),
    login: z.string(),
    scopes: z.string(),
  }),
  z
    .object({ state: z.string(), active: z.boolean() })
    .refine((value) => value.state !== 'success' || !value.active),
]);
const authSchema = z.object({ hosts: z.record(z.string(), z.array(accountSchema)) });

export function githubJson<T>(stdout: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new DomainError(
      'connection_check_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function githubConnection(
  run: LocalCommand,
  host?: string,
): Promise<ConnectionsStatus['github']> {
  const result = await run('gh', ['auth', 'status', '--json', 'hosts']);
  if (result.missing) return { state: 'missing', installed: false, signed_in: false };
  if (result.timed_out) return { state: 'timeout', installed: true, signed_in: null };
  if (!result.stdout.trim() && result.exit_code === 1)
    return { state: 'signed_out', installed: true, signed_in: false };
  if (result.exit_code !== 0 && result.exit_code !== 1)
    throw new DomainError('connection_check_failed', result.stderr);
  const parsed = githubJson(result.stdout, authSchema);
  const accounts = Object.values(parsed.hosts)
    .flat()
    .filter((value) => 'host' in value);
  const account = host
    ? accounts.find((value) => value.host === host)
    : (accounts.find((value) => value.host === 'github.com') ?? accounts[0]);
  return account
    ? {
        state: 'signed_in',
        installed: true,
        signed_in: true,
        host: account.host,
        account: account.login,
        scopes: account.scopes
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean),
      }
    : { state: 'signed_out', installed: true, signed_in: false };
}

export async function connectionsStatus(
  ctx: ControlContext,
  principal: Principal,
  refresh: boolean,
): Promise<ConnectionsStatus> {
  userOnly(principal);
  const previous = cached.get(ctx);
  if (!refresh && previous && ctx.store.now() - previous.at < 60_000) return previous.value;
  const [github, huggingface, cloudflare] = await Promise.all([
    githubConnection(ctx.localCommand),
    (async (): Promise<ConnectionsStatus['huggingface']> => {
      let result = await ctx.localCommand('hf', ['auth', 'whoami']);
      if (result.missing) result = await ctx.localCommand('huggingface-cli', ['whoami']);
      if (result.missing) return { state: 'missing', installed: false, signed_in: false };
      if (result.timed_out) return { state: 'timeout', installed: true, signed_in: null };
      if (result.exit_code !== 0 || /not logged in|not authenticated/i.test(result.stdout))
        return { state: 'signed_out', installed: true, signed_in: false };
      const account = /^(?:user\s*[:=]\s*)?(\S+)/m.exec(result.stdout.trim())?.[1];
      return account
        ? { state: 'signed_in', installed: true, signed_in: true, account }
        : { state: 'signed_out', installed: true, signed_in: false };
    })(),
    (async (): Promise<ConnectionsStatus['cloudflare']> => {
      const result = await ctx.localCommand('wrangler', ['whoami']);
      if (result.missing) return { state: 'missing', installed: false, signed_in: false };
      if (result.timed_out) return { state: 'timeout', installed: true, signed_in: null };
      const signed_in = result.exit_code === 0 && /You are logged in/i.test(result.stdout);
      const account = /associated with the email\s+([^\s!]+)/i.exec(result.stdout)?.[1];
      return {
        state: signed_in ? 'signed_in' : 'signed_out',
        installed: true,
        signed_in,
        ...(signed_in && account ? { account } : {}),
      };
    })(),
  ]);
  const value = { github, huggingface, cloudflare };
  cached.set(ctx, { at: ctx.store.now(), value });
  return value;
}
