import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

it('accepts project permissions, branch queries, worktree settings and stale cleanup', () => {
  expect(
    inputSchemas['approval.respond'].parse({
      approval_id: 'approval',
      decision: 'approve_project',
    }).decision,
  ).toBe('approve_project');
  expect(
    inputSchemas['permission.rule.remove'].parse({
      project_id: 'project',
      rule: 'Bash(pnpm test)',
    }),
  ).toEqual({ project_id: 'project', rule: 'Bash(pnpm test)' });
  expect(inputSchemas['workspace.prune_stale'].parse({ project_id: 'project' })).toEqual({
    project_id: 'project',
  });
  for (const name of ['permission.rules', 'workspace.stale'] as const)
    expect(querySchemas[name].parse({ project_id: 'project' })).toEqual({ project_id: 'project' });
  expect(
    querySchemas['project.branches'].parse({ project_id: 'project', root: '/project' }),
  ).toEqual({ project_id: 'project', root: '/project' });
  expect(
    inputSchemas['project.worktree.set'].parse({
      project_id: 'project',
      copy_paths: ['.env', 'local/config'],
      command: { argv: ['pnpm', 'install'], timeout_ms: 30000 },
    }),
  ).toMatchObject({ copy_paths: ['.env', 'local/config'] });
});

it.each(['../outside', '/absolute', 'a/../../outside'])(
  'refuses an escaping worktree copy path %s',
  (entry) => {
    expect(
      inputSchemas['project.worktree.set'].safeParse({
        project_id: 'project',
        copy_paths: [entry],
      }).success,
    ).toBe(false);
  },
);

it('accepts a strict input for adding a project permission rule', () => {
  const input = { project_id: 'project', rule: 'Bash(pnpm test)', session_id: 'source-session' };
  expect(inputSchemas['permission.rule.add'].parse(input)).toEqual(input);
  expect(inputSchemas['permission.rule.add'].safeParse({ ...input, extra: true }).success).toBe(
    false,
  );
});
