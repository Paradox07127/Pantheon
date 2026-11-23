import { existsSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 180_000,
});
const result = { id: 'sessions.panel-files', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const INDEX = `export const answer = ${stamp};\n`;
const { project_id } = await newProject(`verify-files-${stamp}`, {
  'README.md': '# files panel\n',
  'src/index.ts': INDEX,
  'src/util.ts': 'export const twice = (n: number) => n * 2;\n',
  'package.json': '{ "name": "files-panel-fixture", "private": true }\n',
  '.gitignore': 'build/\n*.log\n',
});

// The session writes an ignored folder, an ignored file and a listed one into its worktree.
const TITLE = `verify-files-${stamp}`;
const created = await call('session.create', {
  project_id,
  runtime: 'fixture',
  workspace: 'worktree',
  permission_mode: 'auto_edit',
  input: `${TITLE}\nfixture-script\n${JSON.stringify([
    { write: { path: 'build/out.txt', text: 'ignored\n' } },
    { write: { path: 'debug.log', text: 'ignored\n' } },
    { write: { path: 'notes.txt', text: 'listed\n' } },
    { say: 'done' },
  ])}`,
});
const session = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === created.id);
  return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
}, 60_000);
check('前置：会话回合跑完', session?.last_turn?.state === 'completed', session?.last_turn);

const board = await query('board', { project_id });
const workspaceId = board.sessions.find((s) => s.id === created.id)?.workspace_id;
const worktree = board.workspaces.find((w) => w.id === workspaceId)?.path;
check(
  '前置：被忽略的 build/out.txt 和 debug.log 真的写进了工作树',
  worktree &&
    existsSync(path.join(worktree, 'build/out.txt')) &&
    existsSync(path.join(worktree, 'debug.log')),
  worktree,
);

const scope = { project_id, session_id: created.id };
const rootList = await query('files.list', scope);
const srcList = await query('files.list', { ...scope, path: 'src' });
const read = await query('files.read', { ...scope, path: 'src/index.ts' });
result.daemon = { root: rootList, src: srcList, read: { path: read.path, text: read.text } };
const rootNames = rootList.entries.map((e) => e.name);
check(
  '后端对照：files.list 不含 .git、build、debug.log,含 notes.txt 和 .gitignore',
  !rootNames.includes('.git') &&
    !rootNames.includes('build') &&
    !rootNames.includes('debug.log') &&
    rootNames.includes('notes.txt') &&
    rootNames.includes('.gitignore'),
  rootNames,
);

// Opens the session and its Files panel.
await page.click({ role: 'button', name: `${session?.title ?? TITLE}，fixture`, exact: false });
const toolbar = { role: 'toolbar', name: '面板', exact: true };
await page.waitFor(
  `[...document.querySelectorAll('[role=toolbar]')].some((t) => t.getAttribute('aria-label') === '面板' && t.getClientRects().length)`,
  'the session header panels toolbar',
);
await page.click({ role: 'button', name: '文件', exact: true, within: toolbar });

// The tree's rows, each with its level, read in one pass.
const treeRows = () =>
  page.evaluate(`(() => {
    const tree = [...document.querySelectorAll('[role=tree]')].find((t) => t.getAttribute('aria-label') === '文件' && t.getClientRects().length);
    if (!tree) return [];
    return [...tree.querySelectorAll('[role=treeitem]')].map((r) => ({
      name: r.textContent.trim(),
      level: Number(r.getAttribute('aria-level')),
      expanded: r.getAttribute('aria-expanded'),
    }));
  })()`);
const top = await poll(treeRows, 15_000);
result.top = top;
const topNames = top.filter((r) => r.level === 1).map((r) => r.name);
check(
  '文件树第一层等于 files.list 的条目，顺序一致',
  JSON.stringify(topNames) === JSON.stringify(rootNames),
  { shown: topNames, daemon: rootNames },
);
check(
  '文件树里没有 .git、build、debug.log',
  !topNames.some((n) => ['.git', 'build', 'debug.log'].includes(n)),
  topNames,
);
check('对照组：同一个读法能读到 notes.txt', topNames.includes('notes.txt'), topNames);
check('对照组：同一个读法读不到不存在的 absent.txt', !topNames.includes('absent.txt'), topNames);

// Opens the src folder.
const tree = { role: 'tree', name: '文件', exact: true };
await page.click({ role: 'treeitem', name: 'src', exact: true, within: tree });
const opened = await poll(async () => {
  const rows = await treeRows();
  return rows.some((r) => r.level === 2) && rows;
});
result.opened = opened;
const childNames = (opened || []).filter((r) => r.level === 2).map((r) => r.name);
check(
  '展开 src 后第二层等于 files.list(path=src)',
  JSON.stringify(childNames) === JSON.stringify(srcList.entries.map((e) => e.name)),
  { shown: childNames, daemon: srcList.entries.map((e) => e.name) },
);
check(
  'src 行 aria-expanded=true',
  (opened || []).find((r) => r.name === 'src')?.expanded === 'true',
  opened,
);

// Previews a file.
await page.click({ role: 'treeitem', name: 'index.ts', exact: true, within: tree });
const preview = await poll(() =>
  page.evaluate(`(() => {
    const code = document.querySelector('.ftr-view .ftr-code');
    const path = document.querySelector('.ftr-path');
    if (!code) return null;
    return {
      path: [...path.querySelectorAll(':scope > span:not(.ftr-acts)')].map((s) => s.textContent).join(''),
      text: [...code.querySelectorAll('.ftr-ln')].map((l) => l.children[1].textContent).join('\\n'),
      numbers: [...code.querySelectorAll('.ftr-n')].map((n) => n.textContent),
    };
  })()`),
);
result.preview = preview;
check('预览显示 files.read 的文本', preview && preview.text === read.text.replace(/\n$/, ''), {
  shown: preview?.text,
  daemon: read.text,
});
check('预览路径显示 src/index.ts', preview?.path === 'src/index.ts', preview?.path);
check('对照组：预览文本不等于另一个文件的文本', preview?.text !== 'listed', preview?.text);

result.shot = await page.screenshot('sessions.panel-files');
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
