import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, newProject } = await open(runDir, { ms: 300_000 });
const result = { id: 'board.since-you-left', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// The lane names the card draws (BriefCard.tsx, zh-CN/board-brief.json).
const LANE = { delivered: '交付', decided: '替你决定', planned: '计划' };

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

// The card as shown, read by role and accessible name: whether it has "标为已读", per lane its
// name and the names of its points, and the links outside its paragraph (the failure lines).
const card = () =>
  page.evaluate(`(() => {
    const c = [...document.querySelectorAll('[role=group][aria-label="你离开后"]')].find((el) => el.getClientRects().length);
    if (!c) return null;
    const lanes = ${JSON.stringify(LANE)};
    const groups = [...c.querySelectorAll('[role=group]')];
    const lane = (name) => {
      const g = groups.find((el) => (el.getAttribute('aria-label') ?? '').startsWith(name));
      return g ? { label: g.getAttribute('aria-label'), points: [...g.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) } : null;
    };
    return {
      read: [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === '标为已读'),
      lanes: Object.fromEntries(Object.entries(lanes).map(([key, name]) => [key, lane(name)])),
      lines: [...c.querySelectorAll('a[href]')].filter((a) => !a.closest('p')).map((a) => a.textContent.trim()),
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
  purpose: 'lead',
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
// Per lane the points the card should draw: delivered is merges and failures, plan is assumptions
// and proposals, decided for you is the decisions project.decisions lists after leaving.
const expected = async (b) => {
  const n = (...kinds) => b.items.filter((i) => kinds.includes(i.kind)).length;
  const decided = b.items.some((i) => i.kind === 'decided')
    ? (await query('project.decisions', { project_id, since: String(b.since + 1) })).items.length
    : 0;
  return {
    delivered: n('merge', 'failure'),
    decided,
    planned: n('assumption', 'proposal'),
  };
};
const pointCounts = (c) =>
  c && Object.fromEntries(Object.keys(LANE).map((k) => [k, c.lanes[k]?.points.length ?? null]));
const sameCounts = (c, want) =>
  !!c && Object.keys(LANE).every((k) => c.lanes[k]?.points.length === want[k]);
const now = await brief();
const want = await expected(now);
const shown = (await poll(async () => sameCounts(await card(), want) && card())) || (await card());
result.brief = now;
result.card = shown;
check('出现 "你离开后"，带 "标为已读"', shown?.read, shown);
check('每道时间轴的点数等于 project.brief 里该类条目数', sameCounts(shown, want), {
  ui: pointCounts(shown),
  daemon: want,
});
check(
  '对照组：把交付道的期望点数加一，同一读法判 false',
  !sameCounts(shown, { ...want, delivered: want.delivered + 1 }),
);
const mergedPoint = shown?.lanes.delivered?.points.find((l) =>
  l?.includes(`verify-brief-merge-${stamp}`),
);
check(
  '交付道有合并会话的点，名字带 "已合并"',
  mergedPoint?.includes('已合并'),
  shown?.lanes.delivered,
);

// The card comes before the needs-you list, and its heading, time and "标为已读" share one row.
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
      title: mid(c.querySelector('h2')),
      time: mid(c.querySelector('time')),
      read: mid([...c.querySelectorAll('button')].find((b) => b.textContent.trim() === '标为已读')),
      firstLane: mid(c.querySelector('[role=group]')),
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
  '对照组：同一读法判标题和第一道时间轴不在同一行',
  placed && !oneRow(placed.title, placed.firstLane),
  placed && [placed.title, placed.firstLane],
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

// The worker's failure is a point on the delivered lane and a failure line, both named by its task.
const view = await query('board.view', { project_id, days: '7' });
const taskTitle = view.tasks.find((t) => t.id === `${lead.id}:task-one`)?.title;
check('前置：board.view 有计划任务', taskTitle === task.title, taskTitle);
const taskPoint = shown?.lanes.delivered?.points.find((l) => taskTitle && l?.includes(taskTitle));
check('交付道有失败任务的点，名字带任务标题', taskPoint, shown?.lanes.delivered);
check(
  '失败行是带任务标题的链接',
  shown?.lines.some((l) => taskTitle && l.includes(taskTitle)),
  {
    lines: shown?.lines,
    taskTitle,
  },
);
check(
  '对照组：同一读法在失败行里找不到合并会话',
  !shown?.lines.some((l) => l.includes(`verify-brief-merge-${stamp}`)),
  shown?.lines,
);
const drawer = () =>
  page.evaluate(
    `(() => { const d = document.querySelector('aside[aria-labelledby=bd-drw-title]'); return d && d.getClientRects().length && !d.dataset.endingStyle ? document.getElementById('bd-drw-title')?.textContent ?? '' : null; })()`,
  );
check('前置：抽屉未打开', (await drawer()) === null, await drawer());
if (taskPoint)
  await page.click({
    role: 'button',
    name: taskTitle,
    within: { role: 'group', name: shown.lanes.delivered.label, exact: true },
  });
const opened = await poll(async () => {
  const d = await drawer();
  return d && d;
});
check('点交付道上的任务点后抽屉打开这个任务', opened === taskTitle, { opened, taskTitle });
check('对照组：抽屉标题不是合并会话', opened !== `verify-brief-merge-${stamp}`, opened);
// The pressed point keeps focus and its tooltip, which may take the first Escape.
const closed = await poll(async () => {
  if ((await drawer()) === null) return true;
  await page.press('Escape');
  return false;
}, 3000);
check('按 Escape 后抽屉关上', closed, await drawer());

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
const latest = await brief();
const wantBack = await expected(latest);
const back =
  (await poll(async () => sameCounts(await card(), wantBack) && card())) || (await card());
check('新事发生后卡片回来，每道点数等于 project.brief', sameCounts(back, wantBack), {
  ui: pointCounts(back),
  daemon: wantBack,
});
check(
  '对照组：同一读法把计划道的期望点数加一判 false',
  !sameCounts(back, { ...wantBack, planned: wantBack.planned + 1 }),
);
check(
  '回来的卡片没有已读前的合并',
  back && !back.lanes.delivered?.points.some((l) => l?.includes(`verify-brief-merge-${stamp}`)),
  back?.lanes.delivered,
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
