import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProjectBaseline, ProjectIntro } from '@pantheon/domain';
import { zh } from './i18n-setup.js';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, {
    layoutEffect: true,
    useId: 'overview-id',
  }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { MemoryOverview } from '@/screens/memory/MemoryOverview';
import { OverviewMemory, OverviewMemoryView } from '@/screens/memory/OverviewMemory';
import { PendingCard } from '@/screens/memory/PendingCard';
import { cachedQuery } from '@/data/query-cache';
import { ProjectProfile } from '@/screens/memory/ProjectProfile';

const NOW = Date.now();

const languages: ProjectIntro['languages'] = [
  { name: 'TypeScript', lines: 600 },
  { name: 'SQL', lines: 150 },
  { name: 'CSS', lines: 100 },
  { name: 'Shell', lines: 50 },
  { name: 'YAML', lines: 40 },
  { name: 'Markdown', lines: 30 },
  { name: 'other', lines: 30 },
];

const profile = (extra: Partial<Parameters<typeof ProjectProfile>[0]> = {}) =>
  ProjectProfile({
    id: 'refunds',
    name: 'Refunds',
    summary: 'Refund service with a back office for operators',
    sources: ['file:README.md:3'],
    branch: 'main',
    committedAt: null,
    now: NOW,
    stack: ['Node.js', 'Fastify'],
    languages,
    ...extra,
  });

const cls = (tree: ReactNode, name: string) =>
  nodes(tree).filter((n) =>
    String(n.props.className ?? '')
      .split(' ')
      .includes(name),
  );
const typeName = (n: ReactElement<any>) =>
  typeof n.type === 'function' ? (n.type as { name: string }).name : null;

describe('project profile', () => {
  it('titles the project with its mark and name and puts the summary, whole on hover, beside its source', () => {
    const tree = profile();
    const title = find(tree, (n) => n.type === 'h2');
    expect(text(title)).toBe('Refunds');
    expect(nodes(tree).some((n) => typeName(n) === 'ProjectMonogram')).toBe(true);
    const summary = cls(tree, 'mo-pf-sum')[0]!;
    const p = find(summary, (n) => n.type === 'p');
    expect(text(p)).toBe('Refund service with a back office for operators');
    expect(p.props.title).toBe('Refund service with a back office for operators');
    expect(cls(summary, 'mo-pf-ref').map((n) => [typeName(n), n.props.source])).toEqual([
      ['SourceRef', 'file:README.md:3'],
    ]);
  });

  it('opens a summary source from the project folder it was read in', () => {
    const summary = cls(profile({ base: '/work/refunds' }), 'mo-pf-sum')[0]!;
    expect(cls(summary, 'mo-pf-ref')[0]!.props.base).toBe('/work/refunds');
  });

  it('follows the branch with when the head was committed, before the divider', () => {
    const row = cls(profile({ committedAt: NOW - 12 * 60_000 }), 'mo-pf-chips')[0]!;
    const top = (row.props.children as ReactNode[]).flat().filter(Boolean) as ReactElement<any>[];
    expect(top.map((n) => n.props.content)).toEqual([
      zh('memory.overview.branch'),
      zh('memory.overview.committed'),
      undefined,
      undefined,
      undefined,
    ]);
    const commit = top[1]!.props.children as ReactElement<any>;
    expect(commit.props.className).toBe('chip');
    expect(text(commit)).toBe('12 分钟');
    expect(top[2]!.props.className).toBe('mo-pf-sep');
    const detached = cls(
      profile({ branch: null, committedAt: NOW - 12 * 60_000 }),
      'mo-pf-chips',
    )[0]!;
    expect(text(detached)).toBe('12 分钟Node.jsFastify');
  });

  it('puts the branch, a divider and the stack in one row of chips', () => {
    const row = cls(profile(), 'mo-pf-chips')[0]!;
    const items = nodes(row.props.children).filter((n) => n !== row);
    const top = (row.props.children as ReactNode[]).flat().filter(Boolean) as ReactElement<any>[];
    expect(top[0]!.props.content).toBe(zh('memory.overview.branch'));
    top[0] = top[0]!.props.children;
    expect(top.map((n) => n.props.className)).toEqual(['chip', 'mo-pf-sep', 'chip', 'chip']);
    expect(text(top[0])).toBe('main');
    expect(items.some((n) => n.props.className === 'mono' && text(n) === 'main')).toBe(true);
    expect(top.slice(2).map(text)).toEqual(['Node.js', 'Fastify']);
  });

  it('leaves out the branch on a detached head and the divider without a stack', () => {
    const detached = cls(profile({ branch: null }), 'mo-pf-chips')[0]!;
    expect(text(detached)).toBe('Node.jsFastify');
    expect(cls(detached, 'mo-pf-sep')).toHaveLength(0);
    const bare = cls(profile({ stack: [] }), 'mo-pf-chips')[0]!;
    expect(cls(bare, 'mo-pf-sep')).toHaveLength(0);
    expect(text(bare)).toBe('main');
  });

  it('heads the language cell with the line count and lists only shares in two columns', () => {
    const tree = profile();
    const cell = find(tree, (n) => n.props['aria-label'] === zh('memory.overview.languages'));
    expect(text(cls(cell, 'mo-pf-ch')[0])).toBe('语言1,000 行');
    const bar = cls(cell, 'mo-pf-seg')[0]!;
    expect(bar.props.role).toBe('img');
    expect(bar.props['aria-label']).toBe(
      '语言按代码行：TypeScript 60%，SQL 15%，CSS 10%，Shell 5%，其他 10%',
    );
    const parts = nodes(bar.props.children).filter((n) => n.type === 'i');
    expect(parts.map((n) => n.props['data-k'])).toEqual([1, 2, 3, 4, 'other']);
    const legend = cls(cell, 'mo-pf-legend')[0]!;
    expect(
      nodes(legend.props.children)
        .filter((n) => n.type === 'li')
        .map(text),
    ).toEqual(['TypeScript60%', 'SQL15%', 'CSS10%', 'Shell5%', '其他10%']);
  });

  it('paints every language share, other included, in a colour of its own, never the empty track', () => {
    const css = readFileSync(
      fileURLToPath(
        new URL('../../apps/web/src/screens/memory/memory-overview.css', import.meta.url),
      ),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
      selectors: m[1]!.split(',').map((s) => s.trim()),
      background: /background:\s*([^;]+);/.exec(m[2]!)?.[1],
    }));
    const paint = (selector: string) =>
      rules.find((r) => r.background && r.selectors.includes(selector))?.background;
    const cell = find(profile(), (n) => n.props['aria-label'] === zh('memory.overview.languages'));
    const bar = find(cell, (n) => n.props.role === 'img');
    const kinds = nodes(bar.props.children)
      .filter((n) => n.type === 'i')
      .map((n) => String(n.props['data-k']));
    const painted = kinds.map((k) => [
      k,
      paint(`.mo-pf-seg > [data-k='${k}']`),
      paint(`.mo-pf-dot[data-k='${k}']`),
    ]);
    expect(painted.filter(([, seg, dot]) => !seg || seg !== dot || seg === 'var(--track)')).toEqual(
      [],
    );
  });

  it('widens the project cell over the whole row when nothing is counted', () => {
    const tree = profile({ summary: null, sources: [], languages: [] });
    expect(cls(tree, 'mo-pf-sum')).toHaveLength(0);
    expect(nodes(tree).some((n) => n.props['aria-label'] === zh('memory.overview.languages'))).toBe(
      false,
    );
  });
});

const confirmed = {
  id: 'baseline-1',
  revision: 2,
  project_id: 'refunds',
  state: 'confirmed',
  facts_id: 'facts-1',
  dropped: 0,
  created_at: 0,
  result: {
    folders: [
      { root: '/work/refunds', stage: 'active', stack: ['Node.js', 'React'], gate: [] },
      { root: '/work/refunds-web', stage: 'active', stack: ['React', 'Vite'], gate: [] },
    ],
    workstreams: [],
    contradictions: [],
    findings: [],
    questions: [],
  },
} as unknown as ProjectBaseline;

beforeEach(() => {
  mock.board = {
    board: {
      cursor: 1,
      projects: [{ id: 'refunds', name: 'Refunds', roots: ['/work/refunds'] }],
      sessions: [],
      session_turns: [],
      workspaces: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  const answers: Record<string, unknown> = {
    'project.intro.read': {
      intro: {
        project_id: 'refunds',
        summary: 'Refund service',
        sources: ['file:README.md:3'],
        features: [],
        modules: [],
        languages,
        weeks: [],
        heads: [],
        session_id: 'intro-session',
        written_at: 0,
      },
      behind: 0,
      writing_session_id: null,
    },
    'project.baseline.read': confirmed,
    'project.head': {
      branch: 'main',
      sha: '6e9b7a3f',
      subject: 'Fix refunds',
      committed_at: NOW - 60_000,
    },
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({ ok: true, value: answers[method] })),
      command: vi.fn(),
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('memory overview', () => {
  it('stacks the project profile, the memory panel and the introduction in that order', async () => {
    const memory = createElement('section', { 'aria-label': 'memory panel' });
    let hold!: (held: boolean) => void;
    const h = mount(() =>
      MemoryOverview({ projectId: 'refunds', memory: (onHold) => ((hold = onHold), memory) }),
    );
    await h.flush();
    hold(false);
    h.render();
    const page = (h.value.props.children as ReactNode[]).filter(Boolean)[0] as ReactElement<any>;
    const blocks = (page.props.children as ReactNode[]).flat() as ReactElement<any>[];
    expect(blocks.map((n) => typeName(n) ?? n.props['aria-label'])).toEqual([
      'ProjectProfile',
      'memory panel',
      'IntroView',
    ]);
    const shown = blocks[0]!.props;
    expect(shown).toMatchObject({
      id: 'refunds',
      name: 'Refunds',
      summary: 'Refund service',
      sources: ['file:README.md:3'],
      base: '/work/refunds',
      branch: 'main',
      committedAt: NOW - 60_000,
      languages,
    });
    // Folders share one row of stack chips, each named once.
    expect(shown.stack).toEqual(['Node.js', 'React', 'Vite']);
    expect(blocks[2]!.props.projectId).toBe('refunds');
  });
});

describe('memory overview first draw', () => {
  // Each read waits until the test answers it; the query cache outlives a test, so each uses its own project.
  let answer: (name: string, value: unknown) => Promise<void>;
  let refuse: (name: string, code: string) => Promise<void>;
  beforeEach(() => {
    const waits = new Map<string, (result: unknown) => void>();
    const wait = (name: string) => new Promise((resolve) => waits.set(name, resolve));
    vi.stubGlobal('window', {
      pantheon: {
        query: vi.fn((method: string, params: Record<string, string>) =>
          wait(params.state ? `${method}:${params.state}` : method),
        ),
        command: vi.fn((c: { type: string }) => wait(c.type)),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    answer = async (name, value) => {
      waits.get(name)!({ ok: true, value });
      await Promise.resolve();
    };
    refuse = async (name, code) => {
      waits.get(name)!({ ok: false, error: { code, message: `${name} refused` } });
      await Promise.resolve();
    };
  });
  const directory = {
    epoch: 1,
    records: [],
    signature: 's'.repeat(64),
    total: 0,
    index_pending: 0,
    facets: { tags: [], tasks: [] },
    budget: { used_bytes: 0, limit_bytes: 12000 },
    counts: { active: 0, draft: 0, archived: 0 },
    jobs: [],
    sessions: [],
    document_ready: false,
  };
  const context = { bytes: 10, items: [], omitted: 0 };

  it('draws the profile, the memory panel and the introduction together once every first read is in', async () => {
    mock.board.board.projects.push({ id: 'payouts', name: 'Payouts', roots: [] });
    let hold!: (held: boolean) => void;
    const memory = (onHold: (held: boolean) => void) => {
      hold = onHold;
      return createElement('section', { 'aria-label': 'memory panel' });
    };
    const h = mount(() => MemoryOverview({ projectId: 'payouts', memory }));
    expect(nodes(h.value).some((n) => typeName(n) === 'ProjectProfile')).toBe(false);
    // The memory panel holds the page before the first paint while its own reads are out.
    hold(true);
    h.render();
    const page = () =>
      nodes(h.value).find(
        (n) => n.props.className === 'mo-pg' && nodes(n).some((c) => c.props['aria-label']),
      )!;
    const drawn = () =>
      !!page() &&
      !page().props.hidden &&
      nodes(page()).some((n) => typeName(n) === 'ProjectProfile') &&
      nodes(page()).some((n) => typeName(n) === 'IntroView');
    expect(drawn()).toBe(false);
    await answer('project.intro.read', {
      intro: {
        project_id: 'payouts',
        summary: 'Payout service',
        sources: [],
        features: [],
        modules: [],
        languages,
        weeks: [],
        heads: [],
        session_id: 'intro-session',
        written_at: 0,
      },
      behind: 0,
      writing_session_id: null,
    });
    await h.flush();
    expect(drawn()).toBe(false);
    await answer('project.baseline.read', confirmed);
    await answer('project.head', { branch: 'main', sha: '6e9b7a3f', subject: 'Fix payouts' });
    await h.flush();
    expect(drawn()).toBe(false);
    hold(false);
    h.render();
    expect(drawn()).toBe(true);
    expect(named(page(), 'ProjectProfile').props).toMatchObject({
      summary: 'Payout service',
      branch: 'main',
      stack: ['Node.js', 'React', 'Vite'],
      languages,
    });
    // Later reads update the drawn page in place.
    hold(true);
    h.render();
    expect(drawn()).toBe(true);
  });

  it('keeps the page held until the memory panel has reported its reads', async () => {
    mock.board.board.projects.push({ id: 'refunds', name: 'Refunds', roots: [] });
    let hold!: (held: boolean) => void;
    const memory = (onHold: (held: boolean) => void) => {
      hold = onHold;
      return createElement('section', { 'aria-label': 'memory panel' });
    };
    const h = mount(() => MemoryOverview({ projectId: 'refunds', memory }));
    await answer('project.intro.read', { intro: null, behind: 0, writing_session_id: null });
    await answer('project.baseline.read', confirmed);
    await answer('project.head', { branch: 'main', sha: '6e9b7a3f', subject: 'Fix refunds' });
    await h.flush();
    const shown = () => nodes(h.value).some((n) => typeName(n) === 'IntroView');
    expect(shown()).toBe(false);
    hold(false);
    h.render();
    expect(shown()).toBe(true);
  });

  it('holds the page while any of the memory panel reads is out', async () => {
    const onHold = vi.fn();
    const h = mount(() => OverviewMemory({ projectId: 'ledger', onHold }));
    await h.flush();
    expect(onHold).toHaveBeenLastCalledWith(true);
    for (const [name, value] of [
      ['memory.read', directory],
      ['memory.context', context],
      ['memory.recent', { items: [] }],
    ] as const) {
      await answer(name, value);
      await h.flush();
      expect(onHold).toHaveBeenLastCalledWith(true);
    }
    await answer('memory.read:draft', directory);
    await h.flush();
    expect(onHold).toHaveBeenLastCalledWith(false);
  });

  it('turns a confirm refused for space into the refused card, and a conflict into the sources one', async () => {
    const draft = { id: 'draft-1', kind: 'decision', key: 'retention', revision: 1, created_at: 0 };
    const h = mount(() => OverviewMemory({ projectId: 'ledger-budget', onHold() {} }));
    await h.flush();
    await answer('memory.read', directory);
    await answer('memory.context', context);
    await answer('memory.recent', { items: [] });
    await answer('memory.read:draft', { ...directory, records: [draft] });
    await h.flush();
    await answer('memory.history', {
      items: [{ ...draft, state: 'draft', title: 'Keep keys', text: 'Keep keys', based_on: 's' }],
    });
    await h.flush();
    const view = () => named(h.value, 'OverviewMemoryView').props;
    const card = () => view().data.pending[0];
    const refusal = {
      used_bytes: 12486,
      limit_bytes: 12000,
      largest_records: [{ id: 'big', title: 'Verify callbacks', bytes: 2140 }],
    };
    const stillDraft = {
      ...draft,
      state: 'draft',
      title: 'Keep keys',
      text: 'Keep keys',
      based_on: 's',
    };
    const fail = (code: string, details?: unknown) =>
      ((window as any).pantheon.command = vi.fn(async (c: { type: string }) =>
        c.type === 'memory.history'
          ? { ok: true, value: { items: [stillDraft] } }
          : { ok: false, error: { code, message: code, ...(details ? { details } : {}) } },
      ));
    fail('memory_budget_exceeded', refusal);
    view().actions.onCommit(card().item);
    await h.flush();
    expect(card()).toMatchObject({ overBudget: refusal, rejected: false, busy: false });
    fail('revision_conflict');
    view().actions.onCommit(card().item);
    await h.flush();
    expect(card().rejected).toBe(true);
    expect(card().overBudget).toBeUndefined();
  });

  const draft = { id: 'draft-1', kind: 'decision', key: 'retention', revision: 1, created_at: 0 };
  const proposed = {
    ...draft,
    state: 'draft',
    title: 'Keep keys',
    text: 'Keep keys',
    based_on: 's',
  };
  const view = (h: HookHost<any>) => named(h.value, 'OverviewMemoryView').props;
  const cardOf = (h: HookHost<any>) => {
    const pending = named(OverviewMemoryView(view(h)), 'Pending');
    return find((pending.type as any)(pending.props), (n) => n.type === PendingCard);
  };
  const withDraft = async (projectId: string) => {
    const h = mount(() => OverviewMemory({ projectId, onHold() {} }));
    await h.flush();
    await answer('memory.read', { ...directory, counts: { active: 0, draft: 1, archived: 0 } });
    await answer('memory.context', context);
    await answer('memory.recent', { items: [] });
    await answer('memory.read:draft', { ...directory, records: [draft] });
    await h.flush();
    return h;
  };

  it('keeps a confirm another window already made from reading as changed sources', async () => {
    const h = await withDraft('ledger-taken');
    await answer('memory.history', { items: [proposed] });
    await h.flush();
    (window as any).pantheon.command = vi.fn(async (c: { type: string }) =>
      c.type === 'memory.history'
        ? { ok: true, value: { items: [{ ...proposed, state: 'active', revision: 2 }] } }
        : {
            ok: false,
            error: { code: 'revision_conflict', message: 'Supply the current revision' },
          },
    );
    view(h).actions.onCommit(view(h).data.pending[0].item);
    await h.flush();
    expect(view(h).data.pending.filter((p: any) => p.rejected)).toEqual([]);
  });

  it('opens a draft refused for its sources in the rewrite dialog', async () => {
    const h = await withDraft('ledger-rewrite');
    await answer('memory.history', { items: [proposed] });
    await h.flush();
    cardOf(h).props.onRewrite();
    h.render();
    expect(named(h.value, 'NewMemoryDialog').props).toMatchObject({
      open: true,
      original: proposed,
      projectId: 'ledger-rewrite',
    });
  });

  it('says which panel reads failed and reads them again on retry', async () => {
    const h = mount(() => OverviewMemory({ projectId: 'ledger-failed', onHold() {} }));
    await h.flush();
    await refuse('memory.read', 'unavailable');
    await answer('memory.context', context);
    await refuse('memory.recent', 'unavailable');
    await refuse('memory.read:draft', 'unavailable');
    await h.flush();
    const data = view(h).data;
    expect(data.directoryError).toContain('memory.read refused');
    expect(data.recentError).toContain('memory.recent refused');
    expect(data.pendingError).toContain('memory.read:draft refused');
    const query = (window as any).pantheon.query as ReturnType<typeof vi.fn>;
    const asked = query.mock.calls.length;
    view(h).actions.onRetry();
    await h.flush();
    const again = query.mock.calls
      .slice(asked)
      .map(([method, params]) => (params.state ? `${method}:${params.state}` : method));
    expect(again).toEqual(
      expect.arrayContaining(['memory.read', 'memory.recent', 'memory.read:draft']),
    );
  });

  it('keeps the records a later history read failed to bring and caches no empty stand-in', async () => {
    const first = await withDraft('ledger-history');
    await answer('memory.history', { items: [proposed] });
    await first.flush();
    expect(view(first).data.pending.map((p: any) => p.item.id)).toEqual(['draft-1']);
    first.unmount();
    const again = mount(() => OverviewMemory({ projectId: 'ledger-history', onHold() {} }));
    await again.flush();
    await refuse('memory.history', 'ipc_failed');
    await again.flush();
    expect(view(again).data.pending.map((p: any) => p.item.id)).toEqual(['draft-1']);
    expect(view(again).data.pendingError).toContain('memory.history refused');
    expect(cachedQuery('memory.history', 'drafts:ledger-history')?.data).toMatchObject({
      items: { retention: [proposed] },
    });
  });

  it('draws a panel read before on its first frame, context included', async () => {
    const first = mount(() => OverviewMemory({ projectId: 'vault', onHold() {} }));
    await first.flush();
    await answer('memory.read', directory);
    await answer('memory.context', context);
    await answer('memory.recent', { items: [] });
    await answer('memory.read:draft', directory);
    await first.flush();
    first.unmount();
    const onHold = vi.fn();
    const again = mount(() => OverviewMemory({ projectId: 'vault', onHold }));
    expect(named(again.value, 'OverviewMemoryView').props.data.context).toEqual(context);
    expect(onHold).toHaveBeenLastCalledWith(false);
  });
});
