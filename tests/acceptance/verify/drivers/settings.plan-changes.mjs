import { open } from '../page.mjs';
const { page, query, call, errors, poll, reset, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'settings.plan-changes', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Every project follows the global value; start from the built-in one and put the user's back at the end.
const globalOf = async () =>
  (await query('project.defaults')).settings.find((s) => s.key === 'workflow_policy')?.global;
const saved = await globalOf();
const restore = async () => {
  if (saved) await call('project.defaults.set', { key: 'workflow_policy', value: saved });
  else await call('project.defaults.clear', { key: 'workflow_policy' });
};
if (saved && 'plan_changes' in saved) {
  const { plan_changes: _, ...rest } = saved;
  if (Object.keys(rest).length)
    await call('project.defaults.set', { key: 'workflow_policy', value: rest });
  else await call('project.defaults.clear', { key: 'workflow_policy' });
}

const stamp = Date.now();
const { project_id } = await newProject(`verify-plan-changes-${stamp}`, {
  'README.md': '# plan changes\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "plan-changes-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);

// Settings > Workflow shows the value a fresh project follows.
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '流程', exact: true });
const rowValue = () =>
  page.evaluate(`(() => {
    const row = document.querySelector('[role=group][aria-label="计划改动"]');
    if (!row) return null;
    return [...row.querySelectorAll('[role=radio]')]
      .filter((r) => r.getAttribute('aria-checked') === 'true')
      .map((r) => r.textContent.trim());
  })()`);
const shown = await poll(async () => {
  const v = await rowValue();
  return v?.length ? v : null;
});
check(
  '设置页"计划改动"一行选中"lead 直接改"',
  shown?.length === 1 && shown[0] === 'lead 直接改',
  shown,
);
check('对照组：选中的不是"等我批准"', shown && !shown.includes('等我批准'), shown);
const policy0 = await query('workflow.policy', { project_id });
check(
  '新项目 workflow.policy 的 plan_changes 是 auto',
  policy0.plan_changes === 'auto',
  policy0.plan_changes,
);

// The assistant resident writes a small plan, then proposes changes to it.
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const task = (id, title) => ({
  id,
  title,
  goal: `Do ${title}.`,
  lane: 'lane-a',
  milestone: 'milestone-a',
  estimate: 3,
  depends_on: [],
  source: ['The user asked for it.'],
  scope: ['src/index.ts'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  priority: 'normal',
});
const plan = {
  base_version: 0,
  headline: `Plan changes ${stamp}`,
  lanes: [{ id: 'lane-a', title: 'Lane A' }],
  tasks: [task('task-one', 'Task one'), task('task-two', 'Task two')],
  milestones: [
    {
      id: 'milestone-a',
      title: 'Milestone A',
      criteria: ['Both tasks merge.'],
      tasks: ['task-one', 'task-two'],
      due_on: day(10),
    },
  ],
  risks: [],
  assumptions: [],
};
const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const send = async (steps) =>
  call(
    'session.send',
    { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
    (await board()).sessions.find((s) => s.id === assistant).revision,
  );
await send([{ tool: { name: 'update_board', arguments: plan } }]);
const view = () => query('board.view', { project_id, days: '7' });
const leadOf = (v) => v.leads?.find((l) => l.session_id === assistant);
const hasTask = (v, id) => v.tasks?.some((t) => t.id.endsWith(`:${id}`));
const planned = await poll(async () => {
  const v = await view();
  return hasTask(v, 'task-one') && v;
}, 30_000);
check('前置：lead 的计划在 board.view 上', planned, planned && leadOf(planned)?.plan_version);

const proposeAdd = async (id, title) => {
  await poll(async () => {
    const s = (await query('session.list', { project_id })).find((x) => x.id === assistant);
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state);
  }, 30_000);
  await send([
    {
      tool: {
        name: 'propose_board',
        arguments: {
          base_version: leadOf(await view())?.plan_version ?? 1,
          reason: `Add ${title}`,
          ops: [{ type: 'add_task', task: { ...task(id, title), depends_on: ['task-one'] } }],
        },
      },
    },
  ]);
};
const proposalOf = async (id) =>
  (await query('project.read', { project_id })).plans
    ?.find((p) => p.lead_session_id === assistant)
    ?.recent_proposals?.find((p) => p.ops.some((op) => op.task?.id === id));
const pendingOf = (v, id) =>
  leadOf(v)?.pending_proposals?.find((p) => p.ops.some((op) => op.task?.id === id));
const needsProposal = async () =>
  (await query('needs_you.list', { project_id })).items.filter(
    (i) => i.kind === 'board.plan.proposal',
  );
// The needs-you rows that decide a plan proposal in place: each has its change-then-accept toggle.
const cards = () =>
  page.evaluate(`(() => {
    const list = document.querySelector('section[aria-label="需要你"]');
    return list
      ? [...list.querySelectorAll('article')].filter((row) =>
          [...row.querySelectorAll('button[aria-expanded]')].some((b) =>
            b.getAttribute('aria-label')?.startsWith('改一下再接受 '),
          ),
        ).length
      : 0;
  })()`);

// Auto: the change lands at once.
const AUTO = `task-auto-${stamp}`.slice(0, 40);
await proposeAdd(AUTO, 'Auto task');
const applied = await poll(async () => {
  const v = await view();
  return hasTask(v, AUTO) && v;
}, 30_000);
check('auto:board.view 的计划已有提议加的任务', applied, AUTO);
check(
  'auto:board.view 上没有待定提议',
  applied && !pendingOf(applied, AUTO),
  applied && leadOf(applied)?.pending_proposals,
);
const autoStored = await proposalOf(AUTO);
check('auto:提议存为 accepted', autoStored?.status === 'accepted', autoStored?.status);
const autoNeeds = await needsProposal();
check('auto:needs_you.list 没有 board.plan.proposal', autoNeeds.length === 0, autoNeeds);
await reset();
await page.click({ role: 'button', name: '项目看板', exact: true });
// The accepted task shows on the tasks page's flow chart once the board read has it.
await page.click({ role: 'radio', name: '任务', exact: true });
await page.click({ role: 'radio', name: '流程图', exact: true });
await page.click({ role: 'radio', name: '全部', exact: true });
await poll(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify('Auto task')})`));
await page.click({ role: 'radio', name: '总览', exact: true });
const autoCards = await cards();
check('auto:看板"总览"页的需要你没有提议行', autoCards === 0, autoCards);
result.shot_auto = await page.screenshot(`${result.id}-auto`);

// Control group: "等我批准" set through the UI, and the next proposal waits.
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '流程', exact: true });
await page.click({
  role: 'radio',
  name: '等我批准',
  exact: true,
  within: { role: 'group', name: '计划改动', exact: true },
});
const policy1 = await poll(async () => {
  const p = await query('workflow.policy', { project_id });
  return p.plan_changes === 'confirm' && p;
});
check('对照组：界面选"等我批准"后 workflow.policy 是 confirm', policy1, policy1?.plan_changes);
const CONFIRM = `task-wait-${stamp}`.slice(0, 40);
await proposeAdd(CONFIRM, 'Waiting task');
const waiting = await poll(async () => {
  const v = await view();
  return pendingOf(v, CONFIRM) && v;
}, 30_000);
check(
  '对照组：提议在 board.view 待定',
  waiting,
  waiting && leadOf(waiting)?.pending_proposals?.length,
);
check('对照组：计划还没有这个任务', waiting && !hasTask(waiting, CONFIRM));
const confirmNeeds = await poll(async () => {
  const items = await needsProposal();
  return items.length ? items : null;
});
check(
  '对照组：needs_you.list 有 board.plan.proposal',
  confirmNeeds?.length === 1,
  confirmNeeds?.map((i) => i.request_id),
);
await reset();
await page.click({ role: 'button', name: '项目看板', exact: true });
await page.click({ role: 'radio', name: '总览', exact: true });
const confirmCards = await poll(async () => ((await cards()) > 0 ? await cards() : null));
check('对照组：看板"总览"页的需要你有一条提议行', confirmCards === 1, confirmCards);
result.shot = await page.screenshot(result.id);

await restore();
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
