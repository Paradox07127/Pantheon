import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.lane-approval', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-lane-approval-${stamp}`, {
  'README.md': '# lane approval\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "lane-approval-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
const view = () => query('board.view', { project_id, days: '7' });
const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await revision(),
);
// Room for all four tasks, whose sessions keep their places after their turn ends.
await call('workflow.policy.set', { project_id, max_parallel_limit: 4, max_parallel: 4 });

const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const RISKY = `Risky lane ${stamp}`;
const PLAIN = `Plain lane ${stamp}`;
const TASK = {
  risky_top: `Top tier ${stamp}`,
  risky_low: `Low tier ${stamp}`,
  plain_one: `Plain one ${stamp}`,
  plain_two: `Plain two ${stamp}`,
};
const planTask = (id, lane, tier) => ({
  id,
  title: TASK[id],
  goal: `Do ${TASK[id]}\n${script({ say: 'Done.' })}`,
  lane,
  milestone: 'M',
  depends_on: [],
  source: ['The user asked for it.'],
  scope: [`src/${id}.ts`],
  acceptance: ['true'],
  kind: { domain: 'backend-logic', tier },
  path: 'dispatch',
  flow_reason: 'The task runs in a session of its own',
});
const RISKY_IDS = ['risky_top', 'risky_low'];
const PLAIN_IDS = ['plain_one', 'plain_two'];
const plan = (base_version, lanes, ids) => ({
  base_version,
  headline: `Lane approval ${stamp}`,
  lanes,
  tasks: ids.map((id) => planTask(id, id.split('_')[0], id === 'risky_top' ? 't3' : 't1')),
  milestones: [{ id: 'M', title: 'Milestone M', criteria: ['The tasks merge'], tasks: ids }],
  risks: [],
  assumptions: [],
});

// The lead writes its first plan, one lane with a t3 task and a t1 task, and starts both.
const LEAD = `Lead ${stamp}`;
await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'lead',
  input: `${LEAD}\n${script(
    {
      tool: {
        name: 'update_board',
        arguments: plan(0, [{ id: 'risky', title: RISKY }], RISKY_IDS),
      },
    },
    { tool: { name: 'start_task', arguments: { task_ids: RISKY_IDS } } },
  )}`,
});
const leadOf = async () =>
  (await query('session.list', { project_id })).find((s) => s.title === LEAD);
const idle = () =>
  poll(async () => {
    const s = await leadOf();
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
  }, 30_000);
const lead = await idle();
check('前置：lead 会话的回合结束', lead, lead?.last_turn);
await page.click({ role: 'button', name: '项目看板', exact: true });
await page.click({ role: 'radio', name: '任务', exact: true });
await page.click({ role: 'radio', name: '流程图', exact: true });
await page.click({ role: 'radio', name: '全部', exact: true });
await page.click({ role: 'radio', name: '总览', exact: true });

// One read of the board view and the session list gives the tasks, their waits and their sessions.
const snapshot = async () => {
  const [v, sessions] = await Promise.all([view(), query('session.list', { project_id })]);
  const tasks = Object.fromEntries(
    Object.keys(TASK).map((key) => {
      const t = v.tasks.find((x) => x.title === TASK[key]);
      const own = sessions.filter(
        (s) => s.title?.includes(TASK[key]) || t?.session_ids?.includes(s.id),
      );
      return [
        key,
        t && { state: t.state, wait: t.dispatch_wait ?? null, sessions: own.map((s) => s.id) },
      ];
    }),
  );
  return { tasks, sessions };
};
const approvalItems = async () =>
  (await query('needs_you.list', { project_id })).items.filter(
    (i) => i.kind === 'board.lane.approval',
  );

// a. needs_you.list holds one plan approval for the lane.
const items = await poll(approvalItems);
const item = items.find?.((i) => i.request_id === 'risky');
result.item = item && {
  kind: item.kind,
  request_id: item.request_id,
  session_id: item.session_id,
  primary: item.primary,
  reason: item.reason,
  next_step: item.next_step,
};
check(
  'needs_you.list 有一条 board.lane.approval，request_id 是这条线的 id',
  items.length === 1 && item && item.session_id === lead?.id,
  result.item ?? items,
);
check(
  '对照组：同一读法对不存在的线 id 判 false',
  !items.some?.((i) => i.request_id === 'risky-absent'),
);

// b. The lane's tasks have no session and wait for the plan approval.
const held = await poll(async () => {
  const s = await snapshot();
  return RISKY_IDS.every((k) => s.tasks[k]?.wait === 'plan_approval') && s;
});
const heldTasks = (held || (await snapshot())).tasks;
result.held_tasks = Object.fromEntries(RISKY_IDS.map((k) => [k, heldTasks[k]]));
check('批准前：两个任务的 dispatch_wait 都是 plan_approval', held, result.held_tasks);
check(
  '批准前：两个任务都没有会话',
  RISKY_IDS.every((k) => heldTasks[k] && heldTasks[k].sessions.length === 0),
  result.held_tasks,
);

// c. The needs-you list on the board's overview shows the lane.
const strip = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length && el.getBoundingClientRect().height > 0);
    if (!s) return null;
    return [...s.querySelectorAll('li.bf-need')].map((li) => {
      const acts = [...li.querySelectorAll('.rq-hd .rq-acts button')];
      return {
        who: li.querySelector('article')?.getAttribute('aria-label') ?? null,
        kind: li.querySelector('.rq-kind')?.textContent ?? null,
        what: li.querySelector('.rq-hd .rq-what')?.textContent ?? null,
        text: li.textContent.replace(/\\s+/g, ' ').trim(),
        primary: acts.filter((b) => !b.classList.contains('ib')).map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label') })),
        more: acts.filter((b) => b.classList.contains('ib')).map((b) => b.getAttribute('aria-label')),
      };
    });
  })()`);
const rowOf = (rows, title) => rows?.find?.((r) => r.who === title);
const rows = await poll(async () => {
  const r = await strip();
  return rowOf(r, RISKY) && r;
});
const row = rowOf(rows, RISKY);
result.row = row ?? rows;
check('看板 "需要你" 有一行，article 名是工作线标题', row, rows);
check('对照组：同一读法找不到不存在的工作线标题', !rowOf(rows, `${RISKY}-absent`));
check('行内文字有 "计划等你批准"', row?.text.includes('计划等你批准'), row?.text);
check(
  '行只有一个主按钮，名字是 "批准计划 <工作线标题>"',
  row?.primary.length === 1 &&
    row.primary[0].text === '批准计划' &&
    row.primary[0].label === `批准计划 ${RISKY}`,
  row?.primary,
);

// The queued text on the task's node on the tasks page's flow chart.
await page.click({ role: 'radio', name: '任务', exact: true });
const nodeOf = (title) =>
  page.evaluate(`(() => {
    const el = [...document.querySelectorAll('[role="group"]')].find((g) => g.getAttribute('aria-label')?.startsWith(${JSON.stringify(`${title}，`)}) && g.getClientRects().length);
    return el ? { label: el.getAttribute('aria-label'), text: el.textContent.replace(/\\s+/g, ' ').trim() } : null;
  })()`);
const node = await poll(async () => {
  const n = await nodeOf(TASK.risky_top);
  return n && (n.label + n.text).includes('排队中：等你批准计划') && n;
});
result.node = node || (await nodeOf(TASK.risky_top));
result.node_names = await names(TASK.risky_top);
check('t3 任务的节点上有 "排队中：等你批准计划"', node, result.node);

// The title bar's needs-you popover, before the approval.
const trigger = async () =>
  (await names('件事等你')).filter((c) => c.role === 'button' && /^\d+ 件事等你$/.test(c.name));
const popover = () =>
  page.evaluate(`(() => {
    const pop = document.querySelector('.np');
    if (!pop || !pop.getClientRects().length) return null;
    return [...pop.querySelectorAll('li')].map((li) => ({
      title: li.querySelector('.np-t')?.textContent ?? null,
      text: li.textContent.replace(/\\s+/g, ' ').trim(),
      buttons: [...li.querySelectorAll('.np-a button')].map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label') })),
    }));
  })()`);
const [opener] = await trigger();
if (opener) {
  await page.click({ role: 'button', name: opener.name, exact: true });
  const pop = await poll(async () => {
    const p = await popover();
    return p?.some((r) => r.text.includes(RISKY)) && p;
  }, 5000);
  result.popover = pop ? pop.filter((r) => r.text.includes(RISKY)) : await popover();
  check(
    '标题栏 "需要你" 弹层里这一条有按钮 "批准计划"',
    result.popover?.some?.((r) => r.buttons.some((b) => b.text === '批准计划')),
    result.popover,
  );
  await page.press('Escape');
  await poll(async () => (await popover()) === null, 3000);
} else check('标题栏有 "N 件事等你" 按钮', false, await names('等你'));

result.shot = await page.screenshot('board-lane-approval');

// d. Approve from the board's needs-you row, on the overview.
await page.click({ role: 'radio', name: '总览', exact: true });
try {
  await page.click({ role: 'button', name: `批准计划 ${RISKY}`, exact: true });
} catch (error) {
  check('点得到 "批准计划 <工作线标题>"', false, error.message.slice(0, 300));
}
const left = await poll(async () => !(await approvalItems()).length, 10_000);
check('批准后 needs_you.list 里没有这一条', left, await approvalItems());
const gone = await poll(async () => !rowOf(await strip(), RISKY), 5000);
check('批准后看板 "需要你" 里这一行离开', gone, await strip());
const opened = await poll(async () => {
  const s = await snapshot();
  return (
    RISKY_IDS.every(
      (k) => s.tasks[k]?.sessions.length > 0 && s.tasks[k].wait !== 'plan_approval',
    ) && s
  );
}, 30_000);
const openedTasks = (opened || (await snapshot())).tasks;
result.opened_tasks = Object.fromEntries(RISKY_IDS.map((k) => [k, openedTasks[k]]));
check('批准后两个任务都有了会话，不再等 plan_approval', opened, result.opened_tasks);

// e. A later write adds a lane with only t1 tasks; it gets no approval and its tasks start.
const version = (await view()).leads?.find((l) => l.session_id === lead?.id)?.plan_version ?? 1;
const ready = await idle();
await call(
  'session.send',
  {
    session_id: lead.id,
    input: script(
      {
        tool: {
          name: 'update_board',
          arguments: plan(
            version,
            [
              { id: 'risky', title: RISKY },
              { id: 'plain', title: PLAIN },
            ],
            [...RISKY_IDS, ...PLAIN_IDS],
          ),
        },
      },
      { tool: { name: 'start_task', arguments: { task_ids: PLAIN_IDS } } },
    ),
  },
  (await board()).sessions.find((s) => s.id === lead.id)?.revision ?? ready?.revision,
);
await idle();
const plainOpened = await poll(async () => {
  const s = await snapshot();
  return PLAIN_IDS.every((k) => s.tasks[k]?.sessions.length > 0) && s;
}, 30_000);
const plainTasks = (plainOpened || (await snapshot())).tasks;
result.plain_tasks = Object.fromEntries(PLAIN_IDS.map((k) => [k, plainTasks[k]]));
check('对照组：只有 t1 任务的新线，两个任务直接有了会话', plainOpened, result.plain_tasks);
check(
  '对照组：只有 t1 任务的新线，任务的 dispatch_wait 不是 plan_approval',
  PLAIN_IDS.every((k) => plainTasks[k] && plainTasks[k].wait !== 'plan_approval'),
  result.plain_tasks,
);
const plainItems = await approvalItems();
check('对照组：needs_you.list 里没有这条线的批准', !plainItems.length, plainItems);
const plainRow = rowOf(await strip(), PLAIN);
check('对照组：看板 "需要你" 里没有这条线', !plainRow, plainRow);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
