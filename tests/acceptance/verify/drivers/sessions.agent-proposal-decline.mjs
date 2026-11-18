import { open } from '../page.mjs';
const first = await open(process.argv[2]);
const { query, call, poll, newProject } = first;
let { page, errors } = first;
const result = { id: 'sessions.agent-proposal-decline', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, name: PROJECT } = await newProject(`verify-proposal-decline-${stamp}`);
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const NAME = `Scout ${stamp}`;
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
  within: { role: 'group', name: '本项目', exact: true },
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

const cursor = (await board()).cursor;
await page.click({ role: 'button', name: '拒绝', exact: true, within: CARD });

const resolved = await poll(async () =>
  (await query('events', { project_id, after: cursor, limit: 2000 })).events.find(
    (e) => e.kind === 'agent_proposal.resolved' && e.aggregate_id === proposalId,
  ),
);
check('提议的状态是 declined', resolved?.payload?.state === 'declined', resolved?.payload);
const shown = await poll(() =>
  page.evaluate(`(() => {
    if (document.querySelector(${JSON.stringify(cardSel)})) return null;
    const lines = [...document.querySelectorAll('.ag-ln')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim());
    return lines.length ? lines : null;
  })()`),
);
result.line = shown;
check(
  '卡片换成一行 你拒绝了{名字}',
  shown?.length === 1 && shown[0].startsWith(`你拒绝了${NAME}`),
  shown,
);
check(
  '对照组：没有 你创建了{名字} 的行',
  shown && !shown.some((l) => l.includes(`你创建了${NAME}`)),
);
const agents = await query('agent.list', { project_id });
check(
  'agent.list 没有新智能体(只有助理和问题处理)',
  resolved && !agents.some((a) => a.name === NAME) && agents.length === 2,
  agents.map((a) => a.name),
);
const needs = await poll(async () => {
  const items = (await query('needs_you.list', { project_id })).items;
  return !items.some((i) => i.source?.id === proposalId) && items;
});
check('needs_you.list 不再有这条提议', needs, needs && needs.map((i) => i.kind));

result.shot = await page.screenshot(result.id);
result.errors = await errors();

// Recorded, not judged: what the call shows after a reload, once now and once the proposal is a minute old.
const decidedAt = Date.now();
/** Opens a fresh connection, shows this project and the assistant's conversation. */
const showAssistant = async () => {
  page.close();
  ({ page, errors } = await open(process.argv[2]));
  await page.click({ role: 'button', name: '切换项目', exact: true });
  await page.click({ role: 'menuitemradio', name: PROJECT, exact: false });
  await page.waitFor(
    `(document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').includes(${JSON.stringify(PROJECT)})`,
    `the sidebar to show project ${PROJECT}`,
  );
  await page.click({
    role: 'button',
    name: '助理，',
    exact: false,
    within: { role: 'group', name: '本项目', exact: true },
  });
};
const view = `(() => {
  const card = document.querySelector(${JSON.stringify(cardSel)});
  if (card) return { card: [...card.querySelectorAll('.ag-pcf button')].map((b) => b.textContent.trim()) };
  const lines = [...document.querySelectorAll('.ag-ln')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim());
  return lines.length ? { lines } : null;
})()`;
try {
  await page.evaluate('location.reload()');
} catch {}
await showAssistant();
result.reload = [
  { after_ms: Date.now() - decidedAt, shows: (await poll(() => page.evaluate(view))) ?? null },
];
result.reload_errors = await errors();
// The card counts a proposal older than a minute that left the needs-you list as decided.
await poll(() => Date.now() - decidedAt > 65_000, 70_000);
await showAssistant();
result.reload.push({
  after_ms: Date.now() - decidedAt,
  shows: (await poll(() => page.evaluate(view))) ?? null,
});
result.reload_errors.push(...(await errors()));

console.log(JSON.stringify(result, null, 2));
page.close();
