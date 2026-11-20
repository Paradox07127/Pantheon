import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { ATTENTION_KINDS, DEFAULT_ATTENTION_DELIVERY } from '@pantheon/protocol';
import { open } from '../page.mjs';
const runDir = process.argv[2];
let { page, query, call, errors, poll } = await open(runDir);
const result = { id: 'settings.notifications', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Each rule key's row name and each delivery's choice name (zh-CN/notifications.json).
const NAME = {
  plan_change: '计划变更',
  question: '问题',
  repeated_failure: '失败两次',
  permission: '权限请求',
  milestone_accept: '待验收的里程碑',
  budget: '预算',
  improvement: '改进',
  external: '外部审批',
  other: '其他',
  merged: '已合并',
};
const CHOICE = { now: '立即', brief: '仅简报', never: '从不' };
// The rule keys the page lists: the interface offers no agent proposal.
const SHOWN = ATTENTION_KINDS.filter((k) => k !== 'agent_proposal');
const OVERDUE = '等了超过 4 小时的问题';

// The daemon's own values before this run writes any: those it has when no rule is stored.
const first = await query('app.settings');
check(
  '默认：待验收的里程碑、新 agent、已合并为 brief，其余为 now',
  ATTENTION_KINDS.every(
    (k) =>
      first.attention_delivery[k] ===
      (['milestone_accept', 'agent_proposal', 'merged'].includes(k) ? 'brief' : 'now'),
  ),
  first.attention_delivery,
);
check(
  '对照组：同一读法对"已合并为 now"判 false',
  !(first.attention_delivery.merged === 'now'),
  first.attention_delivery.merged,
);
await call('app.settings.set', {
  attention_delivery: DEFAULT_ATTENTION_DELIVERY,
  quiet_hours: null,
});

// Every radio group on the page: its name, its choices and the checked one.
const groups = () =>
  page.evaluate(`[...document.querySelectorAll('.ps-rows [role=radiogroup]')]
    .filter((g) => g.getClientRects().length)
    .map((g) => ({
      name: g.getAttribute('aria-label'),
      choices: [...g.querySelectorAll('[role=radio]')].map((r) => r.textContent.trim()),
      checked: [...g.querySelectorAll('[role=radio]')]
        .filter((r) => r.getAttribute('aria-checked') === 'true')
        .map((r) => r.textContent.trim()),
      disabled: g.hasAttribute('data-disabled') || g.getAttribute('aria-disabled') === 'true',
    }))`);
const field = (name) =>
  page.evaluate(
    `document.querySelector(${JSON.stringify(`input[aria-label="${name}"]`)})?.value ?? null`,
  );
const openPage = async () => {
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '通知', exact: true });
  return poll(async () => {
    const g = await groups();
    return g.length > SHOWN.length && g.every((x) => x.checked.length === 1) && g;
  });
};
const shownAs = (list, settings) =>
  SHOWN.every(
    (k) =>
      list.find((g) => g.name === NAME[k])?.checked[0] === CHOICE[settings.attention_delivery[k]],
  );

const shown = await openPage();
const kindRows = (shown || []).filter((g) => g.name !== OVERDUE);
check(
  '每个决定种类加 "已合并" 各一行',
  kindRows.length === SHOWN.length &&
    SHOWN.every((k) => kindRows.filter((g) => g.name === NAME[k]).length === 1),
  kindRows.map((g) => g.name),
);
check(
  '每行的选择是 立即 / 仅简报 / 从不',
  kindRows.length > 0 && kindRows.every((g) => g.choices.join('/') === '立即/仅简报/从不'),
  kindRows.map((g) => g.choices),
);
const start = await query('app.settings');
check('每行选中的值等于 app.settings 的 attention_delivery', shown && shownAs(shown, start), {
  ui: kindRows.map((g) => [g.name, g.checked[0]]),
});
check(
  '对照组：把已合并当成 now，同一读法判 false',
  !(
    shown && shownAs(shown, { attention_delivery: { ...start.attention_delivery, merged: 'now' } })
  ),
);
check(
  '界面上 待验收的里程碑、已合并 选中 仅简报',
  ['milestone_accept', 'merged'].every(
    (k) => kindRows.find((g) => g.name === NAME[k])?.checked[0] === '仅简报',
  ),
);
result.shot = await page.screenshot('pair-notifications');
copyFileSync(
  path.join(runDir, result.shot.file),
  path.join(runDir, 'screens', 'pair-notifications.png'),
);

// Change two rows; the daemon stores each kind and leaves the rest.
await page.click({
  role: 'radio',
  name: '从不',
  exact: true,
  within: { role: 'radiogroup', name: NAME.permission, exact: true },
});
const afterPermission = await poll(async () => {
  const s = await query('app.settings');
  return s.attention_delivery.permission === 'never' && s;
});
check('选 权限请求=从不 后 app.settings 的 permission 是 never', afterPermission);
await page.click({
  role: 'radio',
  name: '仅简报',
  exact: true,
  within: { role: 'radiogroup', name: NAME.plan_change, exact: true },
});
const afterPlan = await poll(async () => {
  const s = await query('app.settings');
  return s.attention_delivery.plan_change === 'brief' && s;
});
check('选 计划变更=仅简报 后 app.settings 的 plan_change 是 brief', afterPlan);
check(
  '其他种类不变',
  afterPlan &&
    ATTENTION_KINDS.filter((k) => k !== 'permission' && k !== 'plan_change').every(
      (k) => afterPlan.attention_delivery[k] === DEFAULT_ATTENTION_DELIVERY[k],
    ) &&
    afterPlan.attention_delivery.permission === 'never',
  afterPlan?.attention_delivery,
);

// Quiet hours: a start typed alone pairs with the placeholder end; then an end.
const typeTime = async (name, text) => {
  await page.click({ role: 'textbox', name, exact: true });
  await page.press('a', ['Meta']);
  await page.press('Backspace');
  if (text) await page.fill({ role: 'textbox', name, exact: true }, text);
  await page.press('Enter');
};
await typeTime('开始', '23:00');
const q1 = await poll(
  async () =>
    (await query('app.settings')).quiet_hours?.from === '23:00' &&
    (await query('app.settings')).quiet_hours,
);
check('填开始 23:00 后 quiet_hours 是 23:00–08:00', q1?.from === '23:00' && q1?.to === '08:00', q1);
await typeTime('结束', '07:30');
const q2 = await poll(async () => {
  const q = (await query('app.settings')).quiet_hours;
  return q?.to === '07:30' && q;
});
check('填结束 07:30 后 quiet_hours 是 23:00–07:30', q2?.from === '23:00' && q2?.to === '07:30', q2);
const fields = (await poll(async () => {
  const f = { from: await field('开始'), to: await field('结束') };
  return f.from === '23:00' && f.to === '07:30' && f;
})) || { from: await field('开始'), to: await field('结束') };
check('输入框显示 23:00 和 07:30', fields.from === '23:00' && fields.to === '07:30', fields);

// Reload: the page shows what the daemon stored.
await page.evaluate('window.__beforeReload = true');
try {
  await page.evaluate('location.reload()');
} catch {
  // The reload ends this connection.
}
page.close();
({ page, query, call, errors, poll } = await open(runDir));
check(
  '前置：页面确实重新加载了',
  (await page.evaluate('window.__beforeReload === undefined')) === true,
);
const reloaded = await openPage();
const stored = await query('app.settings');
check(
  '刷新后每行选中的值等于 app.settings（权限请求=从不、计划变更=仅简报）',
  reloaded &&
    shownAs(reloaded, stored) &&
    reloaded.find((g) => g.name === NAME.permission)?.checked[0] === '从不' &&
    reloaded.find((g) => g.name === NAME.plan_change)?.checked[0] === '仅简报',
  reloaded && reloaded.filter((g) => g.name !== OVERDUE).map((g) => [g.name, g.checked[0]]),
);
const fieldsAfter = { from: await field('开始'), to: await field('结束') };
check(
  '刷新后勿扰时段显示 23:00 到 07:30',
  fieldsAfter.from === '23:00' && fieldsAfter.to === '07:30',
  fieldsAfter,
);

// Clear quiet hours with its button: the setting leaves the app settings.
await page.click({ role: 'button', name: '清除勿扰时段', exact: true });
const cleared = await poll(async () => {
  const s = await query('app.settings');
  return !('quiet_hours' in s) && s;
});
check(
  '点 清除勿扰时段 后 app.settings 没有 quiet_hours',
  cleared,
  (await query('app.settings')).quiet_hours,
);
const emptied = await poll(async () => {
  const f = { from: await field('开始'), to: await field('结束') };
  return f.from === '' && f.to === '' && f;
});
check('清除后两个输入框为空', emptied, { from: await field('开始'), to: await field('结束') });
check(
  '对照组：清除后 清除勿扰时段 按钮不在',
  !(await page.evaluate(`!!document.querySelector('button[aria-label="清除勿扰时段"]')`)),
);

// Emptying a time clears them too.
await typeTime('开始', '22:30');
const q3 = await poll(async () => (await query('app.settings')).quiet_hours);
check('再填开始 22:30 后有 quiet_hours', q3?.from === '22:30', q3);
await typeTime('开始', '');
const cleared2 = await poll(async () => !('quiet_hours' in (await query('app.settings'))));
check(
  '清空开始后 app.settings 没有 quiet_hours',
  cleared2,
  (await query('app.settings')).quiet_hours,
);

await call('app.settings.set', {
  attention_delivery: DEFAULT_ATTENTION_DELIVERY,
  quiet_hours: null,
});
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
