import { open } from '../page.mjs';
const { run, page, query, call, errors, poll } = await open(process.argv[2]);
const result = { id: 'sessions.new-session-zone', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const COMPOSER = '新会话的第一条消息';
const composerShown = () =>
  page.evaluate(
    `[...document.querySelectorAll('textarea, [role=textbox]')].some((el) => el.getClientRects().length && (el.getAttribute('aria-label') ?? '') === ${JSON.stringify(COMPOSER)})`,
  );

// Start away from the new session page, on an existing session.
const AWAY = `verify-zone-away-${Date.now()}`;
await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  input: `${AWAY}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`,
});
await poll(async () =>
  (await query('session.list', { project_id: run.project_id })).some((s) => s.title === AWAY),
);
await page.click({ role: 'button', name: `${AWAY}，fixture`, exact: false });
await poll(async () => !(await composerShown()));
check('对照组：打开已有会话后看不到新会话输入框', !(await composerShown()));

const placed = await page.evaluate(`(() =>
  [...document.querySelectorAll('button[aria-label="新会话"]')]
    .filter((b) => b.getClientRects().length)
    .map((b) => ({
      zone: b.closest('.ss-zh')?.firstElementChild?.textContent ?? null,
      inHeader: !!b.closest('header, [role=banner], .tb, .topbar'),
      inSidebar: !!b.closest('nav.ss-list'),
    })))()`);
result.placed = placed;
check(
  '只有一个可见的 新会话 按钮，在 会话 区标题行上',
  placed.length === 1 && placed[0].zone === '会话' && placed[0].inSidebar,
  placed,
);
check(
  '新会话按钮不在顶栏',
  placed.every((p) => !p.inHeader),
  placed,
);

const before = (await query('session.list', { project_id: run.project_id })).length;
await page.click({ role: 'button', name: '新会话', exact: true });
const shown = await poll(composerShown);
check('点击后进入新会话页，显示第一条消息输入框', shown);
const current = await page.evaluate(
  `document.querySelector('.ss-zh button[aria-label="新会话"]')?.getAttribute('aria-current')`,
);
check('新会话按钮标为当前', current === 'true', current);
const after = (await query('session.list', { project_id: run.project_id })).length;
check('后端对照：只进新会话页，session.list 没有新增会话', after === before, { before, after });
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
