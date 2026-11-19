import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 150_000,
});
const result = { id: 'insights-memory.learned-inbox', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the page commits from now on, at every DOM change; `state` is a page
// expression. A window on a background display gets no animation frames, so this does not use them.
const watch = (state) =>
  page.evaluate(`(() => {
    window.__verifyWatch?.disconnect();
    const seen = (window.__verifyStates = []);
    const take = () => {
      const now = (() => ${state})();
      if (seen.at(-1) !== now) seen.push(now);
    };
    take();
    const observer = (window.__verifyWatch = new MutationObserver(take));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => observer.disconnect(), 6000);
    return true;
  })()`);
const states = () => page.evaluate('window.__verifyStates ?? []');

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-learned-inbox-${stamp}`, {
    'README.md': '# learned inbox\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "learned-inbox-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  await call('workflow.policy.set', { project_id, improvement_mode: 'confirm' });
  const policy = await query('workflow.policy', { project_id });
  // A session that put up a plan is a lead, which may propose changes.
  const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
  const LEAD = `Lead learned ${stamp}`;
  const plan = {
    base_version: 0,
    headline: `Learned inbox ${stamp}`,
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
  const propose = (change) => ({
    tool: { name: 'propose_improvement', arguments: { evidence, change } },
  });
  const KEEP = `Run the docs linter before handing back ${stamp}`;
  const DROP = `Write the migration test first ${stamp}`;
  // max_parallel may not go above max_parallel_limit.
  const TO = policy.max_parallel > 1 ? policy.max_parallel - 1 : 2;
  result.policy = { max_parallel: policy.max_parallel, limit: policy.max_parallel_limit };
  result.turns = [];
  for (const change of [
    { type: 'policy_change', param: 'max_parallel', to: TO },
    { type: 'experience', domain: 'docs-chore', procedure: KEEP },
    { type: 'experience', domain: 'backend-logic', procedure: DROP },
  ])
    result.turns.push((await send([propose(change)]))?.last_turn?.state ?? null);
  const improvements = () => query('improvement.list', { project_id });
  const all = await poll(async () => {
    const list = await improvements();
    return list.length >= 3 && list;
  }, 20_000);
  result.proposed = (all || []).map((i) => [
    i.status,
    i.change.type,
    i.change.procedure ?? i.change.param,
  ]);
  const policyItem = all?.find?.((i) => i.change.type === 'policy_change');
  const keep = all?.find?.((i) => i.change.procedure === KEEP);
  const drop = all?.find?.((i) => i.change.procedure === DROP);
  check('前置：三条候选都在 improvement.list', policyItem && keep && drop, result.proposed);
  if (!policyItem || !keep || !drop)
    throw new Error('No proposals to verify; see the checks above');
  // One on trial, one reverted, one left for the user.
  await call('improvement.decide', {
    project_id,
    improvement_id: policyItem.id,
    decision: 'confirm',
  });
  await call('improvement.decide', { project_id, improvement_id: drop.id, decision: 'confirm' });
  await call('improvement.decide', { project_id, improvement_id: drop.id, decision: 'revert' });
  const statusOf = async (id) => (await improvements()).find((i) => i.id === id)?.status;
  const learned = await query('learned.list', { project_id });
  result.learned = learned.map((i) => ({
    id: i.id,
    group: i.group,
    kind: i.kind,
    verdict: i.verdict,
    n: i.n,
    tasks_required: i.tasks_required,
    actions: i.actions,
  }));
  check(
    '前置：learned.list 分组是 needs_you / on_trial / reverted',
    learned.find((i) => i.id === keep.id)?.group === 'needs_you' &&
      learned.find((i) => i.id === policyItem.id)?.group === 'on_trial' &&
      learned.find((i) => i.id === drop.id)?.group === 'reverted',
    result.learned,
  );

  // 1. Memory > Learned.
  const LIST = '经验列表';
  const listState = `(() => {
    const s = [...document.querySelectorAll('section')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(LIST)});
    if (!s) return 'none';
    if (s.getAttribute('aria-busy') === 'true') return 'loading';
    return [...s.querySelectorAll('[role=listbox]')].map((g) => g.getAttribute('aria-label') + ':' + g.querySelectorAll('[role=option]').length).join('|');
  })()`;
  await page.click({ role: 'button', name: '记忆', exact: true });
  await watch(listState);
  // The tab's name carries the count of changes that need you.
  await page.click({ role: 'tab', name: '经验', exact: false });
  const read = () =>
    page.evaluate(`(() => {
      const s = [...document.querySelectorAll('section')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(LIST)});
      if (!s || s.getAttribute('aria-busy') === 'true') return null;
      const groups = {};
      for (const g of s.querySelectorAll('[role=listbox]')) groups[g.getAttribute('aria-label')] = [...g.querySelectorAll('[role=option]')].map((o) => ({ name: o.getAttribute('aria-label'), text: o.innerText.replace(/\\s+/g, ' '), selected: o.getAttribute('aria-selected') }));
      const fold = s.querySelector('button[aria-expanded]');
      return { groups, fold: fold && { text: fold.innerText.replace(/\\s+/g, ' '), expanded: fold.getAttribute('aria-expanded') } };
    })()`);
  const list = await poll(async () => {
    const r = await read();
    return r?.groups['需要你'] && r?.groups['试用中'] && r;
  });
  result.list = list;
  check('有区域 "经验列表"', list, await names('经验'));
  const trialRow = list?.groups['试用中']?.find((o) => o.name.includes('流程参数'));
  check(
    '需要你 一组有这条 experience',
    list?.groups['需要你']?.some((o) => o.name.includes(KEEP)),
    list?.groups['需要你'],
  );
  check('试用中 一组有这条 policy_change', trialRow, list?.groups['试用中']);
  const trialItem = learned.find((i) => i.id === policyItem.id);
  check(
    '试用中的行写 "证据不够" 和 n / tasks_required 个任务(等于 learned.list)',
    trialRow?.text.includes('证据不够') &&
      trialRow.text.includes(`${trialItem.n ?? 0} / ${trialItem.tasks_required} 个任务`),
    { row: trialRow?.text, n: trialItem.n, required: trialItem.tasks_required },
  );
  check(
    '已撤回 折叠：有折叠按钮 "已撤回 1"，aria-expanded=false，组不展开',
    list?.fold?.text.includes('已撤回') && list.fold.expanded === 'false' && !list.groups['已撤回'],
    list?.fold,
  );
  check(
    '对照组：需要你 一组里没有已撤回的那条',
    !list?.groups['需要你']?.some((o) => o.name.includes(DROP)),
  );
  const firstStates = await states();
  result.first_open_states = firstStates;
  const drawn = firstStates.filter((s) => s !== 'none' && s !== 'loading');
  check('首次打开不闪：列表落定前没画出别的分组', new Set(drawn).size <= 1, firstStates);

  // The locator gives <section> no implicit role, so the list is found by its name alone.
  await page.click({
    role: 'button',
    name: '已撤回',
    exact: false,
    within: { name: LIST, exact: true },
  });
  const opened = await poll(async () => (await read())?.groups['已撤回']);
  check(
    '点开 已撤回 后出现这条',
    opened?.some((o) => o.name.includes(DROP)),
    opened,
  );

  // 2. The trial's details: Revert is there.
  await page.click({
    role: 'option',
    name: '流程参数',
    exact: false,
    within: { role: 'listbox', name: '试用中', exact: true },
  });
  const DETAIL = { name: '经验详情', exact: true };
  const detailButtons = () =>
    page.evaluate(`(() => {
      const a = document.querySelector('aside[aria-label="经验详情"]');
      return a ? [...a.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()) : null;
    })()`);
  const trialButtons = await poll(
    async () => (await detailButtons())?.includes('撤回') && (await detailButtons()),
  );
  check('试用中详情有 "撤回"', trialButtons, await detailButtons());

  // 3. The candidate: Confirm and Reject; confirm it.
  await page.click({
    role: 'option',
    name: KEEP,
    exact: false,
    within: { role: 'listbox', name: '需要你', exact: true },
  });
  const candButtons = await poll(async () => {
    const b = await detailButtons();
    return b?.includes('确认') && b.includes('拒绝') && b;
  });
  check('候选详情有 "确认" 和 "拒绝"', candButtons, await detailButtons());
  result.shot = await page.screenshot(result.id);
  await page.click({ role: 'button', name: '确认', exact: true, within: DETAIL });
  const confirmed = await poll(async () => (await statusOf(keep.id)) === 'trial');
  check(
    '点 "确认" 后 improvement.list 里它是 trial(experience 先试用)',
    confirmed,
    await statusOf(keep.id),
  );
  const moved = await poll(async () => {
    const r = await read();
    return r?.groups['试用中']?.some((o) => o.name.includes(KEEP)) && !r.groups['需要你'] && r;
  });
  check('确认后它从 需要你 移到 试用中', moved, (await read())?.groups);

  // 4. Revert the policy trial from its details.
  await page.click({
    role: 'option',
    name: '流程参数',
    exact: false,
    within: { role: 'listbox', name: '试用中', exact: true },
  });
  await poll(async () => (await detailButtons())?.includes('撤回'));
  await page.click({ role: 'button', name: '撤回', exact: true, within: DETAIL });
  const reverted = await poll(async () => (await statusOf(policyItem.id)) === 'reverted');
  check('点 "撤回" 后 policy_change 是 reverted', reverted, await statusOf(policyItem.id));
  const after = await query('workflow.policy', { project_id });
  check('对照：撤回后 max_parallel 回到原值', after.max_parallel === policy.max_parallel, {
    before: policy.max_parallel,
    after: after.max_parallel,
  });
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
