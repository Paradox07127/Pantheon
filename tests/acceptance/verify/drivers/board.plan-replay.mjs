import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 200_000,
});
const result = { id: 'board.plan-replay', checks: [] };
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

const replayJs = `(() => {
  const btn = [...document.querySelectorAll('button[aria-label="回放"]')].find((b) => b.getClientRects().length);
  const sec = document.querySelector('section[aria-label="计划回放"]');
  const slider = sec?.querySelector('[role=slider]');
  const chart = sec?.querySelector('[role=list].bd-prp-fl');
  const ev = sec?.querySelector('section.bd-prp-ev');
  return {
    button: btn ? { pressed: btn.getAttribute('aria-pressed'), disabled: btn.getAttribute('aria-disabled'), described: btn.getAttribute('aria-describedby') ? document.getElementById(btn.getAttribute('aria-describedby'))?.textContent ?? null : null } : null,
    open: !!sec,
    slider: slider ? { name: slider.getAttribute('aria-label'), now: slider.getAttribute('aria-valuenow'), min: slider.getAttribute('aria-valuemin'), max: slider.getAttribute('aria-valuemax'), text: slider.getAttribute('aria-valuetext'), busy: slider.getAttribute('aria-busy') } : null,
    chart: chart?.getAttribute('aria-label') ?? null,
    nodes: [...(chart?.querySelectorAll('[role=listitem]') ?? [])].map((n) => n.getAttribute('aria-label')),
    events: ev ? { head: ev.querySelector('h2')?.textContent ?? null, n: ev.querySelector('.bd-prp-evn')?.textContent ?? null, rows: [...ev.querySelectorAll('li button')].map((b) => ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), current: b.getAttribute('aria-current') })) } : null,
  };
})()`;
const replay = () => page.evaluate(replayJs);

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-plan-replay-${stamp}`, {
    'README.md': '# replay\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "plan-replay-fixture", "private": true }\n',
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
  const plan = (base_version, tasks) => ({
    base_version,
    headline: `Replay ${stamp}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks,
    milestones: [
      {
        id: 'milestone-a',
        title: 'Milestone A',
        criteria: ['The tasks merge.'],
        tasks: tasks.map((t) => t.id),
      },
    ],
    risks: [],
    assumptions: [],
  });
  const T1 = `First ${stamp}`;
  const T2 = `Second ${stamp}`;
  const T3 = `Third ${stamp}`;
  const version = async () =>
    (await query('board.view', { project_id, days: '7' })).leads?.find(
      (l) => l.session_id === assistant,
    )?.plan_version;
  // Events: plan v1 (two tasks), the first dispatched, plan v2 (a third task).
  await send([
    {
      tool: {
        name: 'update_board',
        arguments: plan(0, [task('task-one', T1), task('task-two', T2, ['task-one'])]),
      },
    },
  ]);
  await call('task.start', { project_id, lead_session_id: assistant, task_ids: ['task-one'] });
  await poll(
    async () =>
      (await query('session.list', { project_id })).find((s) => s.task?.id === 'task-one'),
    30_000,
  );
  await send([
    {
      tool: {
        name: 'update_board',
        arguments: plan(await version(), [
          task('task-one', T1),
          task('task-two', T2, ['task-one']),
          task('task-three', T3),
        ]),
      },
    },
  ]);
  const daemon = await poll(async () => {
    const r = await query('board.plan.replay', { lead_session_id: assistant });
    return r.frames?.filter((f) => f.kind === 'board.plan_updated').length >= 2 && r;
  }, 20_000);
  result.daemon_frames = daemon?.frames?.map((f) => `${f.kind}:${f.tasks.length}`);
  check(
    '前置：board.plan.replay 有两次计划更新和一次派发',
    daemon?.frames?.some((f) => f.kind === 'task.dispatched'),
    result.daemon_frames,
  );
  const total = daemon?.total ?? daemon?.frames?.length;

  // 1. Tasks > Timeline > Replay.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '时间线', exact: true });
  const bar0 = await poll(async () => (await replay()).button);
  check('任务 → 时间线 顶栏有 "回放" 按钮，可用', bar0 && !bar0.disabled, bar0);
  await watch(
    `(() => { const r = ${replayJs}; return [r.open, r.slider?.now, r.chart, r.events?.rows.length].join('|'); })()`,
  );
  await page.click({ role: 'button', name: '回放', exact: true });
  const r0 = await poll(async () => {
    const r = await replay();
    return r.open && r.chart && r.slider?.busy === null && r;
  });
  result.at_open = r0;
  check('点后按钮 aria-pressed=true，出现 "计划回放" 区', r0?.button?.pressed === 'true', r0);
  check(
    '滑块名 "计划时间"，停在最新事件，最大值等于事件总数',
    r0?.slider?.name === '计划时间' &&
      r0.slider.now === String(total) &&
      r0.slider.max === String(total),
    { ui: r0?.slider, daemon: total },
  );
  check(
    '最新事件时流程图 3 个任务，节点名 "{任务}，{状态}"',
    r0?.nodes?.length === 3 &&
      r0.nodes.includes(`${T1}，已派发`) &&
      r0.nodes.includes(`${T3}，已计划`),
    r0?.nodes,
  );
  check(
    '"此时的事件" 区标题和计数等于位置',
    r0?.events?.head === '此时的事件' && r0.events.n === String(total),
    r0?.events,
  );
  check(
    '此时的事件 行数等于位置(≤10)，第一行是当前',
    r0?.events?.rows.length === Math.min(10, total) && r0.events.rows[0]?.current === 'true',
    r0?.events?.rows,
  );
  result.first_open_states = await states();
  result.shot = await page.screenshot(result.id);

  // 2. Arrow keys step back one event at a time.
  await page.evaluate(
    `document.querySelector('section[aria-label="计划回放"] [role=slider]').focus()`,
  );
  await page.press('ArrowLeft');
  const r1 = await poll(async () => {
    const r = await replay();
    return r.slider?.now === String(total - 1) && r;
  });
  result.after_left = r1;
  check('按 ← 后 aria-valuenow 减一', r1, (await replay()).slider);
  check(
    '按 ← 后 "此时的事件" 少一行，计数减一',
    r1 && r1.events.n === String(total - 1) && r1.events.rows.length === Math.min(10, total - 1),
    r1?.events,
  );
  check(
    '按 ← 回到派发那一刻：流程图只剩 2 个任务，没有第三个',
    r1 && r1.nodes.length === 2 && !r1.nodes.some((n) => n.startsWith(T3)),
    r1?.nodes,
  );
  check('对照组：按 ← 后图的名字变了', r1 && r1.chart !== r0?.chart, {
    before: r0?.chart,
    after: r1?.chart,
  });
  // page.press knows no Home key.
  for (const type of ['rawKeyDown', 'keyUp'])
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36,
    });
  const rHome = await poll(async () => {
    const r = await replay();
    return r.slider?.now === r.slider?.min && r;
  });
  check(
    '按 Home 到第一个事件：两个任务都是 "已计划"',
    rHome?.nodes?.length === 2 && rHome.nodes.every((n) => n.endsWith('，已计划')),
    rHome?.nodes,
  );
  await page.press('ArrowRight');
  const rRight = await poll(async () => {
    const r = await replay();
    return r.slider?.now === String(Number(rHome?.slider?.min) + 1) && r;
  });
  check('按 → 前进一个事件', rRight, (await replay()).slider);

  // 3. Dragging: press at the right end of the track moves to the newest event.
  const box = await page.evaluate(`(() => {
    const s = document.querySelector('section[aria-label="计划回放"] [role=slider]');
    const r = s.getBoundingClientRect();
    return { left: r.left, right: r.right, y: r.top + r.height / 2 };
  })()`);
  const press = (x) => ({ x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.left + 2, y: box.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press(box.left + 2) });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...press(box.right - 1),
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...press(box.right - 1),
    buttons: 0,
  });
  const rDrag = await poll(async () => {
    const r = await replay();
    return r.slider?.now === String(total) && r;
  });
  check(
    '从左端拖到右端后回到最新事件，图回到 3 个任务',
    rDrag?.nodes?.length === 3,
    (await replay()).slider,
  );

  // 4. A project without a lead: Replay is disabled.
  await page.press('Escape');
  const { project_id: bare } = await newProject(`verify-replay-none-${stamp}`, {
    'README.md': '# none\n',
    'src/index.ts': 'export const answer = 1;\n',
    'package.json': '{ "name": "replay-none-fixture", "private": true }\n',
  });
  const leads = (await query('board.view', { project_id: bare, days: '7' })).leads ?? [];
  check('前置：新项目 board.view 没有 lead', leads.length === 0, leads);
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '时间线', exact: true });
  const none = await poll(async () => (await replay()).button);
  result.no_lead = none;
  check(
    '没有 lead 的项目 "回放" aria-disabled=true，说明 "没有可回放的计划"',
    none?.disabled === 'true' && none.described === '没有可回放的计划',
    none,
  );
  // page.click refuses an aria-disabled button; a user's click still lands on it.
  await page.evaluate(
    `[...document.querySelectorAll('button[aria-label="回放"]')].find((b) => b.getClientRects().length).click()`,
  );
  const still = await replay();
  check('点了也不打开回放', !still.open && still.button?.pressed === 'false', still);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
