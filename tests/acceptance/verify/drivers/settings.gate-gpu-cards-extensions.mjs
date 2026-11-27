import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'settings.gate-gpu-cards-extensions', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

try {
  const stamp = Date.now();
  const NAME = `verify-gate-gpu-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# gate gpu\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "gate-gpu-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const projectOf = async () => (await board()).projects.find((p) => p.id === project_id);
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await projectOf()).revision,
  );

  // Settings > Projects > the project.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({
    role: 'button',
    name: '项目',
    exact: true,
    within: { name: '设置分区', exact: true },
  });
  result.all_projects_button = (await names('所有项目')).some((n) => n.role === 'button');
  if (result.all_projects_button)
    await page.click({ role: 'button', name: '所有项目', exact: true });
  // The project list shows no extension sections; the record starts there.
  await poll(async () => (await names(NAME)).some((n) => n.role === 'button'));
  result.before_open = await page.evaluate(
    `[...document.querySelectorAll('[role=group]')].filter((el) => / 工具$/.test(el.getAttribute('aria-label') ?? '') && el.getClientRects().length).length`,
  );

  // (c) Records, from before the project page opens, the most extension sections ever drawn.
  await page.evaluate(`(() => {
    window.__verifyWatch?.disconnect();
    const seen = (window.__verifySections = []);
    const take = () => {
      const g = [...document.querySelectorAll('[role=group]')].find((el) => / 工具$/.test(el.getAttribute('aria-label') ?? '') && el.getClientRects().length);
      const now = g ? (g.getAttribute('aria-busy') === 'true' ? 'busy:' : '') + g.querySelectorAll('section').length : 'none';
      if (seen.at(-1) !== now) {
        seen.push(now);
        // Which page drew it, for the report.
        const h = [...document.querySelectorAll('h1, h2')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim()).slice(0, 2).join('/');
        trail.push(now + ' on ' + h + ' @' + (Date.now() - t0) + 'ms');
      }
    };
    const trail = (window.__verifyTrail = []);
    const t0 = Date.now();
    take();
    const observer = (window.__verifyWatch = new MutationObserver(take));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    setTimeout(() => observer.disconnect(), 8000);
    return true;
  })()`);

  await page.click({ role: 'button', name: NAME, exact: false });

  // (c) The extension sections: settled, and never more drawn than the settled count.
  const sections = await poll(async () => {
    const seen = await page.evaluate('window.__verifySections ?? []');
    const last = seen.at(-1);
    return last && !last.startsWith('busy') && last !== 'none' && seen;
  }, 8000);
  const seen = sections || (await page.evaluate('window.__verifySections ?? []'));
  result.sections_seen = seen;
  result.sections_trail = await page.evaluate('window.__verifyTrail ?? []');
  const counts = seen.map((s) => Number(s.replace('busy:', ''))).filter((n) => !Number.isNaN(n));
  const final = counts.at(-1);
  check(
    '扩展区首次打开：出现过的分节数最大值等于最终分节数(没有五个骨架分节)',
    counts.length > 0 && Math.max(...counts) === final,
    seen,
  );
  check(
    '数据到达前分节数为 0',
    seen.filter((s) => s.startsWith('busy:')).every((s) => s === 'busy:0'),
    seen,
  );
  await page.click({ role: 'button', name: '关闭设置', exact: true });

  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
