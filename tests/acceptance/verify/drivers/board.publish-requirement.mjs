import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
let { run, page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.publish-requirement', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// The screen the sidebar marks as current.
const currentScreen = () =>
  page.evaluate(
    `[...document.querySelectorAll('[aria-current=page]')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`,
  );

// A direct session of another project (boot's), which this project's bar must not offer.
const ELSEWHERE = `verify-elsewhere-${Date.now()}`;
await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  input: `${ELSEWHERE}\nfixture-script\n${JSON.stringify([{ say: 'elsewhere' }])}`,
});

// A project opened for the first time lands on its board, even when the app was on another screen.
await page.click({ role: 'button', name: '记忆', exact: true });
const before = await poll(async () => {
  const c = await currentScreen();
  return c.includes('记忆') && c;
});
check('前置：打开新项目前在 "记忆"', before, before || (await currentScreen()));
const stamp = Date.now();
const { project_id } = await newProject(`verify-request-${stamp}`, {
  'README.md': '# request\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "request-fixture", "private": true }\n',
});
const landed = await poll(async () => {
  const c = await currentScreen();
  return c.includes('项目看板') && c;
});
check('新打开的项目落在 "项目看板"', landed, landed || (await currentScreen()));
check('对照组：当前不是 "记忆"', landed && !landed.includes('记忆'), landed);

const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const sessions = () => query('session.list', { project_id });
const idle = (id) =>
  poll(async () => {
    const s = (await sessions()).find((x) => x.id === id);
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
  }, 30_000);

// A plan lead (a direct session that wrote a plan) and a plain direct session.
const task = (id, title) => ({
  id,
  title,
  goal: `Do ${title}.`,
  lane: 'lane-a',
  milestone: 'milestone-a',
  estimate: 3,
  depends_on: [],
  source: ['The user asked for it.'],
  scope: ['src/index.ts'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  priority: 'normal',
});
const plan = {
  base_version: 0,
  headline: `Request ${stamp}`,
  lanes: [{ id: 'lane-a', title: 'Lane A' }],
  tasks: [task('task-one', 'Task one')],
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
const LEAD = `verify-lead-${stamp}`;
const lead = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${LEAD}\nfixture-script\n${JSON.stringify([{ tool: { name: 'update_board', arguments: plan } }])}`,
});
const DIRECT = `verify-direct-${stamp}`;
const direct = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${DIRECT}\nfixture-script\n${JSON.stringify([{ say: 'ready' }])}`,
});
check('前置：lead 会话回合结束', (await idle(lead.id))?.last_turn?.state === 'completed');
check('前置：直接会话回合结束', (await idle(direct.id))?.last_turn?.state === 'completed');
const view = await poll(async () => {
  const v = await query('board.view', { project_id, days: '7' });
  return v.leads?.some((l) => l.session_id === lead.id) && v;
}, 30_000);
check(
  '前置：board.view 的 leads 有这个 lead',
  view,
  view?.leads?.map((l) => l.session_id),
);

// What the menu should list, read from the daemon: residents, plan leads, direct sessions, new lead.
const BUILT_IN = { Assistant: ['assistant', '助理'], Triage: ['triage', '问题处理'] };
const agentLabel = (a) => (BUILT_IN[a.name]?.[0] === a.template ? BUILT_IN[a.name][1] : a.name);
const agents = (await query('agent.list', { project_id }))
  .filter((a) => !a.archived_at)
  .sort(
    (a, b) =>
      (a.template === 'assistant' ? 0 : a.template === 'triage' ? 1 : 2) -
        (b.template === 'assistant' ? 0 : b.template === 'triage' ? 1 : 2) ||
      a.created_at - b.created_at,
  );
const assistantAgent = agents.find((a) => a.template === 'assistant');
const ASSISTANT = agentLabel(assistantAgent);
const leadTitle = view?.leads?.find((l) => l.session_id === lead.id)?.title ?? LEAD;
const expectedMenu = [...agents.map(agentLabel), leadTitle, DIRECT, '新 lead'];
result.expected_menu = expectedMenu;

await page.click({ role: 'button', name: '项目看板', exact: true });
const targetButton = () =>
  poll(async () => (await names('发送给')).filter((c) => c.role === 'button').map((c) => c.name));
const firstTarget = await targetButton();
check(
  `目标按钮默认叫 "发送给${ASSISTANT}"`,
  firstTarget?.length === 1 && firstTarget[0] === `发送给${ASSISTANT}`,
  firstTarget,
);
check('对照组：默认不是 "发送给新 lead"', firstTarget?.[0] !== '发送给新 lead', firstTarget);

const menuItems = () =>
  poll(async () => {
    const items = await page.evaluate(
      `[...document.querySelectorAll('[role=menuitemradio]')].filter((el) => el.getClientRects().length).map((el) => ({ name: el.textContent.trim(), checked: el.getAttribute('aria-checked') === 'true' }))`,
    );
    return items.length > 0 && items;
  });
await page.click({ role: 'button', name: `发送给${ASSISTANT}`, exact: true });
const menu = await menuItems();
check(
  '菜单依次是 助理、其他常驻 agent、计划 lead、直接会话、新 lead',
  menu && menu.map((m) => m.name).join('|') === expectedMenu.join('|'),
  { ui: menu && menu.map((m) => m.name), daemon: expectedMenu },
);
check(
  '对照组：新 lead 放在最前的顺序判 false',
  !(
    menu &&
    menu.map((m) => m.name).join('|') === ['新 lead', ...expectedMenu.slice(0, -1)].join('|')
  ),
);
check('菜单里选中的是助理', menu && menu.find((m) => m.checked)?.name === ASSISTANT, menu);
result.shot = await page.screenshot('pair-request-target');
copyFileSync(
  path.join(runDir, result.shot.file),
  path.join(runDir, 'screens', 'pair-request-target.png'),
);
await page.press('Escape');

const menuOpen = () =>
  page.evaluate(
    `[...document.querySelectorAll('[role=menuitemradio]')].some((el) => el.getClientRects().length)`,
  );
// Picks a target; records whether the menu stayed open after the pick, then closes it.
const pick = async (name) => {
  let by = 'click';
  try {
    await page.click({ role: 'menuitemradio', name, exact: true });
  } catch (error) {
    if (!/outside the viewport/.test(error.message)) throw error;
    // An entry below the window's edge is reached from the keyboard: Down until it is highlighted, Enter.
    by = 'keyboard';
    const highlighted = `document.activeElement?.getAttribute('role') === 'menuitemradio' && document.activeElement.textContent.trim() === ${JSON.stringify(name)}`;
    for (let n = 0; n < 80 && !(await page.evaluate(highlighted)); n++)
      await page.press('ArrowDown');
    await page.press('Enter');
  }
  const open = await menuOpen();
  (result.menu_open_after_pick ??= []).push({ name, open, by });
  if (open) await page.press('Escape');
  await poll(async () => !(await menuOpen()), 3000);
};
// Send with the default target: a turn in the Assistant's session.
const turns = async () => (await board()).session_turns ?? [];
const assistantSession = async () =>
  (await sessions()).find((s) => s.resident?.agent_id === assistantAgent.id && !s.archived_at);
const sendText = async (title) => {
  await page.fill(
    { role: 'textbox', name: '需求', exact: true },
    `${title}\nfixture-script\n${JSON.stringify([{ say: 'noted' }])}`,
  );
  await page.click({ role: 'button', name: '发送', exact: true });
};
const ASK1 = `verify-ask-assistant-${stamp}`;
await sendText(ASK1);
const toAssistant = await poll(async () => {
  const s = await assistantSession();
  const turn = s && (await turns()).find((t) => t.session_id === s.id && t.input?.includes(ASK1));
  return turn && { session: s.id, turn: turn.id, state: turn.state };
}, 20_000);
check('默认目标发送后助理会话有这个回合', toAssistant, toAssistant);
const receipt = await poll(async () =>
  (await names(`回执：${ASK1}`)).find((c) => c.name === `回执：${ASK1}`),
);
check('出现回执 "回执：{第一行}"', receipt, receipt);
const elsewhere = (await turns()).filter(
  (t) => t.input?.includes(ASK1) && t.session_id !== toAssistant?.session,
);
check(
  '对照组：别的会话没有收到这条',
  elsewhere.length === 0,
  elsewhere.map((t) => t.session_id),
);
// The receipt's steps against the turn the daemon holds.
const steps = async () =>
  page.evaluate(
    `[...document.querySelectorAll('section[aria-label=${JSON.stringify(`回执：${ASK1}`)}] ol li')].map((li) => li.getAttribute('data-st'))`,
  );
const doneTurn = await poll(async () => {
  const t = (await turns()).find((x) => x.id === toAssistant?.turn);
  return t && !['queued', 'running'].includes(t.state) && t;
}, 30_000);
const shownSteps = await poll(async () => {
  const s = await steps();
  return s.every((x) => x === 'done') && s;
});
check(
  '回执进度与回合一致：回合 completed，四步都完成',
  doneTurn?.state === 'completed' && shownSteps,
  { turn: doneTurn?.state, steps: shownSteps || (await steps()) },
);
result.receipt_links = await page.evaluate(
  `[...document.querySelectorAll('section[aria-label=${JSON.stringify(`回执：${ASK1}`)}] a, section[aria-label=${JSON.stringify(`回执：${ASK1}`)}] button')].length`,
);

// Choose the direct session; the choice survives a reload; sending goes there.
await page.click({ role: 'button', name: `发送给${ASSISTANT}`, exact: true });
await pick(DIRECT);
const chosen = await targetButton();
check(`选直接会话后按钮叫 "发送给${DIRECT}"`, chosen?.[0] === `发送给${DIRECT}`, chosen);
await page.evaluate('window.__beforeReload = true');
try {
  await page.evaluate('location.reload()');
} catch {
  // The reload ends this connection.
}
page.close();
({ page, query, call, errors, poll, names } = await open(runDir, { ms: 300_000 }));
check(
  '前置：页面确实重新加载了',
  (await page.evaluate('window.__beforeReload === undefined')) === true,
);
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitemradio', name: `verify-request-${stamp}`, exact: false });
await page.click({ role: 'button', name: '项目看板', exact: true });
const afterReload = await targetButton();
check(`刷新后按钮仍叫 "发送给${DIRECT}"`, afterReload?.[0] === `发送给${DIRECT}`, afterReload);
const ASK2 = `verify-ask-direct-${stamp}`;
await sendText(ASK2);
const toDirect = await poll(
  async () => (await turns()).find((t) => t.input?.includes(ASK2)),
  20_000,
);
check('发到直接会话：回合在这个会话上', toDirect?.session_id === direct.id, toDirect?.session_id);
check(
  '对照组：不在助理会话上',
  toDirect && toDirect.session_id !== (await assistantSession())?.id,
  toDirect?.session_id,
);

// The menu's sessions against session.list of this project.
const own = new Set((await sessions()).map((s) => s.id));
const others = (await query('board')).sessions.filter((s) => s.project_id !== project_id);
await page.click({ role: 'button', name: `发送给${DIRECT}`, exact: true });
const listed = (await menuItems()) || [];
const foreign = listed
  .map((m) => m.name)
  .filter((name) => others.some((s) => s.title === name) && !expectedMenu.includes(name));
check('菜单里的会话都属于本项目（session.list）', foreign.length === 0, {
  foreign: foreign.slice(0, 5),
  count: foreign.length,
});
check(
  '对照组：本项目的直接会话在菜单里',
  listed.some((m) => m.name === DIRECT) && own.has(direct.id),
);
// What a send to such an entry does.
if (foreign.length) {
  await pick(foreign[0]);
  const ASK_FOREIGN = `verify-ask-foreign-${stamp}`;
  await sendText(ASK_FOREIGN);
  const alert = await poll(async () =>
    page.evaluate(
      `[...document.querySelectorAll('.pb [role=alert]')].map((a) => a.textContent).join(' ')`,
    ),
  );
  const landedTurn = ((await query('board')).session_turns ?? []).find((t) =>
    t.input?.includes(ASK_FOREIGN),
  );
  result.foreign_send = { target: foreign[0], alert, turn: landedTurn?.session_id ?? null };
}
if (await menuOpen()) await page.press('Escape');
await poll(async () => !(await menuOpen()), 3000);

// New lead: a new session takes the requirement, and the bar forgets the choice after the send.
await page.click({ role: 'button', name: (await targetButton())[0], exact: true });
await pick('新 lead');
const creating = await targetButton();
check('选新 lead 后按钮叫 "发送给新 lead"', creating?.[0] === '发送给新 lead', creating);
const ASK3 = `verify-ask-new-lead-${stamp}`;
await sendText(ASK3);
const created = await poll(async () => (await sessions()).find((s) => s.title === ASK3), 20_000);
check('新 lead：session.list 多出标题为第一行的会话', created, created?.id);
const afterSend = await poll(async () => {
  const b = await targetButton();
  return b?.[0] !== '发送给新 lead' && b;
});
check('发送后不再是 "发送给新 lead"', afterSend, afterSend || (await targetButton()));
result.after_new_lead = afterSend;

// A long menu: thirty more direct sessions; the menu stays inside the window and its last entry scrolls into view.
const MANY = Array.from(
  { length: 30 },
  (_, n) => `verify-many-${stamp}-${String(n).padStart(2, '0')}`,
);
const many = [];
for (const title of MANY)
  many.push(
    await call('session.create', {
      project_id,
      runtime: 'fixture',
      input: `${title}\nfixture-script\n${JSON.stringify([{ say: 'ready' }])}`,
    }),
  );
for (const s of many) await idle(s.id);
await poll(async () => (await names('发送给')).some((c) => c.role === 'button'));
await page.click({ role: 'button', name: (await targetButton())[0], exact: true });
const longMenu = (await menuItems()) || [];
const lastName = MANY.at(-1);
check(
  '前置：长菜单里有最后一个直接会话',
  longMenu.some((m) => m.name === lastName),
  {
    count: longMenu.length,
    tail: longMenu.slice(-3).map((m) => m.name),
  },
);
// The visible part of the menu and of its last entry, clipped by every scrolling ancestor.
const geometry = () =>
  page.evaluate(`(() => {
    const items = [...document.querySelectorAll('[role=menuitemradio]')].filter((el) => el.getClientRects().length);
    const last = items.find((el) => el.textContent.trim() === ${JSON.stringify(lastName)});
    const menu = last?.closest('[role=menu]');
    if (!last || !menu) return null;
    let scroller = last.parentElement;
    while (scroller && scroller !== document.body && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    if (scroller === document.body) scroller = null;
    const m = menu.getBoundingClientRect(), l = last.getBoundingClientRect();
    const clip = scroller ? scroller.getBoundingClientRect() : m;
    return {
      window: innerHeight,
      menu: { top: Math.round(m.top), bottom: Math.round(m.bottom) },
      last: { top: Math.round(l.top), bottom: Math.round(l.bottom) },
      scrollable: !!scroller,
      lastVisible: l.top >= Math.max(0, clip.top) - 1 && l.bottom <= Math.min(innerHeight, clip.bottom) + 1,
    };
  })()`);
const atOpen = await geometry();
result.long_menu_at_open = atOpen;
check(
  '长菜单的下沿在窗口内',
  atOpen && atOpen.menu.top >= 0 && atOpen.menu.bottom <= atOpen.window,
  atOpen,
);
check(
  '对照组：打开时最后一项在可见区外（长菜单确实要滚动）',
  atOpen && !atOpen.lastVisible,
  atOpen,
);
// Scroll with the mouse wheel over the menu, as the user would.
const menuPoint = await page.evaluate(`(() => {
  const menu = [...document.querySelectorAll('[role=menu]')].find((el) => el.querySelector('[role=menuitemradio]') && el.getClientRects().length);
  const r = menu?.getBoundingClientRect();
  return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height, innerHeight - r.top) / 2) };
})()`);
let scrolled = null;
for (let n = 0; n < 30 && menuPoint && !scrolled?.lastVisible; n++) {
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...menuPoint,
    deltaX: 0,
    deltaY: 300,
  });
  scrolled = await geometry();
}
scrolled ??= await geometry();
result.long_menu_scrolled = scrolled;
check('滚动菜单后最后一项在窗口内可见', scrolled?.scrollable && scrolled.lastVisible, scrolled);
// Every entry of the long menu is a resident, this project's lead or session (session.list), or the new lead.
const ownTitles = new Set((await sessions()).map((s) => s.title));
const known = (name) => ownTitles.has(name) || expectedMenu.includes(name) || name === leadTitle;
const strangers = longMenu.map((m) => m.name).filter((name) => !known(name));
check('长菜单的每一项都属于本项目（session.list）', longMenu.length > 0 && strangers.length === 0, {
  strangers,
  count: longMenu.length,
});
check('对照组：别的项目的会话标题判为不属于本项目', !known(ELSEWHERE));
await page.press('Escape');

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
