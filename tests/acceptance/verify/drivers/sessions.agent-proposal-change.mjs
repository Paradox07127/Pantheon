import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-proposal-change', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-proposal-change-${stamp}`);
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const NAME = `Lambda ${stamp}`;
const OLD_ROLE = 'Checker';
const NEW_ROLE = `Reviewer ${stamp % 100000}`;
const agentId = (
  await call('agent.create', {
    project_id,
    template: 'custom',
    name: NAME,
    role: OLD_ROLE,
    instructions: `You check things for ${NAME}.`,
  })
).id;
const agentOf = async (id) => (await query('agent.list', { project_id })).find((a) => a.id === id);
const before = await agentOf(agentId);
const CARD = { name: `智能体提议：${NAME}`, exact: true };
const cardSel = `section.ag-pc[aria-label=${JSON.stringify(CARD.name)}]`;

// The assistant proposes a change of one field to the existing agent.
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const steps = [
  { tool: { name: 'propose_agent', arguments: { agent_id: agentId, role: NEW_ROLE } } },
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
result.pending = pending && { source: pending.source, agent_proposal: pending.agent_proposal };
check('needs_you.list 有这条修改提议', proposalId, result.pending);

await page.click({
  role: 'button',
  name: '助理，',
  exact: false,
  within: { role: 'group', name: '常驻智能体', exact: true },
});
const card = await poll(() =>
  page.evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(cardSel)});
    if (!card) return null;
    return {
      name: card.querySelector('.ag-pn')?.textContent ?? null,
      chip: card.querySelector('.ag-pch .chip')?.textContent ?? null,
      facts: [...card.querySelectorAll('.ag-kv dt')].map((d) => d.textContent),
      prompt: !!card.querySelector('.ag-pp'),
      buttons: [...card.querySelectorAll('.ag-pcf button')].map((b) => b.textContent.trim()),
      text: card.innerText.replace(/\\s+/g, ' ').trim(),
    };
  })()`),
);
result.card = card;
check('卡片标题是现有智能体的名字', card?.name === NAME, card?.name);
check('卡片显示提议的新角色', card?.chip === NEW_ROLE, card?.chip);
check(
  '卡片只显示改的字段：没有模板、模型、工具、例行任务、角色提示词',
  card && card.facts.length === 0 && !card.prompt,
  card && { facts: card.facts, prompt: card.prompt },
);
check('对照组：卡片里没有旧角色', card && !card.text.includes(OLD_ROLE), card?.text);
check(
  '卡片有 拒绝、编辑、创建',
  card && ['拒绝', '编辑', '创建'].every((b) => card.buttons.includes(b)),
  card?.buttons,
);

const cursor = (await board()).cursor;
await page.click({ role: 'button', name: '创建', exact: true, within: CARD });
const after = await poll(async () => {
  const now = await agentOf(agentId);
  return now.role === NEW_ROLE && now;
});
check(
  'agent.list 里它的 role 是新值',
  after?.role === NEW_ROLE,
  after?.role ?? (await agentOf(agentId)).role,
);
check('revision 变大', after && after.revision > before.revision, {
  before: before.revision,
  after: after?.revision,
});
check('对照组：名字没变', after && after.name === NAME, after?.name);
const agents = await query('agent.list', { project_id });
check(
  '没有新建智能体',
  agents.length === 3,
  agents.map((a) => a.name),
);
const resolved = await poll(async () =>
  (await query('events', { project_id, after: cursor, limit: 2000 })).events.find(
    (e) => e.kind === 'agent_proposal.resolved' && e.aggregate_id === proposalId,
  ),
);
check(
  '提议的状态是 changed，结果是这个智能体',
  resolved?.payload?.state === 'changed' && resolved.payload.result_agent_id === agentId,
  resolved?.payload,
);
const line = await poll(() =>
  page.evaluate(`(() => {
    if (document.querySelector(${JSON.stringify(cardSel)})) return null;
    const lines = [...document.querySelectorAll('.ag-ln')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim());
    return lines.length ? lines : null;
  })()`),
);
check(
  '卡片换成 你修改了{名字} 一行',
  line?.length === 1 && line[0].startsWith(`你修改了${NAME}`),
  line,
);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
