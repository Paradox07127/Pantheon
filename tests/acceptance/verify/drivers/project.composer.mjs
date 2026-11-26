import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.composer', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-composer-${stamp}`, {
  'README.md': '# project composer\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-composer-fixture", "private": true }\n',
});
const MAIN = `verify-composer-main-${stamp}`;
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
const before = await poll(async () => {
  const turns = await turnsOf();
  return idle(turns) && turns;
}, 30_000);
check(
  '前置：主 agent 空闲',
  before?.length,
  before?.map((t) => t.state),
);

await page.click({ role: 'button', name: '项目', exact: true });
const BOX = { role: 'textbox', name: '给主 agent 的消息', exact: true };
const readBox = () =>
  page.evaluate(`(() => {
    const ta = [...document.querySelectorAll('textarea[aria-label="给主 agent 的消息"]')].find((t) => t.getClientRects().length);
    if (!ta) return null;
    const box = ta.closest('.pj-cmp') ?? ta.parentElement;
    const send = [...box.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '发送');
    return {
      value: ta.value,
      send: send ? { disabled: send.disabled } : null,
      alert: [...box.querySelectorAll('[role=alert]')].map((a) => a.textContent.trim()),
    };
  })()`);
const empty = await poll(readBox, 10_000);
check('输入框为空时 "发送" 不可点', empty?.send?.disabled === true, empty);

// Idle: the message goes out as session.send, byte for byte.
const SEND = `verify send ${stamp}\nsecond line "quoted" & <tag>`;
await page.fill(BOX, SEND);
await page.click({ role: 'button', name: '发送', exact: true });
const sent = await poll(async () => {
  const turns = await turnsOf();
  return turns.find((t) => t.input === SEND) && turns;
}, 15_000);
const sendTurn = sent?.find?.((t) => t.input === SEND);
result.sendTurn = sendTurn;
check('后端对照：主 agent 多一个回合，输入原样', sendTurn, sendTurn);
check('空闲时以 session.send 发出(kind send)', sendTurn?.kind === 'send', sendTurn?.kind);
check(
  '对照组：没有 kind steer 的同一输入',
  !sent?.some?.((t) => t.input === SEND && t.kind === 'steer'),
  sent?.map?.((t) => t.kind),
);
const cleared = await poll(async () => (await readBox())?.value === '', 5_000);
check('发出后输入框清空', cleared, (await readBox())?.value);
await poll(async () => idle(await turnsOf()), 30_000);

// Running: a turn that never ends, then the message goes out as session.steer.
const revision = (await query('board', { project_id })).sessions.find(
  (x) => x.id === conductor.id,
).revision;
await call(
  'session.send',
  {
    session_id: conductor.id,
    input: `hold ${stamp}\nfixture-script\n${JSON.stringify([{ hang: true }])}`,
  },
  revision,
);
const holding = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === conductor.id);
  return s?.last_turn?.state === 'running' && s;
}, 20_000);
check('前置：主 agent 回合在跑', holding, holding?.last_turn);
// Waits until the screen has the running turn before typing.
await poll(
  () =>
    page.evaluate(
      `[...document.querySelectorAll('section[aria-label="项目状态"] .pj-k')].some((c) => c.textContent.startsWith('在跑') && c.querySelector('.kpi')?.textContent.trim() !== '0')`,
    ),
  10_000,
);
const STEER = `verify steer ${stamp}`;
await page.fill(BOX, STEER);
await page.press('Enter', ['Meta']);
const steered = await poll(async () => {
  const turns = await turnsOf();
  return turns.find((t) => t.input === STEER) && turns;
}, 15_000);
const steerTurn = steered?.find?.((t) => t.input === STEER);
result.steerTurn = steerTurn;
check('⌘↵ 发出；后端对照：输入原样', steerTurn, steerTurn);
check('回合在跑时以 session.steer 发出(kind steer)', steerTurn?.kind === 'steer', steerTurn?.kind);
check(
  '对照组：没有 kind send 的同一输入',
  !steered?.some?.((t) => t.input === STEER && t.kind === 'send'),
  steered?.map?.((t) => t.kind),
);
const cleared2 = await poll(async () => (await readBox())?.value === '', 5_000);
const after = await readBox();
check('⌘↵ 发出后输入框清空，没有报错', cleared2 && after?.alert.length === 0, after);
result.shot = await page.screenshot(result.id);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
