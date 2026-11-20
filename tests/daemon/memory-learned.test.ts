import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startDaemon } from '@pantheon/daemon';
import { command, USER_PRINCIPAL_ID, type CommandType } from '@pantheon/protocol';

it('serves retraction undo through authenticated HTTP', async () => {
  const root = mkdtempSync(path.resolve('memory-learned-http-'));
  const daemon = await startDaemon({ directory: root, adapters: [], intervalMs: 60000 });
  try {
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const call = async (
      type: CommandType,
      input: Record<string, unknown>,
      revision: number | null = null,
    ) => {
      const response = await fetch(`${daemon.url}/v1/commands`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, revision)),
      });
      expect(response.status).toBe(200);
      return (await response.json()).receipt;
    };
    mkdirSync(path.join(root, 'project'));
    const project = await call('project.open', {
      name: 'Learned memory',
      roots: [path.join(root, 'project')],
    });
    const get = (method: string, params: Record<string, string>) =>
      fetch(
        `${daemon.url}/v1/${method}?${new URLSearchParams({ project_id: project.id, ...params })}`,
        { headers },
      );
    const draft = await call('memory.propose', {
      project_id: project.id,
      key: 'schema',
      kind: 'note',
      text: 'Check migrations',
    });
    const active = await call('memory.commit', { memory_id: draft.id }, draft.revision);
    const archived = await call('memory.archive', { memory_id: active.id }, active.revision);
    expect(archived.archived_ids).toEqual([active.id]);
    expect(
      await call('memory.undo_retraction', { memory_id: active.id }, archived.revision),
    ).toEqual({ restored_ids: [active.id], skipped: [] });
    expect(await (await get('memory.recent', { limit: '1' })).json()).toMatchObject({
      items: [{ kind: 'retraction_undone' }],
    });
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
