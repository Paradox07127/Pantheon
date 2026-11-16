import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import { projectSetupSkill } from '../../packages/control/src/project-setup-skill.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

/** The model input of the first turn of a session created with these extra fields. */
async function firstInput(extra: Record<string, unknown>) {
  const f = workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'A habit tracker for runners',
    ...extra,
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  return { f, session, input: send.mock.calls[0]![1].input as string };
}

it('opens a project setup session whose first message starts with the setup guide', async () => {
  const { f, session, input } = await firstInput({ purpose: 'project_setup' });
  expect(input.indexOf(projectSetupSkill)).toBeGreaterThanOrEqual(0);
  expect(input.indexOf(projectSetupSkill)).toBeLessThan(
    input.indexOf('A habit tracker for runners'),
  );
  // The thread shows only what the user wrote.
  expect(f.turns(session.id)[0]!.input).toBe('A habit tracker for runners');
  expect(session.workspace_id).toBeDefined();
});

it('opens a session without a purpose with no setup guide', async () => {
  const { input } = await firstInput({});
  expect(input).not.toContain(projectSetupSkill);
});

it('rejects a purpose it does not know', () => {
  const f = workbenchFixture();
  expect(() =>
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      purpose: 'baseline',
    }),
  ).toThrow();
});

it('has the setup guide settle requirements a few questions at a time and build only once confirmed', () => {
  expect(projectSetupSkill).toMatch(/who the users are/);
  expect(projectSetupSkill).toMatch(/platforms/);
  expect(projectSetupSkill).toMatch(/technology preferences/);
  expect(projectSetupSkill).toMatch(/constraints/);
  expect(projectSetupSkill).toMatch(/at most 3 questions/);
  expect(projectSetupSkill).toMatch(/Do not create or change any file before the user confirms/);
  for (const part of ['README', 'package manager', 'entry point', 'test framework'])
    expect(projectSetupSkill).toContain(part);
  expect(projectSetupSkill).toMatch(/run the baseline/);
  expect(projectSetupSkill).toMatch(/Do not draw in the conversation/);
  expect(projectSetupSkill).toMatch(/board/);
});

it('reads a project folder with fewer than three files as empty, as the baseline does', () => {
  const f = workbenchFixture();
  expect(f.control.projectFactsRead(user, f.project.id).empty).toBe(true);
  mkdirSync(path.join(f.source, 'src'));
  writeFileSync(path.join(f.source, 'src/index.ts'), 'export {};\n');
  writeFileSync(path.join(f.source, 'README.md'), '# Tracker\n');
  expect(f.control.projectFactsRead(user, f.project.id).empty).toBe(false);
});
