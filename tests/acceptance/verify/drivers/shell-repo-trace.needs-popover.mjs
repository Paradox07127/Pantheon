import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'shell-repo-trace.needs-popover', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// The row title each decision kind gets (data/attention.ts, zh-CN/attention.json).
const DECISION = {
  plan_change: '计划变更',
  question: '问题',
  milestone_accept: '待验收的里程碑',
  repeated_failure: '失败两次',
  agent_proposal: '新智能体',
  permission: '权限',
  budget: '预算',
  improvement: '改进',
  external: '外部请求',
};
const blocksText = (n) => (n > 0 ? `阻塞 ${n} 个任务` : null);

// The title bar counts every project's waits: settle what earlier drivers left waiting anywhere,
// so the counts below are this run's.
const sessionsNow = (await query('board')).sessions;
for (const item of (await query('needs_you.list')).items) {
  if (item.kind === 'session.failed') {
    // A lead whose turn failed stays open; the daemon archives only an ended session.
    const session = sessionsNow.find((s) => s.id === (item.session_id ?? item.source.id));
    if (['failed', 'idle', 'ready', 'done', 'merged', 'discarded'].includes(session?.state))
      await call('session.archive', { session_id: session.id }, session.revision);
  } else if (item.kind === 'agent.proposal')
    await call('agent.proposal.resolve', { proposal_id: item.source.id, decision: 'decline' });
  else if (item.kind === 'permission')
    await call(
      'approval.respond',
      { approval_id: item.source.id, decision: 'reject' },
      item.source.revision,
    );
  else if (item.kind === 'lead.question')
    await call('lead.question.answer', {
      project_id: item.project_id,
      lead_session_id: item.session_id,
      question_id: item.question.id,
      answer: 'SQLite',
    });
  else if (item.kind === 'board.plan.proposal')
    await call('board.plan.proposal.resolve', {
      project_id: item.project_id,
      lead_session_id: item.session_id,
      proposal_id: item.request_id,
      decision: 'reject',
    });
}
// A wait no command settles, such as a lead's failed turn, leaves with its project.
const unsettled = (await query('needs_you.list')).items;
result.removed = [];
for (const id of new Set(unsettled.map((i) => i.project_id))) {
  if (id === run.project_id) continue;
  const project = (await query('board')).projects.find((p) => p.id === id);
  try {
    await call('project.remove', { project_id: id }, project?.revision);
    result.removed.push(project?.name);
  } catch (error) {
    result.removed.push(`${project?.name}: ${error.message.slice(0, 200)}`);
  }
}
const cleared = await poll(async () => (await query('needs_you.list')).items.length === 0);
check(
  '前置：开始时 needs_you.list 为空（全部项目）',
  cleared,
  (await query('needs_you.list')).items.map((i) => [i.kind, i.reason]),
);

const stamp = Date.now();
const { project_id, name: projectName } = await newProject(`verify-needs-${stamp}`, {
  'README.md': '# needs\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "needs-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'ask' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const allNeeds = async () => (await query('needs_you.list')).items;
const mine = async () => (await allNeeds()).filter((i) => i.project_id === project_id);

// The Assistant plans two tasks, then asks a question the second task waits on, then proposes a change.
const task = (id, title, depends_on = []) => ({
  id,
  title,
  goal: `Do ${title}.`,
  lane: 'lane-a',
  milestone: 'milestone-a',
  estimate: 3,
  depends_on,
  source: ['The user asked for it.'],
  scope: ['src/index.ts'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  priority: 'normal',
});
const plan = {
  base_version: 0,
  headline: `Needs ${stamp}`,
  lanes: [{ id: 'lane-a', title: 'Lane A' }],
  tasks: [task('task-one', 'Task one'), task('task-two', 'Task two', ['task-one'])],
  milestones: [
    {
      id: 'milestone-a',
      title: 'Milestone A',
      criteria: ['Both tasks merge.'],
      tasks: ['task-one', 'task-two'],
      due_on: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
    },
  ],
  risks: [],
  assumptions: [],
};
await call('workflow.policy.set', { project_id, plan_changes: 'confirm' });
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const idle = () =>
  poll(async () => {
    const s = (await query('session.list', { project_id })).find((x) => x.id === assistant);
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
  }, 30_000);
const send = async (steps) => {
  await idle();
  await call(
    'session.send',
    { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
    (await board()).sessions.find((s) => s.id === assistant).revision,
  );
  return idle();
};
await send([{ tool: { name: 'update_board', arguments: plan } }]);
const view = () => query('board.view', { project_id, days: '7' });
const version = (await view()).leads?.find((l) => l.session_id === assistant)?.plan_version ?? 1;
const asked = await send([
  {
    tool: {
      name: 'ask_user',
      arguments: {
        question: `Which store for ${stamp}?`,
        options: ['SQLite', 'Postgres'],
        recommended: 'SQLite',
        assumption: 'SQLite until you answer.',
        blocks: ['task-two'],
      },
    },
  },
]);
check('前置：提问的回合结束', asked?.last_turn?.state === 'completed', asked?.last_turn);
await send([
  {
    tool: {
      name: 'propose_board',
      arguments: {
        base_version: version,
        reason: 'Add a third task',
        ops: [{ type: 'add_task', task: task('task-three', 'Task three', ['task-one']) }],
      },
    },
  },
]);

// Two direct sessions each wait on a permission request.
const waitingOn = async (title, command) => {
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    permission_mode: 'ask',
    input: `${title}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command } } }])}`,
  });
  return poll(async () =>
    (await query('session.list', { project_id })).find((s) => s.title === title && s.waiting > 0),
  );
};
const sessionA = await waitingOn(`verify-needs-a-${stamp}`, 'echo a');
const sessionB = await waitingOn(`verify-needs-b-${stamp}`, 'echo b');
const items = await poll(async () => {
  const list = await mine();
  return list.length >= 4 && list;
}, 20_000);
check(
  '前置：needs_you.list 有问题、计划变更和两个权限请求，问题阻塞 1 个任务',
  items &&
    items.filter((i) => i.decision === 'permission').length === 2 &&
    items.some((i) => i.decision === 'question' && i.blocks === 1) &&
    items.some((i) => i.decision === 'plan_change'),
  items?.map((i) => [i.kind, i.decision, i.blocks]),
);

// The popover as shown: its label, empty text, and per project group the rows.
const shown = () =>
  page.evaluate(`(() => {
    const pop = document.querySelector('.np');
    if (!pop || !pop.getClientRects().length) return null;
    return {
      label: pop.getAttribute('aria-label'),
      empty: pop.querySelector('.np-x')?.textContent ?? null,
      groups: [...pop.querySelectorAll('[role=group]')].map((g) => ({
        name: g.getAttribute('aria-label'),
        rows: [...g.querySelectorAll('li')].map((li) => {
          const actions = [...li.querySelectorAll('.np-a button')];
          const more = actions.filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('更多操作'));
          return {
            title: li.querySelector('.np-t')?.textContent ?? null,
            count: li.querySelector('.np-c')?.textContent ?? null,
            primary: actions.filter((b) => !more.includes(b)).map((b) => b.textContent.trim()),
            more: more.map((b) => b.getAttribute('aria-label')),
          };
        }),
      })),
    };
  })()`);
// Where keyboard focus is: the row index and button text inside the popover, else the element's name.
const focus = () =>
  page.evaluate(`(() => {
    const el = document.activeElement;
    const rows = [...document.querySelectorAll('.np li')];
    const row = rows.findIndex((li) => li.contains(el));
    return {
      row,
      text: el?.textContent?.trim().slice(0, 40) ?? null,
      label: el?.getAttribute?.('aria-label') ?? null,
      tag: el?.tagName ?? null,
    };
  })()`);
const trigger = async () =>
  (await names('件事等你')).filter((c) => c.role === 'button' && /^\d+ 件事等你$/.test(c.name));
const expectRows = (list, decisionOf = (i) => DECISION[i.decision], blocksOf = (i) => i.blocks) =>
  list.map((i) => ({ title: decisionOf(i), count: blocksText(blocksOf(i)) }));
const sameRows = (ui, want) =>
  !!ui &&
  ui.length === want.length &&
  ui.every((r, n) => r.title === want[n].title && r.count === want[n].count);

// Open the title bar's needs-you button.
const all = await allNeeds();
const triggers = await trigger();
check(
  '标题栏按钮名是 "{needs_you.list 条数} 件事等你"',
  triggers.length === 1 && triggers[0].name === `${all.length} 件事等你`,
  { triggers, daemon: all.length },
);
await page.click({ role: 'button', name: `${all.length} 件事等你`, exact: true });
const pop = await poll(async () => {
  const s = await shown();
  return s?.groups.some((g) => g.name === projectName) && s;
});
check('popover 的名字是 "等你的 N 件事"', pop?.label === `等你的 ${all.length} 件事`, pop?.label);
const rowCount = pop?.groups.reduce((n, g) => n + g.rows.length, 0);
check('popover 行数等于 needs_you.list 条数', rowCount === all.length, {
  ui: rowCount,
  daemon: all.length,
});
const group = pop?.groups.find((g) => g.name === projectName);
const now = await mine();
check(
  '本项目的行按顺序等于 needs_you.list：标题是决定种类，blocks>0 才有 "阻塞 N 个任务"',
  sameRows(group?.rows, expectRows(now)),
  {
    ui: group?.rows.map((r) => [r.title, r.count]),
    daemon: now.map((i) => [i.decision, i.blocks]),
  },
);
check(
  '对照组：把问题的 blocks 当成 0，同一读法判 false',
  !sameRows(
    group?.rows,
    expectRows(now, undefined, (i) => (i.decision === 'question' ? 0 : i.blocks)),
  ),
);
check(
  '对照组：把权限当成"问题"，同一读法判 false',
  !sameRows(
    group?.rows,
    expectRows(now, (i) => (i.decision === 'permission' ? '问题' : DECISION[i.decision])),
  ),
);
const everyRow = pop?.groups.flatMap((g) => g.rows) ?? [];
check(
  '每行恰好一个主按钮',
  everyRow.length > 0 && everyRow.every((r) => r.primary.length === 1),
  everyRow.map((r) => [r.title, r.primary]),
);
check(
  '其余操作在 "更多操作：{行标题}" 菜单里，每行至多一个',
  everyRow.every((r) => r.more.length <= 1 && r.more.every((m) => m === `更多操作：${r.title}`)),
  everyRow.map((r) => [r.title, r.more]),
);
const permissionRow = group?.rows.find((r) => r.title === '权限');
check(
  '权限行主按钮是 "允许"，有 "更多操作：权限"',
  permissionRow?.primary[0] === '允许' && permissionRow.more[0] === '更多操作：权限',
  permissionRow,
);
const questionRow = group?.rows.find((r) => r.title === '问题');
check(
  '问题行主按钮是 "回答"，有 "更多操作：问题"',
  questionRow?.primary[0] === '回答' && questionRow.more[0] === '更多操作：问题',
  questionRow,
);
// The question row's menu holds the rest of its actions.
const menuItems = () =>
  poll(async () => {
    const items = (await names('')).filter((c) => c.role === 'menuitem').map((c) => c.name);
    return items.length > 0 && items;
  });
await page.click({
  role: 'button',
  name: '更多操作：问题',
  exact: true,
  within: { role: 'group', name: projectName, exact: true },
});
const questionMenu = await menuItems();
check(
  '"更多操作：问题" 菜单里是 "打开会话"',
  questionMenu?.length === 1 && questionMenu[0] === '打开会话',
  questionMenu,
);
await page.press('Escape');
await poll(async () => !(await names('')).some((c) => c.role === 'menuitem'), 3000);
if (!(await shown()))
  await page.click({ role: 'button', name: `${all.length} 件事等你`, exact: true });
const atShot = await poll(shown);
check(
  '截图时 popover 开着且至少 3 行',
  atShot && atShot.groups.reduce((n, g) => n + g.rows.length, 0) >= 3,
);
result.shot = await page.screenshot('pair-needs-popover');
copyFileSync(
  path.join(process.argv[2], result.shot.file),
  path.join(process.argv[2], 'screens', 'pair-needs-popover.png'),
);
await page.press('Escape');

// Settle the question and the proposal from the daemon, leaving the two permission requests.
const question = now.find((i) => i.decision === 'question');
const proposal = now.find((i) => i.decision === 'plan_change');
await call('lead.question.answer', {
  project_id,
  lead_session_id: assistant,
  question_id: question.question.id,
  answer: 'SQLite',
});
await call('board.plan.proposal.resolve', {
  project_id,
  lead_session_id: assistant,
  proposal_id: proposal.request_id,
  decision: 'reject',
});
const left = await poll(async () => {
  const list = await allNeeds();
  return list.length === 2 && list.every((i) => i.decision === 'permission') && list;
}, 20_000);
check(
  '前置：needs_you.list 只剩两个权限请求（全部项目）',
  left,
  (await allNeeds()).map((i) => [i.project_id === project_id, i.kind]),
);
await poll(async () => (await trigger())[0]?.name === '2 件事等你');
await page.click({ role: 'button', name: '2 件事等你', exact: true });
const two = await poll(async () => {
  const s = await shown();
  return s?.groups[0]?.rows.length === 2 && s;
});
check(
  'popover 显示 2 行',
  two,
  (two || (await shown()))?.groups?.map((g) => g.rows.length),
);

// Records every element that takes focus from now on, so a focus that lasts one frame still shows.
await page.evaluate(`(() => {
  window.__focusLog = [];
  if (window.__focusLogged) return;
  window.__focusLogged = true;
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    (window.__focusLog ??= []).push({
      label: el.getAttribute?.('aria-label') ?? null,
      text: (el.textContent ?? '').trim().slice(0, 40),
      in_popover: !!el.closest?.('.np'),
    });
  }, true);
})()`);
const focusLog = () => page.evaluate('window.__focusLog');

// Allow the first row from the keyboard: the popover opens with focus on the first row; Tab to its primary, Enter.
// Where the popover puts focus on open is not part of this item; it is recorded.
result.focus_at_open = await focus();
// Tab until the first row's primary has focus; Enter only there, so no other row is opened.
let onPrimary = null;
for (let n = 0; n < 4 && !onPrimary; n++) {
  await page.press('Tab');
  onPrimary = await poll(async () => {
    const f = await focus();
    return f.row === 0 && f.text === '允许' && f;
  }, 500);
}
check('前置：Tab 到第一行的 "允许"', onPrimary, onPrimary || (await focus()));
if (!onPrimary) {
  result.errors = await errors();
  console.log(JSON.stringify(result, null, 2));
  page.close();
  process.exit(0);
}
await page.press('Enter');
const afterFirst = await poll(async () => {
  const s = await shown();
  return s?.groups[0]?.rows.length === 1 && s;
});
check(
  '允许后这一行离开，剩 1 行',
  afterFirst,
  (afterFirst || (await shown()))?.groups?.map((g) => g.rows.length),
);
const daemonAfterFirst =
  (await poll(async () => {
    const list = await allNeeds();
    return list.length === 1 && list;
  })) || (await allNeeds());
check(
  'needs_you.list 剩下的是第二行的会话（第一行的请求已答）',
  daemonAfterFirst?.[0]?.session_id === sessionB.id,
  daemonAfterFirst?.map((i) => i.session_id),
);
check(
  '对照组：剩下的不是第一行的会话',
  daemonAfterFirst?.[0]?.session_id !== sessionA.id,
  daemonAfterFirst?.map((i) => i.session_id),
);
const f1 = await poll(async () => {
  const f = await focus();
  return f.row === 0 && f.text === '允许' && f;
}, 3000);
check('焦点在下一行的主按钮 "允许" 上', f1, f1 || (await focus()));
check('对照组：焦点不在 "更多操作" 上', f1 && !(f1.label ?? '').startsWith('更多操作'), f1);

// Deny the last row from its menu; the title bar's button goes once nothing waits.
await page.click({ role: 'button', name: '更多操作：权限', exact: true });
const permissionMenu = await menuItems();
check(
  '"更多操作：权限" 菜单里是 "拒绝"',
  permissionMenu?.length === 1 && permissionMenu[0] === '拒绝',
  permissionMenu,
);
await page.evaluate('window.__focusLog.length = 0');
await page.click({ role: 'menuitem', name: '拒绝', exact: true });
const emptyNow = await poll(async () => (await allNeeds()).length === 0, 10_000);
check('拒绝后 needs_you.list 为空', emptyNow);
const gone = await poll(
  async () => (await trigger()).length === 0 && (await shown()) === null,
  5000,
);
result.observed_title_bar = {
  trigger_gone: Boolean(gone),
  focus_log: await focusLog(),
  focus_now: await focus(),
};

// All projects keeps its needs-you button: the last row there returns focus to it.
const third = await waitingOn(`verify-needs-c-${stamp}`, 'echo c');
check('前置：再造一个权限请求', third, third?.id);
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitem', name: '全部项目', exact: false });
// The cell reads "等你{count}" and then which projects the count spans.
const waitingCount = (await allNeeds()).length;
const cell = await poll(async () =>
  (await names('等你')).find(
    (c) => c.role === 'button' && c.name.startsWith(`等你${waitingCount}`),
  ),
);
check('全部项目页的 "等你" 按钮计数等于 needs_you.list', cell, {
  cell,
  daemon: waitingCount,
});
await page.click({ role: 'button', name: cell.name, exact: true });
const one = await poll(async () => {
  const s = await shown();
  return s?.groups[0]?.rows.length === 1 && s;
});
check('全部项目页 popover 显示 1 行"权限"', one?.groups[0]?.rows[0]?.title === '权限', one);
await page.evaluate('window.__focusLog.length = 0');
// Tab from wherever the popover put focus until the row's primary button has it.
let onOnly = null;
for (let n = 0; n < 4 && !onOnly; n++) {
  await page.press('Tab');
  onOnly = await poll(async () => {
    const f = await focus();
    return f.row === 0 && f.text === '允许' && f;
  }, 500);
}
check('前置：Tab 到这一行的 "允许"', onOnly, onOnly || (await focus()));
await page.press('Enter');
const lastDone = await poll(async () => (await allNeeds()).length === 0, 10_000);
check('允许后 needs_you.list 为空', lastDone);
const back = await poll(async () => {
  const f = await focus();
  return /^等你\d+/.test(f.text ?? '') && f;
}, 3000);
check('最后一行处理后焦点回到打开 popover 的 "等你" 按钮', back, back || (await focus()));
check('对照组：焦点不在 popover 里', back && back.row === -1, back);
const empty = await poll(async () => (await shown())?.empty);
check('没有等你的事时 popover 显示 "没有需要你的事。"', empty === '没有需要你的事。', empty);
check('对照组：空文案不是英文原文', empty !== 'Nothing needs you.', empty);
result.focus_log_projects = await focusLog();
await page.press('Escape');

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
