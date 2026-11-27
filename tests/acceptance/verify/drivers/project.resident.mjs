import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.resident', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-resident-${stamp}`, {
  'README.md': '# project resident\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-resident-fixture", "private": true }\n',
});
const MAIN = `verify-resident-main-${stamp}`;
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`,
});
const turnsOf = async () =>
  (await query('board', { project_id })).session_turns.filter((t) => t.session_id === conductor.id);
const idle = (turns) =>
  turns.length && turns.every((t) => !['queued', 'running'].includes(t.state));
const ready = await poll(async () => {
  const turns = await turnsOf();
  return idle(turns) && turns;
}, 30_000);
check(
  '前置：主 agent 空闲',
  ready?.length,
  ready?.map?.((t) => t.state),
);

const before = await query('project.resident', { project_id });
check('对照组：设常驻前 session_id 为 null', before.session_id === null, before.session_id);

await page.click({ role: 'button', name: '项目', exact: true });
const readCard = () =>
  page.evaluate(`(() => {
    const card = [...document.querySelectorAll('section[aria-label="常驻"]')].find((s) => s.getClientRects().length);
    if (!card) return null;
    const counts = Object.fromEntries([...card.querySelectorAll('.pj-rkc')].map((c) => [
      c.querySelector('.cap')?.textContent.trim(), c.querySelector('.kpi')?.textContent.trim(),
    ]));
    return {
      text: card.innerText,
      buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
      counts,
      alert: [...card.querySelectorAll('[role=alert]')].map((a) => a.textContent.trim()),
    };
  })()`);
const SET = `把 ${MAIN} 设为常驻`;
const unset = await poll(async () => {
  const card = await readCard();
  return card?.buttons.includes(SET) && card;
}, 15_000);
check('没有常驻时卡片写"还没有常驻主 agent"', unset?.text?.includes('还没有常驻主 agent'), unset);

await page.click({ role: 'button', name: SET, exact: true });
const set = await poll(async () => {
  const r = await query('project.resident', { project_id });
  return r.session_id === conductor.id && r;
}, 15_000);
check('点"设为常驻"后 project.resident 的 session_id 是它', set, set?.session_id);
const shown = await poll(async () => {
  const card = await readCard();
  return card?.buttons.includes('取消常驻') && card;
}, 10_000);
check('卡片显示会话标题和"取消常驻"', shown?.text?.includes(MAIN), shown);

const MESSAGE = `verify resident ${stamp}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`;
await page.fill({ role: 'textbox', name: '给主 agent 的消息', exact: true }, MESSAGE);
await page.click({ role: 'button', name: '发送', exact: true });
const answered = await poll(async () => {
  const turns = await turnsOf();
  return turns.some((t) => t.input === MESSAGE) && idle(turns) && turns;
}, 30_000);
check(
  '前置：发出的回合结束',
  answered,
  answered?.map?.((t) => t.state),
);
const counted = await poll(async () => {
  const r = await query('project.resident', { project_id });
  const card = await readCard();
  return r.turns.user >= 1 && card?.counts['你打的回合'] === String(r.turns.user) && { r, card };
}, 15_000);
check(
  '"你打的回合"等于 project.resident 的 turns.user',
  counted,
  counted ? { turns: counted.r.turns, counts: counted.card.counts } : await readCard(),
);
check(
  '"Pantheon 起的回合"等于 project.resident 的 turns.pantheon',
  counted && counted.card.counts['Pantheon 起的回合'] === String(counted.r.turns.pantheon),
  counted?.card?.counts,
);
check(
  '对照组："你打的回合"不等于 turns.user + 1',
  counted && counted.card.counts['你打的回合'] !== String(counted.r.turns.user + 1),
  counted?.card?.counts,
);
result.shot = await page.screenshot(result.id);

await page.click({ role: 'button', name: '取消常驻', exact: true });
const cleared = await poll(async () => {
  const r = await query('project.resident', { project_id });
  return r.session_id === null && r;
}, 15_000);
check('点"取消常驻"后 session_id 为 null', cleared, cleared?.session_id);
const back = await poll(async () => {
  const card = await readCard();
  return card?.text?.includes('还没有常驻主 agent') && card;
}, 10_000);
check('卡片回到"还没有常驻"', back?.buttons?.includes(SET), back);
check('卡片没有报错', back && back.alert.length === 0, back?.alert);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
