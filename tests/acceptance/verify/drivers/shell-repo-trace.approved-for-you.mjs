import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'shell-repo-trace.approved-for-you', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Local midnight of a range's first day, as data/decisions-for-user.ts reads it.
const DAYS = { today: 1, week: 7, month: 30 };
const since = (range) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - DAYS[range] + 1).getTime();
};

const stamp = Date.now();
const { project_id, name: projectName } = await newProject(`verify-decided-${stamp}`, {
  'README.md': '# approved\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "decided-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'ask' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const sessions = () => query('session.list', { project_id });
const decisions = async (range = 'today') =>
  (await query('project.decisions', { project_id, since: String(since(range)) })).items;

// A seed session's two prompts the user allows for the project, which stores a rule for each.
const SEED = `verify-decided-seed-${stamp}`;
await call('session.create', {
  project_id,
  runtime: 'fixture',
  permission_mode: 'ask',
  input: `${SEED}\nfixture-script\n${JSON.stringify([
    { ask: { tool: 'Bash', input: { command: `pnpm test --filter seed-${stamp}` } } },
    { ask: { tool: 'Bash', input: { command: `pnpm lint --filter seed-${stamp}` } } },
    { say: 'seeded' },
  ])}`,
});
const seed = await poll(async () => (await sessions()).find((s) => s.title === SEED), 30_000);
for (let n = 0; n < 2; n++) {
  const item = await poll(async () =>
    (await query('needs_you.list')).items.find(
      (i) => i.kind === 'permission' && i.session_id === seed?.id,
    ),
  );
  if (!item) break;
  await call(
    'approval.respond',
    { approval_id: item.source.id, decision: 'approve_project' },
    item.source.revision,
  );
  await poll(
    async () => !(await query('needs_you.list')).items.some((i) => i.source?.id === item.source.id),
  );
}
const rules = await poll(async () => {
  const list = await query('permission.rules', { project_id });
  return list.length >= 2 && list;
});
result.rules = rules;
check('前置：允许到项目后 permission.rules 有两条规则', rules?.length === 2, rules);

// A direct session asks two commands the stored rules cover; the daemon answers both by rule.
const COMMANDS = [`pnpm test --filter one-${stamp}`, `pnpm lint --filter two-${stamp}`];
const WORKER = `verify-decided-worker-${stamp}`;
const worker = await call('session.create', {
  project_id,
  runtime: 'fixture',
  permission_mode: 'ask',
  input: `${WORKER}\nfixture-script\n${JSON.stringify([
    ...COMMANDS.map((command) => ({ ask: { tool: 'Bash', input: { command } } })),
    { say: 'done' },
  ])}`,
});
const workerDone = await poll(async () => {
  const s = (await sessions()).find((x) => x.id === worker.id);
  return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
}, 30_000);
result.worker = workerDone && {
  state: workerDone.state,
  turn: workerDone.last_turn?.state,
  waiting: workerDone.waiting,
  title: workerDone.title,
};
const workerTitle = workerDone?.title ?? WORKER;
check(
  '前置：这个会话的回合跑完，没有在等你',
  workerDone?.last_turn?.state === 'completed' && workerDone.waiting === 0,
  result.worker,
);
// The seed's prompts the user allowed are not decisions made for the user.
const today = await poll(async () => {
  const items = await decisions();
  return items.length >= 2 && items;
}, 20_000);
check(
  '前置：project.decisions 今天只有这个会话的两个按已存规则批准的权限请求',
  today &&
    today.length === 2 &&
    today.every((i) => i.kind === 'prompt_by_rule' && i.session_id === worker.id && i.rule),
  { items: today, worker: result.worker },
);
if (!today || today.length < 2) {
  result.errors = await errors();
  console.log(JSON.stringify(result, null, 2));
  page.close();
  process.exit(0);
}

// A direct session waits on the user, so the title bar has its needs-you button.
await call('session.create', {
  project_id,
  runtime: 'fixture',
  permission_mode: 'ask',
  input: `verify-decided-wait-${stamp}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command: 'git push --force origin main' } } }])}`,
});
const all = await poll(async () => {
  const items = (await query('needs_you.list')).items;
  return items.some((i) => i.project_id === project_id) && items;
}, 20_000);
check('前置：needs_you.list 有本项目的等待', all, all?.length);

// The needs-you popover's footer counts today's decisions and opens the tab.
await page.click({ role: 'button', name: `${all.length} 件事等你`, exact: true });
const decided = await decisions();
// The popover spans every project, and so does its footer: the sum over the projects of what a
// stored rule answered today, the only decision the list shows.
const projects = (await query('board')).projects.filter((p) => p.removed_at === undefined);
let todayAll = 0;
for (const p of projects)
  todayAll += (
    await query('project.decisions', { project_id: p.id, since: String(since('today')) })
  ).items.filter((i) => i.kind === 'prompt_by_rule').length;
const footerText = () =>
  page.evaluate(
    `(() => { const f = document.querySelector('.np .np-f'); return f && f.getClientRects().length ? f.textContent.replace(/\\s+/g, ' ').trim() : null; })()`,
  );
// The footer adds up each project's read as it lands; wait for the sum.
let footer = null;
await poll(async () => (footer = await footerText()) === `替你批准了 ${todayAll} 项今天`);
result.footer_daemon = { this_project: decided.length, all_projects: todayAll };
check(
  'popover 底部是 "替你批准了 N 项今天"，N 等于各项目 project.decisions 今天按规则批准的条数之和',
  footer === `替你批准了 ${todayAll} 项今天`,
  { footer, daemon: result.footer_daemon },
);
check('对照组：N 加一时判 false', footer !== `替你批准了 ${todayAll + 1} 项今天`, footer);
const popoverOpen = () =>
  page.evaluate(
    `(() => { const f = document.querySelector('.np .np-f'); return !!f && f.getClientRects().length > 0; })()`,
  );
result.before_footer_click = {
  popover_open: await popoverOpen(),
  screen: await page.evaluate(
    `[...document.querySelectorAll('[aria-current=page]')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`,
  ),
  notices: await page.evaluate(
    `[...document.querySelectorAll('.toast.nc')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`,
  ),
};
if (!result.before_footer_click.popover_open)
  await page.click({ role: 'button', name: `${all.length} 件事等你`, exact: true });
let viaFooter = true;
try {
  await page.click({ role: 'button', name: `替你批准了 ${todayAll} 项`, exact: false });
} catch (error) {
  // No footer to click: the trace page opens from the palette's recent activity, so the table can still be checked.
  viaFooter = false;
  result.footer_click = error.message.slice(0, 300);
  await page.press('Escape');
  await page.click({ role: 'button', name: '搜索', exact: true });
  await page.waitFor(`!!document.querySelector('.cmdk input')`, 'the command palette to open');
  const box = await page.evaluate(
    `document.querySelector('.cmdk input').getAttribute('aria-label')`,
  );
  await page.fill({ role: 'combobox', name: box, exact: true }, '最近动态');
  await page.click({ role: 'option', name: '最近动态', exact: true });
  await page.click({ role: 'tab', name: '替你批准的', exact: false });
}
const selectedTab = () =>
  page.evaluate(
    `[...document.querySelectorAll('[role=tab][aria-selected=true]')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`,
  );
const tab = await poll(async () => {
  const s = await selectedTab();
  // The tab's name is followed by today's count.
  return s.some((name) => name.startsWith('替你批准的')) && s;
});
check('点底部后轨迹页的 "替你批准的" 标签选中', viaFooter && tab, tab || (await selectedTab()));

// The table against project.decisions.
const table = () =>
  page.evaluate(`(() => {
    const t = [...document.querySelectorAll('[role=table]')].find((el) => el.getAttribute('aria-label') === '替你批准的' && el.getClientRects().length);
    if (!t) return null;
    return [...t.querySelectorAll('[role=row]')].filter((r) => !r.classList.contains('afy-hd')).map((r) => {
      const cells = [...r.querySelectorAll('[role=cell]')];
      return {
        action: cells[0]?.textContent.trim() ?? null,
        by: cells[1]?.textContent.trim() ?? null,
        rule: cells[3]?.textContent.trim() ?? null,
        task: cells[4]?.querySelector('button')?.textContent.trim() ?? null,
        when: cells[5]?.textContent.trim() ?? null,
      };
    });
  })()`);
const rowsMatch = (rows, items) =>
  !!rows &&
  rows.length === items.length &&
  rows.every(
    (r, n) =>
      r.action === items[n].input_summary && r.by === '已存规则' && r.rule === items[n].rule,
  );
const rows = await poll(async () => {
  const r = await table();
  return r?.length === decided.length && r;
});
check('表名为 "替你批准的"', rows, rows || (await table()));
check(
  '行按顺序等于 project.decisions：操作是工具输入，批准者是 已存规则，规则列是那条规则',
  rowsMatch(rows, decided),
  { ui: rows, daemon: decided.map((i) => [i.kind, i.input_summary, i.rule]) },
);
check('对照组：顺序倒过来时判 false', !rowsMatch(rows, [...decided].reverse()));
check(
  '对照组：批准者当成 lead 时判 false',
  !(Array.isArray(rows) && rows.length > 0 && rows.every((r) => r.by === 'lead')),
);
check(
  '行的任务列是这个会话的标题（session.list 的 title）',
  Array.isArray(rows) && rows.every((r) => r.task === workerTitle),
  rows?.map((r) => r.task),
);
result.shot = await page.screenshot('pair-approved');
copyFileSync(
  path.join(runDir, result.shot.file),
  path.join(runDir, 'screens', 'pair-approved.png'),
);

// The ranges: each re-reads project.decisions with its own since.
const radios = () =>
  page.evaluate(
    `[...document.querySelectorAll('[role=radiogroup][aria-label="时间范围"] [role=radio]')].filter((el) => el.getClientRects().length).map((el) => ({ name: el.textContent.trim(), checked: el.getAttribute('aria-checked') === 'true' }))`,
  );
check(
  '时间范围是 今天 / 7 天 / 30 天，默认今天',
  JSON.stringify(await radios()) ===
    JSON.stringify([
      { name: '今天', checked: true },
      { name: '7 天', checked: false },
      { name: '30 天', checked: false },
    ]),
  await radios(),
);
// A decision made now lands in every range; whether a range read again shows in its rows staying equal.
for (const [name, range] of [
  ['7 天', 'week'],
  ['30 天', 'month'],
  ['今天', 'today'],
]) {
  await page.click({ role: 'radio', name, exact: true });
  const picked = await poll(async () => (await radios()).find((r) => r.checked)?.name === name);
  const want = await decisions(range);
  const got = await poll(async () => {
    const r = await table();
    return rowsMatch(r, want) && r;
  });
  check(`选 "${name}" 后行等于 project.decisions(since=${range})`, picked && got, {
    ui: got || (await table()),
    daemon: want.length,
  });
}

// The row's session link opens that session.
// Both rows link to the same session; the first row's link is clicked where it is drawn.
const linkAt = await page.evaluate(`(() => {
  const t = [...document.querySelectorAll('[role=table]')].find((el) => el.getAttribute('aria-label') === '替你批准的');
  const b = t?.querySelector('[role=row]:not(.afy-hd) .afy-ref');
  const r = b?.getBoundingClientRect();
  return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: b.textContent.trim() };
})()`);
check('前置：第一行有任务链接', linkAt?.text === workerTitle, linkAt);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
  await page.send('Input.dispatchMouseEvent', {
    type,
    x: linkAt.x,
    y: linkAt.y,
    button: 'left',
    clickCount: 1,
  });
const opened = await poll(() =>
  page.evaluate(`(() => {
    const row = document.querySelector('[data-session="${worker.id}"]');
    const current = row?.getAttribute('aria-current') === 'true';
    const shown = !!document.querySelector('main')?.innerText.includes(${JSON.stringify(workerTitle)});
    return current && shown && { current, shown };
  })()`),
);
const elsewhere = await page.evaluate(
  `document.querySelector('[data-session="${seed?.id}"]')?.getAttribute('aria-current') === 'true'`,
);
check('点行的任务链接后打开这个会话：侧栏行 aria-current，主区显示其标题', opened, opened);
check('对照组：存下规则的那个会话的行不是当前', !elsewhere, elsewhere);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
