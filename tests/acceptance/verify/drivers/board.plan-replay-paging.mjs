import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'board.plan-replay-paging', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

// The replay region, read by role and name.
const replayJs = `(() => {
  const sec = [...document.querySelectorAll('section')].find((s) => s.getAttribute('aria-label') === '计划回放');
  if (!sec) return null;
  const slider = sec.querySelector('[role=slider]');
  return {
    slider: slider && { now: slider.getAttribute('aria-valuenow'), min: slider.getAttribute('aria-valuemin'), max: slider.getAttribute('aria-valuemax'), text: slider.getAttribute('aria-valuetext'), busy: slider.getAttribute('aria-busy') },
    spinning: [...sec.querySelectorAll('[role=img]')].some((el) => el.getAttribute('aria-label') === '正在加载更早的事件'),
    more: [...sec.querySelectorAll('button')].some((b) => b.textContent.trim() === '加载更早的事件'),
    text: sec.innerText.replace(/\\s+/g, ' ').slice(0, 600),
  };
})()`;
const replay = () => page.evaluate(replayJs);

try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-replay-paging-${stamp}`, {
    'README.md': '# replay paging\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "replay-paging-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    await revision(),
  );
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const sessions = () => query('session.list', { project_id });
  const busy = (s) => s?.last_turn && ['queued', 'running'].includes(s.last_turn.state);
  const idle = (id) =>
    poll(async () => {
      const s = (await sessions()).find((x) => x.id === id);
      return s?.last_turn && !busy(s) && s;
    }, 60_000);
  const TITLE = `Paged ${stamp}`;
  const plan = (version) => ({
    base_version: version,
    headline: `Replay paging ${stamp} #${version}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks: [
      {
        id: 'task-one',
        title: TITLE,
        goal: `${TITLE}.`,
        lane: 'lane-a',
        depends_on: [],
        source: ['The user asked for it.'],
        scope: ['src/index.ts'],
        acceptance: ['true'],
        kind: { domain: 'backend-logic', tier: 't1' },
      },
    ],
    milestones: [],
    risks: [],
    assumptions: [],
  });
  // More than one page of frames: 120 plan updates, 30 to a turn.
  let version = 0;
  for (let turn = 0; turn < 4; turn++) {
    await idle(assistant);
    const steps = [];
    for (let i = 0; i < 30; i++)
      steps.push({ tool: { name: 'update_board', arguments: plan(version++) } });
    await call(
      'session.send',
      { session_id: assistant, input: script(...steps) },
      (await board()).sessions.find((s) => s.id === assistant).revision,
    );
  }
  await idle(assistant);

  // A session the user opens for the task itself, with no dispatch, that merges.
  const MANUAL = `Manual ${stamp}`;
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    task_id: `${assistant}:task-one`,
    input: `${MANUAL}\n${script(
      { write: { path: 'src/index.ts', text: 'export const answer = 44;\n' } },
      { commit: 'Manual' },
    )}`,
  });
  // A task session takes its task's title.
  const manual = await poll(
    async () => (await sessions()).find((s) => s.task?.id === 'task-one'),
    20_000,
  );
  check('前置：用户开的任务会话绑定了 task-one', manual?.task?.id === 'task-one', manual?.task);
  await idle(manual.id);
  await call(
    'session.merge',
    { session_id: manual.id },
    (await board()).sessions.find((s) => s.id === manual.id).revision,
  );
  const read = async () => {
    const all = [];
    let before = '9007199254740991';
    for (;;) {
      const r = await query('board.plan.replay', {
        lead_session_id: assistant,
        before,
        limit: '500',
      });
      all.unshift(...r.frames);
      if (r.frames.length < 500) return { total: r.total, frames: all };
      before = String(r.frames[0].sequence);
    }
  };
  const daemon = await poll(async () => {
    const r = await read();
    return r.frames.some((f) => f.kind === 'session.merged') && r;
  }, 60_000);
  const mergeFrame = daemon?.frames?.find((f) => f.kind === 'session.merged');
  result.daemon = daemon && {
    total: daemon.total,
    frames: daemon.frames.length,
    merge: mergeFrame && {
      task_id: mergeFrame.task_id,
      status: mergeFrame.tasks?.map((t) => `${t.id}:${t.status}`),
    },
  };
  check('后端对照：board.plan.replay 超过 100 帧', daemon?.total > 100, result.daemon);
  check(
    '后端对照：回放里有这个任务的合并帧(session.merged，task_id task-one，状态 merged)',
    mergeFrame?.task_id === 'task-one' &&
      mergeFrame.tasks.some((t) => t.id === 'task-one' && t.status === 'merged'),
    result.daemon?.merge,
  );

  // Tasks > Timeline > Replay; to the first frame.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '时间线', exact: true });
  await page.click({ role: 'button', name: '回放', exact: true });
  const opened = await poll(async () => {
    const r = await replay();
    return r?.slider && r.slider.busy !== 'true' && r;
  });
  result.opened = opened;
  await page.evaluate(
    `[...document.querySelectorAll('section')].find((s) => s.getAttribute('aria-label') === '计划回放').querySelector('[role=slider]').focus()`,
  );
  // page.press knows no Home or End; the key goes through CDP as a keyboard would send it.
  const key = async (name, code) => {
    for (const type of ['rawKeyDown', 'keyUp'])
      await page.send('Input.dispatchKeyEvent', {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
      });
  };
  await key('Home', 36);
  const settled = await poll(async () => {
    const r = await replay();
    return r && !r.spinning && r.slider?.now === r.slider?.min && r;
  }, 15_000);
  result.at_start = settled || (await replay());
  check('翻到头后 "正在加载更早的事件" 不再转圈', settled && !settled.spinning, result.at_start);
  check('翻到头后没有 "加载更早的事件" 按钮', settled && !settled.more, result.at_start);
  check(
    '后端对照：滑块帧数等于 board.plan.replay 的 total',
    settled && Number(settled.slider.max) - Number(settled.slider.min) + 1 === daemon?.total,
    { slider: settled?.slider, total: daemon?.total },
  );
  // The last frame is the manual session's merge.
  await key('End', 35);
  const last = await poll(async () => {
    const r = await replay();
    return r?.slider?.now === r?.slider?.max && r;
  });
  result.at_end = last;
  check(
    '最后一帧是这个任务的合并：回放文字里有 "已合并" 和任务名',
    last?.text.includes('已合并') && last.text.includes(TITLE),
    last?.text,
  );
  result.names = await names('合并');
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
