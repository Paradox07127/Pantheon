import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 200_000,
});
const result = { id: 'board.plan-pause', checks: [] };
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
    setTimeout(() => observer.disconnect(), 6000);
    return true;
  })()`);
const states = () => page.evaluate('window.__verifyStates ?? []');

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-plan-pause-${stamp}`, {
    'README.md': '# pause\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "plan-pause-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
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
  const T1 = `Held task ${stamp}`;
  const T2 = `Idle task ${stamp}`;
  await send([
    {
      tool: {
        name: 'update_board',
        arguments: {
          base_version: 0,
          headline: `Pause ${stamp}`,
          lanes: [{ id: 'lane-a', title: 'Lane A' }],
          tasks: [task('task-one', T1), task('task-two', T2)],
          milestones: [
            {
              id: 'milestone-a',
              title: 'Milestone A',
              criteria: ['Both tasks merge.'],
              tasks: ['task-one', 'task-two'],
            },
          ],
          risks: [],
          assumptions: [],
        },
      },
    },
  ]);
  const planOf = async () =>
    (await query('project.read', { project_id })).plans.find(
      (p) => p.lead_session_id === assistant,
    );
  check(
    '前置：plan 已写好、未暂停',
    (await planOf())?.tasks?.length === 2 && !(await planOf()).paused,
  );

  // 1. The board's bar: Pause plan.
  const barJs = `(() => {
    const b = [...document.querySelectorAll('button')].find((x) => ['暂停计划', '继续计划'].includes(x.getAttribute('aria-label')) && x.getClientRects().length);
    return {
      button: b?.getAttribute('aria-label') ?? null,
      busy: b?.getAttribute('aria-busy') ?? null,
      version: document.querySelector('.gm-pv')?.textContent ?? null,
      reassessing: document.body.innerText.includes('lead 正在重估'),
    };
  })()`;
  await watch(`(() => { const b = ${barJs}; return b.button + '|' + b.version; })()`);
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '总览', exact: true });
  const bar0 = await poll(async () => {
    const b = await page.evaluate(barJs);
    return b.button && b;
  });
  check('看板顶栏有 "暂停计划" 按钮', bar0?.button === '暂停计划', bar0);
  await page.click({ role: 'button', name: '暂停计划', exact: true });
  const paused = await poll(async () => (await planOf())?.paused);
  check('点 "暂停计划" 后 project.read 的计划 paused 有值', paused?.at > 0, paused);
  result.paused_at_ms = Date.now();
  const bar1 = await poll(async () => {
    const b = await page.evaluate(barJs);
    return b.button === '继续计划' && b;
  });
  check('顶栏按钮变成 "继续计划"', bar1, await page.evaluate(barJs));
  check(
    '顶栏写 "计划 v{n}，暂停于 …"，版本等于 project.read 的 plan_version',
    bar1?.version?.startsWith(`计划 v${(await planOf()).plan_version}，暂停于 `),
    bar1?.version,
  );
  check('lead 还没重估时顶栏显示 "lead 正在重估"', bar1?.reassessing, bar1);

  // A held task: started while the plan is paused.
  await idle();
  await call('task.start', { project_id, lead_session_id: assistant, task_ids: ['task-one'] });
  const held = await poll(async () => {
    const t = (await planOf())?.tasks.find((x) => x.id === 'task-one');
    return t?.dispatch_wait === 'paused' && t;
  });
  check('前置：暂停时开始的任务 dispatch_wait=paused', held, (await planOf())?.tasks);

  // 2. The lead's reassessment: a Plan paused card with Resume.
  const DONE = `Nothing merged yet ${stamp}`;
  await send([
    {
      tool: {
        name: 'reassess',
        arguments: { done: DONE, blocked: 'nothing', change: 'Split task one.' },
      },
    },
  ]);
  const reassessed = await poll(async () => (await planOf())?.reassessment?.done === DONE);
  check('前置：project.read 的计划有 reassessment', reassessed, (await planOf())?.reassessment);
  const cardJs = `(() => {
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length);
    const art = [...(s?.querySelectorAll('article') ?? [])].find((a) => (a.getAttribute('aria-label') ?? '').startsWith('计划已暂停：'));
    if (!art) return null;
    return {
      label: art.getAttribute('aria-label'),
      kind: art.querySelector('.rq-kind')?.textContent ?? null,
      text: art.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400),
      buttons: [...art.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label') })),
    };
  })()`;
  const card = await poll(() => page.evaluate(cardJs));
  result.card = card;
  check(
    '"需要你" 里出现 "计划已暂停：{计划}" 卡，种类 "计划已暂停"',
    card?.kind === '计划已暂停',
    card,
  );
  check(
    '卡上有 "继续" 按钮',
    card?.buttons.some((b) => b.text === '继续'),
    card?.buttons,
  );
  check(
    '卡上能读到 lead 的重估内容',
    card?.text.includes(DONE) ||
      (await page.evaluate(`document.body.innerText.includes(${JSON.stringify(DONE)})`)),
    card?.text,
  );
  const bar2 = await page.evaluate(barJs);
  check('重估写好后顶栏不再显示 "lead 正在重估"', bar2.reassessing === false, bar2);
  const items = (await query('needs_you.list', { project_id })).items;
  check(
    '后端对照：needs_you.list 有 board.plan.reassessment',
    items.some((i) => i.kind === 'board.plan.reassessment'),
    items.map((i) => i.kind),
  );
  result.shot = await page.screenshot(result.id);

  // 3. Tasks > List: the held row says Paused.
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '列表', exact: true });
  const rowsJs = `(() => {
    const table = document.querySelector('[role=table][aria-label="任务列表"]');
    if (!table) return null;
    return [...table.querySelectorAll('[role=row]')].map((r) => r.getAttribute('aria-label')).filter(Boolean);
  })()`;
  const rows = await poll(async () => {
    const r = await page.evaluate(rowsJs);
    return r?.some((x) => x.startsWith(T1)) && r;
  });
  result.rows = rows || (await page.evaluate(rowsJs));
  check('列表里被挡的行名 "{任务}，已暂停"', rows?.includes(`${T1}，已暂停`), result.rows);
  check(
    '对照组：没开始的任务不显示已暂停',
    rows && !rows.includes(`${T2}，已暂停`) && rows.some((x) => x.startsWith(T2)),
    rows,
  );

  // 4. Resume from the bar.
  result.resume_after_pause_ms = Date.now() - result.paused_at_ms;
  await page.click({ role: 'button', name: '继续计划', exact: true });
  const resumed = await poll(async () => {
    const p = await planOf();
    return p && !p.paused && p;
  });
  check('点 "继续计划" 后 project.read 的计划不再 paused', resumed, (await planOf())?.paused);
  const bar3 = await poll(async () => {
    const b = await page.evaluate(barJs);
    return b.button === '暂停计划' && b;
  });
  check('顶栏按钮变回 "暂停计划"', bar3, await page.evaluate(barJs));
  const rowsAfter = await poll(async () => {
    const r = await page.evaluate(rowsJs);
    return r && !r.includes(`${T1}，已暂停`) && r;
  });
  check('继续后该行不再是 "已暂停"', rowsAfter, rowsAfter);
  const gone = await poll(
    async () =>
      !(await query('needs_you.list', { project_id })).items.some(
        (i) => i.kind === 'board.plan.reassessment',
      ),
  );
  check('继续后 needs_you.list 没有 reassessment 卡', gone);
  result.first_open_states = await states();
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
