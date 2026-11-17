import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, query, call, errors, poll, names, reset } = await open(process.argv[2]);
const result = { id: 'diagnosis.ask-agent-route', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const debugSessions = async () =>
  (await query('session.list', { project_id: run.project_id })).filter(
    (s) => s.app_debug && !s.archived_at,
  );

// Ask agent takes the project's default runtime, else claude; this daemon has only the fixture.
const project = (await query('board')).projects.find((p) => p.id === run.project_id);
if (project.session_defaults?.runtime !== 'fixture')
  await call(
    'project.sessionDefaults.set',
    { project_id: run.project_id, runtime: 'fixture', permission_mode: 'ask' },
    project.revision,
  );
// A fresh start: no live diagnosis session in the boot project.
for (const s of await debugSessions()) {
  const { revision } = (await query('board')).sessions.find((b) => b.id === s.id);
  await call('session.archive', { session_id: s.id }, revision);
}
const before = await debugSessions();
check('对照组：点击前 boot 项目没有 app_debug 会话', before.length === 0, before.length);

// A saved theme the page still lists after the daemon deleted it, so picking it fails.
const LABEL = `verify-${Date.now()}`;
const { theme_id } = await call('theme.set', {
  label: LABEL,
  light: { anchors: { 'surface-0': '#ffffff', 'text-primary': '#111111' } },
});
await call('theme.apply', { theme_id: null });
await reset();
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '外观', exact: true });
await page.waitFor(
  `[...document.querySelectorAll('button.ps-thc')].some((b) => b.textContent.includes(${JSON.stringify(LABEL)}))`,
  'the saved theme card to show',
);
await call('theme.delete', { theme_id });
await page.click({ role: 'button', name: LABEL, exact: false });
const ask = await poll(async () => {
  const found = await names('问 agent');
  return found.length ? found : null;
});
result.askNames = ask;
check('失败 toast 有 问 agent 按钮', ask?.length >= 1, ask);
await page.click({ role: 'button', name: '问 agent', exact: true });

const listed = await poll(async () => {
  const all = await debugSessions();
  return all.length ? all : null;
}, 20_000);
const session = listed?.[0];
result.session = session && {
  id: session.id,
  workspace_kind: session.workspace_kind,
  permission_mode: session.permission_mode,
  state: session.state,
};
result.debugErrors = await page.evaluate(
  `window.__pantheonAppErrors.slice(-3).map((e) => [e.command, e.code, e.message].join(' '))`,
);
check('点击后 session.list 多了一个 app_debug 会话', listed?.length === 1, listed?.length);
check(
  '它的 workspace_kind 是 in_place',
  session?.workspace_kind === 'in_place',
  session?.workspace_kind,
);
check(
  '它的 permission_mode 是 plan',
  session?.permission_mode === 'plan',
  session?.permission_mode,
);
check('对照组：permission_mode 不是 ask', session && session.permission_mode !== 'ask');
const sent = await poll(() => page.evaluate(`document.body.innerText.includes('已发给调试会话')`));
check('toast 显示 已发给调试会话', sent);
result.shot = await page.screenshot(result.id);
await reset();
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
