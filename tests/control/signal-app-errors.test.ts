import { expect, it, vi } from 'vitest';
import type { AgentProfile, LeadNote, Session, SignalIssue } from '@pantheon/domain';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const issues = (f: Fixture) => f.store.list<SignalIssue>('signal_issues');

/** The texts of the signal notes the project's triage residents got, oldest first. */
function triageNotes(f: Fixture) {
  const triage = f.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === f.project.id && agent.template === 'triage')!;
  const ids = new Set(
    f.store
      .list<Session>('sessions')
      .filter((session) => session.resident?.agent_id === triage.id)
      .map((session) => session.id),
  );
  return f.store
    .events(0, f.project.id, 1000, ['lead.note_added'])
    .filter((event) => ids.has(event.aggregate_id))
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'signal')
    .map((note) => note.text);
}

it('records an app error for the project at the app checkout and groups its repeats', async () => {
  const f = await workbenchFixture({ appCheckout: true });
  const report = (item: number) =>
    f.call<SignalIssue>('signal.app_error', {
      kind: 'console',
      message: `Warning: list item ${item} has no key`,
      stack: [
        'Error',
        '    at warn (http://localhost:5173/node_modules/.vite/deps/react.js?v=8e1f0a2b:40:3)',
        `    at Row (http://localhost:5173/src/screens/board/Row.tsx?t=${item}:4:1)`,
      ].join('\n'),
    });
  const first = report(3);
  expect(first).toMatchObject({
    project_id: f.project.id,
    source: 'app_errors',
    title: 'Warning: list item <n> has no key',
    state: 'new',
    priority: 'record',
    count: 1,
  });
  report(9);
  expect(issues(f)).toHaveLength(1);
  expect(issues(f)[0]).toMatchObject({ id: first.id, count: 2 });
  expect(issues(f)[0]!.samples.at(-1)).toMatch(/^Warning: list item 9 has no key\nError\n/);
});

it('drops an app error when no open project is the app checkout, and still succeeds', async () => {
  const f = await workbenchFixture();
  expect(f.call('signal.app_error', { kind: 'error', message: 'TypeError: boom' })).toBeNull();
  expect(
    f.call('signal.app_error', { kind: 'crash', message: 'Renderer gone: oom', reason: 'oom' }),
  ).toBeNull();
  expect(issues(f)).toEqual([]);
});

it('delivers a renderer crash to the listening triage at once and records nothing for a clean exit', async () => {
  const f = await workbenchFixture({ appCheckout: true });
  let now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  expect(
    f.call('signal.app_error', {
      kind: 'crash',
      message: 'Renderer process gone: clean-exit (exit code 0)',
      reason: 'clean-exit',
      exit_code: 0,
    }),
  ).toBeNull();
  expect(issues(f)).toEqual([]);

  const crash = f.call<SignalIssue>('signal.app_error', {
    kind: 'crash',
    message: 'Renderer process gone: oom (exit code 9)',
    reason: 'oom',
    exit_code: 9,
  });
  expect(crash).toMatchObject({
    source: 'app_errors',
    fingerprint: 'crash:oom',
    priority: 'interrupt',
    state: 'new',
  });
  now += 31_000;
  await f.control.tick();
  expect(triageNotes(f)).toHaveLength(1);
  expect(triageNotes(f)[0]).toContain(crash.id);
});
