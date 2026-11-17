import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import { appDebugSkill } from '../../packages/control/src/app-debug-skill.js';
import { projectSetupSkill } from '../../packages/control/src/project-setup-skill.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

/** The model input of the first turn of a session created with these extra fields. */
async function firstInput(extra: Record<string, unknown>) {
  const f = await workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const start = vi.spyOn(f.adapter, 'start');
  const session = await f.call<Session>('session.create', {
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
  return {
    f,
    session,
    input: send.mock.calls[0]![1].input as string,
    spec: start.mock.calls[0]![0],
  };
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

it('opens an app debug session whose runtime reaches the app at the port the desktop wrote for each turn', async () => {
  const { f, session, input } = await firstInput({ purpose: 'app_debug' });
  expect(input.indexOf(appDebugSkill)).toBeGreaterThanOrEqual(0);
  expect(input.indexOf(appDebugSkill)).toBeLessThan(input.indexOf('A habit tracker for runners'));
  expect(input).not.toContain(projectSetupSkill);
  expect(f.turns(session.id)[0]!.input).toBe('A habit tracker for runners');
  expect(session.app_debug).toBe(true);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const userData = ctx.protectionPaths!.desktopUserDataDir;
  const portFile = path.join(userData, 'DevToolsActivePort');
  const chromeDevtools = (port: number) => [
    {
      name: 'chrome_devtools',
      command: 'npx',
      args: [
        '--prefix',
        os.homedir(),
        '-y',
        'chrome-devtools-mcp@1.13.0',
        `--browser-url=http://127.0.0.1:${port}`,
      ],
      env: {},
    },
  ];
  mkdirSync(userData, { recursive: true });
  writeFileSync(portFile, '9333\n/devtools/browser/x\n');
  const stored = () => f.store.must<Session>('sessions', session.id);
  expect(workbenchSessionSpec(ctx, stored()).mcp_servers).toEqual(chromeDevtools(9333));
  // A restarted app writes a new port, which the same session reaches on its next turn.
  writeFileSync(portFile, '9444\n/devtools/browser/y\n');
  expect(workbenchSessionSpec(ctx, stored()).mcp_servers).toEqual(chromeDevtools(9444));
  rmSync(portFile);
  expect(workbenchSessionSpec(ctx, stored()).mcp_servers).toEqual([]);
});

it.each([
  ['project_setup', false],
  ['app_debug', false],
  [undefined, true],
])(
  'gives a session with purpose %s the lead planning instructions: %s',
  async (purpose, planned) => {
    const f = await workbenchFixture();
    const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
    Object.assign(ctx, {
      issueSessionCredential: () => ({
        token_file: path.join(os.tmpdir(), 'token'),
        daemon_url: 'http://127.0.0.1:4321',
      }),
    });
    const session = await f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'A habit tracker for runners',
      ...(purpose ? { purpose } : {}),
    });
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    const spec = workbenchSessionSpec(ctx, f.store.must<Session>('sessions', session.id));
    expect(spec.pantheon_mcp).toBeDefined();
    expect(spec.control_instructions!.includes('update_board before anything changes')).toBe(
      planned,
    );
  },
);

it('rejects a purpose it does not know', async () => {
  const f = await workbenchFixture();
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

it('reads a project folder with fewer than three files as empty, as the baseline does', async () => {
  const f = await workbenchFixture();
  expect((await f.control.projectFactsRead(user, f.project.id)).empty).toBe(true);
  mkdirSync(path.join(f.source, 'src'));
  writeFileSync(path.join(f.source, 'src/index.ts'), 'export {};\n');
  writeFileSync(path.join(f.source, 'README.md'), '# Tracker\n');
  expect((await f.control.projectFactsRead(user, f.project.id)).empty).toBe(false);
});
