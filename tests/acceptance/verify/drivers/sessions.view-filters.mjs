import { open } from '../page.mjs';
const runDir = process.argv[2];
let { page, query, call, errors, poll, newProject } = await open(runDir);
const result = { id: 'sessions.view-filters', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const NAME = `verify-filter-${stamp}`;
const { project_id } = await newProject(NAME);
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);

// A lead session with a one-task plan, and that task's session, which keeps running.
const plan = {
  base_version: 0,
  headline: 'One running worker',
  lanes: [{ id: 'work', title: `Lane ${stamp}` }],
  tasks: [
    {
      id: 'hold',
      title: `Hold ${stamp}`,
      goal: 'Hold the slot',
      lane: 'work',
      depends_on: [],
      source: ['Hold the slot'],
      scope: ['hold.txt'],
      acceptance: ['test -f hold.txt'],
      kind: { domain: 'backend-logic', tier: 't1' },
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};
const lead = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'lead',
  input: `verify-filter-lead-${stamp}\nfixture-script\n${JSON.stringify([{ tool: { name: 'update_board', arguments: plan } }])}`,
});
await poll(
  async () =>
    (await query('session.list', { project_id })).find((s) => s.id === lead.id)?.last_turn
      ?.state === 'completed',
  30_000,
);
await call('session.create', {
  project_id,
  runtime: 'fixture',
  task_id: `${lead.id}:hold`,
  input: `Hold the slot\nfixture-script\n${JSON.stringify([{ hang: true }])}`,
});
const worker = await poll(
  async () =>
    (await query('session.list', { project_id })).find(
      (s) => s.lead === lead.id && s.state === 'running',
    ),
  30_000,
);
check('前置：session.list 有运行中的 worker', worker, worker?.id);

// A direct session, whose row the Worker filter leaves in place.
const DIRECT = `verify-direct-${stamp}`;
await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${DIRECT}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`,
});
const direct = await poll(
  async () => (await query('session.list', { project_id })).find((s) => s.title === DIRECT),
  30_000,
);
check('前置：session.list 有一个直接会话', direct, direct?.id);

const shownRows = () =>
  page.evaluate(`({
    worker: !!document.querySelector('nav.ss-list [data-session="${worker?.id}"]'),
    direct: !!document.querySelector('nav.ss-list [data-session="${direct?.id}"]'),
  })`);
const menuItems = () =>
  page.evaluate(`(() => {
    const pop = document.querySelector('.sb-vm');
    if (!pop) return null;
    return {
      heads: [...pop.querySelectorAll('.sb-vm-h')].map((h) => h.textContent.trim()),
      checks: [...pop.querySelectorAll('[role=menuitemcheckbox]')].map((m) => ({
        name: m.textContent.trim(),
        checked: m.getAttribute('aria-checked'),
      })),
    };
  })()`);
const openMenu = async () => {
  await page.click({ role: 'button', name: '分组、排序与筛选', exact: true });
  return poll(menuItems);
};
const toggleWorker = async () => {
  await openMenu();
  await page.click({ role: 'menuitemcheckbox', name: 'Worker', exact: true });
  await page.press('Escape');
};

await poll(async () => (await shownRows()).worker);
const menu = await openMenu();
result.menu = menu;
check(
  '视图菜单有 类型 和 运行时 两组',
  menu?.heads.includes('类型') && menu.heads.includes('运行时'),
  menu?.heads,
);
check(
  '类型组有 Worker/直接/分析 三个勾选项，起初都勾上，没有常驻',
  ['Worker', '直接', '分析'].every((n) =>
    menu?.checks.some((c) => c.name === n && c.checked === 'true'),
  ) && !menu?.checks.some((c) => c.name === '常驻'),
  menu?.checks,
);
check(
  '视图菜单按钮在会话标题行',
  await page.evaluate(`!!document.querySelector('.ss-zh [aria-label="分组、排序与筛选"]')`),
  null,
);
check(
  '运行时组列出 fixture',
  menu?.checks.some((c) => /fixture/i.test(c.name)),
  menu?.checks.map((c) => c.name),
);
await page.press('Escape');

await toggleWorker();
const hidden = await poll(async () => {
  const rows = await shownRows();
  return !rows.worker && rows;
});
check('取消勾选 Worker 后 worker 行消失、直接会话行还在', hidden && hidden.direct, hidden);

// Reload the page: the view is stored per project and must still apply.
const before = await errors();
try {
  await page.evaluate('location.reload()');
} catch {}
page.close();
({ page, query, call, errors, poll } = await open(runDir));
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitemradio', name: NAME, exact: false });
await page.waitFor(
  `(document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').includes(${JSON.stringify(NAME)})`,
  `the sidebar to show project ${NAME}`,
);
const afterReload = await poll(async () => {
  const rows = await shownRows();
  return rows.direct && rows;
});
const stored = await page.evaluate(
  `Object.keys(localStorage).filter((k) => k.endsWith(${JSON.stringify(project_id)})).map((k) => localStorage.getItem(k))`,
);
result.stored = stored;
check(
  '刷新后筛选还在：worker 行仍隐藏、直接会话行在',
  afterReload && !afterReload.worker,
  afterReload,
);
check(
  '刷新后存下的视图 hiddenTypes 含 worker',
  stored.some((v) => v?.includes('"worker"')),
  stored,
);
const reopened = await openMenu();
check(
  '刷新后菜单里 Worker 未勾选',
  reopened?.checks.some((c) => c.name === 'Worker' && c.checked === 'false'),
  reopened?.checks,
);
await page.press('Escape');

await toggleWorker();
const back = await poll(async () => {
  const rows = await shownRows();
  return rows.worker && rows;
});
check('对照组：重新勾上 Worker 后 worker 行回来', back, back);
result.shot = await page.screenshot(result.id);
result.errors = [...before, ...(await errors())];
console.log(JSON.stringify(result, null, 2));
page.close();
