import { open } from '../page.mjs';
const runDir = process.argv[2];
let { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'project.plan-flow', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const files = (name) => ({
  'README.md': `# ${name}\n`,
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': `{ "name": "${name}", "private": true }\n`,
});
// A project whose main agent writes plan; resolves once project.plan has it.
const planned = async (name, plan) => {
  const { project_id } = await newProject(name, files(name));
  const main = await call('session.create', {
    project_id,
    runtime: 'fixture',
    purpose: 'conductor',
    input: `${name}-main\nfixture-script\n${JSON.stringify([
      { tool: { name: 'write_plan', arguments: plan } },
      { say: 'planned' },
    ])}`,
  });
  const read = await poll(async () => {
    const [p, all] = await Promise.all([
      query('project.plan', { project_id }),
      query('session.list', { project_id }),
    ]);
    const m = all.find((s) => s.id === main.id);
    return p.plan?.items.length === plan.items.length && m?.last_turn?.state === 'completed' && p;
  }, 30_000);
  return { project_id, plan: read?.plan };
};
const viewSwitch = () =>
  page.evaluate(`(() => {
    const g = [...document.querySelectorAll('[role=radiogroup]')].find((e) => e.getAttribute('aria-label') === '计划的视图' && e.getClientRects().length);
    if (!g) return null;
    return {
      inTopBar: !!g.closest('.tb-end'),
      radios: [...g.querySelectorAll('[role=radio]')].map((r) => ({ name: r.textContent.trim(), checked: r.getAttribute('aria-checked') === 'true' })),
    };
  })()`);
const listShown = () =>
  page.evaluate(
    `[...document.querySelectorAll('section[aria-label="计划"] li.pj-it')].filter((e) => e.getClientRects().length).length`,
  );

// The control: a plan whose items wait for nothing has no switch.
const FLAT = `verify-plan-flat-${stamp}`;
const flat = await planned(FLAT, {
  milestones: [{ id: 'm', title: `里程碑-${stamp}` }],
  items: [
    { id: 'a', title: `flat-a-${stamp}`, milestone: 'm' },
    { id: 'b', title: `flat-b-${stamp}`, milestone: 'm' },
  ],
});
check(
  '前置：没有依赖的计划写入',
  flat.plan,
  flat.plan?.items.map((i) => i.depends_on ?? null),
);
await page.click({ role: 'button', name: '项目', exact: true });
const flatRows = await poll(async () => (await listShown()) === 2);
check(
  '对照组：没有依赖的计划只出列表，没有 "计划的视图" 切换',
  flatRows && (await viewSwitch()) === null,
  await viewSwitch(),
);

// A plan where one item waits for another.
const FLOW = `verify-plan-flow-${stamp}`;
const T = { up: `flow-up-${stamp}`, down: `flow-down-${stamp}`, free: `flow-free-${stamp}` };
const flow = await planned(FLOW, {
  milestones: [{ id: 'm', title: `里程碑-${stamp}` }],
  items: [
    { id: 'up', title: T.up, milestone: 'm' },
    { id: 'down', title: T.down, milestone: 'm', depends_on: ['up'] },
    { id: 'free', title: T.free, milestone: 'm' },
  ],
});
check(
  '前置：project.plan 有一项依赖另一项',
  flow.plan?.items.find((i) => i.id === 'down')?.depends_on?.[0] === 'up',
  flow.plan?.items.map((i) => [i.id, i.depends_on ?? null]),
);
await page.click({ role: 'button', name: '项目', exact: true });
const sw = await poll(async () => (await viewSwitch()) ?? false);
check(
  '有依赖时顶栏右端出现 "列表 / 流程" 切换，默认列表',
  sw?.inTopBar &&
    JSON.stringify(sw.radios) ===
      JSON.stringify([
        { name: '列表', checked: true },
        { name: '流程', checked: false },
      ]),
  sw,
);
await page.click({ role: 'radio', name: '流程', exact: true });
const nodeNames = async () => {
  const out = {};
  // A node is named by its item's title; the containers and the edges' names hold it too.
  for (const title of Object.values(T))
    out[title] = (await names(title)).map((n) => n.name).filter((n) => n === title);
  return out;
};
const nodes = await poll(async () => {
  const n = await nodeNames();
  return Object.values(n).every((x) => x.length === 1) && (await listShown()) === 0 && n;
});
result.nodes = nodes || (await nodeNames());
check(
  '切到 "流程" 后列表收起，每项一个节点（按无障碍名找到，每个标题恰一个）',
  nodes,
  result.nodes,
);
const nodeCount = await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="计划"] .react-flow__node')].filter((e) => !e.classList.contains('react-flow__node-group')).length`,
);
check('后端对照：节点数等于 project.plan 的项数', nodeCount === flow.plan?.items.length, {
  ui: nodeCount,
  daemon: flow.plan?.items.length,
});
check('对照组：不存在的标题找不到节点', (await names(`flow-absent-${stamp}`)).length === 0);
result.shot = await page.screenshot(result.id);

// Clicking a node opens its item's inspector.
await page.click({ name: T.down, exact: true });
const inspector = (title) =>
  page.evaluate(
    `[...document.querySelectorAll('aside')].some((e) => e.getClientRects().length && e.getAttribute('aria-label') === ${JSON.stringify(`${title} 的详情`)})`,
  );
const opened = await poll(() => inspector(T.down));
check(`点节点 ${T.down} 打开它的计划项检查器`, opened);
check('对照组：另一项的检查器没开', !(await inspector(T.up)));

// After a reload the project still shows the flow.
const stored = await page.evaluate(`localStorage.getItem('pantheon.planView.${flow.project_id}')`);
const flatStored = await page.evaluate(
  `localStorage.getItem('pantheon.planView.${flat.project_id}')`,
);
check('选择按项目记在 localStorage', stored === 'flow' && flatStored !== 'flow', {
  stored,
  flatStored,
});
try {
  await page.evaluate('location.reload()');
} catch {}
page.close();
({ page, query, call, errors, poll, names } = await open(runDir));
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitemradio', name: FLOW, exact: false });
await page.waitFor(
  `(document.querySelector('button[aria-label="切换项目"]')?.textContent ?? '').includes(${JSON.stringify(FLOW)})`,
  `the sidebar to show project ${FLOW}`,
);
await page.click({ role: 'button', name: '项目', exact: true });
const after = await poll(async () => {
  const s = await viewSwitch();
  const n = await nodeNames();
  return (
    s?.radios.find((r) => r.checked)?.name === '流程' &&
    Object.values(n).every((x) => x.length === 1) && { switch: s, nodes: n }
  );
});
check('刷新后仍是流程：切换选中 "流程"，节点还在', after, after || (await viewSwitch()));

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
