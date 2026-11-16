import { afterEach, expect, it, vi } from 'vitest';
import type { MemoryJob } from '@pantheon/domain';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
import { DeliveryList, EntriesFooter, type DeliverySession } from '@/screens/memory/EntriesFooter';
import { EntriesEmpty, EntriesError, EntriesLoading } from '@/screens/memory/EntryStates';
import { zh } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 10, 30, 0).getTime();
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

const session = (
  id: string,
  delivered: boolean,
  memory_tool = true,
  runtime = 'claude',
): DeliverySession => ({
  id,
  title: `title of ${id}`,
  delivered,
  prepared: delivered,
  memory_tool,
  stale: false,
  runtime,
});
const SESSIONS = [
  session('lead', true),
  session('review', true, true, 'codex'),
  session('worker', false),
  session('frontend', false, false, 'agy'),
];
const job = (patch: Partial<MemoryJob>): MemoryJob =>
  ({
    id: 'job-1',
    revision: 1,
    project_id: 'project-a',
    signature: 'sig-now',
    state: 'done',
    attempts: 1,
    created_at: NOW - 60_000,
    ...patch,
  }) as MemoryJob;

function footer(
  directory: Partial<Parameters<typeof EntriesFooter>[0]['directory']> = {},
  sessions = SESSIONS,
) {
  const calls = { open: vi.fn(), overview: vi.fn(), retry: vi.fn() };
  const h = mount(() =>
    EntriesFooter({
      directory: {
        signature: 'sig-now',
        jobs: [],
        document_ready: false,
        index_pending: 0,
        ...directory,
      },
      sessions,
      onOpenSession: calls.open,
      onOpenOverview: calls.overview,
      onRetryDocument: calls.retry,
    }),
  );
  return { h, calls };
}

it('counts delivered and waiting sessions on the delivery button, and names all three in its label', () => {
  vi.useFakeTimers({ now: NOW });
  const { h } = footer();
  const trigger = find(h.value, (n) => n.props['aria-label']?.startsWith('送达情况'));
  expect(trigger.props['aria-label']).toBe(
    '送达情况：2 个会话已送达，1 个等下一轮，1 个没有记忆工具',
  );
  expect(text(trigger)).toBe('2 个会话已送达，1 个等下一轮');
  const bar = find(trigger, (n) => n.props.role === 'img');
  expect(bar.props['aria-label']).toBe('送达 2，等下一轮 1，没有记忆工具 1');
  expect(
    nodes(bar.props.children).map((n) => [n.props['data-tone'], n.props.style['--n']]),
  ).toEqual([
    ['ok', 2],
    ['wait', 1],
    ['idle', 1],
  ]);
});

it('groups the delivery list into delivered, waiting and no memory tool, and opens a session from its row', () => {
  const open = vi.fn();
  const tree = DeliveryList({ sessions: SESSIONS, onOpenSession: open });
  const heads = nodes(tree).filter((n) => n.props.className === 'mef-h');
  expect(heads.map(text)).toEqual(['已送达2', '等下一轮1', '这个会话没有记忆工具1']);
  const rows = nodes(tree).filter((n) => n.type === 'button');
  expect(rows.map(text)).toEqual([
    'title of lead',
    'title of review',
    'title of worker',
    'title of frontend',
  ]);
  expect(rows.map((r) => named(r, 'RuntimeGlyph').props.runtime)).toEqual([
    'claude',
    'codex',
    'claude',
    'agy',
  ]);
  rows[2]!.props.onClick();
  expect(open).toHaveBeenCalledWith('worker');
});

it('leaves out a delivery group with no sessions', () => {
  const tree = DeliveryList({ sessions: [session('lead', true)], onOpenSession() {} });
  expect(
    nodes(tree)
      .filter((n) => n.props.className === 'mef-h')
      .map(text),
  ).toEqual(['已送达1']);
});

it('links the updated progress document to the overview, with the time it was written', () => {
  vi.useFakeTimers({ now: NOW });
  const at = new Date(2026, 10, 13, 10, 27).getTime();
  const { h, calls } = footer({
    document_ready: true,
    index_pending: 1,
    jobs: [job({ signature: 'sig-old', completed_at: NOW - 1000 }), job({ completed_at: at })],
  });
  const doc = find(h.value, (n) => n.props.className === 'mef-doc');
  expect(text(doc)).toBe('进度文档已更新10:27');
  doc.props.onClick();
  expect(calls.overview).toHaveBeenCalledOnce();
  expect(text(find(h.value, (n) => n.props.className === 'mef-idx'))).toBe('1 条还没进索引');
  expect(
    nodes(h.value)
      .filter((n) => n.props.className === 'kbd')
      .map(text),
  ).toEqual(['J', 'K']);
  expect(nodes(h.value).filter((n) => n.props.className === 'mef-vsep')).toHaveLength(2);
});

it('shows the progress document being written with its attempt and the time spent', () => {
  vi.useFakeTimers({ now: NOW });
  const { h } = footer({ jobs: [job({ state: 'running', attempts: 1, created_at: NOW - 4000 })] });
  const doc = find(h.value, (n) => n.props.className === 'mef-doc-run');
  expect(text(doc)).toBe('进度文档生成中第 1 次，已用 4 秒');
  vi.advanceTimersByTime(3000);
  h.render();
  expect(text(find(h.value, (n) => n.props.className === 'mef-doc-run'))).toContain('已用 7 秒');
});

it('counts the next attempt while a failed write waits to be retried', () => {
  vi.useFakeTimers({ now: NOW });
  const { h } = footer({ jobs: [job({ state: 'pending', attempts: 2, created_at: NOW - 9000 })] });
  expect(text(find(h.value, (n) => n.props.className === 'mef-doc-run'))).toContain('第 3 次');
});

it('alerts that the progress document failed, with the attempts, the error and a retry', () => {
  vi.useFakeTimers({ now: NOW });
  const { h, calls } = footer({
    jobs: [job({ state: 'failed', attempts: 3, error: 'lease expired' })],
  });
  const alert = find(h.value, (n) => n.props.role === 'alert');
  expect(text(alert)).toContain('进度文档生成失败，试了 3 次');
  expect(text(find(alert, (n) => n.props.className === 'mef-err'))).toBe('lease expired');
  const retry = find(alert, (n) => n.type === 'button');
  expect(text(retry)).toBe(zh('memory.status.retry'));
  retry.props.onClick();
  expect(calls.retry).toHaveBeenCalledOnce();
});

it('draws no delivery button, document state or index count when there is nothing to show', () => {
  vi.useFakeTimers({ now: NOW });
  const { h } = footer({ jobs: [job({ signature: 'sig-old' })] }, []);
  const classes = nodes(h.value).map((n) => n.props.className);
  expect(classes).not.toContain('mef-vsep');
  expect(classes).not.toContain('mef-doc');
  expect(classes).not.toContain('mef-idx');
  expect(text(h.value)).toBe('JK移动');
});

it('loads as a busy skeleton of a group head and four rows, then says how long reading has taken', () => {
  vi.useFakeTimers({ now: NOW });
  const h = mount(() => EntriesLoading());
  const busy = find(h.value, (n) => n.props['aria-busy'] === 'true');
  expect(busy.props['aria-label']).toBe(zh('memory.status.loading.label'));
  const rows = nodes(busy).filter((n) => n.props.className === 'mes-row');
  expect(rows).toHaveLength(4);
  expect(
    rows.map((r) =>
      nodes(r.props.children)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'Skeleton')
        .map((n) => n.props.style?.width ?? n.props.className),
    ),
  ).toEqual([
    [16, 136, 'mes-grow', 32],
    [16, 112, 'mes-grow', 32],
    [16, 148, 'mes-grow', 32],
    [16, 96, 'mes-grow', 32],
  ]);
  const status = () => find(h.value, (n) => n.props.role === 'status');
  expect(text(status())).toBe('');
  vi.advanceTimersByTime(1400);
  h.render();
  expect(text(status())).toBe('读取中，1.4 秒');
});

it('fails to read in a centred alert with the error and a retry', () => {
  const retry = vi.fn();
  const tree = EntriesError({ message: 'connect ECONNREFUSED', onRetry: retry });
  expect(tree!.props.role).toBe('alert');
  expect(text(tree)).toContain(zh('memory.status.failed'));
  expect(text(find(tree, (n) => n.props.className === 'mes-err'))).toBe('connect ECONNREFUSED');
  const button = find(tree, (n) => n.type === 'button');
  expect(text(button)).toBe(zh('memory.status.retry'));
  button.props.onClick();
  expect(retry).toHaveBeenCalledOnce();
});

it('offers to write the first memory when there is none, with its N key', () => {
  const create = vi.fn();
  const tree = EntriesEmpty({ onCreate: create });
  expect(tree.props.title).toBe(zh('memory.status.empty'));
  const action = tree.props.action;
  expect(action.keys).toBe('N');
  expect(action.label).toBe(zh('memory.status.empty.create'));
  action.onClick();
  expect(create).toHaveBeenCalledOnce();
});
