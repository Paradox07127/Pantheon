import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, query, call, errors, poll, names, reset } = await open(process.argv[2]);
const result = { id: 'diagnosis.debug-view-send', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const debugSessions = async () =>
  (await query('session.list', { project_id: run.project_id })).filter(
    (s) => s.app_debug && !s.archived_at,
  );

// Ask agent and the debug view take the project's default runtime; this daemon has only the fixture.
const project = (await query('board')).projects.find((p) => p.id === run.project_id);
if (project.session_defaults?.runtime !== 'fixture')
  await call(
    'project.sessionDefaults.set',
    { project_id: run.project_id, runtime: 'fixture', permission_mode: 'ask' },
    project.revision,
  );
// One live diagnosis session, as Ask agent opens it (diagnosis.ask-agent-route); idle so it takes a message.
if ((await debugSessions()).length === 0)
  await call('session.create', {
    project_id: run.project_id,
    input: 'verify diagnosis session',
    purpose: 'app_debug',
    workspace: 'in_place',
    runtime: 'fixture',
  });
const before = await poll(async () => {
  const all = await debugSessions();
  return all.length && all.every((s) => s.state !== 'running') ? all : null;
}, 30_000);
check(
  '前置：有一个空闲的 app_debug 会话',
  before?.length >= 1,
  before?.map((s) => [s.id, s.state]),
);
const target = before?.[0];

// A failed command, so the app has a recorded problem the request's message must leave out.
const LABEL = `verify-theme-${Date.now()}`;
const { theme_id } = await call('theme.set', {
  label: LABEL,
  light: { anchors: { 'surface-0': '#ffffff', 'text-primary': '#111111' } },
});
await call('theme.apply', { theme_id: null });
await reset();
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '外观', exact: true });
await page.waitFor(
  `[...document.querySelectorAll('button.ps-thc')].some((b) => b.textContent.includes(${JSON.stringify(LABEL)}))`,
  'the saved theme card to show',
);
await call('theme.delete', { theme_id });
await page.click({ role: 'button', name: LABEL, exact: false });
const failed = await poll(async () => (await names('问 agent')).length > 0);
check('前置：一条命令失败，app 记下了问题（失败 toast 出现）', failed);

const NOTE = `verify-note-${Date.now()}`;
const REQUEST = `verify-request-${Date.now()}`;
const turnsOf = async (id) =>
  (await query('board')).session_turns.filter((t) => t.session_id === id).length;
const turnsBefore = await turnsOf(target?.id);
await reset();
// A point in the sidebar, below the title bar, outside its nested regions (the session list has its own).
const box = await page.evaluate(`(() => {
  const side = document.querySelector('[data-debug-region="app.sidebar"]').getBoundingClientRect();
  const x = Math.round(side.left + side.width / 2);
  for (let y = Math.round(side.top) + 120; y < side.bottom; y += 8) {
    const under = document.elementsFromPoint(x, y).find((el) => !el.closest('.dbv'));
    if (under?.closest('[data-debug-region]')?.getAttribute('data-debug-region') === 'app.sidebar')
      return { x, y };
  }
  return null;
})()`);
// A CDP ⌘K did not open the palette here; the title bar's button opens the same palette.
await page.click({ role: 'button', name: '搜索', exact: true });
await page.fill({ role: 'combobox', name: '搜索', exact: true }, '调试视图');
await page.click({ role: 'option', name: '调试视图', exact: false });
await page.waitFor(
  `!!document.querySelector('.dbv [role=application]')`,
  'the debug view overlay to open',
);
// Moves in from beside the point, so the pointer crosses the hit layer.
await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 20, y: box.y - 20 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
result.hover = await page.evaluate(`(() => ({
  hit: !!document.querySelector('.dbv-hit'),
  top: document.elementFromPoint(${box.x}, ${box.y})?.className ?? null,
  box: document.querySelector('.dbv-box[data-state=hover]')?.getAttribute('style') ?? null,
  tag: document.querySelector('.dbv-tag')?.outerHTML.slice(0, 300) ?? null,
}))()`);
const tag = await poll(() =>
  page.evaluate(`document.querySelector('.dbv-tag[role=status]')?.textContent || null`),
);
check('悬停侧栏时标签显示 侧栏', tag?.includes('侧栏'), tag);
const mouse = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse });
result.box = box;
const picked = await poll(() => page.evaluate(`!!document.querySelector('.dbv textarea')`));
check('点击后检查面板显示所选项', picked);
if (!picked) {
  result.shot = await page.screenshot(result.id);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
result.noteBoxes = await names('问题描述');
const inspector = { name: '检查面板', exact: true };
const toolbar = { role: 'toolbar', name: '调试视图', exact: true };
const REQUEST_LABEL = '你想改什么或修什么？';
const insSend = `document.querySelector('.dbv-ins .dbv-send button.pri')`;
const sendDisabled = await page.evaluate(`${insSend}?.disabled ?? null`);
check('描述为空时检查面板的 发送 不可用', sendDisabled === true, sendDisabled);

// The toolbar's Send with no request opens the inspector on the request box instead of sending.
await page.click({ role: 'button', name: '关闭检查面板', exact: true });
await page.waitFor(`!document.querySelector('.dbv-ins')`, 'the inspector to close');
await page.click({ role: 'button', name: '发送', exact: true, within: toolbar });
const focused = await poll(() =>
  page.evaluate(`document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(REQUEST_LABEL)}
    && !!document.querySelector('.dbv-ins') || null`),
);
check('描述为空时点工具栏 发送：打开检查面板，焦点在描述框', focused, await page.evaluate(
  `document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`,
));
const notSent = await turnsOf(target?.id);
check('描述为空时点工具栏 发送 没有发出消息', notSent === turnsBefore, { before: turnsBefore, now: notSent });

await page.fill({ role: 'textbox', name: '问题描述', exact: false, within: inspector }, NOTE);
await page.fill({ role: 'textbox', name: REQUEST_LABEL, exact: true, within: inspector }, REQUEST);
const enabled = await page.evaluate(`${insSend}?.disabled === false`);
check('填了描述后检查面板的 发送 可用', enabled);
await page.click({ role: 'button', name: '发送', exact: true, within: inspector });

const arrived = await poll(async () => {
  const board = await query('board');
  const turns = board.session_turns.filter((t) => JSON.stringify(t).includes(NOTE));
  return turns.length ? turns : null;
}, 20_000);
// The message as the daemon stored it.
const input = arrived?.[0]?.input ?? '';
result.message = input;
const lines = input.split('\n').map((line) => line.trim());
const line = (prefix) => lines.find((l) => l.startsWith(prefix));
check('消息以 The user\'s request: 加空行加描述开头', input.startsWith(`The user's request:\n\n${REQUEST}`), input.slice(0, 80));
check('对照组：同一读法对错误的开头判 false', !input.startsWith(`The user's request:\n\n${REQUEST}-absent`) && !input.startsWith('The user asked about this'));
check('消息里有所选项一行 1. …', lines.some((l) => /^1\. /.test(l)), lines.find((l) => /^1\. /.test(l)));
// The packaged build carries no data-pt-src (the plugin runs only on the dev server), and the line is left out then.
const src = await page.evaluate(
  `document.querySelector('[data-debug-region="app.sidebar"]').getAttribute('data-pt-src')`,
);
check('Source 行与区域元素的 data-pt-src 一致（没有就不写这一行）', src ? line('Source: ') === `Source: ${src}` : !line('Source: '), { src, line: line('Source: ') ?? null });
check('Selector 行是区域选择器', line('Selector: ') === 'Selector: [data-debug-region="app.sidebar"]', line('Selector: '));
const stack = line('Stack: ');
check('Stack 行最多 3 项', stack && stack.slice(7).split(' < ').length <= 3, stack);
check('有 Text 行', line('Text: '), line('Text: '));
check('Note 行是备注', line('Note: ') === `Note: ${NOTE}`, line('Note: '));
check('区域选中没有 Props 行', !lines.some((l) => l.startsWith('Props')));
check('没有 Styles 和 Rect 行', !lines.some((l) => l.startsWith('Styles') || l.startsWith('Rect')));
check('没有 Recent problems 段', !input.includes('Recent problems'));
check('没有 Reproduce 行', !input.includes('Reproduce'));
check(
  '带备注的消息到了一个会话',
  arrived?.length === 1,
  arrived?.map((t) => t.session_id),
);
check('到的是前置的同一个 app_debug 会话', arrived?.[0]?.session_id === target?.id, {
  to: arrived?.[0]?.session_id,
  expected: target?.id,
});
const region = arrived && JSON.stringify(arrived[0]).includes('app.sidebar');
check('消息里带着所选区域 app.sidebar', region);
const after = await debugSessions();
check(
  '没有新开第二个 app_debug 会话',
  after.length === before?.length,
  after.map((s) => s.id),
);
check(
  '对照组：别的会话的 turn 里没有这条备注',
  !(await query('board')).session_turns.some(
    (t) => t.session_id !== target?.id && JSON.stringify(t).includes(NOTE),
  ),
);
const closed = await poll(async () => !(await page.evaluate(`!!document.querySelector('.dbv')`)));
check('发送后调试视图关闭', closed);
result.shot = await page.screenshot(result.id);
await reset();
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
