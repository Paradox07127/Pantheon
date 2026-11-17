import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runGit } from '@pantheon/control';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plainGit(cwd: string, args: string[], input?: Buffer) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    input,
    env: {
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Driver Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Driver Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function repository(attributes: string, driver = 'fixture.driver') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-drivers-'));
  roots.push(root);
  plainGit(root, ['init', '--quiet']);
  for (const name of ['filtered.txt', 'external.txt', 'converted.txt'])
    writeFileSync(path.join(root, name), 'base\n');
  writeFileSync(
    path.join(root, attributes),
    `filtered.txt filter=${driver}\nexternal.txt diff=external\nconverted.txt diff=converted\n`,
  );
  plainGit(root, ['add', '.']);
  plainGit(root, ['commit', '--quiet', '-m', 'Initial files']);
  const markers = Object.fromEntries(
    ['smudge', 'clean', 'command', 'textconv'].map((name) => [
      name,
      path.join(root, `${name}-ran`),
    ]),
  );
  for (const [kind, key, body] of [
    ['smudge', `filter.${driver}.smudge`, 'cat'],
    ['clean', `filter.${driver}.clean`, 'cat'],
    ['command', 'diff.external.command', 'exit 0'],
    ['textconv', 'diff.converted.textconv', 'cat "$1"'],
  ]) {
    const script = path.join(root, `${kind}.sh`);
    writeFileSync(script, `#!/bin/sh\nprintf executed > '${markers[kind!]}'\n${body}\n`);
    chmodSync(script, 0o700);
    plainGit(root, ['config', key!, script]);
  }
  plainGit(root, ['config', `filter.${driver}.required`, 'true']);
  return { root, markers };
}

const patch = Buffer.from(
  'diff --git a/filtered.txt b/filtered.txt\n--- a/filtered.txt\n+++ b/filtered.txt\n@@ -1 +1 @@\n-base\n+changed\n',
);

it.each(
  ['.gitattributes', '.git/info/attributes'].flatMap((attributes) =>
    ['checkout', 'add', 'apply', 'diff', 'literal diff', 'blame'].map((operation) => ({
      attributes,
      operation,
    })),
  ),
)(
  'ignores repository drivers during $operation with $attributes',
  async ({ attributes, operation }) => {
    for (const hardened of [false, true]) {
      const { root, markers } = repository(attributes);
      let args: string[];
      let input: Buffer | undefined;
      if (operation === 'checkout') {
        unlinkSync(path.join(root, 'filtered.txt'));
        args = ['checkout', '--', 'filtered.txt'];
      } else if (operation === 'apply') {
        args = ['apply', '--index'];
        input = patch;
      } else {
        for (const name of ['filtered.txt', 'external.txt', 'converted.txt'])
          writeFileSync(path.join(root, name), 'changed\n');
        args =
          operation === 'add'
            ? ['add', '--', '*.txt']
            : operation === 'blame'
              ? ['blame', 'HEAD', '--', 'converted.txt']
              : operation === 'literal diff'
                ? ['--literal-pathspecs', 'diff']
                : ['diff'];
      }
      if (hardened) {
        const result = await runGit(root, args, input, true);
        expect(result.stderr.toString()).toBe('');
        expect(result.exit_code).toBe(0);
        expect(Object.values(markers).filter(existsSync)).toEqual([]);
        if (operation.endsWith('diff')) expect(result.stdout.toString()).toContain('+changed');
      } else {
        plainGit(root, args, input);
        const expected =
          operation === 'checkout'
            ? ['smudge']
            : operation.endsWith('diff')
              ? ['clean', 'command', 'textconv']
              : operation === 'blame'
                ? ['textconv']
                : operation === 'apply'
                  ? // Reading may reuse the index stat cache; writing always invokes smudge.
                    ['smudge']
                  : ['clean'];
        for (const name of expected) expect(existsSync(markers[name]!)).toBe(true);
      }
    }
  },
);

it('does not run a repository merge driver during a rebase and stops on a conflict instead', async () => {
  for (const hardened of [false, true]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-drivers-'));
    roots.push(root);
    plainGit(root, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(path.join(root, '.gitattributes'), 'merged.txt merge=fixture\n');
    writeFileSync(path.join(root, 'merged.txt'), 'first\nsecond\nthird\n');
    plainGit(root, ['add', '.']);
    plainGit(root, ['commit', '--quiet', '-m', 'Initial files']);
    plainGit(root, ['checkout', '--quiet', '-b', 'session']);
    writeFileSync(path.join(root, 'merged.txt'), 'first\nsecond\nsession\n');
    plainGit(root, ['commit', '--quiet', '-am', 'Session change']);
    plainGit(root, ['checkout', '--quiet', 'main']);
    writeFileSync(path.join(root, 'merged.txt'), 'source\nsecond\nthird\n');
    plainGit(root, ['commit', '--quiet', '-am', 'Source change']);
    plainGit(root, ['checkout', '--quiet', 'session']);
    const marker = path.join(root, 'merge-driver-ran');
    const script = path.join(root, 'merge-driver.sh');
    writeFileSync(script, `#!/bin/sh\nprintf executed > '${marker}'\n`);
    chmodSync(script, 0o700);
    plainGit(root, ['config', 'merge.fixture.driver', `${script} %O %A %B`]);
    if (hardened) {
      const result = await runGit(root, ['rebase', '--quiet', 'main'], undefined, true);
      expect(existsSync(marker)).toBe(false);
      expect(result.exit_code).not.toBe(0);
      expect(
        (
          await runGit(root, ['diff', '--name-only', '--diff-filter=U'], undefined, true)
        ).stdout.toString(),
      ).toBe('merged.txt\n');
    } else {
      plainGit(root, ['rebase', '--quiet', 'main']);
      expect(existsSync(marker)).toBe(true);
    }
  }
});

it('ignores a filter driver whose name contains an equals sign', async () => {
  for (const hardened of [false, true]) {
    const { root, markers } = repository('.gitattributes', 'fixture=driver');
    writeFileSync(path.join(root, 'filtered.txt'), 'changed\n');
    if (hardened) {
      const result = await runGit(root, ['add', '--', 'filtered.txt'], undefined, true);
      expect(result.exit_code).toBe(0);
      expect(existsSync(markers.clean!)).toBe(false);
    } else {
      plainGit(root, ['add', '--', 'filtered.txt']);
      expect(existsSync(markers.clean!)).toBe(true);
    }
  }
});
