import { expect, it } from 'vitest';
import { permissionRule } from '@pantheon/domain';

const bash = (command: string) => permissionRule('Bash', { command });

it('keys a simple command on its first two words unless the second is an option', () => {
  expect(bash('git status')).toBe('Bash(git status)');
  expect(bash('git push --force')).toBe('Bash(git push)');
  expect(bash('pnpm test')).toBe('Bash(pnpm test)');
  expect(bash('  pnpm test --filter web')).toBe('Bash(pnpm test)');
  expect(bash('ls -la')).toBe('Bash(ls)');
  expect(bash('ls')).toBe('Bash(ls)');
});

it('keys a command with shell syntax beyond plain words on its whole text', () => {
  for (const command of [
    'CI=1 pnpm test',
    'CI=1 rm -rf src',
    'echo ok >(touch /tmp/x)',
    'ls <(cat ~/.ssh/id_rsa)',
    'rm a > /etc/x',
    'cat < input.txt',
    'echo {a,b}',
    'rm *.log',
    'rm file?.txt',
    'rm [ab].txt',
    'cat ~/notes',
    'echo $HOME',
    'echo $(id)',
    'echo `id`',
    './run.sh fast',
    '/bin/rm -rf src',
    'pnpm test && rm -rf src',
    'pnpm test; git push',
    'pnpm test | sh',
    'pnpm test\nrm -rf src',
  ])
    expect(bash(` ${command} `)).toBe(`Bash(${command})`);
});

it('keys any other tool on its name', () => {
  expect(permissionRule('WebFetch', { url: 'https://example.invalid' })).toBe('WebFetch');
  expect(permissionRule('Bash', { command: '  ' })).toBe('Bash');
});
