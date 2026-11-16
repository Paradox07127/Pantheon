import { describe, expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';
import {
  addEnvRow,
  addRoots,
  checkEnvironment,
  draftOf,
  environmentSetRequest,
  envRecord,
  envRows,
  openRequest,
  sameEnvironment,
  type EnvironmentDraft,
} from '@/screens/projects/environment';
import { zh } from './i18n-setup.js';

const APP = '/Users/me/app';

const draft = (extra: Partial<EnvironmentDraft> = {}): EnvironmentDraft => ({
  roots: [],
  env: [],
  ...extra,
});

describe('env rows and records', () => {
  it('turns a record into rows and back', () => {
    const env = { API_URL: 'http://localhost', TOKEN: 's3cret' };
    const rows = envRows(env);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['API_URL', 'http://localhost'],
      ['TOKEN', 's3cret'],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(envRecord(rows)).toEqual(env);
  });

  it('starts empty without an environment', () => {
    expect(draftOf({})).toEqual({ roots: [], env: [] });
  });

  it('copies the saved folders and variables', () => {
    const d = draftOf({ roots: ['/Users/me/lib'], env: { A: '1' } });
    expect(d.roots).toEqual(['/Users/me/lib']);
    expect(d.env.map((r) => [r.key, r.value])).toEqual([['A', '1']]);
  });

  it('adds a blank row with a fresh id', () => {
    const rows = addEnvRow(envRows({ A: '1' }));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ key: '', value: '' });
    expect(rows[1]!.id).not.toBe(rows[0]!.id);
  });

  it('leaves out rows with neither key nor value and trims keys', () => {
    expect(
      envRecord([
        { id: 0, key: ' A ', value: '1' },
        { id: 1, key: '', value: '' },
      ]),
    ).toEqual({ A: '1' });
  });
});

describe('addRoots', () => {
  it('appends every chosen folder at once', () => {
    expect(addRoots([APP], ['/Users/me/lib', '/Users/me/docs'])).toEqual({
      roots: [APP, '/Users/me/lib', '/Users/me/docs'],
      rejected: [],
    });
  });

  it.each([
    [
      'skips a folder already listed, trailing separators ignored',
      [`${APP}/`, '/Users/me/lib', '/Users/me/lib'],
      [APP, '/Users/me/lib'],
      [
        { path: `${APP}/`, error: zh('projects.folders.listed') },
        { path: '/Users/me/lib', error: zh('projects.folders.listed') },
      ],
    ],
    [
      'skips a folder inside or around a listed one',
      [`${APP}/src`, '/Users/me', '/Users/me/app2'],
      [APP, '/Users/me/app2'],
      [
        { path: `${APP}/src`, error: zh('projects.folders.insideListed') },
        { path: '/Users/me', error: zh('projects.folders.containsListed') },
      ],
    ],
  ])('%s', (_name, picked, roots, rejected) => {
    expect(addRoots([APP], picked)).toEqual({ roots, rejected });
  });

  it('starts an empty list with the chosen folders', () => {
    expect(addRoots([], [APP])).toEqual({ roots: [APP], rejected: [] });
  });
});

describe('checkEnvironment', () => {
  it('accepts a valid draft', () => {
    const check = checkEnvironment(
      draft({ roots: ['/Users/me/lib'], env: envRows({ _A1: 'x', B: '' }) }),
    );
    expect(check.environment).toEqual({
      roots: ['/Users/me/lib'],
      env: { _A1: 'x', B: '' },
    });
    expect(check.rows).toEqual([null, null]);
    expect(check.roots).toEqual([null]);
  });

  it('rejects a key that is not a variable name', () => {
    const check = checkEnvironment(
      draft({ roots: [APP], env: envRows({ '1A': 'x', 'A-B': 'y' }) }),
    );
    expect(check.environment).toBeNull();
    expect(check.rows.every((e) => e === zh('projects.variables.nameInvalid'))).toBe(true);
  });

  it('rejects a duplicate key on the later row', () => {
    const check = checkEnvironment(
      draft({
        roots: [APP],
        env: [
          { id: 0, key: 'A', value: '1' },
          { id: 1, key: 'A', value: '2' },
        ],
      }),
    );
    expect(check.rows).toEqual([null, zh('projects.variables.nameRepeated')]);
    expect(check.environment).toBeNull();
  });

  it('rejects a value without a key and ignores a blank row', () => {
    const check = checkEnvironment(
      draft({
        roots: [APP],
        env: [
          { id: 0, key: '', value: 'x' },
          { id: 1, key: '', value: '' },
        ],
      }),
    );
    expect(check.rows).toEqual([zh('projects.variables.nameMissing'), null]);
    expect(check.environment).toBeNull();
    expect(
      checkEnvironment(draft({ roots: [APP], env: [{ id: 1, key: '', value: '' }] })).environment,
    ).toEqual({ roots: [APP], env: {} });
  });

  it('needs at least one folder', () => {
    expect(checkEnvironment(draft()).environment).toBeNull();
  });

  it('marks the later of two listed folders that repeat or nest', () => {
    const check = checkEnvironment(draft({ roots: [APP, `${APP}/`, `${APP}/src`, '/Users/me'] }));
    expect(check.roots).toEqual([
      null,
      zh('projects.folders.listed'),
      zh('projects.folders.insideListed'),
      zh('projects.folders.containsListed'),
    ]);
    expect(check.environment).toBeNull();
  });
});

describe('requests', () => {
  it('opens a project with its environment', () => {
    const req = openRequest('app', {
      roots: [APP, '/Users/me/lib'],
      env: { A: '1' },
    });
    expect(req).toEqual({
      type: 'project.open',
      input: { name: 'app', roots: [APP, '/Users/me/lib'], env: { A: '1' } },
      expected_revision: null,
    });
    expect(inputSchemas['project.open'].safeParse(req.input).success).toBe(true);
  });

  it('opens a project without an empty environment', () => {
    const req = openRequest('app', { roots: [APP], env: {} });
    expect(req.input).toEqual({ name: 'app', roots: [APP] });
    expect(inputSchemas['project.open'].safeParse(req.input).success).toBe(true);
  });

  it('replaces the environment at the project revision', () => {
    const req = environmentSetRequest({ id: 'project-a', revision: 7 }, 'app', {
      roots: [APP, '/Users/me/lib'],
      env: {},
    });
    expect(req).toEqual({
      type: 'project.environment.set',
      input: { project_id: 'project-a', name: 'app', roots: [APP, '/Users/me/lib'], env: {} },
      expected_revision: 7,
    });
    expect(inputSchemas['project.environment.set'].safeParse(req.input).success).toBe(true);
  });
});

describe('sameEnvironment', () => {
  const project = { name: 'app', roots: ['/Users/me/lib'], env: { A: '1', B: '2' } };

  it('ignores variable order', () => {
    expect(
      sameEnvironment(project, 'app', {
        roots: ['/Users/me/lib'],
        env: { B: '2', A: '1' },
      }),
    ).toBe(true);
  });

  it('sees a changed name, folder or value', () => {
    const environment = { roots: ['/Users/me/lib'], env: { A: '1', B: '2' } };
    expect(sameEnvironment(project, 'app2', environment)).toBe(false);
    expect(sameEnvironment(project, 'app', { ...environment, roots: [] })).toBe(false);
    expect(sameEnvironment(project, 'app', { ...environment, env: { A: '1', B: '3' } })).toBe(
      false,
    );
  });

  it('treats a missing environment as empty', () => {
    expect(sameEnvironment({ name: 'app' }, 'app', { roots: [], env: {} })).toBe(true);
  });
});
