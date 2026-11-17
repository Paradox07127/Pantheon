import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-profile-idle', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-profile-idle-${stamp}`);
const NAME = `Mu ${stamp}`;
const ROLE = `Watcher ${stamp % 100000}`;
const agentId = (
  await call('agent.create', {
    project_id,
    template: 'custom',
    name: NAME,
    role: ROLE,
    instructions: `You watch things for ${NAME}.`,
  })
).id;
const residentOf = async () =>
  (await query('session.list', { project_id })).find((s) => s.resident?.agent_id === agentId);
check('前置：这个智能体没有会话', !(await residentOf()));

const rowSel = `nav.ss-list [role=group][aria-label="常驻智能体"] .ss-rr[data-stop="resident:${agentId}"]`;
const row = await poll(() =>
  page.evaluate(
    `document.querySelector(${JSON.stringify(rowSel)})?.getAttribute('aria-label') ?? null`,
  ),
);
check('侧栏行是 {名字}，尚未开始', row?.startsWith(`${NAME}，尚未开始`), row);

// A right press on the row, as a user's right click does.
const { x, y } = await page.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(rowSel)});
  el.scrollIntoView({ block: 'center' });
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
})()`);
const mouse = { x, y, button: 'right', buttons: 2, clickCount: 1 };
await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
const menu = await poll(() =>
  page
    .evaluate(
      `[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.textContent.trim())`,
    )
    .then((items) => (items.length ? items : null)),
);
check('右键菜单有 资料', menu?.includes('资料'), menu);
await page.click({ role: 'menuitem', name: '资料', exact: true });

const panelJs = (name) => `(() => {
  const aside = document.querySelector('aside.ag-insp[aria-label=${JSON.stringify(`${name}的资料`)}]');
  if (!aside) return null;
  return {
    head: aside.querySelector('.ag-ih')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    chip: aside.querySelector('.ag-ih .chip')?.textContent ?? null,
    role: aside.querySelector('input.ag-role')?.value ?? null,
    width: Math.round(aside.getBoundingClientRect().width),
  };
})()`;
const panel = await poll(() => page.evaluate(panelJs(NAME)));
result.panel = panel;
check('资料面板打开，头部有名字', panel?.head?.includes(NAME), panel);
const listed = (await query('agent.list', { project_id })).find((a) => a.id === agentId);
check('头部角色等于 agent.list 的 role', panel?.chip === listed.role && listed.role === ROLE, {
  shown: panel?.chip,
  daemon: listed.role,
});
check('对照组：没有别的名字的资料面板', !(await page.evaluate(panelJs(`${NAME}-absent`))));
// Recorded, not judged: whether showing the profile started the agent's conversation.
result.session_after_profile = (await residentOf())?.id ?? null;

result.shot = await page.screenshot(result.id);
result.errors = await errors();
await page.click({ role: 'button', name: '关闭资料', exact: true });
console.log(JSON.stringify(result, null, 2));
page.close();
