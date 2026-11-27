import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.plan-edit', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const NAME = `verify-plan-edit-${stamp}`;
const { project_id } = await newProject(NAME, {
  'README.md': `# ${NAME}\n`,
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': `{ "name": "${NAME}", "private": true }\n`,
});
const T = { a: `edit-a-${stamp}`, b: `edit-b-${stamp}`, c: `edit-c-${stamp}` };
const RENAMED = `${T.c} renamed`;
// The main agent writes the plan and keeps its turn running, so the edits are steered into it.
const main = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${NAME}-main\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'write_plan',
        arguments: {
          milestones: [{ id: 'm', title: `beta-${stamp}` }],
          items: [
            { id: 'a', title: T.a, milestone: 'm' },
            { id: 'b', title: T.b, milestone: 'm' },
            { id: 'c', title: T.c, milestone: 'm' },
          ],
        },
      },
    },
    { hang: true },
  ])}`,
});
const before = await poll(async () => {
  const [p, all] = await Promise.all([
    query('project.plan', { project_id }),
    query('session.list', { project_id }),
  ]);
  const m = all.find((s) => s.id === main.id);
  return p.plan?.items.length === 3 && m?.last_turn?.state === 'running' && p.plan;
}, 30_000);
check(
  '前置：计划写入，主 agent 回合在跑',
  before,
  before?.items.map((i) => i.id),
);

await page.click({ role: 'button', name: '项目', exact: true });
// A read-only row's title is the name of its first button, the one that opens the item.
const planState = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="计划"]')].find((e) => e.getClientRects().length);
    if (!s) return null;
    const name = (el) => (el.getAttribute('aria-label') ?? el.textContent).trim();
    const rows = [...s.querySelectorAll('li')].filter((li) => li.querySelector('button'));
    const title = (li) => name(li.querySelector('button'));
    return {
      inputs: [...s.querySelectorAll('input')].map((i) => i.getAttribute('aria-label')),
      edited: s.querySelectorAll('[role=img][aria-label="已改"]').length,
      pending: rows
        .filter((li) => li.querySelector('[role=img][aria-label="待处理"]'))
        .map(title),
      rows: rows.map(title),
    };
  })()`);
const shown = await poll(async () => {
  const s = await planState();
  return s?.rows.length === 3 && s;
});
check('对照组：没进编辑前清单没有输入框', shown && shown.inputs.length === 0, shown);

await page.click({ role: 'button', name: '编辑', exact: true });
const editing = await poll(async () => {
  const s = await planState();
  return s?.inputs.length === 3 && s;
});
check('点 "编辑" 后每项一个标题输入框', editing, editing || (await planState()));

await page.fill({ role: 'textbox', name: `${T.c} 的标题`, exact: true }, RENAMED);
await page.evaluate(`(() => {
  const input = document.querySelector('input[aria-label=${JSON.stringify(`${T.a} 的标题`)}]');
  [...input.closest('li').querySelectorAll('button')].find((b) => b.textContent.trim() === '去掉').click();
})()`);
const edited = await poll(async () => {
  const s = await planState();
  return s?.edited === 2 && s;
});
check('改过的两行标出 "已改"', edited, edited || (await planState()));
result.editShot = await page.screenshot(`${result.id}-editing`);

await page.click({ role: 'button', name: '发给主 agent', exact: true });
const turnsOf = async () =>
  (await query('board', { project_id })).session_turns.filter((t) => t.session_id === main.id);
const turns = await poll(async () => {
  const all = await turnsOf();
  return all.some((t) => t.input.startsWith('I edited your plan in the plan list.')) && all;
}, 15_000);
const sentAll = turns?.filter?.((t) => t.input.startsWith('I edited your plan in the plan list.'));
const sent = sentAll?.[0];
result.sent = sent && { kind: sent.kind, input: sent.input };
const lines = sent?.input.split('\n').slice(1) ?? [];
const want = [
  `drop a ${JSON.stringify(T.a)}`,
  `rename c ${JSON.stringify(T.c)} -> ${JSON.stringify(RENAMED)}`,
];
check(
  '后端对照：主 agent 收到一条消息，两行改动，项 id 对得上',
  JSON.stringify(lines) === JSON.stringify(want),
  lines,
);
check('主 agent 只收到一条这样的消息', sentAll?.length === 1, sentAll?.length);
check('回合在跑时以 session.steer 发出(kind steer)', sent?.kind === 'steer', sent?.kind);
check('对照组：消息里没有没改的那项', !lines.some((line) => line.includes(T.b)), lines);

const pending = await poll(async () => {
  const s = await planState();
  return s?.inputs.length === 0 && s.pending.length === 2 && s;
});
check(
  '发出后清单回到只读，被改的两项显示 "待处理"',
  pending && [T.a, T.c].every((title) => pending.pending.includes(title)),
  pending || (await planState()),
);
check(
  '对照组：没改的那项没有 "待处理"',
  pending && !pending.pending.includes(T.b),
  pending?.pending,
);
const plan = await query('project.plan', { project_id });
check('后端对照：计划还没被重写', plan.plan?.revision === before?.revision, {
  before: before?.revision,
  now: plan.plan?.revision,
});
check('对照组：不存在的标题找不到', (await names(`edit-absent-${stamp}`)).length === 0);
result.shot = await page.screenshot(`${result.id}-pending`);

// A move: the message gives the milestone's whole order, which must be the order the editor shows.
await page.click({ role: 'button', name: '编辑', exact: true });
await poll(async () => (await planState())?.inputs.length === 3);
await page.evaluate(`(() => {
  const input = document.querySelector('input[aria-label=${JSON.stringify(`${T.b} 的标题`)}]');
  input.closest('li').querySelector('button[aria-label="上移"]').click();
})()`);
const ID = { [T.a]: 'a', [T.b]: 'b', [T.c]: 'c' };
const moved = await poll(async () => {
  const s = await planState();
  return s?.edited === 2 && s;
});
const shownOrder = (moved?.inputs ?? []).map((label) => ID[label.replace(/ 的标题$/, '')]);
check('上移后编辑视图的顺序', JSON.stringify(shownOrder) === '["b","a","c"]', shownOrder);
await page.click({ role: 'button', name: '发给主 agent', exact: true });
const orderTurn = await poll(async () =>
  (await turnsOf()).find((t) => t.input.split('\n').some((line) => line.startsWith('order '))),
);
const orderLine = orderTurn?.input.split('\n').find((line) => line.startsWith('order ')) ?? '';
const sentOrder = orderLine
  .slice(orderLine.indexOf(': ') + 2)
  .split(', ')
  .map((part) => part.split(' ')[0]);
check(
  '后端对照：移动发出一行 order,id 顺序和界面一致',
  shownOrder.length === 3 && JSON.stringify(sentOrder) === JSON.stringify(shownOrder),
  { orderLine, shownOrder },
);
check(
  '对照组：消息里没有 move 行',
  orderTurn && !orderTurn.input.split('\n').some((line) => line.startsWith('move ')),
  orderTurn?.input,
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
