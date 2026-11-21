import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Project, ProjectRead, Session } from '@pantheon/domain';
import { fixture } from '../helpers.js';

function read(f: Awaited<ReturnType<typeof fixture>>): ProjectRead {
  return f.call<ProjectRead>('project.read', { project_id: f.project.id });
}
/** A planner session's credential, as the daemon issues it. */
function planner(f: Awaited<ReturnType<typeof fixture>>) {
  const session = f.store.insert<Session>('sessions', {
    id: 'planner-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    state: 'open',
    turn_count: 0,
  });
  return {
    id: `session:${session.id}`,
    role: 'planner' as const,
    session_id: session.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  };
}

describe('project facts', () => {
  it('filters project facts by project and rejects a planner of another project', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const root = path.join(f.root, 'other');
      mkdirSync(root);
      const other = await f.call<Project>('project.open', { name: 'Other', roots: [root] });
      f.call('project.brief.set', {
        project_id: other.id,
        goal: 'Other only',
        goals: [],
        non_goals: [],
      });
      expect(read(f).brief).toBeUndefined();
      expect(() => f.call('project.read', { project_id: other.id }, null, planner(f))).toThrow(
        'Project principal required',
      );
    } finally {
      await f.close();
    }
  });
});
