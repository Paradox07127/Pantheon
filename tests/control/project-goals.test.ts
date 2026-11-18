import { describe, it, expect } from 'vitest';
import { id } from '@pantheon/domain';
import type {
  BoardPlan,
  Milestone,
  Principal,
  Project,
  ProjectGoal,
  ProjectRead,
  Session,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { transferPlan } from '../../packages/control/dist/board-plan.js';
import { fixture, insertSession, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function goals(f: Fixture): ProjectGoal[] {
  return f.call<ProjectRead>('project.read', { project_id: f.project.id }).goals.map((v) => v.goal);
}
function add(f: Fixture, text: string): ProjectGoal {
  return f.call<ProjectGoal>('goal.set', { project_id: f.project.id, text });
}
function failure(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}
/** A lead session's credential, as the daemon issues it. */
function lead(f: Fixture): Principal {
  const session = f.store.insert<Session>('sessions', {
    id: 'lead-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    state: 'open',
    turn_count: 0,
  });
  return {
    id: `session:${session.id}`,
    role: 'lead',
    session_id: session.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60000,
  };
}

describe('project goals', () => {
  it('lists the goals the user adds in creation order with the user text', async () => {
    const f = await fixture();
    try {
      expect(goals(f)).toEqual([]);
      for (const text of ['Ship export', 'Cut startup time', 'Keep data local']) add(f, text);
      expect(goals(f).map((g) => g.text)).toEqual([
        'Ship export',
        'Cut startup time',
        'Keep data local',
      ]);
    } finally {
      await f.close();
    }
  });
  it('refuses an eighth active goal until the user archives one', async () => {
    const f = await fixture();
    try {
      const first = add(f, 'Goal 1');
      for (let n = 2; n <= 7; n += 1) add(f, `Goal ${n}`);
      expect(failure(() => add(f, 'Goal 8')).code).toBe('invalid_state');
      f.call('goal.archive', { goal_id: first.id }, first.revision);
      expect(add(f, 'Goal 8').text).toBe('Goal 8');
      expect(goals(f)).toHaveLength(7);
    } finally {
      await f.close();
    }
  });
  it('rewrites a goal at its revision and refuses a stale revision', async () => {
    const f = await fixture();
    try {
      const goal = add(f, 'Ship export');
      const next = f.call<ProjectGoal>(
        'goal.set',
        { project_id: f.project.id, goal_id: goal.id, text: 'Ship CSV export' },
        goal.revision,
      );
      expect(goals(f).map((g) => g.text)).toEqual(['Ship CSV export']);
      const stale = failure(() =>
        f.call(
          'goal.set',
          { project_id: f.project.id, goal_id: goal.id, text: 'Ship PDF export' },
          goal.revision,
        ),
      );
      expect(stale.code).toBe('revision_conflict');
      expect(next.revision).toBe(goal.revision + 1);
    } finally {
      await f.close();
    }
  });
  it('reorders exactly the active goals and refuses any other set', async () => {
    const f = await fixture();
    try {
      const [a, b, c] = ['A', 'B', 'C'].map((text) => add(f, text));
      const archived = add(f, 'D');
      f.call('goal.archive', { goal_id: archived.id }, archived.revision);
      f.call('goal.reorder', { project_id: f.project.id, goal_ids: [c!.id, a!.id, b!.id] });
      expect(goals(f).map((g) => g.text)).toEqual(['C', 'A', 'B']);
      const leftOut = failure(() =>
        f.call('goal.reorder', { project_id: f.project.id, goal_ids: [a!.id, b!.id] }),
      );
      expect(leftOut.code).toBe('revision_conflict');
      const withArchived = failure(() =>
        f.call('goal.reorder', {
          project_id: f.project.id,
          goal_ids: [a!.id, b!.id, c!.id, archived.id],
        }),
      );
      expect(withArchived.code).toBe('revision_conflict');
      expect(goals(f).map((g) => g.text)).toEqual(['C', 'A', 'B']);
    } finally {
      await f.close();
    }
  });
  it('refuses goal changes from a lead and from a personal agent', async () => {
    const f = await fixture();
    try {
      const byLead = failure(() =>
        f.call('goal.set', { project_id: f.project.id, text: 'Lead goal' }, null, lead(f)),
      );
      expect(byLead.code).toBe('permission_denied');
      const personal: Principal = { id: 'personal:k1', role: 'personal' };
      const byPersonal = failure(() =>
        f.call('goal.set', { project_id: f.project.id, text: 'Personal goal' }, null, personal),
      );
      expect(byPersonal).toMatchObject({
        code: 'permission_denied',
        message: "Outside the personal agent's scope",
      });
      expect(goals(f)).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('leaves an archived goal out of project.read and refuses archiving it again', async () => {
    const f = await fixture();
    try {
      const kept = add(f, 'Ship export');
      const archived = add(f, 'Old goal');
      const next = f.call<ProjectGoal>('goal.archive', { goal_id: archived.id }, archived.revision);
      expect(goals(f).map((g) => g.id)).toEqual([kept.id]);
      expect(
        failure(() => f.call('goal.archive', { goal_id: archived.id }, next.revision)).code,
      ).toBe('invalid_state');
    } finally {
      await f.close();
    }
  });
});

/** A lead the user asked for the export, with no plan yet. */
function exportLead(f: Fixture): Principal {
  const session = insertSession(f);
  f.store.insert('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: 'Ship the export API this week.',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${session.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60_000_000,
  };
}
const planOf = (f: Fixture, p: Principal) => f.store.must<BoardPlan>('board_plans', p.session_id!);
/** Sends the whole plan with milestone m1 over task api; `link` is merged into m1. */
function sendPlan(f: Fixture, p: Principal, link: { goal?: string | null } = {}) {
  return f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', p.session_id!)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'api',
          title: 'API',
          goal: 'Serve exports',
          lane: 'core',
          depends_on: [],
          source: ['Ship the export API'],
          scope: [],
          acceptance: [],
          done_when: 'report',
          milestone: 'm1',
        },
      ],
      milestones: [
        { id: 'm1', title: 'Release', criteria: ['Exports download'], tasks: ['api'], ...link },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    p,
  );
}
function editMilestone(f: Fixture, p: Principal, patch: Record<string, unknown>) {
  return f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      base_version: planOf(f, p).plan_version,
      ops: [{ type: 'set_milestone', milestone_id: 'm1', patch }],
    },
    null,
    p,
  );
}
const linkedGoal = (f: Fixture) =>
  f
    .call<ProjectRead>('project.read', { project_id: f.project.id })
    .milestones.find((view) => view.milestone.key === 'm1')?.milestone.goal_id;

describe('milestone goal links', () => {
  it('keeps a lead link through a resend without goal and drops it on goal null', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const goal = add(f, 'Ship export');
      const p = exportLead(f);
      sendPlan(f, p, { goal: goal.id });
      expect(linkedGoal(f)).toBe(goal.id);
      const version = planOf(f, p).plan_version;
      sendPlan(f, p);
      expect(linkedGoal(f)).toBe(goal.id);
      expect(planOf(f, p).plan_version).toBe(version);
      sendPlan(f, p, { goal: null });
      expect(linkedGoal(f)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it('refuses a goal id that names no goal of the project', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const other = f.store.insert<Project>('projects', { ...f.project, id: 'another-project' });
      const foreign = f.call<ProjectGoal>('goal.set', { project_id: other.id, text: 'Elsewhere' });
      const p = exportLead(f);
      for (const goal of ['no-such-goal', foreign.id])
        expect(failure(() => sendPlan(f, p, { goal }))).toMatchObject({
          code: 'invalid_input',
          message: `milestones: milestone m1 names unknown goal ${goal}; use an id from project_read.goals`,
        });
      expect(f.store.get('board_plans', p.session_id!)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it('keeps a link to a goal archived since but refuses a new link to it', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const goal = add(f, 'Ship export');
      const p = exportLead(f);
      sendPlan(f, p, { goal: goal.id });
      f.call('goal.archive', { goal_id: goal.id }, goal.revision);
      sendPlan(f, p, { goal: goal.id });
      expect(linkedGoal(f)).toBe(goal.id);
      sendPlan(f, p, { goal: null });
      expect(failure(() => sendPlan(f, p, { goal: goal.id }))).toMatchObject({
        code: 'invalid_input',
        message: expect.stringContaining(`milestone m1 names archived goal ${goal.id}`),
      });
      expect(linkedGoal(f)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it('links with an edit and keeps the link through a title edit', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const goal = add(f, 'Ship export');
      const p = exportLead(f);
      sendPlan(f, p);
      editMilestone(f, p, { goal: goal.id });
      expect(linkedGoal(f)).toBe(goal.id);
      editMilestone(f, p, { title: 'Release export' });
      expect(linkedGoal(f)).toBe(goal.id);
      f.call(
        'board.plan.edit',
        {
          project_id: f.project.id,
          lead_session_id: p.session_id,
          base_version: planOf(f, p).plan_version,
          ops: [{ type: 'set_milestone', milestone_id: 'm1', patch: { due_on: '2026-12-01' } }],
        },
        null,
        user,
      );
      expect(linkedGoal(f)).toBe(goal.id);
      editMilestone(f, p, { goal: null });
      expect(linkedGoal(f)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it('keeps an accepted milestone completed when the lead links it', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const goal = add(f, 'Ship export');
      const p = exportLead(f);
      sendPlan(f, p);
      const plan = planOf(f, p);
      f.store.update<BoardPlan>(
        'board_plans',
        {
          ...plan,
          accepted: {
            api: { at: f.store.now(), evidence: 'The report answers it', generation: 1 },
          },
        },
        plan.revision,
      );
      const row = f.store.list<Milestone>('milestones').find((m) => m.key === 'm1')!;
      f.call(
        'milestone.accept',
        { milestone_id: row.id, evidence_refs: ['task:api'] },
        row.revision,
      );
      sendPlan(f, p, { goal: goal.id });
      const view = f
        .call<ProjectRead>('project.read', { project_id: f.project.id })
        .milestones.find((entry) => entry.milestone.key === 'm1')!;
      expect(view.milestone.goal_id).toBe(goal.id);
      expect(view.status).toBe('completed');
    } finally {
      await f.close();
    }
  });
  it('counts the milestones and tasks linked to each active goal', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const goal = add(f, 'Ship export');
      const archived = add(f, 'Old goal');
      const p = exportLead(f);
      const task = (id: string, milestone: string) => ({
        id,
        title: id,
        goal: 'Serve exports',
        lane: 'core',
        depends_on: [],
        source: ['Ship the export API'],
        scope: [],
        acceptance: [],
        done_when: 'report',
        milestone,
      });
      const send = (withSecond: boolean) =>
        f.call(
          'board.plan.update',
          {
            project_id: f.project.id,
            base_version: f.store.get<BoardPlan>('board_plans', p.session_id!)?.plan_version ?? 0,
            headline: 'Export ships this week',
            lanes: [{ id: 'core', title: 'Core' }],
            tasks: [
              task('api', 'm1'),
              ...(withSecond ? [task('csv', 'm2'), task('pdf', 'm2'), task('zip', 'm2')] : []),
              task('old', 'm3'),
            ],
            milestones: [
              { id: 'm1', title: 'Release', criteria: ['Exports download'], tasks: ['api'] },
              ...(withSecond
                ? [
                    {
                      id: 'm2',
                      title: 'Formats',
                      criteria: ['All formats'],
                      tasks: ['csv', 'pdf', 'zip'],
                    },
                  ]
                : []),
              {
                id: 'm3',
                title: 'Legacy',
                criteria: ['Old path'],
                tasks: ['old'],
                goal: archived.id,
              },
            ],
            risks: [],
            assumptions: [],
          },
          null,
          p,
        );
      send(true);
      editMilestone(f, p, { goal: goal.id });
      f.call(
        'board.plan.edit',
        {
          project_id: f.project.id,
          base_version: planOf(f, p).plan_version,
          ops: [{ type: 'set_milestone', milestone_id: 'm2', patch: { goal: goal.id } }],
        },
        null,
        p,
      );
      const plan = planOf(f, p);
      const accepted = { at: f.store.now(), evidence: 'The report answers it', generation: 1 };
      f.store.update<BoardPlan>(
        'board_plans',
        { ...plan, accepted: { api: accepted, csv: accepted } },
        plan.revision,
      );
      const rows = f.store.list<Milestone>('milestones');
      const row = (key: string) => rows.find((m) => m.key === key)!;
      f.call(
        'milestone.accept',
        { milestone_id: row('m1').id, evidence_refs: ['task:api'] },
        row('m1').revision,
      );
      f.call('goal.archive', { goal_id: archived.id }, archived.revision);
      const views = () => f.call<ProjectRead>('project.read', { project_id: f.project.id }).goals;
      expect(views()).toEqual([
        {
          goal: expect.objectContaining({ id: goal.id }),
          milestone_ids: [row('m1').id, row('m2').id],
          milestones: { done: 1, ready: 0, total: 2 },
          tasks: { done: 2, total: 4 },
        },
      ]);
      send(false);
      expect(views()[0]).toMatchObject({
        milestone_ids: [row('m1').id],
        milestones: { done: 1, ready: 0, total: 1 },
        tasks: { done: 1, total: 1 },
      });
    } finally {
      await f.close();
    }
  });
  it('keeps the link when another lead takes over the plan', async () => {
    const f = await fixture({ managedWorkspaces: true });
    try {
      const goal = add(f, 'Ship export');
      const p = exportLead(f);
      sendPlan(f, p, { goal: goal.id });
      const next = exportLead(f);
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      ctx.store.transaction(() => transferPlan(ctx, planOf(f, p), next.session_id!, ''));
      sendPlan(f, next);
      const row = f.store.list<Milestone>('milestones').find((m) => m.key === 'm1')!;
      expect(row).toMatchObject({ owner_session_id: next.session_id, goal_id: goal.id });
    } finally {
      await f.close();
    }
  });
});
