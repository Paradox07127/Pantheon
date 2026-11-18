import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-proposal', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-proposal-${stamp}`);
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const NAME = `Scout ${stamp}`;
const CARD = { name: `智能体提议：${NAME}`, exact: true };

// The assistant proposes through its propose_agent tool, as a model's turn would call it.
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
        routines: [{ prompt: 'Look for stale docs.', every_minutes: 1440, enabled: true }],
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
result.daemon = pending && {
  kind: pending.kind,
  session_id: pending.session_id,
  agent_proposal: pending.agent_proposal,
};
check(
  'needs_you.list 有助理会话的 agent.proposal，名字对',
  pending?.session_id === assistant && pending.agent_proposal?.name === NAME,
  result.daemon,
);

if (pending) {
  // The title bar's needs-you list.
  const trigger = await poll(() =>
    page.evaluate(`document.querySelector('button.tbe-wait')?.getAttribute('aria-label') ?? null`),
  );
  await page.click({ role: 'button', name: trigger, exact: true });
  const rows = await poll(() =>
    page.evaluate(`(() => {
      const pop = document.querySelector('.pop.np');
      if (!pop) return null;
      const rows = [...pop.querySelectorAll('button.np-open')].map((b) => ({
        title: b.querySelector('.np-t')?.textContent ?? '',
        detail: b.querySelector('.np-d')?.textContent ?? '',
      }));
      // An empty array is truthy: wait for this proposal's row, not for the first rows.
      return rows.some((r) => r.detail.includes(${JSON.stringify(`新智能体：${NAME}`)})) && rows;
    })()`),
  );
  result.popover = rows;
  const row = (rows || []).find((r) => r.detail.includes(`新智能体：${NAME}`));
  check('需要你的列表里有这条提议，带智能体名字', row, rows);
  check(
    '对照组：列表里没有不存在的名字',
    rows && !rows.some((r) => r.detail.includes(`${NAME}-absent`)),
  );
  await page.click({ role: 'button', name: `新智能体：${NAME}`, exact: false });

  const card = await poll(() =>
    page.evaluate(`(() => {
      const card = document.querySelector('section.ag-pc[aria-label=${JSON.stringify(CARD.name)}]');
      if (!card) return null;
      return {
        buttons: [...card.querySelectorAll('.ag-pcf button')].map((b) => b.textContent.trim()),
        role: card.querySelector('.ag-pch .chip')?.textContent ?? null,
        text: card.innerText.slice(0, 400),
      };
    })()`),
  );
  result.card = card;
  check(
    '点列表行后打开提议的对话，卡片有 拒绝、编辑、创建',
    card && ['拒绝', '编辑', '创建'].every((b) => card.buttons.includes(b)),
    card,
  );
  check('卡片的角色等于提议的 role', card?.role === 'Scout', card?.role);
  const current = await page.evaluate(
    `document.querySelector('.ss-rr[aria-current="true"]')?.getAttribute('aria-label') ?? null`,
  );
  check('当前行是助理', current?.startsWith('助理'), current);

  await page.click({ role: 'button', name: '创建', exact: true, within: CARD });
  const made = await poll(async () =>
    (await query('agent.list', { project_id })).find((a) => a.name === NAME),
  );
  result.made = made && {
    id: made.id,
    template: made.template,
    role: made.role,
    created_by: made.created_by,
    routines: made.routines,
  };
  check(
    '创建后 agent.list 有它，由助理会话提议',
    made?.template === 'custom' &&
      made.created_by?.kind === 'agent' &&
      made.created_by.session_id === assistant,
    result.made,
  );
  check(
    '对照组：agent.list 里没有不存在的名字',
    !(await query('agent.list', { project_id })).some((a) => a.name === `${NAME}-absent`),
  );
  const line = await poll(() =>
    page.evaluate(
      `document.body.innerText.includes(${JSON.stringify(`你创建了${NAME}`)}) && !document.querySelector('section.ag-pc[aria-label=${JSON.stringify(CARD.name)}]')`,
    ),
  );
  check('卡片换成 你创建了{名字} 一行', line);
  const sidebar = await poll(() =>
    page.evaluate(
      `document.querySelector('nav.ss-list [role=group][aria-label="本项目"] .ss-rr[data-stop="resident:${made?.id}"]')?.getAttribute('aria-label') ?? null`,
    ),
  );
  check('侧栏出现新智能体的行', sidebar?.startsWith(`${NAME}，`), sidebar);
  const gone = await poll(
    async () =>
      !(await query('needs_you.list', { project_id })).items.some(
        (i) => i.kind === 'agent.proposal',
      ),
  );
  check('needs_you.list 不再有这条提议', gone);
}

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
