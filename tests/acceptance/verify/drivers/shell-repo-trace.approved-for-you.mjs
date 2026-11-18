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

// A lead with a one-task plan; the task's worker asks twice, under the default charter.
const task = {
  id: 'task-one',
  title: 'Task one',
  goal: 'Do the task.',
  lane: 'lane-a',
  depends_on: [],
  source: ['The user asked for it.'],
  scope: ['src/index.ts'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  priority: 'normal',
};
const plan = {
  base_version: 0,
  headline: `Approved ${stamp}`,
  lanes: [{ id: 'lane-a', title: 'Lane A' }],
  tasks: [task],
  milestones: [],
  risks: [],
  assumptions: [],
};
const lead = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `verify-decided-lead-${stamp}\nfixture-script\n${JSON.stringify([{ tool: { name: 'update_board', arguments: plan } }])}`,
});
await poll(
  async () => (await sessions()).find((s) => s.id === lead.id)?.last_turn?.state === 'completed',
  30_000,
);
const COMMANDS = [`pnpm test --filter one-${stamp}`, `pnpm lint --filter two-${stamp}`];
const WORKER = `verify-decided-worker-${stamp}`;
const worker = await call('session.create', {
  project_id,
  runtime: 'fixture',
  permission_mode: 'ask',
  task_id: `${lead.id}:task-one`,
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
// A task session takes its task's title; the table and the sidebar show that.
const workerTitle = workerDone?.title ?? WORKER;
const today = await poll(async () => {
  const items = await decisions();
  return items.length >= 2 && items;
}, 20_000);
check(
  '前置：project.decisions 今天有 worker 的两个由 lead 批准的权限请求',
  today &&
    today.length === 2 &&
    today.every((i) => i.kind === 'prompt_approved' && i.session_id === worker.id),
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
// The popover spans every project, and so does its footer: the sum of project.decisions today over the projects.
const projects = (await query('board')).projects.filter((p) => p.removed_at === undefined);
let todayAll = 0;
for (const p of projects)
  todayAll += (
    await query('project.decisions', { project_id: p.id, since: String(since('today')) })
  ).items.length;
const footerText = () =>
  page.evaluate(
    `(() => { const f = document.querySelector('.np .np-f'); return f && f.getClientRects().length ? f.textContent.replace(/\\s+/g, ' ').trim() : null; })()`,
  );
// The footer adds up each project's read as it lands; wait for the sum.
let footer = null;
await poll(async () => (footer = await footerText()) === `替你批准了 ${todayAll} 项今天`);
result.footer_daemon = { this_project: decided.length, all_projects: todayAll };
check(
  'popover 底部是 "替你批准了 N 项今天"，N 等于各项目 project.decisions 今天的条数之和',
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
  // No footer to click: the tab is reached from the sidebar, so the table can still be checked.
  viaFooter = false;
  result.footer_click = error.message.slice(0, 300);
  await page.press('Escape');
  await page.click({ role: 'button', name: '轨迹', exact: true });
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
        task: cells[3]?.querySelector('button')?.textContent.trim() ?? null,
        when: cells[4]?.textContent.trim() ?? null,
      };
    });
  })()`);
const rowsMatch = (rows, items) =>
  !!rows &&
  rows.length === items.length &&
  rows.every((r, n) => r.action === items[n].input_summary && r.by === 'lead');
const rows = await poll(async () => {
  const r = await table();
  return r?.length === decided.length && r;
});
check('表名为 "替你批准的"', rows, rows);
check('行按顺序等于 project.decisions：操作是工具输入，批准者是 lead', rowsMatch(rows, decided), {
  ui: rows,
  daemon: decided.map((i) => [i.kind, i.input_summary, i.decided_by]),
});
check('对照组：顺序倒过来时判 false', !rowsMatch(rows, [...decided].reverse()));
check(
  '行的任务列是 worker 会话的标题（session.list 的 title）',
  rows && rows.every((r) => r.task === workerTitle),
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
  `document.querySelector('[data-session="${lead.id}"]')?.getAttribute('aria-current') === 'true'`,
);
check('点行的任务链接后打开 worker 会话：侧栏行 aria-current，主区显示其标题', opened, opened);
check('对照组：lead 会话的行不是当前', !elsewhere, elsewhere);

result.overrule = 'skipped: no fixture step makes a question a lead answered';
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
