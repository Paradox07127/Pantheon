import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 120_000,
});
const result = { id: 'sessions.monitor-open-runs', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-runs-${stamp}`, {
  'README.md': '# runs\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "runs-fixture", "private": true }\n',
});
// Two sessions that keep running: the runs page lists running sessions, and the one opened from must be alone.
const TITLE = `verify-runs-open-${stamp}`;
const OTHER = `verify-runs-other-${stamp}`;
const start = (title) =>
  call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `${title}\nfixture-script\n${JSON.stringify([{ say: 'ok' }, { hang: true }])}`,
  });
const mine = await start(TITLE);
const other = await start(OTHER);
const running = await poll(async () => {
  const list = await query('session.list', { project_id });
  const a = list.find((s) => s.id === mine.id && s.state === 'running');
  const b = list.find((s) => s.id === other.id && s.state === 'running');
  return a && b && { mine: a, other: b };
}, 30_000);
check(
  '前置：session.list 里两个会话都在运行',
  running,
  running && [running.mine.state, running.other.state],
);

await page.click({ role: 'button', name: `${TITLE}，fixture`, exact: false });
const monitor = {
  role: 'button',
  name: '监控',
  exact: true,
  within: { role: 'toolbar', name: '面板', exact: true },
};
const pressed = await poll(() =>
  page.evaluate(
    `(() => { const b = [...document.querySelectorAll('[role=toolbar][aria-label="面板"] button[aria-label="监控"]')].find((el) => el.getClientRects().length); return b ? b.getAttribute('aria-pressed') : null; })()`,
  ),
);
check('前置：会话头部的面板工具栏有 "监控" 按钮', pressed !== null, pressed);
if (pressed !== 'true') await page.click(monitor);
await page.click({ role: 'button', name: '在运行页打开', exact: true });

const tabs = () =>
  page.evaluate(
    `[...document.querySelectorAll('[role=tab][aria-selected=true]')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`,
  );
const selected = await poll(async () => {
  const s = await tabs();
  return s.includes('运行') && s;
});
check('点 "在运行页打开" 后轨迹页的 "运行" 页签选中', selected, selected || (await tabs()));

const listed = () =>
  page.evaluate(
    `(() => { const g = [...document.querySelectorAll('[role=treegrid]')].find((el) => el.getAttribute('aria-label') === '会话和调用' && el.getClientRects().length); return g ? [...g.querySelectorAll('[role=row][data-type=session] .ct-title')].map((el) => el.textContent.trim()) : null; })()`,
  );
const rows = await poll(async () => {
  const r = await listed();
  return r?.length && r;
});
const daemon = (await query('session.list', { project_id })).find((s) => s.id === mine.id);
result.rows = rows;
check(
  '后端对照：运行页只列出 session.list 里这个会话的标题',
  Array.isArray(rows) && rows.length === 1 && rows[0] === daemon?.title,
  { ui: rows, daemon: daemon?.title },
);
check(
  '对照组：同项目另一个运行中的会话不在列表里',
  Array.isArray(rows) && !rows.includes(OTHER),
  rows,
);
result.shot = await page.screenshot(result.id);

// Stops both, so nothing keeps running for the drivers after this one.
for (const s of (await query('board', { project_id })).sessions.filter(
  (x) => x.id === mine.id || x.id === other.id,
))
  await call('session.interrupt', { session_id: s.id }, s.revision);
const stopped = await poll(async () =>
  (await query('session.list', { project_id }))
    .filter((s) => s.id === mine.id || s.id === other.id)
    .every((s) => s.state !== 'running'),
);
check('收尾：两个会话都已停下', stopped);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
