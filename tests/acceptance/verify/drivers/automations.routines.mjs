import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 150_000,
});
const result = { id: 'automations.routines', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the screen commits from now on, at every DOM change; `state` is a page
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
  const { project_id } = await newProject(`verify-automations-${stamp}`, {
    'README.md': '# automations\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "automations-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const agents = await query('agent.list', { project_id });
  const triage = agents.find((a) => a.template === 'triage');
  const assistant = agents.find((a) => a.template === 'assistant');
  check(
    '前置：新项目带 assistant 和 triage 两个 agent',
    triage && assistant,
    agents.map((a) => a.template),
  );

  // 1. Empty: no agent of the project has a routine.
  const TABLE = '本项目 agent 的例行任务';
  const EMPTY = '本项目还没有 agent 按时间安排做事。';
  const screenState = `(() => {
    const main = document.querySelector('main.au-pg');
    if (!main) return 'none';
    const table = main.querySelector('[role=table]');
    if (table?.getAttribute('aria-busy') === 'true') return 'loading';
    if (main.innerText.includes(${JSON.stringify(EMPTY)})) return 'empty';
    if (table) return 'rows:' + table.querySelectorAll('[role=row]:not(.au-hd)').length;
    return 'other:' + main.innerText.slice(0, 40);
  })()`;
  const entry0 = await poll(async () => (await names('自动化，')).find((n) => n.role === 'button'));
  check(
    '侧栏入口名 "自动化，已开 0 个例行任务"',
    entry0?.name === '自动化，已开 0 个例行任务',
    entry0,
  );
  await watch(screenState);
  await page.click({ role: 'button', name: '自动化，已开 0 个例行任务', exact: true });
  const h1 = await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('h1')].find((h) => h.getClientRects().length)?.textContent ?? null`,
    ),
  );
  check('标题 h1 是 "自动化"', h1 === '自动化', h1);
  const empty = await poll(() =>
    page.evaluate(`document.body.innerText.includes(${JSON.stringify(EMPTY)})`),
  );
  check('空状态写 "本项目还没有 agent 按时间安排做事。"', empty);
  check(
    '空状态有 "添加例行任务" 按钮',
    (await names('添加例行任务')).some((n) => n.role === 'button'),
  );
  const daemonEmpty = await query('agent.routines', { project_id });
  check('后端对照：agent.routines 为空', daemonEmpty.length === 0, daemonEmpty.length);
  const firstStates = await states();
  result.first_open_states = firstStates;
  const shownStates = firstStates.filter((s) => s !== 'none' && s !== 'loading');
  check('首次打开不闪：落定前没有画出别的内容', new Set(shownStates).size <= 1, firstStates);

  // 2. Routines on two agents, one paused.
  const SWEEP = `Sweep ${stamp}`;
  const DIGEST = `Digest ${stamp}`;
  const STANDUP = `Standup ${stamp}: read the board, list every task that changed since yesterday and send one short line per lane`;
  // The wake note quotes the prompt; the closing quote lands on the line after the script.
  const sweepPrompt = `${SWEEP}\nfixture-script\n${JSON.stringify([{ say: 'Sweep ran.' }, { wait: 8000 }])}\nend`;
  await call('agent.update', {
    agent_id: triage.id,
    revision: triage.revision,
    routines: [
      { id: 'sweep', prompt: sweepPrompt, every_minutes: 60, enabled: true },
      { id: 'digest', prompt: DIGEST, at: '09:00', enabled: false },
    ],
  });
  await call('agent.update', {
    agent_id: assistant.id,
    revision: assistant.revision,
    routines: [{ id: 'standup', prompt: STANDUP, every_minutes: 120, enabled: true }],
  });
  const entry2 = await poll(async () =>
    (await names('自动化，')).find((n) => n.role === 'button' && n.name.includes('2')),
  );
  check(
    '侧栏入口名变成 "自动化，已开 2 个例行任务"',
    entry2?.name === '自动化，已开 2 个例行任务',
    entry2,
  );

  const rowsJs = `(() => {
    const table = [...document.querySelectorAll('[role=table]')].find((t) => t.getAttribute('aria-label') === ${JSON.stringify(TABLE)});
    if (!table) return null;
    return [...table.querySelectorAll('[role=row]')].filter((r) => r.querySelector('[role=cell]')).map((r) => {
      const cells = [...r.querySelectorAll('[role=cell]')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim());
      return {
        cells,
        buttons: [...r.querySelectorAll('button')].map((b) => ({
          name: b.getAttribute('aria-label') ?? b.textContent.trim(),
          disabled: b.disabled,
          expanded: b.getAttribute('aria-expanded'),
        })),
      };
    });
  })()`;
  const rows = await poll(async () => {
    const r = await page.evaluate(rowsJs);
    return r?.length === 3 && r;
  });
  result.rows = rows;
  const rowOf = (list, text) => list?.find?.((r) => r.cells[1]?.startsWith(text));
  const daemon = await query('agent.routines', { project_id });
  check('表格 3 行，等于 agent.routines 的条数', rows?.length === daemon.length, {
    ui: rows?.length,
    daemon: daemon.length,
  });
  const digest = rowOf(rows, DIGEST);
  const sweep = rowOf(rows, SWEEP);
  const standup = rowOf(rows, STANDUP);
  check(
    '每行的 Agent 列是界面语言的名字(问题处理 / 助理)',
    daemon.every((d) => {
      const r = rowOf(rows, d.routine.prompt.split('\n')[0]);
      return (
        r &&
        r.cells[0] ===
          { triage: '问题处理', assistant: '助理' }[
            d.agent_id === triage.id ? 'triage' : 'assistant'
          ]
      );
    }),
    rows?.map((r) => r.cells[0]),
  );
  check('停用的例行任务下次运行列写 "已暂停"', digest?.cells[3] === '已暂停', digest?.cells);
  check(
    '停用的行按钮是 "恢复"，"立即运行" 禁用',
    digest?.buttons.some((b) => b.name === '恢复') &&
      digest.buttons.find((b) => b.name === '立即运行')?.disabled === true,
    digest?.buttons,
  );
  check(
    '开着的行按钮是 "暂停"，"立即运行" 可点',
    sweep?.buttons.some((b) => b.name === '暂停') &&
      sweep.buttons.find((b) => b.name === '立即运行')?.disabled === false,
    sweep?.buttons,
  );
  check(
    '对照组：开着的行下次运行列不是 "已暂停"',
    standup && standup.cells[3] !== '已暂停',
    standup?.cells,
  );
  // A long prompt is cut inside its own column, not drawn over the next ones.
  const spill = await page.evaluate(`(() => {
    const table = [...document.querySelectorAll('[role=table]')].find((t) => t.getAttribute('aria-label') === ${JSON.stringify(TABLE)});
    return [...table.querySelectorAll('[role=row]')].flatMap((r) => [...r.querySelectorAll('[role=cell]')].map((c, i) => {
      // The boxes drawn, not the text's own width: a cut text is wider than its box.
      const box = c.getBoundingClientRect().right;
      const text = Math.max(box, ...[...c.children].map((el) => el.getBoundingClientRect().right));
      return { column: i, over: Math.round(text - box), text: c.innerText.slice(0, 40) };
    })).filter((c) => c.over > 1);
  })()`);
  check('例行任务列的长提示词在本列内截断，不压到后面的列', spill.length === 0, spill);

  // 3. Resume the paused one, then pause it again.
  const enabledOf = async (rid) =>
    (await query('agent.routines', { project_id })).find((d) => d.routine.id === rid)?.routine
      .enabled;
  await page.click({
    role: 'button',
    name: '恢复',
    exact: true,
    within: { role: 'row', name: DIGEST },
  });
  const resumed = await poll(async () => (await enabledOf('digest')) === true);
  check('点 "恢复" 后 agent.routines 里 digest enabled=true', resumed);
  const resumedUi = await poll(async () =>
    rowOf(await page.evaluate(rowsJs), DIGEST)?.buttons.some((b) => b.name === '暂停'),
  );
  check('恢复后该行按钮变成 "暂停"', resumedUi);
  await page.click({
    role: 'button',
    name: '暂停',
    exact: true,
    within: { role: 'row', name: DIGEST },
  });
  const paused = await poll(async () => (await enabledOf('digest')) === false);
  check('点 "暂停" 后 agent.routines 里 digest enabled=false', paused);
  const toast = await poll(() =>
    page.evaluate(`document.body.innerText.includes(${JSON.stringify(`已暂停 ${DIGEST}`)})`),
  );
  check('暂停后出现 "已暂停 {例行任务}" 的提示', toast);

  // 4. Run now; the button stays disabled while the run is out.
  await page.click({
    role: 'button',
    name: '立即运行',
    exact: true,
    within: { role: 'row', name: SWEEP },
  });
  const during = await poll(async () => {
    const wakes = await query('agent.wakes', { agent_id: triage.id, limit: '5' });
    const run = wakes.find((w) => w.routine_ids?.includes('sweep'));
    if (!run || !['queued', 'running'].includes(run.state)) return null;
    const ui = rowOf(await page.evaluate(rowsJs), SWEEP)?.buttons.find(
      (b) => b.name === '立即运行',
    );
    return ui?.disabled ? { state: run.state, disabled: ui.disabled } : null;
  }, 8000);
  check('运行中(agent.wakes 为 queued/running)时 "立即运行" 禁用', during, during);
  const finished = await poll(async () => {
    const wakes = await query('agent.wakes', { agent_id: triage.id, limit: '5' });
    const run = wakes.find((w) => w.routine_ids?.includes('sweep'));
    return run && !['queued', 'running'].includes(run.state) && run;
  }, 30_000);
  check('前置：这次运行结束且 completed', finished?.state === 'completed', finished?.state);
  const after = await poll(async () =>
    rowOf(await page.evaluate(rowsJs), SWEEP)?.buttons.find(
      (b) => b.name === '立即运行' && !b.disabled,
    ),
  );
  check('运行结束后 "立即运行" 恢复可点', after);
  const lastCell = rowOf(await page.evaluate(rowsJs), SWEEP)?.cells[4];
  check('上次运行列不再是 "从未运行"', lastCell && !lastCell.includes('从未运行'), lastCell);

  // 5. The runs of the row.
  await page.click({ role: 'button', name: `展开 ${SWEEP}`, exact: false });
  const groupJs = `(() => {
    const g = [...document.querySelectorAll('[role=group]')].find((el) => (el.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(SWEEP)}) && el.getAttribute('aria-label').endsWith('的最近运行'));
    if (!g || g.getAttribute('aria-busy') === 'true') return null;
    return { label: g.getAttribute('aria-label'), runs: [...g.querySelectorAll('.au-run')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()), buttons: [...g.querySelectorAll('button')].map((b) => ({ name: b.textContent.trim(), disabled: b.disabled })) };
  })()`;
  const group = await poll(() => page.evaluate(groupJs));
  result.runs = group;
  const wakes = (await query('agent.wakes', { agent_id: triage.id, limit: '20' })).filter((w) =>
    w.routine_ids?.includes('sweep'),
  );
  check('展开后有组 "{例行任务} 的最近运行"', group, await names('的最近运行'));
  check(
    '运行行数等于 agent.wakes 里含该例行任务的条数(最多 5)',
    group?.runs.length === Math.min(5, wakes.length),
    { ui: group?.runs.length, daemon: wakes.length },
  );
  check(
    '展开按钮名变成 "收起 … 的运行"，aria-expanded=true',
    (await names(`收起 ${SWEEP}`)).length === 1,
    await names(`收起 ${SWEEP}`),
  );
  check(
    '完成的运行行有可点的 "做成任务"',
    group?.buttons.some((b) => b.name === '做成任务' && !b.disabled),
    group?.buttons,
  );

  // 6. Make a task, then open the Assistant session it went to.
  const assistantSession = async () =>
    (await query('session.list', { project_id })).find((s) => s.resident?.kind === 'assistant');
  const before = await assistantSession();
  await page.click({ role: 'button', name: '做成任务', exact: true });
  const sent = await poll(() =>
    page.evaluate(`(${groupJs})?.buttons.some((b) => b.name === '打开') ?? false`),
  );
  check(
    '做成任务后行里显示 "已交给助理" 和 "打开"',
    sent && (await page.evaluate(`document.body.innerText.includes('已交给助理')`)),
  );
  const assistantNow = await poll(async () => {
    const s = await assistantSession();
    return (
      s && s.id !== undefined && (s.last_turn?.id ?? null) !== (before?.last_turn?.id ?? null) && s
    );
  });
  check('后端对照：助理会话收到了新回合', assistantNow, assistantNow?.last_turn);
  result.shot = await page.screenshot(result.id);
  await page.click({ role: 'button', name: '打开', exact: true });
  const opened = await poll(() =>
    page.evaluate(`(() => {
      const row = document.querySelector('nav.ss-list [aria-current="true"]');
      return row ? (row.getAttribute('aria-label') ?? row.textContent).trim() : null;
    })()`),
  );
  check('点 "打开" 后侧栏选中的是助理会话', opened?.startsWith('助理'), opened);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
