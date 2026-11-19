import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.step-verdict', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-step-verdict-${stamp}`, {
  'README.md': '# step verdict\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "step-verdict-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
// The task rows with their step runs come from board.view; the board query holds no tasks.
const view = () => query('board.view', { project_id, days: '7' });
const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
await call(
  'project.gate.set',
  {
    project_id,
    root: (await board()).projects.find((p) => p.id === project_id).roots?.[0] ?? repo,
    commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
  },
  await revision(),
);
await call('project.autoMerge.set', { project_id, enabled: true }, await revision());
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await revision(),
);

const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const definition = (steps) => ({
  slots: { before_dispatch: [], before_merge: steps, after_merge: [] },
  plan_review: { tiers: [] },
  review: { max_rounds: 1 },
});
await call('workflow.definition.set', { project_id, definition: definition([]), base_version: 0 });

// One named workflow per state, each with one before_merge prompt step that asks for a verdict.
const file = (name) => `${name}-${stamp}.txt`;
const RAN = `cat ${file('passed')}`;
const UNTOUCHED = 'docs/never-touched.md';
const PASS_SUMMARY = `The file holds hello (${stamp}).`;
const FAIL_SUMMARY = `The file misses its second line (${stamp}).`;
const STATES = {
  none: { title: `Check none ${stamp}`, steps: [{ say: 'Looked at the file.' }] },
  passed: {
    title: `Check passed ${stamp}`,
    steps: [
      { trace: { tool: 'Bash', input: { command: RAN } } },
      {
        tool: {
          name: 'step_verdict',
          arguments: {
            verdict: 'pass',
            summary: PASS_SUMMARY,
            evidence: [
              { kind: 'command', ref: RAN },
              { kind: 'file', ref: UNTOUCHED },
            ],
          },
        },
      },
    ],
  },
  failed: {
    title: `Check failed ${stamp}`,
    steps: [
      { trace: { tool: 'Bash', input: { command: `cat ${file('failed')}` } } },
      {
        tool: {
          name: 'step_verdict',
          arguments: {
            verdict: 'fail',
            summary: FAIL_SUMMARY,
            evidence: [{ kind: 'command', ref: `cat ${file('failed')}` }],
          },
        },
      },
    ],
  },
};
const workflows = {};
for (const [key, state] of Object.entries(STATES)) {
  const saved = await call('workflow.definition.save_as', { project_id, name: `${key}-${stamp}` });
  await call('workflow.definition.set', {
    project_id,
    id: saved.id,
    definition: definition([
      {
        id: 'verify',
        title: state.title,
        kind: {
          type: 'prompt',
          expects: 'verdict',
          prompt: `Check ${file(key)}.\n${script(...state.steps)}`,
        },
      },
    ]),
    base_version: saved.definition_version ?? 1,
  });
  workflows[key] = saved.id;
}

// The lead plans three tasks, one per workflow, and starts them; each task writes and commits its file.
const TASK = {
  none: `Write none ${stamp}`,
  passed: `Write passed ${stamp}`,
  failed: `Write failed ${stamp}`,
};
const planTask = (key) => ({
  id: key,
  title: TASK[key],
  goal: `Add ${file(key)}\n${script(
    { write: { path: file(key), text: 'hello\n' } },
    { commit: `Add ${file(key)}` },
    { tool: { name: 'report', arguments: { kind: 'done', text: 'Done' } } },
  )}`,
  lane: 'main',
  milestone: 'M',
  depends_on: [],
  source: [`Add ${file(key)}`],
  scope: [file(key)],
  acceptance: [`test -f ${file(key)}`],
  path: 'dispatch',
  flow_reason: 'The task runs in a session of its own',
  workflow_id: workflows[key],
});
const KEYS = Object.keys(STATES);
const plan = {
  base_version: 0,
  headline: `Step verdict ${stamp}`,
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: KEYS.map(planTask),
  milestones: [{ id: 'M', title: 'Milestone M', criteria: ['The tasks merge'], tasks: KEYS }],
  risks: [],
  assumptions: [],
};
await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `Plan ${stamp}\n${script(
    { tool: { name: 'update_board', arguments: plan } },
    { tool: { name: 'start_task', arguments: { task_ids: KEYS } } },
  )}`,
});
await page.click({ role: 'button', name: '项目看板', exact: true });
// The view and scope a previous run left; the flow chart shows every task under 全部.
await page.click({ role: 'radio', name: '任务', exact: true });
await page.click({ role: 'radio', name: '流程图', exact: true });
await page.click({ role: 'radio', name: '全部', exact: true });
await page.click({ role: 'radio', name: '总览', exact: true });

// One board read gives each task and its step run; every check below reads the same result.
const stepOf = (b, key) => {
  const task = b.tasks.find((t) => t.title === TASK[key]);
  return { task, run: task?.step_runs?.find((r) => r.step_id === 'verify') };
};
const settled = await poll(async () => {
  const b = await view();
  const done = { none: 'inconclusive', passed: 'passed', failed: 'failed' };
  // The passed task is read once it has merged, so its drawer is opened in the same state every run.
  return (
    KEYS.every((key) => stepOf(b, key).run?.state === done[key]) &&
    stepOf(b, 'passed').task?.state === 'merged' &&
    b
  );
}, 90_000);
const last = settled || (await view());
result.step_runs = Object.fromEntries(
  KEYS.map((key) => [key, stepOf(last, key).run ?? stepOf(last, key).task?.state ?? null]),
);
check(
  '前置：三个任务的步骤分别落到 inconclusive、passed、failed，通过的任务已合并',
  settled,
  result.step_runs,
);

// The needs-you list on the board's overview and the task drawer's workflow step section.
const strip = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length);
    if (!s) return null;
    return [...s.querySelectorAll('li.bf-need')].map((li) => {
      const acts = [...li.querySelectorAll('.rq-hd .rq-acts button')];
      return {
        who: li.querySelector('article')?.getAttribute('aria-label') ?? null,
        kind: li.querySelector('.rq-kind')?.textContent ?? null,
        what: li.querySelector('.rq-hd')?.textContent ?? null,
        primary: acts.filter((b) => !b.classList.contains('ib')).map((b) => b.textContent.trim()),
        more: acts.filter((b) => b.classList.contains('ib')).map((b) => b.getAttribute('aria-label')),
      };
    });
  })()`);
const drawer = () =>
  page.evaluate(`(() => {
    const d = document.querySelector('aside.bd-drw');
    if (!d || !d.getClientRects().length || d.dataset.endingStyle) return null;
    const sec = d.querySelector('section[aria-labelledby="bd-dstep"]');
    return {
      title: document.getElementById('bd-drw-title')?.textContent ?? null,
      step: sec && {
        heading: sec.querySelector('h3')?.textContent ?? null,
        title: sec.querySelector('.bd-vst')?.textContent ?? null,
        status: sec.querySelector('.bd-pchip')?.textContent ?? null,
        none: sec.querySelector('.bd-vnone')?.textContent ?? null,
        summary: sec.querySelector('.bd-vsum')?.textContent ?? null,
        evidence: [...sec.querySelectorAll('.bd-vev li')].map((li) => ({
          mark: li.querySelector('[role="img"]')?.getAttribute('aria-label') ?? null,
          ref: li.querySelector('.bd-vref')?.textContent ?? null,
          note: li.querySelector('.bd-vnote')?.textContent ?? null,
        })),
        back: sec.querySelector('.bd-vback .bd-vbt')?.textContent ?? null,
        buttons: [...sec.querySelectorAll('.bd-vsa button')].map((b) => b.textContent.trim()),
      },
    };
  })()`);
/** The task buttons of the milestone card the overview unfolds. */
const MILESTONE_TASKS = { role: 'group', name: '3 个任务：', exact: false };
// A task's card on the tasks page's flow chart opens it in the drawer; `via`, a task button of the
// overview's current milestone, opens it beside the needs-you list.
const openDrawer = async (key, via) => {
  await page.click({ role: 'radio', name: via ? '总览' : '任务', exact: true });
  // React Flow keeps a node hidden until it has measured it.
  if (!via)
    await poll(() =>
      page.evaluate(
        `[...document.querySelectorAll('[role="group"]')].some((el) => el.getAttribute('aria-label')?.startsWith(${JSON.stringify(`${TASK[key]}，`)}) && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0)`,
      ),
    );
  try {
    await page.click(via ?? { role: 'group', name: `${TASK[key]}，`, exact: false });
  } catch (error) {
    check(`打开 ${TASK[key]} 的抽屉`, false, error.message.slice(0, 300));
    return null;
  }
  return poll(async () => {
    const d = await drawer();
    return d?.title === TASK[key] && d.step && d;
  });
};

// No verdict: a row in the needs-you list and the drawer's two buttons.
const noneRun = stepOf(last, 'none').run;
const needs = (await query('needs_you.list', { project_id })).items;
const item = needs.find((i) => i.kind === 'workflow.approval' && i.source?.id === noneRun?.id);
check(
  'needs_you.list 有这一步的 workflow.approval，status 是 inconclusive',
  item?.status === 'inconclusive',
  item && { kind: item.kind, status: item.status },
);
// While the step waits on the user its merge holds, and the task's state is waiting_approval.
const holdOf = async (key) => {
  const task = stepOf(await view(), key).task;
  const run = stepOf(last, key).run;
  const session = (await query('session.list', { project_id })).find(
    (s) => s.id === run?.session_id,
  );
  return { task: task?.state ?? null, merge: session?.merge ?? null };
};
const holds = (h) =>
  h.task === 'waiting_approval' &&
  h.merge?.state === 'blocked' &&
  h.merge.reason === 'workflow_approval';
const held = await poll(async () => {
  const h = await holdOf('none');
  return holds(h) && h;
});
check(
  '后端：没交判决时 board.view 的任务 state 是 waiting_approval，会话 merge 扣在 workflow_approval',
  held,
  held || (await holdOf('none')),
);
const passedHold = await holdOf('passed');
check('对照组：同一读法对已通过的任务判 false', !holds(passedHold), passedHold);
const rowOf = (rows, title) => rows?.find((r) => r.kind === '没交判决' && r.what?.includes(title));
const rows = await poll(async () => {
  const r = await strip();
  return rowOf(r, STATES.none.title) && r;
});
const row = rowOf(rows, STATES.none.title);
result.row = row ?? rows;
check('需要你列表有一行，种类 "没交判决"，内容是步骤标题', row, rows);
check('对照组：同一读法找不到不存在的步骤标题', !rowOf(rows, `${STATES.none.title}-absent`));
check(
  '行的主按钮是 "算通过"',
  row?.primary.length === 1 && row.primary[0] === '算通过',
  row?.primary,
);
const noneDrawer = await openDrawer('none');
const ns = noneDrawer?.step;
result.none_drawer = noneDrawer ?? (await drawer()) ?? (await names(TASK.none));
check(
  '抽屉有 "工作流步骤" 一节，标题是步骤标题',
  ns?.heading === '工作流步骤' && ns.title === STATES.none.title,
  ns,
);
check(
  '状态是 "没交判决"，有一行没交判决的说明',
  ns?.status === '没交判决' && ns.none === '这一轮结束时没交判决。',
  ns && [ns.status, ns.none],
);
check('两个按钮 "算通过"、"算失败"', ns?.buttons.join('|') === '算通过|算失败', ns?.buttons);
const stateText = { inconclusive: '没交判决', passed: '通过', failed: '失败' };
check(
  '后端：步骤状态 inconclusive，与抽屉的状态一致',
  noneRun?.state === 'inconclusive' && stateText[noneRun.state] === ns?.status,
  { daemon: noneRun?.state, ui: ns?.status },
);
check('对照组：同一读法对 passed 判 false', stateText.passed !== ns?.status);

result.dark = await page.evaluate(`document.documentElement.classList.contains('dark')`);
await page.evaluate(
  `document.querySelector('aside.bd-drw section[aria-labelledby="bd-dstep"]')?.scrollIntoView({ block: 'center' })`,
);
result.shot = await page.screenshot('pair-step-verdict');

// The row's More menu holds the other decision; the drawer stays open on the overview.
await openDrawer('none', {
  role: 'button',
  name: `${TASK.none}，`,
  exact: false,
  within: MILESTONE_TASKS,
});
if (row?.more[0]) {
  await page.click({ role: 'button', name: row.more[0], exact: true });
  const items = async () => (await names('算失败')).filter((c) => c.role === 'menuitem');
  // The trigger opens its menu on the frame after the press; an empty list is not an answer yet.
  const menu = await poll(async () => {
    const found = await items();
    return found.length > 0 && found;
  });
  check('"更多操作" 菜单里有 "算失败"', menu?.length === 1, menu);
  result.drawer_with_menu = (await drawer())?.title ?? null;
  check(
    '打开 "更多操作" 菜单后抽屉还在',
    result.drawer_with_menu === TASK.none,
    result.drawer_with_menu,
  );
  // Without a menu, Escape would close the drawer and fail every check after it.
  if (menu) {
    await page.press('Escape');
    const closed = await poll(async () => (await items()).length === 0, 3000);
    check('前置：Escape 关掉菜单', closed);
    result.drawer_after_menu_escape = (await drawer())?.title ?? null;
    check(
      'Escape 关掉菜单后抽屉还在',
      result.drawer_after_menu_escape === TASK.none,
      result.drawer_after_menu_escape,
    );
  }
} else check('"更多操作" 菜单里有 "算失败"', false, row);

// The row's button is named with its task as well; the drawer's is the only one named just this.
try {
  await page.click({ role: 'button', name: '算通过', exact: true });
} catch (error) {
  check('抽屉里的 "算通过" 点得到', false, {
    error: error.message.slice(0, 200),
    drawer: await drawer(),
  });
}
const decided = await poll(async () => {
  const b = await view();
  const { run, task } = stepOf(b, 'none');
  const left = !(await query('needs_you.list', { project_id })).items.some(
    (i) => i.source?.id === noneRun?.id,
  );
  return run?.state === 'passed' && left && { run: run.state, task: task.state };
}, 15_000);
check(
  '点 "算通过" 后步骤变成 passed，needs_you.list 里这一条没了',
  decided,
  decided || stepOf(await view(), 'none').run?.state,
);
const gone = await poll(async () => !rowOf(await strip(), STATES.none.title));
check('需要你列表里这一行离开', gone);
const merged = await poll(async () => {
  const t = stepOf(await view(), 'none').task;
  return ['merging', 'merged'].includes(t?.state) && t.state;
}, 30_000);
check('任务继续去合并', merged, merged || stepOf(await view(), 'none').task?.state);

// Passed: the summary and the evidence, checked against what the turn ran.
// The overview's current milestone lists the merged task.
const passedRun = stepOf(last, 'passed').run;
const pd = (
  await openDrawer('passed', {
    role: 'button',
    name: `${TASK.passed}，已合并`,
    exact: true,
    within: MILESTONE_TASKS,
  })
)?.step;
result.passed_drawer = pd ?? (await drawer());
check(
  '通过：状态 "通过"，摘要是交的 summary',
  pd?.status === '通过' && pd.summary === PASS_SUMMARY,
  pd && [pd.status, pd.summary],
);
check(
  '跑过的命令带 "已核对" 标记',
  pd?.evidence[0]?.ref === RAN && pd.evidence[0].mark === '已核对' && !pd.evidence[0].note,
  pd?.evidence[0],
);
check(
  '没碰过的文件标 "未核对"',
  pd?.evidence[1]?.ref === UNTOUCHED &&
    pd.evidence[1].mark === '未核对' &&
    pd.evidence[1].note === '未核对',
  pd?.evidence[1],
);
const sameEvidence = (ui, verdict) =>
  !!ui &&
  !!verdict &&
  ui.summary === verdict.summary &&
  ui.evidence.length === verdict.evidence.length &&
  verdict.evidence.every(
    (e, n) => ui.evidence[n].ref === e.ref && (ui.evidence[n].mark === '已核对') === e.checked,
  );
check(
  '后端：step_runs[].verdict 的 summary、ref、checked 等于抽屉',
  passedRun?.verdict?.verdict === 'pass' && sameEvidence(pd, passedRun.verdict),
  passedRun?.verdict,
);
check(
  '对照组：把 checked 反过来，同一读法判 false',
  !sameEvidence(
    pd,
    passedRun?.verdict && {
      ...passedRun.verdict,
      evidence: passedRun.verdict.evidence.map((e) => ({ ...e, checked: !e.checked })),
    },
  ),
);
if (pd) result.shot_passed = await page.screenshot('pair-step-verdict-passed');

// Failed: the summary and the line that the task went back to the lead.
const failedRun = stepOf(last, 'failed').run;
const fd = (await openDrawer('failed'))?.step;
result.failed_drawer = fd ?? (await drawer());
check(
  '失败：状态 "失败"，摘要是交的 summary',
  fd?.status === '失败' && fd.summary === FAIL_SUMMARY,
  fd && [fd.status, fd.summary],
);
check('有 "已退回 lead" 一行', fd?.back === '已退回 lead', fd?.back);
check(
  '后端：步骤状态 failed，verdict 是 fail，与抽屉一致',
  failedRun?.state === 'failed' &&
    failedRun.verdict?.verdict === 'fail' &&
    stateText[failedRun.state] === fd?.status,
  { daemon: failedRun?.state, ui: fd?.status },
);
check('对照组：同一读法对 passed 判 false', stateText.passed !== fd?.status);

await page.press('Escape');
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
