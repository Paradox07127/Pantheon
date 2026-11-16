import { expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import { completionSkills, loadState, readInventory, savedOverrides } from '@/data/extensions';
import { splitPath } from '@/data/format';
import { readEventHistory } from '@/data/logs';
import { findProjectByRoots } from '@/data/projects';
import { composeState } from '@/data/transcript';
import type { DaemonEvent } from '@/data/sync';

const session = { id: 'session', state: 'open' } as Session;
const event = (
  sequence: number,
  kind: string,
  payload: object = {},
  aggregate_id = session.id,
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'project',
  causation_id: '',
  created_at: sequence * 100,
  payload,
});

it('locks a skill while its parent plugin is disabled', () => {
  const inventory = {
    runtime: 'codex',
    mcp_servers: [],
    plugins: [{ id: 'plugin', enabled: true }],
    skills: [{ id: 'skill', name: 'skill', enabled: true, plugin: 'plugin' }],
    apps: true,
    connectors: [],
    hooks: [],
  };
  expect(
    loadState(inventory, { ...savedOverrides({}, 'codex'), disabled_plugins: ['plugin'] }).skills[0]
      ?.lock,
  ).toEqual({ reason: 'plugin', plugin: 'plugin' });
});

it('leaves the skills of a disabled plugin out of completion', () => {
  const inventory = {
    runtime: 'codex',
    mcp_servers: [],
    plugins: [
      { id: 'closed-here', enabled: true },
      { id: 'off-on-machine', enabled: false },
      { id: 'open', enabled: true },
    ],
    skills: [
      { id: 'a', name: 'a', enabled: true, plugin: 'closed-here' },
      { id: 'b', name: 'b', enabled: true, plugin: 'off-on-machine' },
      { id: 'c', name: 'c', enabled: true, plugin: 'open' },
      { id: 'd', name: 'd', enabled: true },
      { id: 'e', name: 'e', enabled: true },
    ],
    apps: true,
    connectors: [],
    hooks: [],
  };
  const overrides = {
    ...savedOverrides({}, 'codex'),
    disabled_plugins: ['closed-here'],
    disabled_skills: ['e'],
  };
  expect(completionSkills(inventory, overrides).map((s) => s.id)).toEqual(['c', 'd']);
});

it('rejects inventory with no boolean apps state', async () => {
  const result = await readInventory(
    {
      query: async () => ({
        ok: true,
        value: { runtime: 'codex', mcp_servers: [], plugins: [], skills: [], hooks: [] },
      }),
    },
    'project',
    'codex',
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'bad_response' } });
});

it('preserves significant whitespace in project roots', () => {
  const projects = [{ roots: ['/work/name'] }];
  expect(findProjectByRoots(projects, ['/work/name '])).toBeNull();
});

it('splits backslash paths at the last two segments', () => {
  expect(splitPath('C:\\work\\project\\file.txt')).toEqual(['C:\\work', '\\project\\file.txt']);
});

it('restarts event history when the daemon requires a replacement snapshot', async () => {
  const afters: string[] = [];
  const result = await readEventHistory(
    {
      query: async (_method, params) => {
        afters.push(params!.after as string);
        return {
          ok: true,
          value:
            afters.length === 1
              ? { events: [], cursor: 1, snapshot_required: true }
              : { events: [event(1, 'session.created')], cursor: 1 },
        };
      },
    },
    { after: 20 },
  );
  expect(afters).toEqual(['20', '0']);
  expect(result).toMatchObject({
    ok: true,
    value: { reset: true, events: [event(1, 'session.created')] },
  });
});

it('disables composer input for reviewers and sessions pending termination', () => {
  for (const extra of [{ review_id: 'review' }, { stop_pending: true }]) {
    const state = composeState({ ...session, ...extra });
    expect([state.send.enabled, state.steer.enabled]).toEqual([false, false]);
  }
});
