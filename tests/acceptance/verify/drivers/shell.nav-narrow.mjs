import { open } from '../page.mjs';
const { run, page, query, errors, poll } = await open(process.argv[2]);
const result = { id: 'shell.nav-narrow', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const EXPAND = '展开侧栏';
const COLLAPSE = '折叠侧栏';
const shownButton = (name) =>
  page.evaluate(
    `[...document.querySelectorAll('button')].some((b) => b.getClientRects().length && b.getAttribute('aria-label') === ${JSON.stringify(name)})`,
  );
// Visible buttons of the sidebar, named as the locator names them.
const sidebarButtons = () =>
  page.evaluate(`(() => {
    const bar = document.querySelector('aside.sb:not(.sb-rail)');
    if (!bar) return null;
    return [...bar.querySelectorAll('button')]
      .filter((b) => b.getClientRects().length)
      .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/g, ' ').trim());
  })()`);
// The rail's own icon buttons, without the floated panel the pointer opens.
const railButtons = () =>
  page.evaluate(`(() => {
    const rail = document.querySelector('aside.sb-rail');
    if (!rail) return null;
    return [...rail.querySelectorAll('button.ib')]
      .filter((b) => !b.closest('.sb-peek') && b.getClientRects().length)
      .map((b) => b.getAttribute('aria-label'));
  })()`);

// Starts with the sidebar open.
if (await shownButton(EXPAND)) await page.click({ role: 'button', name: EXPAND, exact: true });
const open1 = await poll(sidebarButtons);
result.sidebar = open1;
check('前置：展开的侧栏在', Array.isArray(open1) && open1.length > 0, open1);
check(
  '展开侧栏没有名为 "轨迹" "记忆" 的可见按钮',
  Array.isArray(open1) && !open1.includes('轨迹') && !open1.includes('记忆'),
  open1,
);
check('对照组：展开侧栏的 "设置" 按钮能找到', open1?.includes('设置'), open1);
const switcher = await page.evaluate(
  `document.querySelector('button[aria-label="切换项目"]')?.textContent ?? null`,
);
const project = (await query('board')).projects.find((p) => p.id === run.project_id);
check('后端对照：项目切换按钮显示 board 里 boot 项目的名字', switcher?.includes(project?.name), {
  switcher,
  daemon: project?.name,
});

// The rail: changes, new session, all projects, settings.
await page.click({ role: 'button', name: COLLAPSE, exact: true });
const rail = await poll(async () => {
  const r = await railButtons();
  return r?.length && r;
});
result.rail = rail;
check(
  '折叠后图标栏的按钮正好是 改动、新会话、全部项目、设置',
  JSON.stringify(rail) === JSON.stringify(['改动', '新会话', '全部项目', '设置']),
  rail,
);
check('对照组：图标栏的 "设置" 按钮能找到', Array.isArray(rail) && rail.includes('设置'), rail);
check(
  '对照组：图标栏按钮多一个 "轨迹" 时判 false',
  JSON.stringify(rail) !== JSON.stringify(['轨迹', '改动', '新会话', '全部项目', '设置']),
);

// The command palette: no trace or memory page, all projects still there.
await page.click({ role: 'button', name: '搜索', exact: true });
await page.waitFor(`!!document.querySelector('.cmdk input')`, 'the command palette to open');
const box = await page.evaluate(`document.querySelector('.cmdk input').getAttribute('aria-label')`);
const labels = () =>
  page.evaluate(
    `[...document.querySelectorAll('.cmdk [role=option] .cmdk-lb')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`,
  );
const search = async (text, until) => {
  await page.fill({ role: 'combobox', name: box, exact: true }, text);
  return poll(async () => until(await labels()) && (await labels()), 3000).then(
    async (got) => got || (await labels()),
  );
};
const projects = await search('全部项目', (l) => l.includes('全部项目'));
check('命令面板搜 "全部项目" 有 "全部项目" 页面项', projects.includes('全部项目'), projects);
const trace = await search('轨迹', () => false);
check('命令面板搜 "轨迹" 没有 "轨迹" 页面项', !trace.includes('轨迹'), trace);
const memory = await search('记忆', () => false);
check('命令面板搜 "记忆" 没有 "记忆" 页面项', !memory.includes('记忆'), memory);
result.palette = { projects, trace, memory };
result.shot = await page.screenshot(result.id);
await page.press('Escape');

// Leaves the sidebar open for the drivers after this one.
await page.click({ role: 'button', name: EXPAND, exact: true });
const restored = await poll(async () => (await sidebarButtons())?.includes('设置'));
check('收尾：侧栏恢复为展开', restored, await sidebarButtons());

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
