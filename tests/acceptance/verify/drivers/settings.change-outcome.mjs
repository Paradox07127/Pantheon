import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, reset, newProject } = await open(process.argv[2], {
  ms: 200_000,
});
const result = { id: 'settings.change-outcome', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the page commits from now on, at every DOM change; `state` is a page
// expression. A window on a background display gets no animation frames, so this does not use them.
const watch = (state) =>
  page.evaluate(`(() => {
    window.__verifyWatch?.disconnect();
    const seen = (window.__verifyStates = []);
    const t0 = Date.now();
    let last;
    const take = () => {
      const now = (() => ${state})();
      if (last !== now) seen.push(now + ' @' + (Date.now() - t0) + 'ms');
      last = now;
    };
    take();
    const observer = (window.__verifyWatch = new MutationObserver(take));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => observer.disconnect(), 4000);
    return true;
  })()`);
const states = () => page.evaluate('window.__verifyStates ?? []');

// The page every project follows; put the user's value back at the end.
const globalOf = async () =>
  (await query('project.defaults')).settings.find((s) => s.key === 'workflow_policy')?.global;
const saved = await globalOf();
const restore = async () => {
  if (saved) await call('project.defaults.set', { key: 'workflow_policy', value: saved });
  else await call('project.defaults.clear', { key: 'workflow_policy' });
};

// One "Did it help?" block as drawn: its name, verdict, count meter and rows.
const cardJs = (root) => `(() => {
  const c = ${root};
  if (!c) return null;
  return {
    tag: c.tagName.toLowerCase(),
    role: c.getAttribute('role'),
    label: c.getAttribute('aria-label'),
    busy: c.getAttribute('aria-busy'),
    title: c.querySelector('.co-t')?.textContent ?? null,
    verdict: c.querySelector('.co-v')?.textContent ?? null,
    meter: c.querySelector('[role=img].meter')?.getAttribute('aria-label') ?? null,
    count: c.querySelector('.co-c .co-n, .co-l .co-n, .co-h > .co-n')?.textContent ?? null,
    rows: [...c.querySelectorAll('[role=rowheader]')].map((r) => r.textContent),
  };
})()`;

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-change-outcome-${stamp}`, {
    'README.md': '# outcome\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "change-outcome-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const outcomes = () => query('change.outcomes', { project_id });
  const policyOutcome = async () =>
    (await outcomes()).find((o) => o.kind === 'policy_changed' && o.param === 'max_parallel');

  // 1. Settings > Workflow: no block before a change.
  const PARAM = '并发上限';
  const REGION = `有没有用？${PARAM}`;
  const rowJs = `(() => {
    const row = document.querySelector('[role=group][aria-label=${JSON.stringify(PARAM)}]');
    if (!row) return null;
    const next = row.nextElementSibling;
    return {
      value: row.querySelector('input')?.value ?? null,
      nextLabel: next?.getAttribute('aria-label') ?? null,
      nextTag: next?.tagName.toLowerCase() ?? null,
    };
  })()`;
  const regionRoot = `document.querySelector('section[aria-label=${JSON.stringify(REGION)}]')`;
  await watch(`(() => { const r = ${rowJs}; return r ? r.value + '|' + r.nextLabel : 'none'; })()`);
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '流程', exact: true });
  const row0 = await poll(async () => {
    const r = await page.evaluate(rowJs);
    return r?.value && r;
  });
  result.row_before = row0;
  const before = await policyOutcome();
  check('前置：change.outcomes 还没有 max_parallel 的改动', !before, before);
  check(`改之前 "${PARAM}" 行下面没有 "${REGION}"`, row0 && row0.nextLabel !== REGION, row0);
  result.first_open_states = await states();
  const was = (await query('workflow.policy', { project_id })).max_parallel;

  // 2. One step down; the built-in value is at its cap, so up is disabled.
  await page.click({ role: 'button', name: `${PARAM} 减一`, exact: true });
  const changed = await poll(async () => {
    const p = await query('workflow.policy', { project_id });
    return p.max_parallel === was - 1 && p;
  });
  check(`点 "${PARAM} 减一" 后 workflow.policy 的 max_parallel 减一`, changed, {
    was,
    now: changed?.max_parallel,
  });
  const globalOutcome = await poll(policyOutcome, 5000);
  const globalRow = await page.evaluate(rowJs);
  result.after_global_change = { outcome: globalOutcome ?? null, row: globalRow };
  // Only a project's own change is counted, so the global one draws no block.
  check(`改这一页(全局值)后 "${PARAM}" 行下面不出现 "${REGION}"`, globalRow?.nextLabel !== REGION, {
    row: globalRow,
    change_outcomes: globalOutcome ?? null,
  });
  await restore();

  // The project's own value, set from the row's project dialog.
  await page.click({
    role: 'button',
    // "自行设置并发上限的项目", or "{n} 个项目自行设置了并发上限" once an earlier run set one.
    name: '项目',
    exact: false,
    within: { role: 'group', name: PARAM, exact: true },
  });
  await page.click({ role: 'combobox', name: '项目', exact: true });
  // The list holds every project the earlier drivers opened; the new one is at its end.
  const pick = await poll(() =>
    page.evaluate(`(() => {
      const l = document.querySelector('[role=listbox]');
      const opts = [...document.querySelectorAll('[role=option]')];
      const to = opts.findIndex((el) => el.textContent.trim() === ${JSON.stringify(`verify-change-outcome-${stamp}`)});
      if (!l || to < 0) return null;
      const r = l.getBoundingClientRect();
      return {
        to,
        from: opts.findIndex((el) => el.getAttribute('aria-selected') === 'true'),
        count: opts.length,
        list: { top: Math.round(r.top), bottom: Math.round(r.bottom), scroll: l.scrollHeight, overflow: getComputedStyle(l).overflowY },
        last: Math.round(opts.at(-1).getBoundingClientRect().bottom),
        viewport: innerHeight,
      };
    })()`),
  );
  result.select_geometry = pick;
  check(
    '项目下拉列表落在窗口内，或者能在列表里滚动到每一项',
    (pick.list.top >= 0 && pick.last <= pick.viewport) ||
      ['auto', 'scroll'].includes(pick.list.overflow),
    pick,
  );
  // The option sits below the window's bottom edge; the keyboard reaches it as a user's does.
  for (let i = 0; i < Math.abs(pick.to - pick.from); i++)
    await page.press(pick.to > pick.from ? 'ArrowDown' : 'ArrowUp');
  await page.press('Enter');
  await page.click({
    role: 'button',
    name: `${PARAM} 减一`,
    exact: true,
    within: { role: 'group', name: `verify-change-outcome-${stamp} 自行设置的值`, exact: true },
  });
  const own = await poll(async () => {
    const p = await query('workflow.policy', { project_id });
    return p.max_parallel === was - 1 && p;
  });
  check(
    '在项目对话框里减一后，该项目 workflow.policy 的 max_parallel 减一',
    own,
    own?.max_parallel,
  );
  await page.click({ role: 'button', name: '关闭', exact: true });
  const outcome = await poll(policyOutcome);
  result.outcome = outcome;
  check(
    '后端对照：change.outcomes 有 policy_changed max_parallel，n<10，证据不够',
    outcome?.n < outcome?.tasks_required &&
      outcome.tasks_required === 10 &&
      outcome.verdict === 'not_enough_evidence',
    outcome && { n: outcome.n, required: outcome.tasks_required, verdict: outcome.verdict },
  );
  const card = await poll(async () => {
    const c = await page.evaluate(cardJs(regionRoot));
    return c && c.busy === null && c;
  });
  result.card = card;
  const row1 = await page.evaluate(rowJs);
  check(
    `"${PARAM}" 行紧下面是 region "${REGION}"`,
    row1?.nextTag === 'section' && row1.nextLabel === REGION,
    row1,
  );
  check(
    `少于 10 个任务时有 meter "已有 ${outcome?.n} 个，需要 10 个任务"`,
    card?.meter === `已有 ${outcome?.n} 个，需要 10 个任务`,
    card,
  );
  check('meter 旁写 "n / 10 个任务"', card?.count === `${outcome?.n} / 10 个任务`, card?.count);
  check('判定写 "证据不够"', card?.verdict === '证据不够', card?.verdict);
  check(
    '对照组：别的行(并发上限封顶)下面没有 region',
    !(await page.evaluate(
      `!!document.querySelector('section[aria-label="有没有用？并发上限封顶"]')`,
    )),
  );
  result.shot = await page.screenshot(result.id);
  await restore();

  // 3. The agent profile's Did it help? section, after turning on one of its routines.
  await reset();
  const triage = (await query('agent.list', { project_id })).find((a) => a.template === 'triage');
  const SWEEP = `Sweep ${stamp}`;
  await call('agent.update', {
    agent_id: triage.id,
    revision: triage.revision,
    routines: [{ id: 'sweep', prompt: SWEEP, every_minutes: 60, enabled: true }],
  });
  const routineOutcome = await poll(async () =>
    (await outcomes()).find((o) => o.kind === 'routine_enabled' && o.agent_id === triage.id),
  );
  check('前置：change.outcomes 有这个 agent 的 routine_enabled', routineOutcome, routineOutcome);
  const NAME = '问题处理';
  const rowSel = `nav.ss-list [role=group][aria-label="本项目"] .ss-rr[data-stop="resident:${triage.id}"]`;
  await poll(() => page.evaluate(`!!document.querySelector(${JSON.stringify(rowSel)})`));
  const { x, y } = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(rowSel)});
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  const mouse = { x, y, button: 'right', buttons: 2, clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
  const ASIDE = `aside.ag-insp[aria-label=${JSON.stringify(`${NAME}的资料`)}]`;
  const sectionJs = `(() => {
    const a = document.querySelector(${JSON.stringify(ASIDE)});
    if (!a) return null;
    return [...a.querySelectorAll('section')].map((s) => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent ?? '?');
  })()`;
  await watch(`(() => { const s = ${sectionJs}; return s ? s.join('|') : 'none'; })()`);
  await page.click({ role: 'menuitem', name: '资料', exact: true });
  const helpRoot = `(() => {
    const a = document.querySelector(${JSON.stringify(ASIDE)});
    const s = [...(a?.querySelectorAll('section') ?? [])].find((s) => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent === '有没有用？');
    return s?.querySelector('.co') ?? null;
  })()`;
  const help = await poll(async () => {
    const c = await page.evaluate(cardJs(helpRoot));
    return c && c.busy === null && c;
  });
  result.profile_card = help;
  result.profile_sections = await page.evaluate(sectionJs);
  result.profile_open_states = await states();
  check('资料面板有 "有没有用？" 分区', help, result.profile_sections);
  check(
    `分区里的卡名 "开启了 ${SWEEP}"`,
    help?.role === 'group' && help.label === `开启了 ${SWEEP}` && help.title === `开启了 ${SWEEP}`,
    help,
  );
  check(
    `卡上 meter 等于 change.outcomes 的 n："已有 ${routineOutcome?.n} 个，需要 10 个任务"`,
    help?.meter === `已有 ${routineOutcome?.n} 个，需要 10 个任务`,
    help?.meter,
  );
  check('卡上判定 "证据不够"', help?.verdict === '证据不够', help?.verdict);
  result.shot_profile = await page.screenshot(`${result.id}-profile`);
  await page.click({ role: 'button', name: '关闭资料', exact: true });
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
  await restore();
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
