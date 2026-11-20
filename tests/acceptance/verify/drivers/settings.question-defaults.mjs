import { open } from '../page.mjs';
const { page, query, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 150_000,
});
const result = { id: 'settings.question-defaults', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const NAME = `verify-question-defaults-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# question defaults\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "question-defaults-fixture", "private": true }\n',
  });
  const policy0 = await query('workflow.policy', { project_id });
  check('前置：提问期限默认关', !policy0.question_defaults, policy0.question_defaults ?? null);

  // 1. Settings > Projects > the project.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '项目', exact: true });
  if ((await names('所有项目')).some((n) => n.role === 'button'))
    await page.click({ role: 'button', name: '所有项目', exact: true });
  await page.click({ role: 'button', name: NAME, exact: false });
  const QD = '可撤回的提问在 N 小时后采用 lead 推荐的答案';
  const toggle = () =>
    page.evaluate(
      `[...document.querySelectorAll('input[type=checkbox]')].find((e) => e.getClientRects().length && e.getAttribute('aria-label') === ${JSON.stringify(QD)})?.checked ?? null`,
    );
  const shown = await poll(async () => {
    const checked = await toggle();
    return checked !== null && { checked };
  });
  check('提问期限开关显示关(与 workflow.policy 一致)', shown?.checked === false, shown);

  // 2. The question deadline.
  await page.click({ role: 'checkbox', name: QD, exact: true });
  const qd = await poll(
    async () => (await query('workflow.policy', { project_id })).question_defaults,
  );
  check(
    '打开开关后 workflow.policy 的 question_defaults.after_hours 是 24',
    qd?.after_hours === 24,
    qd,
  );
  const hours = await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === '小时数' && i.getClientRects().length)?.value ?? null`,
    ),
  );
  check('开关后出现 "小时数"，值为 24', hours === '24', hours);
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
