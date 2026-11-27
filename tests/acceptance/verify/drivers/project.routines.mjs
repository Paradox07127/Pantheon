import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.routines', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-routines-${stamp}`, {
  'README.md': '# project routines\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-routines-fixture", "private": true }\n',
});
const MAIN = `verify-routines-main-${stamp}`;
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`,
});
const ready = await poll(async () => {
  const turns = (await query('board', { project_id })).session_turns.filter(
    (t) => t.session_id === conductor.id,
  );
  return turns.length && turns.every((t) => !['queued', 'running'].includes(t.state)) && turns;
}, 30_000);
check(
  '前置：主 agent 空闲',
  ready?.length,
  ready?.map?.((t) => t.state),
);
await call('project.resident.set', { project_id, session_id: conductor.id });

const before = await query('project.routines', { project_id });
check('对照组：新建前 routines 为空', before.routines.length === 0, before.routines);

await page.click({ role: 'button', name: '项目', exact: true });
const readCard = () =>
  page.evaluate(`(() => {
    const card = [...document.querySelectorAll('section[aria-label="例程"]')].find((s) => s.getClientRects().length);
    if (!card) return null;
    return {
      rows: [...card.querySelectorAll('li')].map((li) => li.innerText),
      alert: [...card.querySelectorAll('[role=alert]')].map((a) => a.textContent.trim()),
    };
  })()`);
const empty = await poll(async () => {
  const card = await readCard();
  return card && card.rows.length === 0 && card;
}, 15_000);
check('例程卡片出现且没有行', empty, empty);

const NAME = `verify-routine-${stamp}`;
const FORM = { role: 'dialog', name: '新例程', exact: true };
await page.click({ role: 'button', name: '新例程', exact: true });
await page.fill({ role: 'textbox', name: '名称', exact: true, within: FORM }, NAME);
await page.fill(
  { role: 'textbox', name: '提示词', exact: true, within: FORM },
  'Look at the issues assigned to me',
);
await page.click({ role: 'checkbox', name: '前置检查', exact: true, within: FORM });
result.formShot = await page.screenshot(`${result.id}-form`);
await page.click({ role: 'button', name: '保存', exact: true, within: FORM });
const created = await poll(async () => {
  const routine = (await query('project.routines', { project_id })).routines.find(
    (r) => r.name === NAME,
  );
  return routine && routine.next_at !== null && routine;
}, 15_000);
check('保存后 project.routines 有它且 next_at 不为 null', created, created);
check(
  '它每 30 分钟一次、没有前置检查',
  created?.every_minutes === 30 && created.precheck === undefined,
  created,
);
const listed = await poll(async () => {
  const card = await readCard();
  return card?.rows.length === 1 && card.rows[0].includes('每 30 分钟') && card;
}, 10_000);
check('卡片的行写"每 30 分钟"', listed, listed);

await page.click({ role: 'button', name: '立即运行', exact: true });
const ran = await poll(async () => {
  const routine = (await query('project.routines', { project_id })).routines.find(
    (r) => r.name === NAME,
  );
  return routine?.last_run?.outcome === 'woken' && routine;
}, 15_000);
check('立即运行后 last_run.outcome 是 woken', ran, ran?.last_run);
const woken = await poll(async () => {
  const card = await readCard();
  return card?.rows[0]?.includes('已唤醒') && card;
}, 10_000);
check('卡片的上一次写"已唤醒"', woken, woken ?? (await readCard()));
check('对照组：运行后卡片不再写"还没跑过"', woken && !woken.rows[0].includes('还没跑过'), woken);
result.shot = await page.screenshot(result.id);

await page.click({ role: 'button', name: '暂停', exact: true });
const paused = await poll(async () => {
  const routine = (await query('project.routines', { project_id })).routines.find(
    (r) => r.name === NAME,
  );
  return routine?.state === 'paused' && routine;
}, 15_000);
check('暂停后 state 是 paused', paused, paused?.state);
const pausedRow = await poll(async () => {
  const card = await readCard();
  return card?.rows[0]?.includes('已暂停') && card;
}, 10_000);
check('卡片写"已暂停"', pausedRow, pausedRow ?? (await readCard()));

await page.click({ role: 'button', name: '删除', exact: true });
await page.click({
  role: 'button',
  name: '删除',
  exact: true,
  within: { role: 'alertdialog', name: `删除 ${NAME}？`, exact: true },
});
const removed = await poll(async () => {
  const { routines } = await query('project.routines', { project_id });
  return routines.every((r) => r.name !== NAME) && { routines };
}, 15_000);
check('删除后 project.routines 没有它', removed, removed);
const gone = await poll(async () => {
  const card = await readCard();
  return card && card.rows.length === 0 && card;
}, 10_000);
check('卡片没有行', gone, gone ?? (await readCard()));
check('卡片没有报错', gone && gone.alert.length === 0, gone?.alert);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
