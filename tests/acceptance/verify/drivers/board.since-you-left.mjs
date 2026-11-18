import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, newProject } = await open(runDir, { ms: 300_000 });
const result = { id: 'board.since-you-left', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// The cell caption each brief kind gets (BriefCard.tsx, zh-CN/brief.json).
const CAPTION = {
  decisions: '等你处理',
  milestone: '里程碑有进展',
  merge: '已合并',
  failure: '失败',
  assumption: '新假设',
  proposal: '智能体提议',
};

const stamp = Date.now();
const { project_id } = await newProject(`verify-brief-${stamp}`, {
  'README.md': '# brief\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "brief-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const brief = () => query('project.brief', { project_id });
const sessions = () => query('session.list', { project_id });
const idle = (id) =>
  poll(async () => {
    const s = (await sessions()).find((x) => x.id === id);
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
  }, 30_000);
await page.click({ role: 'button', name: '项目看板', exact: true });

// The card as shown: its name, and per cell its label, caption, count and links.
const card = () =>
  page.evaluate(`(() => {
    const c = [...document.querySelectorAll('[role=group][aria-label="你离开后"]')].find((el) => el.getClientRects().length);
    if (!c) return null;
    return {
      read: !!c.querySelector('.bf-brief-read'),
      cells: [...c.querySelectorAll('.bf-brief-c')].map((cell) => ({
        label: cell.getAttribute('aria-label'),
        cap: cell.querySelector('.cap')?.textContent ?? null,
        count: cell.querySelector('.kpi')?.textContent ?? null,
        links: [...cell.querySelectorAll('a.bf-brief-lk')].map((a) => a.textContent.trim()),
      })),
    };
  })()`);

// A lead plans one task in a milestone, so a failure of its worker links to that task.
const task = {
  id: 'task-one',
  title: `Brief task ${stamp}`,
  goal: 'Do the task.',
  lane: 'lane-a',
  milestone: 'milestone-a',
  estimate: 3,
  depends_on: [],
  source: ['The user asked for it.'],
  scope: ['src/index.ts'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  priority: 'normal',
};
const plan = {
  base_version: 0,
  headline: `Brief ${stamp}`,
  lanes: [{ id: 'lane-a', title: 'Lane A' }],
  tasks: [task],
  milestones: [
    {
      id: 'milestone-a',
      title: 'Milestone A',
      criteria: ['It merges.'],
      tasks: ['task-one'],
      due_on: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    },
  ],
  risks: [],
  assumptions: [],
};
const lead = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `verify-brief-lead-${stamp}\nfixture-script\n${JSON.stringify([{ tool: { name: 'update_board', arguments: plan } }])}`,
});
check('前置：lead 回合结束', (await idle(lead.id))?.last_turn?.state === 'completed');

// Start from nothing new: mark the project seen, then the card is not shown.
await call('project.seen', { project_id });
const empty = await brief();
check('前置：project.seen 后 project.brief 没有条目', empty.items.length === 0, empty.items);
const none = await poll(async () => (await card()) === null, 5000);
check('project.brief 没有条目时看板上没有 "你离开后"', none, await card());

// Something happens: a direct session merges, and the task's worker fails.
const merger = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `verify-brief-merge-${stamp}\nfixture-script\n${JSON.stringify([
    { write: { path: 'src/merged.ts', text: 'export const merged = true;\n' } },
    { commit: 'Add merged' },
    { say: 'done' },
  ])}`,
});
check('前置：合并会话回合结束', (await idle(merger.id))?.last_turn?.state === 'completed');
const mergeReceipt = await call(
  'session.merge',
  { session_id: merger.id },
  (await board()).sessions.find((s) => s.id === merger.id).revision,
);
result.merge_receipt = mergeReceipt;
const merged = await poll(async () => {
  const s = (await sessions()).find((x) => x.id === merger.id);
  return s?.state === 'merged' && s;
}, 30_000);
check(
  '前置：合并会话已合并（session.list state merged）',
  merged,
  (await sessions()).find((x) => x.id === merger.id)?.state,
);
// A failed fixture turn leaves its session idle, and needs-you lists a failed session only; a
// worktree preparation command that fails marks the session failed.
await call(
  'project.worktree.set',
  { project_id, copy_paths: [], command: { argv: ['false'] } },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const worker = await call('session.create', {
  project_id,
  runtime: 'fixture',
  task_id: `${lead.id}:task-one`,
  input: `fixture-script\n${JSON.stringify([{ say: 'never runs' }])}`,
});
const failedWorker = await poll(async () => {
  const s = (await sessions()).find((x) => x.id === worker.id);
  return s?.state === 'failed' && s;
}, 30_000);
check(
  '前置：worker 会话 failed（准备命令失败）',
  failedWorker,
  (await sessions()).find((s) => s.id === worker.id)?.state,
);

const served = await poll(async () => {
  const b = await brief();
  return b.items.some((i) => i.kind === 'merge') && b.items.some((i) => i.kind === 'failure') && b;
}, 20_000);
check(
  '前置：project.brief 有合并和失败',
  served,
  (await brief()).items.map((i) => [i.kind, i.ref]),
);
const kinds = served ? [...new Set(served.items.map((i) => i.kind))] : [];
// Per kind the count the card shows: one cell per item, the decisions cell its count.
const countOf = (b, kind) =>
  kind === 'decisions'
    ? b.items.find((i) => i.kind === 'decisions')?.count
    : b.items.filter((i) => i.kind === kind).length;
const shown =
  (await poll(async () => {
    const c = await card();
    return c?.cells.length === kinds.length && c;
  })) || (await card());
const now = await brief();
result.brief = now;
result.card = shown;
check('出现 "你离开后"，带 "标为已读"', shown?.read, shown);
const sameCounts = (c, b, of = countOf) =>
  !!c &&
  c.cells.length === [...new Set(b.items.map((i) => i.kind))].length &&
  [...new Set(b.items.map((i) => i.kind))].every((kind) =>
    c.cells?.some((cell) => cell.cap === CAPTION[kind] && cell.count === String(of(b, kind))),
  );
check('每类的计数等于 project.brief 里该类的条目数', sameCounts(shown, now), {
  ui: shown?.cells?.map((c) => [c.cap, c.count]),
  daemon: [...new Set(now.items.map((i) => i.kind))].map((k) => [k, countOf(now, k)]),
});
check(
  '对照组：把合并数加一，同一读法判 false',
  !sameCounts(shown, now, (b, kind) => countOf(b, kind) + (kind === 'merge' ? 1 : 0)),
);
const mergedCell = shown?.cells?.find((c) => c.cap === '已合并');
check(
  '已合并一格链到合并会话的标题',
  mergedCell?.links.includes(`verify-brief-merge-${stamp}`),
  mergedCell,
);

// The card comes before the needs-you list, and its title, time and "标为已读" share one row.
const layout = () =>
  page.evaluate(`(() => {
    const visible = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getClientRects().length);
    const c = visible('[role=group][aria-label="你离开后"]');
    const list = visible('section[aria-label="需要你"]');
    if (!c || !list) return null;
    const mid = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
    return {
      cardFirst: !!(c.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING),
      listFirst: !!(list.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING),
      title: mid(c.querySelector('.bf-brief-t')),
      time: mid(c.querySelector('.bf-brief-at')),
      read: mid(c.querySelector('.bf-brief-read')),
      firstCount: mid(c.querySelector('.bf-brief-c .kpi')),
      rows: [...list.querySelectorAll('li.bf-need')].map((li) => ({
        who: li.querySelector('article')?.getAttribute('aria-label') ?? null,
        kind: (li.querySelector('.rq-kind')?.textContent ?? '').trim(),
        blocks: (li.querySelector('.rq-blk')?.textContent ?? '').trim(),
      })),
    };
  })()`);
const placed = await poll(layout);
result.layout = placed;
check('"你离开后" 在 "需要你" 列表之前（文档顺序）', placed?.cardFirst, placed);
check('对照组：同一读法判列表不在卡片之前', placed && !placed.listFirst, placed);
const oneRow = (a, b) => a !== null && b !== null && Math.abs(a - b) <= 3;
check(
  '标题、时间和 "标为已读" 在同一行（竖直中心相差 3 px 内）',
  placed && oneRow(placed.title, placed.time) && oneRow(placed.title, placed.read),
  placed && [placed.title, placed.time, placed.read],
);
check(
  '对照组：同一读法判标题和第一格的计数不在同一行',
  placed && !oneRow(placed.title, placed.firstCount),
  placed && [placed.title, placed.firstCount],
);
// The failed worker's row in the list, at its place in needs_you.list.
const needs = (await query('needs_you.list', { project_id })).items;
const failedAt = needs.findIndex((i) => (i.session_id ?? i.source.id) === worker.id);
const failedRow = placed?.rows[failedAt];
check(
  '失败会话那一行的种类列不空',
  failedAt >= 0 && placed.rows.length === needs.length && failedRow?.kind !== '',
  { failedAt, rows: placed?.rows, daemon: needs.map((i) => [i.kind, i.reason]) },
);
check('对照组：同一读法读这一行空的阻塞列得空串', failedRow?.blocks === '', failedRow);

// The screenshot: the board with the card.
result.dark = await page.evaluate(`document.documentElement.classList.contains('dark')`);
result.shot = await page.screenshot('pair-brief');
copyFileSync(path.join(runDir, result.shot.file), path.join(runDir, 'screens', 'pair-brief.png'));

// A task item is a link that opens its task in the board's drawer.
const taskItem = now.items.find((i) => i.ref.kind === 'task');
check(
  '前置：project.brief 有指向任务的条目',
  taskItem,
  now.items.map((i) => [i.kind, i.ref]),
);
const view = await query('board.view', { project_id, days: '7' });
const taskTitle = view.tasks.find((t) => t.id === taskItem?.ref.id)?.title;
const failedCell = shown?.cells?.find((c) => c.cap === CAPTION[taskItem?.kind]);
check('任务条目显示为任务标题的链接', taskTitle && failedCell?.links.includes(taskTitle), {
  links: failedCell?.links,
  taskTitle,
});
const drawer = () =>
  page.evaluate(
    `(() => { const d = document.querySelector('aside.bd-drw'); return d && d.getClientRects().length && !d.dataset.endingStyle ? document.getElementById('bd-drw-title')?.textContent ?? '' : null; })()`,
  );
check('前置：抽屉未打开', (await drawer()) === null, await drawer());
if (taskTitle)
  await page.click({
    role: 'link',
    name: taskTitle,
    exact: true,
    within: { role: 'group', name: failedCell.label, exact: true },
  });
const opened = await poll(async () => {
  const d = await drawer();
  return d && d;
});
check('点任务链接后抽屉打开这个任务', opened === taskTitle, { opened, taskTitle });
check('对照组：抽屉标题不是合并会话', opened !== `verify-brief-merge-${stamp}`, opened);
await page.press('Escape');
await poll(async () => (await drawer()) === null, 3000);

// Mark as read: project.seen moves the cursor, the card leaves, the brief is empty.
const cursorBefore = now.since;
await page.click({ role: 'button', name: '标为已读', exact: true });
const left = await poll(async () => (await card()) === null, 5000);
check('点 "标为已读" 后卡片离开', left, await card());
const afterRead = await brief();
check('标为已读后 project.brief 没有条目', afterRead.items.length === 0, afterRead.items);
check('project.brief 的 since 前进了（project.seen 已发出）', afterRead.since > cursorBefore, {
  before: cursorBefore,
  after: afterRead.since,
});

// Something new happens: another session fails; the card comes back.
const second = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `verify-brief-fail-${stamp}\nfixture-script\n${JSON.stringify([{ say: 'never runs' }])}`,
});
await poll(
  async () => (await sessions()).find((x) => x.id === second.id)?.state === 'failed',
  30_000,
);
const again = await poll(async () => {
  const b = await brief();
  return b.items.some((i) => i.kind === 'failure') && b;
}, 20_000);
check('前置：新失败后 project.brief 又有条目', again, (await brief()).items);
const back = await poll(async () => {
  const c = await card();
  return c && c;
});
const latest = await brief();
check('新事发生后卡片回来，计数等于 project.brief', sameCounts(back, latest), {
  ui: back?.cells?.map((c) => [c.cap, c.count]),
  daemon: [...new Set(latest.items.map((i) => i.kind))].map((k) => [k, countOf(latest, k)]),
});
check('回来的卡片没有已读前的合并', !back?.cells?.some((c) => c.cap === '已合并'), back);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
