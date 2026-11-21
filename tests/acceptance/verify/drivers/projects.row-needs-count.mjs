import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 120_000,
});
const result = { id: 'projects.row-needs-count', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
// A project with nothing waiting, the control row.
const quiet = await newProject(`verify-quiet-${stamp}`, { 'README.md': '# quiet\n' });

// A permission request in boot's project.
const WAITING = `verify-needs-row-${stamp}`;
const created = await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  permission_mode: 'ask',
  input: `${WAITING}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command: 'echo needs' } } }])}`,
});
const waiting = await poll(async () =>
  (await query('session.list', { project_id: run.project_id })).find(
    (s) => s.id === created.id && s.waiting > 0,
  ),
);
check('前置：boot 项目里的会话在等权限', waiting, waiting?.id);

await page.click({ role: 'button', name: '切换项目', exact: true });
await page.click({ role: 'menuitem', name: '全部项目', exact: false });

// One project row as drawn, read in one pass.
const row = (name) =>
  page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section.pr-row')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(name)} && el.getClientRects().length);
    if (!r) return null;
    const need = [...r.querySelectorAll('.pr-need button')].map((b) => b.textContent.trim()).find((text) => text.startsWith('等你决定：')) ?? null;
    return { need, spark: !!r.querySelector('.pr-spark') };
  })()`);
const needsOf = async (project_id) =>
  (await query('projects.summary')).projects.find((s) => s.project_id === project_id)?.needs_you;
// The summary and the row agree once the page has read the request; both are kept from the same pass.
let boot = null;
let daemon = null;
await poll(async () => {
  daemon = await needsOf(run.project_id);
  boot = await row(run.project_name);
  return boot?.need === `等你决定：${daemon}`;
});
result.boot = { ui: boot, daemon };
check('前置：projects.summary 里 boot 项目的 needs_you 大于 0', daemon > 0, daemon);
check(
  'boot 项目行的 "等你决定：N" 的 N 等于 projects.summary 的 needs_you',
  boot?.need === `等你决定：${daemon}`,
  result.boot,
);
check('对照组：N 加一时判 false', boot?.need !== `等你决定：${daemon + 1}`, boot?.need);
check('boot 项目行没有趋势图（.pr-spark 不存在）', boot && !boot.spark, boot);

const quietRow = await poll(() => row(quiet.name));
const quietNeeds = await needsOf(quiet.project_id);
result.quiet = { ui: quietRow, daemon: quietNeeds };
check('前置：没有等待的项目 needs_you 为 0', quietNeeds === 0, quietNeeds);
check('对照组：没有等待的项目行没有 "等你决定" 按钮', quietRow && quietRow.need === null, quietRow);
result.shot = await page.screenshot(result.id);

// Answers this request, so it does not wait for the drivers after this one.
const item = (await query('needs_you.list')).items.find(
  (i) => i.kind === 'permission' && i.session_id === created.id,
);
if (item)
  await call(
    'approval.respond',
    { approval_id: item.source.id, decision: 'approve' },
    item.source.revision,
  );
const answered = await poll(async () => {
  const s = (await query('session.list', { project_id: run.project_id })).find(
    (x) => x.id === created.id,
  );
  return s && s.waiting === 0;
});
check('收尾：权限请求已处理', answered);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
