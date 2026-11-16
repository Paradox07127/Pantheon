import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  requireThat,
  TASK_DOMAINS,
  TASK_TIERS,
  type EffortLevel,
  type Principal,
  type Project,
  type TaskKind,
} from '@pantheon/domain';
import {
  EFFORT_LEVELS,
  inputSchemas,
  type RoutingCandidate,
  type RoutingCell,
  type RoutingTable,
} from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { candidateKey, median, routingStats, type RoutingCellStats } from './routing-stats.js';
import { homeRuntime, readUserConfig, sessionDefaults } from './user-config.js';

// Score of a candidate (runtime, model, effort) in a cell (domain, tier), in four steps:
// 1. Board level L in [0, 1]: a pass-rate board as is; a rating board as the Elo win rate against the median candidate.
// 2. Prior mean m0 = clip(b + γ·(L − L_median)); b is the local gate pass rate of the cell, else its domain, else all.
// 3. Posterior p = (s + k·m0) / (n + k), from n gated tasks of which s passed the gate on the first attempt.
// 4. Among candidates within ε of the best p, the one with the lowest median token cost wins.
/** Tasks the prior counts as (k), step 3. */
const PRIOR_TASKS = 10;
/** Discount on a board score's lead over the candidates' median (γ), step 2. */
const BOARD_DISCOUNT = 0.5;
/** Candidates this close to the best posterior compete on token cost (ε), step 4. */
const TIE_MARGIN = 0.05;
/** The clip of the prior mean, step 2. */
const PRIOR_MIN = 0.02,
  PRIOR_MAX = 0.98;
/** Elo convention for turning a rating gap into an expected win rate, step 1. */
const ELO_SCALE = 400,
  ELO_BASE = 10;
/** Local runs a cell, then its domain, needs before its own pass rate is the base, step 2. */
const BASE_RUNS = 20;

const BOARD_OF: Partial<Record<TaskKind['domain'], string>> = {
  'frontend-ui': 'code-arena',
  'backend-logic': 'terminal-bench',
  'script-infra': 'terminal-bench',
};

interface Alias {
  runtime: string;
  model: string;
  effort: EffortLevel;
}
interface BoardRow {
  source: string;
  board_name: string;
  score: number;
  /** A Bradley-Terry rating, or a pass rate in percent. */
  unit: 'rating' | 'accuracy_pct';
  alias: Alias | null;
}
interface Leaderboards {
  fetched_at: string;
  sources: { source: string; fetched_at: string | null }[];
  rows: BoardRow[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAlias = (value: unknown): value is Alias =>
  isRecord(value) &&
  typeof value.runtime === 'string' &&
  typeof value.model === 'string' &&
  (EFFORT_LEVELS as readonly unknown[]).includes(value.effort);

const isLeaderboards = (value: unknown): value is Leaderboards =>
  isRecord(value) &&
  typeof value.fetched_at === 'string' &&
  Array.isArray(value.sources) &&
  value.sources.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.source === 'string' &&
      (entry.fetched_at === null || typeof entry.fetched_at === 'string'),
  ) &&
  Array.isArray(value.rows) &&
  value.rows.every(
    (row) =>
      isRecord(row) &&
      typeof row.source === 'string' &&
      typeof row.board_name === 'string' &&
      typeof row.score === 'number' &&
      (row.unit === 'rating' || row.unit === 'accuracy_pct') &&
      (row.alias === null || isAlias(row.alias)),
  );

/** `<dir>/leaderboards.json`; no directory, no file or a file of another shape is no prior. */
function readLeaderboards(dir: string | undefined): Leaderboards | undefined {
  if (!dir) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(dir, 'leaderboards.json'), 'utf8'));
    return isLeaderboards(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

interface BoardEntry {
  alias: Alias;
  row: BoardRow;
  /** The score as a 0 to 1 level, step 1. */
  level: number;
}

/** The aliased rows of one board by candidate, the best score where several name one candidate. */
function boardEntries(boards: Leaderboards, source: string): Map<string, BoardEntry> {
  const best = new Map<string, BoardRow & { alias: Alias }>();
  for (const row of boards.rows) {
    if (row.source !== source || !row.alias) continue;
    const key = candidateKey(row.alias),
      held = best.get(key);
    if (!held || row.score > held.score) best.set(key, row as BoardRow & { alias: Alias });
  }
  const ratingMedian =
    median([...best.values()].filter((row) => row.unit === 'rating').map((row) => row.score)) ?? 0;
  return new Map(
    [...best].map(([key, row]) => [
      key,
      {
        alias: row.alias,
        row,
        level:
          row.unit === 'rating'
            ? 1 / (1 + ELO_BASE ** ((ratingMedian - row.score) / ELO_SCALE))
            : row.score / 100,
      },
    ]),
  );
}

function runs(cells: RoutingCellStats[]): { n: number; s: number } {
  let n = 0,
    s = 0;
  for (const cell of cells)
    for (const candidate of cell.candidates) {
      n += candidate.n;
      s += candidate.s;
    }
  return { n, s };
}

/** The local pass rate b_c of the cell, else of its domain, else of all cells, else one half. */
function basePassRate(stats: RoutingCellStats[], domain: string, tier: string): number {
  const cell = runs(stats.filter((entry) => entry.domain === domain && entry.tier === tier));
  if (cell.n >= BASE_RUNS) return cell.s / cell.n;
  const ofDomain = runs(stats.filter((entry) => entry.domain === domain));
  if (ofDomain.n >= BASE_RUNS) return ofDomain.s / ofDomain.n;
  const all = runs(stats);
  return all.n ? all.s / all.n : 0.5;
}

const choice = ({ runtime, model, effort }: RoutingCandidate) => ({
  runtime,
  model,
  ...(effort ? { effort } : {}),
});

/** Each (domain, tier) cell with candidates on installed runtimes, their posterior pass rates and its two picks. */
export function routingTable(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): RoutingTable {
  projectAccess(ctx, principal, projectId, 'routing.table');
  return projectRoutingTable(ctx, projectId);
}

/** The routing table without an access check, for the daemon's own checks. */
export function projectRoutingTable(ctx: ControlContext, projectId: string): RoutingTable {
  const project = ctx.store.must<Project>('projects', projectId),
    defaults = sessionDefaults(ctx, project);
  const stats = routingStats(ctx, projectId),
    boards = readLeaderboards(ctx.userConfigDir);
  // An adapter whose binary was not found at startup is still registered, as version 'unprobed'.
  const available = (name: string) => {
    const adapter = ctx.adapters.get(name);
    return adapter !== undefined && adapter.report.version !== 'unprobed';
  };
  const single =
    defaults?.single_model && defaults.model !== undefined && available(defaults.runtime)
      ? {
          runtime: defaults.runtime,
          model: defaults.model,
          ...(defaults.effort ? { effort: defaults.effort } : {}),
        }
      : undefined;
  const cells: RoutingCell[] = [];
  for (const domain of TASK_DOMAINS) {
    const source = BOARD_OF[domain],
      board = boards && source ? boardEntries(boards, source) : new Map<string, BoardEntry>();
    const levelMedian = median([...board.values()].map((entry) => entry.level)) ?? 0;
    for (const tier of TASK_TIERS) {
      const local = new Map(
        (
          stats.find((entry) => entry.domain === domain && entry.tier === tier)?.candidates ?? []
        ).map((candidate) => [candidateKey(candidate), candidate]),
      );
      const keys = new Set([...local.keys(), ...board.keys()]);
      const override = project.routing_overrides?.[domain]?.[tier];
      if (!keys.size && !single && !override) continue;
      const base = basePassRate(stats, domain, tier);
      const scored: RoutingCandidate[] = [...keys].map((key) => {
        const ran = local.get(key),
          listed = board.get(key);
        const n = ran?.n ?? 0,
          s = ran?.s ?? 0;
        const prior = Math.min(
          PRIOR_MAX,
          Math.max(
            PRIOR_MIN,
            base + BOARD_DISCOUNT * ((listed?.level ?? levelMedian) - levelMedian),
          ),
        );
        const { runtime, model, effort } = ran ?? listed!.alias;
        return {
          runtime,
          model,
          ...(effort ? { effort } : {}),
          p: (s + PRIOR_TASKS * prior) / (n + PRIOR_TASKS),
          n,
          s,
          success_rate: n ? s / n : null,
          ...(ran?.median_tokens !== undefined ? { median_tokens: ran.median_tokens } : {}),
          ...(listed
            ? {
                board: {
                  source: listed.row.source,
                  board_name: listed.row.board_name,
                  score: listed.row.score,
                },
              }
            : {}),
        };
      });
      const candidates = scored.filter((candidate) => available(candidate.runtime));
      if (single) {
        cells.push({
          domain,
          tier,
          first: single,
          first_source: 'user',
          candidates: candidates.filter(
            (candidate) => candidate.runtime === single.runtime && candidate.model === single.model,
          ),
          prior: null,
        });
        continue;
      }
      if (!candidates.length) {
        if (override) cells.push({ domain, tier, candidates, prior: null });
        continue;
      }
      candidates.sort((a, b) => b.p - a.p);
      const best = candidates[0]!.p;
      // Without local token data a candidate ranks after every candidate with it.
      const first = candidates
        .filter((candidate) => candidate.p >= best - TIE_MARGIN)
        .sort(
          (a, b) => (a.median_tokens ?? Infinity) - (b.median_tokens ?? Infinity) || b.p - a.p,
        )[0]!;
      const alternate = candidates.find(
        (candidate) => candidate !== first && candidate.runtime !== first.runtime,
      );
      const fetchedAt =
        boards?.sources.find((entry) => entry.source === source)?.fetched_at ?? boards?.fetched_at;
      cells.push({
        domain,
        tier,
        first: choice(first),
        first_source: 'records',
        ...(alternate
          ? { alternate: choice(alternate), alternate_source: 'records' as const }
          : {}),
        candidates,
        prior:
          source && fetchedAt && candidates.some((candidate) => candidate.board)
            ? { source, fetched_at: fetchedAt }
            : null,
      });
    }
  }
  // A project on one model keeps its defaults over user choices it had before.
  for (const cell of single ? [] : cells) {
    const override = project.routing_overrides?.[cell.domain]?.[cell.tier];
    for (const slot of ['first', 'alternate'] as const) {
      if (!override?.[slot] || !available(override[slot].runtime)) continue;
      cell[slot] = override[slot];
      cell[`${slot}_source`] = 'user';
    }
  }
  return { cells };
}

export const routingHandlers: Handlers = {
  'routing.set': (ctx, p, c) => {
    userOnly(p);
    const { project_id, domain, tier, slot, choice } = c.input as ReturnType<
      (typeof inputSchemas)['routing.set']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    requireThat(
      projectRoutingTable(ctx, project_id).cells.some(
        (cell) => cell.domain === domain && cell.tier === tier,
      ),
      'not_found',
      `No routing cell for ${domain} ${tier}`,
    );
    if (choice) {
      requireThat(
        ctx.adapters.has(choice.runtime),
        'invalid_input',
        'Routing runtime is not available',
      );
      requireThat(
        homeRuntime(choice.model, readUserConfig(ctx.userConfigDir).model_families) ===
          choice.runtime,
        'invalid_input',
        `Routing model ${choice.model} does not belong to ${choice.runtime}`,
      );
    }
    const routing_overrides: NonNullable<Project['routing_overrides']> = structuredClone(
      project.routing_overrides ?? {},
    );
    const tiers = (routing_overrides[domain] ??= {}),
      cell = (tiers[tier] ??= {});
    if (choice === null) delete cell[slot];
    else cell[slot] = choice;
    if (!Object.keys(cell).length) delete tiers[tier];
    if (!Object.keys(tiers).length) delete routing_overrides[domain];
    const { routing_overrides: _, ...rest } = project;
    const next = ctx.store.update(
      'projects',
      Object.keys(routing_overrides).length ? { ...rest, routing_overrides } : rest,
      project.revision,
    );
    ctx.store.event(
      'project.routing_set',
      next,
      project_id,
      { domain, tier, slot, choice },
      c.command_id,
    );
    return next;
  },
};
