import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { awaitWorkspaceReady } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const realPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = realPath;
});

it('adds the linked worktrees of one source one at a time', async () => {
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim();
  const bin = mkdtempSync(path.join(os.tmpdir(), 'git-wrap-'));
  const log = path.join(bin, 'adds.log');
  // Holds each `worktree add` open for 200 ms so two concurrent ones would overlap.
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
case " $* " in *" worktree add "*)
  echo "start $(perl -MTime::HiRes=time -e 'printf "%.3f", time')" >> "${log}"
  sleep 0.2
  "${realGit}" "$@"; code=$?
  echo "end $(perl -MTime::HiRes=time -e 'printf "%.3f", time')" >> "${log}"
  exit $code;;
esac
exec "${realGit}" "$@"
`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${realPath}`;

  const f = workbenchFixture();
  const sessions = [f.create('One'), f.create('Two'), f.create('Three')];
  for (const session of sessions) await awaitWorkspaceReady(f.control, session.workspace_id!);

  const lines = readFileSync(log, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(6);
  let open = 0;
  for (const line of lines) {
    open += line.startsWith('start') ? 1 : -1;
    expect(open).toBeLessThanOrEqual(1);
  }
});
