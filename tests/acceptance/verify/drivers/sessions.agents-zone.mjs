import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agents-zone', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// A project of its own, so its agents are only the ones made here.
const stamp = Date.now();
const { project_id } = await newProject(`verify-zone-${stamp}`);
const projectRow = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const make = async (name) =>
  (
    await call('agent.create', {
      project_id,
      template: 'custom',
      name,
      role: 'Checker',
      instructions: `You check things for ${name}.`,
    })
  ).id;
const ALPHA = `Alpha ${stamp}`;
const BETA = `Beta ${stamp}`;
const GONE = `Gone ${stamp}`;
const alpha = await make(ALPHA);
const beta = await make(BETA);
const gone = await make(GONE);
await call('agent.archive', { agent_id: gone });

const agents = await query('agent.list', { project_id });
result.daemon = agents.map((a) => ({
  id: a.id,
  name: a.name,
  template: a.template,
  created_at: a.created_at,
  archived_at: a.archived_at ?? null,
}));
check(
  'agent.list 有归档的那个，带 archived_at',
  agents.find((a) => a.id === gone)?.archived_at !== undefined,
  result.daemon.find((a) => a.id === gone),
);
const rank = (a) => (a.template === 'assistant' ? 0 : a.template === 'triage' ? 1 : 2);
const expected = agents
  .filter((a) => a.archived_at === undefined)
  .sort((a, b) => rank(a) - rank(b) || a.created_at - b.created_at)
  .map((a) => `resident:${a.id}`);

const rowsJs = `(() => {
  const group = document.querySelector('nav.ss-list [role=group][aria-label="本项目"]');
  if (!group) return null;
  return [...group.querySelectorAll('button.ss-rr')].map((b) => ({
    stop: b.getAttribute('data-stop'),
    label: b.getAttribute('aria-label'),
    current: b.getAttribute('aria-current'),
  }));
})()`;
const rows = await poll(async () => {
  const shown = await page.evaluate(rowsJs);
  return shown && shown.length === expected.length && shown.every((r, i) => r.stop === expected[i])
    ? shown
    : false;
});
const last = rows || (await page.evaluate(rowsJs));
result.rows = last;
check('智能体区的行顺序等于 agent.list 的 助理、问题处理、其余按创建先后(不含归档)', rows, {
  shown: last?.map((r) => r.stop),
  expected,
});
check(
  '行名：助理、问题处理、Alpha、Beta',
  last?.length === 4 &&
    last[0].label.startsWith('助理') &&
    last[1].label.startsWith('问题处理') &&
    last[2].label.startsWith(`${ALPHA}，`) &&
    last[3].label.startsWith(`${BETA}，`),
  last?.map((r) => r.label),
);
check(
  '归档的智能体不在侧栏',
  last && !last.some((r) => r.stop === `resident:${gone}` || r.label.includes(GONE)),
);
check(
  '对照组：同一读法能找到没归档的 Alpha',
  last?.some((r) => r.stop === `resident:${alpha}`),
);

const sessionsOf = async (agentId) =>
  (await query('session.list', { project_id })).filter(
    (s) => s.resident?.agent_id === agentId && !s.archived_at,
  );
check('点击前 Alpha 没有会话', (await sessionsOf(alpha)).length === 0);
check('Alpha 行显示 尚未开始', last?.[2]?.label === `${ALPHA}，尚未开始`, last?.[2]?.label);

await page.click({
  role: 'button',
  name: `${ALPHA}，`,
  exact: false,
  within: { role: 'group', name: '本项目', exact: true },
});
const opened = await poll(async () => {
  const list = await sessionsOf(alpha);
  return list.length > 0 && list;
});
check(
  '点击后 session.list 有 resident.agent_id=Alpha 的会话(resident.open {agent_id})',
  opened?.length === 1,
  opened && opened.map((s) => ({ id: s.id, resident: s.resident })),
);
const current = await poll(() =>
  page.evaluate(
    `document.querySelector('.ss-rr[data-stop="resident:${alpha}"]')?.getAttribute('aria-current') === 'true'`,
  ),
);
check('Alpha 行成为当前行(打开了它的对话)', current);
const thread = await poll(() =>
  page.evaluate(`(() => {
    const composer = [...document.querySelectorAll('textarea')].map((t) => t.getAttribute('aria-label'));
    return composer.includes(${JSON.stringify(`发给 ${ALPHA}`)}) ? { composer, empty: document.querySelector('.ss-emp')?.textContent ?? null } : null;
  })()`),
);
check(
  '主区是 Alpha 的对话：输入框叫 发给 Alpha，空状态写 Alpha 的名字',
  thread && thread.empty?.includes(`告诉${ALPHA}接下来`),
  thread,
);
check('对照组：输入框不叫 发给 Beta', thread && !thread.composer.includes(`发给 ${BETA}`));
check('对照组：Beta 没被点过，仍没有会话', (await sessionsOf(beta)).length === 0);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
