import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '@pantheon/domain';

type Row = { source: string; board_name: string; score: number; unit: string };
type Alias = { runtime: string; model: string; effort: string };
// The tests project only typechecks the scripts it lists, so these modules are imported by URL.
const script = (file: string) => import(new URL(`../../scripts/${file}`, import.meta.url).href);
const {
  parseCodeArena,
  parseTerminalBench,
}: { parseCodeArena(pages: string[]): Row[]; parseTerminalBench(html: string): Row[] } =
  await script('leaderboards/parse.mjs');
const {
  refreshLeaderboards,
}: {
  refreshLeaderboards(options: {
    fetchText: (url: string) => Promise<string>;
    previous: unknown;
    now?: () => string;
  }): Promise<{
    fetched_at: string;
    sources: { source: string; ok: boolean; fetched_at: string | null; error?: string }[];
    rows: (Row & { alias: Alias | null })[];
  }>;
} = await script('refresh-leaderboards.mjs');

const fixture = (name: string) =>
  fs.readFileSync(new URL(`../fixtures/leaderboards/${name}`, import.meta.url), 'utf8');
const arenaPage = fixture('code-arena-webdev-rows.json');
const tbenchPage = fixture('tbench-leaderboard.html');
const aliases: Record<string, Alias> = JSON.parse(
  fs.readFileSync(new URL('../../scripts/leaderboards/aliases.json', import.meta.url), 'utf8'),
);
const efforts: Record<EffortLevel, true> = {
  none: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  ultra: true,
};

describe('Code Arena parsing', () => {
  it('keeps only webdev category rows with their rating', () => {
    const rows = parseCodeArena([arenaPage]);
    expect(rows.map((row) => row.board_name)).toEqual([
      'Claude Opus 5.5 (Max)',
      'Claude Sonnet 5.5 (xHigh)',
      'Gemini 4 Carbon (High)',
      'GPT-6 Astra (Max)',
    ]);
    expect(rows[0]).toEqual({
      source: 'code-arena',
      board_name: 'Claude Opus 5.5 (Max)',
      score: 1818.1871919358268,
      unit: 'rating',
    });
    expect(rows[1]?.score).toBeCloseTo(1773.459, 3);
    expect(rows[3]?.score).toBeCloseTo(1766.933, 3);
  });

  it('rejects a response without a rows array', () => {
    expect(() => parseCodeArena(['{"error":"not found"}'])).toThrow(/no rows array/);
  });
});

describe('Terminal-Bench parsing', () => {
  it('reads model, agent, effort and accuracy from the embedded page data', () => {
    const rows = parseTerminalBench(tbenchPage);
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3)).toEqual([
      {
        source: 'terminal-bench',
        board_name: 'Opus 5.5 / Claude Code / max',
        score: 65.76,
        unit: 'accuracy_pct',
      },
      {
        source: 'terminal-bench',
        board_name: 'Sonnet 5.5 / Claude Code / max',
        score: 63.94,
        unit: 'accuracy_pct',
      },
      {
        source: 'terminal-bench',
        board_name: 'GPT-6.1 Sol / Codex / max',
        score: 60.91,
        unit: 'accuracy_pct',
      },
    ]);
  });

  it('throws with a reason when the embedded structure changes', () => {
    expect(() => parseTerminalBench(tbenchPage.replaceAll('\\"rows\\"', '\\"entries\\"'))).toThrow(
      /no object with leaderboard and rows/,
    );
    expect(() => parseTerminalBench(tbenchPage.replaceAll('model_display', 'model_info'))).toThrow(
      /missing model_display/,
    );
    expect(() => parseTerminalBench('<html><body></body></html>')).toThrow(/no self.__next_f/);
  });
});

describe('alias table', () => {
  it('maps every board name to a claude or codex runtime and a known effort level', () => {
    const entries = Object.entries(aliases);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, alias] of entries) {
      expect(['claude', 'codex'], name).toContain(alias.runtime);
      expect(Object.hasOwn(efforts, alias.effort), name).toBe(true);
      expect(alias.model, name).toMatch(/^\S+$/);
    }
  });
});

describe('leaderboard refresh', () => {
  const previous = {
    fetched_at: '2026-11-01T00:00:00.000Z',
    sources: [
      { source: 'code-arena', ok: true, fetched_at: '2026-11-01T00:00:00.000Z' },
      { source: 'terminal-bench', ok: true, fetched_at: '2026-11-01T00:00:01.000Z' },
    ],
    rows: [
      {
        source: 'code-arena',
        board_name: 'Claude Opus 5.5 (Max)',
        score: 1700,
        unit: 'rating',
        alias: null,
      },
      {
        source: 'terminal-bench',
        board_name: 'GPT-6.1 Sol / Codex / max',
        score: 60.91,
        unit: 'accuracy_pct',
        alias: null,
      },
    ],
  };

  it('keeps the previous rows of a failing source and marks it not ok', async () => {
    const next = await refreshLeaderboards({
      previous,
      now: () => '2026-11-09T00:00:00.000Z',
      fetchText: async (url: string) => {
        if (url.startsWith('https://datasets-server.huggingface.co/')) return arenaPage;
        throw new Error(`${url} answered HTTP 503`);
      },
    });
    expect(next.sources).toEqual([
      { source: 'code-arena', ok: true, fetched_at: '2026-11-09T00:00:00.000Z' },
      {
        source: 'terminal-bench',
        ok: false,
        fetched_at: '2026-11-01T00:00:01.000Z',
        error: 'https://www.tbench.ai/leaderboard answered HTTP 503',
      },
    ]);
    expect(next.rows.filter((row) => row.source === 'code-arena')).toHaveLength(4);
    expect(next.rows.find((row) => row.source === 'code-arena')?.score).toBe(1818.1871919358268);
    expect(next.rows.filter((row) => row.source === 'terminal-bench')).toEqual([
      {
        source: 'terminal-bench',
        board_name: 'GPT-6.1 Sol / Codex / max',
        score: 60.91,
        unit: 'accuracy_pct',
        alias: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
      },
    ]);
  });

  it('marks both sources ok and attaches aliases when both load', async () => {
    const next = await refreshLeaderboards({
      previous: undefined,
      fetchText: async (url: string) =>
        url.startsWith('https://datasets-server.huggingface.co/') ? arenaPage : tbenchPage,
    });
    expect(next.sources.map((entry) => entry.ok)).toEqual([true, true]);
    expect(next.rows).toHaveLength(8);
    expect(next.rows.find((row) => row.board_name === 'Gemini 4 Carbon (High)')?.alias).toBeNull();
    expect(
      next.rows.find((row) => row.board_name === 'Opus 5.5 / Claude Code / max')?.alias,
    ).toEqual({ runtime: 'claude', model: 'claude-opus-5-5', effort: 'max' });
  });
});
