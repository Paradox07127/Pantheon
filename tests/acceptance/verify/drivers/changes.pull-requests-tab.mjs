import { open } from '../page.mjs';
const { page, query, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'changes.pull-requests-tab', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// A project whose repository has no remote, so the daemon finds no GitHub repository without asking GitHub.
const stamp = Date.now();
const { project_id } = await newProject(`verify-pulls-${stamp}`, {
  'README.md': '# pulls\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "pulls-fixture", "private": true }\n',
});

const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
const tabs = () =>
  page.evaluate(
    `[...document.querySelectorAll('[role=tab]')].filter((t) => t.getClientRects().length).map((t) => ({ name: t.textContent.replace(/\\s+/g, ' ').trim(), selected: t.getAttribute('aria-selected') }))`,
  );
const before = await poll(tabs);
result.tabs = before;
check(
  '改动页有 "拉取请求" 分栏',
  before?.some((t) => t.name === '拉取请求'),
  before,
);
check(
  '对照组：没有名为 "不存在的分栏" 的分栏',
  !before?.some((t) => t.name === '不存在的分栏'),
  before,
);

await page.click({ role: 'tab', name: '拉取请求', exact: true });
const after = await poll(async () => {
  const list = await tabs();
  return list.find((t) => t.name === '拉取请求')?.selected === 'true' && list;
});
check('点了以后 "拉取请求" 被选中', after, after);

// The daemon's answers the tab reads; connections.status answers from its cache, as the app's read does.
const connections = await query('connections.status');
const items = await query('github.items', { project_id, kind: 'pr' });
result.daemon = { github: connections.github?.state, repo: items.repo, items: items.items.length };
const expected =
  connections.github?.state !== 'signed_in'
    ? 'GitHub 没有连上'
    : items.repo === null
      ? '这个项目没有 GitHub 仓库'
      : null;
check(
  '后端对照：github.items 对没有远端的项目给 repo=null、无条目',
  items.repo === null && items.items.length === 0,
  result.daemon,
);
// The text of the tab panel labelled by the "拉取请求" tab; the list's panel leaves as it comes in.
const shown = await poll(() =>
  page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === '拉取请求');
    const panel = tab && [...document.querySelectorAll('[role=tabpanel]')].find((p) => p.getAttribute('aria-labelledby') === tab.id && p.getClientRects().length);
    return panel ? panel.textContent.replace(/\\s+/g, ' ').trim() : '';
  })()`),
);
result.shown = shown;
check('分栏显示与 daemon 状态对应的空状态', expected && shown.includes(expected), {
  shown,
  expected,
});
check('对照组：分栏里没有另一种空状态 "还没有拉取请求"', !shown.includes('还没有拉取请求'), shown);
const list = await page.evaluate(
  `[...document.querySelectorAll('[aria-label="打开的拉取请求"]')].filter((e) => e.getClientRects().length).length`,
);
check('没有拉取请求列表', list === 0, list);

result.shot = await page.screenshot('changes.pull-requests-tab');
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
