import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'changes.quality-strip', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-quality-${stamp}`, {
  'README.md': '# quality\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "quality-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
const projectRevision = async () =>
  (await board()).projects.find((p) => p.id === project_id).revision;
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await projectRevision(),
);
const ROOT = (await query('project.read', { project_id })).project?.roots?.[0] ?? repo;
// A step that passes only while a flag file outside the repository exists: it flips on one commit.
const FLAG = path.join(run.workspace, `quality-flag-${stamp}`);
await call(
  'project.gate.set',
  {
    project_id,
    root: ROOT,
    commands: [
      { name: 'pass-step', argv: ['sh', '-c', 'exit 0'] },
      { name: 'flag-step', argv: ['sh', '-c', `test -f '${FLAG}'`] },
    ],
  },
  await projectRevision(),
);

const done = (s) => s?.last_turn && !['queued', 'running'].includes(s.last_turn.state);
const session = async (title, file) => {
  const created = await call('session.create', {
    project_id,
    runtime: 'fixture',
    workspace: 'worktree',
    input: `${title}\nfixture-script\n${JSON.stringify([
      { write: { path: file, text: `export const v = ${stamp};\n` } },
      { commit: `add ${file}` },
      { say: 'done' },
    ])}`,
  });
  return poll(async () => {
    const s = (await query('session.list', { project_id })).find((x) => x.id === created.id);
    return done(s) && s;
  }, 60_000);
};
const runs = async (session_id) =>
  (await query('session.gates.history', { session_id })).runs ?? [];
// Runs the session's gates once and waits for that run to finish.
const runGates = async (session_id) => {
  // A run the turn's end started finishes first.
  await poll(async () => !(await query('session.gates', { session_id })).running, 30_000);
  const before = (await runs(session_id)).length;
  const rev = (await board()).sessions.find((s) => s.id === session_id).revision;
  await call('session.gates.run', { session_id }, rev);
  return poll(async () => {
    const g = await query('session.gates', { session_id });
    const list = await runs(session_id);
    return !g.running && list.length > before && list[0];
  }, 60_000);
};

// Session one: fails on flag-step first, then passes on the same commit.
rmSync(FLAG, { force: true });
const one = await session(`verify-quality-one-${stamp}`, 'src/one.ts');
const oneFirst = await runGates(one.id);
writeFileSync(FLAG, 'on\n');
const oneSecond = await runGates(one.id);
// Session two passes first time.
const two = await session(`verify-quality-two-${stamp}`, 'src/two.ts');
await runGates(two.id);
check(
  '前置：会话一先失败后通过，提交相同',
  oneFirst?.results?.some((r) => r.name === 'flag-step' && r.exit_code !== 0) &&
    oneSecond?.results?.every((r) => r.exit_code === 0) &&
    oneFirst.commit === oneSecond.commit,
  { first: oneFirst?.results, second: oneSecond?.results },
);

// A branch landing, whose gate run joins the project's gate history.
const BRANCH = `verify-land-${stamp}`;
const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => execFileSync('git', args, { cwd: repo, env });
git('checkout', '-q', '-b', BRANCH);
writeFileSync(path.join(repo, 'src/landed.ts'), `export const landed = ${stamp};\n`);
git('add', '-A');
git('commit', '-q', '-m', 'add landed');
git('checkout', '-q', 'main');
await call('project.land', { root: ROOT, branch: BRANCH });
const history = await poll(async () => {
  const h = await query('project.gates.history', { project_id, limit: '100' });
  return h.runs.some((r) => r.landing_id) && h;
}, 90_000);
const landingRun = history?.runs?.find((r) => r.landing_id);
check('前置：project.gates.history 里有这次分支落地的运行', landingRun, {
  runs: history?.runs?.map((r) => ({
    run: r.run_id,
    session: r.session_id,
    landing: r.landing_id,
    branch: r.branch,
  })),
});
existsSync(FLAG) && rmSync(FLAG, { force: true });

// Figures computed from the two queries, as the strip's model is documented.
const runsAll = (await query('project.gates.history', { project_id, limit: '100' })).runs;
const metrics = await query('project.review.metrics', { project_id });
result.daemon = { runs: runsAll.length, metrics };
const failing = (r) =>
  r.state === 'failed' ||
  r.state === 'timed_out' ||
  (r.state === undefined && (r.timed_out || r.exit_code !== 0));
const stepState = (r) =>
  r.state ?? (r.timed_out ? 'timed_out' : r.exit_code === 0 ? 'passed' : 'failed');
const first = new Map();
for (const r of runsAll) first.set(r.landing_id ?? r.session_id ?? r.run_id, r);
const owners = [...first.values()];
const passed = owners.filter((r) => !r.results.some(failing)).length;
const seen = new Map();
for (const r of runsAll.slice(0, 30)) {
  if (!r.commit) continue;
  for (const s of r.results) {
    if (stepState(s) === 'skipped') continue;
    const key = `${s.name}\0${s.command.join(' ')}`;
    const by = seen.get(key) ?? { name: s.name, by: new Map() };
    seen.set(key, by);
    const outcomes = by.by.get(r.commit) ?? new Set();
    by.by.set(r.commit, outcomes.add(failing(s) ? 'failed' : 'passed'));
  }
}
const flaky = [...seen.values()]
  .filter((s) => [...s.by.values()].some((o) => o.size === 2))
  .map((s) => s.name);
const expectedPercent = owners.length ? `${Math.round((passed / owners.length) * 100)}%` : '—';
result.expected = { passed, total: owners.length, percent: expectedPercent, flaky };
check(
  '前置：计算出的数字不是退化值(两次会话一次落地，首次通过 2/3，flag-step 时过时不过)',
  passed === 2 && owners.length === 3 && flaky.length === 1 && flaky[0] === 'flag-step',
  result.expected,
);

// Opens the Changes screen.
const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
const strip = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section.cq')].find((e) => e.getClientRects().length && e.getAttribute('aria-label') === '质量');
    if (!s) return null;
    const part = (name) => [...s.querySelectorAll('[role=group]')].find((g) => g.getAttribute('aria-label') === name);
    const fp = part('门禁首次通过');
    const fl = part('时过时不过的步骤');
    const hist = part('门禁历史');
    const tracker = hist?.querySelector('.ql-gt');
    const ad = part('各评审方的采纳率');
    return {
      busy: s.getAttribute('aria-busy'),
      firstPass: fp?.querySelector('.cq-v b')?.textContent ?? null,
      firstPassCount: fp?.querySelector('.cq-n')?.textContent ?? null,
      flakyCount: fl?.querySelector('.cq-v > b')?.textContent ?? null,
      flaky: fl ? [...fl.querySelectorAll('.cq-flaky li')].map((li) => li.textContent) : null,
      history: tracker?.getAttribute('aria-label') ?? null,
      rows: hist ? [...hist.querySelectorAll('.ql-gtn span')].map((e) => e.textContent) : null,
      cells: hist ? [...hist.querySelectorAll('.ql-tc')].map((c) => ({ label: c.getAttribute('aria-label'), button: c.tagName === 'BUTTON' })) : null,
      adoption: ad ? ad.textContent.replace('各评审方的采纳率', '').trim() : null,
      reviewers: ad ? [...ad.querySelectorAll('.cq-rr')].length : null,
    };
  })()`);
const shown = await poll(async () => {
  const v = await strip();
  return v && !v.busy && v.history && v.firstPassCount && v;
}, 20_000);
result.shown = shown;
check('首次通过率等于由 project.gates.history 算出的值', shown?.firstPass === expectedPercent, {
  shown: shown?.firstPass,
  expected: expectedPercent,
});
check('首次通过计数等于 "通过 / 总数"', shown?.firstPassCount === `${passed} / ${owners.length}`, {
  shown: shown?.firstPassCount,
  expected: `${passed} / ${owners.length}`,
});
check(
  '时过时不过的步骤数和名字等于算出的值',
  shown?.flakyCount === String(flaky.length) &&
    JSON.stringify(shown?.flaky) === JSON.stringify(flaky),
  { shown: [shown?.flakyCount, shown?.flaky], expected: flaky },
);
const columns = Math.min(runsAll.length, 30);
check(
  '门禁历史的列数等于 project.gates.history 的运行数',
  shown?.history === `门禁历史，最近 ${columns} 次运行`,
  { shown: shown?.history, runs: runsAll.length },
);
check(
  '门禁历史有分支落地的列(格子名含分支名)',
  shown?.cells?.some((c) => c.label?.includes(BRANCH)),
  shown?.cells?.map((c) => c.label),
);
check(
  '对照组：格子名里没有不存在的分支',
  !shown?.cells?.some((c) => c.label?.includes(`${BRANCH}-absent`)),
  null,
);
check(
  '采纳率：project.review.metrics 为空时显示 "—" 且没有评审方行',
  metrics.length === 0 && shown?.adoption === '—' && shown?.reviewers === 0,
  { metrics, shown: shown?.adoption, reviewers: shown?.reviewers },
);

// The landing's column opens its change when the list still shows it.
const landingRow = (await query('project.changes', { project_id })).changes.find(
  (c) => c.id === `landing:${landingRun?.landing_id}`,
);
result.landingRow = landingRow && { id: landingRow.id, title: landingRow.title };
const landingCell = shown?.cells?.find((c) => c.label?.includes(BRANCH));
check(
  '落地列在改动列表有这一行时是按钮',
  landingRow ? landingCell?.button === true : landingCell?.button === false,
  { listed: Boolean(landingRow), cell: landingCell },
);
result.shot = await page.screenshot('changes.quality-strip');
if (landingRow && landingCell?.button) {
  await page.click({ role: 'button', name: landingCell.label, exact: true });
  const opened = await poll(() =>
    page.evaluate(`document.querySelector('aside.chg-insp')?.getAttribute('aria-label') ?? null`),
  );
  check('点落地列打开这次落地的改动', opened === landingRow.title, {
    opened,
    row: landingRow.title,
  });
}

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
