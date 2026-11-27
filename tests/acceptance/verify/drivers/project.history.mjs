import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.history', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-project-history-${stamp}`, {
  'README.md': '# project history\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-history-fixture", "private": true }\n',
});
const projectRevision = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id).revision;
// A gate that passes, so the finished session lands; the merge runs it.
const ROOT = (await query('project.read', { project_id })).project?.roots?.[0] ?? repo;
await call(
  'project.gate.set',
  { project_id, root: ROOT, commands: [{ name: 'pass-step', argv: ['sh', '-c', 'exit 0'] }] },
  await projectRevision(),
);
const revisionOf = async (id) =>
  (await query('board', { project_id })).sessions.find((x) => x.id === id).revision;
const T = {
  first: `history-first-${stamp}`,
  second: `history-second-${stamp}`,
  third: `history-third-${stamp}`,
};
const M = { one: `第一里程碑-${stamp}`, two: `第二里程碑-${stamp}` };
const WORKER = `verify-history-worker-${stamp}`;
const write = (plan) => [{ tool: { name: 'write_plan', arguments: plan } }, { say: 'planned' }];
// The main agent takes input only while the board has it open; a landing may start a turn of its own.
const settled = (id) =>
  poll(
    async () =>
      (await query('board', { project_id })).sessions.find((x) => x.id === id)?.state === 'open',
    60_000,
  );
const revisions = async () => (await query('project.plan.history', { project_id })).revisions;

// Plan one: two items; the same turn starts a session that commits a change.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `verify-history-main-${stamp}\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'spawn_session',
        arguments: {
          runtime: 'fixture',
          input: `${WORKER}\nfixture-script\n${JSON.stringify([
            { write: { path: 'src/history.ts', text: 'export const history = 1;\n' } },
            { commit: `history ${stamp}` },
            { say: 'done' },
          ])}`,
        },
      },
    },
    ...write({
      milestones: [{ id: 'one', title: M.one }],
      items: [
        { id: 'first', title: T.first, milestone: 'one' },
        { id: 'second', title: T.second, milestone: 'one' },
      ],
    }),
  ])}`,
});
const worker = await poll(async () => {
  const all = await query('session.list', { project_id });
  const w = all.find((s) => s.spawned_by?.session_id === conductor.id && s.title === WORKER);
  return w?.last_turn?.state === 'completed' && w;
}, 60_000);
await settled(conductor.id);
check('前置：第一次计划写入，起的会话回合跑完', worker && (await revisions()).length === 1, [
  worker?.id ?? null,
  (await revisions()).length,
]);

// Plan two: a third item under a new milestone, naming the session; then the session lands.
const second = {
  milestones: [
    { id: 'one', title: M.one },
    { id: 'two', title: M.two },
  ],
  items: [
    { id: 'first', title: T.first, milestone: 'one' },
    { id: 'second', title: T.second, milestone: 'one' },
    { id: 'third', title: T.third, milestone: 'two', session_ids: [worker?.id ?? ''] },
  ],
};
await call(
  'session.send',
  { session_id: conductor.id, input: `plan two\nfixture-script\n${JSON.stringify(write(second))}` },
  await revisionOf(conductor.id),
);
await poll(async () => (await revisions()).length === 2, 30_000);
await settled(conductor.id);
await call('session.merge', { session_id: worker?.id }, await revisionOf(worker?.id));
const landed = await poll(async () => {
  const { landings } = await query('project.landings.read', { project_id });
  return landings.find((l) => l.session_id === worker?.id && l.state === 'landed');
}, 60_000);
check('前置：project.landings.read 有这个会话的 landed 记录', landed, landed?.state ?? null);

// Plan three: the second item removed, a replan.
await settled(conductor.id);
await call(
  'session.send',
  {
    session_id: conductor.id,
    input: `plan three\nfixture-script\n${JSON.stringify(
      write({ ...second, items: second.items.filter((i) => i.id !== 'second') }),
    )}`,
  },
  await revisionOf(conductor.id),
);
await poll(async () => (await revisions()).length === 3, 30_000);
await settled(conductor.id);
const history = await revisions();
const { landings } = await query('project.landings.read', { project_id });
result.backend = {
  revisions: history.map((r) => [r.revision, r.author, r.changes, r.replan]),
  landings: landings.map((l) => [l.session_id ?? l.branch, l.state]),
};
const ids = new Set(history.flatMap((r) => r.items.map((i) => i.id)));
check(
  '前置：project.plan.history 三次修订，最新一次删掉第二项并标 replan',
  history.length === 3 &&
    history[0].replan &&
    JSON.stringify(history[0].changes.removed) === '["second"]',
  result.backend.revisions,
);

// The history view, read from the page.
const readHistory = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="计划历史"]')].find((e) => e.getClientRects().length);
    if (!s) return null;
    return {
      rows: [...s.querySelectorAll('li')].map((li) => ({
        text: li.textContent.trim(),
        images: [...li.querySelectorAll('[role=img]')].map((e) => e.getAttribute('aria-label')),
        button: !!li.querySelector('button'),
      })),
      replans: [...s.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')),
    };
  })()`);
await page.click({ role: 'button', name: '项目', exact: true });
await page.click({ role: 'radio', name: '历史', exact: true });
const shown = await poll(async () => {
  const h = await readHistory();
  return h?.rows.length === ids.size && h.rows.some((r) => r.images.length > 1) && h;
}, 20_000);
result.ui = shown || (await readHistory());
const row = (title) => result.ui?.rows.find((r) => r.text === title);
check('后端对照：行数等于修订里出现过的项数', result.ui?.rows.length === ids.size, [
  result.ui?.rows.length ?? null,
  ids.size,
]);
check(
  '后端对照：replan 记号数等于 replan 为真的修订数，记号列出删掉的项',
  result.ui?.replans.length === history.filter((r) => r.replan).length &&
    result.ui.replans[0]?.includes('重新规划') &&
    result.ui.replans[0]?.includes(`删掉 ${T.second}`),
  result.ui?.replans,
);
check(
  '删掉的第二项：行在删掉那一刻结束，没有打开检查器的按钮',
  row(T.second)?.images[0]?.includes('删掉') && row(T.second)?.button === false,
  row(T.second),
);
const dots = (title) => (row(title)?.images ?? []).slice(1);
check(
  '后端对照：落地点在第三项的行上，是 landed',
  dots(T.third).length === 1 && dots(T.third)[0].endsWith('落地'),
  dots(T.third),
);
check(
  '对照组：没有落地记录的第一、第二项，行上没有点',
  row(T.first) && dots(T.first).length === 0 && dots(T.second).length === 0,
  [dots(T.first), dots(T.second)],
);

// Hovering the replan mark lists what it removed.
const mark = await page.evaluate(`(() => {
  const s = [...document.querySelectorAll('section[aria-label="计划历史"]')].find((e) => e.getClientRects().length);
  const r = s?.querySelector('button[aria-label]')?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
})()`);
if (mark) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mark });
const tip = await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('[role=tooltip], .tooltip')].map((e) => e.textContent).find((t) => t.includes('重新规划')) ?? null`,
  ),
);
check('悬停 replan 记号时列出删掉的项', tip?.includes(`删掉 ${T.second}`), tip);
result.shot = await page.screenshot(result.id);

// Picking a row opens its item's inspector, as in the list.
await page.click({ role: 'button', name: T.third, exact: true });
const inspector = (title) =>
  page.evaluate(
    `[...document.querySelectorAll('aside')].some((e) => e.getClientRects().length && e.getAttribute('aria-label') === ${JSON.stringify(`${title} 的详情`)})`,
  );
check('点第三项的行打开它的计划项检查器', await poll(() => inspector(T.third)));
check('对照组：第一项的检查器没开', !(await inspector(T.first)));

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
