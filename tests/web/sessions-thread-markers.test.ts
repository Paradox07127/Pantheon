import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Collapsible } from '../../apps/web/node_modules/@base-ui/react/collapsible/index.mjs';
import { Dialog } from '../../apps/web/node_modules/@base-ui/react/dialog/index.mjs';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { ContextBreakdown } from '@/screens/sessions/ContextBreakdown';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';

const listed = (
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const turn = (extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id: 'turn-a',
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: 'Check the webhook',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});
const event = (sequence: number, kind: string, minute: number) =>
  ({
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id: 'turn-a',
    aggregate_revision: sequence,
    project_id: 'project-a',
    causation_id: 'cause',
    created_at: new Date(2026, 10, 12, 10, minute).getTime(),
    payload: { turn_id: 'turn-a' },
  }) as DaemonEvent;

const body = (tree: unknown, name: string) => {
  const node = named(tree as any, name);
  return mount(() => (node.type as (props: unknown) => ReactNode)(node.props) as ReactElement<any>);
};
const turnHost = (
  session: WorkbenchSession | null,
  options: { turn?: SessionTurn; events?: DaemonEvent[]; checkpoint?: string | null } = {},
) =>
  mount(() =>
    ThreadTurn({
      view: buildTranscript(
        [options.turn ?? turn()],
        options.events ?? [event(1, 'turn.completed', 14)],
      ).turns[0]!,
      folders: [],
      status: { kind: 'ended', tool: null, since: null },
      fresh: new Set(),
      request: () => null,
      listed: session,
      checkpoint: options.checkpoint ?? null,
    }),
  );
const checkpointRow = (tree: unknown) =>
  nodes(tree as any).find(
    (n) =>
      typeof n.type === 'function' &&
      n.type.name === 'ThreadMark' &&
      nodes(n).some((c) => typeof c.type === 'function' && c.type.name === 'CheckpointBack'),
  );

let commands: { type: string; input: unknown }[];
beforeEach(() => {
  commands = [];
  mock.board = {
    board: { sessions: [{ id: 'session-a', runtime: 'claude', revision: 4 }] },
    events: [],
  };
  vi.stubGlobal('window', {
    pantheon: {
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return { ok: true, value: {} };
      }),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the interrupted notice', () => {
  it('is a notice bar with a hollow dot, what happened, that the changes are kept and when', () => {
    const h = turnHost(null, { events: [event(1, 'turn.cancelled', 41)] });
    const bar = find(h.value, (n) => n.props.className === 'ss-nb');
    expect(bar.props.role).toBe('note');
    expect(find(bar, (n) => n.props.className === 'ss-nbd').props['data-tone']).toBe('idle');
    expect(text(bar)).toBe(
      `${zh('sessions.thread.interrupted')}${zh('sessions.thread.interruptedKept')}10:41`,
    );
    expect(text(find(bar, (n) => n.props.className === 'ss-nbt'))).toBe('10:41');
  });
});

describe('the checkpoint after a turn', () => {
  it('rules a line with the checkpoint, the time the turn ended and a way back to it', () => {
    const row = checkpointRow(turnHost(listed('idle'), { checkpoint: 'turn-b' }).value);
    expect(row).toBeDefined();
    expect(text(row!)).toBe(`${zh('sessions.thread.checkpoint')}10:14`);
    const back = body(row, 'CheckpointBack');
    const button = find(back.value, (n) => n.type === 'button');
    expect(text(button)).toBe(zh('sessions.thread.checkpointBack'));
    expect(button.props.disabled).toBe(false);
  });

  it('is left out when no checkpoint follows, the turn was rolled back or the session cannot roll back', () => {
    for (const h of [
      turnHost(listed('idle')),
      turnHost(listed('idle'), { checkpoint: 'turn-b', turn: turn({ rolled_back: true }) }),
      turnHost(listed('idle', { workspace_kind: 'in_place' }), { checkpoint: 'turn-b' }),
      turnHost(listed('merged'), { checkpoint: 'turn-b' }),
      turnHost(null, { checkpoint: 'turn-b' }),
    ])
      expect(checkpointRow(h.value)).toBeUndefined();
  });

  it('keeps the way back off while the session is running', () => {
    const row = checkpointRow(turnHost(listed('running'), { checkpoint: 'turn-b' }).value);
    const back = body(row, 'CheckpointBack');
    expect(find(back.value, (n) => n.type === 'button').props.disabled).toBe(true);
  });

  it('rolls the worktree back to the checkpoint once confirmed', async () => {
    const row = checkpointRow(turnHost(listed('idle'), { checkpoint: 'turn-b' }).value);
    const back = body(row, 'CheckpointBack');
    find(back.value, (n) => n.type === 'button').props.onClick();
    back.render();
    const dialog = named(back.value, 'RollbackDialog');
    expect(dialog.props.open).toBe(true);
    const confirm = body(back.value, 'RollbackDialog');
    expect(text(find(confirm.value, (n) => n.type === Dialog.Title))).toBe(
      zh('sessions.thread.checkpointTitle'),
    );
    expect(text(find(confirm.value, (n) => n.type === Dialog.Description))).toContain(
      zh('sessions.screen.rollbackBothBody'),
    );
    expect(commands).toEqual([]);
    find(
      confirm.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.screen.rollback'),
    ).props.onClick();
    await confirm.flush();
    expect(commands).toMatchObject([
      { type: 'session.rollback', input: { session_id: 'session-a', turn_id: 'turn-b' } },
    ]);
  });
});

describe('the expandable rows of the context breakdown', () => {
  it('name how many tools, agents and files each holds', () => {
    const h = mount(() =>
      ContextBreakdown({
        usage: {
          context_tokens: 30_000,
          context_window: 400_000,
          context_breakdown: {
            categories: [
              { id: 'mcp_tools', tokens: 9_000, kind: 'used' },
              { id: 'custom_agents', tokens: 1_000, kind: 'used' },
              { id: 'memory_files', tokens: 4_000, kind: 'used' },
            ],
            mcp_tools: [
              { name: 'search', server: 'docs', tokens: 6_000, loaded: true },
              { name: 'fetch', server: 'docs', tokens: 3_000, loaded: true },
              { name: 'later', server: 'docs', tokens: 2_000, loaded: false },
            ],
            agents: [{ type: 'migrator', source: 'project', tokens: 1_000 }],
            memory_files: [
              { path: 'CLAUDE.md', tokens: 3_000 },
              { path: 'MEMORY.md', tokens: 1_000 },
            ],
          },
        },
      }),
    );
    const rows = nodes(h.value).filter((n) => n.props['data-group']);
    expect(rows.map(text)).toEqual([
      `${zh('sessions.compose.context.mcpTools')}2`,
      `${zh('sessions.compose.context.memoryFiles')}2`,
      `${zh('sessions.compose.context.customAgents')}1`,
    ]);
  });
});

describe('the confirmed baseline a lead starts from', () => {
  it('folds into a closed card named for the baseline that opens to its whole text', () => {
    const input =
      '[Pantheon] This is the confirmed baseline of the project.\n\nWorkstreams: importer';
    const h = turnHost(listed('running'), { turn: turn({ input, origin: 'baseline' }) });
    const card = find(h.value, (n) => n.type === Collapsible.Root);
    expect(card.props.defaultOpen).toBeFalsy();
    expect(text(find(card, (n) => n.type === Collapsible.Trigger))).toBe(
      zh('sessions.thread.confirmedBaseline'),
    );
    const shown = 'This is the confirmed baseline of the project.\n\nWorkstreams: importer';
    expect(text(find(card, (n) => n.type === Collapsible.Panel))).toBe(shown);
    // The text shows only inside the card.
    expect(nodes(h.value).filter((n) => n.props.children === shown)).toHaveLength(1);
  });
});
