import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.task-thread', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-task-thread-${stamp}`, {
  'README.md': '# task thread\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "task-thread-fixture", "private": true }\n',
});
const MAIN = `verify-thread-main-${stamp}`;
const WORKER = `verify-thread-worker-${stamp}`;
// The main agent starts one session whose turn writes a file and completes.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'spawn_session',
        arguments: {
          runtime: 'fixture',
          input: `${WORKER}\nfixture-script\n${JSON.stringify([
            { write: { path: 'src/thread.ts', text: 'export const thread = 1;\n' } },
            { say: 'done' },
          ])}`,
        },
      },
    },
    { say: 'ok' },
  ])}`,
});
const started = await poll(async () => {
  const all = await query('session.list', { project_id });
  const main = all.find((s) => s.id === conductor.id);
  const worker = all.find((s) => s.spawned_by?.session_id === conductor.id && s.title === WORKER);
  return (
    main?.last_turn?.state === 'completed' && worker?.last_turn?.state === 'completed' && worker
  );
}, 60_000);
check('前置：主 agent 起的会话回合跑完', started, started && started.last_turn);

const T = { linked: `thread-linked-${stamp}`, free: `thread-free-${stamp}` };
const plan = {
  milestones: [{ id: 'only', title: `里程碑-${stamp}` }],
  items: [
    { id: 'linked', title: T.linked, milestone: 'only', session_ids: [started?.id ?? ''] },
    { id: 'free', title: T.free, milestone: 'only' },
  ],
};
const revisionOf = async (id) =>
  (await query('board', { project_id })).sessions.find((x) => x.id === id).revision;
await call(
  'session.send',
  {
    session_id: conductor.id,
    input: `plan\nfixture-script\n${JSON.stringify([
      { tool: { name: 'write_plan', arguments: plan } },
      { say: 'planned' },
    ])}`,
  },
  await revisionOf(conductor.id),
);
const planned = await poll(async () => {
  const [p, all] = await Promise.all([
    query('project.plan', { project_id }),
    query('session.list', { project_id }),
  ]);
  const main = all.find((s) => s.id === conductor.id);
  return (
    p.plan?.items.length === plan.items.length &&
    main?.state !== 'running' &&
    main?.last_turn?.state === 'completed' &&
    p.plan
  );
}, 30_000);
check(
  '前置：计划写入，一项指向这个会话',
  planned?.items.find((i) => i.id === 'linked')?.session_id === started?.id,
  planned?.items.map((i) => [i.id, i.session_id ?? null]),
);

await page.click({ role: 'button', name: '项目', exact: true });
const readThread = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="经过"]')].find((e) => e.getClientRects().length);
    if (!s) return null;
    return [...s.querySelectorAll(':scope > ol > li')]
      .filter((li) => li.querySelector(':scope > time'))
      .map((li) => li.textContent.trim());
  })()`);
await poll(async () => (await query('project.plan', { project_id })).plan?.items.length === 2);
await page.click({ role: 'button', name: T.linked, exact: true });
// The entries the screen shows and the thread read compared in the same poll.
const seen = await poll(async () => {
  const [rows, thread] = await Promise.all([
    readThread(),
    query('session.thread', { session_id: started?.id ?? '' }),
  ]);
  const want = Math.min(8, thread.entries.length);
  return rows?.length === want && rows.some((r) => r.includes('回合完成')) && { rows, thread };
}, 20_000);
result.backend = seen?.thread.entries.map((e) => [e.kind, e.by ?? e.state ?? null]);
result.rows = seen ? seen.rows : await readThread();
check(
  '检查器 "经过" 的行数等于 session.thread 的条目数',
  seen && seen.rows.length === seen.thread.entries.length,
  [result.rows?.length ?? null, seen?.thread.entries.length ?? null],
);
check(
  '有一行 "主 agent 起的"，后端对照：session.thread 的 started 条目 by=main_agent',
  seen?.rows.some((r) => r.includes('主 agent 起的')) &&
    seen.thread.entries.some((e) => e.kind === 'started' && e.by === 'main_agent'),
  result.rows,
);
check(
  '有一行 "回合完成"，后端对照：session.thread 有 turn_ended completed',
  seen?.rows.some((r) => r.includes('回合完成')) &&
    seen.thread.entries.some((e) => e.kind === 'turn_ended' && e.state === 'completed'),
  result.rows,
);
check(
  '对照组：同一读法里没有 "你起的"',
  seen && !seen.rows.some((r) => r.includes('你起的')),
  result.rows,
);

await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="经过"]')].find((e) => e.getClientRects().length)?.scrollIntoView({ block: 'end' })`,
);
result.threadShot = await page.screenshot(`${result.id}-thread`);
await page.click({ role: 'button', name: T.free, exact: true });
const freeOpen = await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('aside[aria-label]')].some((a) => a.getClientRects().length && a.getAttribute('aria-label').includes(${JSON.stringify(T.free)}))`,
  ),
);
const freeThread = await readThread();
check('对照组：没有会话的计划项，检查器里没有 "经过"', freeOpen && freeThread === null, [
  freeOpen,
  freeThread,
]);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
