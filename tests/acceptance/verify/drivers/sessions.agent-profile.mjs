import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-profile', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-profile-${stamp}`);
const projectRow = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const NAME = `Kappa ${stamp}`;
const ROLE = `Role ${stamp % 100000}`;
const agentId = (
  await call('agent.create', {
    project_id,
    template: 'custom',
    name: NAME,
    role: 'Checker',
    instructions: `You check things for ${NAME}.`,
  })
).id;
const agentOf = async (id) => (await query('agent.list', { project_id })).find((a) => a.id === id);
const assistantId = (await query('agent.list', { project_id })).find(
  (a) => a.template === 'assistant',
).id;

const ZONE = { role: 'group', name: '常驻智能体', exact: true };
const rowSel = (id) =>
  `nav.ss-list [role=group][aria-label="常驻智能体"] .ss-rr[data-stop="resident:${id}"]`;
const rowShown = (id) => page.evaluate(`!!document.querySelector(${JSON.stringify(rowSel(id))})`);
/** Opens the row's context menu with a right press, as a user's right click does. */
const rightClick = async (id) => {
  const { x, y } = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(rowSel(id))});
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  const mouse = { x, y, button: 'right', buttons: 2, clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
};
// The locator gives <aside> no implicit role, so the panel is found by its name alone.
const PANEL = (name) => ({ name: `${name}的资料`, exact: true });
const panelJs = (name) => `(() => {
  const aside = document.querySelector('aside.ag-insp[aria-label=${JSON.stringify(`${name}的资料`)}]');
  const main = document.querySelector('main.ss-convo');
  if (!aside || !main) return null;
  const a = aside.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return {
    width: Math.round(a.width),
    left: Math.round(a.left),
    mainRight: Math.round(m.right),
    mainWidth: Math.round(m.width),
    chip: aside.querySelector('.ag-ih .chip')?.textContent ?? null,
    buttons: [...aside.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
    sections: [...aside.querySelectorAll('section')].map((s) => s.querySelector('.cap')?.textContent ?? null),
    text: aside.innerText,
  };
})()`;

await poll(() => rowShown(agentId));
// Opens the agent's conversation first, so the profile has one to sit beside.
await page.click({ role: 'button', name: `${NAME}，`, exact: false, within: ZONE });
await poll(() =>
  page.evaluate(
    `document.querySelector(${JSON.stringify(rowSel(agentId))})?.getAttribute('aria-current') === 'true'`,
  ),
);
await rightClick(agentId);
const menu = await poll(() =>
  page
    .evaluate(
      `[...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.textContent.trim())`,
    )
    .then((items) => (items.length ? items : null)),
);
check('右键菜单有 资料', menu?.includes('资料'), menu);
await page.click({ role: 'menuitem', name: '资料', exact: true });
const panel = await poll(() => page.evaluate(panelJs(NAME)));
result.panel = panel;
check(
  '资料在对话旁边，约 400px 宽',
  panel &&
    Math.abs(panel.width - 400) <= 20 &&
    panel.left >= panel.mainRight - 2 &&
    panel.mainWidth > 300,
  panel,
);
const before = await agentOf(agentId);
check('资料头部的角色等于 agent.list 的 role', panel?.chip === before.role, {
  shown: panel?.chip,
  daemon: before.role,
});
check('自定义智能体的资料有 归档', panel?.buttons.includes('归档'), panel?.buttons);

await page.fill({ role: 'textbox', name: '角色', exact: true, within: PANEL(NAME) }, ROLE);
await page.click({ role: 'button', name: '保存', exact: true, within: PANEL(NAME) });
const saved = await poll(async () => {
  const now = await agentOf(agentId);
  return now.role === ROLE && now;
});
check('保存后 agent.list 的 role 是新值', saved?.role === ROLE, saved?.role);
check('保存后 revision 变大', saved && saved.revision > before.revision, {
  before: before.revision,
  after: saved?.revision,
});
const chip = await poll(() =>
  page.evaluate(panelJs(NAME)).then((p) => (p?.chip === ROLE ? p.chip : null)),
);
check('资料头部显示新角色', chip === ROLE, chip ?? (await page.evaluate(panelJs(NAME)))?.chip);
check('对照组：头部不再是旧角色', chip && chip !== before.role);

check(
  '自定义智能体的资料只有 你的指令，没有 内置角色',
  panel?.sections.join() === '你的指令',
  panel?.sections,
);
check(
  '你的指令 显示 agent.list 的 instructions',
  panel?.text.includes(before.instructions),
  before.instructions,
);
const OWN = `You check things for ${NAME} and report twice.`;
await page.click({ role: 'button', name: '编辑指令', exact: true, within: PANEL(NAME) });
await page.fill({ role: 'textbox', name: '你的指令', exact: true, within: PANEL(NAME) }, OWN);
await page.click({ role: 'button', name: '保存', exact: true, within: PANEL(NAME) });
const own = await poll(async () => {
  const now = await agentOf(agentId);
  return now.instructions === OWN && now;
});
check('保存指令后 agent.list 的 instructions 是新值', own?.instructions === OWN, own?.instructions);
const ownShown = await poll(() =>
  page.evaluate(panelJs(NAME)).then((p) => (p?.text.includes(OWN) ? true : null)),
);
check('保存后 你的指令 显示新值', ownShown);

await page.click({ role: 'button', name: '归档', exact: true, within: PANEL(NAME) });
const archived = await poll(async () => {
  const now = await agentOf(agentId);
  return now.archived_at !== undefined && now;
});
check('归档(无确认)后 agent.list 有 archived_at', archived, archived?.archived_at);
const hidden = await poll(async () => !(await rowShown(agentId)));
check('归档后侧栏行消失', hidden);
const notice = await poll(() =>
  page.evaluate(`(() => {
    const text = document.body.innerText;
    return text.includes(${JSON.stringify(`已归档${NAME}`)}) ? true : null;
  })()`),
);
check('出现 已归档{名字} 的提示', notice);
await page.click({ role: 'button', name: '撤销', exact: true });
const back = await poll(async () => {
  const now = await agentOf(agentId);
  return now.archived_at === undefined && now;
});
check(
  '撤销后 agent.list 没有 archived_at',
  back,
  back && { archived_at: back.archived_at ?? null },
);
const returned = await poll(() => rowShown(agentId));
check('撤销后侧栏行回来', returned);

await rightClick(assistantId);
await page.click({ role: 'menuitem', name: '资料', exact: true });
const assistant = await poll(() => page.evaluate(panelJs('助理')));
check('助理的资料打开了', assistant, assistant);
check('助理的资料没有 归档', assistant && !assistant.buttons.includes('归档'), assistant?.buttons);
const assistantListed = await agentOf(assistantId);
check(
  '助理的资料有 内置角色 和 你的指令 两段',
  assistant?.sections.join() === '内置角色,你的指令',
  assistant?.sections,
);
check(
  '内置角色 显示 agent.list 的 role_prompt 开头',
  assistant?.text.includes(assistantListed.role_prompt.split('\n')[0]),
  assistantListed.role_prompt.split('\n')[0],
);
check(
  '内置角色 只读：资料里没有含 role_prompt 的输入框',
  await page.evaluate(
    `[...document.querySelectorAll('aside.ag-insp textarea, aside.ag-insp input')].every((el) => !el.value.includes(${JSON.stringify(assistantListed.role_prompt.split('\n')[0])}))`,
  ),
);
check(
  '助理没有自己的指令时显示 添加指令',
  !assistantListed.instructions && assistant?.buttons.includes('添加指令'),
  { instructions: assistantListed.instructions ?? null, buttons: assistant?.buttons },
);

result.shot = await page.screenshot(result.id);
await page.click({ role: 'button', name: '关闭资料', exact: true });
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
