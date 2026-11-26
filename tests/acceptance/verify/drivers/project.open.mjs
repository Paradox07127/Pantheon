import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.open', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-open-${stamp}`, {
  'README.md': '# project open\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-open-fixture", "private": true }\n',
});
const create = (title, steps) =>
  call('session.create', {
    project_id,
    runtime: 'fixture',
    workspace: 'worktree',
    input: `${title}\nfixture-script\n${JSON.stringify(steps)}`,
  });
// One session each: waiting on the user, running, a failed turn, and one that commits and lands.
await create(`verify-open-ask-${stamp}`, [{ ask: { tool: 'Bash', input: { command: 'ls' } } }]);
await create(`verify-open-hang-${stamp}`, [{ hang: true }]);
await create(`verify-open-fail-${stamp}`, [{ fail: 'boom' }]);
const LAND = `verify-open-land-${stamp}`;
const land = await create(LAND, [
  { write: { path: 'src/landed.ts', text: `export const landed = ${stamp};\n` } },
  { commit: `land ${stamp}` },
  { say: 'done' },
]);
const ready = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === land.id);
  return s?.state === 'ready' && s;
}, 30_000);
check('前置：落地用的会话回合跑完、有提交', ready?.ahead > 0, ready && { state: ready.state });
const revision = (await query('board', { project_id })).sessions.find(
  (s) => s.id === land.id,
)?.revision;
try {
  await call('session.merge', { session_id: land.id }, revision);
} catch (error) {
  result.mergeError = String(error.message).slice(0, 500);
}

// Settled when the summary has each kind and the plan has the landing.
const settled = await poll(async () => {
  const summary = (await query('projects.summary')).projects.find(
    (p) => p.project_id === project_id,
  );
  const plan = await query('project.plan', { project_id });
  return (
    summary?.needs_you > 0 &&
    summary.counts.running > 0 &&
    summary.merged_today > 0 &&
    plan.latest_landing && { summary, plan }
  );
}, 60_000);
const summary = settled?.summary;
const latest = settled?.plan?.latest_landing;
result.summary = summary;
result.latest_landing = latest;
check('前置：projects.summary 有等你、在跑、今天落地', settled, summary);

await page.click({ role: 'button', name: '项目', exact: true });
const readScreen = () =>
  page.evaluate(`(() => {
    const stat = [...document.querySelectorAll('[aria-label="项目状态"]')].find((e) => e.getClientRects().length);
    if (!stat) return null;
    const page = stat.closest('.tb-pg');
    const nav = [...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && b.textContent.trim() === '项目');
    return {
      title: page?.querySelector('h1')?.textContent.trim() ?? null,
      current: nav?.getAttribute('aria-current') ?? null,
      cells: [...stat.querySelectorAll('.pj-k')].map((c) => ({
        k: c.querySelector('.cap')?.textContent.trim(),
        v: c.querySelector('.kpi')?.textContent.trim(),
        text: c.textContent.replace(/\\s+/g, ' ').trim(),
      })),
      other: [...stat.children].filter((c) => !c.classList.contains('pj-k')).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
    };
  })()`);
const shown =
  (await poll(async () => {
    const v = await readScreen();
    const landed = v?.cells.find((c) => c.k === '今天落地');
    return v && landed?.v === String(summary?.merged_today) && v;
  }, 15_000)) || (await readScreen());
result.shown = shown;
check('主区标题 "项目"', shown?.title === '项目', shown?.title);
check('"项目" 按钮 aria-current="page"', shown?.current === 'page', shown?.current);
const KEYS = ['在跑', '等你', '可落地', '失败', '今天落地'];
check(
  '状态头依次有 在跑/等你/可落地/失败/今天落地',
  JSON.stringify(shown?.cells.slice(0, 5).map((c) => c.k)) === JSON.stringify(KEYS),
  shown?.cells.map((c) => c.k),
);
const value = (k) => shown?.cells.find((c) => c.k === k)?.v;
const expected = summary && {
  在跑: summary.counts.running,
  等你: summary.needs_you,
  可落地: summary.counts.ready,
  失败: summary.counts.failed,
  今天落地: summary.merged_today,
};
check(
  '后端对照：各格数字等于 projects.summary',
  expected && Object.entries(expected).every(([k, n]) => value(k) === String(n)),
  { shown: shown?.cells, expected },
);
check(
  '对照组：同一读法对错的 "在跑" 值判 false',
  expected && value('在跑') !== String(expected.在跑 + 1),
  value('在跑'),
);
const waitingCell = shown?.cells.find((c) => c.k === '等你');
check('有等你的项时 "等你" 格旁写 "最久 N"', /最久/.test(waitingCell?.text ?? ''), waitingCell);
const landingCell = shown?.cells.find((c) => c.k === '最近落地');
const landingText = landingCell?.text ?? shown?.other.find((t) => t.includes('最近落地'));
result.landingText = landingText;
check(
  '后端对照："最近落地" 格有 latest_landing 的 7 位短 sha 和标题',
  latest &&
    landingText?.includes(String(latest.sha ?? latest.commit ?? '').slice(0, 7)) &&
    landingText.includes(latest.title ?? LAND),
  { landingText, latest },
);
check(
  '对照组："最近落地" 格不含 8 位 sha',
  latest && !landingText?.includes(String(latest.sha ?? latest.commit ?? '').slice(0, 8)),
  landingText,
);
result.shot = await page.screenshot(result.id);

// Mounted once: a marker on the status element survives a trip to the sessions screen.
const MARK = `mark-${stamp}`;
await page.evaluate(
  `[...document.querySelectorAll('[aria-label="项目状态"]')].find((e) => e.getClientRects().length).dataset.verifyMark = ${JSON.stringify(MARK)}`,
);
await page.click({ role: 'button', name: '新会话', exact: true });
const left = await poll(
  () =>
    page.evaluate(
      `![...document.querySelectorAll('[aria-label="项目状态"]')].some((e) => e.getClientRects().length)`,
    ),
  5_000,
);
check('切到会话屏后状态头不可见', left, left);
await page.click({ role: 'button', name: '项目', exact: true });
const back = await poll(
  () =>
    page.evaluate(
      `[...document.querySelectorAll('[aria-label="项目状态"]')].find((e) => e.getClientRects().length)?.dataset.verifyMark ?? null`,
    ),
  5_000,
);
check('切回后项目屏没有重新挂载(标记还在)', back === MARK, back);
check('对照组：标记读法对别的值判 false', back !== `${MARK}-absent`, back);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
