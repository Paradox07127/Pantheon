import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';
import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function repo(commitAt?: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'routine-precheck-'));
  folders.push(folder);
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: folder,
      env: { ...process.env, GIT_AUTHOR_DATE: commitAt, GIT_COMMITTER_DATE: commitAt },
    });
  git('init', '-q');
  if (commitAt) git('commit', '-q', '--allow-empty', '-m', 'change');
  return folder;
}

function precheck(id: string, cwd: string, lastRunAt?: string): number | null {
  const argv = ROUTINE_TEMPLATES.find((each) => each.id === id)?.precheck?.argv ?? [];
  const env = { ...process.env };
  delete env.ROUTINE_LAST_RUN_AT;
  if (lastRunAt) env.ROUTINE_LAST_RUN_AT = lastRunAt;
  return spawnSync(argv[0]!, argv.slice(1), { cwd, env }).status;
}

describe('routine template catalog', () => {
  it.each(ROUTINE_TEMPLATES.map((template) => [template.id, template] as const))(
    '%s parses as a routine of agent.update',
    (_, { id: _id, title: _title, ...routine }) => {
      const parsed = inputSchemas['agent.update'].safeParse({
        agent_id: 'agent-1',
        revision: 1,
        routines: [{ ...routine, enabled: true }],
      });
      expect(parsed.error).toBeUndefined();
      expect('every_minutes' in routine !== 'at' in routine).toBe(true);
    },
  );

  it('gives every template its own id', () => {
    const ids = ROUTINE_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every precheck a command', () => {
    for (const template of ROUTINE_TEMPLATES)
      if (template.precheck) expect(template.precheck.argv[0]).toBeTruthy();
  });

  it('offers a weekly self-review that starts turned off and proposes at most two changes with their sample size', () => {
    const template = ROUTINE_TEMPLATES.find((each) => each.id === 'weekly-self-review')!;
    expect(template).toMatchObject({
      title: 'Weekly self-review',
      every_minutes: 7 * 24 * 60,
      enabled: false,
    });
    for (const part of [
      'project_read',
      'lead.retrospectives',
      'at most 3',
      'at most 2',
      'propose_improvement',
      'sample size n',
    ])
      expect(template.prompt).toContain(part);
  });

  it('runs the bug hunt on its first run, even in a repository without commits', () => {
    expect(precheck('bug-hunt', repo())).toBe(0);
    expect(precheck('bug-hunt', repo('2026-01-01T00:00:00Z'))).toBe(0);
  });

  it('runs the bug hunt only when a commit landed since its last run', () => {
    const folder = repo('2026-01-01T00:00:00Z');
    expect(precheck('bug-hunt', folder, '2025-12-31T00:00:00.000Z')).toBe(0);
    expect(precheck('bug-hunt', folder, '2026-01-02T00:00:00.000Z')).not.toBe(0);
  });
});
