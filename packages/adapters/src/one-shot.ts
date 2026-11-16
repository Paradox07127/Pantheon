import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { nativeEnvironment } from './process.js';

const subscriptions = new Map<string, Promise<boolean>>();

/**
 * Whether the local Claude is logged in with a claude.ai subscription. A yes is kept per binary;
 * a no or a failed probe is asked again next time, since the user can log in while Pantheon runs.
 */
export function claudeSubscription(binary = 'claude'): Promise<boolean> {
  const known = subscriptions.get(binary);
  if (known) return known;
  const subscription = new Promise<boolean>((resolve) => {
    const probe = spawn(binary, ['auth', 'status', '--json'], {
      env: nativeEnvironment(),
      // Its own process group holds what it starts, so a hung probe is stopped whole.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (chunk: string) => (stdout += chunk));
    probe.once('error', () => {
      clearTimeout(deadline);
      resolve(false);
    });
    // Close waits for the pipe, which a descendant of the probe can hold open.
    probe.once('close', (code) => {
      clearTimeout(deadline);
      try {
        const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
        resolve(
          code === 0 &&
            status.loggedIn === true &&
            (status.authMethod === 'claude.ai' || status.authMethod === 'oauth'),
        );
      } catch {
        resolve(false);
      }
    });
    const deadline = setTimeout(() => {
      try {
        if (process.platform === 'win32') probe.kill('SIGKILL');
        else if (probe.pid !== undefined) process.kill(-probe.pid, 'SIGKILL');
      } catch {
        // The group is already empty.
      }
      probe.stdout.destroy();
      resolve(false);
    }, 10000);
  });
  subscriptions.set(binary, subscription);
  void subscription.then(
    (loggedIn) => {
      if (!loggedIn) subscriptions.delete(binary);
    },
    () => subscriptions.delete(binary),
  );
  return subscription;
}

/**
 * One prompt to a Claude model through the subscription login, with no tools, settings or saved
 * history, so no session list or trace sees it; resolves to the reply text and its tokens.
 */
export async function claudeOneShot(
  prompt: string,
  model: string,
  signal: AbortSignal,
  binary = 'claude',
): Promise<{ text: string; usage?: { input_tokens: number; output_tokens: number } }> {
  const subscribed = await new Promise<boolean>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    claudeSubscription(binary)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!subscribed) throw new Error('Claude is not logged in with a claude.ai subscription');
  signal.throwIfAborted();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pantheon-one-shot-'));
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    // An abort while the folder was made fired before the listener was added.
    signal.throwIfAborted();
    let reply: { text: string; usage?: { input_tokens: number; output_tokens: number } } = {
      text: '',
    };
    for await (const message of query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        cwd,
        env: nativeEnvironment(),
        abortController,
        pathToClaudeCodeExecutable: binary,
      },
    })) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') throw new Error(`Claude ended with ${message.subtype}`);
      reply = {
        text: message.result,
        usage: {
          // Cache reads and writes count as input, as in session turns.
          input_tokens:
            message.usage.input_tokens +
            message.usage.cache_read_input_tokens +
            message.usage.cache_creation_input_tokens,
          output_tokens: message.usage.output_tokens,
        },
      };
    }
    return reply;
  } finally {
    signal.removeEventListener('abort', abort);
    await rm(cwd, { recursive: true, force: true });
  }
}
