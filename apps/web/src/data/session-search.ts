import type { BridgeResult, DesktopBridge, SessionSearchResult } from '@pantheon/protocol';

export type { SessionSearchResult };

const LIMIT = '8';

/** GET /v1/session.search over every project, archived sessions included. */
export async function searchSessions(
  bridge: Pick<DesktopBridge, 'query'> | undefined,
  text: string,
): Promise<BridgeResult<SessionSearchResult>> {
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .query('session.search', { text, limit: LIMIT })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return result;
  const value = result.value as Partial<SessionSearchResult> | null;
  if (!value || !Array.isArray(value.hits))
    return {
      ok: false,
      error: { code: 'bad_response', message: 'session.search result has no hits' },
    };
  return { ok: true, value: value as SessionSearchResult };
}
