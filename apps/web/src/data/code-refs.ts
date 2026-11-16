import type { BridgeResult, GithubItems, SymbolsSearchResult } from '@pantheon/protocol';

export type CodeSymbol = SymbolsSearchResult['symbols'][number];
export type GithubItem = GithubItems['items'][number];

async function query(method: string, params: Record<string, string>) {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    } as const;
  return bridge.query(method, params).catch((reason: unknown): BridgeResult<unknown> => ({
    ok: false,
    error: {
      code: 'ipc_failed',
      message: reason instanceof Error ? reason.message : String(reason),
    },
  }));
}

/** GET /v1/symbols.search: up to 50 code symbols whose names hold q, in the session's worktree if given. */
export async function searchSymbols(
  project_id: string,
  session_id: string | null,
  q: string,
): Promise<BridgeResult<CodeSymbol[]>> {
  const result = await query('symbols.search', {
    project_id,
    ...(session_id ? { session_id } : {}),
    q,
  });
  if (!result.ok) return result;
  const symbols = (result.value as Partial<SymbolsSearchResult> | null)?.symbols;
  if (!Array.isArray(symbols))
    return {
      ok: false,
      error: { code: 'bad_response', message: 'symbols.search result has no symbols' },
    };
  return { ok: true, value: symbols };
}

/** GET /v1/github.items: the project's open pull requests or issues from the local gh. */
export async function listGithubItems(
  project_id: string,
  kind: 'pr' | 'issue',
): Promise<BridgeResult<GithubItem[]>> {
  const result = await query('github.items', { project_id, kind });
  if (!result.ok) return result;
  const items = (result.value as Partial<GithubItems> | null)?.items;
  if (!Array.isArray(items))
    return {
      ok: false,
      error: { code: 'bad_response', message: 'github.items result has no items' },
    };
  return { ok: true, value: items };
}
