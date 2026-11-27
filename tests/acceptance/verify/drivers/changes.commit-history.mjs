import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'changes.commit-history', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-commits-${stamp}`, {
  'README.md': '# commits\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "commits-fixture", "private": true }\n',
});
// Two more commits made by hand, before any session.
const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
for (const n of [1, 2]) {
  writeFileSync(path.join(repo, `notes-${n}.md`), `note ${n}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', `Hand commit ${n}`);
}

const board = () => query('board', { project_id });
const projectRevision = async () =>
  (await board()).projects.find((p) => p.id === project_id).revision;
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await projectRevision(),
);

// A worktree session that commits twice, then lands.
const TITLE = `verify-commits-session-${stamp}`;
const FIRST = `add refunds ${stamp}`;
const SECOND = `add list ${stamp}`;
const session = await call('session.create', {
  project_id,
  runtime: 'fixture',
  workspace: 'worktree',
  input: `${TITLE}\nfixture-script\n${JSON.stringify([
    { write: { path: 'src/refunds.ts', text: `export const refunds = ${stamp};\n` } },
    { commit: FIRST },
    { write: { path: 'src/list.ts', text: 'export const list = [];\nexport const more = 1;\n' } },
    { commit: SECOND },
    { say: 'done' },
  ])}`,
});
const ready = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === session.id);
  return s?.state === 'ready' && s.ahead >= 2 && s;
}, 60_000);
check('前置：会话两次提交后可以落地', ready, ready && { state: ready.state, ahead: ready.ahead });
const revision = (await board()).sessions.find((s) => s.id === session.id)?.revision;
await call('session.merge', { session_id: session.id }, revision);
const landed = await poll(async () => {
  const read = await query('project.landings.read', { project_id });
  return read.landings.find((r) => r.session_id === session.id && r.state === 'landed');
}, 60_000);
check('前置：会话合并落地', landed, landed && { id: landed.id, state: landed.state });

const log = await poll(async () => {
  const l = await query('repo.log', { project_id, limit: 50 });
  return l.commits.filter((c) => c.session_id === session.id).length >= 2 && l;
}, 20_000);
result.log = log?.commits?.map((c) => ({
  sha: c.sha.slice(0, 7),
  subject: c.subject,
  session_id: c.session_id,
  landing_id: c.landing_id,
}));
const bySubject = (subject) => log?.commits?.find((c) => c.subject === subject);
const first = bySubject(FIRST);
const second = bySubject(SECOND);
const initial = bySubject('Initial commit');
check(
  '后端对照：repo.log 里会话的两个提交带这个会话的 session_id',
  first?.session_id === session.id && second?.session_id === session.id,
  result.log,
);
const listed = (await query('session.list', { project_id })).find((s) => s.id === session.id);

const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
await page.click({ role: 'tab', name: '提交', exact: true });

// Each listed commit: its SHA from the row id, its session mark and its branch landing mark.
const rows = () =>
  page.evaluate(`[...document.querySelectorAll('[role=option][id^=chc-]')].map((r) => ({
    sha: r.id.slice(4),
    session: r.querySelector('.chc-ses')?.textContent.trim() ?? null,
    landing: [...r.querySelectorAll('.chip')].some((c) => c.textContent.trim() === '分支落地'),
  }))`);
const shown = await poll(async () => {
  const list = await rows();
  return list.length === log?.commits?.length && list;
}, 15_000);
result.rows = shown;
const row = (sha) => shown?.find((r) => r.sha === sha);
check(
  '图里列出 repo.log 的全部提交，顺序一致',
  JSON.stringify(shown?.map((r) => r.sha)) === JSON.stringify(log?.commits?.map((c) => c.sha)),
  shown?.map((r) => r.sha.slice(0, 7)),
);
check(
  '会话带进的两个提交都标出会话标题(session.list 的 title)',
  row(first?.sha)?.session === listed?.title && row(second?.sha)?.session === listed?.title,
  { first: row(first?.sha), second: row(second?.sha), title: listed?.title },
);
const unattributed = log?.commits?.filter((c) => !c.session_id && !c.landing_id) ?? [];
check(
  '没有归属的提交(repo.log 无 session_id 和 landing_id)行上都不标',
  unattributed.length > 0 &&
    unattributed.every((c) => row(c.sha)?.session === null && row(c.sha)?.landing === false),
  unattributed.map((c) => ({ subject: c.subject, row: row(c.sha) })),
);
check(
  '对照组：建项目时的初始提交不标归属',
  initial && row(initial.sha)?.session === null && row(initial.sha)?.landing === false,
  initial && row(initial.sha),
);

// Opens the first session commit and compares its files with repo.commit_diff.
await page.evaluate(`document.getElementById(${JSON.stringify(`chc-${first?.sha}`)}).click()`);
const detail = () =>
  page.evaluate(`(() => {
    const a = document.querySelector('aside.chg-insp');
    if (!a) return null;
    return {
      label: a.getAttribute('aria-label'),
      files: [...a.querySelectorAll('ul.chg-dfl .chg-dfl-h')].map((b) => b.getAttribute('aria-label')),
      session: a.querySelector('.chc-ses')?.textContent.trim() ?? null,
      next: [...a.querySelectorAll('button')].some((b) => b.textContent.trim() === '下一个提交'),
    };
  })()`);
const opened = await poll(async () => {
  const d = await detail();
  return d?.files?.length && d;
}, 15_000);
result.detail = opened;
const diff = await query('repo.commit_diff', { project_id, sha: first?.sha });
result.diff = diff.files.map((f) => f.path);
check(
  '详情的文件等于 repo.commit_diff 的文件',
  JSON.stringify(opened?.files) ===
    JSON.stringify(diff.files.map((f) => `${f.path}，显示它的差异`)),
  { shown: opened?.files, daemon: result.diff },
);
check(
  '对照组：第一个会话提交的详情里没有第二个提交的 src/list.ts',
  opened && !opened.files.some((f) => f.startsWith('src/list.ts')),
  opened?.files,
);
check('详情里标出会话标题', opened?.session === listed?.title, opened?.session);
const after = await query('repo.commit_after', { project_id, sha: first?.sha });
result.after = after.next && { sha: after.next.sha.slice(0, 7), subject: after.next.subject };
check(
  '"下一个提交" 按钮有无与 repo.commit_after 的 next 一致',
  opened && opened.next === Boolean(after.next),
  { button: opened?.next, next: result.after },
);
result.shot = await page.screenshot('changes.commit-history');

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
