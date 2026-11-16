import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ProjectFactsRead,
  ProjectHead,
  ProjectHeatmap,
  StaleWorkspaces,
  WorkbenchSession,
} from '@pantheon/protocol';
import { readInsightsSection } from '../../apps/web/src/screens/insights/InsightsScreen.js';
import { pickRepoTab, RepoScreen } from '../../apps/web/src/screens/repo/RepoScreen.js';
import {
  BranchPanel,
  MergeHeat,
  RepoKpis,
  RepoPanels,
} from '../../apps/web/src/screens/board/RepoCharts.js';
import { commitDays, docRows, hotspotRows } from '../../apps/web/src/screens/board/repo-model.js';
import { zh } from './i18n-setup.js';

type Facts = NonNullable<ProjectFactsRead['facts']>;
type Folder = Facts['folders'][number];

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);

const folder = (root: string, patch: Partial<Folder> = {}): Folder => ({
  root,
  git: true,
  commits_per_day: [],
  hotspots: [],
  recent_commits: [],
  file_types: [],
  directories: [],
  manifests: [],
  agent_instructions: [],
  docs: [],
  checklists: [],
  tests: { files: 0, configs: [] },
  ci: [],
  truncated: [],
  ...patch,
});

const facts = (...folders: Folder[]): Facts => ({ collected_at: NOW, folders });

const read = (
  value: Facts | null,
  workstreams: ProjectFactsRead['workstreams'] = [],
): ProjectFactsRead => ({
  facts: value,
  collected_at: value?.collected_at ?? null,
  empty: false,
  workstreams,
});

const titles = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('commit cadence', () => {
  it('stacks one series per Git folder, each in its own category color', () => {
    const { series, days } = commitDays(
      facts(
        folder('/work/app', {
          commits_per_day: [
            { date: '2026-11-02', count: 2 },
            { date: '2026-11-03', count: 1 },
          ],
        }),
        folder('/work/api', {
          commits_per_day: [
            { date: '2026-11-02', count: 0 },
            { date: '2026-11-03', count: 4 },
          ],
        }),
      ),
    );
    expect(series.map((s) => [s.label, s.color])).toEqual([
      ['app', 'var(--series-1)'],
      ['api', 'var(--series-2)'],
    ]);
    expect(days.map((d) => [d.day, d.parts.map((p) => p.count), d.total])).toEqual([
      ['2026-11-02', [2, 0], 2],
      ['2026-11-03', [1, 4], 5],
    ]);
  });

  it('draws no series for a folder without Git', () => {
    const { series, days } = commitDays(
      facts(
        folder('/work/notes', { git: false }),
        folder('/work/app', { commits_per_day: [{ date: '2026-11-03', count: 3 }] }),
      ),
    );
    expect(series.map((s) => [s.label, s.color])).toEqual([['app', 'var(--series-1)']]);
    expect(days.map((d) => d.parts.length)).toEqual([1]);
  });
});

describe('change hotspots', () => {
  it('ranks paths across folders by commit count and keeps the top ten', () => {
    const many = (prefix: string, counts: number[]) =>
      counts.map((commits, i) => ({ path: `${prefix}/${i}.ts`, commits }));
    const rows = hotspotRows(
      facts(
        folder('/work/app', { hotspots: many('app', [9, 7, 5, 3, 1, 1]) }),
        folder('/work/notes', { git: false }),
        folder('/work/api', { hotspots: many('api', [12, 8, 6, 4, 2, 2]) }),
      ),
    );
    expect(rows.map((r) => r.commits)).toEqual([12, 9, 8, 7, 6, 5, 4, 3, 2, 2]);
    expect(rows[0]).toMatchObject({ path: 'api/0.ts', share: 1 });
    expect(rows[0]!.series.color).toBe('var(--series-2)');
    expect(rows[1]).toMatchObject({ path: 'app/0.ts', share: 9 / 12 });
    expect(rows[1]!.series.color).toBe('var(--series-1)');
  });
});

describe('doc age', () => {
  it('lists the oldest doc first with the longest bar, stale past ninety days', () => {
    const rows = docRows(
      facts(
        folder('/work/app', {
          docs: [
            { path: 'README.md', headings: [], modified_at: NOW - 30 * DAY },
            { path: 'docs/old.md', headings: [], modified_at: NOW - 120 * DAY },
          ],
        }),
        folder('/work/notes', {
          git: false,
          docs: [{ path: 'today.md', headings: [], modified_at: NOW }],
        }),
      ),
      NOW,
    );
    expect(rows.map((r) => [r.path, r.share, r.stale])).toEqual([
      ['docs/old.md', 1, true],
      ['README.md', 0.25, false],
      ['today.md', 0, false],
    ]);
    expect(rows.map((r) => r.age_days)).toEqual([120, 30, 0]);
    expect(rows[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('paths in several folders', () => {
  const twoFolders = facts(
    folder('/work/app', {
      hotspots: [{ path: 'src/main.ts', commits: 3 }],
      docs: [{ path: 'README.md', headings: [], modified_at: NOW - 10 * DAY }],
    }),
    folder('/work/api', {
      hotspots: [{ path: 'src/main.ts', commits: 2 }],
      docs: [{ path: 'README.md', headings: [], modified_at: NOW - 100 * DAY }],
    }),
  );

  it('names the folder of each doc and hotspot when the project has more than one', () => {
    expect(docRows(twoFolders, NOW).map((r) => r.label)).toEqual([
      'api/README.md',
      'app/README.md',
    ]);
    expect(hotspotRows(twoFolders).map((r) => r.label)).toEqual([
      'app/src/main.ts',
      'api/src/main.ts',
    ]);
    const html = renderToStaticMarkup(
      createElement(RepoPanels, { read: read(twoFolders), now: NOW }),
    );
    expect(html).toContain('aria-label="api/README.md：100 天未改"');
    expect(html).toContain('aria-label="api/src/main.ts：2 次提交"');
    expect(html).toContain('title="api/README.md">api/README.md</span>');
  });

  it('keeps the bare path in a project with one folder', () => {
    const one = facts(
      folder('/work/app', { docs: [{ path: 'README.md', headings: [], modified_at: NOW }] }),
    );
    expect(docRows(one, NOW).map((r) => r.label)).toEqual(['README.md']);
  });
});

describe('repository panels', () => {
  const measured = facts(
    folder('/work/app', {
      commits_per_day: [{ date: '2026-11-03', count: 1 }],
      hotspots: [{ path: 'src/main.ts', commits: 3 }],
      docs: [{ path: 'README.md', headings: [], modified_at: NOW - 100 * DAY }],
    }),
  );

  it('shows commit cadence, workstreams, hotspots and doc age with labelled charts', () => {
    const html = renderToStaticMarkup(
      createElement(RepoPanels, {
        read: read(measured, [
          { id: 'w1', title: 'Login', status: 'running', done: 1, open: 2, missing: 0 },
        ]),
        now: NOW,
      }),
    );
    expect(titles(html)).toEqual([
      zh('board.commits.title'),
      zh('board.repo.workstreams'),
      zh('board.hotspots.title'),
      zh('board.docs.title'),
    ]);
    expect(html).toContain('aria-label="src/main.ts：3 次提交"');
    expect(html).toContain('aria-label="README.md：100 天未改"');
  });

  it('hides the workstream panel when there are no workstreams', () => {
    const html = renderToStaticMarkup(
      createElement(RepoPanels, { read: read(measured), now: NOW }),
    );
    expect(titles(html)).toEqual([
      zh('board.commits.title'),
      zh('board.hotspots.title'),
      zh('board.docs.title'),
    ]);
  });

  it('says only that nothing was measured yet, leaving the baseline start to the setup', () => {
    const html = renderToStaticMarkup(
      createElement(RepoPanels, {
        read: read(null, [
          { id: 'w1', title: 'Login', status: 'running', done: 1, open: 2, missing: 0 },
        ]),
        now: NOW,
      }),
    );
    expect(titles(html)).toEqual([zh('board.repo.title')]);
    expect(html).toContain(zh('board.repo.noBaseline'));
    expect(html).not.toContain('</button>');
  });
});

describe('worktrees and branches', () => {
  const session = (id: string, patch: Partial<WorkbenchSession> = {}): WorkbenchSession =>
    ({
      id,
      title: `Session ${id}`,
      runtime: 'claude',
      workspace_id: `w-${id}`,
      workspace_kind: 'linked_worktree',
      state: 'idle',
      waiting: 0,
      reconciling: false,
      stopping: false,
      last_activity_at: new Date(NOW - DAY).toISOString(),
      changes: null,
      merge: null,
      ...patch,
    }) as WorkbenchSession;
  const sessions = [
    session('list', {
      branch: 'feature/list',
      ahead: 3,
      behind: 0,
      state: 'ready',
      last_activity_at: new Date(NOW - 60_000).toISOString(),
      changes: { files: 4, additions: 120, deletions: 15 },
    }),
    session('signature', { branch: 'feature/sign', ahead: 5, behind: 2 }),
    session('report', {
      branch: null,
      title: 'Weekly report',
      ahead: 7,
      behind: 5,
      changes: { files: 1, additions: 0, deletions: 37 },
    }),
    session('archived', {
      branch: 'feature/old',
      behind: 9,
      archived_at: new Date(NOW).toISOString(),
    }),
    session('merged', { branch: 'feature/merged', behind: 8, state: 'merged' }),
    session('discarded', { branch: 'feature/gone', behind: 7, state: 'discarded' }),
    session('in-place', { workspace_kind: 'in_place', behind: 6 }),
  ];
  const head: ProjectHead = {
    branch: 'main',
    sha: 'a1b2c3d4e5f6',
    subject: 'Land the list',
    committed_at: NOW - 12 * 60_000,
    uncommitted: 0,
  };

  it('names the checked out commit and its age, counts kept worktrees and the branches behind', () => {
    const html = renderToStaticMarkup(
      createElement(RepoKpis, { head, sessions, stale: { count: 2 }, now: NOW }),
    );
    expect(html).toContain(
      '<span class="bd-kpi-k">main</span><span class="bd-kpi-v"><b class="rp-sha">a1b2c3d</b><span class="bd-kpi-n">12 分钟</span>',
    );
    expect(html).toContain('工作树</span><span class="bd-kpi-v"><b>3</b></span>');
    expect(html).toContain(
      '落后源分支</span><span class="bd-kpi-v"><b>2</b><span class="bd-kpi-n">最多落后 5</span>',
    );
  });

  it('shows dashes until the head and the sessions are read', () => {
    const html = renderToStaticMarkup(
      createElement(RepoKpis, { head: null, sessions: null, stale: null, now: NOW }),
    );
    expect([...html.matchAll(/<b[^>]*>([^<]*)<\/b>/g)].map((m) => m[1])).toEqual([
      '—',
      '—',
      '—',
      '—',
    ]);
  });

  const worktreesCell = (stale: StaleWorkspaces) =>
    renderToStaticMarkup(createElement(RepoKpis, { head, sessions, stale, now: NOW })).match(
      /工作树<\/span><span class="bd-kpi-v">(.*?)<\/span><\/div>/,
    )![1];

  it('puts the disk all worktrees take beside their count once each is measured', () => {
    expect(
      worktreesCell({
        count: 0,
        worktree_disk: { count: 6, size_bytes: 1.2 * 1024 ** 3, unmeasured: 0 },
      }),
    ).toBe('<b>3</b><span class="bd-kpi-n">1.2 GB</span>');
    expect(
      worktreesCell({
        count: 0,
        worktree_disk: { count: 6, size_bytes: 1024 ** 3, unmeasured: 2 },
      }),
    ).toBe('<b>3</b>');
    expect(worktreesCell({ count: 2 })).toBe('<b>3</b>');
  });

  const conflicts = (files: string[], total = files.length) => ({
    predicted_conflicts: { files, total },
  });
  const conflictCell = (list: WorkbenchSession[] | null) =>
    renderToStaticMarkup(
      createElement(RepoKpis, { head, sessions: list, stale: null, now: NOW }),
    ).match(/会冲突<\/span><span class="bd-kpi-v">(.*?)<\/span><\/div>/)![1];

  it('counts the worktrees whose branch would conflict, naming the first file', () => {
    expect(conflictCell(null)).toBe('<b>—</b>');
    expect(
      conflictCell([
        session('older', {
          last_activity_at: new Date(NOW - 2 * DAY).toISOString(),
          ...conflicts(['b.ts']),
        }),
        session('newer', conflicts(['refunds/service.ts', 'a.ts'], 4)),
        session('clean', conflicts([])),
        session('unread'),
      ]),
    ).toBe(
      '<b class="rp-bad">2</b><span class="bd-kpi-n rp-file" title="refunds/service.ts">refunds/service.ts</span>',
    );
    expect(conflictCell([session('clean', conflicts([])), session('unread')])).toBe('<b>0</b>');
  });

  const branchRows = (list: WorkbenchSession[], base?: string | null) =>
    [
      ...renderToStaticMarkup(
        createElement(BranchPanel, {
          projectId: 'p',
          sessions: list,
          stale: { read: { count: 0 }, reload() {} },
          base,
        }),
      ).matchAll(/<div class="rp-row rp-br">(.*?)<\/div>/gs),
    ].map((m) => m[1]!);

  it('puts a conflict chip where a conflicting branch shows its distance', () => {
    const rows = branchRows(
      [
        session('conflict', {
          branch: 'feature/refund',
          ahead: 2,
          behind: 1,
          ...conflicts(['refunds/service.ts', 'a.ts'], 5),
        }),
        session('clean', {
          branch: 'feature/clean',
          ahead: 1,
          behind: 0,
          last_activity_at: new Date(NOW - 2 * DAY).toISOString(),
          ...conflicts([]),
        }),
      ],
      'main',
    );
    expect(rows[0]).toContain(
      '<span class="chip rp-cf" title="refunds/service.ts\na.ts\n另有 3 个">与 main 冲突</span>',
    );
    expect(rows[0]).not.toContain('领先');
    expect(rows[1]).toContain('<span class="rp-n">领先 1，落后 0</span>');
    expect(rows[1]).not.toContain('rp-cf');
  });

  it('says only that it will conflict when the head branch is unknown', () => {
    const [row] = branchRows([session('conflict', conflicts(['a.ts']))], null);
    expect(row).toContain('<span class="chip rp-cf" title="a.ts">会冲突</span>');
  });

  it('lists each kept worktree with its branch, distance and changes, the title for a detached one', () => {
    const html = renderToStaticMarkup(
      createElement(BranchPanel, {
        projectId: 'p',
        sessions,
        stale: { read: { count: 2 }, reload() {} },
      }),
    );
    expect(titles(html)).toEqual([zh('insights.repo.branches')]);
    const rows = [...html.matchAll(/<div class="rp-row rp-br">(.*?)<\/div>/g)].map((m) => m[1]!);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('<span class="rp-path" title="feature/list">feature/list</span>');
    expect(rows[0]).toContain('<span class="rp-n">领先 3，落后 0</span>');
    expect(rows[0]).toContain('<span class="df-add">+120</span><span class="df-del">−15</span>');
    expect(rows[1]).toContain('<span class="rp-diff"></span>');
    expect(rows[2]).toContain('<span class="rp-name" title="Weekly report">');
    expect(rows[2]).toContain('<span class="df-add" data-zero="true">+0</span>');
    expect(html).toMatch(/<button type="button" class="btn ghost sm">清理过期工作树…<\/button>/);
  });

  it('holds the cleanup while no worktree is stale', () => {
    const html = renderToStaticMarkup(
      createElement(BranchPanel, {
        projectId: 'p',
        sessions: [],
        stale: { read: { count: 0 }, reload() {} },
      }),
    );
    expect(html).toContain(zh('insights.repo.noWorktrees'));
    expect(html).toMatch(/<button type="button" class="btn ghost sm" disabled="">/);
  });
});

describe('merge heat', () => {
  const days = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(2026, 10, 3 - 89 + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const commit = (
    sha: string,
    day: string,
    lane_key: string | null,
    via: ProjectHeatmap['commits'][number]['via'],
  ): ProjectHeatmap['commits'][number] => ({
    sha,
    at: Date.parse(`${day}T12:00:00`),
    day,
    lane_key,
    via,
    added: 1,
    removed: 0,
    subject: sha,
  });
  const merge = (
    id: string,
    day: string,
    session_id: string,
  ): ProjectHeatmap['merges'][number] => ({
    id,
    session_id,
    at: Date.parse(`${day}T12:00:00`),
    day,
  });
  const heatmap = (
    merges: ProjectHeatmap['merges'],
    commits: ProjectHeatmap['commits'] = [],
  ): ProjectHeatmap => ({
    days,
    lanes: [],
    hours: [],
    commits,
    merges,
  });

  const twelveWeeks = { days: 84, span: '12 周' };

  it('counts each recorded merge on the day it merged over twelve weeks', () => {
    const html = renderToStaticMarkup(
      createElement(MergeHeat, {
        ...twelveWeeks,
        heatmap: heatmap(
          [
            merge('m1', days[80]!, 'worker'),
            merge('m2', days[86]!, 'lead'),
            merge('m3', days[88]!, 'lead'),
            merge('m4', days[88]!, 'lead'),
            merge('m5', days[2]!, 'earlier'),
          ],
          [commit('a', days[10]!, 'worker', 'merge')],
        ),
      }),
    );
    expect(html).toContain('role="img" aria-label="过去 12 周每天的合并，共 4 次"');
    expect(html).toContain('12 周共 4 次');
    const levels = [...html.matchAll(/<i class="rp-hc" data-l="(\d)"/g)].map((m) => m[1]);
    expect(levels).toHaveLength(84);
    expect(levels.filter((l) => l !== '0')).toEqual(['2', '2', '4']);
  });

  it('names each month under the first week that starts in it', () => {
    const html = renderToStaticMarkup(
      createElement(MergeHeat, {
        ...twelveWeeks,
        heatmap: heatmap([]),
      }),
    );
    expect([...html.matchAll(/>(\d+月)</g)].map((m) => m[1])).toEqual(['9月', '10月']);
  });

  const shared = (total: number): StaleWorkspaces['shared_files'] => ({
    files: Array.from({ length: Math.min(total, 50) }, (_, i) => ({
      path: `src/file-${i}.ts`,
      session_ids: i === 0 ? ['a', 'b', 'c'] : ['a', 'b'],
    })),
    total,
  });

  it('lists five files several sessions change under the heat, and how many more', () => {
    const html = renderToStaticMarkup(
      createElement(MergeHeat, {
        ...twelveWeeks,
        heatmap: heatmap([]),
        shared: shared(8),
      }),
    );
    expect(html).toContain(zh('insights.repo.sharedFiles'));
    const rows = [...html.matchAll(/<div class="rp-sfr">(.*?)<\/div>/g)].map((m) => m[1]!);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain('<span class="rp-path" title="src/file-0.ts">src/file-0.ts</span>');
    expect(rows[0]).toContain('<span class="rp-n">3 个会话</span>');
    expect(rows[4]).toContain('src/file-4.ts');
    expect(html).toContain('<div class="rp-sfm">另有 3 个</div>');
  });

  it('draws no shared file block when none or none read', () => {
    for (const value of [shared(0), undefined]) {
      const html = renderToStaticMarkup(
        createElement(MergeHeat, {
          ...twelveWeeks,
          heatmap: heatmap([]),
          shared: value,
        }),
      );
      expect(html).not.toContain('<hr');
      expect(html).not.toContain(zh('insights.repo.sharedFiles'));
    }
  });
});

describe('repository tab', () => {
  it('moves from the engineering board to the overview tab of the repository page', () => {
    pickRepoTab('repo-overview-tab', 'overview');
    const html = renderToStaticMarkup(
      createElement(RepoScreen, { projectId: 'repo-overview-tab', onOpenSession() {} }),
    );
    const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tabs).toEqual(
      ['timeline', 'changes', 'compare', 'overview', 'pulls'].map((k) => zh(`repo.tabs.${k}`)),
    );
    expect(titles(html)).toEqual([zh('board.repo.title')]);
    expect(readInsightsSection('repo')).toBe('iterations');
  });
});

describe('repository stylesheet', () => {
  const css = readFileSync(
    new URL('../../apps/web/src/screens/board/repo.css', import.meta.url),
    'utf8',
  );
  it.each([
    ['sets paths in the monospace font', '.rp-path', 'font-family', 'var(--font-mono)'],
    ['marks the failure colour in the stylesheet', '.bd-kpi-v .rp-bad', 'color', 'var(--bad)'],
  ])('%s', (_name, selector, property, value) => {
    const rule = css.split(`\n${selector} {`)[1]?.split('}')[0];
    expect(rule).toContain(`${property}: ${value};`);
  });
});
