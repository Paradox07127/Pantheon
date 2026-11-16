import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardActivity, BoardModel, BoardSegment, BoardTaskStatus } from '@pantheon/protocol';
import { TaskDrawer } from '../../apps/web/src/screens/board/TaskDrawer.js';
import { zh } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];

const NOW = Date.UTC(2026, 10, 3, 12);
const noop = () => {};
/** The drawer of the task, on a board holding only the given tasks. */
const drawer = (taskId: string, tasks: Task[], extra: object = {}) =>
  renderToStaticMarkup(
    createElement(TaskDrawer, {
      model: {
        now: NOW,
        lanes: [],
        edges: [],
        merges: [],
        tasks,
        ...extra,
      } as unknown as BoardModel,
      taskId,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
    }),
  );

const task = (id: string, status: BoardTaskStatus, patch: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status,
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

const stalled: BoardActivity = {
  phase: 'tool',
  since: NOW - 40 * 60_000,
  health: 'stalled',
  attempt: 1,
};

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The text of the element with the id, without its markup. */
function textById(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return '';
  const open = html.lastIndexOf('<', start);
  const tag = /^<([a-z]+)/.exec(html.slice(open))![1]!;
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = open;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return unescape(html.slice(open, m.index).replace(/<[^>]+>/g, ''));
  }
  return '';
}

/** Each button's accessible name and description, as a screen reader would announce them. */
function buttons(html: string) {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, body]) => {
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs!)?.[1];
    const refs = (name: string) =>
      (attr(name) ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => textById(html, id))
        .join(' ');
    const label = attr('aria-label');
    return {
      name: label
        ? unescape(label)
        : refs('aria-labelledby') || unescape(body!.replace(/<[^>]+>/g, '')),
      description: refs('aria-describedby'),
    };
  });
}

describe('task drawer badges', () => {
  it('spells out each badge the card shows only as an icon', () => {
    const html = drawer('blocked-stalled', [
      task('blocked-stalled', 'running', {
        activity: stalled,
        blockers: ['依赖任务「parse the input」未完成'],
      }),
    ]);
    // Tags hold the hover-only labels; only text between them is on screen.
    const visible = unescape(html.replace(/<[^>]+>/g, ' '));
    expect(visible).toContain('阻塞：依赖任务「parse the input」未完成');
    expect(visible).toContain(zh('board.task.health.stalled'));
  });

  it('spells out a task not started that waits on upstream without calling it blocked', () => {
    const html = drawer('waits', [
      task('waits', 'todo', {
        blockers: ['排队中：等待依赖'],
        dispatch_wait: 'upstream',
      }),
    ]);
    const visible = unescape(html.replace(/<[^>]+>/g, ' '));
    expect(visible).toContain('排队中：等待依赖');
    expect(visible).not.toContain('阻塞：');
    expect(html).toContain('data-kind="upstream"');
  });
});

describe('task drawer sessions', () => {
  it('name each session button by its visible title', () => {
    const segment = (id: string, title: string): BoardSegment => ({
      id,
      session_id: id,
      title,
      runtime: 'claude',
      model: 'claude-opus',
      status: 'running',
      started_at: NOW,
      ended_at: null,
      tokens: 0,
    });
    const html = drawer(
      'lead-1:importer',
      [
        task('lead-1:importer', 'running', {
          segments: [segment('s-1', 'parse the ledger'), segment('s-2', 'write the importer')],
        }),
      ],
      { since: NOW - 86_400_000 },
    );
    const names = buttons(html).map((b) => b.name);
    expect(names.some((n) => n.includes('parse the ledger'))).toBe(true);
    expect(names.some((n) => n.includes('write the importer'))).toBe(true);
  });

  it('do not claim no changes when a session ran but its changes were not measured', () => {
    const html = drawer(
      'lead-1:importer',
      [
        task('lead-1:importer', 'failed', {
          segments: [
            {
              id: 's-1',
              session_id: 's-1',
              title: 'parse the ledger',
              runtime: 'claude',
              model: 'claude-opus',
              status: 'failed',
              started_at: NOW,
              ended_at: NOW,
              tokens: 0,
            },
          ],
        }),
      ],
      { since: NOW - 86_400_000 },
    );
    expect(html).not.toContain(zh('board.task.drawer.noChanges'));
    expect(html).toContain(zh('board.task.drawer.changesUnknown'));
  });
});

describe('task drawer dependencies', () => {
  it('announce the status of each upstream and downstream task', () => {
    const html = drawer(
      'lead-1:importer',
      [
        task('lead-1:schema', 'failed'),
        task('lead-1:importer', 'running'),
        task('lead-1:report', 'done'),
      ],
      {
        since: NOW - 86_400_000,
        edges: [
          { from: 'lead-1:schema', to: 'lead-1:importer' },
          { from: 'lead-1:importer', to: 'lead-1:report' },
        ],
      },
    );
    const names = buttons(html).map((b) => `${b.name} ${b.description}`);
    const upstream = names.find((n) => n.includes('task lead-1:schema'));
    const downstream = names.find((n) => n.includes('task lead-1:report'));
    expect(upstream).toContain('失败');
    expect(downstream).toContain('完成');
  });
});
