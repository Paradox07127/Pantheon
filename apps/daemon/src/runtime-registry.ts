import { execFile } from 'node:child_process';
import {
  AcpAdapter,
  acpProfiles,
  ClaudeAdapter,
  CodexAdapter,
  nativeEnvironment,
} from '@pantheon/adapters';
import type { HarnessAdapter } from '@pantheon/domain';
import type { UserConfig } from '@pantheon/protocol';

type RuntimeConfig = NonNullable<UserConfig['runtimes']>[string];

/** Builds a replacement without changing the registry or any existing sessions. */
export async function createRuntimeAdapter(
  name: string,
  config: RuntimeConfig,
): Promise<HarnessAdapter | undefined> {
  if (config.enabled === false) return undefined;
  const profile = acpProfiles[name];
  const binary = config.binary ?? profile?.binary ?? name;
  const version = await new Promise<string>((resolve) => {
    let deadline: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (result: string) => {
      done = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const child = execFile(
      binary,
      ['--version'],
      { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env: nativeEnvironment() },
      (error, stdout) => finish(error ? 'unprobed' : stdout.trim()),
    );
    // execFile's own timeout waits for the child to close, which a child ignoring signals never does.
    if (!done)
      deadline = setTimeout(() => {
        child.kill('SIGKILL');
        finish('unprobed');
      }, 5000);
  });
  if (name === 'claude')
    return new ClaudeAdapter(binary, version, undefined, {
      args: config.args,
      artifacts: config.artifacts,
    });
  if (name === 'codex') return new CodexAdapter(binary, version, { args: config.args });
  return version === 'unprobed'
    ? undefined
    : new AcpAdapter({ name, profile: profile!, binary, args: config.args, version });
}
