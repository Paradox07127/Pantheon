import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.plan-reason', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-plan-reason-${stamp}`, {
  'README.md': '# project plan reason\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-plan-reason-fixture", "private": true }\n',
});
const MAIN = `verify-reason-main-${stamp}`;
const ASK = `verify-reason-ask-${stamp}`;
const FAIL = `verify-reason-fail-${stamp}`;
const spawn = (title, steps) => ({
  tool: {
    name: 'spawn_session',
    arguments: { runtime: 'fixture', input: `${title}\nfixture-script\n${JSON.stringify(steps)}` },
  },
});
// The main agent starts one session that waits for approval and one whose turn fails.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([
    spawn(ASK, [{ ask: { tool: 'Bash', input: { command: 'echo hi' } } }, { say: 'done' }]),
    spawn(FAIL, [{ fail: `boom-${stamp}` }]),
    { say: 'ok' },
  ])}`,
});
const started = await poll(async () => {
  const all = await query('session.list', { project_id });
  const spawned = all.filter((s) => s.spawned_by?.session_id === conductor.id);
  const main = all.find((s) => s.id === conductor.id);
  const ask = spawned.find((s) => s.title === ASK);
  const fail = spawned.find((s) => s.title === FAIL);
  return (
    main?.last_turn?.state === 'completed' &&
    ask?.state === 'waiting' &&
    fail?.last_turn?.state === 'failed' && { ask, fail }
  );
}, 60_000);
check(
  '前置：一个会话待批准，一个回合失败',
  started,
  started && [started.ask.state, started.fail.last_turn],
);

const T = {
  ask: `reason-ask-${stamp}`,
  fail: `reason-fail-${stamp}`,
  waits: `reason-waits-${stamp}`,
  free: `reason-free-${stamp}`,
};
const plan = {
  milestones: [{ id: 'only', title: `里程碑-${stamp}` }],
  items: [
    { id: 'ask', title: T.ask, milestone: 'only', session_ids: [started?.ask.id ?? ''] },
    { id: 'fail', title: T.fail, milestone: 'only', session_ids: [started?.fail.id ?? ''] },
    { id: 'waits', title: T.waits, milestone: 'only', depends_on: ['ask'] },
    { id: 'free', title: T.free, milestone: 'only' },
  ],
};
const revisionOf = async (id) =>
  (await query('board', { project_id })).sessions.find((x) => x.id === id).revision;
await call(
  'session.send',
  {
    session_id: conductor.id,
    input: `plan\nfixture-script\n${JSON.stringify([
      { tool: { name: 'write_plan', arguments: plan } },
      { say: 'planned' },
    ])}`,
  },
  await revisionOf(conductor.id),
);
const settled = await poll(async () => {
  const [p, all] = await Promise.all([
    query('project.plan', { project_id }),
    query('session.list', { project_id }),
  ]);
  const main = all.find((s) => s.id === conductor.id);
  return (
    p.plan?.items.length === plan.items.length &&
    main?.state !== 'running' &&
    main?.last_turn?.state === 'completed' && { plan: p.plan, sessions: all }
  );
}, 30_000);
const view = settled?.plan;
// The plan read the rows were last compared with; a late notice can turn a failure's handled_by.
let latest = view;
// Whether one poll saw the daemon's failure owner and the screen's chip agree.
let paired = false;
const item = (id) => latest?.items.find((i) => i.id === id);
const handled = { main_agent: '主 agent 已知道', you: '等你处理' };
result.backend = view?.items.map((i) => ({
  id: i.id,
  title: i.title,
  status: i.status,
  stage: i.stage,
  failure: i.failure,
  stuck_since: i.stuck_since,
  depends_on: i.depends_on,
}));
check('前置：project.plan 有写入的计划，主 agent 回合结束', view, result.backend);
const askNeeds = settled?.sessions.find((s) => s.id === started?.ask.id)?.recap?.needs_you;
result.askNeeds = askNeeds ?? null;

await page.click({ role: 'button', name: '项目', exact: true });
const readReasons = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="计划"]')].find((e) => e.getClientRects().length);
    if (!s) return null;
    return [...s.querySelectorAll('li.pj-it')].map((li) => {
      const why = li.querySelector('.pj-why');
      return {
        title: li.querySelector('.pj-t > button, .pj-t > span')?.textContent.trim(),
        lines: li.querySelectorAll('.pj-why').length,
        text: why ? (why.querySelector(':scope > .clip-1, :scope > span:not(.chip)')?.textContent.trim() ?? null) : null,
        chips: why ? [...why.querySelectorAll('.chip')].map((c) => c.textContent.trim()) : [],
        button: why?.querySelector('button')?.textContent.trim() ?? null,
      };
    });
  })()`);
const rows =
  (await poll(async () => {
    const v = await readReasons();
    const p = (await query('project.plan', { project_id })).plan;
    const f = p?.items.find((i) => i.id === 'fail');
    const shownFail = v?.find?.((x) => x.title === T.fail);
    if (v?.length !== 4 || !f?.failure || shownFail?.chips[0] !== handled[f.failure.handled_by])
      return false;
    latest = p;
    paired = true;
    return v;
  }, 15_000)) || (await readReasons());
result.shown = rows;
const row = (title) => rows?.find?.((r) => r.title === title);

check('后端对照：同一次轮询里 daemon 的 handled_by 和界面的 chip 对上', paired);
check('每行至多一行原因', rows?.length === 4 && rows.every((r) => r.lines <= 1), rows);
// The waiting item.
const ask = item('ask');
const askRow = row(T.ask);
check(
  '后端对照：status 为 needs_you 的项写 recap.needs_you(没有就 "等你处理")加按钮 "去处理"',
  ask?.status === 'needs_you' &&
    askRow?.text === (askNeeds || '等你处理') &&
    askRow.button === '去处理',
  { row: askRow, status: ask?.status, needs_you: askNeeds },
);
// The failed item.
const fail = item('fail');
const failRow = row(T.fail);
check(
  '后端对照：有 failure 的项写失败原因加 chip(按 handled_by)',
  fail?.failure &&
    failRow?.text === fail.failure.reason &&
    failRow.chips[0] === handled[fail.failure.handled_by] &&
    !failRow.button,
  { row: failRow, failure: fail?.failure },
);
check(
  '对照组：失败行的 chip 不是另一种 handled_by',
  fail?.failure &&
    failRow?.chips[0] !== handled[fail.failure.handled_by === 'you' ? 'main_agent' : 'you'],
  failRow?.chips,
);
// The item that waits on another.
const waits = item('waits');
check(
  '后端对照：未开始且依赖没落地时写 "等 X 落地"',
  waits?.status === 'not_started' &&
    JSON.stringify(waits.depends_on) === '["ask"]' &&
    item('ask')?.stage !== 'landed' &&
    row(T.waits)?.text === `等 ${T.ask} 落地`,
  { row: row(T.waits), depends_on: waits?.depends_on },
);
check(
  '对照组：没有依赖、没有会话的项没有原因行',
  item('free')?.status === 'not_started' && row(T.free)?.lines === 0,
  row(T.free),
);
check('对照组：依赖读法对错的标题判 false', row(T.waits)?.text !== `等 ${T.fail} 落地`);
result.shot = await page.screenshot(result.id);

// "去处理" opens the waiting session.
await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="计划"] li.pj-it')].find((li) => li.textContent.includes(${JSON.stringify(T.ask)}))?.querySelector('.pj-why button')?.click()`,
);
const opened = await poll(
  () =>
    page.evaluate(`(() => {
      const m = [...document.querySelectorAll('main[aria-label="对话"]')].find((e) => e.getClientRects().length);
      const list = [...document.querySelectorAll('section[aria-label="计划"]')].some((e) => e.getClientRects().length);
      return m && !list ? { current: [...document.querySelectorAll('[aria-current]')].filter((e) => e.getClientRects().length).map((e) => (e.getAttribute('aria-label') ?? e.textContent).slice(0, 120)) } : null;
    })()`),
  10_000,
);
result.opened = opened;
const currentRow = (title) => opened?.current.some((c) => c.startsWith(`${title}，fixture`));
check('点 "去处理" 打开待批准的会话(侧栏它的行 aria-current)', currentRow(ASK), opened);
check('对照组：打开的不是失败的会话', opened && !currentRow(FAIL), opened?.current);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
