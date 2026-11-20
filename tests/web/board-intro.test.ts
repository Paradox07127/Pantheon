import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectBaseline, ProjectIntro } from '@pantheon/domain';
import { t } from '@/i18n';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'intro-id' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    (selector: any) =>
      selector({
        openSession() {},
        openSessionGroup() {},
        openTaskSession() {},
        memoryTab: 'overview',
        setMemoryTab() {},
      }),
    { setState() {} },
  ),
}));
import { readBoardPage, useBoardPage } from '@/data/board-page';
import { BoardView } from '@/screens/board/BoardScreen';
import { IntroView } from '@/screens/board/IntroView';
import { MemoryOverview } from '@/screens/memory/MemoryOverview';
import { MemoryScreen } from '@/screens/memory/MemoryScreen';
import { commitStep, squarify } from '@/screens/board/intro-model';

const NOW = Date.UTC(2026, 10, 12, 12);
const noop = () => {};
const zhs = (...ids: string[]) => ids.map((id) => zh(id));

const intro = (extra: Partial<ProjectIntro> = {}): ProjectIntro => ({
  project_id: 'refunds',
  summary: 'Refund service with a back office for operators',
  sources: ['file:README.md:3', 'file:src/server.ts'],
  features: [
    {
      title: 'Full and partial refunds',
      text: 'Routes by channel.',
      sources: ['file:src/a.ts:18'],
    },
    { title: 'Signed callbacks', text: 'Verifies signatures.', sources: ['file:src/b.ts:44'] },
    { title: 'Daily reconciliation', text: 'Exports a diff report.', sources: ['file:rec/c.ts'] },
  ],
  modules: [
    {
      path: 'web',
      role: 'Operator back office',
      entry: 'web/main.tsx',
      lines: 3610,
      commits_30d: 14,
    },
    { path: 'src', role: 'API server', entry: 'src/server.ts', lines: 6820, commits_30d: 46 },
    { path: 'scripts', role: 'Release scripts', lines: 260, commits_30d: 0 },
  ],
  architecture: {
    nodes: [
      { id: 'web', label: 'Back office' },
      { id: 'api', label: 'API' },
    ],
    edges: [{ from: 'web', to: 'api' }],
  },
  body: '## Layout\n\nThe API lives in `src`.',
  languages: [
    { name: 'TypeScript', lines: 600 },
    { name: 'SQL', lines: 150 },
    { name: 'CSS', lines: 100 },
    { name: 'Shell', lines: 50 },
    { name: 'YAML', lines: 40 },
    { name: 'Markdown', lines: 30 },
    { name: 'other', lines: 30 },
  ],
  weeks: [9, 14, 11, 22, 17, 25, 19, 12],
  heads: [{ root: '/work/refunds', sha: '6e9b7a3f00112233' }],
  session_id: 'intro-session',
  written_at: NOW - 2 * 3_600_000,
  ...extra,
});

const confirmed = {
  id: 'baseline-1',
  revision: 2,
  project_id: 'refunds',
  state: 'confirmed',
  facts_id: 'facts-1',
  dropped: 0,
  created_at: NOW,
  result: {
    folders: [
      {
        root: '/work/refunds',
        stage: 'active',
        stack: ['Node.js', 'Fastify', 'React'],
        gate: [],
        commands: {
          setup: { argv: ['pnpm', 'install'], sources: [] },
          test: { argv: ['pnpm', 'test'], sources: [] },
        },
      },
    ],
    workstreams: [],
    contradictions: [],
    findings: [],
    questions: [],
  },
} as ProjectBaseline;

let answers: Record<string, unknown>;
let command: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  answers = {
    'project.intro.read': { intro: intro(), behind: 0, writing_session_id: null },
    'project.baseline.read': confirmed,
  };
  command = vi.fn(async () => ({ ok: true, value: { session_id: 'intro-2' } }));
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({ ok: true, value: answers[method] })),
      command,
    },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function mountIntro() {
  const h = mount(() => IntroView({ projectId: 'refunds' }));
  await h.flush();
  return h;
}

const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);
const has = (tree: ReactNode, predicate: (n: ReactElement<any>) => boolean) =>
  nodes(tree).some(predicate);
const typeName = (n: ReactElement<any>) =>
  typeof n.type === 'function' ? (n.type as { name: string }).name : null;
const button = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n).includes(label));

describe('board views', () => {
  it('offers overview and tasks in that order and opens the overview when nothing is stored', () => {
    const h = mount(() =>
      BoardView({
        model: null,
        loading: false,
        error: null,
        onRetry: noop,
        page: useBoardPage('refunds'),
        onPage: noop,
        projectId: 'refunds',
        onOpenSession: noop,
        onOpenStory: noop,
        onOpenTrace: noop,
      }),
    );
    const views = labelled(h.value, zh('board.view.label'));
    expect(views.props.value).toBe('overview');
    expect(
      nodes(views.props.children)
        .filter((n) => n.props.value !== undefined)
        .map(text),
    ).toEqual(zhs('board.view.overview', 'board.view.tasks'));
    expect(readBoardPage('intro')).toBe('overview');
    expect(readBoardPage(null)).toBe('overview');
  });

  it('mounts the profile, the memory panel and the introduction in the memory overview', async () => {
    mock.board.board.projects = [{ id: 'refunds', revision: 1, name: 'Refunds', roots: [] }];
    const h = mount(() => MemoryScreen({ projectId: 'refunds' }));
    const overview = find(h.value, (n) => typeName(n) === 'MemoryOverview');
    const panel = overview.props.memory(noop);
    expect(typeName(panel)).toBe('OverviewMemory');
    expect(panel.props.projectId).toBe('refunds');
    expect(has(h.value, (n) => typeName(n) === 'MainView')).toBe(false);
    // The introduction covers the whole project, so it offers no time range.
    expect(has(h.value, (n) => n.props['aria-label'] === zh('board.headline.range'))).toBe(false);
    let hold!: (held: boolean) => void;
    const page = mount(() =>
      (overview.type as typeof MemoryOverview)({
        ...overview.props,
        memory: (onHold) => ((hold = onHold), panel),
      }),
    );
    await page.flush();
    hold(false);
    page.render();
    expect(has(page.value, (n) => typeName(n) === 'ProjectProfile')).toBe(true);
    expect(has(page.value, (n) => n === panel)).toBe(true);
    expect(has(page.value, (n) => typeName(n) === 'IntroView')).toBe(true);
  });
});

describe('project introduction', () => {
  it('says how many commits the introduction is behind, zero included, and nothing when unknown', async () => {
    const behind = (count: number) =>
      t({ id: 'board.intro.behind', defaultMessage: '' }, { count });
    answers['project.intro.read'] = { intro: intro(), behind: 3, writing_session_id: null };
    expect(text((await mountIntro()).value)).toContain(behind(3));
    answers['project.intro.read'] = { intro: intro(), behind: 0, writing_session_id: null };
    expect(text((await mountIntro()).value)).toContain(behind(0));
    answers['project.intro.read'] = { intro: intro(), behind: null, writing_session_id: null };
    expect(text((await mountIntro()).value)).not.toContain(zh('board.intro.behind').split(' {')[0]);
  });

  it('reads the lag again after a merge into the project, not after every board read', async () => {
    const reads = () =>
      ((window as any).pantheon.query as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([method]) => method === 'project.intro.read',
      ).length;
    const h = await mountIntro();
    expect(reads()).toBe(1);
    mock.board.board = { ...mock.board.board, cursor: 2 };
    h.render();
    await h.flush();
    expect(reads()).toBe(1);
    answers['project.intro.read'] = { intro: intro(), behind: 2, writing_session_id: null };
    mock.board.events = [{ kind: 'session.merged', project_id: 'refunds', sequence: 5 }];
    h.render();
    await h.flush();
    expect(reads()).toBe(2);
    expect(text(h.value)).toContain(
      t({ id: 'board.intro.behind', defaultMessage: '' }, { count: 2 }),
    );
  });

  it('turns survey again off and says it is writing while a writing session runs', async () => {
    answers['project.intro.read'] = { intro: intro(), behind: 0, writing_session_id: 'writer' };
    const h = await mountIntro();
    expect(button(h.value, zh('memory.intro.survey')).props.disabled).toBe(true);
    expect(has(h.value, (n) => typeName(n) === 'RunningFor')).toBe(true);
  });

  it('surveys again by sending the start command and shows a refusal beside the button', async () => {
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: 'An introduction session turn is already running' },
    });
    const h = await mountIntro();
    button(h.value, zh('memory.intro.survey')).props.onClick();
    await h.flush();
    expect(command.mock.calls[0]![0]).toMatchObject({
      type: 'project.intro.start',
      input: { project_id: 'refunds' },
    });
    const refusal = find(h.value, (n) => n.props.role === 'alert');
    expect(text(refusal)).toContain('An introduction session turn is already running');
  });

  it('offers to generate an introduction for an assessed project without one', async () => {
    answers['project.intro.read'] = { intro: null, behind: 0, writing_session_id: null };
    const h = await mountIntro();
    button(h.value, zh('board.intro.generate')).props.onClick();
    await h.flush();
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]![0]).toMatchObject({ type: 'project.intro.start' });
  });

  it.each([
    ['builds the baseline of a project never assessed', null, 'board.baseline.start'],
    [
      'rebuilds the baseline after it failed',
      { ...confirmed, state: 'failed', result: undefined },
      'board.baseline.restart',
    ],
  ])('%s through the model choice the board uses', async (_name, assessed, label) => {
    answers['project.intro.read'] = { intro: null, behind: 0, writing_session_id: null };
    answers['project.baseline.read'] = assessed;
    const h = await mountIntro();
    expect(text(h.value)).not.toContain(zh('board.intro.generate'));
    button(h.value, zh(label)).props.onClick();
    h.render();
    const popover = find(h.value, (n) => typeName(n) === 'BaselinePopover');
    expect(popover.props.label).toBe(zh(label));
    expect(command).not.toHaveBeenCalled();
    popover.props.onStart({ runtime: 'codex' });
    expect(command.mock.calls[0]![0]).toMatchObject({
      type: 'project.baseline.start',
      input: { project_id: 'refunds', runtime: 'codex' },
    });
  });

  it('offers no start while the baseline runs, and says why a start was refused', async () => {
    answers['project.intro.read'] = { intro: null, behind: 0, writing_session_id: null };
    answers['project.baseline.read'] = null;
    command.mockResolvedValueOnce({
      ok: false,
      error: { code: 'resource_busy', message: 'A baseline is already running' },
    });
    const h = await mountIntro();
    button(h.value, zh('board.baseline.start')).props.onClick();
    h.render();
    find(h.value, (n) => typeName(n) === 'BaselinePopover').props.onStart({});
    await h.flush();
    h.render();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain(
      'A baseline is already running',
    );
    answers['project.baseline.read'] = { ...confirmed, state: 'running', result: undefined };
    const running = await mountIntro();
    const start = button(running.value, zh('board.setup.running'));
    expect(start.props.disabled).toBe(true);
    expect(start.props['aria-busy']).toBe(true);
  });

  it('draws the commands and the architecture only when there is data for them', async () => {
    const full = await mountIntro();
    expect(has(full.value, (n) => typeName(n) === 'ArchDiagram')).toBe(true);
    expect(has(full.value, (n) => typeName(n) === 'CommandRow')).toBe(true);

    answers['project.intro.read'] = {
      intro: intro({ architecture: undefined }),
      behind: 0,
      writing_session_id: null,
    };
    answers['project.baseline.read'] = { ...confirmed, state: 'running' };
    const bare = await mountIntro();
    expect(has(bare.value, (n) => typeName(n) === 'ArchDiagram')).toBe(false);
    expect(has(bare.value, (n) => typeName(n) === 'CommandRow')).toBe(false);
    // The modules stay without the diagram.
    expect(has(bare.value, (n) => typeName(n) === 'Treemap')).toBe(true);
  });

  it('draws the architecture with the graph visual renderer, named by its counts', async () => {
    const h = await mountIntro();
    const arch = find(h.value, (n) => typeName(n) === 'ArchDiagram');
    const drawn = mount(() => (arch.type as (props: unknown) => ReactNode)(arch.props));
    const group = find(drawn.value, (n) => n.props.role === 'group');
    expect(group.props['aria-label']).toBe('架构图，2 个节点，1 条边');
    const graph = find(group, (n) => typeName(n) === 'GraphDiagram');
    expect(graph.props.spec).toBe(arch.props.spec);
    expect(graph.props.grows).toBe(true);
  });

  it('draws the whole introduction body with its charts in the main flows, and nothing for an empty body', async () => {
    const flow = '```mermaid\nflowchart LR\n  web --> api\n```';
    const chart = '```vega-lite\n{"mark":"bar"}\n```';
    const body = `## Flows\n\n${flow}\n\nThe API answers.\n\n${chart}`;
    answers['project.intro.read'] = {
      intro: intro({ body }),
      behind: 0,
      writing_session_id: null,
    };
    const drawn = await mountIntro();
    const flows = labelled(drawn.value, zh('board.intro.flows'));
    expect(has(flows, (n) => n.props.text === body)).toBe(true);

    answers['project.intro.read'] = {
      intro: intro({ body: '' }),
      behind: 0,
      writing_session_id: null,
    };
    const bare = await mountIntro();
    expect(has(bare.value, (n) => n.props['aria-label'] === zh('board.intro.flows'))).toBe(false);
  });
});

describe('module treemap layout', () => {
  const values = [4820, 3610, 2940, 2130, 1240, 980, 760, 420, 260, 0];
  const W = 640;
  const H = 160;
  const cells = squarify(values, W, H);
  const total = values.reduce((a, b) => a + b, 0);

  it('gives each module an area in proportion to its lines and leaves empty ones out', () => {
    expect(cells.map((c) => c.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const c of cells)
      expect(Math.abs(c.w * c.h - (values[c.index]! / total) * W * H)).toBeLessThan(1);
  });

  // Equal values in a square put several cells in one row, across and down.
  it.each([
    ['a wide box of uneven modules', cells, W, H],
    ['a square box of equal modules', squarify(Array<number>(9).fill(1), 300, 300), 300, 300],
  ])('keeps every cell inside the box and apart from the others in %s', (_, laid, w, h) => {
    const e = 1e-6;
    for (const c of laid) {
      expect(c.x).toBeGreaterThanOrEqual(-e);
      expect(c.y).toBeGreaterThanOrEqual(-e);
      expect(c.x + c.w).toBeLessThanOrEqual(w + e);
      expect(c.y + c.h).toBeLessThanOrEqual(h + e);
    }
    for (const a of laid)
      for (const b of laid) {
        if (a === b) continue;
        const across = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const down = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(across <= e || down <= e).toBe(true);
      }
  });

  it('shades commits in five steps: none, 1 to 3, 4 to 9, 10 to 19 and 20 or more', () => {
    expect([0, 1, 3, 4, 9, 10, 19, 20, 400].map(commitStep)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
});
