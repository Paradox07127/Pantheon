import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceIndex } from '@pantheon/control';
import type { ImportCandidates } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { importCandidates } from '../../packages/control/dist/import-candidates.js';
import { fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function historyFixture() {
  const homes = mkdtempSync(path.join(os.tmpdir(), 'import-candidates-'));
  cleanups.push(() => rmSync(homes, { recursive: true, force: true }));
  const claudeHome = path.join(homes, 'claude'),
    codexHome = path.join(homes, 'codex'),
    dataDir = path.join(homes, 'data');
  const trace = new TraceIndex({
    file: path.join(homes, 'trace-cache.sqlite'),
    claudeHomes: [claudeHome],
    codexHomes: [codexHome],
  });
  cleanups.push(() => trace.close());
  const f = fixture({
    controlOptions: {
      trace,
      protectionPaths: {
        dataDir,
        desktopUserDataDir: path.join(homes, 'desktop'),
        backupDir: path.join(homes, 'backups'),
        home: homes,
        codexHome,
      },
    },
  });
  cleanups.push(() => f.close());
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const touch = (file: string, at: number) => utimesSync(file, new Date(at), new Date(at));
  const write = (file: string, line: unknown, at: number) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    touch(file, at);
    return file;
  };
  const claude = (cwd: string, at: number, id = randomUUID()) =>
    write(
      path.join(claudeHome, 'projects', cwd.replaceAll(path.sep, '-'), `${id}.jsonl`),
      {
        type: 'user',
        sessionId: id,
        cwd,
        timestamp: new Date(at).toISOString(),
        message: { role: 'user', content: 'Check the build' },
      },
      at,
    );
  const codex = (cwd: string, at: number, id = randomUUID()) =>
    write(
      path.join(codexHome, 'sessions/2026/11/01', `rollout-2026-11-01T00-00-00-${id}.jsonl`),
      {
        timestamp: new Date(at).toISOString(),
        type: 'session_meta',
        payload: { id, cwd, cli_version: '0.1.0' },
      },
      at,
    );
  const repo = (dir: string, origin?: string) => {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    if (origin) git(dir, 'remote', 'add', 'origin', origin);
    return dir;
  };
  /** Queries until the index has read every transcript. */
  const indexed = async (query: () => Promise<ImportCandidates>) => {
    let result = await query();
    for (let round = 0; round < 50 && result.indexing !== null; round += 1) result = await query();
    expect(result.indexing).toBeNull();
    return result;
  };
  return { homes, dataDir, f, ctx, now, claude, codex, repo, indexed };
}

describe('import candidates', () => {
  it('keeps a repository inside an outer checkout that has no history of its own', async () => {
    const fx = historyFixture();
    const outer = fx.repo(path.join(fx.homes, 'outer'));
    const gamma = fx.repo(path.join(outer, 'work/gamma'));
    for (let n = 0; n < 3; n += 1) fx.claude(gamma, fx.now - HOUR_MS);

    const result = await fx.indexed(() => importCandidates(fx.ctx, []));
    expect(
      result.candidates.map((candidate) => [
        candidate.root,
        candidate.preselected,
        candidate.excluded ?? null,
      ]),
    ).toEqual([[realpathSync(gamma), true, null]]);
  });

  it('preselects active repositories with enough sessions and says why others are excluded', async () => {
    const fx = historyFixture();
    const real = (dir: string) => realpathSync(dir);
    const alpha = fx.repo(path.join(fx.homes, 'alpha'), 'git@github.com:acme/alpha-app.git');
    mkdirSync(path.join(alpha, 'src'));
    fx.claude(alpha, fx.now - 3 * HOUR_MS);
    fx.claude(alpha, fx.now - 2 * HOUR_MS);
    fx.claude(path.join(alpha, 'src'), fx.now - 2 * HOUR_MS);
    fx.codex(alpha, fx.now - HOUR_MS);
    const beta = fx.repo(
      path.join(fx.homes, 'beta'),
      'https://gitlab.example.com/group/sub/beta.git',
    );
    fx.claude(beta, fx.now - 2 * HOUR_MS);
    const inner = fx.repo(path.join(alpha, 'vendor/inner'));
    for (let n = 0; n < 3; n += 1) fx.claude(inner, fx.now - 3 * HOUR_MS);
    const plain = path.join(fx.homes, 'plain');
    mkdirSync(plain);
    for (let n = 0; n < 3; n += 1) fx.codex(plain, fx.now - 4 * HOUR_MS);
    // The folder holding the open project.
    fx.claude(fx.f.root, fx.now - 5 * HOUR_MS);
    const data = path.join(fx.dataDir, 'sub');
    mkdirSync(data, { recursive: true });
    fx.claude(data, fx.now - 6 * HOUR_MS);
    fx.claude(path.join(fx.homes, 'gone'), fx.now - 7 * HOUR_MS);
    const stale = fx.repo(path.join(fx.homes, 'stale'), 'ssh://git@example.org:2222/team/stale');
    for (let n = 0; n < 3; n += 1) fx.claude(stale, fx.now - 40 * DAY_MS);

    const result = await fx.indexed(() => importCandidates(fx.ctx, []));
    expect(
      result.candidates.map((candidate) => [
        candidate.root,
        candidate.preselected,
        candidate.excluded ?? null,
      ]),
    ).toEqual([
      [real(alpha), true, null],
      [real(beta), false, null],
      [real(inner), false, 'nested_repo'],
      [real(plain), false, null],
      [real(fx.f.root), false, 'nested_project'],
      [real(data), false, 'pantheon_data'],
      [path.join(real(fx.homes), 'gone'), false, 'missing'],
      [real(stale), false, null],
    ]);
    const [first, second] = result.candidates;
    expect(first).toEqual({
      root: real(alpha),
      name: 'alpha-app',
      git: true,
      remote: { host: 'github.com', owner: 'acme', name: 'alpha-app' },
      sessions: 4,
      runtimes: ['claude', 'codex'],
      last_active_at: new Date(fx.now - HOUR_MS).toISOString(),
      preselected: true,
    });
    expect(second).toMatchObject({
      name: 'beta',
      git: true,
      remote: { host: 'gitlab.example.com', owner: 'group/sub', name: 'beta' },
      sessions: 1,
      runtimes: ['claude'],
    });
    const byRoot = new Map(result.candidates.map((candidate) => [candidate.root, candidate]));
    expect(byRoot.get(real(plain))).toMatchObject({
      name: 'plain',
      git: false,
      remote: null,
      sessions: 3,
      runtimes: ['codex'],
    });
    expect(byRoot.get(real(stale))).toMatchObject({
      git: true,
      remote: { host: 'example.org', owner: 'team', name: 'stale' },
      sessions: 3,
      last_active_at: new Date(fx.now - 40 * DAY_MS).toISOString(),
      preselected: false,
    });
  });

  it('excludes folders in temporary directories', async () => {
    const fx = historyFixture();
    const alpha = fx.repo(path.join(fx.homes, 'alpha'), 'git@github.com:acme/alpha.git');
    for (let n = 0; n < 3; n += 1) fx.claude(alpha, fx.now - HOUR_MS);
    const result = await fx.indexed(() => fx.f.control.importCandidates(user));
    expect(result.candidates).toMatchObject([
      { root: realpathSync(alpha), sessions: 3, preselected: false, excluded: 'temporary' },
    ]);
  });

  it('lists the native sessions of a project that are not in Pantheon yet, without those of a repository inside it', async () => {
    const fx = historyFixture();
    const id = randomUUID();
    fx.claude(fx.f.projectRoot, fx.now - HOUR_MS, id);
    const inner = fx.repo(path.join(fx.f.projectRoot, 'inner'), 'git@github.com:acme/inner.git');
    fx.claude(inner, fx.now - HOUR_MS);
    await fx.indexed(() => importCandidates(fx.ctx, []));
    expect(await fx.f.control.importableSessions(user, fx.f.project.id)).toEqual([
      {
        native_session_id: id,
        runtime: 'claude',
        title: 'Check the build',
        cwd: fx.f.projectRoot,
        updated_at: new Date(fx.now - HOUR_MS).toISOString(),
      },
    ]);
    await expect(fx.f.control.importableSessions(user, 'no-such-project')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
