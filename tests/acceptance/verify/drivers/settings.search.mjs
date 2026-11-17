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
await page.fill(box, 'question rounds');
await delay(0);
const en = await read();
result.english = en;
result.checks.push({
  what: '英文关键词 question rounds 命中 追问轮数，路径 通用 › 摸底',
  ok: en.options.some((o) => o.includes('追问轮数') && o.includes('通用 › 摸底')),
});
await page.fill(box, 'zzqqxx');
const none = await read();
result.checks.push({
  what: '无命中显示 没有匹配的设置',
  ok: none.empty && none.options.length === 0,
});
await page.fill(box, '解释图');
const zh = await read();
result.chinese = zh;
result.checks.push({
  what: 'status 的数字等于 option 数',
  ok: zh.status !== null && zh.status.includes(String(zh.options.length)) && zh.options.length > 0,
});
await page.click({ role: 'option', name: '绘制解释图', exact: false });
const inView = `(() => { const a = document.querySelector('[data-setting-id="general.baselineVisuals"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { top: Math.round(r.top), inView: r.top >= 0 && r.bottom <= innerHeight, flash: a.dataset.flash ?? null }; })()`;
let seen;
for (const end = Date.now() + 3000; Date.now() < end; await delay(100)) {
  seen = await page.evaluate(inView);
  if (seen?.inView) break;
}
result.row = seen;
result.checks.push({
  what: '从 外观 页跳转后 绘制解释图 行滚进视口',
  ok: seen?.inView === true,
  got: seen,
});
const after = await page.evaluate(`(() => ({
  query: document.querySelector('input[role=combobox][aria-label="搜索设置"]').value,
  current: document.querySelector('[aria-current=page]')?.textContent ?? null,
  checked: document.querySelector('input[type=checkbox][aria-label="绘制解释图"]')?.checked,
}))()`);
result.after = after;
const s = await query('app.settings');
result.checks.push({
  what: '跳转后搜索框清空、导航停在 通用',
  ok: after.query === '' && (after.current ?? '').includes('通用'),
});
result.checks.push({
  what: '跳转到的 绘制解释图 开关等于 app.settings.baseline_visuals',
  ok: after.checked === s.baseline_visuals,
});
result.shot = await page.screenshot(result.id);
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
