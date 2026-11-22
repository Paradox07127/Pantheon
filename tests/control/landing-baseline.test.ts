import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { Landing, LandingItem } from '@pantheon/domain';
import { Store } from '../../packages/store/src/index.js';
import { droppedTests } from '../../packages/control/dist/landing.js';
import type { ControlContext } from '../../packages/control/src/context.js';

type GateResult = NonNullable<LandingItem['gate_results']>[number];

const gate = (name: string, passed: number, skipped = 0): GateResult => ({
  name,
  argv: [name],
  state: 'passed',
  exit_code: 0,
  duration_ms: 1,
  timed_out: false,
  output: '',
  tests: { passed, failed: 0, skipped },
});

/** A store at a clock that moves on each read, and two repository roots of one project. */
function baselineFixture() {
  const directory = mkdtempSync(
    path.join(path.resolve('node_modules/.cache'), 'landing-baseline-'),
  );
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first'),
    second = path.join(directory, 'second');
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, path.join(directory, 'linked'));
  let time = 0;
  const store = new Store(':memory:', () => ++time);
  onTestFinished(() => store.close());
  const ctx = { store } as unknown as ControlContext;
  const roots = {
    first: realpathSync(first),
    second: realpathSync(second),
    linked: path.join(directory, 'linked'),
  };
  const landed = (root: string, results: GateResult[]) =>
    store.insert<Landing>('landings', {
      id: `landing-${time}`,
      revision: 1,
      project_id: 'project',
      root,
      branch: 'feature',
      target_branch: 'main',
      workspace_id: `workspace-${time}`,
      state: 'landed',
      gate_results: results,
      finished_at: store.now(),
    });
  const session = { id: 'session', revision: 1 };
  const checked = (commit: string, results: GateResult[]) =>
    store.event('session.gate_checked', session, 'project', { commit, results });
  const merged = (root: string, commit: string) =>
    store.event('session.merged', session, 'project', {
      branch: 'main',
      source: root,
      to_sha: commit,
    });
  return { store, ctx, roots, landed, checked, merged };
}

it('compares a landing only with the last landing onto the same branch of the same repository', () => {
  const f = baselineFixture();
  f.landed(f.roots.first, [gate('unit', 10)]);
  expect(droppedTests(f.ctx, 'project', f.roots.second, 'main', [gate('unit', 9)])).toBe(undefined);
  expect(droppedTests(f.ctx, 'project', f.roots.linked, 'main', [gate('unit', 9)])).toBe(
    'tests_dropped: unit: passed 10→9, skipped 0→0',
  );
  f.checked('merged-commit', [gate('unit', 20)]);
  f.merged(f.roots.second, 'merged-commit');
  expect(droppedTests(f.ctx, 'project', f.roots.first, 'main', [gate('unit', 9)])).toBe(
    'tests_dropped: unit: passed 10→9, skipped 0→0',
  );
  expect(droppedTests(f.ctx, 'project', f.roots.second, 'main', [gate('unit', 19)])).toBe(
    'tests_dropped: unit: passed 20→19, skipped 0→0',
  );
});

it('takes the gate run a session merge landed with, not a later run on the same commit', () => {
  const f = baselineFixture();
  f.checked('merged-commit', [gate('unit', 10)]);
  f.merged(f.roots.first, 'merged-commit');
  f.checked('merged-commit', [gate('unit', 5)]);
  expect(droppedTests(f.ctx, 'project', f.roots.first, 'main', [gate('unit', 9)])).toBe(
    'tests_dropped: unit: passed 10→9, skipped 0→0',
  );
});

it('pairs gates of one name by their order among that name', () => {
  const f = baselineFixture();
  f.landed(f.roots.first, [gate('unit', 50), gate('unit', 10)]);
  expect(
    droppedTests(f.ctx, 'project', f.roots.first, 'main', [gate('unit', 50), gate('unit', 10)]),
  ).toBe(undefined);
  expect(
    droppedTests(f.ctx, 'project', f.roots.first, 'main', [gate('unit', 50), gate('unit', 9)]),
  ).toBe('tests_dropped: unit: passed 10→9, skipped 0→0');
  expect(
    droppedTests(f.ctx, 'project', f.roots.first, 'main', [gate('unit', 40), gate('unit', 10)]),
  ).toBe('tests_dropped: unit: passed 50→40, skipped 0→0');
});

it('reads only the newest matching landing, without loading the landing and merge history', () => {
  const f = baselineFixture();
  f.landed(f.roots.first, [gate('unit', 5)]);
  f.landed(f.roots.first, [gate('unit', 10)]);
  f.landed(f.roots.second, [gate('unit', 30)]);
  const list = vi.spyOn(f.store, 'list'),
    kindEvents = vi.spyOn(f.store, 'kindEvents');
  expect(droppedTests(f.ctx, 'project', f.roots.first, 'main', [gate('unit', 9)])).toBe(
    'tests_dropped: unit: passed 10→9, skipped 0→0',
  );
  expect(list).not.toHaveBeenCalled();
  expect(kindEvents).not.toHaveBeenCalled();
});
