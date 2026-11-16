// Fetches the public leaderboards used as routing priors and writes them to leaderboards.json.
// Usage: node scripts/refresh-leaderboards.mjs [--out <file>]   (default ~/.pantheon/leaderboards.json;
// exits 1 when a source fails, keeping that source's rows from the previous file)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCodeArena, parseTerminalBench } from './leaderboards/parse.mjs';

const ARENA_ROWS =
  'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=webdev&split=latest';
const ARENA_PAGE = 100;
const TBENCH_PAGE = 'https://www.tbench.ai/leaderboard';
const ALIASES = JSON.parse(
  fs.readFileSync(new URL('./leaderboards/aliases.json', import.meta.url), 'utf8'),
);

const sources = [
  {
    source: 'code-arena',
    load: async (fetchText) => {
      const pages = [];
      for (let offset = 0; ; offset += ARENA_PAGE) {
        const page = await fetchText(`${ARENA_ROWS}&offset=${offset}&length=${ARENA_PAGE}`);
        pages.push(page);
        const total = JSON.parse(page).num_rows_total;
        if (typeof total !== 'number') throw new Error('Code Arena response has no num_rows_total');
        if (offset + ARENA_PAGE >= total) break;
      }
      return parseCodeArena(pages);
    },
  },
  {
    source: 'terminal-bench',
    load: async (fetchText) => parseTerminalBench(await fetchText(TBENCH_PAGE)),
  },
];

/** @param {string} url */
export async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.text();
}

/**
 * Loads every source; a source that fails keeps its rows and last success time from `previous`.
 * @param {{
 *   fetchText: (url: string) => Promise<string>,
 *   previous?: any,
 *   aliases?: Record<string, { runtime: string, model: string, effort: string }>,
 *   now?: () => string,
 * }} options
 */
export async function refreshLeaderboards({
  fetchText,
  previous,
  aliases = ALIASES,
  now = () => new Date().toISOString(),
}) {
  const fetched_at = now();
  const status = [];
  const rows = [];
  for (const { source, load } of sources) {
    try {
      rows.push(...(await load(fetchText)));
      status.push({ source, ok: true, fetched_at: now() });
    } catch (error) {
      const last = previous?.sources?.find((entry) => entry.source === source);
      status.push({
        source,
        ok: false,
        fetched_at: last?.fetched_at ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const row of previous?.rows ?? [])
        if (row.source === source)
          rows.push({
            source,
            board_name: row.board_name,
            score: row.score,
            unit: row.unit,
          });
    }
  }
  return {
    fetched_at,
    sources: status,
    rows: rows.map((row) => ({
      ...row,
      alias: Object.hasOwn(aliases, row.board_name) ? aliases[row.board_name] : null,
    })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  if (at >= 0 && !args[at + 1]) throw new Error('--out needs a file path');
  const out = path.resolve(
    at >= 0 ? args[at + 1] : path.join(os.homedir(), '.pantheon', 'leaderboards.json'),
  );
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const next = await refreshLeaderboards({ fetchText, previous });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
  for (const entry of next.sources) {
    const count = next.rows.filter((row) => row.source === entry.source).length;
    const aliased = next.rows.filter((row) => row.source === entry.source && row.alias).length;
    console.log(
      entry.ok
        ? `${entry.source}: ${count} rows, ${aliased} with an alias`
        : `${entry.source}: failed (${entry.error}); kept ${count} rows from the previous file`,
    );
  }
  console.log(`wrote ${out}`);
  if (next.sources.some((entry) => !entry.ok)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
