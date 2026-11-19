import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Visual } from '@pantheon/domain';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { refreshVisuals } from '@/data/visuals';

const visual = (id: string, session_id: string | null): Visual =>
  ({
    id,
    revision: 1,
    project_id: 'project-1',
    session_id,
    title: `drawing ${id}`,
    kind: 'mermaid',
    spec: { source: 'graph LR\na-->b' },
    created_at: 1,
    updated_at: 1,
  }) as Visual;

let turns = 0;
const command = vi.fn(async (sent: { type: string }): Promise<any> => {
  if (sent.type === 'session.send') return { ok: true, value: { id: `turn-${++turns}` } };
  return { ok: true, value: {} };
});
const sends = () =>
  command.mock.calls
    .map(([c]) => c as any)
    .filter((c) => c.type === 'session.send')
    .map((c) => ({
      session: c.input.session_id,
      revision: c.expected_revision,
      input: c.input.input,
    }));

type Shown = { id: string; state: string; revision: number };
const show = (sessions: Shown[], events: unknown[] = []) =>
  useBoard.setState({ board: { sessions, session_turns: [] } as never, events: events as never });
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  turns = 0;
  command.mockClear();
  vi.stubGlobal('window', { pantheon: { command } });
  useBoard.setState({ resync: 0, refresh() {} } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('redrawing pinned visuals one turn each', () => {
  it('asks a session for its second visual only after the first turn ended, at the new revision', async () => {
    show([{ id: 'session-1', state: 'open', revision: 4 }]);
    let done: string | null | undefined;
    void refreshVisuals([visual('a', 'session-1'), visual('b', 'session-1')]).then(
      (r) => (done = r),
    );
    await settle();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ session: 'session-1', revision: 4 });
    expect(sends()[0]!.input).toContain('replaces "a"');
    expect(sends()[0]!.input).not.toContain('replaces "b"');
    show([{ id: 'session-1', state: 'running', revision: 5 }]);
    await settle();
    expect(sends()).toHaveLength(1);
    expect(done).toBeUndefined();
    show([{ id: 'session-1', state: 'open', revision: 6 }]);
    await settle();
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ session: 'session-1', revision: 6 });
    expect(sends()[1]!.input).toContain('replaces "b"');
    expect(done).toBeNull();
  });

  it('asks different sessions at the same time, and waits for a running one to go idle', async () => {
    show([
      { id: 'session-1', state: 'open', revision: 4 },
      { id: 'session-2', state: 'open', revision: 9 },
      { id: 'session-3', state: 'running', revision: 2 },
    ]);
    void refreshVisuals([
      visual('a', 'session-1'),
      visual('b', 'session-2'),
      visual('c', 'session-3'),
    ]);
    await settle();
    expect(sends().map((s) => s.session)).toEqual(['session-1', 'session-2']);
    expect(command.mock.calls.some(([c]) => c.type === 'session.steer')).toBe(false);
    show([
      { id: 'session-1', state: 'running', revision: 5 },
      { id: 'session-2', state: 'running', revision: 10 },
      { id: 'session-3', state: 'open', revision: 3 },
    ]);
    await settle();
    expect(sends().map((s) => [s.session, s.revision])).toEqual([
      ['session-1', 4],
      ['session-2', 9],
      ['session-3', 3],
    ]);
  });

  it('asks no deleted session, before or while its queue waits', async () => {
    show([{ id: 'session-1', state: 'open', revision: 4 }]);
    let done: string | null | undefined;
    void refreshVisuals([
      visual('orphan', null),
      visual('a', 'session-1'),
      visual('b', 'session-1'),
    ]).then((r) => (done = r));
    await settle();
    expect(sends().map((s) => s.input)).toEqual([expect.stringContaining('replaces "a"')]);
    expect(sends()[0]!.input).not.toContain('replaces "b"');
    show(
      [],
      [
        {
          kind: 'session.deleted',
          aggregate_id: 'session-1',
          project_id: 'project-1',
          sequence: 3,
        },
      ],
    );
    await settle();
    expect(sends()).toHaveLength(1);
    expect(done).toBeNull();
  });
});
