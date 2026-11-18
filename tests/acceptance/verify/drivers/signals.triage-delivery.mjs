import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'signals.triage-delivery', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-delivery-${stamp}`);
const projectRow = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const residents = async (kind) =>
  (await query('session.list', { project_id })).filter((s) => s.resident?.kind === kind);
const turnsOf = async (id) =>
  (await query('board', { project_id })).session_turns.filter((t) => t.session_id === id);

// The assistant is opened first so that its turns can be counted before and after the delivery.
const assistantId = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const assistantBefore = (await turnsOf(assistantId)).length;
const agents = await query('agent.list', { project_id });
const triage = agents.find((a) => a.template === 'triage');
check(
  'agent.list 有 Triage，且监听 session_failures',
  triage?.effective_listens.includes('session_failures'),
  triage?.effective_listens,
);
check(
  '对照组：助理不监听 session_failures',
  !agents.find((a) => a.template === 'assistant').effective_listens.includes('session_failures'),
);

const FAIL = [{ fail: { message: 'Rate limited', error_code: 'rate_limited' } }];
for (let i = 0; i < 3; i++)
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `verify-delivery-${stamp}-${i}\nfixture-script\n${JSON.stringify(FAIL)}`,
  });
const outageIn = (issues) =>
  issues.find((i) => i.source === 'session_failures' && i.fingerprint.startsWith('outage:'));
const outage = await poll(async () => outageIn(await query('signal.list', { project_id })), 60_000);
check(
  'signal.list 有停摆信号，优先级 interrupt',
  outage?.priority === 'interrupt',
  outage?.priority,
);
check(
  '刚出现时还没发给任何人(30 秒分组窗口内)',
  outage && outage.routed.length === 0,
  outage?.routed,
);

// The group window is 30 seconds.
const sent = await poll(async () => {
  const now = outageIn(await query('signal.list', { project_id }));
  return now?.routed.length > 0 && now;
}, 90_000);
result.routed = sent?.routed;
check(
  '窗口后 signal.list 的 routed 有 Triage，via=interrupt',
  sent && sent.routed.at(-1).agent_id === triage?.id && sent.routed.at(-1).via === 'interrupt',
  sent?.routed,
);
const queued = (await residents('triage'))[0];
check('Triage 有常驻会话', queued, queued?.id);
const wake = await poll(async () => {
  if (!queued) return null;
  const turns = await turnsOf(queued.id);
  return turns.length > 0 && turns;
}, 30_000);
result.triageTurns = wake?.map((t) => ({ origin: t.origin ?? null, state: t.state }));
check('Triage 常驻会话有一个被唤醒的回合', wake, result.triageTurns);
check('助理没有因此多出回合', (await turnsOf(assistantId)).length === assistantBefore, {
  before: assistantBefore,
  after: (await turnsOf(assistantId)).length,
});
check(
  '对照组：助理的 routed 里没有它',
  !sent?.routed.some(
    (r) =>
      r.agent_id === assistantId ||
      r.agent_id === agents.find((a) => a.template === 'assistant').id,
  ),
);

// The same delivery in the app.
await page.click({ role: 'button', name: '工程看板', exact: true });
await page.click({ role: 'tab', name: '信号', exact: true });
// The delivery's own wake turn can end the outage, so the row sits in the filter of its state now.
await poll(async () =>
  (await turnsOf(queued.id)).every((t) => !['queued', 'running'].includes(t.state)),
);
const nowState = outageIn(await query('signal.list', { project_id }))?.state;
result.stateAfterDelivery = nowState;
const FILTER = { muted: '已静音', resolved: '已解决' }[nowState];
if (FILTER) await page.click({ role: 'radio', name: FILTER, exact: false });
const label = await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('.sg-rows [role=option]')].map((r) => r.getAttribute('aria-label')).find((l) => l.startsWith(${JSON.stringify(outage?.title ?? '')})) ?? null`,
  ),
);
check('信号页的行说 已发给问题处理', label?.includes('已发给问题处理'), label);
await page.evaluate(
  `[...document.querySelectorAll('.sg-rows [role=option]')].find((r) => r.getAttribute('aria-label').startsWith(${JSON.stringify(outage?.title ?? '')})).click()`,
);
const panel = await poll(() =>
  page.evaluate(`(() => {
    const a = document.querySelector('aside.sg-insp[aria-label="信号详情"]');
    if (!a) return null;
    return {
      facts: [...a.querySelectorAll('dt')].map((d) => [d.textContent, d.nextElementSibling?.textContent]),
      history: [...a.querySelectorAll('.sg-hist li')].map((l) => l.textContent),
    };
  })()`),
);
result.panel = panel;
const sentFact = panel?.facts.find(([l]) => l === '发给')?.[1];
check('详情 发给 一行含 问题处理', sentFact?.includes('问题处理'), sentFact);
check(
  '历史里有 已发给问题处理',
  panel?.history.some(
    (h) => h.includes('Sent to 问题处理') || h.includes('已发给问题处理') || h.includes('问题处理'),
  ),
  panel?.history,
);

// The Triage conversation.
await page.click({
  role: 'button',
  name: '问题处理，',
  exact: false,
  within: { role: 'group', name: '本项目', exact: true },
});
const convo = await poll(() =>
  page.evaluate(`(() => {
    const evs = [...document.querySelectorAll('button.ss-ev')].map((b) => b.textContent.trim());
    return evs.length ? { events: evs, text: document.querySelector('main.ss-convo')?.innerText.slice(0, 600) } : null;
  })()`),
);
result.convo = convo;
check('Triage 的对话里有折叠的唤醒事件行', convo?.events.length > 0, convo?.events);
check(
  '信号唤醒的事件行叫 信号，不叫 Worker 报告',
  convo?.events.some((e) => e.startsWith('信号')) &&
    !convo.events.some((e) => e.includes('Worker 报告')),
  convo?.events,
);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
