import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'settings.gate-gpu-cards-extensions', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

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

  // (a) Settings > Projects > the project: the gate GPU switch.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '项目', exact: true });
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
  const GPU = '门禁命令可使用 GPU';
  const gpuJs = `(() => { const b = [...document.querySelectorAll('input[type=checkbox]')].find((i) => i.getAttribute('aria-label') === ${JSON.stringify(GPU)} && i.getClientRects().length); return b ? { checked: b.checked, disabled: b.disabled } : null; })()`;
  const sw0 = await poll(() => page.evaluate(gpuJs));
  const p0 = await projectOf();
  check('项目页有 "门禁命令可使用 GPU" 开关，默认未选中', sw0 && sw0.checked === false, sw0);
  check('后端对照：Project.gate_gpu 默认不是 true', p0.gate_gpu !== true, p0.gate_gpu ?? null);
  // The first open settles before the switch is clicked; the mark splits the record in two.
  result.first_open = await poll(async () => {
    const seen = await page.evaluate('window.__verifySections ?? []');
    return /^\d+$/.test(seen.at(-1) ?? '') && seen.includes('busy:0') && seen;
  }, 8000);
  await page.evaluate(`window.__verifySections.push('click')`);
  await page.click({ role: 'checkbox', name: GPU, exact: true });
  const on = await poll(async () => (await projectOf()).gate_gpu === true);
  const sw1 = await poll(async () => {
    const s = await page.evaluate(gpuJs);
    return s?.checked && !s.disabled && s;
  });
  check('点一下后 Project.gate_gpu 为 true', on, (await projectOf()).gate_gpu);
  check('点一下后界面为选中', sw1?.checked === true, sw1 || (await page.evaluate(gpuJs)));

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

  // (b) Two setting changes of the same agent: their Apply buttons have different names.
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const idle = () =>
    poll(async () => {
      const s = (await query('session.list', { project_id })).find((x) => x.id === assistant);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const policy0 = await query('workflow.policy', { project_id });
  const wantParallel = policy0.max_parallel === 2 ? 3 : 2;
  const wakeWant =
    (policy0.acceptance_wake ?? 'each_merge') === 'milestone' ? 'each_merge' : 'milestone';
  const QA = `Run ${wantParallel} at a time ${stamp}`;
  const QB = `Wake per milestone ${stamp}`;
  await idle();
  await call(
    'session.send',
    {
      session_id: assistant,
      input: `${QA}. ${QB}.\n${script(
        {
          tool: {
            name: 'propose_setting',
            arguments: { param: 'max_parallel', value: wantParallel, quote: QA },
          },
        },
        {
          tool: {
            name: 'propose_setting',
            arguments: { param: 'acceptance_wake', value: wakeWant, quote: QB },
          },
        },
      )}`,
    },
    (await board()).sessions.find((s) => s.id === assistant).revision,
  );
  await idle();
  const proposals = await poll(async () => {
    const items = (await query('needs_you.list', { project_id })).items.filter(
      (i) => i.kind === 'setting.proposal',
    );
    return items.length === 2 && items;
  }, 20_000);
  check('前置：needs_you.list 有同一个 agent 的两条设置改动', proposals, proposals?.length);
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '总览', exact: true });
  const folded = await poll(
    async () => (await names('还有 ')).find((n) => n.role === 'button'),
    3000,
  );
  if (folded?.name) await page.click({ role: 'button', name: folded.name, exact: true });
  const cards = await poll(async () => {
    const list =
      await page.evaluate(`[...document.querySelectorAll('article')].filter((a) => (a.getAttribute('aria-label') ?? '').includes('提议的设置改动') && a.getClientRects().length).map((a) => ({
      card: a.getAttribute('aria-label'),
      apply: [...a.querySelectorAll('button')].filter((b) => b.textContent.trim() === '应用').map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
    }))`);
    return list.length === 2 && list;
  });
  result.cards = cards;
  const applies = (cards || []).flatMap((c) => c.apply);
  check(
    '两个 "应用" 按钮的可访问名称不同',
    applies.length === 2 && applies[0] !== applies[1],
    applies,
  );
  check(
    '每个 "应用" 名称带本卡的设置名',
    (cards || []).every((c) => {
      const setting = c.card.split('提议的设置改动：')[1];
      return setting && c.apply[0]?.includes(setting);
    }),
    cards,
  );
  check(
    '对照组："应用" 名称不只是 "应用 {agent}"',
    applies.every((a) => a.startsWith('应用') && a.includes('，')),
    applies,
  );
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
