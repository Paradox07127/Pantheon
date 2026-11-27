import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { run, page, query, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'changes.local', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const name = `verify-local-${stamp}`;
const { project_id, repo } = await newProject(name, {
  'README.md': '# local\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "local-fixture", "private": true }\n',
});
const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env }).toString().trim();
// A remote outside the repository.
const remote = path.join(run.workspace, 'remotes', `${name}.git`);
mkdirSync(remote, { recursive: true });
git(remote, 'init', '-q', '--bare', '-b', 'main');
git(repo, 'remote', 'add', 'origin', remote);
// One file changed and one made by hand in the project folder.
const CHANGED = 'src/index.ts';
const ADDED = 'notes/todo.md';
const ADDED_TEXT = `- check the refund list ${stamp}\n`;
writeFileSync(path.join(repo, CHANGED), 'export const answer = 43;\nexport const more = true;\n');
mkdirSync(path.join(repo, 'notes'), { recursive: true });
writeFileSync(path.join(repo, ADDED), ADDED_TEXT);

const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
await page.click({ role: 'tab', name: '本地', exact: true });

const SUFFIX = '，显示它的差异';
const listed = () =>
  page.evaluate(
    `[...document.querySelectorAll('.chl-files .chg-dfl-h')].map((b) => b.getAttribute('aria-label'))`,
  );
const paths = async () => (await listed()).map((label) => label.replace(SUFFIX, ''));
const bar = () => page.evaluate(`document.querySelector('.chl-bar')?.innerText ?? null`);
const pushDisabled = () =>
  page.evaluate(
    `[...document.querySelectorAll('.chl-bar button')].find((b) => b.textContent.trim() === '推送')?.disabled ?? null`,
  );

const both = await poll(async () => {
  const shown = await paths();
  return shown.includes(CHANGED) && shown.includes(ADDED) && shown;
}, 15_000);
const working = await query('repo.working_diff', { project_id });
check(
  '列表显示改过的和新建的文件，等于 repo.working_diff 的 files',
  both && JSON.stringify(both) === JSON.stringify(working.files.map((f) => f.path)),
  { shown: both, daemon: working.files.map((f) => ({ path: f.path, status: f.status })) },
);
const before = await bar();
check(
  '没有上游时写"没有上游"，推送可用',
  working.upstream === null && before?.includes('没有上游') && (await pushDisabled()) === false,
  { bar: before, upstream: working.upstream },
);
result.shot = await page.screenshot('changes.local');

// Discards the new file, then undoes it from the panel.
await page.click({ role: 'button', name: `丢弃 ${ADDED} 的改动`, exact: true });
await page.click({ role: 'button', name: '丢弃', exact: true });
const gone = await poll(
  async () => !existsSync(path.join(repo, ADDED)) && !(await paths()).includes(ADDED),
);
check('确认丢弃后新建的文件从磁盘和列表消失', gone, await paths());
await page.click({
  role: 'button',
  name: '撤回',
  exact: true,
  within: { role: 'group', name: '最近一次丢弃', exact: true },
});
const back = await poll(
  async () => existsSync(path.join(repo, ADDED)) && (await paths()).includes(ADDED),
);
const restored = existsSync(path.join(repo, ADDED)) && readFileSync(path.join(repo, ADDED), 'utf8');
check('撤回后文件回到列表，内容和原来一样', back && restored === ADDED_TEXT, { restored });

// Commits only the changed file.
const MESSAGE = `Raise the answer ${stamp}`;
await page.click({ role: 'checkbox', name: `提交 ${CHANGED}`, exact: true });
await page.fill({ role: 'textbox', name: '提交说明', exact: true }, MESSAGE);
await page.click({ role: 'button', name: '提交选中的文件', exact: true });
const log = await poll(async () => {
  const l = await query('repo.log', { project_id, limit: 1 });
  return l.commits[0]?.subject === MESSAGE && l;
});
check('repo.log 最新一条的 subject 是这条说明', log, log?.commits?.[0]?.subject);
const after = await poll(async () => {
  const shown = await paths();
  return !shown.includes(CHANGED) && shown;
});
const afterDiff = await query('repo.working_diff', { project_id });
check(
  '对照组：没勾选的文件提交后仍在列表和 repo.working_diff 里，提交的文件不在',
  after &&
    after.includes(ADDED) &&
    afterDiff.files.some((f) => f.path === ADDED) &&
    !afterDiff.files.some((f) => f.path === CHANGED),
  { shown: after, daemon: afterDiff.files.map((f) => f.path) },
);

// Pushes, setting origin as the upstream.
const pushedTo = async () => {
  try {
    return git(remote, 'rev-parse', 'HEAD');
  } catch {
    return null;
  }
};
await page.click({ role: 'button', name: '推送', exact: true });
const first = await poll(async () => (await pushedTo()) === git(repo, 'rev-parse', 'HEAD'));
check('第一次推送后远程的 HEAD 等于本地 HEAD', first, {
  remote: await pushedTo(),
  local: git(repo, 'rev-parse', 'HEAD'),
});
const tracked = await poll(async () => {
  const text = await bar();
  return text?.includes('origin/main') && !text.includes('领先') && text;
});
check('推送后显示上游 origin/main，没有领先数', tracked, await bar());

// One more commit makes the branch one ahead; pushing brings it back to zero.
const SECOND = `Add the todo ${stamp}`;
await page.click({ role: 'checkbox', name: `提交 ${ADDED}`, exact: true });
await page.fill({ role: 'textbox', name: '提交说明', exact: true }, SECOND);
await page.click({ role: 'button', name: '提交选中的文件', exact: true });
const ahead = await poll(async () => (await bar())?.includes('领先 1'));
const upstream = (await query('repo.working_diff', { project_id })).upstream;
check('再提交一次后显示领先 1，等于 repo.working_diff 的 ahead', ahead && upstream?.ahead === 1, {
  bar: await bar(),
  upstream,
});
await page.click({ role: 'button', name: '推送', exact: true });
const second = await poll(async () => (await pushedTo()) === git(repo, 'rev-parse', 'HEAD'));
const zero = await poll(async () => {
  const text = await bar();
  return text?.includes('origin/main') && !text.includes('领先') && (await pushDisabled()) === true;
});
const finalUpstream = (await query('repo.working_diff', { project_id })).upstream;
check(
  '第二次推送后远程等于本地 HEAD，领先数变 0，推送不可用',
  second && zero && finalUpstream?.ahead === 0,
  {
    bar: await bar(),
    upstream: finalUpstream,
  },
);
check(
  '两个文件都提交后显示空状态',
  await poll(() => page.evaluate(`document.body.innerText.includes('没有未提交的改动')`)),
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
