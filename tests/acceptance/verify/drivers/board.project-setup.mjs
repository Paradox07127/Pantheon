import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const t0 = Date.now();
const { page, query, call, errors, newProject } = await open(process.argv[2]);
const proj = await newProject(`setup-${Date.now()}`);
const result = { id: 'board.project-setup', checks: [] };
await page.click({ role: 'button', name: '项目看板', exact: true });
const read = () => query('project.baseline.read', { project_id: proj.project_id });
const facts0 = await query('project.facts.read', { project_id: proj.project_id });
await page.waitFor(
  `document.body.innerText.includes(${JSON.stringify(proj.name + ' 还没有代码')})`,
  'the empty folder text',
);
result.checks.push({
  what: 'facts.empty 为 true 时界面显示 还没有代码 和 从零搭建',
  ok:
    facts0.empty === true &&
    (await page.evaluate(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '从零搭建')`,
    )),
});
// Three files make the folder count as a project (packages/control/src/baseline.ts:91).
for (const f of ['a.txt', 'b.txt']) writeFileSync(path.join(proj.repo, f), f + '\n');
const git = (...a) =>
  execFileSync('git', a, {
    cwd: proj.repo,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('add', '-A');
git('commit', '-q', '-m', 'Add two files');
await call('project.facts.refresh', { project_id: proj.project_id });
const b0 = await read();
result.before = b0;
await page.waitFor(
  `document.body.innerText.includes(${JSON.stringify('Pantheon 先读一遍 ' + proj.name)})`,
  'the setup lead text',
);
const ui0 = await page.evaluate(
  `(() => ({ build: [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '建立基线').length, choose: !!document.querySelector('button[aria-label="选择运行时和模型"]') }))()`,
);
result.checks.push({
  what: 'daemon 无基线（null 或无 state）',
  ok: b0 === null || b0?.state === undefined || b0?.state === 'empty',
  got: b0?.state ?? b0,
});
result.checks.push({
  what: '界面显示 Pantheon 先读一遍 verify-app，带 建立基线 和 选择运行时和模型',
  ok: ui0.build === 1 && ui0.choose,
});
await page.click({ role: 'button', name: '建立基线', exact: true });
let b;
for (const end = Date.now() + 30_000; Date.now() < end; await delay(300)) {
  b = await read();
  if (b && b.state && b.state !== 'running') break;
}
result.after = { state: b?.state, session_id: b?.session_id };
const words = { running: '正在建立基线', failed: '基线失败', submitted: '确认基线' };
const want = words[b?.state];
let ui1 = '';
for (const end = Date.now() + 10_000; Date.now() < end; await delay(200)) {
  ui1 = await page.evaluate('document.body.innerText');
  if (want && ui1.includes(want)) break;
}
result.checks.push({
  what: `daemon 基线状态 ${b?.state} 在界面显示为 ${want}`,
  ok: !!want && ui1.includes(want),
});
result.checks.push({
  what: '基线会话出现在 session.list',
  ok: (await query('session.list', { project_id: proj.project_id })).some(
    (s) => s.id === b?.session_id,
  ),
});
result.uiTail = ui1.slice(-600);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
