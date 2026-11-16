import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { BoardPlan, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

// The policy must stop a weakened check even when that check would return success.
vi.mock('../../packages/control/dist/validation-executor.js', async (original) => ({
  ...(await original<typeof import('../../packages/control/dist/validation-executor.js')>()),
  runValidationCommand: vi.fn(async () => ({
    exit_code: 0,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: '',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
    boundary: {
      kind: 'macos-seatbelt',
      network: 'loopback',
      supported: true,
      stop_scope: 'process-group',
    },
  })),
}));

const cases = [
  ['deleted test file', 'tests/answer.test.ts', '', undefined, 'true'],
  ['removed test case', 'tests/answer.test.ts', "it('works', () => {});\n", '', 'true'],
  ['removed suite', 'tests/answer.test.ts', "describe('works', () => {});\n", '', 'true'],
  ['removed assertion', 'tests/answer.test.ts', 'expect(answer).toBe(42);\n', '', 'true'],
  ['skipped case', 'tests/answer.test.ts', '', "it.skip('works', () => {});\n", 'true'],
  ['skipped suite', 'tests/answer.test.ts', '', "describe.skip('works', () => {});\n", 'true'],
  ['exclusive case', 'tests/answer.test.ts', '', "it.only('works', () => {});\n", 'true'],
  ['exclusive suite', 'tests/answer.test.ts', '', "describe.only('works', () => {});\n", 'true'],
  ['disabled case', 'tests/answer.test.ts', '', "xit('works', () => {});\n", 'true'],
  [
    'acceptance script',
    'checks/answer.mjs',
    'process.exit(1);\n',
    'process.exit(0);\n',
    'node checks/answer.mjs',
  ],
  [
    'acceptance test edit',
    'tests/answer.test.ts',
    'const answer = 41;\n',
    'const answer = 42;\n',
    'true && vitest run tests/answer.test.ts',
  ],
  [
    'custom gate configuration',
    'checks/gate.json',
    '{}\n',
    '{"disabled":true}\n',
    'true --config=checks/gate.json',
  ],
  [
    'package gate script',
    'package.json',
    '{"scripts":{"test":"false"}}\n',
    '{"scripts":{"test":"true"}}\n',
    'true',
  ],
  [
    'test runner configuration',
    'vitest.config.ts',
    'export default {};\n',
    'export default { exclude: ["**/*"] };\n',
    'true',
  ],
  ['CI workflow', '.github/workflows/ci.yml', 'run: false\n', 'run: true\n', 'true'],
] as const;

it.each(cases)(
  'hands an unlisted %s to the lead until its exact path is scoped',
  async (_label, file, before, after, acceptance) => {
    const f = workbenchFixture();
    mkdirSync(path.dirname(path.join(f.source, file)), { recursive: true });
    writeFileSync(path.join(f.source, file), before);
    git(f.source, 'add', '.');
    git(f.source, 'commit', '--quiet', '-m', 'Add verification input');
    const sourceHead = git(f.source, 'rev-parse', 'HEAD');
    const lead = f.create('Maintain the answer');
    await awaitWorkspaceReady(f.control, lead.workspace_id!);
    await eventually(
      () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
      () => f.control.tick(),
    );
    f.store.insert<BoardPlan>('board_plans', {
      id: lead.id,
      revision: 1,
      project_id: f.project.id,
      headline: 'Maintain the answer',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'answer',
          title: 'Answer',
          goal: 'Maintain the answer',
          lane: 'core',
          depends_on: [],
          source: [],
          scope: [path.dirname(file)],
          acceptance: [acceptance],
        },
      ],
      risks: [],
      assumptions: [],
      plan_version: 0,
      pending_edits: [],
      inbox: [],
      notified: {},
      updated_at: f.store.now(),
    });
    const worker = f.create();
    const workspace = await awaitWorkspaceReady(f.control, worker.workspace_id!);
    await eventually(
      () => f.turns(worker.id).every((turn) => turn.state === 'completed'),
      () => f.control.tick(),
    );
    const idle = f.store.must<Session>('sessions', worker.id);
    f.store.update(
      'sessions',
      { ...idle, task: { lead_session_id: lead.id, id: 'answer' } },
      idle.revision,
    );
    if (after === undefined) rmSync(path.join(workspace.path, file));
    else writeFileSync(path.join(workspace.path, file), after);
    git(workspace.path, 'add', '.');
    git(workspace.path, 'commit', '--quiet', '-m', 'Change verification input');
    f.call(
      'session.merge',
      {
        session_id: worker.id,
        ...(_label === 'deleted test file' ? { allow_out_of_scope: true } : {}),
      },
      f.store.must<Session>('sessions', worker.id).revision,
    );
    await eventually(
      () =>
        f.store.must<Session>('sessions', worker.id).merge?.state === 'blocked' ||
        f.store.must<Session>('sessions', worker.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    expect(f.store.must<Session>('sessions', worker.id).merge).toMatchObject({
      state: 'blocked',
      reason: 'verification_changed',
      conflicts: [file],
    });
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(sourceHead);
    await eventually(
      () =>
        f
          .turns(lead.id)
          .some((turn) => turn.origin === 'tracker' && turn.input.includes('verification_changed')),
      () => f.control.tick(),
    );
    expect(f.turns(lead.id).find((turn) => turn.origin === 'tracker')!.input).toContain(file);
    const plan = f.store.must<BoardPlan>('board_plans', lead.id);
    f.store.update(
      'board_plans',
      { ...plan, tasks: [{ ...plan.tasks[0]!, scope: [file] }] },
      plan.revision,
    );
    const blocked = f.store.must<Session>('sessions', worker.id);
    f.call('session.merge', { session_id: worker.id }, blocked.revision);
    await eventually(
      () => f.store.must<Session>('sessions', worker.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    expect(
      f.store.kindEvents(f.project.id, ['session.verification_change_allowed']).at(-1)?.payload,
    ).toEqual({ files: [file], reason: 'explicit_task_scope' });
  },
);
