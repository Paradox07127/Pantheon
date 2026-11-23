import { open } from '../page.mjs';
const { page, query, errors, poll } = await open(process.argv[2]);
const result = { id: 'shell.sidebar-quota', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const EXPAND = '展开侧栏';
const COLLAPSE = '折叠侧栏';
const shownButton = (name) =>
  page.evaluate(
    `[...document.querySelectorAll('button')].some((b) => b.getClientRects().length && b.getAttribute('aria-label') === ${JSON.stringify(name)})`,
  );
// The quota group and its rows, read in one pass; `label` is the group's name.
const quotaShown = (label) =>
  page.evaluate(`(() => {
    const groups = [...document.querySelectorAll('[role=group]')].filter(
      (g) => g.getClientRects().length && g.getAttribute('aria-label') === ${JSON.stringify(label)},
    );
    return {
      groups: groups.length,
      rows: [...document.querySelectorAll('.sb-q-row, .sb-q-ring')].map((r) => r.getAttribute('aria-label')),
    };
  })()`);

// The fixture runtime reports no quota window; no runtime in this daemon does.
const statuses = await query('runtime.status');
const reporting = statuses.filter((s) => s.quota?.windows?.length);
result.reporting = reporting.map((s) => s.runtime);
check(
  '后端对照：runtime.status 里没有运行时报告额度窗口',
  reporting.length === 0,
  result.reporting,
);

// Expanded sidebar.
if (await shownButton(EXPAND)) await page.click({ role: 'button', name: EXPAND, exact: true });
await poll(() => shownButton(COLLAPSE));
const expanded = await quotaShown('订阅额度');
result.expanded = expanded;
check(
  '展开侧栏：没有 "订阅额度" 组，也没有额度行',
  expanded.groups === 0 && expanded.rows.length === 0,
  expanded,
);
const settings = await page.evaluate(
  `[...document.querySelectorAll('aside .sb-gz button')].some((b) => b.getClientRects().length && b.textContent.includes('设置'))`,
);
check('侧栏底部 "设置" 仍在', settings, settings);
const navGroups = await page.evaluate(
  `[...document.querySelectorAll('[aria-label]')].filter((g) => g.getClientRects().length && g.getAttribute('aria-label') === '导航').length`,
);
check('对照组：同一个 aria-label 读法对 "导航" 判真', navGroups > 0, navGroups);
result.shot = await page.screenshot('shell.sidebar-quota');

// Collapsed rail.
await page.click({ role: 'button', name: COLLAPSE, exact: true });
await poll(() => shownButton(EXPAND));
const rail = await quotaShown('订阅额度');
result.rail = rail;
check('折叠成 rail:没有额度环', rail.groups === 0 && rail.rows.length === 0, rail);
await page.click({ role: 'button', name: EXPAND, exact: true });
await poll(() => shownButton(COLLAPSE));

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
