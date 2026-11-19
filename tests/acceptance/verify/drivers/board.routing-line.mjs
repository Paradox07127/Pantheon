import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.routing-line', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-routing-${stamp}`, {
  'README.md': '# routing\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "routing-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
// An empty board shows the setup panel in place of the bar; another lead's plan fills it.
const other = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `verify-route-other-${stamp}\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'update_board',
        arguments: {
          base_version: 0,
          headline: 'Other plan',
          lanes: [{ id: 'lane-x', title: 'Other lane' }],
          tasks: [
            {
              id: 'other-task',
              title: 'Other task',
              goal: 'Do the other task.',
              lane: 'lane-x',
              depends_on: [],
              source: ['The user asked for it.'],
              scope: ['src/index.ts'],
              acceptance: ['pnpm test'],
              kind: { domain: 'backend-logic', tier: 't1' },
              priority: 'normal',
            },
          ],
          milestones: [],
          risks: [],
          assumptions: [],
        },
      },
    },
  ])}`,
});
await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === other.id);
  return s?.last_turn?.state === 'completed';
}, 30_000);
await page.click({ role: 'button', name: '项目看板', exact: true });
// The requirement bar is on the tasks page.
await page.click({ role: 'radio', name: '任务', exact: true });
const barShown = await poll(
  () =>
    page.evaluate(
      `[...document.querySelectorAll('[aria-label]')].some((el) => el.getAttribute('aria-label') === '需求' && el.getClientRects().length)`,
    ),
  20_000,
);
check(
  '前置：看板上有 "需求" 输入框',
  barShown,
  barShown || (await page.evaluate('document.body.innerText.slice(0, 1500)')),
);
if (!barShown) {
  console.log(JSON.stringify(result, null, 2));
  page.close();
  process.exit(0);
}
// The project's turns as the board snapshot holds them, with their routing.
const turns = async () => (await query('board')).session_turns ?? [];

const task = (id, title) => ({
  id,
  title,
  goal: `Do ${title}.`,
  lane: 'lane-a',
  depends_on: [],
  source: ['The user asked for it.'],
  scope: ['src/index.ts'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  priority: 'normal',
});
const LANE = `Lane ${stamp}`;
const planWith = (base_version, tasks) => ({
  base_version,
  headline: `Routing ${stamp}`,
  lanes: [{ id: 'lane-a', title: LANE }],
  tasks,
  milestones: [],
  risks: [],
  assumptions: [],
});

// Sends a request from the bar to its default target, the Assistant; returns its turn once routed.
const request = async (title, steps) => {
  await page.fill(
    { role: 'textbox', name: '需求', exact: true },
    `${title}\nfixture-script\n${JSON.stringify(steps)}`,
  );
  await page.click({ role: 'button', name: '发送', exact: true });
  return poll(async () => {
    const turn = (await turns()).find((t) => t.input?.includes(title));
    return turn && !['queued', 'running'].includes(turn.state) && turn.routing && turn;
  }, 30_000);
};
// The routing line under the receipt of `title`: its name, text and button.
const line = (title) =>
  page.evaluate(`(() => {
    const rc = [...document.querySelectorAll('section')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(`回执：${title}`)});
    const g = rc?.querySelector('.pb-rr');
    if (!g) return null;
    return {
      name: g.getAttribute('aria-label'),
      text: g.querySelector('span')?.textContent ?? null,
      button: [...g.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  })()`);

// 1. A request the Assistant only replies to.
const ASK1 = `verify-route-answer-${stamp}`;
const turn1 = await request(ASK1, [{ say: 'Here is the answer.' }]);
check('前置：回合完成且有 routing', turn1?.state === 'completed' && turn1.routing, turn1);
const shown1 = await poll(async () => {
  const l = await line(ASK1);
  return l?.text && l;
});
check(
  'routing.kind=answered 时回执显示 "已在这里回答"',
  turn1?.routing?.kind === 'answered' && shown1?.text === '已在这里回答',
  { ui: shown1, routing: turn1?.routing },
);
check('分流行名为 "已分流：{文字}"', shown1?.name === `已分流：${shown1?.text}`, shown1);
check('分流行有 "换个分流" 按钮', shown1?.button.includes('换个分流'), shown1);
check('对照组：不是 "新计划 …"', !shown1?.text?.startsWith('新计划'), shown1);

// 2. A request the Assistant turns into a new plan through update_board.
const ASK2 = `verify-route-plan-${stamp}`;
const turn2 = await request(ASK2, [
  { tool: { name: 'update_board', arguments: planWith(0, [task('task-one', 'Task one')]) } },
]);
const shown2 = await poll(async () => {
  const l = await line(ASK2);
  return l?.text && l;
});
check(
  'routing.kind=new_plan 时回执显示 "新计划 {工作线名}"',
  turn2?.routing?.kind === 'new_plan' &&
    turn2.routing.lane_id === 'lane-a' &&
    shown2?.text === `新计划 ${LANE}`,
  { ui: shown2, routing: turn2?.routing },
);
check('对照组：工作线 id 不当作名字显示', shown2?.text !== '新计划 lane-a', shown2);

// 3. A request the Assistant adds to that plan.
const version =
  (await query('board.view', { project_id, days: '7' })).leads?.find(
    (l) => l.session_id === turn2?.session_id,
  )?.plan_version ?? 1;
const ASK3 = `verify-route-add-${stamp}`;
const turn3 = await request(ASK3, [
  {
    tool: {
      name: 'update_board',
      arguments: planWith(version, [task('task-one', 'Task one'), task('task-two', 'Task two')]),
    },
  },
]);
const shown3 = await poll(async () => {
  const l = await line(ASK3);
  return l?.text && l;
});
check(
  'routing.kind=added 时回执显示 "已加入 {工作线}，任务 {任务名}"',
  turn3?.routing?.kind === 'added' &&
    JSON.stringify(turn3.routing.task_ids) === '["task-two"]' &&
    shown3?.text === `已加入 ${LANE}，任务 Task two`,
  { ui: shown3, routing: turn3?.routing },
);
result.shot = await page.screenshot('pair-routing');
copyFileSync(path.join(runDir, result.shot.file), path.join(runDir, 'screens', 'pair-routing.png'));

// Route differently: the menu's choices, then answer here; a new turn is queued on the Assistant.
await page.click({ role: 'button', name: '换个分流', exact: true });
const menu = await poll(async () => {
  const items = (await names('')).filter((c) => c.role === 'menuitem').map((c) => c.name);
  return items.length > 0 && items;
});
result.reroute_menu = menu;
check(
  '"换个分流" 菜单有 "在这里回答" 和 "新计划"，没有已走的分流',
  menu && menu.includes('在这里回答') && menu.includes('新计划'),
  menu,
);
const before = new Set((await turns()).map((t) => t.id));
await page.click({ role: 'menuitem', name: '在这里回答', exact: true });
const rerouted = await poll(async () =>
  (await turns()).find(
    (t) =>
      !before.has(t.id) &&
      t.session_id === turn3?.session_id &&
      t.input?.includes('The user routes this request differently: answer it here'),
  ),
);
check(
  '选 "在这里回答" 后助理会话多了一个改道回合',
  rerouted,
  rerouted && {
    id: rerouted.id,
    state: rerouted.state,
    session: rerouted.session_id,
  },
);
check('改道回合带原请求文字', rerouted?.input?.includes(ASK3), rerouted?.input?.slice(0, 200));
check(
  '对照组：别的会话没有收到改道',
  !(await turns()).some(
    (t) =>
      !before.has(t.id) &&
      t.session_id !== turn3?.session_id &&
      t.input?.includes('routes this request differently'),
  ),
);
const alert = await page.evaluate(
  `[...document.querySelectorAll('.pb [role=alert]')].map((a) => a.textContent).join(' ')`,
);
check('改道没有报错', !alert, alert);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
