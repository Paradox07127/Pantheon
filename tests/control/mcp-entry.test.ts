import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';
import { git } from './workbench-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.restoreAllMocks();
});

it('starts the Pantheon MCP server from the CLI entry the control was given', async () => {
  const entry = '/Applications/Pantheon.app/Contents/Resources/cli/index.js';
  const adapter = new FixtureAdapter();
  const starts = vi.spyOn(adapter, 'start');
  const f = await fixture({
    adapter,
    managedWorkspaces: true,
    controlOptions: {
      readProcess: () => undefined,
      issueSessionCredential: (sessionId) => ({
        token_file: path.join('/nonexistent-session-tokens', sessionId),
        daemon_url: 'http://127.0.0.1:4321',
      }),
      mcpEntry: entry,
    },
  });
  cleanup.push(() => f.close());
  writeFileSync(path.join(f.projectRoot, 'README.md'), 'Readme\n');
  git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
  git(f.projectRoot, 'add', '.');
  git(f.projectRoot, 'commit', '--quiet', '-m', 'Initial files');
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: adapter.name,
    input: 'Write a sentence',
    purpose: 'conductor',
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => starts.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(starts.mock.calls[0]![0].pantheon_mcp?.args[0]).toBe(entry);
});
