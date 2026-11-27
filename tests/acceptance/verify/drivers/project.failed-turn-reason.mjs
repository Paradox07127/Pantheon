import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.failed-turn-reason', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-failed-reason-${stamp}`, {
  'README.md': '# failed turn reason\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "failed-turn-reason-fixture", "private": true }\n',
});
const MAIN = `verify-fr-main-${stamp}`;
const TOLD = `verify-fr-told-${stamp}`;
const SPAWN_OK = `verify-fr-spawn-ok-${stamp}`;
const MINE = `verify-fr-mine-${stamp}`;
const NO_CODE = `verify-fr-nocode-${stamp}`;
const OK = `verify-fr-ok-${stamp}`;
const failWith = (fail) => [{ fail }];
const spawn = (title, steps) => ({
  tool: {
    name: 'spawn_session',
    arguments: { runtime: 'fixture', input: `${title}\nfixture-script\n${JSON.stringify(steps)}` },
  },
});
// The main agent is still running when its spawned session fails, so the notice reaches it at once.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([
    spawn(TOLD, failWith({ message: 'Build failed\nmore', error_code: 'runtime_exit' })),
    spawn(SPAWN_OK, [{ say: 'done' }]),
    { wait: 5000 },
    { say: 'ok' },
  ])}`,
});
const mine = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${MINE}\nfixture-script\n${JSON.stringify(
    failWith({ message: 'Build failed\nmore', error_code: 'runtime_exit' }),
  )}`,
});
const noCode = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${NO_CODE}\nfixture-script\n${JSON.stringify(failWith({ message: 'Build failed\nmore' }))}`,
});
const okDirect = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${OK}\nfixture-script\n${JSON.stringify([{ say: 'done' }])}`,
});
const settled = (s) =>
  s && ['idle', 'ready'].includes(s.state) && !['queued', 'running'].includes(s.last_turn?.state);
// Decided on the same read the checks use.
const list = await poll(async () => {
  const all = await query('session.list', { project_id });
  const by = (title) => all.find((s) => s.title === title);
  const told = by(TOLD);
  return (
    [MINE, NO_CODE, OK, SPAWN_OK, TOLD].every((t) => settled(by(t))) &&
    told.last_turn.told_main_agent === true && {
      all,
      by: Object.fromEntries(all.map((s) => [s.title, s])),
    }
  );
}, 90_000);
const by = list?.by ?? {};
result.backend = Object.fromEntries(
  [TOLD, SPAWN_OK, MINE, NO_CODE, OK].map((t) => [
    t,
    {
      state: by[t]?.state,
      spawned_by: by[t]?.spawned_by?.session_id ?? null,
      last_turn: by[t]?.last_turn,
    },
  ]),
);
check('前置：四个会话回合结束，主 agent 已被告知 TOLD 的失败回合', list, result.backend);
check(
  '前置:TOLD 是主 agent 起的，失败回合带 error_code=runtime_exit',
  by[TOLD]?.spawned_by?.session_id === conductor.id &&
    by[TOLD]?.last_turn?.state === 'failed' &&
    by[TOLD]?.last_turn?.error_code === 'runtime_exit',
  by[TOLD]?.last_turn,
);
check(
  '前置:MINE 是用户开的失败会话，没有 told_main_agent',
  !by[MINE]?.spawned_by &&
    by[MINE]?.last_turn?.state === 'failed' &&
    by[MINE]?.last_turn?.error_code === 'runtime_exit' &&
    by[MINE]?.last_turn?.told_main_agent === undefined,
  by[MINE]?.last_turn,
);

// What the row should say, built from session.list's last_turn.
const expected = (s) => {
  const reason = (s.last_turn.error_code ?? s.last_turn.error)?.split('\n')[0];
  const handler = s.spawned_by && s.last_turn.told_main_agent ? '主 agent 已知道' : '等你处理';
  return reason ? `上回合失败 · ${handler}：${reason}` : `上回合失败。${handler}`;
};
const readRow = (id) =>
  page.evaluate(`(() => {
    const b = document.querySelector('[data-session="${id}"]');
    return b ? { name: b.getAttribute('aria-label'), shown: b.innerText } : null;
  })()`);

// (1) Sidebar rows. The project was switched to by newProject, so the sidebar lists its sessions.
const rows =
  (await poll(async () => {
    const r = {};
    for (const t of [MINE, NO_CODE, OK, TOLD, SPAWN_OK])
      r[t] = by[t] ? await readRow(by[t].id) : null;
    return r[MINE]?.name?.includes('上回合失败') && r[TOLD]?.name?.includes('上回合失败') && r;
  }, 15_000)) || {};
result.rows = rows;
check(
  `用户开的失败会话行名含 "上回合失败 · 等你处理：runtime_exit"`,
  rows[MINE]?.name?.includes('上回合失败 · 等你处理：runtime_exit'),
  rows[MINE]?.name,
);
check(
  '后端对照：用户开的失败会话行名含按 session.list last_turn 拼出的句子',
  by[MINE] && rows[MINE]?.name?.includes(expected(by[MINE])),
  by[MINE] && expected(by[MINE]),
);
check(
  '用户开的失败会话行上看得见同一句',
  by[MINE] && rows[MINE]?.shown?.includes(expected(by[MINE])),
  rows[MINE]?.shown,
);
check(
  '没有 error_code 时 reason 取 error 首行:"上回合失败 · 等你处理：Build failed"',
  by[NO_CODE]?.last_turn?.error_code === undefined &&
    rows[NO_CODE]?.name?.includes('上回合失败 · 等你处理：Build failed') &&
    !rows[NO_CODE].name.includes('more') &&
    rows[NO_CODE].shown.includes(expected(by[NO_CODE])),
  { row: rows[NO_CODE], last_turn: by[NO_CODE]?.last_turn },
);
check(
  '主 agent 起、已告知的失败会话行名含 "上回合失败 · 主 agent 已知道：runtime_exit"',
  rows[TOLD]?.name?.includes('上回合失败 · 主 agent 已知道：runtime_exit') &&
    rows[TOLD].shown.includes(expected(by[TOLD])),
  rows[TOLD],
);
check(
  '对照组：成功会话行名和行上文字都不含 "上回合失败"',
  rows[OK]?.name && !rows[OK].name.includes('上回合失败') && !rows[OK].shown.includes('上回合失败'),
  rows[OK],
);
check(
  '对照组：主 agent 起的成功会话行名不含 "上回合失败："',
  rows[SPAWN_OK]?.name && !rows[SPAWN_OK].name.includes('上回合失败'),
  rows[SPAWN_OK]?.name,
);
check(
  '对照组：用户开的失败会话行名不含 "主 agent 已知道"',
  rows[MINE]?.name && !rows[MINE].name.includes('主 agent 已知道'),
  rows[MINE]?.name,
);

// (2) Project screen agent rows.
await page.click({ role: 'button', name: '项目', exact: true });
const readAgents = () =>
  page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section[aria-label="Agent"]')].find((e) => e.getClientRects().length);
    if (!r) return null;
    return [...r.querySelectorAll('li button')].map((b) => ({
      title: b.querySelector('.pj-atl .clip-1')?.textContent.trim() ?? b.querySelector('.clip-1')?.textContent.trim(),
      sub: b.querySelector('.pj-sub')?.textContent.trim() ?? null,
    }));
  })()`);
const agents =
  (await poll(async () => {
    const v = await readAgents();
    return v?.find((r) => r.title === TOLD)?.sub?.includes('上回合失败') && v;
  }, 15_000)) || (await readAgents());
result.agents = agents;
const agent = (title) => agents?.find?.((r) => r.title === title);
check(
  '后端对照：项目屏失败 agent 行的副标题等于按 session.list 拼出的句子',
  by[TOLD] && agent(TOLD)?.sub === expected(by[TOLD]),
  { shown: agent(TOLD), expected: by[TOLD] && expected(by[TOLD]) },
);
check(
  '对照组：项目屏成功 agent 行的副标题不含 "上回合失败"(有 recap.headline 时等于它)',
  agent(SPAWN_OK) &&
    !agent(SPAWN_OK).sub?.includes('上回合失败') &&
    (agent(SPAWN_OK).sub ?? null) === (by[SPAWN_OK]?.recap?.headline ?? null),
  { shown: agent(SPAWN_OK), headline: by[SPAWN_OK]?.recap?.headline ?? null },
);
check(
  '对照组：用户开的失败会话不在 Agent 列表',
  agents && !agent(MINE),
  agents?.map((r) => r.title),
);
result.shot = await page.screenshot(result.id);
result.ids = { conductor: conductor.id, mine: mine.id, noCode: noCode.id, ok: okDirect.id };
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
