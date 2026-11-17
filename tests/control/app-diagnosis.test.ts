import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { credentialRole, type Principal, type Session, type Workspace } from '@pantheon/domain';
import {
  appDebugTools,
  command,
  coordinationTools,
  leadToolGroups,
  sessionTools,
  type CommandType,
} from '@pantheon/protocol';
import { appDebugSkill, appDiagnoseSkill } from '../../packages/control/src/app-debug-skill.js';
import {
  purposeSessionTools,
  sessionAction,
  type ControlContext,
} from '../../packages/control/dist/context.js';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const appActions = Object.values(appDebugTools) as string[];
const everyAction = [
  ...new Set([
    ...Object.values(sessionTools).flatMap((tools) => Object.values(tools) as string[]),
    ...(Object.values(coordinationTools) as string[]),
  ]),
].sort();

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const kindOf = (f: Fixture, session: Session) =>
  f.store.must<Workspace>('workspaces', session.workspace_id!).kind;

function principalOf(f: Fixture, session: Session): Principal {
  return {
    id: `session:${session.id}`,
    role: credentialRole(session, kindOf(f, session)),
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60_000,
  };
}

/** Every session tool and coordination tool the session may call, sorted. */
function granted(f: Fixture, session: Session): string[] {
  const principal = principalOf(f, session);
  return everyAction.filter((action) => {
    try {
      sessionAction(ctxOf(f), principal, action);
      return true;
    } catch {
      return false;
    }
  });
}

const open = (f: Fixture, extra: Record<string, unknown> = {}) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'The sidebar overlaps the board',
    ...extra,
  });
const diagnosis = (f: Fixture, extra: Record<string, unknown> = {}) =>
  open(f, { purpose: 'app_debug', workspace: 'in_place', ...extra });

/** A lead that is not a resident gets every lead tool but those of the resident-only groups. */
const directLeadActions = () =>
  Object.entries(sessionTools.lead)
    .filter(
      ([name]) =>
        !['always_on', 'app', 'sessions', 'github', 'agents'].includes(
          leadToolGroups[name as keyof typeof leadToolGroups],
        ),
    )
    .map(([, action]): string => action);

it.each([
  [
    'an app debug session in the project folder gets only the app tools and project_read',
    { purpose: 'app_debug', workspace: 'in_place' },
    'planner',
    () => [...appActions, 'project.read'].sort(),
  ],
  [
    'an app debug worktree session keeps its lead tools and gets the app tools too',
    { purpose: 'app_debug' },
    'lead',
    () =>
      [
        ...directLeadActions().filter((action) => !appActions.includes(action)),
        ...appActions,
      ].sort(),
  ],
  [
    'an ordinary worktree session gets none of the app tools',
    {},
    'lead',
    () =>
      directLeadActions()
        .filter((action) => !appActions.includes(action))
        .sort(),
  ],
  [
    'an ordinary session in the project folder gets none of the app tools',
    { workspace: 'in_place' },
    'planner',
    () =>
      (Object.values(sessionTools.planner) as string[])
        .filter((action) => !appActions.includes(action))
        .sort(),
  ],
] as const)('%s', async (_, extra, role, expected) => {
  const f = await workbenchFixture();
  const session = await open(f, extra);
  expect(principalOf(f, session).role).toBe(role);
  expect(granted(f, session)).toEqual(expected());
});

it('lists the allowed tools of the diagnosis session only', async () => {
  const f = await workbenchFixture();
  const inPlace = await diagnosis(f);
  expect(purposeSessionTools(inPlace, kindOf(f, inPlace))).toEqual([
    'app.errors',
    'app.screenshot',
    'app.dom',
    'app.logs',
    'style.read',
    'style.set',
    'project.read',
  ]);
  const worktree = await open(f, { purpose: 'app_debug' });
  expect(purposeSessionTools(worktree, kindOf(f, worktree))).toBeUndefined();
  const ordinary = await open(f, { workspace: 'in_place' });
  expect(purposeSessionTools(ordinary, kindOf(f, ordinary))).toBeUndefined();
});

it('refuses an app tool to an ordinary session and an editing tool to the diagnosis session', async () => {
  const f = await workbenchFixture();
  const run = (session: Session, type: CommandType, input: Record<string, unknown>) => {
    const principal = principalOf(f, session);
    return () => f.control.execute(principal, command(principal.id, type, input));
  };
  const ordinary = await open(f);
  for (const type of ['app.logs', 'style.read'] as const)
    expect(run(ordinary, type, {}), type).toThrow(
      expect.objectContaining({
        code: 'permission_denied',
        message: 'Action outside session role',
      }),
    );
  expect(run(ordinary, 'style.set', { css: '' })).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const inPlace = await diagnosis(f);
  expect(run(inPlace, 'app.logs', {})()).toEqual({ lines: [] });
  for (const [type, input] of [
    ['theme.set', { label: 'Paper', light: { anchors: {} } }],
    ['visual.draw', { title: 'x', kind: 'mermaid', spec: { source: 'graph LR; a-->b' } }],
    ['memory.propose', {}],
  ] as const)
    expect(run(inPlace, type, input), type).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
});

it('opens the diagnosis session in the project folder in plan mode with the diagnosis guide first', async () => {
  const f = await workbenchFixture({ managedWorkspaces: false });
  const send = vi.spyOn(f.adapter, 'send');
  const session = await diagnosis(f, { permission_mode: 'auto_edit' });
  expect(session).toMatchObject({ app_debug: true, permission_mode: 'plan' });
  expect(f.store.must<Workspace>('workspaces', session.workspace_id!)).toMatchObject({
    kind: 'in_place',
    path: f.source,
  });
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(f.start.mock.calls[0]![0]).toMatchObject({ cwd: f.source, permission_mode: 'plan' });
  const input = send.mock.calls[0]![1].input as string;
  expect(input.indexOf(appDiagnoseSkill)).toBeGreaterThanOrEqual(0);
  expect(input.indexOf(appDiagnoseSkill)).toBeLessThan(
    input.indexOf('The sidebar overlaps the board'),
  );
  // The thread shows only what the user wrote.
  expect(f.turns(session.id)[0]!.input).toBe('The sidebar overlaps the board');
  expect(f.list().find((row) => row.id === session.id)).toMatchObject({ app_debug: true });
});

it('refuses a diagnosis session on another device, as every session in the project folder', async () => {
  const f = await workbenchFixture();
  expect(() => diagnosis(f, { device_id: 'build-box' })).toThrow(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  expect(f.store.list<Session>('sessions')).toEqual([]);
});

it('has the diagnosis guide keep the project as it is and end with an issue draft', () => {
  for (const tool of [
    'app_errors',
    'app_dom',
    'app_screenshot',
    'app_logs',
    'style_read',
    'style_set',
  ])
    expect(appDiagnoseSkill).toContain(tool);
  expect(appDiagnoseSkill).toMatch(/not the code of the project/);
  expect(appDiagnoseSkill).toMatch(/Do not create, edit or delete files in the project/);
  expect(appDiagnoseSkill).toContain('[data-debug-region="…"]');
  expect(appDiagnoseSkill).toContain('Settings > Appearance');
  expect(appDiagnoseSkill).toMatch(/fenced GitHub issue draft/);
  for (const part of [
    'title',
    'steps to reproduce',
    'expected',
    'actual',
    'app version',
    'log lines',
  ])
    expect(appDiagnoseSkill).toContain(part);
});

it.each([
  ['debug', appDebugSkill],
  ['diagnosis', appDiagnoseSkill],
])("has the %s guide open on the debug view and the user's own words", (_, guide) => {
  expect(guide).toContain('from the debug view');
  expect(guide).toContain('do what they ask');
  expect(guide).not.toContain('clicked');
});

it('has the debug guide make a requested change rather than hunt for errors', () => {
  expect(appDebugSkill).not.toContain('Reproduce first');
  expect(appDebugSkill).toContain('When they ask for a change');
  expect(appDebugSkill).toContain('Do not look for unrelated errors');
  expect(appDebugSkill).toContain('## Fix');
});

it('reads the last lines of the daemon log, only the matching ones with grep, none without a log', async () => {
  const f = await workbenchFixture();
  const logs = (input: Record<string, unknown>) =>
    f.call<{ lines: string[] }>('app.logs', input).lines;
  expect(logs({})).toEqual([]);
  const folder = path.join(f.protectionPaths.desktopUserDataDir, 'logs');
  mkdirSync(folder, { recursive: true });
  const written = Array.from({ length: 300 }, (_, n) =>
    n % 3 === 0 ? `${n} error: board failed` : `${n} info: tick`,
  );
  writeFileSync(path.join(folder, 'daemon.log'), `${written.join('\n')}\n`);
  expect(logs({})).toEqual(written.slice(-200));
  expect(logs({ lines: 2 })).toEqual(['298 info: tick', '299 info: tick']);
  expect(logs({ lines: 3, grep: 'error' })).toEqual([
    '291 error: board failed',
    '294 error: board failed',
    '297 error: board failed',
  ]);
  expect(logs({ grep: 'missing' })).toEqual([]);
});
