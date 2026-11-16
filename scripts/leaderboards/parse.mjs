// Turns raw leaderboard responses into rows of { source, board_name, score, unit }.

/**
 * Rows of the `webdev` category from pages of the Hugging Face datasets-server `/rows` response
 * for `lmarena-ai/leaderboard-dataset`, config `webdev`.
 * @param {string[]} pages raw JSON bodies
 * @returns {{ source: string, board_name: string, score: number, unit: string }[]}
 */
export function parseCodeArena(pages) {
  const rows = [];
  for (const page of pages) {
    const body = JSON.parse(page);
    if (!Array.isArray(body?.rows)) throw new Error('Code Arena response has no rows array');
    for (const { row } of body.rows) {
      if (typeof row?.category !== 'string')
        throw new Error('Code Arena row has no category field');
      if (row.category !== 'webdev') continue;
      if (typeof row.model_name !== 'string' || typeof row.rating !== 'number')
        throw new Error('Code Arena webdev row is missing model_name or a numeric rating');
      rows.push({
        source: 'code-arena',
        board_name: row.model_name,
        score: row.rating,
        unit: 'rating',
      });
    }
  }
  if (rows.length === 0) throw new Error('Code Arena response has no webdev category rows');
  return rows;
}

/**
 * Rows from the leaderboard data that tbench.ai embeds in its page as Next.js flight chunks
 * (`self.__next_f.push([1, "..."])`). The board name joins model, agent and reasoning effort.
 * @param {string} html
 * @returns {{ source: string, board_name: string, score: number, unit: string }[]}
 */
export function parseTerminalBench(html) {
  const flight = [...html.matchAll(/<script>self\.__next_f\.push\((.*?)\)<\/script>/gs)]
    .map((m) => JSON.parse(m[1]))
    .filter((chunk) => chunk[0] === 1 && typeof chunk[1] === 'string')
    .map((chunk) => chunk[1])
    .join('');
  if (!flight) throw new Error('Terminal-Bench page has no self.__next_f flight chunks');
  let board;
  for (const line of flight.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0 || !line.slice(colon + 1).startsWith('[')) continue;
    let value;
    try {
      value = JSON.parse(line.slice(colon + 1));
    } catch {
      continue;
    }
    board = findBoard(value);
    if (board) break;
  }
  if (!board) throw new Error('Terminal-Bench page has no object with leaderboard and rows');
  if (board.rows.length === 0) throw new Error('Terminal-Bench leaderboard has no rows');
  return board.rows.map((row) => {
    const model = row?.metadata?.model_display?.label;
    const agent = row?.metadata?.agent_display?.label;
    const effort = row?.metadata?.reasoning_effort;
    const accuracy = row?.metrics?.accuracy;
    if (
      typeof model !== 'string' ||
      typeof agent !== 'string' ||
      typeof effort !== 'string' ||
      typeof accuracy !== 'number'
    )
      throw new Error(
        'Terminal-Bench row is missing model_display, agent_display, reasoning_effort or accuracy',
      );
    return {
      source: 'terminal-bench',
      board_name: `${model} / ${agent} / ${effort}`,
      score: accuracy,
      unit: 'accuracy_pct',
    };
  });
}

const findBoard = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  if (
    !Array.isArray(value) &&
    typeof value.leaderboard?.title === 'string' &&
    value.leaderboard.title.startsWith('Terminal-Bench') &&
    Array.isArray(value.rows)
  )
    return value;
  for (const child of Object.values(value)) {
    const found = findBoard(child);
    if (found) return found;
  }
  return undefined;
};
