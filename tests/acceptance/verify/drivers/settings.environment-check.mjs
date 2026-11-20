import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 480_000,
});
const result = { id: 'settings.environment-check', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-environment-${stamp}`, {
  'README.md': '# environment check\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "environment-check-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
const ROOT = (await query('project.read', { project_id })).project?.roots?.[0] ?? repo;
result.root = ROOT;
const setGate = async (commands) =>
  call('project.gate.set', { project_id, root: ROOT, commands }, await revision());
const checks = () => query('project.environment.checks', { project_id });
const latest = async () => (await checks()).find((c) => c.root === ROOT);
const settled = (ms = 60_000) =>
  poll(async () => {
    const row = await latest();
    return row && row.state !== 'running' && row;
  }, ms);

const BOOM = `boom-${stamp}`;
const PASS = { name: 'pass-check', argv: ['sh', '-c', 'sleep 2'] };
const FAIL = { name: 'fail-check', argv: ['sh', '-c', `echo ${BOOM}; exit 3`] };

// What the section shows, read in one pass.
const section = () =>
  page.evaluate(`(() => {
    const s = document.querySelector('section.evc');
    if (!s) return null;
    const button = s.querySelector('.evc-end button');
    const why = button?.getAttribute('aria-describedby');
    return {
      title: s.getAttribute('aria-label'),
      button: button?.textContent.trim(),
      disabled: !!button?.disabled,
      why: why ? document.getElementById(why)?.textContent.trim() ?? null : null,
      groups: [...s.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label')),
      rows: [...s.querySelectorAll('li.evc-item')].map((li) => ({
        name: li.querySelector('.evc-nm')?.textContent.trim(),
        state: li.querySelector('.evc-cmd .evc-g')?.getAttribute('aria-label'),
        log: li.querySelector('pre.evc-log')?.getAttribute('aria-label') ?? null,
        tail: li.querySelector('pre.evc-log')?.textContent ?? null,
        failure: li.querySelector('.evc-class')?.textContent.trim() ?? null,
      })),
    };
  })()`);
const clickVerify = () =>
  page.evaluate(
    `(() => { const b = document.querySelector('section.evc .evc-end button'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  );
const group = (state) => `${ROOT}，${state}`;

try {
  await setGate([PASS, FAIL]);
  const gates = (await query('project.read', { project_id })).project?.gates?.[ROOT];
  check(
    '前置：project.read 的 gates[root] 是一条通过、一条失败',
    gates?.length === 2 && gates[1].name === FAIL.name,
    gates?.map((g) => g.name),
  );

  // Settings > Projects > this project, whose page holds its gates.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '项目', exact: true });
  await page.click({ role: 'button', name: `verify-environment-${stamp}`, exact: false });
  // The section renders its button before the board snapshot that carries the gate commands set above.
  const first =
    (await poll(async () => {
      const s = await section();
      return s?.rows.length === 2 && s;
    })) || (await section());
  check('门禁页有"环境"一节', first?.title === '环境', first?.title);
  check('按钮是"检查环境"且可用', first?.button === '检查环境' && !first.disabled, first);
  // Before any check the root lists its gate commands as not run.
  check(
    '还没有检查结果：根目录组"没跑"，每条命令"没跑"，checks 为空',
    first?.groups.length === 1 &&
      first.groups[0] === group('没跑') &&
      first.rows.every((r) => r.state === '没跑' && r.log === null) &&
      (await checks()).length === 0,
    first && { groups: first.groups, rows: first.rows.map((r) => r.state) },
  );

  // The page reloads on the check's events; a marker on window shows it was not reloaded.
  await page.evaluate(`window.__evcMarker = ${stamp}`);
  const hash = await page.evaluate('location.hash');
  check('点"检查环境"', await clickVerify());
  const busy = await poll(async () => {
    const s = await section();
    return s?.disabled && s.groups.includes(group('运行中')) && s;
  });
  check('点击后按钮不可用，出现"{root}，运行中"', busy, busy?.groups);
  const runningRow = await latest();
  check(
    'project.environment.checks 新的一条 state 是 running',
    runningRow?.state === 'running',
    runningRow?.state,
  );

  const ended = await settled();
  const done = await poll(async () => {
    const s = await section();
    return s?.button === '再查一次' && !s.disabled && s.rows.length === 2 && s;
  });
  check('结束后 checks 最新一条 state 是 failed', ended?.state === 'failed', ended?.state);
  check('按钮是"再查一次"且可用', done, done && { button: done.button, disabled: done.disabled });
  check('根目录组是"失败"', done?.groups.includes(group('失败')), done?.groups);
  check('对照组：根目录组不是"通过"', done && !done.groups.includes(group('通过')), done?.groups);
  check(
    '第一条命令"通过"，第二条"失败，退出码 3"',
    done?.rows[0]?.state === '通过' && done?.rows[1]?.state === '失败，退出码 3',
    done?.rows.map((r) => r.state),
  );
  check(
    '界面命令名和 checks 最新一条 commands[] 一致',
    JSON.stringify(done?.rows.map((r) => r.name)) ===
      JSON.stringify(ended?.commands.map((c) => c.name)),
    { ui: done?.rows.map((r) => r.name), daemon: ended?.commands.map((c) => c.name) },
  );
  check(
    '界面状态和 checks 的 exit_code 一致',
    ended?.commands.every((c, i) =>
      c.exit_code === 0
        ? done?.rows[i]?.state === '通过'
        : done?.rows[i]?.state === `失败，退出码 ${c.exit_code}`,
    ),
    ended?.commands.map((c) => c.exit_code),
  );
  check(
    '失败那条有"fail-check 的日志末尾"且含 boom 串',
    done?.rows[1]?.log === `${FAIL.name} 的日志末尾` && done.rows[1].tail?.includes(BOOM),
    done?.rows[1] && { log: done.rows[1].log, tail: done.rows[1].tail },
  );
  check('对照组：日志末尾不含别的串', done && !done.rows[1]?.tail?.includes(`boom-${stamp + 1}`));
  check('失败那条有失败分类', done?.rows[1]?.failure, done?.rows[1]?.failure);
  check(
    '失败分类和 checks 的 failure_class 一致',
    ended?.commands[1]?.failure_class &&
      done?.rows[1]?.failure ===
        (ended.commands[1].failure_class === 'code' ? '代码的问题' : '这台机器的问题'),
    ended?.commands[1]?.failure_class,
  );
  check('通过那条没有日志', done && done.rows[0].log === null, done?.rows[0]?.log);
  const kept = await page.evaluate(
    `window.__evcMarker === ${stamp} && location.hash === ${JSON.stringify(hash)}`,
  );
  check('从点击到结果页面没有刷新、没有切页', kept);

  // No horizontal overflow: the log and each row stay inside the section.
  const overflow = await page.evaluate(`(() => {
    const s = document.querySelector('section.evc');
    const right = s.getBoundingClientRect().right + 0.5;
    return [...s.querySelectorAll('li.evc-item, pre.evc-log, .evc-rh')]
      .filter((el) => el.getBoundingClientRect().right > right || el.scrollWidth > el.clientWidth + 1 && el.tagName !== 'PRE')
      .map((el) => el.className);
  })()`);
  check('日志块和每一行的右边界不超出这一节', overflow?.length === 0, overflow);
  await page.evaluate(
    `document.querySelector('section.evc pre.evc-log')?.scrollIntoView({ block: 'center' })`,
  );
  result.shot = await page.screenshot(result.id);

  // Only the passing command left: the next check passes.
  await setGate([PASS]);
  check('点"再查一次"', await poll(clickVerify));
  const passed = await poll(async () => {
    const row = await latest();
    return row && row.id !== ended?.id && row.state !== 'running' && row;
  }, 60_000);
  check('再查一次后 checks 最新一条 state 是 passed', passed?.state === 'passed', passed?.state);
  const shownPassed = await poll(async () => {
    const s = await section();
    return s?.groups.includes(group('通过')) && !s.disabled && s;
  });
  check('根目录组是"通过"', shownPassed, shownPassed?.groups);
  check(
    '通过时没有日志',
    shownPassed && !(await page.evaluate(`!!document.querySelector('section.evc pre.evc-log')`)),
  );

  // No gate commands: the button is disabled and says why.
  await setGate([]);
  const empty = await poll(async () => {
    const s = await section();
    return s?.disabled && s.why && s;
  });
  check('门禁清空后按钮不可用', empty?.disabled, empty);
  check(
    '按钮的 aria-describedby 读到"没有可跑的门禁命令"',
    empty?.why === '没有可跑的门禁命令',
    empty?.why,
  );

  // A second verify while one runs is refused.
  await setGate([{ name: 'slow-check', argv: ['sh', '-c', 'sleep 4'] }]);
  await poll(async () => !(await section())?.disabled);
  check('慢门禁：点"再查一次"', await clickVerify());
  const slowStarted = await poll(async () => (await latest())?.state === 'running');
  let refused = null;
  try {
    await call('project.environment.verify', { project_id });
  } catch (error) {
    refused = String(error.message);
  }
  check(
    '检查在跑时再发 project.environment.verify 被拒，错误码 resource_busy',
    slowStarted && refused?.includes('resource_busy'),
    refused,
  );
  // The running state reaches the page an event after the daemon has it.
  const busyShown =
    (await poll(async () => {
      const now = await section();
      return now?.disabled ? now : null;
    }, 3000)) || (await section());
  check('这时界面按钮不可用', busyShown?.disabled, busyShown?.button);
  const slowEnded = await settled();
  check('慢检查结束且通过', slowEnded?.state === 'passed', slowEnded?.state);
  await poll(async () => !(await section())?.disabled);
} catch (error) {
  check('驱动跑完没有抛异常', false, String(error?.message ?? error));
} finally {
  await settled().catch(() => null);
  await setGate([]).catch(() => null);
}

check('对照组：不存在的根目录组找不到', (await names(`${ROOT}-absent`)).length === 0);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
