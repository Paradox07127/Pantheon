import { it, expect } from 'vitest';
import { splitPath } from '@/data/format';

const worktree = '/private/tmp/claude-501/-Users-me-project/worktrees/agent-checkout';

it('splits a path before its last two segments', () => {
  expect(splitPath(worktree)).toEqual([
    '/private/tmp/claude-501/-Users-me-project',
    '/worktrees/agent-checkout',
  ]);
  expect(splitPath('apps/web/src/index.css')).toEqual(['apps/web', '/src/index.css']);
});

it('keeps a trailing slash with the last segment', () => {
  expect(splitPath('/private/tmp/claude/agent/')).toEqual(['/private/tmp', '/claude/agent/']);
});

it('leaves a path of two segments or fewer whole', () => {
  expect(splitPath('/repo/src')).toEqual(['', '/repo/src']);
  expect(splitPath('/repo')).toEqual(['', '/repo']);
  expect(splitPath('repo/src')).toEqual(['', 'repo/src']);
  expect(splitPath('abcdefghijklmnop')).toEqual(['', 'abcdefghijklmnop']);
});
