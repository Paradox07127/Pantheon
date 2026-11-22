import { expect, it, vi } from 'vitest';
import type { LandingItem, Project, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function idleSession(f: Fixture, input = 'Check the project') {
  const session = await f.create(input);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return f.store.must<Session>('sessions', session.id);
}

function recordGateRun(
  f: Fixture,
  session: Session,
  at: number,
  results: NonNullable<LandingItem['gate_results']> = [
    { name: 'check', argv: ['true'], exit_code: 0, duration_ms: 50, timed_out: false, output: '' },
  ],
) {
  vi.spyOn(f.store, 'now').mockReturnValue(at);
  return f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit: 'c'.repeat(40),
    check_spec_hash: 'spec',
    results,
  });
}

it('merges session runs newest first with listed titles and one project event read', async () => {
  const f = await workbenchFixture();
  const first = await idleSession(f, 'Check the first session'),
    second = await idleSession(f, 'Check the second session');
  const at = Date.parse('2026-01-01T12:00:00Z');
  const now = vi.spyOn(f.store, 'now').mockReturnValue(at);
  const firstStart = f.store.event('session.gate_started', first, f.project.id, {});
  now.mockReturnValue(at + 10);
  const secondStart = f.store.event('session.gate_started', second, f.project.id, {});
  const oldest = recordGateRun(f, second, at + 100),
    middle = recordGateRun(f, first, at + 200),
    newest = recordGateRun(f, second, at + 300);
  const expected = [
    ...f.control.sessionGatesHistory(user, first.id).runs,
    ...f.control.sessionGatesHistory(user, second.id).runs,
  ].sort((a, b) => b.finished_at.localeCompare(a.finished_at));
  const titles = new Map(f.list().map((session) => [session.id, session.title]));
  const readEvents = vi.spyOn(f.store, 'kindEvents'),
    cursor = f.store.cursor();

  const { runs } = f.control.projectGatesHistory(user, f.project.id);
  expect(runs.map((run) => run.run_id)).toEqual([
    newest.event_id,
    middle.event_id,
    oldest.event_id,
  ]);
  expect(runs.map((run) => run.session_id)).toEqual([second.id, first.id, second.id]);
  expect(runs.map((run) => run.session_title)).toEqual([
    titles.get(second.id),
    titles.get(first.id),
    titles.get(second.id),
  ]);
  expect(runs.map(({ session_id, session_title, ...run }) => run)).toEqual(expected);
  expect(runs.map((run) => run.started_at)).toEqual([
    new Date(newest.created_at - 50).toISOString(),
    new Date(firstStart.created_at).toISOString(),
    new Date(secondStart.created_at).toISOString(),
  ]);
  expect(readEvents).toHaveBeenCalledExactlyOnceWith(f.project.id, [
    'session.gate_checked',
    'session.gate_started',
  ]);
  expect(f.store.cursor()).toBe(cursor);
});

it('applies the limit across sessions and defaults to thirty runs', async () => {
  const f = await workbenchFixture();
  const first = await idleSession(f),
    second = await idleSession(f);
  const at = Date.parse('2026-01-01T12:00:00Z');
  const events = Array.from({ length: 31 }, (_, index) =>
    recordGateRun(f, index % 2 ? first : second, at + index * 100),
  );
  const newestFirst = events.reverse().map((event) => event.event_id);

  expect(f.control.projectGatesHistory(user, f.project.id).runs.map((run) => run.run_id)).toEqual(
    newestFirst.slice(0, 30),
  );
  expect(
    f.control.projectGatesHistory(user, f.project.id, 2).runs.map((run) => run.run_id),
  ).toEqual(newestFirst.slice(0, 2));
});

it('skips a session without a worktree before applying the limit', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const readOnly = f.store.insert<Session>('sessions', {
    id: 'read-only-session',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  const at = Date.parse('2026-01-01T12:00:00Z');
  const checked = recordGateRun(f, session, at);
  recordGateRun(f, readOnly, at + 100);

  expect(f.control.projectGatesHistory(user, f.project.id, 1).runs).toEqual([
    expect.objectContaining({ run_id: checked.event_id, session_id: session.id }),
  ]);
});

it('leaves out the runs of a deleted session whose events remain', async () => {
  const f = await workbenchFixture();
  const kept = await idleSession(f, 'Check the kept session'),
    deleted = await idleSession(f, 'Check the deleted session');
  const at = Date.parse('2026-01-01T12:00:00Z');
  const keptRun = recordGateRun(f, kept, at);
  recordGateRun(f, deleted, at + 100);
  f.call(
    'session.delete',
    { session_id: deleted.id },
    f.store.must<Session>('sessions', deleted.id).revision,
  );
  await eventually(
    () => !f.store.get<Session>('sessions', deleted.id),
    () => f.control.tick(),
  );

  expect(f.control.projectGatesHistory(user, f.project.id).runs).toEqual([
    expect.objectContaining({ run_id: keptRun.event_id, session_id: kept.id }),
  ]);
});

it('lists commands after a failure as skipped just like the session query', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        { name: 'build', argv: ['pnpm', 'build'] },
        { name: 'test', argv: ['pnpm', 'test'] },
        { name: 'lint', argv: ['pnpm', 'lint'] },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  recordGateRun(f, session, Date.parse('2026-01-01T12:00:00Z'), [
    {
      name: 'build',
      argv: ['pnpm', 'build'],
      exit_code: 0,
      duration_ms: 120,
      timed_out: false,
      output: '',
    },
    {
      name: 'test',
      argv: ['pnpm', 'test'],
      exit_code: 1,
      duration_ms: 250,
      timed_out: false,
      output: '',
    },
  ]);

  const [run] = f.control.projectGatesHistory(user, f.project.id).runs;
  expect(run!.results).toEqual(f.control.sessionGatesHistory(user, session.id).runs[0]!.results);
  expect(run!.results).toEqual([
    {
      name: 'build',
      command: ['pnpm', 'build'],
      exit_code: 0,
      timed_out: false,
      duration_ms: 120,
    },
    {
      name: 'test',
      command: ['pnpm', 'test'],
      exit_code: 1,
      timed_out: false,
      duration_ms: 250,
    },
    { name: 'lint', command: ['pnpm', 'lint'], skipped: true },
  ]);
});

it('refuses access to another project principal', async () => {
  const f = await workbenchFixture();
  const otherProject = f.store.insert<Project>('projects', { ...f.project, id: 'other-project' });
  const session = f.store.insert<Session>('sessions', {
    id: 'other-session',
    revision: 1,
    project_id: otherProject.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    project_setup: true,
  });
  const otherPrincipal = {
    id: `session:${session.id}`,
    role: 'planner' as const,
    project_id: otherProject.id,
    session_id: session.id,
    expires_at: f.store.now() + 60000,
  };
  expect(f.control.projectGatesHistory(otherPrincipal, otherProject.id)).toEqual({ runs: [] });
  expect(() => f.control.projectGatesHistory(otherPrincipal, f.project.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('filters by the inclusive run start before limiting and orders by start newest first', async () => {
  const f = await workbenchFixture();
  const first = await idleSession(f),
    second = await idleSession(f);
  const at = new Date(2027, 2, 10, 12).getTime();
  const now = vi.spyOn(f.store, 'now').mockReturnValue(at);
  f.store.event('session.gate_started', first, f.project.id, {});
  now.mockReturnValue(at + 100);
  f.store.event('session.gate_started', second, f.project.id, {});
  const newerStart = recordGateRun(f, second, at + 200),
    olderStart = recordGateRun(f, first, at + 300);
  expect(f.control.projectGatesHistory(user, f.project.id).runs.map((run) => run.run_id)).toEqual([
    olderStart.event_id,
    newerStart.event_id,
  ]);
  expect(
    f.control.projectGatesHistory(user, f.project.id, 1, at).runs.map((run) => run.run_id),
  ).toEqual([newerStart.event_id]);
  expect(
    f.control.projectGatesHistory(user, f.project.id, 500, at + 100).runs.map((run) => run.run_id),
  ).toEqual([newerStart.event_id]);
  expect(f.control.projectGatesHistory(user, f.project.id, 500, at + 101).runs).toEqual([]);
});

it('allows more than a hundred runs only when a start is supplied', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const at = new Date(2027, 2, 10, 12).getTime();
  for (let index = 0; index < 101; index++) recordGateRun(f, session, at + index * 100);
  expect(f.control.projectGatesHistory(user, f.project.id, 500, at - 50).runs).toHaveLength(101);
  expect(() => f.control.projectGatesHistory(user, f.project.id, 101)).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
});
