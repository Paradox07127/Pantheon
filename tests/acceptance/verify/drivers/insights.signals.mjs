import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'insights.signals', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-signals-${stamp}`);
const projectRow = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
result.project_id = project_id;

// Three sessions of one runtime and model whose turns fail with one error code make an outage.
const FAIL = [{ fail: { message: 'Rate limited', error_code: 'rate_limited' } }];
for (let i = 0; i < 3; i++)
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `verify-signals-${stamp}-${i}\nfixture-script\n${JSON.stringify(FAIL)}`,
  });
const outageOf = (issues) =>
  issues.find((i) => i.source === 'session_failures' && i.title.startsWith('Turns of 3 sessions'));
const outage = await poll(async () => outageOf(await query('signal.list', { project_id })), 60_000);
const all = await query('signal.list', { project_id });
result.signals = all.map((i) => ({
  id: i.id,
  state: i.state,
  title: i.title,
  fingerprint: i.fingerprint,
  muted_by: i.muted_by ?? null,
  priority: i.priority,
}));
check(
  'signal.list 有 session_failures 的停摆信号，标题以 Turns of 3 sessions 开头',
  outage,
  outage?.title,
);
const inhibited = all.filter((i) => i.muted_by === outage?.id);
check(
  '它压住的单会话信号在 signal.list 里是 muted 且 muted_by 指向它',
  inhibited.length > 0 && inhibited.every((i) => i.state === 'muted'),
  inhibited.map((i) => ({ title: i.title, state: i.state })),
);

await page.click({ role: 'button', name: '工程看板', exact: true });
await page.click({ role: 'tab', name: '信号', exact: true });
const rowTitles = (filter) =>
  page.evaluate(
    `[...document.querySelectorAll('.sg-rows [role=option]')].map((r) => r.getAttribute('aria-label'))`,
  );
const listed = await poll(async () => {
  const labels = await rowTitles();
  return labels.some((l) => l.startsWith(outage.title)) ? labels : null;
});
check('信号页的未处理列表里有停摆信号，名字以 signal.list 的 title 开头', listed, listed);
check(
  '对照组：不存在的标题找不到',
  !(await rowTitles()).some((l) => l.startsWith(`${outage.title} absent`)),
);
const nested = await page.evaluate(
  `[...document.querySelectorAll('.sg-sub [role=option]')].map((r) => r.getAttribute('aria-label'))`,
);
check(
  '被压住的单会话信号在停摆信号下的分组里',
  nested.length === inhibited.length &&
    nested.every((l) => inhibited.some((i) => l.startsWith(i.title))),
  nested,
);

// The details panel of the outage.
const rowSel = (title) =>
  `(() => [...document.querySelectorAll('.sg-rows [role=option]')].find((r) => r.getAttribute('aria-label').startsWith(${JSON.stringify(title)})))()`;
await page.evaluate(`${rowSel(outage.title)}.click()`);
const panel = await poll(() =>
  page.evaluate(`(() => {
    const a = document.querySelector('aside.sg-insp[aria-label="信号详情"]');
    if (!a) return null;
    return {
      title: a.querySelector('h2')?.textContent,
      facts: [...a.querySelectorAll('dt')].map((d) => [d.textContent, d.nextElementSibling?.textContent]),
      sections: [...a.querySelectorAll('section')].map((s) => s.getAttribute('aria-label') ?? s.querySelector('.cap')?.textContent),
      history: [...a.querySelectorAll('.sg-hist li')].map((l) => l.textContent),
      sample: a.querySelector('.sg-code')?.textContent ?? null,
      buttons: [...a.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
    };
  })()`),
);
result.panel = panel;
const fact = (label) => panel?.facts.find(([l]) => l === label)?.[1];
check('详情标题等于 signal.list 的 title', panel?.title === outage.title, panel?.title);
check('来源 显示 会话失败', fact('来源') === '会话失败', fact('来源'));
check('指纹 等于 signal.list 的 fingerprint', fact('指纹') === outage.fingerprint, {
  shown: fact('指纹'),
  daemon: outage.fingerprint,
});
check(
  '优先级 显示 打断(crash 升级)',
  fact('优先级') === '打断' && outage.priority === 'interrupt',
  {
    shown: fact('优先级'),
    daemon: outage.priority,
  },
);
check(
  '历史 的条数不少于 signal.list 的 history 条数',
  panel && panel.history.length >= outage.history.length && outage.history.length > 0,
  { shown: panel?.history, daemon: outage.history.map((h) => h.state) },
);
check(
  '示例 显示 signal.list 的最后一条 sample',
  panel?.sample && panel.sample === outage.samples.at(-1),
  { shown: panel?.sample, daemon: outage.samples.at(-1) },
);
check(
  '详情有 由此静音 一段，条数等于被压住的信号数',
  panel?.sections.includes('由此静音') &&
    (await page.evaluate(
      `document.querySelector('#sg-muted-h')?.nextElementSibling?.textContent`,
    )) === String(inhibited.length),
  panel?.sections,
);

// Mute it.
await page.click({ role: 'button', name: '静音', exact: true });
const muted = await poll(async () => {
  const now = (await query('signal.list', { project_id })).find((i) => i.id === outage.id);
  return now?.state === 'muted' && now;
});
check('点 静音 后 signal.list 里它的 state 是 muted', muted, muted?.state);
const gone = await poll(async () => !(await rowTitles()).some((l) => l.startsWith(outage.title)));
check('静音后它离开未处理列表', gone);
await page.click({ role: 'radio', name: '已静音', exact: false });
const inMuted = await poll(async () => {
  const labels = await rowTitles();
  return labels.some((l) => l.startsWith(outage.title)) ? labels : null;
});
check('已静音筛选里有它', inMuted, inMuted);
check(
  '对照组：已静音筛选里没有不存在的标题',
  !(await rowTitles()).some((l) => l.startsWith(`${outage.title} absent`)),
);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
