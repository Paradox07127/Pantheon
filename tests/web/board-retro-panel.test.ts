import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Improvement, Retrospective } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';

const mock = vi.hoisted(() => ({
  improvements: null as Improvement[] | null,
  retrospectives: {
    data: null as Retrospective[] | null,
    loading: false,
    error: null as string | null,
  },
  asked: [] as unknown[],
}));
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useImprovements: () => ({
    read: mock.improvements,
    error: null,
    unavailable: false,
    loading: false,
    reload() {},
  }),
  useTaskRetrospectives: (key: unknown) => {
    mock.asked.push(key);
    return { ...mock.retrospectives, reload() {} };
  },
}));
import { useCurrentProject } from '@/data/current-project';
import { RetroGates, RetroPanel, type RetroTask } from '@/screens/board/RetroPanel';
import { openBoardTab } from '@/screens/settings/settings-jump';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 10, 12);
const HOUR = 3_600_000;

const task = (name: string, patch: Partial<Task>): Task => ({
  id: `lead-a:${name}`,
  owner_session_id: 'lead-a',
  title: `task ${name}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'done',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...patch,
});

const TASKS: Task[] = [
  task('older', {
    ended_at: NOW - 3 * HOUR,
    claim: { session_id: 's-older', runtime: 'codex', model: 'gpt-older' },
    retrospective: {
      id: 'retro-older',
      outcome: 'merged',
      gate_passed_on_attempt: 1,
      handbacks: 0,
      tokens: 12_000,
    },
  }),
  task('open', { status: 'running', state: 'running' }),
  task('newest', {
    ended_at: NOW - HOUR,
    claim: { session_id: 's-newest', runtime: 'claude', model: 'claude-newest' },
    retrospective: {
      id: 'retro-newest',
      outcome: 'merged',
      gate_passed_on_attempt: 3,
      handbacks: 2,
      tokens: 1_500_000,
    },
  }),
  task('dropped', {
    status: 'discarded',
    ended_at: NOW - 2 * HOUR,
    retrospective: { id: 'retro-dropped', outcome: 'removed', handbacks: 2 },
  }),
];

const model = (tasks: Task[]) => ({ now: NOW, tasks }) as BoardModel;

const improvement = (id: string, status: Improvement['status'], retros: string[]) =>
  ({
    id,
    project_id: 'project-a',
    source: 'daemon',
    retrospective_ids: retros,
    status,
    change: { type: 'experience', procedure: 'p' },
  }) as unknown as Improvement;

const render = (tasks: Task[]) =>
  renderToStaticMarkup(
    createElement(RetroPanel, {
      model: model(tasks),
      projectId: 'project-a',
      onOpenTask() {},
    }),
  );

/** Each row's markup, top to bottom. */
const rows = (html: string) => html.split('<li class="ret-row').slice(1);

beforeEach(() => {
  mock.improvements = [
    improvement('imp-1', 'candidate', ['retro-newest', 'retro-older']),
    improvement('imp-2', 'trial', ['retro-newest']),
    improvement('imp-3', 'trial', ['retro-x', 'retro-newest']),
    improvement('imp-4', 'active', ['retro-newest']),
    improvement('imp-5', 'rejected', ['retro-newest']),
    improvement('imp-6', 'candidate', ['retro-x']),
  ];
  mock.retrospectives = { data: null, loading: false, error: null };
  mock.asked = [];
});

describe('board retrospective panel', () => {
  it('lists the tasks with a retrospective, the latest ended first', () => {
    const list = rows(render(TASKS));
    expect(list).toHaveLength(3);
    expect(list.map((r) => /task (\w+)/.exec(r)?.[1])).toEqual(['newest', 'dropped', 'older']);
    expect(list[0]).toContain('claude-newest');
    expect(list[1]).toContain('aria-label="已丢弃"');
  });

  it('draws one gate pip per attempt, the last one passed', () => {
    const [newest, dropped, older] = rows(render(TASKS));
    const pips = (row: string) =>
      [...row.matchAll(/class="ret-pip" data-s="(\w+)"/g)].map((m) => m[1]);
    expect(pips(newest!)).toEqual(['bad', 'bad', 'ok']);
    expect(newest).toContain('aria-label="门禁第 3 次通过"');
    expect(pips(older!)).toEqual(['ok']);
    expect(pips(dropped!)).toEqual([]);
  });

  it.each([
    [
      'shows the handbacks and tokens of each task',
      ['aria-label="交回 2 次"', 'aria-label="1.5M tokens"'],
      ['aria-label="交回 0 次"', 'aria-label="12k tokens"'],
      'tokens"',
    ],
    [
      'counts the improvements each retrospective led to by status, and nothing without any',
      ['aria-label="改进：待确认 1，试用中 2，已生效 1"'],
      ['aria-label="改进：待确认 1"'],
      'ret-xp',
    ],
  ])('%s', (_name, inNewest, inOlder, notInDropped) => {
    const [newest, dropped, older] = rows(render(TASKS));
    for (const part of inNewest) expect(newest).toContain(part);
    for (const part of inOlder) expect(older).toContain(part);
    expect(dropped).not.toContain(notInDropped);
  });

  it('names the handbacks and tokens as focusable images and mutes zero tokens like zero handbacks', () => {
    const free = task('free', {
      ended_at: NOW,
      retrospective: { id: 'retro-free', outcome: 'merged', handbacks: 0, tokens: 0 },
    });
    const [zero, newest] = rows(render([...TASKS, free]));
    const figure = (row: string | undefined, label: string) =>
      new RegExp(`<span[^>]*aria-label="${label}"[^>]*>`).exec(row ?? '')?.[0] ?? '';
    for (const label of ['交回 2 次', '1.5M tokens']) {
      expect(figure(newest, label)).toContain('role="img"');
      expect(figure(newest, label)).toContain('tabindex="0"');
    }
    for (const label of ['交回 0 次', '0 tokens']) {
      expect(figure(zero, label)).toContain('role="img"');
      expect(figure(zero, label)).toContain('data-zero="true"');
    }
  });

  it('titles the panel by the tasks it lists rather than by its tab', () => {
    const html = render(TASKS);
    expect(html).toContain(`>${zh('board.task.retro.listTitle')}<`);
    expect(html).not.toContain('>复盘<');
  });

  it.each([
    [
      'leaves the expand column empty in a row that cannot open beside one that can',
      TASKS,
      2,
      '<span></span>',
    ],
    ['drops the expand column when no row of the list can open', [TASKS[0]!], 0, '<button'],
  ])('%s', (_name, tasks, at, first) => {
    const row = rows(render(tasks))[at]!;
    expect(row.slice(row.indexOf('>') + 1).startsWith(first)).toBe(true);
  });

  it('sums up first-try gate passes over the retrospectives and the mean handbacks', () => {
    const html = render(TASKS);
    expect(html).toContain('aria-label="首轮门禁通过 1 / 3"');
    expect(html).toContain('aria-label="平均交回 1.3 次"');
  });

  it('counts the proposals waiting for a decision next to the title', () => {
    expect(render(TASKS)).toContain('aria-label="2 条提案等待决定"');
    mock.improvements = [improvement('imp-2', 'trial', ['retro-newest'])];
    expect(render(TASKS)).not.toContain('提案等待决定');
  });

  it('opens the retrospective the board was asked for, and only that one', () => {
    useCurrentProject.setState({ projectId: 'project-a' });
    openBoardTab('retro', 'retro-newest');
    const [newest, dropped, older] = rows(render(TASKS));
    expect(newest).toContain('aria-expanded="true"');
    expect(newest).toContain('class="ret-dt"');
    expect(dropped).toContain('aria-expanded="false"');
    expect(dropped).not.toContain('ret-dt');
    expect(older).not.toContain('ret-dt');
  });

  it('shows the empty state without any retrospective', () => {
    const html = render([task('open', { status: 'running' })]);
    expect(html).toContain('bp-empty');
    expect(html).not.toContain('ret-row');
    expect(html).not.toContain('首轮门禁通过');
  });
});

describe('retrospective gate failures', () => {
  const newest = TASKS[2] as RetroTask;
  const gates = () =>
    renderToStaticMarkup(createElement(RetroGates, { projectId: 'project-a', task: newest }));

  it('reads the retrospectives of the plan task and lists each failed gate run', () => {
    mock.retrospectives.data = [
      {
        id: 'retro-newest',
        gate_failures: ['environment', 'code'],
        gate_failed_checks: ['install', 'unit tests'],
      } as Retrospective,
    ];
    const html = gates();
    expect(mock.asked[0]).toEqual({ project_id: 'project-a', task_id: 'newest' });
    const items = html.split('<li').slice(1);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('install');
    expect(items[0]).toContain(zh('board.task.retro.failureEnvironment'));
    expect(items[1]).toContain('unit tests');
    expect(items[1]).toContain(zh('board.task.retro.failureCode'));
  });

  it('shows the failed read with a retry instead of an empty list', () => {
    mock.retrospectives.error = '读取失败（boom）';
    const html = gates();
    expect(html).toContain('role="alert"');
    expect(html).toContain('读取失败（boom）');
    expect(html).toContain(zh('board.query.retry'));
    expect(html).not.toContain('<li');
  });
});
