import { setTimeout as delay } from 'node:timers/promises';
import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, query, call, errors, poll, reset } = await open(process.argv[2]);
await reset();
const result = { id: 'settings.general-baseline', checks: [] };
const settings = () => query('app.settings');
const until = async (pred, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await delay(200)) {
    const s = await settings();
    if (pred(s)) return s;
  }
  return settings();
};
// A known starting point, so each run can step the rounds down once.
await call('app.settings.set', {
  baseline_rounds: 3,
  baseline_visuals: true,
  baseline_range_story: true,
});
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '通用', exact: true });
const ui = () =>
  page.evaluate(`(() => {
  const g = document.querySelector('[role=group][aria-label="追问轮数"]');
  const box = (n) => document.querySelector('input[type=checkbox][aria-label="' + n + '"]')?.checked;
  return { rounds: g ? Number(g.querySelector('output').textContent) : null, visuals: box('绘制解释图'), story: box('确认时解读近期历史') };
})()`);
const s0 = await settings();
// The rows render once the page's settings read returns.
const u0 =
  (await poll(async () => {
    const u = await ui();
    return u.rounds !== null && u;
  })) || (await ui());
result.before = {
  daemon: { r: s0.baseline_rounds, v: s0.baseline_visuals, s: s0.baseline_range_story },
  ui: u0,
};
result.checks.push({
  what: '初始轮数等于 app.settings.baseline_rounds',
  ok: u0.rounds === s0.baseline_rounds,
});
result.checks.push({
  what: '初始开关等于 baseline_visuals / baseline_range_story',
  ok: u0.visuals === s0.baseline_visuals && u0.story === s0.baseline_range_story,
});
await page.click({ role: 'button', name: '减少轮数', exact: true });
const s1 = await until((s) => s.baseline_rounds === s0.baseline_rounds - 1);
const u1 =
  (await poll(async () => {
    const u = await ui();
    return u.rounds === s1.baseline_rounds && u;
  })) || (await ui());
result.checks.push({
  what: '减少轮数后 daemon 轮数减 1',
  ok: s1.baseline_rounds === s0.baseline_rounds - 1,
  got: s1.baseline_rounds,
});
result.checks.push({
  what: '减少轮数后界面轮数等于 daemon',
  ok: u1.rounds === s1.baseline_rounds,
  got: u1.rounds,
});
await page.click({ role: 'checkbox', name: '绘制解释图', exact: true });
const s2 = await until((s) => s.baseline_visuals === !s0.baseline_visuals);
const u2 =
  (await poll(async () => {
    const u = await ui();
    return u.visuals === s2.baseline_visuals && u;
  })) || (await ui());
result.checks.push({
  what: '切换绘制解释图后 daemon 翻转',
  ok: s2.baseline_visuals === !s0.baseline_visuals,
  got: s2.baseline_visuals,
});
result.checks.push({ what: '切换后界面开关等于 daemon', ok: u2.visuals === s2.baseline_visuals });
result.shot = await page.screenshot(result.id);
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
