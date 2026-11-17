import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.resident-wake-fold', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const LANE = `Lane ${stamp}`;
const project = await newProject(`verify-wake-${stamp}`);
const { project_id } = project;
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
// A passing gate and auto merge let the worker merge, which wakes the assistant.
await call(
  'project.gate.set',
  {
    project_id,
    root: (await projectRow()).roots?.[0] ?? project.repo,
    commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
  },
  (await projectRow()).revision,
);
await call('project.autoMerge.set', { project_id, enabled: true }, (await projectRow()).revision);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);

const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const workerSteps = [
  { write: { path: 'notes.txt', text: 'notes\n' } },
  { commit: 'Add notes.txt' },
];
const plan = {
  base_version: 0,
  headline: 'One worker that merges',
  lanes: [{ id: 'docs', title: LANE }],
  tasks: [
    {
      id: 'notes',
      title: 'Add notes.txt',
      goal: `Add notes.txt\nfixture-script\n${JSON.stringify(workerSteps)}`,
      lane: 'docs',
      depends_on: [],
      source: ['Add notes.txt'],
      scope: ['notes.txt'],
      acceptance: ['test -f notes.txt'],
      kind: { domain: 'backend-logic', tier: 't1' },
    },
  ],
  milestones: [],
  risks: [],
  assumptions: [],
};
const steps = [
  { tool: { name: 'update_board', arguments: plan } },
  { tool: { name: 'start_task', arguments: { task_ids: ['notes'] } } },
];
await call(
  'session.send',
  { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
  (await board()).sessions.find((s) => s.id === assistant).revision,
);
const ended = (turn) => !['queued', 'running'].includes(turn.state);
// Decided on the same snapshot the checks below read.
const settled = await poll(async () => {
  const b = await board();
  const workers = b.sessions.filter((s) => s.task?.lead_session_id === assistant);
  const turns = b.session_turns.filter((t) => t.session_id === assistant);
  return workers.length === 1 &&
    workers.every((s) => s.outcome === 'merged') &&
    turns.some((t) => t.origin === 'tracker') &&
    turns.every(ended)
    ? b
    : false;
}, 120_000);
const last = settled || (await board());
const turns = last.session_turns.filter((t) => t.session_id === assistant);
result.daemon = {
  workers: last.sessions
    .filter((s) => s.task?.lead_session_id === assistant)
    .map((s) => ({ id: s.id, state: s.state, outcome: s.outcome })),
  turns: turns.map((t) => ({ origin: t.origin ?? null, state: t.state })),
};
check('worker 合并后常驻会话有 origin=tracker 的回合', settled, result.daemon);
if (settled) {
  const wakes = turns.filter((t) => ['tracker', 'external', 'sync'].includes(t.origin));
  const workers = (await query('session.list', { project_id })).filter((s) => s.lead === assistant);
  await page.click({
    role: 'button',
    name: '助理，',
    exact: false,
    within: { role: 'group', name: '常驻智能体', exact: true },
  });
  const folded = await poll(() =>
    page.evaluate(`(() => {
      const evs = [...document.querySelectorAll('button.ss-ev')];
      if (!evs.length) return null;
      return {
        names: evs.map((b) => b.textContent.trim()),
        expanded: evs.map((b) => b.getAttribute('aria-expanded')),
        open: document.querySelectorAll('.ss-evn').length,
        user: [...document.querySelectorAll('.ss-uh')].map((u) => u.textContent).filter((x) => x.includes('update_board')).length,
      };
    })()`),
  );
  result.folded = folded;
  check(
    '对话里事件行数等于 tracker/external/sync 回合数，都是 Worker 报告 按钮且 aria-expanded=false',
    folded?.names.length === wakes.length &&
      folded.names.every(
        (n) =>
          n.startsWith('Worker 报告') || n.startsWith('计划已同步') || n.startsWith('外部事件'),
      ) &&
      folded.expanded.every((e) => e === 'false') &&
      folded.open === 0,
    folded,
  );
  check('用户自己发的回合不折叠，原文可见', folded?.user === 1, folded?.user);
  await page.click({ role: 'button', name: 'Worker 报告', exact: false });
  const tracker = turns.find((t) => t.origin === 'tracker');
  const opened = await poll(() =>
    page.evaluate(`(() => {
      const b = document.querySelector('button.ss-ev[aria-expanded="true"]');
      const text = document.querySelector('.ss-evn')?.innerText ?? null;
      return b && text ? text : null;
    })()`),
  );
  // Pantheon's turns show their input without the [Pantheon] prefix (thread-model.ts shownInput).
  const probe = (tracker?.input ?? '')
    .replace(/^\[Pantheon\]\s*/, '')
    .split('\n')
    .find((line) => line.trim().length > 20)
    ?.trim()
    .slice(0, 40);
  result.opened = { probe, text: opened?.slice(0, 300) };
  check('点开事件行后显示回合原文', opened && probe && opened.includes(probe), result.opened);
  check('对照组：原文里没有不存在的片段', opened && !opened.includes(`absent-${stamp}`));

  const stripName = `Worker：0 个运行中，0 个待审查，0 个门禁失败`;
  const strip = await poll(() =>
    page.evaluate(`document.querySelector('button.ss-wsb')?.getAttribute('aria-expanded') ?? null`),
  );
  check('对话顶部有 worker 状态条，起初收起', strip === 'false', strip);
  await page.click({ role: 'button', name: stripName, exact: true });
  const lanes = await poll(() =>
    page.evaluate(`(() => {
      const pop = document.querySelector('.ss-wpop');
      if (!pop) return null;
      return [...pop.querySelectorAll('section.ss-lane')].map((s) => s.getAttribute('aria-label'));
    })()`),
  );
  const wantLanes = [...new Set(workers.map((w) => w.task?.lane_title))];
  check(
    '展开后按 lane 标题分组，和 session.list 的 task.lane_title 一致',
    lanes && JSON.stringify(lanes) === JSON.stringify(wantLanes),
    { lanes, wantLanes },
  );
  check('对照组：不存在的 lane 标题不在条里', lanes && !lanes.includes(`${LANE}-absent`));
  // A lane every worker of which ended starts folded; open it to see its workers.
  const shut = await page.evaluate(
    `document.querySelector('.ss-wpop section.ss-lane .ss-lh')?.getAttribute('aria-expanded')`,
  );
  if (shut === 'false')
    await page.click({
      role: 'button',
      name: LANE,
      exact: false,
      within: { role: 'group', name: 'Worker', exact: true },
    });
  const rows = await poll(() =>
    page.evaluate(`(() => {
      const lane = [...document.querySelectorAll('.ss-wpop section.ss-lane')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(LANE)});
      const ids = ${JSON.stringify(workers.map((w) => w.id))};
      const text = lane?.innerText ?? '';
      const found = lane ? [...lane.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent) : [];
      return found.length > 1 && { found, ids };
    })()`),
  );
  const titles = workers.map((w) => w.title);
  check(
    'lane 下列出该 lane 的 worker',
    rows && titles.every((title) => rows.found.some((n) => n?.includes(title))),
    { rows, titles },
  );
}
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
