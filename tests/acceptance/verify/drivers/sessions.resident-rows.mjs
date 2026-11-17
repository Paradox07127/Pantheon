import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.resident-rows', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// A project of its own, so its assistant has never been opened.
const NAME = `verify-res-${Date.now()}`;
const { project_id } = await newProject(NAME);
// The sidebar keys a resident row by its agent's id.
const ASSISTANT = (await query('agent.list', { project_id })).find(
  (a) => a.template === 'assistant',
).id;
const projectRow = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const residentsOf = async (kind) =>
  (await query('session.list', { project_id })).filter((s) => s.resident?.kind === kind);

const zone = await poll(() =>
  page.evaluate(`(() => {
    const nav = document.querySelector('nav.ss-list');
    const group = nav?.querySelector('[role=group]');
    if (!group) return null;
    return {
      heading: document.querySelector('.sb-sh > span')?.textContent ?? null,
      group: group.getAttribute('aria-label'),
      firstInList: nav.firstElementChild === group,
      rows: [...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    };
  })()`),
);
result.zone = zone;
check('侧栏标题行是 智能体', zone?.heading === '智能体', zone?.heading);
check('常驻组在会话列表最上面', zone?.firstInList, zone?.group);
check(
  '常驻行顺序：助理在前、问题处理在后',
  zone?.rows.length === 2 && zone.rows[0].startsWith('助理') && zone.rows[1].startsWith('问题处理'),
  zone?.rows,
);
check('没开过的助理行显示 尚未开始', zone?.rows[0] === '助理，尚未开始', zone?.rows[0]);
const before = await residentsOf('assistant');
check('点击前 session.list 没有助理会话', before.length === 0, before.length);

await page.click({
  role: 'button',
  name: '助理，',
  exact: false,
  within: { role: 'group', name: '常驻智能体', exact: true },
});
const first = await poll(async () => {
  const list = await residentsOf('assistant');
  return list.length > 0 && list;
});
check(
  '点击后 session.list 有一个 resident.kind=assistant 的会话(resident.open 已发出)',
  first?.length === 1,
  first && first.map((s) => s.id),
);
const id = first?.[0]?.id;
const current = await poll(() =>
  page.evaluate(
    `document.querySelector('.ss-rr[data-stop="resident:${ASSISTANT}"]')?.getAttribute('aria-current') === 'true'`,
  ),
);
check('助理行成为当前行', current);
const empty = await poll(() =>
  page.evaluate(`document.querySelector('.ss-emp')?.textContent ?? null`),
);
check(
  '常驻对话显示一句话空状态，带助理的中文名和项目名',
  typeof empty === 'string' && empty.includes(`告诉助理接下来 ${NAME} 要做什么`),
  empty,
);

await page.click({
  role: 'button',
  name: '助理，',
  exact: false,
  within: { role: 'group', name: '常驻智能体', exact: true },
});
// Gives a second session the time to show up before deciding none was added.
const settled =
  (await poll(async () => {
    const list = await residentsOf('assistant');
    return list.length > 1 && list;
  }, 3000)) || (await residentsOf('assistant'));
check(
  '再点一次不新增会话，仍是同一 id',
  settled.length === 1 && settled[0].id === id,
  settled.map((s) => s.id),
);
check(
  '对照组：没点过的问题处理在 session.list 里没有会话',
  (await residentsOf('triage')).length === 0,
);
const rowAfter = await page.evaluate(
  `document.querySelector('.ss-rr[data-stop="resident:${ASSISTANT}"]')?.getAttribute('aria-label')`,
);
check('打开后助理行不再是 尚未开始', rowAfter && !rowAfter.includes('尚未开始'), rowAfter);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
