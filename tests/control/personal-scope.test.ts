import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Approval, Principal, Project, Session } from '@pantheon/domain';
import { command, inputSchemas, type CommandType } from '@pantheon/protocol';
import { OUTSIDE_PERSONAL_SCOPE, PERSONAL_COMMANDS, PERSONAL_QUERIES } from '@pantheon/control';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const personal: Principal = { id: 'personal:k1', role: 'personal' };
const outside = expect.objectContaining({
  code: 'permission_denied',
  message: OUTSIDE_PERSONAL_SCOPE,
});

describe('a personal principal at the command entry and the project check', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it.each(
    Object.keys(inputSchemas).filter(
      (type) => !(PERSONAL_COMMANDS as readonly string[]).includes(type),
    ) as CommandType[],
  )('refuses %s from a personal principal before reading its input', (type) => {
    expect(() => f.control.execute(personal, command(personal.id, type, {}))).toThrow(outside);
  });

  it.each(PERSONAL_COMMANDS)(
    'lets %s from a personal principal past the command entry to its input check',
    (type) => {
      expect(() => f.control.execute(personal, command(personal.id, type, {}))).toThrow(
        expect.objectContaining({ name: 'ZodError' }),
      );
    },
  );

  it('moves only its own seen cursor with project.seen', () => {
    f.call('project.seen', { project_id: f.project.id, at: 1000 });
    expect(f.call('project.seen', { project_id: f.project.id, at: 2000 }, null, personal)).toEqual({
      project_id: f.project.id,
      at: 2000,
    });
    expect(f.control.projectBrief(user, f.project.id).since).toBe(1000);
    expect(f.control.projectBrief(personal, f.project.id).since).toBe(2000);
  });

  it.each([
    ['sessionList', () => f.control.sessionList(personal, f.project.id)],
    ['boardView', () => f.control.boardView(personal, f.project.id, 14)],
    ['snapshot', () => f.control.snapshot(personal, f.project.id)],
    ['snapshotAccess', () => f.control.snapshotAccess(personal, f.project.id)],
    ['projectRead', () => f.control.projectRead(personal, f.project.id)],
  ])('refuses %s called directly with a personal principal', (_name, read) => {
    expect(read).toThrow(outside);
  });

  it('refuses the snapshot of every project to a personal principal', () => {
    expect(() => f.control.snapshot(personal)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  });
});

type Workbench = Awaited<ReturnType<typeof workbenchFixture>>;

/** Two projects, each with an idle session, a pending approval and a decision a lead made for the user. */
async function twoProjects() {
  const f = await workbenchFixture();
  const other = f.store.insert<Project>('projects', {
    ...f.project,
    id: 'other-project',
    name: 'Other project',
  });
  const sessions: Session[] = [];
  for (const project of [f.project, other]) {
    const session = await f.call<Promise<Session>>('session.create', {
      project_id: project.id,
      runtime: f.adapter.name,
      input: `Work on ${project.name}`,
    });
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    sessions.push(session);
  }
  await eventually(
    () =>
      sessions.every(
        (session) =>
          f.turns(session.id).every((turn) => turn.state === 'completed') &&
          f.store.must<Session>('sessions', session.id).state === 'open',
      ),
    () => f.control.tick(),
  );
  for (const session of sessions) {
    f.store.insert<Approval>('approvals', {
      id: `approval-${session.project_id}`,
      revision: 1,
      project_id: session.project_id,
      session_id: session.id,
      kind: 'permission',
      input_hash: 'permission-input',
      decider: 'user',
      state: 'pending',
      created_at: f.store.now(),
    });
    f.store.event('charter.power_used', session, session.project_id, {
      power: 'plan_change',
      mode: 'on',
      subject: 'Reorder the tasks',
      session_id: session.id,
    });
  }
  return { f, ids: [f.project.id, other.id].sort() };
}

const reads: Record<
  (typeof PERSONAL_QUERIES)[number],
  (f: Workbench, ids: string[], p: Principal) => string[]
> = {
  'projects.summary': (f, _ids, p) =>
    f.control
      .projectsSummary(p)
      .projects.filter((project) => project.needs_you > 0)
      .map((project) => project.project_id),
  'needs_you.list': (f, _ids, p) => f.control.needsYou(p).items.map((item) => item.project_id),
  'project.brief': (f, ids, p) =>
    ids.filter((id) => f.control.projectBrief(p, id).items.length > 0),
  'project.decisions': (f, ids, p) =>
    ids.filter((id) => f.control.decisionsForUser(p, id).items.length > 0),
};

it.each(PERSONAL_QUERIES)('reads %s of two projects for a personal principal', async (query) => {
  const { f, ids } = await twoProjects();
  expect([...new Set(reads[query](f, ids, personal))].sort()).toEqual(ids);
  expect(reads[query](f, ids, personal)).toEqual(reads[query](f, ids, user));
});

it('lists for a personal principal the needs-you items the user sees, with actions it may not take disabled', async () => {
  const { f } = await twoProjects();
  const forUser = f.control.needsYou(user).items,
    forPersonal = f.control.needsYou(personal).items;
  expect(forPersonal.map((item) => item.source)).toEqual(forUser.map((item) => item.source));
  expect(forPersonal.flatMap((item) => item.actions).every((action) => !action.allowed)).toBe(true);
});

const secret = 'sk-live-marker-7f3a';

/** Two projects whose first one holds a Bash command with a token: pending, approved for a lead, approved by a rule, and running in the background. */
async function tokenInInputs() {
  const { f } = await twoProjects();
  const session = f.store
    .list<Session>('sessions')
    .find((entry) => entry.project_id === f.project.id)!;
  const commandLine = `curl -H "Authorization: Bearer ${secret}" https://api.example.com`;
  const bash = {
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    kind: 'permission',
    tool: 'Bash',
    input_hash: 'bash-input',
    input_summary: commandLine,
    rule: `Bash(${commandLine})`,
    decider: 'user',
    created_at: f.store.now() - 60_000,
  } as const;
  f.store.insert<Approval>('approvals', { ...bash, id: 'bash-pending', state: 'pending' });
  for (const [id, answered] of [
    ['bash-for-lead', { decider: 'lead', decided_by: `session:${session.id}` }],
    ['bash-by-rule', { answered_by_rule: bash.rule }],
  ] as const) {
    const approval = f.store.insert<Approval>('approvals', {
      ...bash,
      id,
      state: 'approved',
      ...answered,
    });
    f.store.event('approval.approved', approval, f.project.id, answered);
  }
  f.store.event('agent.background.changed', session, f.project.id, {
    kind: 'background.changed',
    tasks: [
      {
        id: 'tunnel',
        kind: 'shell',
        description: commandLine,
        started_at: f.store.now() - 31 * 60_000,
      },
    ],
  });
  return f;
}

it.each<[string, (f: Workbench, p: Principal) => unknown]>([
  ['needs_you.list', (f, p) => f.control.needsYou(p)],
  ['project.brief', (f, p) => f.control.projectBrief(p, f.project.id)],
  ['project.decisions', (f, p) => f.control.decisionsForUser(p, f.project.id)],
])('leaves the tool input text out of %s for a personal principal', async (_query, read) => {
  const f = await tokenInInputs();
  expect(JSON.stringify(read(f, user))).toContain(secret);
  expect(JSON.stringify(read(f, personal))).not.toContain(secret);
});

it.each([
  ['with a stored process identity', { process_identity: { pid: 4242 } }],
  ['without a process identity', { process_identity: undefined }],
])(
  'disables every action of a reconciling session %s for a personal principal',
  async (_case, patch) => {
    const { f } = await twoProjects();
    for (const session of f.store.list<Session>('sessions'))
      f.store.update<Session>(
        'sessions',
        { ...session, ...patch, state: 'reconciling' },
        session.revision,
      );
    const reconciling = (p: Principal) =>
      f.control.needsYou(p).items.filter((item) => item.kind === 'session.reconciling');
    const forPersonal = reconciling(personal).flatMap((item) => item.actions);
    expect(reconciling(user).flatMap((item) => item.actions)).toContainEqual(
      expect.objectContaining({ allowed: true }),
    );
    expect(forPersonal.length).toBeGreaterThan(0);
    expect(forPersonal.every((action) => !action.allowed)).toBe(true);
  },
);
