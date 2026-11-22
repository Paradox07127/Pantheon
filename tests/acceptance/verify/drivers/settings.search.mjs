import { setTimeout as delay } from 'node:timers/promises';
import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, query, call, errors, reset } = await open(process.argv[2]);
const result = { id: 'settings.search', checks: [] };
const box = { role: 'combobox', name: '搜索设置', exact: true };
await reset();
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '外观', exact: true });
const read = () =>
  page.evaluate(`(() => ({
  status: document.querySelector('.ps-live[role=status]')?.textContent ?? null,
  options: [...document.querySelectorAll('#settings-results [role=option]')].map((o) => o.textContent),
  empty: document.body.innerText.includes('没有匹配的设置'),
}))()`);
await page.fill(box, 'where it stands');
await delay(0);
const en = await read();
result.english = en;
result.checks.push({
  what: '英文关键词 where it stands 命中 会话进度摘要，路径 通用 › 语言与休眠',
  ok: en.options.some((o) => o.includes('会话进度摘要') && o.includes('通用 › 语言与休眠')),
});
await page.fill(box, 'zzqqxx');
const none = await read();
result.checks.push({
  what: '无命中显示 没有匹配的设置',
  ok: none.empty && none.options.length === 0,
});
await page.fill(box, '进度摘要');
const zh = await read();
result.chinese = zh;
result.checks.push({
  what: 'status 的数字等于 option 数',
  ok: zh.status !== null && zh.status.includes(String(zh.options.length)) && zh.options.length > 0,
});
await page.click({ role: 'option', name: '会话进度摘要', exact: false });
const inView = `(() => { const a = document.querySelector('[data-setting-id="general.sessionRecap"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { top: Math.round(r.top), inView: r.top >= 0 && r.bottom <= innerHeight, flash: a.dataset.flash ?? null }; })()`;
let seen;
for (const end = Date.now() + 3000; Date.now() < end; await delay(100)) {
  seen = await page.evaluate(inView);
  if (seen?.inView) break;
}
result.row = seen;
result.checks.push({
  what: '从 外观 页跳转后 会话进度摘要 行滚进视口',
  ok: seen?.inView === true,
  got: seen,
});
const after = await page.evaluate(`(() => ({
  query: document.querySelector('input[role=combobox][aria-label="搜索设置"]').value,
  current: document.querySelector('nav[aria-label="设置分区"] [aria-current=page]')?.textContent ?? null,
  checked: document.querySelector('input[type=checkbox][aria-label="会话进度摘要"]')?.checked,
}))()`);
result.after = after;
const s = await query('app.settings');
result.checks.push({
  what: '跳转后搜索框清空、导航停在 通用',
  ok: after.query === '' && (after.current ?? '').includes('通用'),
});
result.checks.push({
  what: '对照组：同一读法判导航不停在 外观',
  ok: !(after.current ?? '').includes('外观'),
});
result.checks.push({
  what: '跳转到的 会话进度摘要 开关等于 app.settings.session_recap',
  ok: after.checked === (s.session_recap !== false),
});
result.shot = await page.screenshot(result.id);
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
