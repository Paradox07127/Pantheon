import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Project, ProjectRead, Session } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function defaultsFixture(managedWorkspaces = false) {
  const configRoot = mkdtempSync(path.join(os.tmpdir(), 'pantheon-defaults-config-'));
  cleanups.push(async () => rmSync(configRoot, { recursive: true, force: true }));
  mkdirSync(path.join(configRoot, '.pantheon'));
  writeFileSync(
    path.join(configRoot, '.pantheon/config.json'),
    JSON.stringify({ version: 1, model_families: { 'fixture-': 'fixture' } }),
  );
  const f = fixture({
    managedWorkspaces,
    controlOptions: { userConfigDir: path.join(configRoot, '.pantheon') },
  });
  cleanups.push(f.close);
  const current = () => f.store.must<Project>('projects', f.project.id);
  const events = () =>
    f.store.db
      .prepare(
        "SELECT payload FROM events WHERE kind='project.session_defaults_set' ORDER BY sequence",
      )
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as unknown);
  return { ...f, current, events };
}

it('stores the default runtime and permission mode on the project at its revision', () => {
  const f = defaultsFixture(),
    before = f.current();
  const next = f.call<Project>(
    'project.sessionDefaults.set',
    { project_id: before.id, runtime: 'fixture', permission_mode: 'plan' },
    before.revision,
  );
  expect(next).toMatchObject({
    session_defaults: { runtime: 'fixture', permission_mode: 'plan' },
    revision: before.revision + 1,
  });
  expect(f.current()).toEqual(next);
  expect(f.events()).toEqual([{ runtime: 'fixture', permission_mode: 'plan' }]);
  expect(() =>
    f.call(
      'project.sessionDefaults.set',
      { project_id: before.id, runtime: 'fixture', permission_mode: 'ask' },
      before.revision,
    ),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
});

it('refuses an unknown runtime, an unknown permission mode and a non-user principal', () => {
  const f = defaultsFixture(),
    before = f.current();
  expect(() =>
    f.call(
      'project.sessionDefaults.set',
      { project_id: before.id, runtime: 'unknown-runtime', permission_mode: 'ask' },
      before.revision,
    ),
  ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  expect(() =>
    f.call(
      'project.sessionDefaults.set',
      { project_id: before.id, runtime: 'fixture', permission_mode: 'always' },
      before.revision,
    ),
  ).toThrow();
  expect(() =>
    f.call(
      'project.sessionDefaults.set',
      { project_id: before.id, runtime: 'fixture', permission_mode: 'ask' },
      before.revision,
      { id: 'agent', role: 'planner' },
    ),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  const schema = inputSchemas['project.sessionDefaults.set'];
  expect(
    schema.safeParse({ project_id: 'p', runtime: 'claude', permission_mode: 'ask', extra: 1 })
      .success,
  ).toBe(false);
  expect(f.current()).toEqual(before);
  expect(f.events()).toEqual([]);
});

it('stores a default model and effort that belong to the default runtime', () => {
  const f = defaultsFixture(),
    before = f.current();
  const defaults = {
    runtime: 'fixture',
    permission_mode: 'auto_edit',
    model: 'fixture-large',
    effort: 'high',
  } as const;
  const next = f.call<Project>(
    'project.sessionDefaults.set',
    { project_id: before.id, ...defaults },
    before.revision,
  );
  expect(next.session_defaults).toEqual(defaults);
  expect(f.events()).toEqual([defaults]);
  for (const model of ['claude-opus-4-1', 'unfamiliar-model'])
    expect(() =>
      f.call(
        'project.sessionDefaults.set',
        { project_id: before.id, runtime: 'fixture', permission_mode: 'ask', model },
        next.revision,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  expect(f.current()).toEqual(next);
  expect(f.events()).toEqual([defaults]);
});

it('stores single_model only with a default model and drops it when turned off', () => {
  const f = defaultsFixture(),
    before = f.current();
  const base = { project_id: before.id, runtime: 'fixture', permission_mode: 'ask' } as const;
  const refused = (() => {
    try {
      f.call('project.sessionDefaults.set', { ...base, single_model: true }, before.revision);
    } catch (error) {
      return error as { code?: string; message?: string };
    }
  })();
  expect(refused?.code).toBe('invalid_input');
  expect(refused?.message).toContain('model');
  expect(f.current()).toEqual(before);

  const on = f.call<Project>(
    'project.sessionDefaults.set',
    { ...base, model: 'fixture-large', effort: 'high', single_model: true },
    before.revision,
  );
  expect(on.session_defaults).toEqual({
    runtime: 'fixture',
    permission_mode: 'ask',
    model: 'fixture-large',
    effort: 'high',
    single_model: true,
  });
  const off = f.call<Project>(
    'project.sessionDefaults.set',
    { ...base, model: 'fixture-large', single_model: false },
    on.revision,
  );
  expect(off.session_defaults).toEqual({
    runtime: 'fixture',
    permission_mode: 'ask',
    model: 'fixture-large',
  });
  expect(f.current().session_defaults).not.toHaveProperty('single_model');
});

it('opens the lead session of a board sync on the default model and effort', () => {
  const f = defaultsFixture(true),
    before = f.current();
  f.call(
    'project.sessionDefaults.set',
    {
      project_id: before.id,
      runtime: 'fixture',
      permission_mode: 'plan',
      model: 'fixture-large',
      effort: 'low',
    },
    before.revision,
  );
  const { session_ids } = f.call<{ session_ids: string[] }>('board.sync', {
    project_id: before.id,
  });
  expect(session_ids).toHaveLength(1);
  expect(f.store.must<Session>('sessions', session_ids[0]!)).toMatchObject({
    runtime: 'fixture',
    requested_model: 'fixture-large',
    requested_effort: 'low',
  });
});

it('removes project defaults and opens a new session with composer values afterward', () => {
  const f = defaultsFixture(true);
  const stored = f.call<Project>(
    'project.sessionDefaults.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      model: 'fixture-large',
      effort: 'high',
      permission_mode: 'plan',
    },
    f.project.revision,
  );
  expect(
    (f.control.projectRead(user, f.project.id) as ProjectRead).project.session_defaults,
  ).toEqual(stored.session_defaults);
  expect(() =>
    f.call('project.sessionDefaults.clear', { project_id: f.project.id }, f.project.revision),
  ).toThrowError(expect.objectContaining({ code: 'revision_conflict' }));
  expect(() =>
    f.call('project.sessionDefaults.clear', { project_id: f.project.id }, stored.revision, {
      id: 'agent',
      role: 'planner',
    }),
  ).toThrowError(expect.objectContaining({ code: 'permission_denied' }));
  f.call('project.sessionDefaults.clear', { project_id: f.project.id }, stored.revision);
  expect((f.control.projectRead(user, f.project.id) as ProjectRead).project).not.toHaveProperty(
    'session_defaults',
  );
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: 'fixture',
    input: 'Read the project',
  });
  expect(session.runtime).toBe('fixture');
  expect(session.permission_mode).toBe('ask');
  expect(session.requested_model).toBeUndefined();
  expect(session.requested_effort).toBeUndefined();
});

it('stores writer and reviewer choices and a fallback for each role', () => {
  const f = defaultsFixture();
  const choice = { runtime: 'fixture', model: 'fixture-small', effort: 'low' } as const;
  const fallbacks = { lead: choice, writer: choice, reviewer: choice };
  const next = f.call<Project>(
    'project.sessionDefaults.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      permission_mode: 'ask',
      writer: choice,
      reviewer: choice,
      fallbacks,
    },
    f.project.revision,
  );
  expect(next.session_defaults).toMatchObject({ writer: choice, reviewer: choice, fallbacks });
  expect(
    (f.control.projectRead(user, f.project.id) as ProjectRead).project.session_defaults,
  ).toEqual(next.session_defaults);
});

it('sets, returns and clears runtime token targets without changing other targets', () => {
  const f = defaultsFixture();
  let project = f.call<Project>(
    'project.usageTargets.set',
    { project_id: f.project.id, targets: { claude: 10000, codex: 0 } },
    f.project.revision,
  );
  expect((f.control.projectRead(user, f.project.id) as ProjectRead).project.usage_targets).toEqual({
    claude: 10000,
    codex: 0,
  });
  project = f.call<Project>(
    'project.usageTargets.set',
    { project_id: f.project.id, targets: { claude: null } },
    project.revision,
  );
  expect(project.usage_targets).toEqual({ codex: 0 });
  project = f.call<Project>(
    'project.usageTargets.set',
    { project_id: f.project.id, targets: { codex: null } },
    project.revision,
  );
  expect(project).not.toHaveProperty('usage_targets');
});

it('opens a main session on its fallback when the default runtime fails admission', () => {
  const f = defaultsFixture(true);
  const backup = new FixtureAdapter();
  backup.name = 'claude';
  f.control.adapters.set(backup.name, backup);
  f.call(
    'project.sessionDefaults.set',
    {
      project_id: f.project.id,
      runtime: 'fixture',
      permission_mode: 'ask',
      model: 'fixture-large',
      fallbacks: { lead: { runtime: 'claude', model: 'claude-fixture', effort: 'low' } },
    },
    f.project.revision,
  );
  f.control.adapters.delete('fixture');
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    input: 'Read the project',
  });
  expect(session).toMatchObject({
    runtime: 'claude',
    requested_model: 'claude-fixture',
    requested_effort: 'low',
  });
});
