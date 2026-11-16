import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startDaemon } from '@pantheon/daemon';
import type { Session } from '@pantheon/domain';
import { eventually } from '../helpers.js';

it('serves authenticated session search over HTTP and validates query parameters', async () => {
  const root = mkdtempSync(path.resolve('search-http-'));
  const daemon = await startDaemon({ directory: root, adapters: [], intervalMs: 60000 });
  try {
    daemon.store.insert<Session>('sessions', {
      id: 'search-session',
      revision: 1,
      project_id: 'project',
      title: 'Searchable session',
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const get = (params: string) => fetch(`${daemon.url}/v1/session.search?${params}`, { headers });
    await eventually(
      () =>
        daemon.control.sessionSearch(
          { id: 'user', role: 'user' },
          { text: 'searchable', limit: 20 },
        ).indexing_complete,
    );
    const response = await get('text=SEARCHABLE');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      indexing_complete: true,
      hits: [{ session_id: 'search-session', project_id: 'project', kind: 'title' }],
    });
    const filtered = await get('text=SEARCHABLE&project_id=other');
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({ hits: [] });
    for (const params of ['', 'text=query&limit=51', 'text=query&extra=1'])
      expect((await get(params)).status).toBe(400);
    expect((await fetch(`${daemon.url}/v1/session.search?text=query`)).status).toBe(403);
    expect(() =>
      daemon.control.sessionSearch({ id: 'agent', role: 'worker' }, { text: 'query', limit: 20 }),
    ).toThrow('Authenticated user required');
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
