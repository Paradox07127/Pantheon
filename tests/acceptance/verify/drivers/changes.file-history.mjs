import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'changes.file-history', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const FILE = 'src/index.ts';
const { project_id } = await newProject(`verify-file-history-${stamp}`, {
  'README.md': '# file history\n',
  [FILE]: 'export const answer = 42;\n',
  'package.json': '{ "name": "file-history-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
const projectRevision = async () =>
  (await board()).projects.find((p) => p.id === project_id).revision;
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await projectRevision(),
);

// A worktree session adds two lines under the initial commit's line, commits, then lands.
const TITLE = `verify-file-history-session-${stamp}`;
const SUBJECT = `add refunds ${stamp}`;
const session = await call('session.create', {
  project_id,
  runtime: 'fixture',
  workspace: 'worktree',
  input: `${TITLE}\nfixture-script\n${JSON.stringify([
    {
      write: {
        path: FILE,
        text: `export const answer = 42;\nexport const refunds = ${stamp};\nexport const more = 1;\n`,
      },
    },
    { commit: SUBJECT },
    { say: 'done' },
  ])}`,
});
const ready = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === session.id);
  return s?.state === 'ready' && s.ahead >= 1 && s;
}, 60_000);
check('前置：会话提交后可以落地', ready, ready && { state: ready.state, ahead: ready.ahead });
const revision = (await board()).sessions.find((s) => s.id === session.id)?.revision;
await call('session.merge', { session_id: session.id }, revision);
const log = await poll(async () => {
  const l = await query('repo.log', { project_id, limit: 50 });
  return l.commits.some((c) => c.subject === SUBJECT && c.session_id === session.id) && l;
}, 60_000);
const landedCommit = log?.commits?.find((c) => c.subject === SUBJECT);
check('前置：会话的提交落地并归属到会话', landedCommit, landedCommit?.sha);
const listed = (await query('session.list', { project_id })).find((s) => s.id === session.id);

const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
await page.click({ role: 'tab', name: '提交', exact: true });
await poll(() =>
  page.evaluate(`!!document.getElementById(${JSON.stringify(`chc-${landedCommit?.sha}`)})`),
);
await page.evaluate(
  `document.getElementById(${JSON.stringify(`chc-${landedCommit?.sha}`)}).click()`,
);
await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('aside.chg-insp button')].some((b) => b.getAttribute('aria-label') === ${JSON.stringify(`打开 ${FILE} 的历史`)})`,
  ),
);
await page.click({ role: 'button', name: `打开 ${FILE} 的历史`, exact: true });

// Each run of lines the blame shows: its commit, its session mark and its line numbers.
const chunks = () =>
  page.evaluate(`[...document.querySelectorAll('aside.chg-insp .chf-chunk')].map((c) => ({
    sha: c.querySelector('.chf-who button[title]')?.getAttribute('title') ?? null,
    session: c.querySelector('.chf-who .chc-ses')?.textContent.trim() ?? null,
    lines: [...c.querySelectorAll('.chf-ln .chf-n')].map((n) => Number(n.textContent)),
  }))`);
const shown = await poll(async () => {
  const list = await chunks();
  return list.length > 0 && list;
}, 15_000);
result.chunks = shown;
const blame = await query('repo.blame', { project_id, path: FILE });
result.blame = blame.chunks.map((c) => ({
  start: c.start,
  count: c.count,
  sha: c.sha.slice(0, 7),
  session_id: c.session_id,
}));
const lineRange = (c) => Array.from({ length: c.count }, (_, i) => c.start + i);
check(
  '每段的提交和行号与 repo.blame 的 chunks 一致',
  JSON.stringify(shown?.map((c) => [c.sha, c.lines])) ===
    JSON.stringify(blame.chunks.map((c) => [c.sha, lineRange(c)])),
  { shown, blame: result.blame },
);
const sessionChunks = blame.chunks.filter((c) => c.session_id === session.id);
check(
  '会话写的两行(第 2、3 行)在 repo.blame 里归属到会话，界面标出会话标题',
  sessionChunks.flatMap(lineRange).join() === '2,3' &&
    shown
      ?.filter((c) => c.lines.includes(2) || c.lines.includes(3))
      .every((c) => c.session === listed?.title),
  { daemon: sessionChunks.map(lineRange), shown, title: listed?.title },
);
const firstLine = shown?.find((c) => c.lines.includes(1));
check(
  '对照组：初始提交写下的第 1 行不标会话',
  firstLine && firstLine.session === null && !blame.chunks.find((c) => c.start === 1)?.session_id,
  firstLine,
);
const history = await query('repo.file_history', { project_id, path: FILE });
const rows = await page.evaluate(
  `[...document.querySelectorAll('aside.chg-insp .chf-row')].map((r) => r.querySelector('.mono')?.textContent.trim())`,
);
check(
  '历史列表等于 repo.file_history 的 changes',
  JSON.stringify(rows) === JSON.stringify(history.changes.map((c) => c.sha.slice(0, 7))),
  { rows, daemon: history.changes.map((c) => c.sha.slice(0, 7)) },
);
const weeks = await page.evaluate(
  `document.querySelectorAll('aside.chg-insp .chf-weeks > i').length`,
);
check(
  '每周柱数等于 repo.file_history 的 weekly 数(26)',
  weeks === history.weekly.length && weeks === 26,
  weeks,
);
result.shot = await page.screenshot('changes.file-history');

await page.click({ role: 'button', name: '回到提交', exact: true });
const back = await poll(() =>
  page.evaluate(
    `document.querySelector('aside.chg-insp')?.getAttribute('aria-label') === ${JSON.stringify(`提交 ${landedCommit?.sha.slice(0, 7)}`)}`,
  ),
);
check('返回按钮回到提交详情', back === true, back);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
