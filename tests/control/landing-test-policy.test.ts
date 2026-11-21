import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const cases = [
  ['deleted test file', 'tests/answer.test.ts', "it('works', () => {});\n", undefined],
  ['removed test case', 'tests/answer.test.ts', "it('works', () => {});\n", ''],
  ['removed assertion', 'tests/answer.test.ts', 'expect(answer).toBe(42);\n', ''],
  ['skipped case', 'tests/answer.test.ts', '', "it.skip('works', () => {});\n"],
  ['exclusive case', 'tests/answer.test.ts', '', "it.only('works', () => {});\n"],
  [
    'pytest skipped case',
    'tests/test_answer.py',
    'def test_works():\n    assert True\n',
    '@pytest.mark.skip\ndef test_works():\n    assert True\n',
  ],
  [
    'test runner configuration',
    'vitest.config.ts',
    'export default {};\n',
    'export default { exclude: ["**/*"] };\n',
  ],
  ['CI workflow', '.github/workflows/ci.yml', 'run: false\n', 'run: true\n'],
  [
    'case added to a test file',
    'tests/answer.test.ts',
    "it('works', () => {});\n",
    "it('works', () => {});\nit('adds', () => {});\n",
  ],
  ['source edit', 'src/answer.ts', 'export const answer = 41;\n', 'export const answer = 42;\n'],
] as const;

/** A session that changes file from before to after (undefined deletes it), not yet merged. */
async function sessionChange(file: string, before: string, after: string | undefined) {
  const f = await workbenchFixture();
  mkdirSync(path.dirname(path.join(f.source, file)), { recursive: true });
  writeFileSync(path.join(f.source, file), before);
  git(f.source, 'add', '.');
  git(f.source, 'commit', '--quiet', '-m', 'Add verification input');
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  if (after === undefined) rmSync(path.join(workspace.path, file));
  else writeFileSync(path.join(workspace.path, file), after);
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '--quiet', '-m', 'Change verification input');
  return { f, session };
}

it.each(cases)(
  'lands a %s from a session without a task contract',
  async (_label, file, before, after) => {
    const { f, session } = await sessionChange(file, before, after);
    f.call(
      'session.merge',
      { session_id: session.id },
      f.store.must<Session>('sessions', session.id).revision,
    );
    await eventually(
      () =>
        f.store.must<Session>('sessions', session.id).merge?.state === 'blocked' ||
        f.store.must<Session>('sessions', session.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );
    expect(f.store.must<Session>('sessions', session.id).merge?.reason).toBeUndefined();
    expect(f.store.must<Session>('sessions', session.id).outcome).toBe('merged');
  },
);
