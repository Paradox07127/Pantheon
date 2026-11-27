import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'insights-memory.graph', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-memory-graph-${stamp}`, {
  'README.md': '# memory graph\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "memory-graph-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await board()).projects.find((p) => p.id === project_id).revision,
);
// A project setup session carries the memory tools.
const TITLE = `verify-memory-graph-${stamp}`;
await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'project_setup',
  input: `${TITLE}\nfixture-script\n${JSON.stringify([{ say: `Ready ${stamp}` }])}`,
});
const first = await poll(
  async () =>
    (await query('session.list', { project_id })).find(
      (s) => s.title === TITLE && s.last_turn && !['queued', 'running'].includes(s.last_turn.state),
    ),
  30_000,
);
check('前置：会话的第一个回合结束', first, first?.last_turn?.state);
const session = first?.id;
const send = async (steps) => {
  const before = (await board()).session_turns.filter((t) => t.session_id === session).length;
  await call(
    'session.send',
    { session_id: session, input: `fixture-script\n${JSON.stringify(steps)}` },
    (await board()).sessions.find((s) => s.id === session).revision,
  );
  return poll(async () => {
    const turns = (await board()).session_turns.filter((t) => t.session_id === session);
    const last = turns.at(-1);
    return turns.length > before && !['queued', 'running'].includes(last.state) && last;
  }, 30_000);
};
const REF = `Graph source ${stamp}`;
const BARE = `Graph bare ${stamp}`;
for (const [key, title, references] of [
  [`testing/graph-ref-${stamp}`, REF, [{ kind: 'file', uri: 'src/index.ts', root: 0 }]],
  [`testing/graph-bare-${stamp}`, BARE, undefined],
]) {
  const { signature } = await call('memory.context', { project_id });
  await send([
    {
      tool: {
        name: 'memory_propose',
        arguments: {
          project_id,
          key,
          kind: 'note',
          title,
          text: `${title}: the answer lives in src/index.ts.`,
          ...(references && { references }),
          based_on: signature,
        },
      },
    },
    { say: `Noted ${stamp}` },
  ]);
}
const found = await poll(async () => {
  const rows = (await query('memory.read', { project_id, state: 'active' })).records ?? [];
  return rows.some((r) => r.title === REF) && rows.some((r) => r.title === BARE) && rows;
}, 30_000);
check('前置：两条项目记忆生效', found, found && found.map((r) => r.title));

// The memory screen's graph tab.
// Neither the sidebar nor the palette opens the memory screen; the session's memory chip does.
await page.click({ role: 'button', name: `${TITLE}，fixture`, exact: false });
const chip = await poll(async () =>
  (await names('记忆')).find((n) => n.name === '记忆待同步' || n.name === '记忆已送达'),
);
result.memory_chip = chip;
await page.click({ role: 'button', name: chip?.name ?? '记忆已送达', exact: true });
await page.click({ role: 'tab', name: '图谱', exact: true });
const selected = await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('[role=tab][aria-selected=true]')].some((e) => e.getClientRects().length && e.textContent.trim() === '图谱')`,
  ),
);
check('记忆屏有 "图谱" 分页，点后选中', selected);
const shownNodes = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="知识图谱"]')].find((e) => e.getClientRects().length);
    return s ? [...s.querySelectorAll('button.mg-mn, button.mg-ms')].map((b) => b.getAttribute('aria-label')) : null;
  })()`);
// The same read the tab sends.
const graph = () =>
  query('memory.graph', { project_id, state: 'all', max_nodes: '80', include_tags: 'false' });
let daemon = null;
const nodes = await poll(async () => {
  const ui = await shownNodes();
  daemon = await graph();
  return (
    ui?.includes(`笔记：${REF}，当前`) &&
    ui.includes(`笔记：${BARE}，当前`) &&
    ui.length === daemon.nodes.length &&
    ui
  );
}, 15_000);
result.ui_nodes = nodes || (await shownNodes());
result.daemon_nodes = daemon?.nodes.map((n) => [n.kind, n.source_kind ?? null, n.label]);
check('图谱里有两条记忆的节点（"笔记：标题，当前"）', nodes, result.ui_nodes);
check(
  '后端对照：界面节点数等于 memory.graph 的 nodes 数',
  Array.isArray(result.ui_nodes) && result.ui_nodes.length === daemon?.nodes.length,
  { ui: result.ui_nodes?.length, daemon: daemon?.nodes.length },
);
check(
  '对照组：不存在的记忆标题没有节点',
  (await names(`笔记：Graph absent ${stamp}`)).length === 0,
);
result.shot = await page.screenshot(result.id);

// Clicking a node opens its details.
await page.click({ role: 'button', name: `笔记：${REF}，当前`, exact: true });
const detail = () =>
  page.evaluate(`(() => {
    const a = [...document.querySelectorAll('aside[aria-label="条目详情"]')].find((e) => e.getClientRects().length);
    return a ? a.querySelector('.mgs-t')?.textContent.trim() ?? '' : null;
  })()`);
const shown = await poll(async () => (await detail()) === REF);
check('点节点后出 "条目详情"，标题是这条记忆', shown, await detail());
check('对照组：详情标题不是另一条', (await detail()) !== BARE);
const pressed = await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="知识图谱"] button[aria-pressed=true]')].map((b) => b.getAttribute('aria-label'))`,
);
check(
  '被点的节点 aria-pressed',
  JSON.stringify(pressed) === JSON.stringify([`笔记：${REF}，当前`]),
  pressed,
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
