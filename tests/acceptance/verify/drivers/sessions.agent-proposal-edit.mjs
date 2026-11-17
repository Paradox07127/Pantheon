import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-proposal-edit', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-proposal-edit-${stamp}`);
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const NAME = `Scout ${stamp}`;
const EDITED = `Edited ${stamp}`;
const CARD = { name: `智能体提议：${NAME}`, exact: true };
const cardSel = `section.ag-pc[aria-label=${JSON.stringify(CARD.name)}]`;

const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const steps = [
  {
    tool: {
      name: 'propose_agent',
      arguments: {
        template: 'custom',
        name: NAME,
        role: 'Scout',
        instructions: 'You scout the repository for stale docs and tell the user.',
        tools: ['board'],
      },
    },
  },
];
await call(
  'session.send',
  { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);
const pending = await poll(
  async () =>
    (await query('needs_you.list', { project_id })).items.find((i) => i.kind === 'agent.proposal'),
  60_000,
);
const proposalId = pending?.source?.id;
check('needs_you.list 有这条提议', pending?.agent_proposal?.name === NAME, pending?.agent_proposal);

// Opens the assistant's conversation from its sidebar row.
await page.click({
  role: 'button',
  name: '助理，',
  exact: false,
  within: { role: 'group', name: '常驻智能体', exact: true },
});
const card = await poll(() =>
  page.evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(cardSel)});
    return card && [...card.querySelectorAll('.ag-pcf button')].map((b) => b.textContent.trim());
  })()`),
);
check(
  '卡片有 拒绝、编辑、创建',
  card && ['拒绝', '编辑', '创建'].every((b) => card.includes(b)),
  card,
);

await page.click({ role: 'button', name: '编辑', exact: true, within: CARD });
const form = await poll(() =>
  page.evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(cardSel)});
    const name = card?.querySelector('input#ag-${proposalId}-name');
    if (!name) return null;
    return {
      name: name.value,
      role: card.querySelector('input#ag-${proposalId}-role')?.value ?? null,
      inputs: card.querySelectorAll('input, textarea').length,
      buttons: [...card.querySelectorAll('.ag-pcf button')].map((b) => b.textContent.trim()),
    };
  })()`),
);
result.form = form;
check(
  '点 编辑 后卡片里出现可改的名称和角色，值是提议的值',
  form?.name === NAME && form.role === 'Scout',
  form,
);
check('编辑态的按钮是 取消、创建', form && form.buttons.join(',') === '取消,创建', form?.buttons);

await page.fill({ role: 'textbox', name: '名称', exact: true, within: CARD }, EDITED);
const typed = await page.evaluate(
  `document.querySelector(${JSON.stringify(cardSel)})?.querySelector('input#ag-${proposalId}-name')?.value`,
);
check('名称框里是改后的名字', typed === EDITED, typed);
const cursor = (await board()).cursor;
await page.click({ role: 'button', name: '创建', exact: true, within: CARD });

const made = await poll(async () =>
  (await query('agent.list', { project_id })).find((a) => a.name === EDITED),
);
result.made = made && {
  id: made.id,
  name: made.name,
  role: made.role,
  created_by: made.created_by,
};
check(
  'agent.list 有改名后的智能体，由助理会话提议',
  made?.created_by?.kind === 'agent' && made.created_by.session_id === assistant,
  result.made,
);
check(
  '对照组：agent.list 里没有原名字',
  made && !(await query('agent.list', { project_id })).some((a) => a.name === NAME),
);
const resolved = await poll(async () =>
  (await query('events', { project_id, after: cursor, limit: 2000 })).events.find(
    (e) => e.kind === 'agent_proposal.resolved' && e.aggregate_id === proposalId,
  ),
);
check(
  '提议的状态是 created，结果是这个智能体',
  resolved?.payload?.state === 'created' && resolved.payload.result_agent_id === made?.id,
  resolved?.payload,
);
const gone = await poll(
  async () =>
    !(await query('needs_you.list', { project_id })).items.some((i) => i.kind === 'agent.proposal'),
);
check('needs_you.list 不再有这条提议', gone);
// Recorded, not judged: the decided line names the agent.
result.line = await poll(() =>
  page.evaluate(`(() => {
    const line = [...document.querySelectorAll('.ag-ln')].find((l) => l.textContent.includes('你创建了'));
    return line ? line.textContent : null;
  })()`),
);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
