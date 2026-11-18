import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.now-needs', checks: [] };
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
const blocksText = (n) => (n > 0 ? `阻塞 ${n} 个任务` : '');
const FOLDED = 3;

const stamp = Date.now();
const { project_id } = await newProject(`verify-now-needs-${stamp}`, {
  'README.md': '# needs\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "now-needs-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'ask' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
const mine = async () => (await query('needs_you.list', { project_id })).items;
await page.click({ role: 'button', name: '项目看板', exact: true });

// The needs-you list as shown on the board's Now page.
const strip = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length && el.getBoundingClientRect().height > 0);
    if (!s) return null;
    return {
      title: s.querySelector('.bf-strip-h b')?.textContent ?? null,
      count: s.querySelector('.bf-strip-n')?.textContent ?? null,
      more: s.querySelector('.bf-more')?.textContent ?? null,
      rows: [...s.querySelectorAll('li.bf-need')].map((li) => {
        const art = li.querySelector('article');
        const acts = [...li.querySelectorAll('.rq-hd .rq-acts button')];
        const menus = acts.filter((b) => b.classList.contains('ib'));
        return {
          who: art?.getAttribute('aria-label') ?? null,
          kind: li.querySelector('.rq-kind')?.textContent ?? null,
          what: li.querySelector('.rq-hd .rq-what')?.textContent ?? null,
          blocks: li.querySelector('.rq-blk')?.textContent ?? null,
          age: li.querySelector('.rq-age')?.textContent ?? null,
          primary: acts.filter((b) => !menus.includes(b)).map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), expanded: b.getAttribute('aria-expanded') })),
          more: menus.map((b) => b.getAttribute('aria-label')),
          question: !!li.querySelector('.qc-q'),
          // Height under the row's one line, and its paragraphs; a one-line row has neither.
          under: Math.round(li.querySelector('.rq-sub')?.getBoundingClientRect().height ?? 0),
          paras: [...li.querySelectorAll('p')].filter((p) => p.getClientRects().length).length,
        };
      }),
    };
  })()`);
const before = await strip();
check('项目没有等你的事时看板上没有 "需要你" 列表', before === null, before);

// The Assistant plans two tasks, asks a question the second task waits on, then proposes a change.
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
const version =
  (await query('board.view', { project_id, days: '7' })).leads?.find(
    (l) => l.session_id === assistant,
  )?.plan_version ?? 1;
const QUESTION = `Which store for ${stamp}?`;
await send([
  {
    tool: {
      name: 'ask_user',
      arguments: {
        question: QUESTION,
        options: ['SQLite', 'Postgres'],
        recommended: 'SQLite',
        assumption: 'SQLite until you answer.',
        blocks: ['task-two'],
      },
    },
  },
]);
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
// Two direct sessions each wait on a permission request, asked while the board is in front.
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
const sessionA = await waitingOn(`verify-now-a-${stamp}`, `echo a-${stamp}`);
const sessionB = await waitingOn(`verify-now-b-${stamp}`, `echo b-${stamp}`);
check('前置：两个会话都在等权限', sessionA && sessionB);

const items = await poll(async () => {
  const list = await mine();
  return list.length >= 4 && list;
}, 20_000);
check(
  '前置：needs_you.list 有问题、计划变更和两个权限请求',
  items &&
    items.filter((i) => i.decision === 'permission').length === 2 &&
    items.some((i) => i.decision === 'question' && i.blocks === 1) &&
    items.some((i) => i.decision === 'plan_change'),
  items?.map((i) => [i.kind, i.decision, i.blocks]),
);

// Rows against the daemon's list: same count, and the shown rows in its order with its decision and blocks.
const expectRows = (list, blocksOf = (i) => i.blocks) =>
  list.map((i) => ({ kind: DECISION[i.decision], blocks: blocksText(blocksOf(i) ?? 0) }));
const sameRows = (rows, want) =>
  !!rows &&
  rows.length === want.length &&
  rows.every((r, n) => r.kind === want[n].kind && r.blocks === want[n].blocks);
const shown = await poll(async () => {
  const s = await strip();
  return (
    s?.count === String(items?.length) && s.rows.length === Math.min(FOLDED, items.length) && s
  );
});
const daemon = await mine();
check('列表标题是 "需要你"', shown?.title === '需要你', shown?.title);
check('列表计数等于 needs_you.list 条数', shown?.count === String(daemon.length), {
  ui: shown?.count,
  daemon: daemon.length,
});
check(
  '前三行按顺序等于 needs_you.list：决定种类、blocks>0 才有 "阻塞 N 个任务"',
  sameRows(shown?.rows, expectRows(daemon.slice(0, FOLDED))),
  {
    ui: shown?.rows.map((r) => [r.kind, r.blocks]),
    daemon: daemon.map((i) => [i.decision, i.blocks]),
  },
);
check(
  '对照组：把问题的 blocks 当成 0，同一读法判 false',
  !sameRows(
    shown?.rows,
    expectRows(daemon.slice(0, FOLDED), (i) => (i.decision === 'question' ? 0 : i.blocks)),
  ),
);
check('折叠时显示 "还有 N 条"', shown?.more === `还有 ${daemon.length - FOLDED} 条`, shown?.more);
const rows = shown?.rows ?? [];
check(
  '每行有年龄文字',
  rows.length > 0 && rows.every((r) => /^(刚刚|\d+ (分钟|小时|天|个月))$/.test(r.age ?? '')),
  rows.map((r) => r.age),
);
check(
  '每行恰好一个操作按钮',
  rows.length > 0 && rows.every((r) => r.primary.length === 1),
  rows.map((r) => [r.kind, r.primary.map((p) => p.text)]),
);
check(
  '"更多操作" 菜单每行至多一个，名字是 "更多操作：{行名}"',
  rows.every((r) => r.more.length <= 1 && r.more.every((m) => m === `更多操作：${r.who}`)),
  rows.map((r) => [r.who, r.more]),
);

// Unfold: every row against the daemon's list.
await page.click({ role: 'button', name: `还有 ${daemon.length - FOLDED} 条`, exact: true });
const unfolded = await poll(async () => {
  const s = await strip();
  return s?.rows.length === daemon.length && s;
});
const daemonNow = await mine();
check('展开后全部行按顺序等于 needs_you.list', sameRows(unfolded?.rows, expectRows(daemonNow)), {
  ui: unfolded?.rows.map((r) => [r.kind, r.blocks]),
  daemon: daemonNow.map((i) => [i.decision, i.blocks]),
});
check('展开后列表底部没有折叠按钮', unfolded && unfolded.more === null, unfolded?.more);
const all = unfolded?.rows ?? [];
const permissionRows = all.filter((r) => r.kind === '权限');
const permissionItems = daemonNow.filter((i) => i.decision === 'permission');
check(
  '权限行的内容是请求的输入（needs_you.list 的 binding.input_summary）',
  permissionRows.length === 2 &&
    permissionRows.every((r, n) => r.what?.includes(permissionItems[n].binding?.input_summary)),
  { ui: permissionRows.map((r) => r.what), daemon: permissionItems.map((i) => i.binding) },
);
check(
  '权限行按钮是 "允许一次"，有 "更多操作"',
  permissionRows.every((r) => r.primary[0]?.text === '允许一次' && r.more.length === 1),
  permissionRows,
);
const oneLine = (r) => r.under === 0 && r.paras === 0;
check(
  '每行只有一行：计划变更行下没有第二段',
  all.length === daemonNow.length && all.some((r) => r.kind === '计划变更') && all.every(oneLine),
  all.map((r) => [r.kind, r.under, r.paras]),
);
const questionRow = all.find((r) => r.kind === '问题');
check(
  '问题行内容是问题文字，按钮是 "回答"',
  questionRow?.what?.includes(QUESTION) && questionRow.primary[0]?.text === '回答',
  questionRow,
);
const planRow = all.find((r) => r.kind === '计划变更');
check(
  '计划变更行只有一个按钮 "查看提议"，没有 "接受"、"拒绝" 和 "更多操作"',
  planRow?.primary.length === 1 &&
    planRow.primary[0].text === '查看提议' &&
    planRow.more.length === 0,
  planRow,
);
// The row's one button brings the proposal's card in the plan proposals panel into view and focus.
await page.click({ role: 'button', name: planRow.primary[0].label, exact: true });
const proposalFocus = await poll(
  () =>
    page.evaluate(
      `(() => { const el = document.activeElement; return el?.tagName === 'ARTICLE' && !!el.closest('section[aria-label="计划改动提议"]') && el.getAttribute('aria-label'); })()`,
    ),
  3000,
);
check('"查看提议" 把焦点移到 "计划改动提议" 面板里那张提议卡', proposalFocus, proposalFocus);

// No floating notice card for a wait the list shows. Only wait cards count: a result card such as
// "Assistant 回合完成" names the same session but tells a turn end, not a wait.
const notices = (wait = true) =>
  page.evaluate(
    `[...document.querySelectorAll('.toast.nc')].filter((el) => el.getClientRects().length && (!${wait} || el.querySelector('.nc-mark[data-mark="wait"]'))).map((el) => el.textContent.replace(/\\s+/g, ' ').trim())`,
  );
const matching = (cards) =>
  cards.filter((text) =>
    all.some(
      (r) =>
        (r.kind === '权限' &&
          permissionItems.some((i) => text.includes(i.binding?.input_summary))) ||
        (r.kind === '问题' && text.includes(QUESTION)) ||
        text.includes(r.who),
    ),
  );
// A card for a wait shows after the board's hold of 1.5 s, if at all; watch for one over 4 s.
await poll(async () => matching(await notices()).length > 0, 4000);
const cards = await notices();
const forShown = matching(cards);
result.notice_cards = await notices(false);
result.window_focused = await page.evaluate('document.hasFocus()');
check('列表显示的等待没有浮动通知卡', forShown.length === 0, { cards, forShown });
check(
  '对照组：同一读法对列表里的命令文字能匹配到行',
  all.some((r) => r.what?.includes(`echo a-${stamp}`)),
);
check(
  '对照组：同一匹配对问题的等待卡文字判出一张',
  matching([`Assistant 在问你${QUESTION}打开`]).length === 1,
);

// The screenshot: the list with its rows.
result.dark = await page.evaluate(`document.documentElement.classList.contains('dark')`);
result.shot = await page.screenshot('pair-board-needs');
copyFileSync(
  path.join(runDir, result.shot.file),
  path.join(runDir, 'screens', 'pair-board-needs.png'),
);

// The question row's button opens its question card under the row.
const qIndex = all.findIndex((r) => r.kind === '问题');
await page.click({ role: 'button', name: questionRow.primary[0].label, exact: true });
const opened = await poll(async () => {
  const s = await strip();
  const r = s?.rows[qIndex];
  return r?.question && r;
});
check(
  '问题行的 "回答" 在行下打开问题卡，按钮 aria-expanded=true',
  opened?.question && opened.primary[0]?.expanded === 'true',
  opened || (await strip())?.rows[qIndex],
);
check(
  '对照组：问题卡在行下打开时，同一读法判这一行不止一行',
  opened && !oneLine(opened),
  opened && [opened.under, opened.paras],
);
const otherCards = ((await strip())?.rows ?? []).filter((r, n) => n !== qIndex && r.question);
check('对照组：别的行下没有问题卡', otherCards.length === 0, otherCards.length);
await page.click({ role: 'button', name: questionRow.primary[0].label, exact: true });
await poll(async () => !(await strip())?.rows[qIndex]?.question, 3000);

// Allow the first permission row; the focus moves to the next row's action button.
const list = await mine();
const actedAt = list.findIndex((i) => i.decision === 'permission');
const acted = list[actedAt];
const next = list[actedAt + 1] ?? list[actedAt - 1];
const rowsBefore = (await strip()).rows;
const actedRow = rowsBefore[actedAt];
// The next row's one button, by its name: its action and who waits.
const nextRow = rowsBefore[list.indexOf(next)];
result.next_row = nextRow && { who: nextRow.who, primary: nextRow.primary[0]?.label };
check('前置：要允许的行是第一个权限请求', actedRow?.kind === '权限', actedRow);
await page.click({ role: 'button', name: actedRow.primary[0].label, exact: true });
const gone = await poll(async () => {
  const l = await mine();
  return !l.some((i) => i.source.id === acted.source.id) && l;
}, 10_000);
check('允许后 needs_you.list 里这一条没了', gone, gone && gone.length);
const nextAt = gone ? gone.findIndex((i) => i.source.id === next.source.id) : -1;
const focus = () =>
  page.evaluate(`(() => {
    const el = document.activeElement;
    const lis = [...document.querySelectorAll('section[aria-label="需要你"] li.bf-need')];
    return {
      row: lis.findIndex((li) => li.contains(el)),
      label: el?.getAttribute?.('aria-label') ?? null,
      menu: !!el?.classList?.contains('ib'),
      primary: !!el?.closest?.('.rq-acts') && !el.classList.contains('ib'),
    };
  })()`);
const f = await poll(async () => {
  const x = await focus();
  return x.row === nextAt && x.primary && x.label === nextRow?.primary[0]?.label && x;
}, 3000);
result.focus_after_allow = f || (await focus());
check('焦点在下一行的操作按钮上（按钮名是下一行的 "{操作} {谁}"）', f, {
  focus: result.focus_after_allow,
  nextAt,
  next: next?.decision,
});
check('对照组：焦点不在 "更多操作" 按钮上', f && !f.menu, f);
check(
  '对照组：焦点不在已允许那一行的按钮上',
  result.focus_after_allow.label !== actedRow.primary[0].label,
  result.focus_after_allow,
);
const afterRows = await poll(async () => {
  const s = await strip();
  return s?.rows.length === gone.length && s;
});
check('列表行数随 needs_you.list 减一', afterRows?.count === String(gone?.length), {
  ui: afterRows?.count,
  daemon: gone?.length,
});

// Settle everything else from the daemon; the list leaves.
for (const item of await mine()) {
  if (item.kind === 'permission')
    await call(
      'approval.respond',
      { approval_id: item.source.id, decision: 'reject' },
      item.source.revision,
    );
  else if (item.kind === 'lead.question')
    await call('lead.question.answer', {
      project_id,
      lead_session_id: item.session_id,
      question_id: item.question.id,
      answer: 'SQLite',
    });
  else if (item.kind === 'board.plan.proposal')
    await call('board.plan.proposal.resolve', {
      project_id,
      lead_session_id: item.session_id,
      proposal_id: item.request_id,
      decision: 'reject',
    });
}
const emptied = await poll(async () => (await mine()).length === 0, 10_000);
check('前置：needs_you.list 清空', emptied);
const after = await poll(async () => (await strip()) === null, 5000);
check('needs_you.list 为空后列表离开', after, await strip());

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
