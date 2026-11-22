import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'shell-repo-trace.needs-popover', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// The row title each decision kind gets (data/attention.ts, zh-CN/attention.json).
const DECISION = {
  question: '问题',
  permission: '权限',
  budget: '预算',
};

// The title bar counts every project's waits: settle what earlier drivers left waiting anywhere,
// so the counts below are this run's.
const sessionsNow = (await query('board')).sessions;
for (const item of (await query('needs_you.list')).items) {
  if (item.kind === 'session.failed') {
    // The daemon archives only an ended session.
    const session = sessionsNow.find((s) => s.id === (item.session_id ?? item.source.id));
    if (['failed', 'idle', 'ready', 'done', 'merged', 'discarded'].includes(session?.state))
      await call('session.archive', { session_id: session.id }, session.revision);
  } else if (item.kind === 'permission')
    await call(
      'approval.respond',
      { approval_id: item.source.id, decision: 'reject' },
      item.source.revision,
    );
}
// A wait no command settles leaves with its project.
const unsettled = (await query('needs_you.list')).items;
result.removed = [];
for (const id of new Set(unsettled.map((i) => i.project_id))) {
  if (id === run.project_id) continue;
  const project = (await query('board')).projects.find((p) => p.id === id);
  try {
    await call('project.remove', { project_id: id }, project?.revision);
    result.removed.push(project?.name);
  } catch (error) {
    result.removed.push(`${project?.name}: ${error.message.slice(0, 200)}`);
  }
}
const cleared = await poll(async () => (await query('needs_you.list')).items.length === 0);
check(
  '前置：开始时 needs_you.list 为空（全部项目）',
  cleared,
  (await query('needs_you.list')).items.map((i) => [i.kind, i.reason]),
);

const stamp = Date.now();
const { project_id, name: projectName } = await newProject(`verify-needs-${stamp}`, {
  'README.md': '# needs\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "needs-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'ask' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const allNeeds = async () => (await query('needs_you.list')).items;
const mine = async () => (await allNeeds()).filter((i) => i.project_id === project_id);

// Two direct sessions each wait on a permission request.
const waitingOn = async (title, command) => {
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    permission_mode: 'ask',
    input: `${title}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command } } }])}`,
  });
  return poll(async () =>
    (await query('session.list', { project_id })).find((s) => s.title === title && s.waiting > 0),
  );
};
const sessionA = await waitingOn(`verify-needs-a-${stamp}`, 'echo a');
const sessionB = await waitingOn(`verify-needs-b-${stamp}`, 'echo b');
const titleOf = { [sessionA?.id]: sessionA?.title, [sessionB?.id]: sessionB?.title };
const items = await poll(async () => {
  const list = await mine();
  return list.length >= 2 && list;
}, 20_000);
check(
  '前置：needs_you.list 有本项目的两个权限请求，没有别的',
  items && items.length === 2 && items.every((i) => i.decision === 'permission'),
  items?.map((i) => [i.kind, i.decision, i.session_id]),
);

// The popover as shown: its label, empty text, and per project group the rows.
const shown = () =>
  page.evaluate(`(() => {
    const pop = document.querySelector('.np');
    if (!pop || !pop.getClientRects().length) return null;
    return {
      label: pop.getAttribute('aria-label'),
      empty: pop.querySelector('.np-x')?.textContent ?? null,
      groups: [...pop.querySelectorAll('[role=group]')].map((g) => ({
        name: g.getAttribute('aria-label'),
        rows: [...g.querySelectorAll('li')].map((li) => {
          const actions = [...li.querySelectorAll('.np-a button')];
          const more = actions.filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('更多操作'));
          return {
            title: li.querySelector('.np-t')?.textContent ?? null,
            open: li.querySelector('button')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
            primary: actions.filter((b) => !more.includes(b)).map((b) => b.textContent.trim()),
            more: more.map((b) => b.getAttribute('aria-label')),
          };
        }),
      })),
    };
  })()`);
// Where keyboard focus is: the row index and button text inside the popover, else the element's name.
const focus = () =>
  page.evaluate(`(() => {
    const el = document.activeElement;
    const rows = [...document.querySelectorAll('.np li')];
    const row = rows.findIndex((li) => li.contains(el));
    return {
      row,
      text: el?.textContent?.trim().slice(0, 40) ?? null,
      label: el?.getAttribute?.('aria-label') ?? null,
      tag: el?.tagName ?? null,
    };
  })()`);
const trigger = async () =>
  (await names('件事等你')).filter((c) => c.role === 'button' && /^\d+ 件事等你$/.test(c.name));
const menuItems = () =>
  poll(async () => {
    const items = (await names('')).filter((c) => c.role === 'menuitem').map((c) => c.name);
    return items.length > 0 && items;
  });
// A row's title is its decision kind; its open button reads the title, then the session's.
const expectRows = (list, decisionOf = (i) => DECISION[i.decision]) =>
  list.map((i) => ({ title: decisionOf(i), open: `${decisionOf(i)}${titleOf[i.session_id]}` }));
const sameRows = (ui, want) =>
  !!ui &&
  ui.length === want.length &&
  ui.every((r, n) => r.title === want[n].title && r.open === want[n].open);

// Open the title bar's needs-you button.
const all = await allNeeds();
const triggers = await trigger();
check(
  '标题栏按钮名是 "{needs_you.list 条数} 件事等你"',
  triggers.length === 1 && triggers[0].name === `${all.length} 件事等你`,
  { triggers, daemon: all.length },
);
await page.click({ role: 'button', name: `${all.length} 件事等你`, exact: true });
const pop = await poll(async () => {
  const s = await shown();
  return s?.groups.some((g) => g.name === projectName) && s;
});
check('popover 的名字是 "等你的 N 件事"', pop?.label === `等你的 ${all.length} 件事`, pop?.label);
const rowCount = pop?.groups.reduce((n, g) => n + g.rows.length, 0);
check('popover 行数等于 needs_you.list 条数', rowCount === all.length, {
  ui: rowCount,
  daemon: all.length,
});
const group = pop?.groups.find((g) => g.name === projectName);
const now = await mine();
check(
  '本项目的行按顺序等于 needs_you.list：标题是决定种类，后面是会话标题',
  sameRows(group?.rows, expectRows(now)),
  {
    ui: group?.rows.map((r) => [r.title, r.open]),
    daemon: now.map((i) => [i.decision, titleOf[i.session_id]]),
  },
);
check(
  '对照组：顺序倒过来时同一读法判 false',
  !sameRows(group?.rows, expectRows([...now].reverse())),
);
check(
  '对照组：把权限当成"问题"，同一读法判 false',
  !sameRows(
    group?.rows,
    expectRows(now, () => '问题'),
  ),
);
const everyRow = pop?.groups.flatMap((g) => g.rows) ?? [];
check(
  '每行恰好一个主按钮',
  everyRow.length > 0 && everyRow.every((r) => r.primary.length === 1),
  everyRow.map((r) => [r.title, r.primary]),
);
check(
  '其余操作在 "更多操作：{行标题}" 菜单里，每行至多一个',
  everyRow.every((r) => r.more.length <= 1 && r.more.every((m) => m === `更多操作：${r.title}`)),
  everyRow.map((r) => [r.title, r.more]),
);
check(
  '权限行主按钮是 "允许"，有 "更多操作：权限"',
  group?.rows.length === 2 &&
    group.rows.every((r) => r.primary[0] === '允许' && r.more[0] === '更多操作：权限'),
  group?.rows,
);
const atShot = await poll(shown);
check(
  '截图时 popover 开着且有本项目的 2 行',
  atShot?.groups.find((g) => g.name === projectName)?.rows.length === 2,
);
result.shot = await page.screenshot('pair-needs-popover');
copyFileSync(
  path.join(process.argv[2], result.shot.file),
  path.join(process.argv[2], 'screens', 'pair-needs-popover.png'),
);

// A row's own button opens its session and closes the popover.
await page.click({
  role: 'button',
  name: `权限${sessionB.title}`,
  exact: true,
  within: { role: 'group', name: projectName, exact: true },
});
const current = (id) =>
  page.evaluate(
    `document.querySelector('[data-session="${id}"]')?.getAttribute('aria-current') === 'true'`,
  );
const openedB = await poll(async () => (await shown()) === null && (await current(sessionB.id)));
check('点第二行打开它的会话：popover 关上，侧栏这一行 aria-current', openedB, {
  popover: await shown(),
  current: await current(sessionB.id),
});
check('对照组：第一行的会话不是当前', !(await current(sessionA.id)));
check(
  '打开会话不答请求：needs_you.list 还是两个权限请求',
  (await allNeeds()).filter((i) => i.decision === 'permission').length === 2,
  (await allNeeds()).map((i) => [i.project_id === project_id, i.kind]),
);
await poll(async () => (await trigger())[0]?.name === '2 件事等你');
await page.click({ role: 'button', name: '2 件事等你', exact: true });
const two = await poll(async () => {
  const s = await shown();
  return s?.groups[0]?.rows.length === 2 && s;
});
check(
  'popover 显示 2 行',
  two,
  (two || (await shown()))?.groups?.map((g) => g.rows.length),
);

// Records every element that takes focus from now on, so a focus that lasts one frame still shows.
await page.evaluate(`(() => {
  window.__focusLog = [];
  if (window.__focusLogged) return;
  window.__focusLogged = true;
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    (window.__focusLog ??= []).push({
      label: el.getAttribute?.('aria-label') ?? null,
      text: (el.textContent ?? '').trim().slice(0, 40),
      in_popover: !!el.closest?.('.np'),
    });
  }, true);
})()`);
const focusLog = () => page.evaluate('window.__focusLog');

// Allow the first row from the keyboard: the popover opens with focus on the first row; Tab to its primary, Enter.
// Where the popover puts focus on open is not part of this item; it is recorded.
result.focus_at_open = await focus();
// Tab until the first row's primary has focus; Enter only there, so no other row is opened.
let onPrimary = null;
for (let n = 0; n < 4 && !onPrimary; n++) {
  await page.press('Tab');
  onPrimary = await poll(async () => {
    const f = await focus();
    return f.row === 0 && f.text === '允许' && f;
  }, 500);
}
check('前置：Tab 到第一行的 "允许"', onPrimary, onPrimary || (await focus()));
if (!onPrimary) {
  result.errors = await errors();
  console.log(JSON.stringify(result, null, 2));
  page.close();
  process.exit(0);
}
await page.press('Enter');
const afterFirst = await poll(async () => {
  const s = await shown();
  return s?.groups[0]?.rows.length === 1 && s;
});
check(
  '允许后这一行离开，剩 1 行',
  afterFirst,
  (afterFirst || (await shown()))?.groups?.map((g) => g.rows.length),
);
const daemonAfterFirst =
  (await poll(async () => {
    const list = await allNeeds();
    return list.length === 1 && list;
  })) || (await allNeeds());
check(
  'needs_you.list 剩下的是第二行的会话（第一行的请求已答）',
  daemonAfterFirst?.[0]?.session_id === sessionB.id,
  daemonAfterFirst?.map((i) => i.session_id),
);
check(
  '对照组：剩下的不是第一行的会话',
  daemonAfterFirst?.[0]?.session_id !== sessionA.id,
  daemonAfterFirst?.map((i) => i.session_id),
);
const f1 = await poll(async () => {
  const f = await focus();
  return f.row === 0 && f.text === '允许' && f;
}, 3000);
check('焦点在下一行的主按钮 "允许" 上', f1, f1 || (await focus()));
check('对照组：焦点不在 "更多操作" 上', f1 && !(f1.label ?? '').startsWith('更多操作'), f1);

// Deny the last row from its menu; the title bar's button goes once nothing waits.
await page.click({ role: 'button', name: '更多操作：权限', exact: true });
const permissionMenu = await menuItems();
check(
  '"更多操作：权限" 菜单里是 "拒绝"',
  permissionMenu?.length === 1 && permissionMenu[0] === '拒绝',
  permissionMenu,
);
await page.evaluate('window.__focusLog.length = 0');
await page.click({ role: 'menuitem', name: '拒绝', exact: true });
const emptyNow = await poll(async () => (await allNeeds()).length === 0, 10_000);
check('拒绝后 needs_you.list 为空', emptyNow);
const gone = await poll(
  async () => (await trigger()).length === 0 && (await shown()) === null,
  5000,
);
result.observed_title_bar = {
  trigger_gone: Boolean(gone),
  focus_log: await focusLog(),
  focus_now: await focus(),
};

// All projects keeps its needs-you button: the last row there returns focus to it.
const third = await waitingOn(`verify-needs-c-${stamp}`, 'echo c');
check('前置：再造一个权限请求', third, third?.id);
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitem', name: '全部项目', exact: false });
// The cell reads "等你{count}" and then which projects the count spans.
const waitingCount = (await allNeeds()).length;
const cell = await poll(async () =>
  (await names('等你')).find(
    (c) => c.role === 'button' && c.name.startsWith(`等你${waitingCount}`),
  ),
);
check('全部项目页的 "等你" 按钮计数等于 needs_you.list', cell, {
  cell,
  daemon: waitingCount,
});
await page.click({ role: 'button', name: cell.name, exact: true });
const one = await poll(async () => {
  const s = await shown();
  return s?.groups[0]?.rows.length === 1 && s;
});
check('全部项目页 popover 显示 1 行"权限"', one?.groups[0]?.rows[0]?.title === '权限', one);
await page.evaluate('window.__focusLog.length = 0');
// Tab from wherever the popover put focus until the row's primary button has it.
let onOnly = null;
for (let n = 0; n < 4 && !onOnly; n++) {
  await page.press('Tab');
  onOnly = await poll(async () => {
    const f = await focus();
    return f.row === 0 && f.text === '允许' && f;
  }, 500);
}
check('前置：Tab 到这一行的 "允许"', onOnly, onOnly || (await focus()));
await page.press('Enter');
const lastDone = await poll(async () => (await allNeeds()).length === 0, 10_000);
check('允许后 needs_you.list 为空', lastDone);
const back = await poll(async () => {
  const f = await focus();
  return /^等你\d+/.test(f.text ?? '') && f;
}, 3000);
check('最后一行处理后焦点回到打开 popover 的 "等你" 按钮', back, back || (await focus()));
check('对照组：焦点不在 popover 里', back && back.row === -1, back);
const empty = await poll(async () => (await shown())?.empty);
check('没有等你的事时 popover 显示 "没有需要你的事。"', empty === '没有需要你的事。', empty);
check('对照组：空文案不是英文原文', empty !== 'Nothing needs you.', empty);
result.focus_log_projects = await focusLog();
await page.press('Escape');

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
