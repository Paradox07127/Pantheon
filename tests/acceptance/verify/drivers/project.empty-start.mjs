import { open } from '../page.mjs';
const { page, query, errors, poll, newProject } = await open(process.argv[2], { ms: 120_000 });
const result = { id: 'project.empty-start', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-empty-${stamp}`, {
  'README.md': '# project empty\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-empty-fixture", "private": true }\n',
});
const sessions = await query('session.list', { project_id });
const openConductors = sessions.filter(
  (s) => s.conductor && !['closed', 'archived'].includes(s.state),
);
check('后端对照：session.list 里没有开着的主 agent', openConductors.length === 0, sessions.length);

await page.click({ role: 'button', name: '项目', exact: true });
const readPane = () =>
  page.evaluate(`(() => {
    const stat = [...document.querySelectorAll('[aria-label="项目状态"]')].find((e) => e.getClientRects().length);
    if (!stat) return null;
    const root = stat.closest('.tb-pg');
    const visible = (el) => el.getClientRects().length > 0;
    return {
      text: root.innerText,
      start: [...root.querySelectorAll('button')].filter(visible).some((b) => b.textContent.trim() === '开主 agent'),
      composer: [...root.querySelectorAll('textarea')].filter(visible).map((t) => t.getAttribute('aria-label')),
      regions: [...root.querySelectorAll('section[aria-label]')].filter(visible).map((s) => s.getAttribute('aria-label')),
    };
  })()`);
// The main agent is decided once the resident read lands: wait for the start button or a composer.
const pane =
  (await poll(async () => {
    const v = await readPane();
    return v && (v.start || v.composer.length > 0) && v;
  }, 10_000)) || (await readPane());
result.pane = pane && { ...pane, text: pane.text.slice(0, 400) };
check(
  '主栏写 "这个项目还没有主 agent。"',
  pane?.text.includes('这个项目还没有主 agent。'),
  result.pane?.text,
);
check('有按钮 "开主 agent"', pane?.start, pane?.start);
check('没有输入框', pane?.composer.length === 0, pane?.composer);
check('没有 region "Agent"', pane && !pane.regions.includes('Agent'), pane?.regions);
check(
  '对照组：同一读法找得到 region "项目介绍"',
  pane?.regions.includes('项目介绍'),
  pane?.regions,
);
result.shot = await page.screenshot(result.id);

await page.click({ role: 'button', name: '开主 agent', exact: true });
const toggle = () =>
  page.evaluate(`(() => {
    const composer = [...document.querySelectorAll('textarea[aria-label="新会话的第一条消息"]')].some((t) => t.getClientRects().length);
    const b = [...document.querySelectorAll('button[aria-label="主 agent"]')].find((x) => x.getClientRects().length);
    return { composer, pressed: b?.getAttribute('aria-pressed') ?? null };
  })()`);
const after =
  (await poll(async () => {
    const v = await toggle();
    return v.composer && v.pressed === 'true' && v;
  }, 10_000)) || (await toggle());
result.after = after;
check('点按钮后切到新会话页', after.composer, after);
check('新会话页的主 agent 开关 aria-pressed 为 true', after.pressed === 'true', after.pressed);
check('对照组：开关读法对 "false" 判 false', after.pressed !== 'false', after.pressed);
const stillNone = (await query('session.list', { project_id })).filter((s) => s.conductor);
check('后端对照：只点按钮不建会话', stillNone.length === 0, stillNone.length);
result.shot2 = await page.screenshot(`${result.id}-new`);

// Leaves the toggle off so later drivers start a plain session; other drivers' toasts may cover it.
await page.evaluate(
  `[...document.querySelectorAll('button[aria-label="主 agent"]')].find((x) => x.getClientRects().length)?.click()`,
);
const off = await poll(async () => (await toggle()).pressed === 'false');
check('收尾：主 agent 开关关回', off, (await toggle()).pressed);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
