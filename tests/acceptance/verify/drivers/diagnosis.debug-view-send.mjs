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

const NOTE = `verify-note-${Date.now()}`;
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
await page.fill({ role: 'textbox', name: '问题描述', exact: false, within: inspector }, NOTE);
await page.click({ role: 'button', name: '发送', exact: true, within: inspector });

const arrived = await poll(async () => {
  const board = await query('board');
  const turns = board.session_turns.filter((t) => JSON.stringify(t).includes(NOTE));
  return turns.length ? turns : null;
}, 20_000);
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
