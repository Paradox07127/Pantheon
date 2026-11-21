import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectBaseline, ProjectIntro } from '@pantheon/domain';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, {
    layoutEffect: true,
    useId: ':intro-id:',
  }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { RunningFor } from '@/components/RunningFor';
import { ArchDiagram, IntroView, SourceRef, Treemap } from '@/screens/memory/IntroView';
import { archLayout, commitShade, mergeEdges } from '@/screens/memory/intro-model';
import { zh } from './i18n-setup.js';

const NOW = Date.now();

const intro = (extra: Partial<ProjectIntro> = {}): ProjectIntro => ({
  project_id: 'refunds',
  summary: 'Refund service with a back office for operators',
  sources: ['file:README.md:3'],
  features: [
    {
      title: 'Full and partial refunds',
      text: 'Routes by channel.',
      sources: ['file:src/a.ts:18', 'file:src/a2.ts'],
    },
    { title: 'Signed callbacks', text: 'Verifies signatures.', sources: ['file:src/b.ts:44'] },
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
      { id: 'web', label: 'Back office', group: 'frontend' },
      { id: 'api', label: 'API' },
    ],
    edges: [{ from: 'web', to: 'api' }],
  },
  body: '## Layout',
  languages: [{ name: 'TypeScript', lines: 600 }],
  weeks: [9, 14, 11, 22, 17, 25, 19, 12],
  heads: [{ root: '/work/refunds', sha: '6e9b7a3f00112233' }],
  session_id: 'intro-session',
  written_at: NOW,
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
        setup: { argv: ['pnpm', 'install'], sources: ['file:package.json:5'] },
        gate: [
          { name: 'test', argv: ['pnpm', 'test'], sources: ['file:package.json:11'] },
          { name: 'lint', argv: ['pnpm', 'lint'], sources: [] },
        ],
      },
    ],
  },
} as ProjectBaseline;

let answers: Record<string, unknown>;
let keys: ((e: unknown) => void)[];
beforeEach(() => {
  mock.board = {
    board: {
      cursor: 1,
      projects: [{ id: 'refunds', name: 'Refunds', roots: ['/work/refunds', '/work/web'] }],
      project_briefs: [
        {
          id: 'refunds',
          revision: 1,
          project_id: 'refunds',
          goal: 'Ship refunds v2',
          goals: ['Every refund runs once', 'Every callback is verified'],
          non_goals: ['No checkout'],
          created_at: NOW,
          updated_by: 'user',
        },
      ],
      sessions: [],
      session_turns: [],
      workspaces: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  answers = {
    'project.intro.read': { intro: intro(), behind: 0, writing_session_id: null },
    'project.baseline.read': confirmed,
  };
  keys = [];
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => ({ ok: true, value: answers[method] })),
      command: vi.fn(async () => ({ ok: true, value: { session_id: 'intro-2' } })),
    },
    addEventListener: (type: string, listener: (e: unknown) => void) => {
      if (type === 'keydown') keys.push(listener);
    },
    removeEventListener: (type: string, listener: (e: unknown) => void) => {
      if (type === 'keydown') keys.splice(keys.indexOf(listener), 1);
    },
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

const has = (tree: ReactNode, predicate: (n: ReactElement<any>) => boolean) =>
  nodes(tree).some(predicate);
const typeName = (n: ReactElement<any>) =>
  typeof n.type === 'function' ? (n.type as { name: string }).name : null;
const byClass = (tree: ReactNode, name: string) =>
  nodes(tree).filter((n) => n.props.className === name);
// The declarations of the intro stylesheet's rule for exactly this selector, space around punctuation taken out.
const rule = (selector: string) => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, '../../apps/web/src/screens/memory/intro.css'),
    'utf8',
  )
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/\s+/g, ' ');
  const at = css.indexOf(`}${selector}{`);
  if (at < 0) return '';
  const start = at + selector.length + 2;
  return css.slice(start, css.indexOf('}', start));
};

describe('project introduction head', () => {
  it('titles the section and states who surveyed it when, the commit and a zero lag', async () => {
    mock.board.board.sessions = [{ id: 'intro-session', runtime: 'claude' }];
    const h = await mountIntro();
    const head = find(h.value, (n) => n.props.className === 'in-hd');
    expect(text(find(head, (n) => n.type === 'h2'))).toBe(zh('memory.intro.title'));
    const time = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(NOW);
    expect(text(head)).toContain(`Claude 摸底于 今天 ${time}`);
    expect(text(head)).toContain('6e9b7a3');
    expect(text(head)).toContain('落后 0 个提交');
    const survey = find(
      head,
      (n) => n.type === 'button' && text(n).includes(zh('memory.intro.survey')),
    );
    expect(survey.props.className).toBe('btn sm');
  });

  it('states the survey time alone once the surveying session is gone from the board', async () => {
    const h = await mountIntro();
    const head = find(h.value, (n) => n.props.className === 'in-hd');
    expect(text(head)).toContain('摸底于 今天');
    expect(text(head)).not.toContain('Claude');
  });

  it('shows only the writing state and how long it has run while a writing session runs', async () => {
    answers['project.intro.read'] = { intro: intro(), behind: 0, writing_session_id: 'writer' };
    mock.board.events = [
      { kind: 'session.opened', aggregate_id: 'writer', created_at: NOW - 72_000 },
    ];
    const h = await mountIntro();
    const head = find(h.value, (n) => n.props.className === 'in-hd');
    expect(text(head)).not.toContain('摸底于');
    const mark = find(head, (n) => typeName(n) === 'RunningFor');
    expect(mark.props).toEqual({ label: zh('components.running.writing'), since: NOW - 72_000 });
    const shown = mount(() => RunningFor({ ...mark.props, since: Date.now() - 72_000 }));
    expect(text(shown.value)).toContain(zh('components.running.writing'));
    expect(text(shown.value)).toContain('1 分 12 秒');
    const long = mount(() => RunningFor({ ...mark.props, since: Date.now() - 3_725_000 }));
    expect(text(long.value)).toContain('1 小时 2 分');
  });
});

describe('project introduction body', () => {
  it('leaves the summary, languages, stack and weeks to other places and draws the body', async () => {
    const h = await mountIntro();
    const all = text(h.value);
    expect(all).not.toContain('Refund service with a back office for operators');
    expect(all).not.toContain('Fastify');
    expect(has(h.value, (n) => n.props.className === 'in-seg')).toBe(false);
    expect(has(h.value, (n) => n.props.className === 'in-bars')).toBe(false);
    expect(has(h.value, (n) => n.props.text === '## Layout')).toBe(true);
    expect(has(h.value, (n) => n.props.className === 'in-mr')).toBe(false);
  });

  it('lists each feature on one row with its first source, beside the goals and non-goals', async () => {
    const h = await mountIntro();
    const rows = byClass(h.value, 'in-ft');
    expect(rows.map((row) => text(row))).toEqual([
      'Full and partial refundsRoutes by channel.',
      'Signed callbacksVerifies signatures.',
    ]);
    expect(rows.map((row) => find(row, (n) => typeName(n) === 'SourceRef').props)).toEqual([
      { source: 'file:src/a.ts:18', base: '/work/refunds', className: 'in-ref' },
      { source: 'file:src/b.ts:44', base: '/work/refunds', className: 'in-ref' },
    ]);
    expect(byClass(h.value, 'in-gl').map((row) => text(row))).toEqual([
      'Every refund runs once',
      'Every callback is verified',
      'No checkout',
    ]);
    const columns = find(h.value, (n) => n.props.className === 'in-fg');
    expect(text(columns)).toContain(zh('memory.intro.goals'));
    expect(text(columns)).toContain(zh('memory.intro.nonGoals'));
  });

  it('bounds a feature row’s title and source, so a long one is cut instead of pushing out', async () => {
    const h = await mountIntro();
    const row = byClass(h.value, 'in-ft')[0]!;
    const columns = rule('.in-ft').match(/grid-template-columns:([^;]+)/)![1]!;
    expect(columns.split(/\s+(?![^(]*\))/)).toHaveLength(4);
    expect(columns).not.toMatch(/(^|\s)(auto|max-content|min-content)(\s|$)/);
    const title = nodes(row).find(
      (n) => text(n) === 'Full and partial refunds' && n.type === 'span',
    );
    expect(String(title!.props.className).split(' ')).toContain('in-cut');
    const ref = mount(() =>
      SourceRef({ source: 'file:src/a.ts:18', base: '/work/refunds', className: 'in-ref' }),
    );
    const wrapper = ref.value as ReactElement<any>;
    expect(rule(`.${wrapper.props.className}`)).toContain('min-width:0');
    const chip = find(wrapper, (n) => n.type === 'button');
    expect(find(chip, (n) => n.type === 'span').props.className).toBe('in-cut');
  });

  it('lists the commands with the file each was found in', async () => {
    const h = await mountIntro();
    const rows = nodes(h.value).filter((n) => typeName(n) === 'CommandRow');
    expect(rows.map((row) => [row.props.label, row.props.command, row.props.source])).toEqual([
      [zh('board.intro.command.setup'), 'pnpm install', 'package.json:5'],
      ['test', 'pnpm test', 'package.json:11'],
      ['lint', 'pnpm lint', undefined],
    ]);
  });

  it('quotes each argument the shell would split or read, so the copied command runs as found', async () => {
    const folder = confirmed.result!.folders[0]!;
    answers['project.baseline.read'] = {
      ...confirmed,
      result: {
        ...confirmed.result,
        folders: [
          {
            root: folder.root,
            gate: [
              { name: 'build', argv: ['sh', '-c', 'pnpm build && pnpm test'], sources: [] },
              {
                name: 'test',
                argv: ['node', 'scripts/run all.mjs', "it's", '&&', '$HOME', ''],
                sources: [],
              },
            ],
          },
        ],
      },
    };
    const h = await mountIntro();
    const rows = nodes(h.value).filter((n) => typeName(n) === 'CommandRow');
    expect(rows.map((row) => row.props.command)).toEqual([
      "sh -c 'pnpm build && pnpm test'",
      `node 'scripts/run all.mjs' 'it'\\''s' '&&' '$HOME' ''`,
    ]);
  });

  it('heads the architecture with its node count and draws it with the graph renderer', async () => {
    const h = await mountIntro();
    expect(text(h.value)).toContain('2 个节点');
    const arch = find(h.value, (n) => typeName(n) === 'ArchDiagram');
    const drawn = mount(() => ArchDiagram(arch.props));
    expect(find(drawn.value, (n) => typeName(n) === 'GraphDiagram').props.spec).toBe(
      arch.props.spec,
    );
  });

  it('puts the picked module in place of the treemap and lets it go by its button or Esc', async () => {
    const h = await mountIntro();
    find(h.value, (n) => typeName(n) === 'Treemap').props.onPick('web');
    h.render();
    expect(has(h.value, (n) => typeName(n) === 'Treemap')).toBe(false);
    const detail = find(h.value, (n) => n.props.className === 'in-mod');
    expect(text(detail)).toContain('web');
    expect(text(detail)).toContain('Operator back office');
    expect(find(detail, (n) => typeName(n) === 'SourceRef').props.source).toBe('file:web/main.tsx');
    expect(text(detail)).toContain('3,610 行');
    expect(text(detail)).toContain('14 次，近 30 天');
    find(detail, (n) => n.props['aria-label'] === zh('memory.intro.module.unpick')).props.onClick();
    h.render();
    expect(has(h.value, (n) => typeName(n) === 'Treemap')).toBe(true);
  });

  it('leaves Esc to an open dialog first and drops the picked module on the next Esc', async () => {
    const h = await mountIntro();
    find(h.value, (n) => typeName(n) === 'Treemap').props.onPick('web');
    h.render();
    const inDialog = { closest: (selector: string) => (selector === '[role=dialog]' ? {} : null) };
    keys.forEach((key) => key({ key: 'Escape', defaultPrevented: false, target: inDialog }));
    h.render();
    expect(has(h.value, (n) => n.props.className === 'in-mod')).toBe(true);
    keys.forEach((key) =>
      key({ key: 'Escape', defaultPrevented: true, target: { closest: () => null } }),
    );
    h.render();
    expect(has(h.value, (n) => n.props.className === 'in-mod')).toBe(true);
    keys.forEach((key) =>
      key({ key: 'Escape', defaultPrevented: false, target: { closest: () => null } }),
    );
    h.render();
    expect(has(h.value, (n) => n.props.className === 'in-mod')).toBe(false);
  });
});

describe('source reference', () => {
  const mountRef = (source: string) =>
    mount(() => SourceRef({ source, base: '/work/refunds', className: 'in-ref' }));

  it('opens a file in the editor at its line, and says why when it cannot', async () => {
    const openFile = vi.fn(async () => ({
      ok: false,
      error: { code: 'file_not_found', message: 'src/a.ts is not a file' },
    }));
    (window as any).pantheon.openFile = openFile;
    const h = mountRef('file:src/a.ts:18');
    const button = find(h.value, (n) => n.type === 'button');
    expect(button.props.className).toBe('chip mono in-ref');
    expect(text(button)).toBe('src/a.ts:18');
    button.props.onClick();
    await h.flush();
    expect(openFile).toHaveBeenCalledWith({ path: 'src/a.ts', line: 18, base: '/work/refunds' });
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe(
      zh('components.markdown.fileNotFound'),
    );
    openFile.mockResolvedValueOnce({ ok: true, value: null } as any);
    find(h.value, (n) => n.type === 'button').props.onClick();
    await h.flush();
    expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('opens a file named without a line at its top', async () => {
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    (window as any).pantheon.openFile = openFile;
    const h = mountRef('file:package.json');
    find(h.value, (n) => n.type === 'button').props.onClick();
    await h.flush();
    expect(openFile).toHaveBeenCalledWith({ path: 'package.json', base: '/work/refunds' });
  });

  it('keeps a commit reference as text', () => {
    const h = mountRef('commit:6e9b7a3f00112233');
    expect(nodes(h.value).some((n) => n.type === 'button')).toBe(false);
    expect(text(h.value)).toBe('6e9b7a3');
  });
});

describe('module treemap', () => {
  it('draws each module as a button shaded in grey by its commits that picks it', () => {
    const onPick = vi.fn();
    const h = mount(() => Treemap({ modules: intro().modules, onPick }));
    const map = find(h.value, (n) => n.props.role === 'group');
    expect(map.props['aria-label']).toBe('3 个模块，10,690 行');
    const cells = nodes(map).filter((n) => n.type === 'button');
    expect(cells.map((c) => [c.props['aria-label'], c.props.style['--v']])).toEqual([
      ['src：6,820 行，近 30 天 46 次提交', 76],
      ['web：3,610 行，近 30 天 14 次提交', 56],
      ['scripts：260 行，近 30 天 0 次提交', 0],
    ]);
    expect(cells.map((c) => c.props['aria-pressed'])).toEqual([false, false, false]);
    expect(cells.map((c) => c.props['data-dark'])).toEqual([true, true, undefined]);
    cells[1]!.props.onClick();
    expect(onPick).toHaveBeenCalledWith('web');
  });

  it('shades five steps from no commits to twenty or more', () => {
    expect([0, 1, 3, 4, 9, 10, 19, 20, 400].map(commitShade)).toEqual([
      0, 18, 18, 36, 36, 56, 56, 76, 76,
    ]);
  });
});

describe('architecture diagram', () => {
  const spec = {
    nodes: [
      { id: 'web', label: 'Back office', group: 'frontend' },
      { id: 'api', label: 'API', group: 'service' },
      { id: 'redis', label: 'Redis', group: 'store' },
      { id: 'pg', label: 'PostgreSQL', group: 'store' },
      { id: 'pay', label: 'Channel', group: 'external' },
      { id: 'rec', label: 'Reconcile', group: 'job' },
    ],
    edges: [
      { from: 'web', to: 'api' },
      { from: 'api', to: 'redis' },
      { from: 'api', to: 'pg' },
      { from: 'api', to: 'pay' },
      { from: 'pay', to: 'api' },
      { from: 'rec', to: 'pg' },
      { from: 'rec', to: 'pay' },
    ],
  };

  it('draws an edge and the one back along it as one edge with two heads', () => {
    expect(
      mergeEdges([
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'c' },
      ]),
    ).toEqual([
      { from: 'a', to: 'b', both: true },
      { from: 'a', to: 'c', both: false },
    ]);
  });

  it('lays nodes in columns by their depth along the edges, 140 by 44 apart by 40 and 22', () => {
    const laid = archLayout(spec);
    expect([laid.width, laid.height]).toEqual([500, 200]);
    expect(laid.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ['web', 0, 12],
      ['api', 180, 12],
      ['redis', 360, 12],
      ['pg', 360, 78],
      ['pay', 360, 144],
      ['rec', 0, 78],
    ]);
    const path = (from: string, to: string) =>
      laid.edges.find((e) => e.from === from && e.to === to)!.d;
    expect(path('web', 'api')).toBe('M140 34H180');
    expect(path('api', 'pg')).toBe('M320 34C340 34 340 100 360 100');
    expect(laid.edges.filter((e) => e.both).map((e) => [e.from, e.to])).toEqual([['api', 'pay']]);
  });

  it('spaces columns and rows by the gap it is given, the default unchanged', () => {
    const chain = {
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const laid = archLayout(chain, { w: 72, h: 24 }, { x: 12, y: 8 });
    expect(laid.width).toBe(3 * 72 + 2 * 12);
    expect(laid.nodes.map((n) => n.x)).toEqual([0, 84, 168]);
    expect(laid.edges.map((e) => e.d)).toEqual(['M72 24H84', 'M156 24H168']);
    expect(archLayout(chain).width).toBe(3 * 140 + 2 * 40);
  });

  // Points along a path of M, H, V and C commands, every curve and line cut in 50 steps.
  const along = (d: string) => {
    const points: [number, number][] = [];
    let [x, y] = [0, 0];
    for (const [, op, args] of d.matchAll(/([MHVC])([^MHVC]*)/g)) {
      const n = args!
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const to = (ex: number, ey: number, at: (t: number) => [number, number]) => {
        for (let i = 1; i <= 50; i++) points.push(at(i / 50));
        [x, y] = [ex, ey];
      };
      const [x0, y0] = [x, y];
      if (op === 'M') [x, y] = [n[0]!, n[1]!];
      else if (op === 'H') to(n[0]!, y, (t) => [x0 + (n[0]! - x0) * t, y0]);
      else if (op === 'V') to(x, n[0]!, (t) => [x0, y0 + (n[0]! - y0) * t]);
      else {
        const bez = (a: number, b: number, c: number, e: number, t: number) =>
          (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * e;
        to(n[4]!, n[5]!, (t) => [bez(x0, n[0]!, n[2]!, n[4]!, t), bez(y0, n[1]!, n[3]!, n[5]!, t)]);
      }
    }
    return points;
  };
  /** The nodes an edge's drawn line passes through, its own two ends left out. */
  const crossed = (laid: ReturnType<typeof archLayout>) =>
    laid.edges.flatMap((edge) =>
      laid.nodes
        .filter((n) => n.id !== edge.from && n.id !== edge.to)
        .filter((n) =>
          along(edge.d).some(([px, py]) => px > n.x && px < n.x + 140 && py > n.y && py < n.y + 44),
        )
        .map((n) => `${edge.from}->${edge.to} through ${n.id}`),
    );

  it('draws an edge that skips a column around the nodes between, not through them', () => {
    const laid = archLayout({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
      ],
    });
    expect(laid.nodes.map((n) => n.y)).toEqual([12, 12, 12]);
    expect(crossed(laid)).toEqual([]);
    expect(crossed(archLayout(spec))).toEqual([]);
  });

  it('draws an edge between nodes of one column rows apart beside the column, within the diagram', () => {
    const laid = archLayout({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    });
    expect(laid.nodes.map((n) => [n.x, n.y])).toEqual([
      [0, 12],
      [0, 78],
      [0, 144],
    ]);
    expect(crossed(laid)).toEqual([]);
    const reach = Math.max(...laid.edges.flatMap((e) => along(e.d).map(([px]) => px)));
    expect(reach).toBeLessThanOrEqual(laid.width);
  });

  it('names the diagram by its node and edge counts and hands the whole spec to the graph renderer', () => {
    const h = mount(() => ArchDiagram({ spec }));
    const group = find(h.value, (n) => n.props.role === 'group');
    expect(group.props['aria-label']).toBe('架构图，6 个节点，7 条边');
    const graph = find(group, (n) => typeName(n) === 'GraphDiagram');
    expect(graph.props.spec).toBe(spec);
    expect(graph.props.grows).toBe(true);
  });
});
