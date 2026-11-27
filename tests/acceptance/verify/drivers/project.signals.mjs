import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.signals', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-project-signals-${stamp}`, {
  'README.md': '# project signals\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-signals-fixture", "private": true }\n',
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
const CHECK = `broken-${stamp}`;
await call(
  'project.gate.set',
  {
    project_id,
    root: ROOT,
    commands: [{ name: CHECK, argv: ['sh', '-c', "echo 'Error: broken' >&2; exit 1"] }],
  },
  await projectRevision(),
);

await page.click({ role: 'button', name: '项目', exact: true });
const readCard = () =>
  page.evaluate(`(() => {
    const card = [...document.querySelectorAll('section[aria-label="信号"]')].find((s) => s.getClientRects().length);
    if (!card) return null;
    return {
      rows: [...card.querySelectorAll('li')].map((li) => ({
        name: li.getAttribute('aria-label'),
        text: li.innerText,
        resolve: [...li.querySelectorAll('button')].some((b) => b.textContent.trim() === '标为已解决'),
      })),
    };
  })()`);
const pageShown = await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('section[aria-label="项目介绍"]')].some((s) => s.getClientRects().length)`,
  ),
);
check('前置：项目页已打开', pageShown, pageShown);
const before = await query('project.signals', { project_id });
check(
  '对照组：门禁前 project.signals 为空且项目页没有"信号"卡片',
  before.issues.length === 0 && (await readCard()) === null,
  { issues: before.issues, card: await readCard() },
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

const one = await session(`verify-signals-one-${stamp}`, 'src/one.ts');
const oneRun = await runGates(one.id);
const two = await session(`verify-signals-two-${stamp}`, 'src/two.ts');
const twoRun = await runGates(two.id);
check(
  '前置：两个会话的门禁都在这条检查上失败',
  [oneRun, twoRun].every((r) => r?.results?.some((s) => s.name === CHECK && s.exit_code !== 0)),
  { one: oneRun?.results, two: twoRun?.results },
);

const opened = await poll(async () => {
  const { issues } = await query('project.signals', { project_id });
  return issues.find((i) => i.source === 'gate_repeat' && i.state === 'open');
}, 15_000);
check('project.signals 有一条开启的反复失败', opened, opened && { ...opened, samples: undefined });
const listed = await poll(async () => {
  const card = await readCard();
  const row = card?.rows.find((r) => r.name === opened?.title);
  return row?.text.includes('开启') && row.text.includes(`${opened.count} 次`) && card;
}, 15_000);
const row = listed?.rows?.find((r) => r.name === opened?.title);
check(
  '卡片出现一行，写"开启"和"反复失败"',
  row?.text.includes('开启') && row.text.includes('反复失败'),
  listed ?? (await readCard()),
);
check('这一行的次数等于 project.signals 的 count', row?.text.includes(`${opened?.count} 次`), {
  row: row?.text,
  count: opened?.count,
});
check(
  '对照组：这一行不写别的次数',
  !row?.text.includes(`${(opened?.count ?? 0) + 1} 次`),
  row?.text,
);

await page.click({
  role: 'button',
  name: opened?.title ?? CHECK,
});
const sample = await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('section[aria-label="信号"] pre')].map((p) => p.textContent).join('\\n')`,
  ),
);
check('展开一行看到最新样本', sample.includes('Error: broken'), sample);
result.shot = await page.screenshot(result.id);

await page.click({
  role: 'button',
  name: '标为已解决',
  exact: true,
});
const resolved = await poll(async () => {
  const { issues } = await query('project.signals', { project_id });
  const issue = issues.find((i) => i.id === opened?.id);
  return issue?.state === 'resolved' && issue;
}, 15_000);
check('点"标为已解决"后 project.signals 里这条是 resolved', resolved, resolved?.state);
const resolvedRow = await poll(async () => {
  const card = await readCard();
  const r = card?.rows.find((x) => x.name === opened?.title);
  return r?.text.includes('已解决') && !r.resolve && r;
}, 10_000);
check('界面这一行写"已解决"，没有"标为已解决"按钮', resolvedRow, resolvedRow ?? (await readCard()));
result.resolvedShot = await page.screenshot(`${result.id}-resolved`);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
