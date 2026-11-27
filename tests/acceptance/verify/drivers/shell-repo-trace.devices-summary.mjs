import { open } from '../page.mjs';
const runDir = process.argv[2];
let { page, query, call, errors, poll, names, reset, newProject } = await open(runDir);
const result = { id: 'shell-repo-trace.devices-summary', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
// TEST-NET-1 answers nothing, so the device stays offline; no remote command runs.
const ID = `verify-remote-${stamp}`;
const NAME = `verify-remote-${stamp}`;
const devices = () => query('device.list');
// Devices are app-wide: drop any a previous run of this driver left behind.
for (const d of await devices())
  if (d.id.startsWith('verify-remote-')) await call('device.remove', { id: d.id });
const summary = () =>
  page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((e) => e.getClientRects().length && (e.getAttribute('aria-label') ?? '').startsWith('设备，'));
    return b ? { name: b.getAttribute('aria-label'), text: b.textContent.trim(), inEnd: !!b.closest('.tbe') } : null;
  })()`);
const reload = async () => {
  try {
    await page.evaluate('location.reload()');
  } catch {}
  page.close();
  ({ page, query, call, errors, poll, names, reset, newProject } = await open(runDir));
};

// The control: this machine alone shows no device button.
const alone = await devices();
check(
  '前置：device.list 只有本机',
  alone.length === 1 && alone[0].id === 'local',
  alone.map((d) => d.id),
);
await reload();
check('对照组：只有本机时标题栏没有设备按钮', (await summary()) === null, await summary());

await call('device.save', { id: ID, ssh: 'verify@192.0.2.1', name: NAME });
const listed = await poll(async () => {
  const all = await devices();
  return all.some((d) => d.id === ID) && all;
}, 20_000);
check('前置：device.list 有登记的远程设备', listed, listed && listed.map((d) => [d.id, d.online]));
// Whether the title bar follows a device added while the window is open.
const live = await poll(async () => (await summary()) ?? false, 5_000);
result.without_reload = live || null;
// A session of this driver's own runs on this machine, so its row lists it.
const { project_id } = await newProject(`verify-devices-${stamp}`, {
  'README.md': '# devices\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "devices-fixture", "private": true }\n',
});
const SESSION = `verify-device-session-${stamp}`;
await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${SESSION}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`,
});
const running = await poll(async () => {
  const local = (await devices()).find((d) => d.id === 'local');
  return local?.load.active_sessions.find((s) => s.title === SESSION) ?? false;
}, 20_000);
check('前置：device.list 的本机 active_sessions 有驱动开的会话', running, running);
await reload();
const daemon = await devices();
const online = daemon.filter((d) => d.online).length;
const shown = await poll(async () => (await summary()) ?? false);
check('登记远程设备并重开窗口后标题栏右端出现设备按钮', shown?.inEnd, shown);
check(
  '后端对照：按钮上的数字等于 device.list 的在线台数，名字写 "N 台里 M 台在线"',
  shown &&
    shown.text === String(online) &&
    shown.name === `设备，${daemon.length} 台里 ${online} 台在线`,
  { ui: shown, total: daemon.length, online },
);
check('对照组：数字加一时判 false', !(shown && shown.text === String(online + 1)));
check('不重开窗口时标题栏也跟上新登记的设备', live, result.without_reload);

// The popover: a row per device, and its footer opens the devices settings.
await page.click({ role: 'button', name: shown?.name ?? '设备，', exact: false });
const rows = () =>
  page.evaluate(`(() => {
    const p = [...document.querySelectorAll('[aria-label="设备"]')].find((e) => e.classList.contains('dvs-pop') && e.getClientRects().length);
    return p ? [...p.querySelectorAll('li.dvs-d')].map((li) => ({ name: li.querySelector('.dvs-nm')?.textContent.trim(), state: li.querySelector('.dvs-dot')?.getAttribute('aria-label'), note: li.querySelector('.dvs-n')?.textContent.trim(), sessions: [...li.querySelectorAll('.dvs-s .dvs-st')].map((e) => e.textContent.trim()) })) : null;
  })()`);
const list = await poll(async () => {
  const r = await rows();
  return r?.length === daemon.length && r;
});
result.rows = list || (await rows());
const remote = Array.isArray(list) ? list.find((r) => r.name === NAME) : undefined;
const remoteDaemon = daemon.find((d) => d.id === ID);
check('弹层里每台设备一行，行数等于 device.list', list, { ui: result.rows, daemon: daemon.length });
check(
  '远程设备那行的状态点和 device.list 的 online 一致',
  remote && remote.state === (remoteDaemon?.online ? '在线' : '连不上'),
  { row: remote, online: remoteDaemon?.online },
);
check(
  '本机那行在线',
  Array.isArray(list) && list.some((r) => r.name !== NAME && r.state === '在线'),
  list,
);
const local = Array.isArray(list) ? list.find((r) => r.name !== NAME) : undefined;
const localDaemon = daemon.find((d) => d.id === 'local');
check('登记的离线设备那行下面不列会话', remote && remote.sessions.length === 0, remote);
check('本机那行下面列出驱动开的会话标题', local && local.sessions.includes(SESSION), {
  row: local,
  daemon: localDaemon?.load.active_sessions.map((s) => s.title),
});
check(
  '后端对照：本机那行列出的会话是 device.list 的前 3 个',
  local &&
    JSON.stringify(local.sessions) ===
      JSON.stringify(localDaemon?.load.active_sessions.slice(0, 3).map((s) => s.title)),
  local?.sessions,
);
check(
  '对照组：不存在的会话标题不在本机那行',
  local && !local.sessions.includes(`${SESSION}-absent`),
);
result.shot = await page.screenshot(result.id);
await page.click({ role: 'button', name: '设备设置', exact: true });
const settings = await poll(() =>
  page.evaluate(`(() => {
    const cur = [...document.querySelectorAll('[aria-current=page]')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim());
    const close = [...document.querySelectorAll('button[aria-label="关闭设置"]')].some((e) => e.getClientRects().length);
    return close && cur.includes('设备') && { cur };
  })()`),
);
check('点 "设备设置" 打开设置的设备页', settings, settings);
const pageRow = await poll(async () => (await names(NAME)).length > 0);
check('设备页列出登记的远程设备', pageRow, await names(NAME));
check('对照组：没登记的设备名不在设备页', (await names(`${NAME}-absent`)).length === 0);

// Leave this machine alone again, for the drivers after this one.
await reset();
await call('device.remove', { id: ID });
check('收尾：移除登记的设备', !(await devices()).some((d) => d.id === ID));
const mine = (await query('board', { project_id })).sessions.find((s) => s.title === SESSION);
if (mine) await call('session.discard', { session_id: mine.id }, mine.revision);
const gone = await poll(
  async () =>
    !(await devices())
      .find((d) => d.id === 'local')
      ?.load.active_sessions.some((s) => s.title === SESSION),
);
check('收尾：丢弃驱动开的会话', gone);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
