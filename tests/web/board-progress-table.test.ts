import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
const box = vi.hoisted(() => ({ w: 0 }));
vi.mock('@/screens/board/Charts', async (actual) => ({
  ...(await actual<object>()),
  useSize: () => [() => {}, { w: box.w, h: 0 }],
}));
import { ProgressTable } from '@/screens/board/ProgressTable';
import { toastManager } from '@/components/Toast';
import { PullLink } from '@/screens/board/status';
import { zh, zhf } from './i18n-setup.js';

const NOW = new Date(2026, 10, 3, 0, 48).getTime();
const SINCE = new Date(2026, 9, 28).getTime();

const model = {
  since: SINCE,
  now: NOW,
  counts: { median_ms: null },
  lanes: [],
  tasks: [
    {
      id: 't1',
      title: 'split the tokenizer',
      goal: '',
      scope: [],
      lane_id: null,
      milestone_id: null,
      status: 'ready',
      blockers: [],
      segments: [],
      additions: 15,
      deletions: 0,
      checks: 'pass',
      started_at: null,
      ended_at: null,
    },
  ],
} as unknown as BoardModel;

const table = (width: number, shown: BoardModel = model) => {
  box.w = width;
  return renderToStaticMarkup(createElement(ProgressTable, { model: shown, onOpenTask() {} }));
};
const css = readFileSync(
  new URL('../../apps/web/src/screens/board/progress.css', import.meta.url),
  'utf8',
);
const HEADS = ['task', 'status', 'progress', 'changes', 'checks', 'duration']
  .map((column) => zh(`board.progress.columns.${column}`))
  .concat('');
const heads = (html: string) =>
  [...html.matchAll(/role="columnheader"[^>]*>(?:<button[^>]*>)?([^<]*)</g)].map((m) => m[1]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('progress table at narrow widths', () => {
  it('keeps the checks column on one line where the columns fit', () => {
    const html = table(850);
    expect(heads(html)).toEqual(HEADS);
    expect(html).toContain(`aria-label="${zh('board.progress.checks.pass')}"`);
    expect(html).toContain('class="bp-tin"');
  });

  it('stacks each row on two lines where the one-line columns no longer fit', () => {
    const html = table(570);
    expect(heads(html)).toEqual(HEADS);
    expect(css).toMatch(
      /@container bp-tbl \(width < 840px\) \{[^@]*\.bp-tr \{[^}]*grid-template-areas:/,
    );
  });

  it('draws the same rows whatever width was last measured, so a narrower box restacks them in its own frame', () => {
    const shape = (html: string) =>
      [...html.matchAll(/<[^>]*role="(?:table|rowgroup|row|cell)"[^>]*>/g)].map((m) => m[0]);
    expect(shape(table(570))).toEqual(shape(table(850)));
  });

  it('keeps every timeline label inside the axis, the newest day included', () => {
    const html = table(400);
    const labels = [...html.matchAll(/class="bp-tk" style="left:([\d.]+)(px|%)">([^<]*)</g)].map(
      (m) => [m[2] === '%' ? (Number(m[1]) / 100) * 400 : Number(m[1]), m[3]] as const,
    );
    expect(labels.at(-1)?.[1]).toBe('11-03');
    for (const [x] of labels) {
      expect(x).toBeGreaterThanOrEqual(22);
      expect(x).toBeLessThanOrEqual(400 - 22);
    }
  });
});

describe('progress table segments', () => {
  it('paints a running segment of the progress bar in the running status colour', () => {
    expect(css).toMatch(/\.bp-b-running \{\s*background: var\(--run\);/);
  });

  it.each([
    ['running', 'running'],
    ['blocked', 'failed'],
    ['waiting_approval', 'waiting'],
    ['merged', 'done'],
  ])('colours the one segment of a %s plan task by that state, not its session', (state, shown) => {
    const html = table(850, {
      ...model,
      tasks: [
        {
          ...model.tasks[0]!,
          status: 'ready',
          state,
          segments: [{ id: 's1', status: 'ready', started_at: null, ended_at: null }],
        },
      ],
    } as unknown as BoardModel);
    expect(html).toContain(`<i class="bp-b-${shown}"></i>`);
    expect(html).not.toContain('bp-b-ready');
    expect(html).toContain(`<span class="n">${shown === 'done' ? 1 : 0}/1</span>`);
  });
});

describe('progress table header', () => {
  it('gives the median duration of the done tasks the rows show', () => {
    const finished = {
      ...model,
      counts: { median_ms: 10 * 60_000 },
      tasks: [
        {
          ...model.tasks[0]!,
          status: 'done',
          started_at: NOW - 80 * 60_000,
          ended_at: NOW - 10 * 60_000,
        },
      ],
    } as unknown as BoardModel;
    const html = table(850, finished);
    expect(html).toMatch(/class="bp-cell c-dur" role="cell">1 小时 10 分</);
    expect(html).toContain('中位用时 <b>1</b> 小时 <b>10</b> 分');
  });
});

describe('progress table badges', () => {
  const withTask = (patch: object) =>
    ({ ...model, tasks: [{ ...model.tasks[0]!, ...patch }] }) as unknown as BoardModel;

  it('shows a task waiting on an upstream task without the blocked mark', () => {
    const html = table(
      850,
      withTask({
        status: 'todo',
        blockers: ['排队中：等待依赖', '依赖任务「parse the input」未完成'],
        blocked_since: NOW - 5 * 60_000,
      }),
    );
    expect(html).not.toContain('data-kind="blocked"');
    expect(html).toContain('data-kind="upstream"');
    expect(html).not.toContain('M4 1h4l3 3v4l-3 3H4L1 8V4z');
    expect(html).toContain('aria-label="排队中：等待依赖；依赖任务「parse the input」未完成"');
  });

  it('keeps the blocked mark on a started task with a merge problem', () => {
    const html = table(
      850,
      withTask({ status: 'running', blockers: ['合并受阻，2 个冲突文件'], blocked_since: null }),
    );
    expect(html).toContain('data-kind="blocked"');
  });

  it('leaves a blocked state to the status cell, which names the blockers on hover', () => {
    const html = table(
      850,
      withTask({ status: 'running', state: 'blocked', blockers: ['合并受阻，2 个冲突文件'] }),
    );
    expect(html).not.toContain('data-kind="blocked"');
    expect(html).toContain(
      `title="${zhf('board.task.badge.blocked', { reasons: '合并受阻，2 个冲突文件' })}"`,
    );
  });

  it.each([
    [
      'leaves an approval wait to the status cell and writes the command alone under the title',
      'approval',
      'waiting_approval',
      [],
      'pnpm migrate',
    ],
    [
      'keeps the question badge of a question the approval state holds, and says it awaits an answer',
      'input',
      'waiting_input',
      [zh('board.task.phase.waitingInput')],
      zhf('board.task.activity.waitingInputFor', { summary: 'pnpm migrate' }),
    ],
  ] as const)('%s', (_, kind, phase, waits, line) => {
    const html = table(
      850,
      withTask({
        status: 'waiting',
        state: 'waiting_approval',
        activity: {
          phase,
          since: NOW,
          health: 'fresh',
          attempt: 1,
          waiting: { kind, summary: 'pnpm migrate', approval_id: 'ap', since: NOW },
        },
      }),
    );
    expect(
      [...html.matchAll(/data-kind="waiting" role="img" aria-label="([^"]*)"/g)].map((m) => m[1]),
    ).toEqual(waits);
    expect(html).toContain(`title="${line}">${line}<`);
  });
});

describe('progress table status', () => {
  it('names a plan task by its state, as the flow chart does, not by its newest session', () => {
    const failed = {
      ...model,
      tasks: [{ ...model.tasks[0]!, status: 'todo', state: 'failed', owner_session_id: 'lead-1' }],
    } as unknown as BoardModel;
    const html = table(850, failed);
    expect(html).toContain(
      `aria-label="${zhf('board.progress.rowLabel', { task: 'split the tokenizer', status: zh('board.task.status.failed') })}"`,
    );
    expect(html).toMatch(/class="bp-cell c-status" role="cell">.*?>失败</);
    expect(html).not.toContain(zh('board.task.status.todo'));
  });
});

describe('progress table plan facts', () => {
  const planTask = (id: string, order: number, patch: object = {}) => ({
    ...model.tasks[0]!,
    id: `lead-1:${id}`,
    title: `task ${id}`,
    owner_session_id: 'lead-1',
    order,
    ...patch,
  });
  const plan = (...tasks: object[]) => ({ ...model, tasks }) as unknown as BoardModel;
  const row = (html: string, title: string) =>
    html.split('class="bp-tr bp-trw"').find((part) => part.includes(`>${title}<`))!;

  it('writes the estimate, links the pull request and marks a locked order', () => {
    const html = table(
      850,
      plan(
        planTask('a', 0, {
          estimate_ms: 90 * 60_000,
          order_locked: true,
          pr: { number: 12, url: 'https://github.com/acme/app/pull/12' },
        }),
        planTask('b', 1),
      ),
    );
    const locked = row(html, 'task a');
    expect(locked).toContain('预计 1 小时 30 分');
    expect(locked).toContain('href="https://github.com/acme/app/pull/12"');
    expect(locked).toContain('>#12<');
    expect(locked).toContain(`aria-label="${zh('board.task.orderLocked')}"`);
    const plain = row(html, 'task b');
    expect(plain).not.toContain('预计');
    expect(plain).not.toContain('href=');
    expect(plain).not.toContain(zh('board.task.orderLocked'));
  });

  it('opens the pull request through the desktop app without opening the row', () => {
    const url = 'https://github.com/acme/app/pull/12';
    const openLink = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('window', { pantheon: { openLink } });
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    PullLink({ pr: { number: 12, url } }).props.onClick(event);
    vi.unstubAllGlobals();
    expect(openLink).toHaveBeenCalledWith(url);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('shows why the pull request did not open', async () => {
    const add = vi.spyOn(toastManager, 'add').mockReturnValue('toast-a');
    const openLink = vi.fn(async () => ({
      ok: false,
      error: { code: 'link_refused', message: 'refused' },
    }));
    vi.stubGlobal('window', { pantheon: { openLink } });
    PullLink({ pr: { number: 12, url: 'https://github.com/acme/app/pull/12' } }).props.onClick({
      preventDefault() {},
      stopPropagation() {},
    });
    vi.unstubAllGlobals();
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ type: 'failure' })),
    );
    add.mockRestore();
  });

  it('keeps a locked row from dragging or offering its order menu, and leaves the others movable', () => {
    box.w = 850;
    const html = renderToStaticMarkup(
      createElement(ProgressTable, {
        model: plan(planTask('a', 0, { order_locked: true }), planTask('b', 1)),
        onOpenTask() {},
        projectId: 'project-a',
      }),
    );
    expect(row(html, 'task a')).not.toContain('draggable');
    expect(row(html, 'task a')).not.toContain(zhf('board.progress.order.menu', { task: 'task a' }));
    expect(row(html, 'task b')).toContain('draggable="true"');
  });
});

describe('progress table clock', () => {
  it('counts a running task up to the local clock when the board was read earlier', () => {
    const started = NOW - 10 * 60_000;
    const running = {
      ...model,
      tasks: [
        {
          ...model.tasks[0]!,
          status: 'running',
          started_at: started,
          segments: [
            { id: 's1', status: 'running', started_at: started, ended_at: null, runtime: null },
          ],
        },
      ],
    } as unknown as BoardModel;
    vi.setSystemTime(NOW + 50 * 60_000);
    expect(table(850, running)).toMatch(/class="bp-cell c-dur" role="cell">1 小时</);
  });
});
