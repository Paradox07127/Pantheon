import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';

it('passes every occurrence of a repeated user argument to the Claude CLI', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-claude-args-')));
  try {
    const record = path.join(root, 'argv.jsonl');
    const binary = path.join(root, 'claude.cjs');
    // Records the arguments of each launch and exits before the SDK handshake.
    writeFileSync(
      binary,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    chmodSync(binary, 0o755);
    const adapter = new ClaudeAdapter(binary, 'test', undefined, {
      args: ['--plugin-dir', '/first', '--plugin-dir=/second', '--plugin-dir', '/third'],
    });
    await adapter.models(root).catch(() => undefined);
    const launches = readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const argv = launches.find((args) => args.some((arg) => arg.startsWith('--plugin-dir')));
    expect(
      argv?.flatMap((arg, index) =>
        arg === '--plugin-dir'
          ? [argv[index + 1]]
          : arg.startsWith('--plugin-dir=')
            ? [arg.slice('--plugin-dir='.length)]
            : [],
      ),
    ).toEqual(['/first', '/second', '/third']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  'permission-prompt-tool',
  'permission-prompts',
  'setting-sources',
  'managed-settings',
  'project-config-root',
  'tools',
  'disallowedTools',
  'strict-mcp-config',
  'resume',
  'continue',
  'session-id',
  'fork-session',
  'resume-session-at',
  'resume-drops-turn',
  'no-session-persistence',
  'input-format',
  'output-format',
])('refuses the SDK-owned Claude argument --%s', (flag) => {
  expect(
    () => new ClaudeAdapter('claude', 'test', undefined, { args: [`--${flag}`, 'x'] }),
  ).toThrow(`Claude argument --${flag} is not allowed`);
});
