import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { TASK_DOMAINS, TASK_TIERS, type Project, type Retrospective } from '@pantheon/domain';
import type { RoutingCell } from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const codex = { runtime: 'codex', model: 'gpt-fixture', effort: 'high' } as const;
const claude = { runtime: 'claude', model: 'claude-fixture', effort: 'high' } as const;
const arenaHigh = { runtime: 'claude', model: 'claude-web', effort: 'medium' } as const;
const arenaLow = { runtime: 'codex', model: 'gpt-web', effort: 'medium' } as const;

const leaderboards = {
  fetched_at: '2026-11-09T08:00:00.000Z',
  sources: [
    { source: 'code-arena', ok: true, fetched_at: '2026-11-09T08:00:01.000Z' },
    { source: 'terminal-bench', ok: true, fetched_at: '2026-11-09T08:00:02.000Z' },
  ],
  rows: [
    { source: 'code-arena', board_name: 'web high', score: 1300, unit: 'rating', alias: arenaHigh },
    { source: 'code-arena', board_name: 'web low', score: 1200, unit: 'rating', alias: arenaLow },
    {
      source: 'terminal-bench',
      board_name: 'GPT Fixture / Codex / high',
      score: 70,
      unit: 'accuracy_pct',
      alias: codex,
    },
    {
      source: 'terminal-bench',
      board_name: 'Claude Fixture / Claude Code / high',
      score: 30,
      unit: 'accuracy_pct',
      alias: claude,
    },
    {
      source: 'terminal-bench',
      board_name: 'Unmapped Model / Some Agent / high',
      score: 90,
      unit: 'accuracy_pct',
      alias: null,
    },
  ],
};

function setup(withLeaderboards: boolean, runtimes = ['claude', 'codex']) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-routing-'));
  if (withLeaderboards)
    writeFileSync(path.join(configDir, 'leaderboards.json'), JSON.stringify(leaderboards));
  const f = fixture({ controlOptions: { userConfigDir: configDir } });
  for (const name of runtimes) {
    const adapter = new FixtureAdapter();
    adapter.name = name;
    f.control.adapters.set(name, adapter);
  }
  cleanups.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  let rows = 0;
  const retro = (fields: Partial<Retrospective>) => {
    rows++;
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${rows}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${rows}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: rows,
      ...fields,
    });
  };
  const table = () => f.control.routingTable(user, f.project.id);
  const cell = (domain: string, tier: string) =>
    table().cells.find((entry) => entry.domain === domain && entry.tier === tier);
  return { f, retro, table, cell };
}

const pOf = (cell: RoutingCell | undefined, model: string) =>
  cell?.candidates.find((candidate) => candidate.model === model)?.p;

it('gives each candidate its prior mean when there is no local history', () => {
  const { cell } = setup(true);

  const backend = cell('backend-logic', 't1');
  expect(pOf(backend, codex.model)).toBeCloseTo(0.6);
  expect(pOf(backend, claude.model)).toBeCloseTo(0.4);
  expect(backend).toMatchObject({
    first: codex,
    alternate: claude,
    prior: { source: 'terminal-bench', fetched_at: '2026-11-09T08:00:02.000Z' },
  });
  expect(backend!.candidates.find((c) => c.model === codex.model)).toMatchObject({
    n: 0,
    s: 0,
    board: { source: 'terminal-bench', board_name: 'GPT Fixture / Codex / high', score: 70 },
  });

  const winRate = 1 / (1 + 10 ** (-50 / 400));
  const frontend = cell('frontend-ui', 't3');
  expect(pOf(frontend, arenaHigh.model)).toBeCloseTo(0.5 + 0.5 * (winRate - 0.5));
  expect(pOf(frontend, arenaLow.model)).toBeCloseTo(0.5 + 0.5 * (1 - winRate - 0.5));
  expect(frontend?.prior).toEqual({
    source: 'code-arena',
    fetched_at: '2026-11-09T08:00:01.000Z',
  });
});

it('moves the first choice to the candidate that passes its gates locally as its runs grow', () => {
  const { retro, cell } = setup(true);
  expect(cell('backend-logic', 't2')?.first).toEqual(codex);

  const kind = { domain: 'backend-logic', tier: 't2' } as const;
  for (let i = 0; i < 30; i++) {
    retro({
      ...claude,
      measured_kind: kind,
      gate_passed_on_attempt: 1,
      task_usage: { input_tokens: 900, output_tokens: 100 },
    });
    retro({
      ...codex,
      measured_kind: kind,
      gate_passed_on_attempt: i < 10 ? 1 : 2,
      task_usage: { input_tokens: 90, output_tokens: 10 },
    });
  }

  const backend = cell('backend-logic', 't2');
  const base = 40 / 60;
  expect(pOf(backend, claude.model)).toBeCloseTo((30 + 10 * (base - 0.1)) / 40);
  expect(pOf(backend, codex.model)).toBeCloseTo((10 + 10 * (base + 0.1)) / 40);
  expect(backend).toMatchObject({ first: claude, alternate: codex });
  expect(backend!.candidates.find((c) => c.model === codex.model)).toMatchObject({
    n: 30,
    s: 10,
    median_tokens: 100,
  });
});

it('counts a failed task without a gate run among the runs of its candidate unless the user stopped it', () => {
  const { retro, cell } = setup(true);
  const kind = { domain: 'backend-logic', tier: 't2' } as const;
  for (let i = 0; i < 2; i++) retro({ ...codex, measured_kind: kind, gate_passed_on_attempt: 1 });
  retro({ ...codex, planned_kind: kind, outcome: 'failed' });
  retro({ ...codex, planned_kind: kind, outcome: 'failed', stopped_by: 'lead' });
  retro({ ...codex, planned_kind: kind, outcome: 'failed', stopped_by: 'user' });

  expect(
    cell('backend-logic', 't2')!.candidates.find((c) => c.model === codex.model),
  ).toMatchObject({ n: 4, s: 2 });
});

it('picks only candidates on registered runtimes', () => {
  const { cell } = setup(true, ['claude']);
  const backend = cell('backend-logic', 't1');
  expect(backend!.candidates.map((c) => c.runtime)).toEqual(['claude']);
  expect(backend).toMatchObject({ first: claude });
  expect(backend).not.toHaveProperty('alternate');
});

it('picks no candidate on a runtime whose binary was not found', () => {
  const { f, cell } = setup(true);
  const codexAdapter = f.control.adapters.get('codex')!;
  codexAdapter.report = { ...codexAdapter.report, version: 'unprobed' };
  expect(cell('backend-logic', 't1')).toMatchObject({ first: claude });
});

it('returns no cell whose candidates are all on unavailable runtimes', () => {
  const { retro, table } = setup(false, ['claude']);
  retro({
    ...codex,
    planned_kind: { domain: 'docs-chore', tier: 't1' },
    gate_passed_on_attempt: 1,
  });
  expect(table().cells).toEqual([]);
});

it('leaves board rows without an alias out of the candidates', () => {
  const { table } = setup(true);
  const models = table().cells.flatMap((entry) => entry.candidates.map((c) => c.model));
  expect(new Set(models)).toEqual(
    new Set([codex.model, claude.model, arenaHigh.model, arenaLow.model]),
  );
});

it('builds the table from local history alone when there is no leaderboards file', () => {
  const { retro, table } = setup(false);
  const kind = { domain: 'docs-chore', tier: 't1' } as const;
  for (let i = 0; i < 4; i++) retro({ ...claude, planned_kind: kind, gate_passed_on_attempt: 1 });
  retro({ ...codex, planned_kind: kind, gate_failures: ['code'] });

  const cells = table().cells;
  expect(cells).toHaveLength(1);
  const base = 4 / 5;
  expect(cells[0]).toMatchObject({ domain: 'docs-chore', tier: 't1', prior: null });
  expect(pOf(cells[0], claude.model)).toBeCloseTo((4 + 10 * base) / 14);
  expect(pOf(cells[0], codex.model)).toBeCloseTo((10 * base) / 11);
});

function useSingleModel(f: ReturnType<typeof fixture>, on = true) {
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update<Project>(
    'projects',
    {
      ...project,
      session_defaults: {
        runtime: claude.runtime,
        permission_mode: 'ask',
        model: claude.model,
        effort: claude.effort,
        ...(on ? { single_model: true } : {}),
      },
    },
    project.revision,
  );
}

it("gives every cell the project's default runtime, model and effort when it uses one model", () => {
  const { f, retro, table } = setup(true);
  const kind = { domain: 'backend-logic', tier: 't2' } as const;
  for (let i = 0; i < 30; i++) {
    retro({ ...codex, measured_kind: kind, gate_passed_on_attempt: 1 });
    retro({ ...claude, measured_kind: kind, gate_failures: ['code'] });
  }
  useSingleModel(f);

  const cells = table().cells;
  expect(cells.map((cell) => `${cell.domain}:${cell.tier}`)).toEqual(
    TASK_DOMAINS.flatMap((domain) => TASK_TIERS.map((tier) => `${domain}:${tier}`)),
  );
  for (const cell of cells) {
    expect(cell.first).toEqual(claude);
    expect(cell).not.toHaveProperty('alternate');
    expect(cell.prior).toBeNull();
    for (const candidate of cell.candidates)
      expect(candidate).toMatchObject({ runtime: claude.runtime, model: claude.model });
  }
  expect(
    cells.find((cell) => cell.domain === kind.domain && cell.tier === kind.tier)?.candidates,
  ).toMatchObject([{ ...claude, n: 30, s: 0 }]);
});

it('keeps the defaults in every cell when a user choice predates single-model mode', () => {
  const { f, cell } = setup(true);
  const kind = { domain: 'backend-logic', tier: 't2' } as const;
  const project = f.call<Project>(
    'routing.set',
    { project_id: f.project.id, ...kind, slot: 'first', choice: codex },
    f.project.revision,
  );
  f.call(
    'routing.set',
    { project_id: f.project.id, ...kind, slot: 'alternate', choice: arenaLow },
    project.revision,
  );
  useSingleModel(f);
  const pinned = cell(kind.domain, kind.tier)!;
  expect(pinned.first).toEqual(claude);
  expect(pinned).not.toHaveProperty('alternate');
});

it('routes as without one model when the default runtime binary was not found', () => {
  const { f, table } = setup(true);
  const claudeAdapter = f.control.adapters.get('claude')!;
  claudeAdapter.report = { ...claudeAdapter.report, version: 'unprobed' };
  useSingleModel(f, false);
  const without = table();
  useSingleModel(f);
  expect(table()).toEqual(without);
});

it('returns no cell that has neither local history nor a board', () => {
  const { retro, table } = setup(true);
  retro({ ...claude, outcome: 'removed', planned_kind: { domain: 'review', tier: 't1' } });
  retro({ ...claude, planned_kind: { domain: 'docs-chore', tier: 't2' } });

  const domains = new Set(table().cells.map((entry) => entry.domain));
  expect(domains).toEqual(new Set(['frontend-ui', 'backend-logic', 'script-infra']));
});

it('sets and clears user choices independently and returns observed candidate success rates', () => {
  const { f, retro, cell } = setup(true);
  const kind = { domain: 'backend-logic', tier: 't2' } as const;
  retro({ ...codex, measured_kind: kind, gate_passed_on_attempt: 1 });
  retro({ ...codex, measured_kind: kind, gate_passed_on_attempt: 2 });
  const initial = cell(kind.domain, kind.tier)!;
  expect(initial).toMatchObject({ first_source: 'records', alternate_source: 'records' });
  expect(initial.candidates.find((c) => c.model === codex.model)).toMatchObject({
    n: 2,
    s: 1,
    success_rate: 0.5,
  });
  expect(initial.candidates.find((c) => c.model === claude.model)?.success_rate).toBeNull();
  let project = f.call<Project>(
    'routing.set',
    { project_id: f.project.id, ...kind, slot: 'first', choice: claude },
    f.project.revision,
  );
  expect(cell(kind.domain, kind.tier)).toMatchObject({ first: claude, first_source: 'user' });
  project = f.call<Project>(
    'routing.set',
    { project_id: f.project.id, ...kind, slot: 'alternate', choice: codex },
    project.revision,
  );
  expect(cell(kind.domain, kind.tier)).toMatchObject({
    alternate: codex,
    alternate_source: 'user',
  });
  project = f.call<Project>(
    'routing.set',
    { project_id: f.project.id, ...kind, slot: 'first', choice: null },
    project.revision,
  );
  expect(cell(kind.domain, kind.tier)).toMatchObject({
    first: initial.first,
    first_source: 'records',
    alternate_source: 'user',
  });
  f.call(
    'routing.set',
    { project_id: f.project.id, ...kind, slot: 'alternate', choice: null },
    project.revision,
  );
  expect(cell(kind.domain, kind.tier)).toEqual(initial);
});

it('refuses a user routing choice for a cell the table does not contain', () => {
  const { f } = setup(false);
  expect(() =>
    f.call(
      'routing.set',
      {
        project_id: f.project.id,
        domain: 'docs-chore',
        tier: 't2',
        slot: 'first',
        choice: claude,
      },
      f.project.revision,
    ),
  ).toThrowError(expect.objectContaining({ code: 'not_found' }));
});

it('refuses a user routing choice on an unregistered runtime or a model of another family', () => {
  const { f } = setup(true);
  for (const choice of [
    { runtime: 'nosuch', model: codex.model },
    { runtime: 'claude', model: codex.model },
  ])
    expect(() =>
      f.call(
        'routing.set',
        { project_id: f.project.id, domain: 'backend-logic', tier: 't1', slot: 'first', choice },
        f.project.revision,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
});

it('routes past a user choice whose runtime binary was not found', () => {
  const { f, cell } = setup(true);
  f.call(
    'routing.set',
    {
      project_id: f.project.id,
      domain: 'backend-logic',
      tier: 't1',
      slot: 'first',
      choice: claude,
    },
    f.project.revision,
  );
  const claudeAdapter = f.control.adapters.get('claude')!;
  claudeAdapter.report = { ...claudeAdapter.report, version: 'unprobed' };
  expect(cell('backend-logic', 't1')).toMatchObject({ first: codex, first_source: 'records' });
});
