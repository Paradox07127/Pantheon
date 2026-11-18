import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.resident-workers-flat', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const LANE = `Lane ${stamp}`;
const { project_id } = await newProject(`verify-flat-${stamp}`);
// The sidebar keys a resident row by its agent's id.
const ASSISTANT = (await query('agent.list', { project_id })).find(
  (a) => a.template === 'assistant',
).id;
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);

// The assistant plans one lane with one task, whose worker keeps running.
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const plan = {
  base_version: 0,
  headline: 'One running worker',
  lanes: [{ id: 'work', title: LANE }],
  tasks: [
    {
      id: 'hold',
      title: `Hold ${stamp}`,
      goal: `Hold the slot\nfixture-script\n${JSON.stringify([{ hang: true }])}`,
      lane: 'work',
      depends_on: [],
      source: ['Hold the slot'],
      scope: ['hold.txt'],
      acceptance: ['test -f hold.txt'],
      kind: { domain: 'backend-logic', tier: 't1' },
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};
const steps = [
  { tool: { name: 'update_board', arguments: plan } },
  { tool: { name: 'start_task', arguments: { task_ids: ['hold'] } } },
];
await call(
  'session.send',
  { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);
const list = await poll(async () => {
  const all = await query('session.list', { project_id });
  return all.some((s) => s.lead === assistant && s.state === 'running') && all;
}, 30_000);
const worker = list && list.find((s) => s.lead === assistant);
result.daemon = worker && {
  id: worker.id,
  state: worker.state,
  lead: worker.lead,
  task: worker.task,
};
check('session.list 里 worker 的 lead 等于常驻会话 id', worker?.lead === assistant, worker?.lead);
check(
  'worker 的 task.lane_title 等于写进计划的 lane 标题',
  worker?.task?.lane_title === LANE,
  worker?.task,
);

const layout = await poll(() =>
  page.evaluate(`(() => {
    const nav = document.querySelector('nav.ss-list');
    const row = nav?.querySelector('[data-session="${worker?.id}"]');
    const group = nav?.querySelector('[role=group]');
    const zone = nav?.querySelector('.ss-zh');
    if (!row || !group || !zone) return null;
    const resident = group.querySelector('[data-stop="resident:${ASSISTANT}"]');
    return {
      zone: zone.firstElementChild?.textContent,
      afterZone: !!(zone.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
      inResidents: group.contains(row),
      residentButtons: group.querySelectorAll('button').length,
      residentExpandable: [...group.querySelectorAll('button')].some((b) => b.hasAttribute('aria-expanded')),
      nextAfterResidents: [group.nextElementSibling, group.nextElementSibling?.nextElementSibling].map((el) => el?.className).join(),
      rowName: row.getAttribute('aria-label'),
      residentName: resident?.getAttribute('aria-label'),
    };
  })()`),
);
result.layout = layout;
check('worker 行在 会话 区标题之后', layout?.zone === '会话' && layout.afterZone, layout?.zone);
check('worker 行不在常驻组里', layout && !layout.inResidents);
check(
  '常驻组只有两行，没有展开按钮，下面是个人级入口，再下面是 会话 区标题',
  layout?.residentButtons === 2 &&
    !layout.residentExpandable &&
    layout.nextAfterResidents === 'ss-grp ss-pa,ss-zh',
  layout && [layout.residentButtons, layout.residentExpandable, layout.nextAfterResidents],
);
// The counts the row should carry, read from the same session.list.
const mine = list ? list.filter((s) => s.lead === assistant && !s.archived_at) : [];
const running = mine.filter(
  (s) => s.stopping || ['starting', 'running', 'merging'].includes(s.state),
).length;
const review = mine.filter((s) => s.state === 'ready').length;
const want = `Worker：${running} 个运行中，${review} 个待审查，0 个门禁失败`;
const name = await poll(async () => {
  const label = await page.evaluate(
    `document.querySelector('[data-stop="resident:${ASSISTANT}"]')?.getAttribute('aria-label') ?? ''`,
  );
  return label.includes(want) && label;
});
check(
  '常驻行无障碍名带 运行中/待审查/门禁失败 计数，和 session.list 一致',
  running === 1 && name,
  name || want,
);
const label = layout?.residentName ?? '';
check(
  '对照组：同一读法对错误计数判 false',
  !label.includes(`Worker：${running + 1} 个运行中`),
  label,
);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
