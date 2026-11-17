import { projectShown } from '../../lib/desktop-app.mjs';
import { open } from '../page.mjs';
const runDir = process.argv[2];
let { page, query, call, errors, poll, newProject } = await open(runDir, { ms: 300_000 });
const result = { id: 'sessions.agent-proposal-card', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const project = await newProject(`verify-proposal-card-${stamp}`);
const { project_id } = project;
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const FIRST = `Scout ${stamp}`;
const SECOND = `Keeper ${stamp}`;
const EDITED = `Renamed ${stamp}`;
const cardOf = (name) => ({ name: `智能体提议：${name}`, exact: true });

// The assistant proposes two agents through its propose_agent tool, as a model's turn would.
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const propose = (name) => ({
  tool: {
    name: 'propose_agent',
    arguments: {
      template: 'custom',
      name,
      role: 'Scout',
      instructions: 'You scout the repository for stale docs and tell the user.',
      tools: ['board'],
      routines: [{ prompt: 'Look for stale docs.', every_minutes: 1440, enabled: true }],
    },
  },
});
await call(
  'session.send',
  {
    session_id: assistant,
    input: `fixture-script\n${JSON.stringify([propose(FIRST), propose(SECOND)])}`,
  },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);
const pending = await poll(async () => {
  const items = (await query('needs_you.list', { project_id })).items.filter(
    (i) => i.kind === 'agent.proposal',
  );
  return items.length === 2 ? items : null;
}, 60_000);
const idOf = (name) => pending?.find((i) => i.agent_proposal?.name === name)?.source.id;
result.proposals = { first: idOf(FIRST), second: idOf(SECOND) };
check('前置：needs_you.list 有两条 agent.proposal', idOf(FIRST) && idOf(SECOND), result.proposals);

/** Opens the assistant's thread from its sidebar row. */
const openAssistant = async () => {
  const label = await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('.ss-rr')].map((r) => r.getAttribute('aria-label')).find((l) => l?.startsWith('助理，')) ?? null`,
    ),
  );
  await page.click({ name: label, exact: true });
};
const cardState = (name) =>
  page.evaluate(`(() => {
    const card = document.querySelector('section.ag-pc[aria-label=${JSON.stringify(`智能体提议：${name}`)}]');
    if (!card) return null;
    return {
      buttons: [...card.querySelectorAll('.ag-pcf button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
    };
  })()`);
const lineShown = (text) =>
  page.evaluate(
    `[...document.querySelectorAll('.ag-ln')].some((l) => l.textContent.includes(${JSON.stringify(text)}))`,
  );

await openAssistant();
const first = await poll(async () => {
  const c = await cardState(FIRST);
  return c?.buttons.some((b) => b.text === '创建' && !b.disabled) ? c : null;
}, 20_000);
check('提议卡显示，带可点的 创建', first, first);

await page.click({ role: 'button', name: '编辑', exact: true, within: cardOf(FIRST) });
await page.fill({ role: 'textbox', name: '名称', exact: true, within: cardOf(FIRST) }, EDITED);
await page.click({ role: 'button', name: '创建', exact: true, within: cardOf(FIRST) });
const line = await poll(() => lineShown(`你创建了${EDITED}`));
const decidedAt = Date.now();
check(`卡片换成 你创建了${EDITED}`, line);
check('对照组：没有 你创建了{原名}', !(await lineShown(`你创建了${FIRST}`)));
const stored = await poll(async () => {
  const p = await query('agent.proposal', { proposal_id: idOf(FIRST) });
  return p?.state === 'created' && p;
});
result.stored = stored && {
  state: stored.state,
  edited_fields: stored.edited_fields,
  resolved_at: stored.resolved_at,
};
check(
  'agent.proposal 是 created，edited_fields.name 是新名字',
  stored?.state === 'created' && stored.edited_fields?.name === EDITED,
  result.stored,
);

// Reload at once, well inside a minute of the decision.
await page.evaluate(`window.__beforeReload = ${stamp}`);
await page.evaluate('location.reload()').catch(() => {});
page.close();
({ page, query, call, errors, poll } = await open(runDir, { ms: 300_000 }));
if (!(await page.evaluate(projectShown(project.name)))) {
  await page.click({ role: 'button', name: '切换项目', exact: true });
  await page.click({ role: 'menuitemradio', name: project.name, exact: false });
  await page.waitFor(projectShown(project.name), `the sidebar to show project ${project.name}`);
}
check(
  '刷新确实发生：刷新前的标记已不在',
  await page.evaluate(`window.__beforeReload === undefined`),
);
await openAssistant();
const after = await poll(async () => {
  const shown = await lineShown(`你创建了${EDITED}`);
  const second = await cardState(SECOND);
  return shown && second?.buttons.length ? { shown, second } : null;
}, 20_000);
result.reload = {
  seconds_after_decision: Math.round((Date.now() - decidedAt) / 100) / 10,
};
check('刷新后仍是 你创建了{新名字} 一行', after?.shown, result.reload);
const firstAfter = await cardState(FIRST);
check('刷新后第一张卡不在，也没有 创建 按钮', firstAfter === null, firstAfter);
check(
  '对照组：未决定的第二张卡刷新后仍有 创建',
  after?.second?.buttons.some((b) => b.text === '创建'),
  after?.second,
);
result.shot = await page.screenshot(result.id);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
