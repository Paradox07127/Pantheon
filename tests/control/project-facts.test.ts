import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { id } from '@pantheon/domain';
import type { Milestone, Project, ProjectRead, Session, SessionTurn } from '@pantheon/domain';
import { fixture, registerWorkspace, user } from '../helpers.js';

function read(f: ReturnType<typeof fixture>): ProjectRead {
  return f.call<ProjectRead>('project.read', { project_id: f.project.id });
}
/** A workbench session row of the project with its own worktree, without a running process. */
function workbenchSession(f: ReturnType<typeof fixture>, projectId = f.project.id): Session {
  const workspace = registerWorkspace(f.control, {
    project_id: projectId,
    kind: 'linked_worktree',
    source: f.store.must<Project>('projects', projectId).roots[0]!,
    base_ref: 'HEAD',
  });
  return f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: projectId,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
}
function end(f: ReturnType<typeof fixture>, session: Session, outcome: 'merged' | 'discarded') {
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update<Session>('sessions', { ...current, state: 'closed', outcome }, current.revision);
}
function milestoneInput(f: ReturnType<typeof fixture>, sessions: Session[]) {
  return {
    project_id: f.project.id,
    title: 'Ship export',
    required_sessions: sessions.map((session) => session.id),
    criteria: ['Export works'],
  };
}
function otherProject(f: ReturnType<typeof fixture>): Project {
  const root = path.join(f.root, 'other');
  mkdirSync(root);
  return f.call<Project>('project.open', { name: 'Other', roots: [root] });
}
/** A planner session's credential, as the daemon issues it. */
function planner(f: ReturnType<typeof fixture>) {
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

describe('project facts and commitments', () => {
  it('filters project facts by project and rejects a planner of another project', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const root = path.join(f.root, 'other');
      mkdirSync(root);
      const other = f.call<Project>('project.open', { name: 'Other', roots: [root] });
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
  it('moves a milestone with its required sessions being merged, accepted or discarded', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const first = workbenchSession(f),
        second = workbenchSession(f),
        dropped = workbenchSession(f);
      const milestone = f.call<Milestone>('milestone.create', milestoneInput(f, [first, second]));
      const view = () => read(f).milestones.find((m) => m.milestone.id === milestone.id)!;
      expect(view()).toMatchObject({ status: 'active', required_total: 2, merged_total: 0 });
      const accept = () =>
        f.call<Milestone>(
          'milestone.accept',
          {
            milestone_id: milestone.id,
            evidence_refs: [`session:${first.id}`],
            criteria_checked: [0],
          },
          f.store.must<Milestone>('milestones', milestone.id).revision,
        );
      expect(accept).toThrow('merged');
      end(f, first, 'merged');
      expect(view()).toMatchObject({ status: 'active', merged_total: 1 });
      expect(accept).toThrow(expect.objectContaining({ code: 'acceptance_pending' }));
      end(f, second, 'merged');
      expect(view()).toMatchObject({ status: 'ready_for_acceptance', merged_total: 2 });
      accept();
      expect(view()).toMatchObject({ status: 'completed', merged_total: 2 });

      const other = f.call<Milestone>('milestone.create', milestoneInput(f, [dropped]));
      end(f, dropped, 'discarded');
      expect(read(f).milestones.find((m) => m.milestone.id === other.id)).toMatchObject({
        status: 'stale',
        required_total: 1,
        merged_total: 0,
        reasons: [`session:${dropped.id}:discarded`],
      });
    } finally {
      await f.close();
    }
  });
  it('accepts only unique evidence references to merged required sessions', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const first = workbenchSession(f),
        second = workbenchSession(f),
        unrelated = workbenchSession(f),
        foreign = workbenchSession(f, otherProject(f).id);
      const milestone = f.call<Milestone>('milestone.create', milestoneInput(f, [first, second]));
      for (const session of [first, second, unrelated, foreign]) end(f, session, 'merged');
      const versions = f.store.list('project_fact_versions');
      const valid = `session:${first.id}`;
      for (const evidence of [
        first.id,
        `commit:${first.id}`,
        'session:',
        'session:missing-session',
        `${valid}:extra`,
        ` ${valid}`,
        `${valid} `,
        `session:${unrelated.id}`,
        `session:${foreign.id}`,
        valid,
      ]) {
        expect(
          () =>
            f.call(
              'milestone.accept',
              { milestone_id: milestone.id, evidence_refs: [valid, evidence] },
              milestone.revision,
            ),
          evidence,
        ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
        expect(f.store.must<Milestone>('milestones', milestone.id)).toEqual(milestone);
        expect(f.store.list('project_fact_versions')).toEqual(versions);
      }
      const evidence = [`session:${second.id}`, valid];
      const accepted = f.call<Milestone>(
        'milestone.accept',
        { milestone_id: milestone.id, evidence_refs: evidence, criteria_checked: [0] },
        milestone.revision,
      );
      expect(accepted.acceptance?.evidence_refs).toEqual(evidence);
      expect(read(f).milestones[0]?.status).toBe('completed');
    } finally {
      await f.close();
    }
  });
  it.each(['open', 'discarded'] as const)(
    'rejects evidence for a required session whose outcome is %s',
    async (outcome) => {
      const f = fixture({ managedWorkspaces: true });
      try {
        const session = workbenchSession(f);
        const milestone = f.call<Milestone>('milestone.create', milestoneInput(f, [session]));
        if (outcome === 'discarded') end(f, session, outcome);
        expect(() =>
          f.call(
            'milestone.accept',
            { milestone_id: milestone.id, evidence_refs: [`session:${session.id}`] },
            milestone.revision,
          ),
        ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
        expect(f.store.must<Milestone>('milestones', milestone.id)).toEqual(milestone);
      } finally {
        await f.close();
      }
    },
  );
  it('derives a lead milestone from the sessions of its tasks', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const lead = workbenchSession(f);
      f.store.insert<SessionTurn>('session_turns', {
        id: id(),
        revision: 1,
        project_id: f.project.id,
        session_id: lead.id,
        input: 'Ship the export API and UI',
        kind: 'send',
        delivery: 'delivered',
        state: 'completed',
      });
      const principal = {
        id: `session:${lead.id}`,
        role: 'lead' as const,
        session_id: lead.id,
        project_id: f.project.id,
        expires_at: f.store.now() + 60000,
      };
      const task = (taskId: string) => ({
        id: taskId,
        title: `Task ${taskId}`,
        goal: `Finish ${taskId}`,
        lane: 'core',
        milestone: 'm1',
        depends_on: [],
        source: ['Ship the export API and UI'],
        scope: [`src/${taskId}`],
        acceptance: ['pnpm test'],
      });
      f.call(
        'board.plan.update',
        {
          project_id: f.project.id,
          base_version: 0,
          headline: 'Export',
          lanes: [{ id: 'core', title: 'Core' }],
          tasks: [task('api'), task('ui')],
          milestones: [
            { id: 'm1', title: 'Export ships', criteria: ['Exports work'], tasks: ['api', 'ui'] },
          ],
          risks: [],
          assumptions: [],
        },
        null,
        principal,
      );
      const bound = (taskId: string) => {
        const session = workbenchSession(f);
        return f.store.update<Session>(
          'sessions',
          { ...session, task: { lead_session_id: lead.id, id: taskId } },
          session.revision,
        );
      };
      const view = () => read(f).milestones.find((m) => m.milestone.key === 'm1')!;
      expect(view()).toMatchObject({
        status: 'active',
        tasks: { done: 0, total: 2 },
        required_sessions: [],
      });
      const discarded = bound('api');
      end(f, discarded, 'discarded');
      const api = bound('api'),
        ui = bound('ui');
      end(f, api, 'merged');
      end(f, ui, 'merged');
      expect(view()).toMatchObject({
        status: 'ready_for_acceptance',
        tasks: { done: 2, total: 2 },
        required_sessions: [api.id, ui.id],
        reasons: [],
      });
      expect(view().milestone.required_sessions).toEqual([]);
      for (const evidence_refs of [
        [api.id],
        [`session:${api.id}`, `session:${api.id}`],
        [`session:${api.id}`, `session:${discarded.id}`],
      ]) {
        expect(() =>
          f.call('milestone.accept', { milestone_id: 'm1', evidence_refs }, null, principal),
        ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
        expect(view().status).toBe('ready_for_acceptance');
      }
      f.call(
        'milestone.accept',
        { milestone_id: 'm1', evidence_refs: [`session:${api.id}`], criteria_checked: [0] },
        null,
        principal,
      );
      expect(view().status).toBe('completed');
      const reopened = bound('ui');
      expect(view()).toMatchObject({
        status: 'active',
        tasks: { done: 1, total: 2 },
        reasons: ['task:ui:active', `session:${reopened.id}:open`],
      });
    } finally {
      await f.close();
    }
  });
  it('rejects milestones bound to sessions outside the project', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const foreign = workbenchSession(f, otherProject(f).id);
      const missing = { ...foreign, id: 'missing-session' };
      for (const session of [foreign, missing]) {
        expect(() => f.call('milestone.create', milestoneInput(f, [session])), session.id).toThrow(
          session.id,
        );
      }
      expect(f.store.list('milestones')).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

describe('accepting a milestone criterion by criterion', () => {
  const failure = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error as { code: string; message: string };
    }
    throw new Error('expected a refusal');
  };
  it('refuses until every criterion is checked, then stores the checked indices', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const session = workbenchSession(f);
      const milestone = f.call<Milestone>('milestone.create', {
        ...milestoneInput(f, [session]),
        criteria: ['Export works', 'Docs name the format'],
      });
      end(f, session, 'merged');
      const accept = (criteria_checked?: number[]) =>
        f.call<Milestone>(
          'milestone.accept',
          {
            milestone_id: milestone.id,
            evidence_refs: [`session:${session.id}`],
            ...(criteria_checked ? { criteria_checked } : {}),
          },
          milestone.revision,
        );
      const none = failure(() => accept([]));
      expect(none.code).toBe('invalid_input');
      expect(none.message).toContain('Export works');
      expect(none.message).toContain('Docs name the format');
      const one = failure(() => accept([0]));
      expect(one.code).toBe('invalid_input');
      expect(one.message).toContain('Docs name the format');
      expect(one.message).not.toContain('Export works');
      for (const checked of [
        [0, 1, 1],
        [0, 1, 2],
        [0, 1, -1],
      ])
        expect(failure(() => accept(checked)).code, String(checked)).toBe('invalid_input');
      expect(f.store.must<Milestone>('milestones', milestone.id)).toEqual(milestone);

      const accepted = accept([1, 0]);
      expect(accepted.acceptance).toMatchObject({
        evidence_refs: [`session:${session.id}`],
        criteria_checked: [1, 0],
      });
      expect(read(f).milestones[0]?.status).toBe('completed');
    } finally {
      await f.close();
    }
  });
  it('accepts a milestone without criteria as before', async () => {
    const f = fixture({ managedWorkspaces: true });
    try {
      const session = workbenchSession(f);
      end(f, session, 'merged');
      f.store.insert<Milestone>('milestones', {
        id: 'no-criteria',
        revision: 1,
        project_id: f.project.id,
        title: 'Bare',
        required_sessions: [session.id],
        criteria: [],
        created_at: f.store.now(),
        updated_by: user.id,
      });
      const accepted = f.call<Milestone>(
        'milestone.accept',
        { milestone_id: 'no-criteria', evidence_refs: [`session:${session.id}`] },
        1,
      );
      expect(accepted.acceptance?.evidence_refs).toEqual([`session:${session.id}`]);
      expect(read(f).milestones[0]?.status).toBe('completed');
    } finally {
      await f.close();
    }
  });
});
