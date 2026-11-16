import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Improvement, MemoryContext, MemoryDirectory, MemoryItem } from '@pantheon/domain';
import { find, named, nodes, text } from './web-hook-host.js';
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ events: [] }), { getState: () => ({}) }),
}));
vi.mock('@/store', () => ({ useShell: Object.assign(() => null, { getState: () => ({}) }) }));
import { OverviewMemoryView, type OverviewMemoryData } from '@/screens/memory/OverviewMemory';
import { AgentContextBody, AgentContextDialog } from '@/screens/memory/AgentContextDialog';
import { contextCounts, waitingSince } from '@/data/memory-context';
import { PendingCard } from '@/screens/memory/PendingCard';
import { zh } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 12, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 10, 13, h, m).getTime();
const noop = () => {};
const actions = {
  onPreview: noop,
  onEntries: noop,
  onEntry: noop,
  onLearned: noop,
  onSession: noop,
  onMaintain: noop,
  onCommit: noop,
  onDiscard: noop,
  onRewrite: noop,
  onRetry: noop,
};

const item = (kind: MemoryItem['kind'], title: string, text = `${title} body`): MemoryItem =>
  ({ id: title, kind, key: title, title, text, state: 'active' }) as MemoryItem;

const context = (extra: Partial<MemoryContext> = {}): MemoryContext => ({
  epoch: 14,
  signature: 'sig',
  items: [
    item('decision', 'Keep idempotency keys for a day'),
    item('decision', 'Verify callbacks on the raw body'),
    item('report', 'Refund state table'),
    item('note', 'Staging first'),
  ],
  experiences: [
    {
      id: 'e1',
      status: 'active',
      procedure: 'Read the middleware first',
      countercondition: 'scripts',
    },
    { id: 'e2', status: 'trial', procedure: 'Add a transition test' },
  ],
  omitted: 2,
  bytes: 8412,
  instructions: '',
  ...extra,
});

const directory = (extra: Partial<MemoryDirectory> = {}): MemoryDirectory => ({
  epoch: 14,
  records: [],
  signature: 'sig',
  total: 0,
  index_pending: 0,
  facets: { tags: [], tasks: [] },
  budget: { used_bytes: 9100, limit_bytes: 12000 },
  counts: { active: 4, draft: 3, archived: 1 },
  jobs: [
    {
      id: 'job',
      revision: 1,
      project_id: 'p',
      signature: 'sig',
      state: 'done',
      attempts: 1,
      created_at: at(10, 20),
      completed_at: at(10, 31),
      body_hash: 'h',
    },
  ],
  sessions: [
    { id: 's1', title: 'lead', delivered: true, prepared: true, memory_tool: true, stale: false },
    {
      id: 's2',
      title: 'callbacks',
      delivered: false,
      prepared: false,
      memory_tool: true,
      stale: true,
    },
    {
      id: 's3',
      title: 'front end',
      delivered: false,
      prepared: false,
      memory_tool: false,
      stale: false,
    },
  ],
  document_ready: true,
  ...extra,
});

const data = (extra: Partial<OverviewMemoryData> = {}): OverviewMemoryData => ({
  directory: directory(),
  context: context(),
  contextError: null,
  directoryError: null,
  recentError: null,
  pendingError: null,
  recent: [
    {
      at: at(10, 31),
      kind: 'committed',
      memory_id: 'm1',
      memory_kind: 'decision',
      key: 'k1',
      title: 'Keep keys',
      actor: 'user',
    },
    {
      at: at(9, 52),
      kind: 'archived',
      memory_id: 'm2',
      memory_kind: 'report',
      key: 'k2',
      title: 'Old survey',
      actor: 'user',
    },
    {
      at: at(9, 40),
      kind: 'restored',
      memory_id: 'm3',
      memory_kind: 'decision',
      key: 'k3',
      title: 'Diff threshold',
      actor: 'user',
    },
    {
      at: at(9, 18),
      kind: 'proposed',
      memory_id: 'm4',
      memory_kind: 'note',
      key: 'k4',
      title: 'State table',
      actor: 'agent',
    },
  ],
  drafts: { count: 3, oldest: NOW - 3_600_000 },
  candidates: { count: 2, oldest: NOW - 27 * 60_000 },
  runtimes: { s1: 'claude', s2: 'codex', s3: 'agy' },
  titles: {},
  pending: [],
  now: NOW,
  ...extra,
});

const render = (d: OverviewMemoryData) =>
  renderToStaticMarkup(createElement(OverviewMemoryView, { data: d, actions }));
const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('overview memory panel', () => {
  it.each([
    [
      'shows the bytes agents get against the budget and what they are made of',
      [
        zh('memory.agent.title'),
        '记忆版本 14',
        '8,412 / 12,000 字节 70%',
        '决定 2',
        '报告 1',
        '笔记 1',
        '经验 2 生效 1 试用 1',
        '放不下省略 2',
        zh('memory.agent.viewAll'),
      ],
      ['aria-label="已用 8,412 字节，预算 12,000 字节，占 70%"', '--v:70%'],
    ],
    [
      'lists delivery per session in one column, grouped by state, with the runtime mark',
      [
        '送达情况 1 / 3 已送达',
        '已送达 Claude Code lead 等下一轮 Codex callbacks 没有记忆工具 Antigravity front end',
      ],
      ['role="group" aria-label="已送达"', 'role="group" aria-label="等下一轮"'],
    ],
    [
      'says no change was made yet instead of leaving the recent changes empty',
      ['看历史 还没有变更'],
      [],
      { recent: [] },
    ],
  ] as [string, string[], string[], Partial<OverviewMemoryData>?][])(
    '%s',
    (_name, words, markup, extra) => {
      const html = render(data(extra));
      for (const part of words) expect(plain(html)).toContain(part);
      for (const part of markup) expect(html).toContain(part);
    },
  );

  it('names an untitled session in delivery as the board does, else by its short id, never its raw id', () => {
    const untitled = (id: string) => ({
      id,
      delivered: false,
      prepared: false,
      memory_tool: true,
      stale: false,
    });
    const html = render(
      data({
        directory: directory({
          sessions: [
            untitled('2ed95cab-2cc9-4b7e-9d1a-0c4f1e2a3b4c'),
            untitled('7b95969c-c01c-4f2a-8e3d-5a6b7c8d9e0f'),
          ],
        }),
        titles: { '2ed95cab-2cc9-4b7e-9d1a-0c4f1e2a3b4c': '对话：Fix a layout bug' },
      }),
    );
    expect(plain(html)).toContain('对话：Fix a layout bug 会话 7b95969c');
    expect(html).not.toContain('2ed95cab-2cc9');
    expect(html).not.toContain('7b95969c-c01c');
  });

  it('says agents get no memory when confirmed decisions exceed the budget', () => {
    const html = render(
      data({
        context: null,
        contextError: { code: 'memory_budget_exceeded', message: 'Confirmed decisions exceed' },
      }),
    );
    const alert = /<div[^>]*role="alert"[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(plain(alert)).toContain('已确认的决定超出 12,000 字节的预算，agent 这一轮拿不到记忆');
    expect(plain(alert)).toContain(zh('memory.agent.shorten'));
    expect(html).not.toContain('class="kpi"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?看完整内容/);
  });

  it('lists recent changes by time, action, title and the kind of record', () => {
    const html = render(data());
    const words = plain(html);
    expect(words).toContain('10:31 确认生效 Keep keys 决定');
    expect(words).toContain('09:52 已归档 Old survey 报告');
    expect(words).toContain('09:40 恢复为草稿 Diff threshold 决定');
    expect(words).toContain('09:18 提出草稿 State table 笔记');
    expect(html).toMatch(/class="[^"]*mu[^"]*"[^>]*>Old survey/);
    expect(html).toMatch(/<span class="chip">决定<\/span>/);
    expect(words).toContain(zh('memory.agent.history'));
  });

  it('names why an archived record left by its reason', () => {
    const archived = (reason: string, title: string) => ({
      at: at(10, 31),
      kind: 'archived' as const,
      memory_id: title,
      memory_kind: 'decision' as const,
      reason: reason as never,
      key: title,
      title,
      actor: 'user',
    });
    const html = render(
      data({
        recent: [
          archived('superseded', 'Keep keys an hour'),
          archived('retracted', 'Retry survey'),
          archived('expired', 'Freeze until Friday'),
          archived('stale', 'Callback order'),
        ],
      }),
    );
    const words = plain(html);
    expect(words).toContain('10:31 被替代 Keep keys an hour');
    expect(words).toContain('10:31 撤回 Retry survey');
    expect(words).toContain('10:31 到期 Freeze until Friday');
    expect(words).toContain('10:31 依据失效 Callback order');
    expect(words).not.toContain(zh('memory.agent.change.archived'));
    expect(html).toMatch(/class="[^"]*mu[^"]*"[^>]*>Retry survey/);
  });

  it('names a retraction the user undid in the recent changes', () => {
    const html = render(
      data({
        recent: [
          {
            at: at(10, 40),
            kind: 'retraction_undone',
            memory_id: 'm1',
            memory_kind: 'decision',
            key: 'k1',
            title: 'Keep keys',
            actor: 'user',
          },
        ],
      }),
    );
    expect(plain(html)).toContain('10:40 撤销撤回 Keep keys');
  });

  it('names a change of a kind it does not know with a plain word, not its code', () => {
    const html = render(
      data({
        recent: [
          {
            at: at(10, 45),
            kind: 'merged' as never,
            memory_id: 'm1',
            memory_kind: 'decision',
            key: 'k1',
            title: 'Keep keys',
            actor: 'user',
          },
        ],
      }),
    );
    expect(plain(html)).toContain('10:45 其他变更 Keep keys');
    expect(html).not.toContain('merged');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('shows the progress document as updated, or the failed tries with a retry', () => {
    expect(plain(render(data()))).toContain('进度文档 已更新 10:31');
    const failed = render(
      data({
        directory: directory({
          document_ready: false,
          jobs: [
            {
              id: 'job2',
              revision: 3,
              project_id: 'p',
              signature: 'sig',
              state: 'failed',
              attempts: 3,
              error: 'disk full',
              created_at: at(10, 0),
            },
          ],
        }),
      }),
    );
    expect(plain(failed)).toContain('进度文档 试了 3 次没生成：disk full 重试');
    expect(plain(failed)).not.toContain(zh('memory.agent.documentReady'));
  });

  it('holds the retry of the progress document while one is out', () => {
    const failed = (maintaining: boolean) =>
      render(
        data({
          maintaining,
          directory: directory({
            document_ready: false,
            jobs: [
              {
                id: 'job2',
                revision: 3,
                project_id: 'p',
                signature: 'sig',
                state: 'failed',
                attempts: 1,
                created_at: at(10, 0),
              },
            ],
          }),
        }),
      )
        .match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)!
        .find((button) => button.includes(zh('memory.agent.retry')))!;
    expect(failed(true)).toContain('disabled=""');
    expect(failed(false)).not.toContain('disabled');
  });

  it('counts the drafts and experience candidates waiting, and leaves the block out when none wait', () => {
    const words = plain(render(data()));
    expect(words).toContain('等你确认 记忆草稿 已等 1 小时 3 经验 已等 27 分钟 2');
    const none = render(
      data({ drafts: { count: 0, oldest: null }, candidates: { count: 0, oldest: null } }),
    );
    expect(none).not.toContain(zh('memory.agent.pending'));
  });

  it('puts a card for each pending draft under the waiting counts, and none when no draft waits', () => {
    const draft = {
      ...item('decision', 'Keep keys for three days', 'Keep idempotency keys for 72 hours'),
      state: 'draft',
      based_on: 'sig',
      created_at: at(10, 33),
    } as MemoryItem;
    const html = render(
      data({
        pending: [
          {
            item: draft,
            versions: [draft],
            author: { title: 'refund review', runtime: 'codex' },
            rejected: false,
            busy: false,
          },
        ],
      }),
    );
    const words = plain(html);
    expect(words).toContain('等你确认 记忆草稿 已等 1 小时 3');
    expect(words).toContain('Keep keys for three days');
    expect(words).toContain(zh('memory.pending.state'));
    expect(words).toContain('refund review');
    expect(words).toContain(zh('memory.pending.latest'));
    expect(words).toContain('确认生效 丢弃 打开详情');
    expect(render(data())).not.toContain('class="mpc"');
  });

  it('wires a pending card to confirm, discard, open details and the proposing session', () => {
    const draft = {
      ...item('note', 'Staging first'),
      state: 'draft',
      based_on: 'old',
      author_session_id: 's2',
      created_at: at(9, 0),
    } as MemoryItem;
    const calls: unknown[][] = [];
    const spy =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args]);
    const view = OverviewMemoryView({
      data: data({
        pending: [{ item: draft, versions: [draft], rejected: true, busy: true }],
      }),
      actions: {
        ...actions,
        onCommit: spy('commit'),
        onDiscard: spy('discard'),
        onEntry: spy('entry'),
        onSession: spy('session'),
        onRewrite: spy('rewrite'),
      },
    });
    const pending = named(view, 'Pending');
    const card = find((pending.type as any)(pending.props), (n) => n.type === PendingCard);
    expect(card.props).toMatchObject({ item: draft, signature: 'sig', rejected: true, busy: true });
    card.props.onCommit();
    card.props.onDiscard();
    card.props.onOpen();
    card.props.onRewrite();
    card.props.onOpenSession();
    expect(calls).toEqual([
      ['commit', draft],
      ['discard', draft],
      ['entry', 'Staging first'],
      ['rewrite', draft],
      ['session', 's2'],
    ]);
  });

  it('compares a draft with the version that was current when it was proposed, not a later one', () => {
    const version = (id: string, committed: number, archived?: number) =>
      ({
        ...item('decision', id, `${id} text`),
        id,
        key: 'keys',
        state: archived === undefined ? 'active' : 'archived',
        committed_at: committed,
        archived_at: archived,
      }) as MemoryItem;
    const one = version('one', at(9, 0), at(11, 0));
    const two = version('two', at(11, 0));
    const draft = {
      ...item('decision', 'draft', 'draft text'),
      key: 'keys',
      state: 'draft',
      based_on: 'old',
      created_at: at(10, 33),
    } as MemoryItem;
    const html = renderToStaticMarkup(
      createElement(PendingCard, {
        item: draft,
        versions: [two, draft, one],
        signature: 'sig',
        onCommit: noop,
        onDiscard: noop,
        onOpen: noop,
        onRewrite: noop,
        onOpenSession: noop,
      }),
    );
    expect(html).toContain('基于第 1 版');
    expect(html).toContain('one text');
    expect(html).not.toContain('two text');
  });

  it('says a read failed with a retry instead of loading or counting nothing', () => {
    const failed = data({
      directory: null,
      recent: null,
      drafts: { count: 0, oldest: null },
      candidates: { count: 0, oldest: null },
      directoryError: 'directory unreadable',
      recentError: 'recent unreadable',
      pendingError: 'drafts unreadable',
    });
    const html = render(failed);
    expect(html).not.toContain('aria-busy');
    const alerts = [...html.matchAll(/<div[^>]*role="alert"[^>]*>(.*?)<\/div>/g)].map((m) =>
      plain(m[1]!).trim(),
    );
    expect(alerts).toEqual([
      'directory unreadable 重试',
      'recent unreadable 重试',
      'drafts unreadable 重试',
    ]);
    let retried = 0;
    const tree = OverviewMemoryView({
      data: failed,
      actions: { ...actions, onRetry: () => retried++ },
    });
    // Draws the panel's own parts; the shared components hold hooks.
    const own = new Set(['Usage', 'Recent', 'Pending', 'Failed']);
    const expand = (tree: any): any[] =>
      nodes(tree).flatMap((c) =>
        own.has((c.type as any).name) ? [c, ...expand((c.type as any)(c.props))] : [c],
      );
    for (const button of expand(tree).filter(
      (n) => n.type === 'button' && text(n) === zh('memory.agent.retry'),
    ))
      button.props.onClick();
    expect(retried).toBe(3);
  });

  const refusal = {
    used_bytes: 12486,
    limit_bytes: 12000,
    largest_records: [
      { id: 'd1', title: 'Verify callbacks on the raw body', bytes: 2140 },
      { id: 'd2', title: 'Keep keys for three days', bytes: 1986 },
    ],
  };
  const refusedDraft = {
    ...item('decision', 'Keep keys for three days'),
    state: 'draft',
    based_on: 'sig',
    created_at: at(10, 33),
  } as MemoryItem;

  it('shows a card refused for space with the bytes, the budget and the largest decisions', () => {
    const props = {
      item: refusedDraft,
      versions: [refusedDraft],
      overBudget: refusal,
      onCommit: noop,
      onDiscard: noop,
      onOpen: noop,
      onRewrite: noop,
      onOpenSession: noop,
    };
    const html = renderToStaticMarkup(createElement(PendingCard, props));
    const alert = /<div[^>]*role="alert"[^>]*>(.*?)<\/div><\/div>/.exec(html)?.[1] ?? '';
    expect(plain(alert)).toContain(zh('memory.pending.overBudget'));
    expect(plain(alert)).toContain('12,486 / 12,000');
    expect(html).toContain('aria-label="当前决定 12,486 字节，预算 12,000 字节"');
    expect(html).toContain('--v:100%');
    const words = plain(html);
    expect(words).toContain('Verify callbacks on the raw body 2,140');
    expect(words).toContain('Keep keys for three days 1,986');
    expect(words).toContain('去缩短 重试 丢弃');
    expect(html).not.toContain('mpc-diff');
    const opened: string[] = [];
    const tree = PendingCard({ ...props, onRecord: (id: string) => opened.push(id) });
    const row = find(tree, (n) => n.type === 'button' && text(n).startsWith('Verify callbacks'));
    row.props.onClick();
    expect(opened).toEqual(['d1']);
  });

  it('opens a decision listed on a card refused for space as an entry', () => {
    const opened: unknown[] = [];
    const view = OverviewMemoryView({
      data: data({
        pending: [
          {
            item: refusedDraft,
            versions: [refusedDraft],
            rejected: false,
            overBudget: refusal,
            busy: false,
          },
        ],
      }),
      actions: { ...actions, onEntry: (id) => opened.push(id) },
    });
    const pending = named(view, 'Pending');
    const card = find((pending.type as any)(pending.props), (n) => n.type === PendingCard);
    expect(card.props.overBudget).toEqual(refusal);
    card.props.onRecord('d2');
    expect(opened).toEqual(['d2']);
  });

  it('turns waiting items and the oldest-first summary into counts', () => {
    expect(contextCounts(context())).toEqual({
      decision: 2,
      report: 1,
      note: 1,
      experiences: 2,
      active: 1,
      trial: 1,
      omitted: 2,
    });
    const improvement = (status: Improvement['status'], proposed_at: number, type = 'experience') =>
      ({ status, proposed_at, change: { type } }) as Improvement;
    expect(
      waitingSince([
        improvement('candidate', 500),
        improvement('candidate', 300),
        improvement('trial', 100),
        improvement('candidate', 200, 'policy_change'),
      ]),
    ).toEqual({ count: 2, oldest: 300 });
    expect(waitingSince([])).toEqual({ count: 0, oldest: null });
  });
});

describe('what agents get now dialog', () => {
  it('groups decisions, reports, notes and experiences, leaving the left-out count to the head', () => {
    const html = renderToStaticMarkup(createElement(AgentContextBody, { context: context() }));
    const words = plain(html);
    expect(words).toContain(
      '决定 2 Keep idempotency keys for a day Keep idempotency keys for a day body',
    );
    expect(words).toContain('报告 1 Refund state table');
    expect(words).not.toContain('放不下');
    expect(words).toContain('笔记 1 Staging first');
    expect(words).toContain('经验 2 Read the middleware first 生效 不适用：scripts');
    expect(words).toContain('Add a transition test 试用中');
  });

  it('shows no reports section when only other kinds were left out', () => {
    const only = { ...context(), items: context().items.filter((i) => i.kind !== 'report') };
    const html = renderToStaticMarkup(createElement(AgentContextBody, { context: only }));
    expect(plain(html)).not.toContain(zh('memory.agent.reports'));
  });

  it('heads the dialog as a project-wide preview with the bytes, the memory version, the left-out count and a close button', () => {
    const tree = AgentContextDialog({
      open: true,
      onOpenChange: noop,
      context: context(),
      limit: 12000,
    });
    const head = text(tree);
    expect(head).toContain(zh('memory.agent.dialogTitle'));
    expect(head).toContain('8,412 / 12,000');
    expect(head).toContain(zh('memory.agent.version'));
    expect(head).toContain('14');
    expect(head).toContain('放不下省略 2 条');
    const close = find(tree, (n) => n.props['aria-label'] === zh('memory.agent.close'));
    expect(close).toBeTruthy();
    expect(nodes(tree).some((n) => n.type === AgentContextBody)).toBe(true);
  });
});
