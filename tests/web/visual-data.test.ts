import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import {
  pinVisual,
  refreshVisuals,
  usePinnedVisuals,
  useRedrawFailed,
  useRefreshing,
  useVisual,
} from '@/data/visuals';
import type { Visual } from '@pantheon/domain';

let revision = 1;
const command = vi.fn(async (sent: { type: string; input: Record<string, unknown> }) => {
  if (sent.type === 'visual.read')
    return {
      ok: true,
      value: {
        id: sent.input.visual_id,
        revision,
        project_id: 'project-1',
        session_id: 'session-1',
        title: `drawing ${revision}`,
        kind: 'mermaid',
        spec: { source: 'graph LR\na-->b' },
        created_at: 1,
        updated_at: 1,
      },
    };
  if (sent.type === 'visual.list') return { ok: true, value: { visuals: [] } };
  return { ok: true, value: {} };
});
const reads = (type: string) => command.mock.calls.filter(([sent]) => sent.type === type);

const drawn = (sequence: number, visual_id: string, project_id = 'project-1') => ({
  event_id: `event-${sequence}`,
  sequence,
  kind: 'visual.drawn',
  project_id,
  aggregate_id: 'session-1',
  payload: { visual_id, title: 'x', kind: 'mermaid', revision: 2 },
});

const changed = (sequence: number, visual_ids: string[], project_id = 'project-1') => ({
  event_id: `event-${sequence}`,
  sequence,
  kind: 'visual.changed',
  project_id,
  aggregate_id: visual_ids[0] ?? project_id,
  payload: { visual_ids },
});

const deleted = (sequence: number, session_id: string, project_id = 'project-1') => ({
  event_id: `event-${sequence}`,
  sequence,
  kind: 'session.deleted',
  project_id,
  aggregate_id: session_id,
  payload: { title: 'x' },
});

const visual = (id: string, revision: number, session_id: string | null = 'session-1') =>
  ({
    id,
    revision,
    project_id: 'project-1',
    session_id,
    title: 'drawing',
    kind: 'mermaid',
    spec: { source: 'graph LR\na-->b' },
    created_at: 1,
    updated_at: 1,
  }) as Visual;

beforeEach(() => {
  vi.useFakeTimers();
  revision = 1;
  command.mockClear();
  vi.stubGlobal('window', { pantheon: { command } });
  useBoard.setState({ events: [], resync: 0 });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('visual reads', () => {
  it('reads a visual again after the session draws it again, and not after other drawings', async () => {
    const h = mount(() => useVisual('visual-1'));
    await h.flush();
    expect(h.value.data?.title).toBe('drawing 1');
    expect(reads('visual.read')).toHaveLength(1);

    useBoard.setState({ events: [drawn(5, 'visual-other')] as never });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.read')).toHaveLength(1);

    revision = 2;
    useBoard.setState({ events: [drawn(5, 'visual-other'), drawn(6, 'visual-1')] as never });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.read')).toHaveLength(2);
    expect(h.value.data?.title).toBe('drawing 2');
  });

  it('reads a visual again after a pin, unpin or arrange of it is stored, and not of others', async () => {
    const h = mount(() => useVisual('visual-1'));
    await h.flush();
    useBoard.setState({ events: [changed(5, ['visual-other'])] as never });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.read')).toHaveLength(1);

    useBoard.setState({
      events: [changed(5, ['visual-other']), changed(6, ['visual-other', 'visual-1'])] as never,
    });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.read')).toHaveLength(2);
  });

  it("reads the project's pinned visuals again as soon as a pin from this window lands", async () => {
    const h = mount(() => usePinnedVisuals('project-1'));
    await h.flush();
    expect(reads('visual.list')).toHaveLength(1);
    expect(await pinVisual('visual-1', 'M')).toBeNull();
    h.render();
    await h.flush();
    expect(reads('visual.list')).toHaveLength(2);
  });

  it("reads the project's pinned visuals and reads them again after a pin, unpin or arrange in the project is stored", async () => {
    const h = mount(() => usePinnedVisuals('project-1'));
    await h.flush();
    expect(reads('visual.list').map(([sent]) => sent.input)).toEqual([
      { project_id: 'project-1', pinned: true },
    ]);
    expect(h.value.data).toEqual([]);

    useBoard.setState({ events: [changed(5, ['visual-other'], 'project-2')] as never });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.list')).toHaveLength(1);

    useBoard.setState({
      events: [changed(5, ['visual-other'], 'project-2'), changed(6, ['visual-1'])] as never,
    });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.list')).toHaveLength(2);
  });

  it('pins at a width only when one is given, so a size change keeps the width', async () => {
    expect(await pinVisual('visual-1', 'S')).toBeNull();
    expect(await pinVisual('visual-1', 'M', 8)).toBeNull();
    expect(reads('visual.pin').map(([sent]) => sent.input)).toEqual([
      { visual_id: 'visual-1', size: 'S' },
      { visual_id: 'visual-1', size: 'M', width: 8 },
    ]);
  });

  it("reads the project's pinned visuals again after one of its sessions is deleted", async () => {
    const h = mount(() => usePinnedVisuals('project-1'));
    await h.flush();
    useBoard.setState({ events: [deleted(5, 'session-other', 'project-2')] as never });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.list')).toHaveLength(1);

    useBoard.setState({
      events: [deleted(5, 'session-other', 'project-2'), deleted(6, 'session-1')] as never,
    });
    h.render();
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(reads('visual.list')).toHaveLength(2);
  });

  it("reads the project's pinned visuals again once the event stream is live again", async () => {
    useBoard.setState({ status: { state: 'live' } });
    const h = mount(() => usePinnedVisuals('project-1'));
    await h.flush();
    useBoard.setState({ status: { state: 'offline', reason: 'gone' } });
    h.render();
    await h.flush();
    expect(reads('visual.list')).toHaveLength(1);

    useBoard.setState({ status: { state: 'live' } });
    h.render();
    await h.flush();
    expect(reads('visual.list')).toHaveLength(2);
  });

  it('says a visual that no longer exists is gone', async () => {
    command.mockImplementationOnce(
      async () =>
        ({ ok: false, error: { code: 'not_found', message: 'visuals/visual-1' } }) as never,
    );
    const h = mount(() => useVisual('visual-1'));
    await h.flush();
    expect(h.value).toMatchObject({ data: null, gone: true });
  });
});

describe('visual redraws', () => {
  it('forgets a redraw once a newer revision is read, so an older copy of the visual shows none', async () => {
    expect(await refreshVisuals([visual('visual-1', 1)])).toBeNull();
    expect(mount(() => useRefreshing([visual('visual-1', 1)])).value).toEqual(
      new Set(['visual-1']),
    );
    mount(() => useRefreshing([visual('visual-1', 2)]));
    expect(mount(() => useRefreshing([visual('visual-1', 1)])).value).toEqual(new Set());
  });

  it('ends a redraw as failed once the session asked to draw it is deleted', async () => {
    const asked = visual('visual-deleted-session', 1);
    expect(await refreshVisuals([asked])).toBeNull();
    expect(mount(() => useRefreshing([asked])).value).toEqual(new Set([asked.id]));
    useBoard.setState({ events: [deleted(7, 'session-1')] as never });
    expect(mount(() => useRefreshing([asked])).value).toEqual(new Set());
    expect(mount(() => useRedrawFailed([asked])).value).toEqual(new Set([asked.id]));
  });

  it('ends a redraw as failed once the visual is read without its session', async () => {
    const asked = visual('visual-orphaned', 1);
    expect(await refreshVisuals([asked])).toBeNull();
    const orphaned = visual('visual-orphaned', 1, null);
    expect(mount(() => useRefreshing([orphaned])).value).toEqual(new Set());
    expect(mount(() => useRedrawFailed([orphaned])).value).toEqual(new Set([orphaned.id]));
  });
});
