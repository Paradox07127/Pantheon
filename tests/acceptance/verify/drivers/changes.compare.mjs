import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { page, query, errors, poll, newProject } = await open(process.argv[2], { ms: 120_000 });
const result = { id: 'changes.compare', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-compare-${stamp}`, {
  'README.md': '# compare\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "compare-fixture", "private": true }\n',
});
const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
// A second branch two commits ahead of main, made by hand; main stays checked out.
const BRANCH = `feature-${stamp}`;
git('switch', '-q', '-c', BRANCH);
for (const n of [1, 2]) {
  writeFileSync(path.join(repo, `src/feature-${n}.ts`), `export const feature${n} = ${n};\n`);
  git('add', '-A');
  git('commit', '-q', '-m', `Feature commit ${n}`);
}
git('switch', '-q', 'main');
const branches = await poll(async () => {
  const list = await query('project.branches', { project_id });
  return list.some((b) => b.name === BRANCH) && list;
});
check(
  '前置：project.branches 列出 main(检出)和新分支',
  branches && branches.find((b) => b.name === 'main')?.checked_out,
  branches && branches.map((b) => ({ name: b.name, checked_out: b.checked_out })),
);

const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
await page.click({ role: 'tab', name: '提交', exact: true });
await page.click({ role: 'radio', name: '比较', exact: true });

const shown = () =>
  page.evaluate(`(() => {
    const value = (label) => document.querySelector('[aria-label=' + JSON.stringify(label) + ']')?.textContent.trim() ?? null;
    const fact = (name) => document.querySelector('[data-fact=' + name + '] dd')?.textContent.trim() ?? null;
    return {
      base: value('基准分支'),
      head: value('比较的分支'),
      ahead: fact('ahead'),
      behind: fact('behind'),
      single: fact('single'),
      noConflicts: [...document.querySelectorAll('.chb span')].some((s) => s.textContent.trim() === '没有冲突'),
      files: [...document.querySelectorAll('.chb ul.chg-dfl .chg-dfl-h')].map((b) => b.getAttribute('aria-label')),
    };
  })()`);
const view = await poll(async () => {
  const v = await shown();
  return v.ahead !== null && v.files.length > 0 && v;
}, 15_000);
result.view = view;
check(
  '默认 base 是当前分支 main,head 是最近提交的另一条分支',
  view?.base === 'main' && view?.head === BRANCH,
  view && { base: view.base, head: view.head },
);
const compare = await query('repo.compare', { project_id, base: 'main', head: BRANCH });
result.compare = {
  ahead: compare.ahead,
  behind: compare.behind,
  conflicts: compare.conflicts?.length,
  single_owner_files: compare.single_owner_files,
  files: compare.files.map((f) => f.path),
};
check(
  '领先数等于 repo.compare 的 ahead(2)',
  view?.ahead === String(compare.ahead) && compare.ahead === 2,
  { shown: view?.ahead, daemon: compare.ahead },
);
check('落后数等于 repo.compare 的 behind', view?.behind === String(compare.behind), {
  shown: view?.behind,
  daemon: compare.behind,
});
check(
  '只有这条分支在改的文件数等于 single_owner_files',
  view?.single === String(compare.single_owner_files),
  { shown: view?.single, daemon: compare.single_owner_files },
);
check(
  '没有冲突时写"没有冲突"(repo.compare 的 conflicts 为空)',
  compare.conflicts?.length === 0 ? view?.noConflicts : !view?.noConflicts,
  { shown: view?.noConflicts, daemon: compare.conflicts },
);
check(
  '文件列表等于 repo.compare 的 files',
  JSON.stringify(view?.files) ===
    JSON.stringify(compare.files.map((f) => `${f.path}，显示它的差异`)),
  { shown: view?.files, daemon: result.compare.files },
);
check('对照组：领先数不等于落后数', view?.ahead !== String(compare.behind), {
  ahead: view?.ahead,
  behind: compare.behind,
});
result.shot = await page.screenshot('changes.compare');

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
