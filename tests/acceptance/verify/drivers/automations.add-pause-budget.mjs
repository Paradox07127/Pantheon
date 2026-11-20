import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'automations.add-pause-budget', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

/**
 * Fixture turns report no input tokens, so the spent budget is written into the boot daemon's own
 * store: the ended turn's usage. The store reads rows again when the database changes under it.
 */
const setTurnTokens = (turnId, tokens) => {
  const db = new DatabaseSync(path.join(run.workspace, 'state', 'control.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare(
    `UPDATE session_turns SET data=json_set(data,'$.usage',json(json_patch(coalesce(json_extract(data,'$.usage'),'{}'),json_object('input_tokens',?,'tokens_unreported',json('null'))))) WHERE id=?`,
  ).run(tokens, turnId);
  db.close();
};

const TABLE = '本项目 agent 的例行任务';
const rowsJs = `(() => {
  const table = [...document.querySelectorAll('[role=table]')].find((t) => t.getAttribute('aria-label') === ${JSON.stringify(TABLE)});
  if (!table) return null;
  return [...table.querySelectorAll('[role=row]')].filter((r) => r.querySelector('[role=cell]')).map((r) => ({
    cells: [...r.querySelectorAll('[role=cell]')].map((c) => c.innerText.replace(/\\s+/g, ' ').trim()),
    after: (r.nextElementSibling?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    text: r.innerText.replace(/\\s+/g, ' ').trim(),
  }));
})()`;
const rows = () => page.evaluate(rowsJs);
const rowOf = (list, text) => list?.find?.((r) => r.cells[1]?.startsWith(text));

try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-automations-add-${stamp}`, {
    'README.md': '# automations\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "automations-add-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const agentOf = async (template) =>
    (await query('agent.list', { project_id })).find((a) => a.template === template);
  const assistant0 = await agentOf('assistant');

  // (a) Empty page > Add routine > the Assistant's profile with one blank routine, focused; Cancel.
  await page.click({ role: 'button', name: '自动化，已开 0 个例行任务', exact: true });
  await page.click({ role: 'button', name: '添加例行任务', exact: true });
  const profileJs = `(() => {
    const a = [...document.querySelectorAll('aside')].find((el) => el.getAttribute('aria-label') === '助理的资料' && el.getClientRects().length);
    if (!a) return null;
    const prompts = [...a.querySelectorAll('input, textarea')].filter((el) => el.getAttribute('aria-label') === '例行任务提示词');
    return { prompts: prompts.map((p) => p.value), focused: prompts.indexOf(document.activeElement) };
  })()`;
  const added = await poll(async () => {
    const p = await page.evaluate(profileJs);
    return p?.prompts.length && p.focused >= 0 && p;
  }, 8000);
  result.added = added;
  check(
    '助理资料面板里有一条空白例行任务',
    added?.prompts.length === 1 && added.prompts[0] === '',
    added,
  );
  check('焦点在这条例行任务的提示词输入框', added?.focused === added?.prompts.length - 1, added);
  await page.click({
    role: 'button',
    name: '取消',
    exact: true,
    within: { name: '助理的资料', exact: true },
  });
  const gone = await poll(async () => {
    const p = await page.evaluate(profileJs);
    return (p === null || p.prompts.length === 0) && (p ?? 'closed');
  }, 5000);
  check('点 "取消" 后空白例行任务消失', gone, await page.evaluate(profileJs));
  const assistant1 = await agentOf('assistant');
  check(
    '后端对照：没有发出 agent.update(助理 revision 不变，routines 仍为空)',
    assistant1.revision === assistant0.revision && (assistant1.routines ?? []).length === 0,
    { before: assistant0.revision, after: assistant1.revision, routines: assistant1.routines },
  );
  await page.press('Escape');

  // (b) Two interval routines; pausing one leaves the other's next run where it was.
  const A = `Hourly ${stamp}`;
  const B = `Twohourly ${stamp}`;
  await call('agent.update', {
    agent_id: assistant1.id,
    revision: assistant1.revision,
    routines: [
      { id: 'hourly', prompt: `${A}\n${script({ say: 'ok' })}`, every_minutes: 60, enabled: true },
      {
        id: 'twohourly',
        prompt: `${B}\n${script({ say: 'ok' })}`,
        every_minutes: 120,
        enabled: true,
      },
    ],
  });
  const routinesOf = async () => query('agent.routines', { project_id });
  const dueOf = async (id) => (await routinesOf()).find((r) => r.routine.id === id)?.next_run_at;
  await page.click({ role: 'button', name: '自动化，已开 2 个例行任务', exact: true });
  const shown = await poll(async () => {
    const r = await rows();
    return r?.length === 2 && rowOf(r, B) && r;
  });
  // A wake of the other routine, so the agent's wakes are more than one routine's.
  await page.click({
    role: 'button',
    name: '立即运行',
    exact: true,
    within: { role: 'row', name: A },
  });
  await poll(async () => {
    const r = (await routinesOf()).find((x) => x.routine.id === 'hourly');
    return r?.last_run && !['queued', 'running'].includes(r.last_run.state);
  }, 30_000);
  const dueBefore = await dueOf('twohourly');
  const cellBefore = rowOf(shown, B)?.cells[3];
  result.before = { due: dueBefore, cell: cellBefore };
  check(
    '前置：两个例行任务都有 next_run_at',
    dueBefore && (await dueOf('hourly')),
    await routinesOf(),
  );
  await page.click({ role: 'button', name: '暂停', exact: true, within: { role: 'row', name: A } });
  const paused = await poll(
    async () =>
      (await routinesOf()).find((r) => r.routine.id === 'hourly')?.routine.enabled === false,
  );
  check('前置：点 "暂停" 后 hourly enabled=false', paused);
  const afterRows = await poll(async () => {
    const r = await rows();
    return rowOf(r, A)?.cells[3] === '已暂停' && r;
  });
  const dueAfter = await dueOf('twohourly');
  result.after = { due: dueAfter, cell: rowOf(afterRows, B)?.cells[3] };
  check('另一个例行任务的 next_run_at 不变(agent.routines)', dueAfter === dueBefore, {
    before: dueBefore,
    after: dueAfter,
  });
  check('另一个例行任务的 "下次运行" 文字不变', rowOf(afterRows, B)?.cells[3] === cellBefore, {
    before: cellBefore,
    after: rowOf(afterRows, B)?.cells[3],
  });
  check(
    '对照组：被暂停的那行 "下次运行" 变成 "已暂停"',
    rowOf(afterRows, A)?.cells[3] === '已暂停',
    rowOf(afterRows, A)?.cells,
  );

  // (d) The runs of one routine: run it once, then open its runs.
  await page.click({
    role: 'button',
    name: '立即运行',
    exact: true,
    within: { role: 'row', name: B },
  });
  const ran = await poll(async () => {
    const r = (await routinesOf()).find((x) => x.routine.id === 'twohourly');
    return r?.last_run && !['queued', 'running'].includes(r.last_run.state) && r;
  }, 30_000);
  check('前置：twohourly 跑完一次', ran, ran?.last_run);
  await page.click({ role: 'button', name: `展开 ${B}`, exact: false });
  const groupJs = `(() => {
    const g = [...document.querySelectorAll('[role=group]')].find((el) => (el.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(B)}) && el.getAttribute('aria-label').endsWith('的最近运行'));
    if (!g || g.getAttribute('aria-busy') === 'true') return null;
    return { label: g.getAttribute('aria-label'), runs: [...g.querySelectorAll(':scope > div')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim()) };
  })()`;
  const group = await poll(() => page.evaluate(groupJs));
  const wakes = await query('agent.wakes', {
    agent_id: assistant1.id,
    routine_id: 'twohourly',
    limit: '50',
  });
  const allWakes = await query('agent.wakes', { agent_id: assistant1.id, limit: '50' });
  result.runs = { ui: group, daemon: wakes.length, all: allWakes.length };
  check(
    '运行列表条数等于 agent.wakes {routine_id} 的条数',
    group && group.runs.length === Math.min(5, wakes.length),
    result.runs,
  );

  check(
    '对照组：agent 的全部唤醒多于这个例行任务的，列表没按 agent 列',
    allWakes.length > wakes.length && group?.runs.length !== Math.min(5, allWakes.length),
    result.runs,
  );

  // (c) The project budget used up: Run now queues and the row says why.
  await call('workflow.policy.set', { project_id, project_budget: { input_tokens: 100 } });
  const OTHER = `Spend ${stamp}`;
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `${OTHER}\n${script({ say: 'ok' })}`,
  });
  const spender = await poll(async () => {
    const s = (await query('session.list', { project_id })).find((x) => x.title === OTHER);
    return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
  }, 30_000);
  setTurnTokens(spender.last_turn.id, 1000);
  const over = await poll(
    async () =>
      (await query('needs_you.list', { project_id })).items.find(
        (i) => i.kind === 'project.over_budget',
      ),
    5000,
  );
  result.budget = over?.project_budget ?? null;
  check('前置：项目预算已用完(needs_you.list 有 project.over_budget)', over, result.budget);
  await page.click({
    role: 'button',
    name: '立即运行',
    exact: true,
    within: { role: 'row', name: B },
  });
  const NOTE = '已排队，项目预算提高或清除后运行';
  const noted = await poll(async () => {
    const r = rowOf(await rows(), B);
    return (r?.text.includes(NOTE) || r?.after.includes(NOTE)) && r;
  }, 8000);
  result.budget_row = noted || rowOf(await rows(), B);
  check('这一行下出现预算提示 "已排队，项目预算提高或清除后运行"', noted, result.budget_row);
  check(
    '对照组：另一行没有预算提示',
    !rowOf(await rows(), A)?.text.includes(NOTE),
    rowOf(await rows(), A),
  );
  result.names = await names('预算');
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
