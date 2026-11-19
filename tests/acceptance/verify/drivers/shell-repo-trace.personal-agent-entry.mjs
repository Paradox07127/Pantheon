import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'shell-repo-trace.personal-agent-entry', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const stamp = Date.now();
// The first-open checks cannot run again in this app, so a later throw still prints them.
process.on('uncaughtException', (error) => {
  check('驱动跑完', false, String(error?.message ?? error).slice(0, 400));
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
});

const homeOf = (board) => board.projects.find((p) => p.kind === 'personal') ?? null;
const visibleOf = (board) =>
  board.projects.filter((p) => p.removed_at === undefined && p.kind !== 'personal');
const homeSessions = async (home) =>
  home
    ? (await query('session.list', { project_id: home.id })).filter(
        (s) => s.resident?.kind === 'personal' && !s.archived_at,
      )
    : [];
// What waits in the projects the user sees, from one read of the board and the needs list.
const waits = async () => {
  const [board, needs] = await Promise.all([query('board'), query('needs_you.list')]);
  const ids = visibleOf(board).map((p) => p.id);
  return needs.items.filter((i) => ids.includes(i.project_id));
};
const waitsText = (n) => `各项目共 ${n} 项等你处理`;

// The sidebar's personal group and the personal agent's row in it.
const personalRow = () =>
  page.evaluate(`(() => {
    const group = [...document.querySelectorAll('[role="group"][aria-label="个人级"]')].find((g) => g.getClientRects().length);
    if (!group) return null;
    const rows = [...group.querySelectorAll('button')].filter((b) => b.getClientRects().length);
    return rows.map((b) => b.getAttribute('aria-label'));
  })()`);
const rowLabel = async () =>
  (await personalRow())?.find((n) => n?.startsWith('个人级智能体')) ?? null;
const shownTitle = () =>
  page.evaluate(
    `[...document.querySelectorAll('.app-main h1')].filter((h) => h.getClientRects().length).map((h) => h.textContent.trim())`,
  );
const onPersonal = async () => (await shownTitle()).includes('个人级智能体');
const sidebarClick = async () => {
  const label = await rowLabel();
  await page.click({ role: 'button', name: label, exact: true });
};

// 1. Before the personal agent is first opened: the row says not started, the daemon has no home.
const board0 = await query('board');
const home0 = homeOf(board0);
const sessions0 = await homeSessions(home0);
result.first_open = !home0;
const rows0 = await poll(personalRow);
check(
  '侧栏有一组 "个人级"，里面有一行个人级智能体',
  rows0?.some?.((n) => n?.startsWith('个人级智能体')),
  rows0,
);
const label0 = await rowLabel();
if (!home0) {
  check('首次打开前：行名带 "尚未开始"', label0?.includes('尚未开始'), label0);
  check(
    '首次打开前：board.projects 里没有 kind=personal 的项目',
    !home0,
    board0.projects.map((p) => [p.name, p.kind]),
  );
} else {
  // An earlier run in this app opened it already; the first-open state cannot come back.
  check('已打开过：行名不再带 "尚未开始"', label0 && !label0.includes('尚未开始'), label0);
  check(
    '已打开过：home 里正好一个个人级会话',
    sessions0.length === 1,
    sessions0.map((s) => s.id),
  );
}
check(
  '对照组：同一读法在 board.projects 里找得到 verify-app，且它不是 personal',
  board0.projects.some((p) => p.id === run.project_id && p.kind !== 'personal'),
  board0.projects.map((p) => [p.name, p.kind]),
);

// 2. Clicking the row opens the personal agent's page; the daemon holds a home with one session.
// An earlier run may have left the personal page shown; start from the project's board.
await page.click({ role: 'button', name: '项目看板', exact: true });
await poll(async () => !(await onPersonal()), 5000);
check('对照组：点之前页面标题不是 "个人级智能体"', !(await onPersonal()), await shownTitle());
await sidebarClick();
const opened = await poll(onPersonal);
check('点侧栏行后顶栏标题是 "个人级智能体"', opened, await shownTitle());
const home = await poll(async () => homeOf(await query('board')));
const sessions1 = await poll(() => homeSessions(home));
result.home = home && { id: home.id, name: home.name, kind: home.kind };
check('daemon 里有 kind=personal 的项目', home, result.home);
check(
  'home 里正好一个个人级会话',
  sessions1.length === 1,
  sessions1.map((s) => [s.id, s.title]),
);
if (home0)
  check('再次打开用的是同一个会话', sessions1[0]?.id === sessions0[0]?.id, [
    sessions0[0]?.id,
    sessions1[0]?.id,
  ]);
const label1 = await poll(async () => {
  const l = await rowLabel();
  return l && !l.includes('尚未开始') && !l.includes('启动中') && l;
});
check('打开后行名不再带 "尚未开始"', label1, label1 ?? (await rowLabel()));
const homeName = home?.name ?? 'Personal';

// 3. The home is not listed where the user picks projects.
// a. The sidebar's project menu.
await page.click({ role: 'button', name: '切换项目', exact: true });
const menu = await poll(async () =>
  (await names('')).filter((c) => c.role === 'menuitemradio').map((c) => c.name),
);
result.menu = menu;
check('项目菜单里没有 home 项目', !menu.some((n) => n.includes(homeName)), menu);
check(
  '对照组：项目菜单里找得到 verify-app',
  menu.some((n) => n.includes(run.project_name)),
  menu,
);
await page.press('Escape');
await poll(async () => !(await names('')).some((c) => c.role === 'menuitemradio'), 3000);

// b. The command palette's projects.
await page.click({ role: 'button', name: '搜索', exact: true });
await page.fill({ role: 'combobox', name: '搜索', exact: true }, '@');
const paletteProjects = () =>
  page.evaluate(`(() => {
    const g = [...document.querySelectorAll('[role="dialog"] [role="group"]')].find((x) => x.querySelector('[role="presentation"]')?.textContent.trim() === '项目');
    return g ? [...g.querySelectorAll('[role="option"]')].map((o) => o.textContent.replace(/\\s+/g, ' ').trim()) : null;
  })()`);
const palette = await poll(paletteProjects);
result.palette = palette;
check(
  '命令面板的项目列表里没有 home 项目',
  palette && !palette.some((n) => n.includes(homeName)),
  palette,
);
check(
  '对照组：命令面板的项目列表里找得到 verify-app',
  palette?.some?.((n) => n.includes(run.project_name)),
  palette,
);
// The first Escape may only clear the query; press until the palette is gone.
const closePalette = () =>
  poll(async () => {
    const shut = await page.evaluate(
      `![...document.querySelectorAll('[role="dialog"]')].some((d) => d.getClientRects().length && d.querySelector('[role="combobox"]'))`,
    );
    if (!shut) await page.press('Escape');
    return shut;
  }, 5000).then(() =>
    // Focus goes back to the search button, whose tooltip then covers the project switcher.
    poll(
      () =>
        page.evaluate(`(() => {
          document.activeElement?.blur();
          const b = document.querySelector('button[aria-label="切换项目"]');
          const r = b?.getBoundingClientRect();
          return !!r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === b;
        })()`),
      5000,
    ),
  );
await closePalette();

// c. The all-projects page's rows.
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitem', name: '全部项目', exact: true });
const tableRows = () =>
  page.evaluate(`(() => {
    const t = [...document.querySelectorAll('[role="table"][aria-label="全部项目"]')].find((x) => x.getClientRects().length);
    return t ? [...t.querySelectorAll('[role="row"]:not(.pr-head)')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)) : null;
  })()`);
const rows = await poll(async () => {
  const r = await tableRows();
  return r?.some((x) => x.includes(run.project_name)) && r;
});
result.project_rows = rows || (await tableRows());
check(
  '全部项目页的行里没有 home 项目',
  rows && !rows.some((n) => n.includes(homeName)),
  result.project_rows,
);
check('对照组：全部项目页的行里找得到 verify-app', rows, result.project_rows);

// 4. The entries count what waits in the visible projects. The all-projects page has the button,
// the other screens the sidebar row; the title bar is on both.
const projectsButton = async () =>
  (await names('个人级智能体'))
    .filter(
      (c) =>
        c.role === 'button' &&
        (c.name === '个人级智能体' || c.name.startsWith('个人级智能体，各项目共')),
    )
    .map((c) => c.name);
const titleBar = async () =>
  (await names('件事等你'))
    .filter((c) => c.role === 'button' && /^\d+ 件事等你$/.test(c.name))
    .map((c) => c.name);
const barOk = (bar, n) => (n > 0 ? bar.includes(`${n} 件事等你`) : bar.length === 0);
const buttonOk = (button, n) =>
  n > 0
    ? button.includes(`个人级智能体，${waitsText(n)}`)
    : button.includes('个人级智能体') && !button.some((b) => b.includes('等你处理'));
const rowOk = (row, n) => (n > 0 ? row?.includes(waitsText(n)) : row && !row.includes('等你处理'));
const onProjectsPage = async () => ({ button: await projectsButton(), bar: await titleBar() });
const inSidebar = async () => ({ row: await rowLabel(), bar: await titleBar() });
const projectsAt = async (n) =>
  (await poll(async () => {
    const l = await onProjectsPage();
    return buttonOk(l.button, n) && barOk(l.bar, n) && l;
  })) || { failed: await onProjectsPage() };
const sidebarAt = async (n) =>
  (await poll(async () => {
    const l = await inSidebar();
    return rowOk(l.row, n) && barOk(l.bar, n) && l;
  })) || { failed: await inSidebar() };
const toProjects = async () => {
  await page.click({ role: 'button', name: '切换项目', exact: true });
  await page.click({ role: 'menuitem', name: '全部项目', exact: true });
  await poll(async () => (await projectsButton()).length);
};
const toBoard = async () => {
  await page.click({ role: 'button', name: '搜索', exact: true });
  await page.fill({ role: 'combobox', name: '搜索', exact: true }, '项目看板');
  await page.click({ role: 'option', name: '项目看板', exact: true });
  await closePalette();
  await poll(rowLabel);
};

const n0 = (await waits()).length;
result.waits_before = n0;
const startProjects = await projectsAt(n0);
check(
  `开始时全部项目页按钮名和标题栏对上 needs_you.list 的 ${n0} 条`,
  !startProjects.failed,
  startProjects,
);
await toBoard();
const startSidebar = await sidebarAt(n0);
check(`开始时侧栏行名和标题栏对上 needs_you.list 的 ${n0} 条`, !startSidebar.failed, startSidebar);

const WAIT_TITLE = `verify-personal-wait-${stamp}`;
await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  input: `${WAIT_TITLE}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command: 'echo personal' } } }])}`,
});
const waiting = await poll(async () =>
  (await query('session.list', { project_id: run.project_id })).find(
    (s) => s.title === WAIT_TITLE && s.waiting > 0,
  ),
);
check(
  '前置：verify-app 里的 fixture 会话进入待批准',
  waiting,
  waiting && { waiting: waiting.waiting, state: waiting.state },
);
const grown = await poll(async () => {
  const w = await waits();
  return w.some((i) => i.session_id === waiting?.id) && w;
});
const n1 = grown ? grown.length : (await waits()).length;
result.waits_after = n1;
check('needs_you.list 的可见项目里多了这一条', n1 === n0 + 1, { before: n0, after: n1 });
const waitSidebar = await sidebarAt(n1);
check(`侧栏行名带 "${waitsText(n1)}"，标题栏是 "${n1} 件事等你"`, !waitSidebar.failed, waitSidebar);
const wrong = await inSidebar();
check(
  '对照组：同一读法对 N+1 判 false',
  !(rowOk(wrong.row, n1 + 1) && barOk(wrong.bar, n1 + 1)),
  wrong,
);
await toProjects();
const waitProjects = await projectsAt(n1);
check(
  `全部项目页按钮名是 "个人级智能体，${waitsText(n1)}"，标题栏是 "${n1} 件事等你"`,
  !waitProjects.failed,
  waitProjects,
);

// 5. Opening the entry again shows the same session.
await page.click({ role: 'button', name: `个人级智能体，${waitsText(n1)}`, exact: true });
const reopened = await poll(onPersonal);
check('点全部项目页的按钮后顶栏标题是 "个人级智能体"', reopened, await shownTitle());
const sessions2 = await homeSessions(home);
check(
  '再点一次：home 的会话数没变，还是同一个会话',
  sessions2.length === 1 && sessions2[0].id === sessions1[0]?.id,
  { before: sessions1.map((s) => s.id), after: sessions2.map((s) => s.id) },
);

// Settle the wait made above, so the counts go back.
const item = (await query('needs_you.list')).items.find(
  (i) => i.session_id === waiting?.id && i.kind === 'permission',
);
if (item)
  await call(
    'approval.respond',
    { approval_id: item.source.id, decision: 'reject' },
    item.source.revision,
  );
const settledWaits = await poll(async () => {
  const w = await waits();
  return !w.some((i) => i.session_id === waiting?.id) && w;
});
const n2 = settledWaits ? settledWaits.length : (await waits()).length;
const zero = n2 === 0 ? '，名字里没有 "等你处理"' : '';
const backSidebar = await sidebarAt(n2);
check(`拒绝后侧栏行名回到 needs_you.list 的 ${n2} 条${zero}`, !backSidebar.failed, backSidebar);
await toProjects();
const backProjects = await projectsAt(n2);
check(`拒绝后全部项目页按钮名回到 ${n2} 条${zero}`, !backProjects.failed, backProjects);

// 6. A message from the personal page's composer gets a reply.
await page.click({ role: 'button', name: backProjects.button?.[0] ?? '个人级智能体', exact: true });
await poll(onPersonal);
const REPLY = `个人级回复${stamp}`;
const escaped = [...REPLY]
  .map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
  .join('');
const MESSAGE = `verify-personal-${stamp}\nfixture-script\n[{"say":"${escaped}"}]`;
const turnsBefore = (await query('board')).session_turns.filter(
  (t) => t.session_id === sessions1[0]?.id,
).length;
const convoText = () =>
  // Kept screens stay mounted hidden; only the shown conversation counts.
  page.evaluate(
    `[...document.querySelectorAll('main[aria-label="对话"]')].find((m) => m.getClientRects().length > 0)?.innerText ?? ''`,
  );
check('对照组：发送前对话里没有这条回复', !(await convoText()).includes(REPLY));
await page.fill({ role: 'textbox', name: '发给 个人级智能体', exact: true }, MESSAGE);
await page.click({ role: 'button', name: '发送', exact: true });
const replied = await poll(async () => (await convoText()).includes(REPLY), 20_000);
check('对话里出现回复', replied);
const done = await poll(async () => {
  const [sessions, board] = await Promise.all([homeSessions(home), query('board')]);
  const s = sessions.find((x) => x.id === sessions1[0]?.id);
  const turns = board.session_turns.filter((t) => t.session_id === s?.id).length;
  return (
    s?.last_turn?.state === 'completed' &&
    turns > turnsBefore && { state: s.last_turn.state, turns }
  );
}, 20_000);
check(
  'session.list 里这个会话的新回合完成',
  done,
  done || (await homeSessions(home)).map((s) => s.last_turn),
);

// 7. The tray's entry: the popover window's button asks the main process to show the page.
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitem', name: '全部项目', exact: true });
const left = await poll(async () => !(await onPersonal()), 5000);
check('前置：离开个人级页面', left, await shownTitle());
const list = await (await fetch(`http://127.0.0.1:${run.port}/json/list`)).json();
const tray = list.find((e) => e.type === 'page' && e.url.includes('kind=popover'));
const trayEval = async (expression) => {
  const ws = new WebSocket(tray.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) resolve(m.result);
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }),
    );
  });
  ws.close();
  return reply?.result?.value;
};
if (!tray)
  check(
    '托盘窗口是 CDP 目标',
    false,
    list.map((e) => e.url),
  );
else {
  const trayButtons = () =>
    trayEval(
      `[...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim())`,
    );
  const shown = await poll(
    async () => (await trayButtons())?.includes('打开个人级智能体') && (await trayButtons()),
    5000,
  );
  check('托盘有按钮 "打开个人级智能体"', shown, shown || (await trayButtons()));
  await trayEval(
    `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开个人级智能体')?.click() ?? false`,
  );
  const viaTray = await poll(onPersonal, 5000);
  check('点托盘按钮后主窗口切到个人级页面', viaTray, await shownTitle());
  const sessions3 = await homeSessions(home);
  check(
    '托盘打开的是同一个会话',
    sessions3.length === 1 && sessions3[0].id === sessions1[0]?.id,
    sessions3.map((s) => s.id),
  );
}

// d. The settings page that lists projects.
await page.click({ role: 'button', name: '搜索', exact: true });
await page.fill({ role: 'combobox', name: '搜索', exact: true }, '设置:项目');
await page.click({ role: 'option', name: '设置:项目', exact: true });
const settingsRows = () =>
  page.evaluate(`(() => {
    const l = [...document.querySelectorAll('[role="list"][aria-label="项目"]')].find((x) => x.getClientRects().length);
    return l ? [...l.querySelectorAll('[role="listitem"]')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)) : null;
  })()`);
const srows = await poll(async () => {
  const r = await settingsRows();
  return r?.some((x) => x.includes(run.project_name)) && r;
});
result.settings_rows = srows || (await settingsRows());
check(
  '设置的项目页里没有 home 项目',
  srows && !srows.some((n) => n.includes(homeName)),
  result.settings_rows,
);
check('对照组：设置的项目页里找得到 verify-app', srows, result.settings_rows);

result.shot = await page.screenshot('personal-agent-entry');
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
