import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'trace.workflow-path', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-workflow-${stamp}`, {
  'README.md': '# workflow\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "workflow-fixture", "private": true }\n',
});
const projectRow = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id);
// A second folder with no protected paths, whose way goes straight to its gate.
const other = `${repo}-second`;
mkdirSync(other, { recursive: true });
writeFileSync(path.join(other, 'README.md'), '# second\n');
const git = (...args) =>
  execFileSync('git', args, {
    cwd: other,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Verify App');
git('config', 'user.email', 'verify-app@example.invalid');
git('add', '-A');
git('commit', '-q', '-m', 'Initial commit');
const opened = (await query('project.read', { project_id })).project;
await call(
  'project.environment.set',
  { project_id, name: opened.name, roots: [...opened.roots, other], env: opened.env ?? {} },
  (await projectRow()).revision,
);
const both = await poll(async () => {
  const p = await projectRow();
  return p?.roots?.length === 2 && p;
});
const [ROOT, SECOND] = both?.roots ?? [repo, other];
// Twelve commands, so the graph is taller than the tab.
const COUNT = 12;
await call(
  'project.gate.set',
  {
    project_id,
    root: ROOT,
    commands: Array.from({ length: COUNT }, (_, i) => ({
      name: `step-${i + 1}`,
      argv: ['sh', '-c', `exit 0 # step-${i + 1}-${stamp}`],
    })),
    protected_paths: [`migrations-${stamp}/**`],
  },
  (await projectRow()).revision,
);
const row = await poll(async () => {
  const p = await projectRow();
  return p?.gates?.[ROOT]?.length === COUNT && p.protected_paths?.[ROOT]?.length === 1 && p;
});
const lines = (row?.gates?.[ROOT] ?? []).map((c) => c.argv.join(' '));
const paths = row?.protected_paths?.[ROOT] ?? [];
check(
  'board 读回两个目录、第一个目录的 12 条门禁命令和一条受保护路径',
  row?.roots?.length === 2 && lines.length === COUNT && paths.length === 1,
  { roots: row?.roots, lines, paths },
);

// The trace page through the palette, then its workflow tab.
await page.click({ role: 'button', name: '搜索', exact: true });
await page.waitFor(`!!document.querySelector('.cmdk input')`, 'the command palette to open');
const box = await page.evaluate(`document.querySelector('.cmdk input').getAttribute('aria-label')`);
await page.fill({ role: 'combobox', name: box, exact: true }, '最近动态');
await page.click({ role: 'option', name: '最近动态', exact: true });
await page.click({ role: 'tab', name: '工作流', exact: true });

// Each drawn node: its name and its detail lines.
const cards = () =>
  page.evaluate(`[...document.querySelectorAll('.vis-gn')].filter((el) => el.getClientRects().length).map((el) => ({
    label: el.querySelector('.vis-gn-t')?.textContent.trim() ?? '',
    detail: [...el.querySelectorAll('.vis-gn-d')].map((d) => d.textContent.trim()),
  }))`);
const drawn = await poll(async () => {
  const c = await cards();
  return c.some((n) => n.label === '落地') && c;
}, 30_000);
const retry = await page.evaluate(
  `[...document.querySelectorAll('button')].some((b) => b.getClientRects().length && b.textContent.trim() === '重试')`,
);
check('工作流设置和门禁历史都读到了，没有出错的重试', !retry, retry);
const labels = (drawn || []).map((n) => n.label);
const APPROVE = `等你批：${ROOT}`;
check(
  '节点有 起会话、审查、受保护目录的等你批、两个门禁目录、落地',
  ['起会话', '审查', APPROVE, ROOT, SECOND, '落地'].every((l) => labels.includes(l)),
  labels,
);
const gate = (drawn || []).find((n) => n.label === ROOT);
check(
  '门禁节点按顺序列出 board 读回的命令',
  JSON.stringify(gate?.detail.slice(0, COUNT)) === JSON.stringify(lines),
  gate?.detail,
);
const approve = (drawn || []).find((n) => n.label === APPROVE);
check(
  '等你批节点列出 board 读回的受保护路径',
  JSON.stringify(approve?.detail) === JSON.stringify(paths),
  approve?.detail,
);
check('没有受保护路径的目录没有等你批节点', !labels.some((l) => l === `等你批：${SECOND}`), labels);

// The edges by their accessible names, "<from> 到 <to>".
const edges = await page.evaluate(
  `[...document.querySelectorAll('.react-flow__edge')].map((el) => el.getAttribute('aria-label'))`,
);
const edge = (from, to) => edges.includes(`${from} 到 ${to}`);
check(
  '边有 起会话→审查、审查→门禁、等你批→受保护目录的门禁、门禁→落地',
  edge('起会话', '审查') &&
    edge('审查', SECOND) &&
    edge(APPROVE, ROOT) &&
    edge(ROOT, '落地') &&
    edge(SECOND, '落地'),
  edges,
);
check('没有 门禁→等你批 的边', !edge(ROOT, APPROVE), edges);
check('受保护目录也有不经等你批、直达门禁的边', edge('起会话', ROOT), edges);

// The graph keeps the height it asks for; the tab scrolls instead.
const sizes = await page.evaluate(`(() => {
  const graph = [...document.querySelectorAll('.vis-gd')].find((el) => el.getClientRects().length);
  const tab = graph?.parentElement;
  return graph && {
    drawn: graph.getBoundingClientRect().height,
    asked: parseFloat(graph.style.height),
    overflows: tab.scrollHeight > tab.clientHeight,
    scrollable: ['auto', 'scroll'].includes(getComputedStyle(tab).overflowY),
  };
})()`);
check('12 条命令时图不被压缩', sizes && Math.abs(sizes.drawn - sizes.asked) <= 1, sizes);
check('内容超出时标签本身可以滚动', sizes && sizes.overflows && sizes.scrollable, sizes);
check(
  '对照组：不存在的命令名在图上找不到',
  !(drawn || []).some((n) => n.detail.some((d) => d.includes(`absent-${stamp}`))),
);

// The trial run under the graph records a check without landing anything.
const before = (await query('project.environment.checks', { project_id })).length;
await page.evaluate(
  `document.querySelector('[aria-label="试跑门禁"]')?.scrollIntoView({ block: 'center' })`,
);
await page.click({
  role: 'button',
  name: '检查环境',
  exact: true,
  within: { name: '试跑门禁', exact: true },
});
const checks = await poll(async () => {
  const list = await query('project.environment.checks', { project_id });
  return list.length > before && list;
}, 60_000);
check(
  '点试跑后 project.environment.checks 读到这次检查',
  Array.isArray(checks) && checks.length > before && checks.some((c) => c.root === ROOT),
  Array.isArray(checks) ? checks.map((c) => ({ root: c.root, state: c.state })) : checks,
);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
