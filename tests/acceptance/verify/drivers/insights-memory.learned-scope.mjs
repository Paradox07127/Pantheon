import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'insights-memory.learned-scope', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

try {
  const stamp = Date.now();
  const { project_id, repo } = await newProject(`verify-learned-scope-${stamp}`, {
    'README.md': '# learned scope\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "learned-scope-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const root = (await board()).projects.find((p) => p.id === project_id).roots?.[0] ?? repo;
  await call('workflow.policy.set', { project_id, improvement_mode: 'confirm' });
  // A session that put up a plan is a lead, which may propose changes.
  const LEAD = `Lead scope ${stamp}`;
  const plan = {
    base_version: 0,
    headline: `Learned scope ${stamp}`,
    lanes: [{ id: 'main', title: `Main ${stamp}` }],
    tasks: [
      {
        id: 'one',
        title: `Task one ${stamp}`,
        goal: 'Do one.',
        lane: 'main',
        depends_on: [],
        source: ['The user asked for it.'],
        scope: ['src/one.ts'],
        acceptance: ['true'],
        kind: { domain: 'backend-logic', tier: 't1' },
      },
    ],
    milestones: [],
    risks: [],
    assumptions: [],
  };
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `${LEAD}\n${script({ tool: { name: 'update_board', arguments: plan } })}`,
  });
  const OTHER = `Other ${stamp}`;
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `${OTHER}\n${script({ say: 'ok' })}`,
  });
  const sessionOf = async (title) =>
    (await query('session.list', { project_id })).find((s) => s.title === title);
  const idle = () =>
    poll(async () => {
      const s = await sessionOf(LEAD);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const lead = await idle();
  const other = await poll(() => sessionOf(OTHER));
  const evidence = [
    { kind: 'session', id: lead.id },
    { kind: 'session', id: other.id },
  ];
  const send = async (steps) => {
    const ready = await idle();
    await call(
      'session.send',
      { session_id: ready.id, input: script(...steps) },
      (await board()).sessions.find((s) => s.id === ready.id)?.revision ?? ready.revision,
    );
    return idle();
  };
  const REJECT = `Rename the helpers first ${stamp}`;
  const REVERT = `Write the migration test first ${stamp}`;
  for (const change of [
    {
      type: 'gate_command',
      root,
      to: [{ name: `Lint ${stamp}`, argv: [process.execPath, '-e', 'process.exit(0)'] }],
    },
    { type: 'policy_change', param: 'path', tier: 't2', to: 'review_loop' },
    { type: 'experience', domain: 'docs-chore', procedure: REJECT },
    { type: 'experience', domain: 'backend-logic', procedure: REVERT },
  ])
    await send([{ tool: { name: 'propose_improvement', arguments: { evidence, change } } }]);
  const improvements = () => query('improvement.list', { project_id });
  const all =
    (await poll(async () => {
      const list = await improvements();
      return list.length >= 4 && list;
    }, 20_000)) || [];
  const gateItem = all.find((i) => i.change.type === 'gate_command');
  const pathItem = all.find((i) => i.change.type === 'policy_change');
  const rejectItem = all.find((i) => i.change.procedure === REJECT);
  const revertItem = all.find((i) => i.change.procedure === REVERT);
  check(
    '前置：四条候选都在 improvement.list',
    gateItem && pathItem && rejectItem && revertItem,
    all.map((i) => [i.status, i.change.type]),
  );
  await call('improvement.decide', {
    project_id,
    improvement_id: rejectItem.id,
    decision: 'reject',
    reject_reason: 'not_useful',
  });
  await call('improvement.decide', {
    project_id,
    improvement_id: revertItem.id,
    decision: 'confirm',
  });
  await call('improvement.decide', {
    project_id,
    improvement_id: revertItem.id,
    decision: 'revert',
  });
  const learned = await query('learned.list', { project_id });
  const of = (id) => learned.find((i) => i.id === id);
  result.learned = learned.map((i) => ({
    id: i.id,
    kind: i.kind,
    status: i.status,
    group: i.group,
    scope: i.scope,
  }));
  check(
    '前置：learned.list 的 scope：门禁命令 {root}，path 策略 {tier:t2}',
    of(gateItem.id)?.scope?.root === root && of(pathItem.id)?.scope?.tier === 't2',
    result.learned,
  );
  check(
    '前置：被拒绝的 status rejected，撤回的 status reverted',
    of(rejectItem.id)?.status === 'rejected' && of(revertItem.id)?.status === 'reverted',
    result.learned,
  );

  // Memory > Learned; each row is an option named by its title.
  await page.click({ role: 'button', name: '记忆', exact: true });
  await page.click({ role: 'tab', name: '经验', exact: false });
  const detail = () =>
    page.evaluate(`(() => {
      const d = [...document.querySelectorAll('aside')].find((el) => el.getAttribute('aria-label') === '经验详情' && el.getClientRects().length);
      if (!d) return null;
      const all = [...d.querySelectorAll('*')];
      const scope = [...d.querySelectorAll('[role=group]')].find((g) => g.getAttribute('aria-label') === '适用范围');
      const diff = [...d.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label').startsWith('改动，'));
      return {
        head: d.innerText.split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 3),
        scope: scope ? scope.innerText.replace(/\\s+/g, ' ').trim() : null,
        scopeAboveDiff: !!scope && !!diff && all.indexOf(scope) < all.indexOf(diff),
        diff: diff?.getAttribute('aria-label') ?? null,
      };
    })()`);
  const openRow = async (title) => {
    await page.click({ role: 'option', name: title, exact: false });
    return poll(async () => {
      const d = await detail();
      return d && d;
    }, 5000);
  };
  // A gate change's row is named by its first command.
  const g = await openRow(`Lint ${stamp}，门禁命令`);
  result.gate_detail = g;
  check(
    '门禁命令改动：diff 上方有 "适用范围" 一行，值为 "目录 <root>"(learned.list scope.root)',
    g?.scope === `目录 ${root}` && g.scopeAboveDiff,
    { ui: g, root },
  );
  const p = await openRow('，流程参数');
  result.path_detail = p;
  check(
    'path 策略改动：diff 上方有 "适用范围" 一行，值为 "级别 T2"(learned.list scope.tier t2)',
    p?.scope === '级别 T2' && p.scopeAboveDiff,
    p,
  );
  check('对照组：path 策略的适用范围不是 "级别 T1"', p?.scope !== '级别 T1', p?.scope);
  // Rejected and reverted ones sit under the closed fold.
  const fold = await page.evaluate(
    `[...document.querySelectorAll('button[aria-expanded]')].find((b) => b.innerText.includes('已撤回'))?.getAttribute('aria-expanded') ?? null`,
  );
  if (fold === 'false') await page.click({ role: 'button', name: '已撤回', exact: false });
  const rejectTitle = of(rejectItem.id).title;
  const revertTitle = of(revertItem.id).title;
  const rj = await openRow(rejectTitle);
  result.reject_detail = rj;
  check('被拒绝的改动：详情抬头是 "已拒绝"', rj?.head?.[0] === '已拒绝', rj?.head);
  const rv = await openRow(revertTitle);
  result.revert_detail = rv;
  check('撤回的改动：详情抬头是 "已撤回"', rv?.head?.[0] === '已撤回', rv?.head);
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
