import { expect, it } from 'vitest';
import {
  id,
  type EnvironmentCheck,
  type LandingItem,
  type Project,
  type Session,
  type SignalIssue,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { recordGateRun } from '../../packages/control/dist/signal-sources.js';
import { eventually, insideSandbox } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type GateResult = NonNullable<LandingItem['gate_results']>[number];

const cannotStart: GateResult = {
  state: 'failed',
  name: 'test',
  argv: ['pantheon-missing-tool', 'test'],
  exit_code: null,
  duration_ms: 3,
  timed_out: false,
  output: 'spawn pantheon-missing-tool ENOENT',
  failure_class: 'environment',
};

/** A project whose gate has the one command `test`, and a task session whose gate runs it. */
async function gateFixture(argv: string[]) {
  const f = await workbenchFixture();
  await f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands: [{ name: 'test', argv }] },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const session = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: 'lead-session', id: 'task-first' },
  });
  const gateRun = (results: GateResult[]) =>
    f.store.transaction(() => {
      f.store.event('session.gate_checked', session, f.project.id, { commit: 'a1b2c3d4', results });
      recordGateRun(ctx, {
        project_id: f.project.id,
        session_id: session.id,
        commit: 'a1b2c3d4',
        results,
      });
    });
  const checks = () => f.store.list<EnvironmentCheck>('environment_checks');
  const issues = () =>
    f.store.list<SignalIssue>('signal_issues').filter((issue) => issue.source === 'gate_failures');
  const ended = () =>
    eventually(
      () => checks().every((check) => check.state !== 'running'),
      () => f.control.tick(),
      20000,
    );
  return { f, gateRun, checks, issues, ended };
}

it.skipIf(insideSandbox).each<[string, string[], (sha: string) => string]>([
  [
    'fails there too',
    ['pantheon-missing-tool', 'test'],
    (sha) => `Fails on ${sha} in a fresh worktree: test exit -1`,
  ],
  ['passes there', ['sh', '-c', 'true'], (sha) => `Passes on ${sha} in a fresh worktree`],
])(
  'checks the base commit of a command that could not start in a task and notes on the issue that it %s',
  async (_, argv, text) => {
    const { f, gateRun, checks, issues, ended } = await gateFixture(argv);
    gateRun([cannotStart]);
    expect(issues()).toHaveLength(1);
    const issue = issues()[0]!;
    expect(checks()).toEqual([
      expect.objectContaining({
        state: 'running',
        root: f.project.roots[0],
        cause: { kind: 'signal', issue_id: issue.id },
      }),
    ]);
    await ended();
    const notes = f.store
      .must<SignalIssue>('signal_issues', issue.id)
      .history.filter((entry) => entry.text.includes('fresh worktree'));
    expect(notes.map((entry) => entry.text)).toEqual([
      text(git(f.source, 'rev-parse', 'HEAD').slice(0, 7)),
    ]);
  },
);

it.skipIf(insideSandbox)(
  'starts no second base check when the same command fails again for its issue',
  async () => {
    const { gateRun, checks, issues, ended } = await gateFixture(['sh', '-c', 'true']);
    gateRun([cannotStart]);
    await ended();
    gateRun([cannotStart]);
    expect(issues()).toHaveLength(1);
    expect(checks()).toHaveLength(1);
  },
);

it('starts no base check for a command that failed on its code in one task', async () => {
  const { gateRun, checks } = await gateFixture(['sh', '-c', 'true']);
  gateRun([
    {
      ...cannotStart,
      argv: ['sh', '-c', 'exit 1'],
      exit_code: 1,
      output: 'AssertionError: expected 3 to be 4',
      failure_class: 'code',
    },
  ]);
  expect(checks()).toEqual([]);
});
