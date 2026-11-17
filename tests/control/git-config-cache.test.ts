import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runGit } from '@pantheon/control';

const roots: string[] = [];
// Moved past the interval within which the cache does not check the repository config again.
let elapsed = 0;
const clock = performance.now.bind(performance);
vi.spyOn(performance, 'now').mockImplementation(() => clock() + elapsed);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plainGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Cache Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Cache Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// A repository whose attributes select the fixture filter, which no config defines yet.
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-config-cache-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const tools = path.join(root, 'tools');
  mkdirSync(repo);
  mkdirSync(tools);
  plainGit(repo, ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(path.join(repo, '.gitattributes'), 'filtered.txt filter=fixture\n');
  writeFileSync(path.join(repo, 'filtered.txt'), 'base\n');
  plainGit(repo, ['add', '.']);
  plainGit(repo, ['commit', '--quiet', '-m', 'Initial files']);
  const marker = path.join(tools, 'clean-ran');
  const script = path.join(tools, 'clean.sh');
  writeFileSync(script, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`);
  chmodSync(script, 0o700);
  const drivers = path.join(tools, 'drivers.cfg');
  writeFileSync(drivers, `[filter "fixture"]\n\tclean = ${script}\n`);
  return { root, repo, marker, script, drivers };
}

// Repeated calls give a cache every chance to fill before the configuration changes.
function warm(cwd: string) {
  for (let index = 0; index < 3; index++)
    expect(runGit(cwd, ['status', '--porcelain']).exit_code).toBe(0);
}

function expectNeutralized(cwd: string, marker: string, env?: NodeJS.ProcessEnv) {
  elapsed += 1000;
  writeFileSync(path.join(cwd, 'filtered.txt'), 'hardened\n');
  const result = runGit(cwd, ['add', '--', 'filtered.txt'], undefined, false, { env });
  expect(result.exit_code).toBe(0);
  expect(existsSync(marker)).toBe(false);
  // Plain git reaches the same driver, so the change did make it live.
  writeFileSync(path.join(cwd, 'filtered.txt'), 'plain\n');
  plainGit(cwd, ['add', '--', 'filtered.txt'], env);
  expect(existsSync(marker)).toBe(true);
}

it('neutralizes a filter that runGit itself wrote to the repository config', () => {
  const { repo, marker, script } = setup();
  warm(repo);
  expect(runGit(repo, ['config', 'filter.fixture.clean', script]).exit_code).toBe(0);
  expectNeutralized(repo, marker);
});

it('neutralizes a filter appended to the repository config file directly', () => {
  const { repo, marker, script } = setup();
  warm(repo);
  appendFileSync(path.join(repo, '.git', 'config'), `[filter "fixture"]\n\tclean = ${script}\n`);
  expectNeutralized(repo, marker);
});

it('neutralizes a filter written into the config file in place with its size and times kept', () => {
  const { repo, marker, script } = setup();
  const config = path.join(repo, '.git', 'config');
  appendFileSync(config, `[filter "fixture"]\n\tclxan = ${script}\n`);
  utimesSync(config, 1_000_000_000, 1_000_000_000);
  warm(repo);
  writeFileSync(config, readFileSync(config, 'utf8').replace('clxan', 'clean'));
  utimesSync(config, 1_000_000_000, 1_000_000_000);
  expectNeutralized(repo, marker);
});

it('neutralizes a filter added to the config.worktree of the worktree in use', () => {
  const { root, repo, marker, script } = setup();
  plainGit(repo, ['config', 'extensions.worktreeConfig', 'true']);
  const linked = path.join(root, 'linked');
  plainGit(repo, ['worktree', 'add', '--quiet', '-b', 'linked', linked]);
  warm(linked);
  plainGit(linked, ['config', '--worktree', 'filter.fixture.clean', script]);
  expectNeutralized(linked, marker);
});

it.each([
  { state: 'missing', description: 'did not exist at the first call' },
  { state: 'existing', description: 'existed at the first call' },
  { state: 'nested', description: 'another included file names and did not exist at first' },
])('neutralizes a filter that appears in an included file that $description', ({ state }) => {
  const { repo, marker, script } = setup();
  plainGit(repo, ['config', 'include.path', 'included.cfg']);
  let included = path.join(repo, '.git', 'included.cfg');
  if (state === 'existing') writeFileSync(included, '[core]\n\tquotepath = false\n');
  if (state === 'nested') {
    writeFileSync(included, '[include]\n\tpath = nested.cfg\n');
    included = path.join(repo, '.git', 'nested.cfg');
  }
  warm(repo);
  writeFileSync(included, `[filter "fixture"]\n\tclean = ${script}\n`);
  expectNeutralized(repo, marker);
});

it('neutralizes a filter included for a branch after switching to that branch', () => {
  const { repo, marker, drivers } = setup();
  plainGit(repo, ['config', 'includeIf.onbranch:feature.path', drivers]);
  warm(repo);
  expect(runGit(repo, ['checkout', '--quiet', '-b', 'feature']).exit_code).toBe(0);
  expectNeutralized(repo, marker);
});

it('neutralizes a filter included only for another worktree of the same repository', () => {
  const { root, repo, marker, drivers } = setup();
  const linked = path.join(root, 'linked');
  plainGit(repo, ['worktree', 'add', '--quiet', '-b', 'linked', linked]);
  plainGit(repo, ['config', 'includeIf.gitdir:**/worktrees/linked.path', drivers]);
  warm(repo);
  expectNeutralized(linked, marker);
});

it('neutralizes a filter from another repository selected through GIT_DIR', () => {
  const first = setup();
  const other = setup();
  plainGit(other.repo, ['config', 'filter.fixture.clean', other.script]);
  warm(first.repo);
  expectNeutralized(first.repo, other.marker, { GIT_DIR: path.join(other.repo, '.git') });
});

it('neutralizes a filter from a global config selected through GIT_CONFIG_GLOBAL', () => {
  const { repo, marker, drivers } = setup();
  warm(repo);
  expectNeutralized(repo, marker, { GIT_CONFIG_GLOBAL: drivers });
});

it('neutralizes a filter of a nested repository that becomes discoverable when its objects directory opens', () => {
  const { repo, marker, script } = setup();
  const inner = path.join(repo, 'inner');
  plainGit(repo, ['init', '--bare', '--quiet', inner]);
  plainGit(inner, ['config', 'core.bare', 'false']);
  plainGit(inner, ['config', 'core.worktree', '..']);
  plainGit(inner, ['config', 'filter.fixture.clean', script]);
  // Git skips a candidate directory whose objects directory it cannot enter.
  chmodSync(path.join(inner, 'objects'), 0o000);
  warm(inner);
  chmodSync(path.join(inner, 'objects'), 0o700);
  expectNeutralized(inner, marker);
});
