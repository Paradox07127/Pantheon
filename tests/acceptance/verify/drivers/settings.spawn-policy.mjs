import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 180_000,
});
const result = { id: 'settings.spawn-policy', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

try {
  const NAME = `verify-spawn-${Date.now()}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# spawn policy\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "spawn-policy-fixture", "private": true }\n',
  });
  const policy = () => query('workflow.policy', { project_id });
  // A setting the page leaves alone, so the read back shows it kept.
  await call('workflow.policy.set', { project_id, task_size: 'medium' }, null);
  const before = await policy();
  check('前置：task_size 设成 medium', before.task_size === 'medium', before.task_size);

  // Settings > Projects > the project.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({
    role: 'button',
    name: '项目',
    exact: true,
    within: { name: '设置分区', exact: true },
  });
  if ((await names('所有项目')).some((n) => n.role === 'button'))
    await page.click({ role: 'button', name: '所有项目', exact: true });
  await poll(async () => (await names(NAME)).some((n) => n.role === 'button'));
  await page.click({ role: 'button', name: NAME, exact: false });

  const limit = { role: 'textbox', name: '同时跑的会话数', exact: true };
  await page.waitFor(
    `[...document.querySelectorAll('input')].some((el) => el.getAttribute('aria-label') === '同时跑的会话数' && !el.disabled)`,
    '起会话上限输入框可用',
  );
  check(
    '起会话上限空着时占位是默认值',
    await page.evaluate(
      `[...document.querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === '同时跑的会话数')?.placeholder === String(${before.defaults.max_spawned})`,
    ),
    before.defaults.max_spawned,
  );
  await page.fill(limit, '6');
  await page.press('Enter');
  const limited = await poll(async () => {
    const read = await policy();
    return read.max_spawned === 6 && read;
  });
  check('workflow.policy 读回 max_spawned = 6', limited, limited?.max_spawned);
  check(
    'max_spawned 在项目自己设的字段里',
    limited?.overridden?.includes('max_spawned'),
    limited?.overridden,
  );

  await page.click({ role: 'button', name: '同时跑的会话数回到全局值', exact: true });
  const followed = await poll(async () => {
    const read = await policy();
    return !read.overridden?.includes('max_spawned') && read;
  });
  check(
    '回到全局值后 overridden 里没有 max_spawned',
    followed && !followed.overridden.includes('max_spawned'),
    followed?.overridden,
  );
  check(
    '回到全局值后 max_spawned 是全局值',
    followed?.max_spawned === before.defaults.max_spawned,
    followed?.max_spawned,
  );

  await page.click({ role: 'button', name: '加一条路由', exact: true });
  const kind = { role: 'textbox', name: '种类', exact: true };
  await page.fill(kind, 'backend');
  await page.press('Enter');
  const routed = await poll(async () => {
    const read = await policy();
    return read.kind_routes?.length === 1 && read;
  });
  const route = routed?.kind_routes?.[0];
  check(
    'workflow.policy 读回一条 backend 路由，首选是一个 runtime',
    route?.kind === 'backend' && typeof route.runtime === 'string' && !route.fallbacks,
    route,
  );
  const kindShown = route
    ? await page.evaluate(
        `[...document.querySelectorAll('[role=group]')].find((el) => el.getAttribute('aria-label') === '第 1 条路由')?.querySelector('input')?.value`,
      )
    : null;
  check('界面上路由的种类名和读回的一致', kindShown === route?.kind, kindShown);
  check('没改的 task_size 读回仍是 medium', routed?.task_size === 'medium', routed?.task_size);
  check(
    '没改的 gate_on_fail 读回仍是原值',
    routed?.gate_on_fail === before.gate_on_fail,
    routed?.gate_on_fail,
  );
  check(
    '对照组：没加的 frontend 路由读不到',
    !(routed?.kind_routes ?? []).some((r) => r.kind === 'frontend'),
    routed?.kind_routes,
  );

  await page.evaluate(
    `[...document.querySelectorAll('section')].find((el) => el.getAttribute('aria-label') === '按种类路由')?.scrollIntoView({ block: 'center' }) ?? true`,
  );
  result.shot = await page.screenshot(result.id);
  await page.click({ role: 'button', name: '关闭设置', exact: true });
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
