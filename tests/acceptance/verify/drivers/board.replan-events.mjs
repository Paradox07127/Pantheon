import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 240_000,
});
const result = { id: 'board.replan-events', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the page commits from now on, at every DOM change, with its time;
// `state` is a page expression. A window on a background display gets no animation frames.
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

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-replan-${stamp}`, {
    'README.md': '# replan\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "replan-fixture", "private": true }\n',
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
    milestone: 'milestone-r',
    estimate: 3,
    depends_on: [],
    source: ['The user asked for it.'],
    scope: ['src/index.ts'],
    acceptance: ['pnpm test'],
    kind: { domain: 'backend-logic', tier: 't1' },
    priority: 'normal',
  });
  const MS = `Milestone R ${stamp}`;
  const plan = (base_version, tasks, trigger_event) => ({
    base_version,
    ...(trigger_event ? { trigger_event } : {}),
    headline: `Replan ${stamp}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks,
    milestones: [
      {
        id: 'milestone-r',
        title: MS,
        criteria: ['The tasks merge.'],
        tasks: tasks.map((t) => t.id),
        replan_if: [{ type: 'handbacks', count: 1 }, { type: 'stall' }],
      },
    ],
    risks: [],
    assumptions: [],
  });
  const T1 = `Handed back ${stamp}`;
  await send([{ tool: { name: 'update_board', arguments: plan(0, [task('task-one', T1)]) } }]);
  const version = async () =>
    (await query('board.view', { project_id, days: '7' })).leads?.find(
      (l) => l.session_id === assistant,
    )?.plan_version;
  const history = () => query('board.history', { project_id });

  // 1. The milestone card's conditions before any is met.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '总览', exact: true });
  const COUNT = `${MS} 的 2 个重新规划条件`;
  const trigger0 = await poll(async () =>
    (await names('个重新规划条件')).filter((n) => n.name.includes(MS)),
  );
  check(
    `里程碑卡上有按钮 "${COUNT}"`,
    trigger0?.some?.((n) => n.name === COUNT),
    trigger0,
  );
  await page.click({ role: 'button', name: COUNT, exact: true });
  const popJs = `(() => {
    const p = [...document.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(`${MS} 的重新规划条件`)} && el.getClientRects().length);
    return p ? p.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`;
  const pop0 = await poll(() => page.evaluate(popJs));
  result.popover_before = pop0;
  check(`popover "${MS} 的重新规划条件" 打开，列出两个条件`, pop0, await names('重新规划条件'));
  await page.press('Escape');

  // 2. A hand-back meets the condition; the daemon fires board.replan_triggered.
  await call('task.start', { project_id, lead_session_id: assistant, task_ids: ['task-one'] });
  const taskSession = await poll(
    async () =>
      (await query('session.list', { project_id })).find((s) => s.task?.id === 'task-one'),
    30_000,
  );
  check('前置：task-one 开出了任务会话', taskSession, taskSession?.id);
  await poll(async () => {
    const s = (await query('session.list', { project_id })).find((x) => x.id === taskSession?.id);
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state);
  }, 30_000);
  await call('task.handback', {
    lead_session_id: assistant,
    task_id: 'task-one',
    reason: `Wrong file ${stamp}`,
  });
  const pending = await poll(async () => (await history()).pending_replans ?? [], 30_000);
  result.pending = pending;
  check(
    '后端对照：board.history 有一条 pending_replans(handbacks)',
    pending?.length === 1 && pending[0].type === 'handbacks',
    pending,
  );
  const metLabel = await poll(async () =>
    (await names('前已满足')).find((n) => n.name.includes(MS)),
  );
  check(
    '条件满足后里程碑按钮名变成 "重新规划条件 {wait} 前已满足，… 的 2 个重新规划条件"',
    metLabel?.name?.startsWith('重新规划条件 ') && metLabel.name.endsWith(`，${COUNT}`),
    metLabel,
  );
  const briefMet = await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('.bf-brief-rp')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`,
    ),
  );
  check(
    '总览简报有一行 "条件已满足"',
    briefMet?.some?.((r) => r.includes('条件已满足')),
    briefMet,
  );

  // 3. The lead answers it with a plan update naming the event.
  await idle();
  const T2 = `Split part ${stamp}`;
  await send([
    {
      tool: {
        name: 'update_board',
        arguments: plan(
          await version(),
          [task('task-one', T1), task('task-two', T2)],
          pending?.[0]?.event_id,
        ),
      },
    },
  ]);
  const answered = await poll(async () => {
    const h = await history();
    const d = h.decisions?.filter((x) => x.replan);
    return !h.pending_replans?.length && d?.length && { h, d };
  }, 20_000);
  const replan = answered?.d?.at(-1);
  result.replan = replan;
  check(
    '后端对照：board.history 的 decisions 有一条 replan，trigger 是那个事件，新增 T2',
    replan?.replan.triggers[0]?.event_id === pending?.[0]?.event_id &&
      replan.replan.added.includes(T2),
    replan,
  );

  // 4. Overview's Re-planned row opens the timeline with that row open.
  const rp = await poll(() =>
    page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button.bf-brief-rp')].find((x) => x.innerText.includes('已重新规划'));
      return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null;
    })()`),
  );
  check('总览简报有 "已重新规划" 行(按钮)', rp, rp);
  check(
    '对照组：回答后 "条件已满足" 行没了',
    !(await page.evaluate(
      `[...document.querySelectorAll('.bf-brief-rp')].some((r) => r.innerText.includes('条件已满足'))`,
    )),
  );
  result.shot = await page.screenshot(result.id);
  const at = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button.bf-brief-rp')].find((x) => x.innerText.includes('已重新规划'));
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const m = { x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 };
  const timelineJs = `(() => {
    const radio = (n) => [...document.querySelectorAll('[role=radio]')].find((r) => (r.getAttribute('aria-label') ?? r.textContent.trim()) === n)?.getAttribute('aria-checked');
    const sec = document.querySelector('section[aria-label="重新规划"]');
    const row = document.getElementById(${JSON.stringify(`bd-hs-rp-${replan?.at}`)});
    return {
      tasks: radio('任务'),
      timeline: radio('时间线'),
      section: !!sec,
      count: sec?.querySelector('.bd-hs-rph .bd-hs-sn')?.textContent ?? null,
      rowOpen: row?.querySelector('button')?.getAttribute('aria-expanded') ?? null,
      rowText: row?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300) ?? null,
      focus: document.activeElement?.closest?.('.bd-hs-rp')?.id ?? null,
    };
  })()`;
  await watch(
    `(() => { const s = ${timelineJs}; return [s.timeline, s.section, s.rowOpen].join('|'); })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...m });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...m, buttons: 0 });
  const tl = await poll(async () => {
    const s = await page.evaluate(timelineJs);
    return s.timeline === 'true' && s.rowOpen === 'true' && s;
  });
  const tlNow = tl || (await page.evaluate(timelineJs));
  result.timeline = tlNow;
  check('点后切到 任务 → 时间线', tlNow.tasks === 'true' && tlNow.timeline === 'true', tlNow);
  check(
    '时间线有 "重新规划" 区，计数等于 history 的 replan 条数',
    tlNow.section && tlNow.count === String(answered?.d?.length),
    { ui: tlNow.count, daemon: answered?.d?.length },
  );
  check('那一行(按 decision.at 定位)展开', tlNow.rowOpen === 'true', tlNow);
  check('展开的行列出新增的任务', tlNow.rowText?.includes(T2), tlNow.rowText);
  result.first_open_states = await states();

  // 5. The milestone card's chip goes back to the count once answered.
  await page.click({ role: 'radio', name: '总览', exact: true });
  const back = await poll(async () =>
    (await names('个重新规划条件')).find((n) => n.name === COUNT),
  );
  check('回答后里程碑按钮名回到 "… 的 2 个重新规划条件"', back, await names('重新规划条件'));
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
