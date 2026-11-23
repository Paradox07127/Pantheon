import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'changes.inspector', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-inspector-${stamp}`, {
  'README.md': '# inspector\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "inspector-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
const projectRevision = async () =>
  (await board()).projects.find((p) => p.id === project_id).revision;
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await projectRevision(),
);
const ROOT = (await query('project.read', { project_id })).project?.roots?.[0] ?? repo;
// One step that passes and one that always fails.
await call(
  'project.gate.set',
  {
    project_id,
    root: ROOT,
    commands: [
      { name: 'pass-step', argv: ['sh', '-c', 'exit 0'] },
      { name: 'fail-step', argv: ['sh', '-c', `echo boom-${stamp}; exit 3`] },
    ],
  },
  await projectRevision(),
);

// Gates in the session's worktree, where a rerun of the failed steps carries the passed ones over.
await call(
  'workflow.policy.set',
  { project_id, gate_runner: 'session' },
  // A new project has no stored policy yet, which the daemon reads as no revision.
  null,
);

// A main agent spawns a worker that writes and commits a file; a direct session does the same.
const steps = (file) => [
  { write: { path: file, text: `export const value = ${stamp};\nexport const more = 1;\n` } },
  { commit: `add ${file}` },
  { say: 'done' },
];
const WORKER = `verify-inspector-worker-${stamp}`;
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `verify-inspector-main-${stamp}\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'spawn_session',
        arguments: {
          runtime: 'fixture',
          input: `${WORKER}\nfixture-script\n${JSON.stringify(steps('src/worker.ts'))}`,
        },
      },
    },
  ])}`,
});
const DIRECT = `verify-inspector-direct-${stamp}`;
const direct = await call('session.create', {
  project_id,
  runtime: 'fixture',
  workspace: 'worktree',
  input: `${DIRECT}\nfixture-script\n${JSON.stringify(steps('src/direct.ts'))}`,
});
const done = (s) => s?.last_turn && !['queued', 'running'].includes(s.last_turn.state);
const settled = await poll(async () => {
  const list = await query('session.list', { project_id });
  const w = list.find((s) => s.spawned_by?.session_id === conductor.id);
  const d = list.find((s) => s.id === direct.id);
  return done(w) && done(d) && { worker: w, direct: d };
}, 60_000);
const worker = settled?.worker;
check(
  '前置：worker 由主会话派出，回合跑完',
  worker?.spawned_by?.session_id === conductor.id && worker.last_turn.state === 'completed',
  worker && { id: worker.id, turn: worker.last_turn, spawned_by: worker.spawned_by },
);
check(
  '前置：直接会话回合跑完',
  settled?.direct?.last_turn?.state === 'completed',
  settled?.direct?.last_turn,
);

// The worker's gate: a run whose fail-step failed.
const gatesOf = (session_id) => query('session.gates', { session_id });
const lastRun = (g) => g?.last ?? null;
let gate = await gatesOf(worker.id);
if (!lastRun(gate) && !gate.running) {
  const rev = (await board()).sessions.find((s) => s.id === worker.id).revision;
  await call('session.gates.run', { session_id: worker.id }, rev);
}
gate = await poll(async () => {
  const g = await gatesOf(worker.id);
  return !g.running && lastRun(g) && g;
}, 60_000);
result.gate = gate?.last;
const failedBefore = gate?.last?.results?.filter((r) => r.exit_code !== 0).map((r) => r.name);
check(
  '前置：session.gates 的最后一次运行有失败步骤 fail-step',
  failedBefore?.includes('fail-step'),
  gate?.last,
);
const historyBefore = (await query('session.gates.history', { session_id: worker.id })).runs ?? [];

// Opens the Changes screen and the worker's change.
const navName = await page.evaluate(
  `[...document.querySelectorAll('aside button')].find((b) => b.getClientRects().length && /^改动\\d*$/.test(b.textContent.replace(/\\s+/g, '')))?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
);
await page.click({ role: 'button', name: navName ?? '改动', exact: true });
const changes = await query('project.changes', { project_id });
result.changes = changes.changes?.map((c) => ({
  id: c.id,
  title: c.title,
  spawned_by: c.spawned_by,
}));
const workerRow = changes.changes?.find((c) => c.id === `session:${worker.id}`);
const directRow = changes.changes?.find((c) => c.id === `session:${direct.id}`);
check('后端对照：project.changes 有 worker 和直接会话两行', workerRow && directRow, result.changes);
await page.waitFor(
  `!!document.getElementById(${JSON.stringify(`chg-session:${worker.id}`)})`,
  'the worker row in the changes list',
);
await page.evaluate(
  `document.getElementById(${JSON.stringify(`chg-session:${worker.id}`)}).click()`,
);
const inspector = () =>
  page.evaluate(`(() => {
    const a = document.querySelector('aside.chg-insp');
    if (!a) return null;
    const files = a.querySelector('ul.chg-dfl');
    const buttons = [...a.querySelectorAll('button')].filter((b) => b.getClientRects().length);
    const rerun = buttons.find((b) => b.textContent.trim() === '只重跑失败的');
    const send = buttons.find((b) => b.getAttribute('aria-label') === '发送' || b.getAttribute('aria-label') === '已发送');
    const ta = a.querySelector('textarea.chg-tell-ta');
    const radios = a.querySelector('[role=radiogroup]');
    return {
      title: a.getAttribute('aria-label'),
      files: files ? [...files.querySelectorAll('li .chg-dfl-h')].map((b) => b.getAttribute('aria-label')) : null,
      fileBars: files ? [...files.querySelectorAll('li .chg-dfb')].map((b) => b.getAttribute('aria-label')) : null,
      rerun: rerun ? { disabled: rerun.disabled } : null,
      send: send ? { name: send.getAttribute('aria-label'), disabled: send.disabled } : null,
      text: ta?.value ?? null,
      textLabel: ta?.getAttribute('aria-label') ?? null,
      recipient: radios ? { name: radios.getAttribute('aria-label'), options: [...radios.querySelectorAll('[role=radio]')].map((r) => r.textContent.trim()) } : null,
    };
  })()`);
const first = await poll(async () => {
  const v = await inspector();
  return v?.files?.length && v;
}, 15_000);
result.inspector = first;

// Changed files equal session.diff.
const diff = await query('session.diff', { session_id: worker.id });
result.diff = diff.files.map((f) => ({
  path: f.path,
  additions: f.additions,
  deletions: f.deletions,
}));
check(
  '改动的文件列表等于 session.diff 的文件',
  JSON.stringify(first?.files) ===
    JSON.stringify(diff.files.map((f) => `${f.path}，打开会话的差异`)),
  { shown: first?.files, daemon: result.diff },
);
check(
  '每行的行数条等于 session.diff 的加删行数',
  JSON.stringify(first?.fileBars) ===
    JSON.stringify(
      diff.files.map((f) => `${f.path}：加 ${f.additions ?? 0} 行，删 ${f.deletions ?? 0} 行`),
    ),
  first?.fileBars,
);
check(
  '对照组：文件列表里没有直接会话的 src/direct.ts',
  !first?.files?.some((f) => f.startsWith('src/direct.ts')),
  first?.files,
);

// The rerun button shows because the last run failed.
check(
  '门禁有失败步骤时显示 "只重跑失败的" 且可点',
  first?.rerun && !first.rerun.disabled,
  first?.rerun,
);

// Tell box: the prefilled reference alone keeps Send off; recipients show for a spawned session.
check(
  '告诉框预填改动引用',
  first?.text === `关于改动「${workerRow?.title}」（${workerRow?.branch}）：\n` ||
    first?.text === `关于改动「${workerRow?.title}」：\n`,
  { text: first?.text, row: { title: workerRow?.title, branch: workerRow?.branch } },
);
check('只有预填引用时 "发送" 不可点', first?.send && first.send.disabled, first?.send);
check(
  '有 spawned_by 时显示 "发给"：这个会话 / 主会话',
  first?.recipient?.name === '发给' &&
    JSON.stringify(first.recipient.options) === JSON.stringify(['这个会话', '主会话']),
  first?.recipient,
);
result.shot = await page.screenshot('changes.inspector');

// Rerun only the failed steps.
await page.click({ role: 'button', name: '只重跑失败的', exact: true });
const after = await poll(async () => {
  const runs = (await query('session.gates.history', { session_id: worker.id })).runs ?? [];
  const g = await gatesOf(worker.id);
  return runs.length > historyBefore.length && !g.running && { runs, gate: g };
}, 60_000);
result.after = after && { newest: after.runs[0], count: after.runs.length };
check('后端对照：点了以后 session.gates.history 多一次运行', after, result.after);
const step = (run, name) => run?.results?.find((r) => r.name === name);
check(
  '后端对照：新一次运行沿用了通过的 pass-step(carried),只重跑了 fail-step',
  step(after?.runs[0], 'pass-step')?.carried === true &&
    !step(after?.runs[0], 'fail-step')?.carried &&
    step(after?.runs[0], 'fail-step')?.exit_code === 3,
  after?.runs[0]?.results,
);
check(
  '对照组：上一次完整运行的 pass-step 不是 carried',
  after && !step(after.runs[1], 'pass-step')?.carried,
  after?.runs[1]?.results,
);
result.rerunState = await inspector();

// Types a message: Send turns on, and sends to the worker.
const before = (await query('session.list', { project_id })).find((s) => s.id === worker.id);
const MESSAGE = `please look ${stamp}`;
await page.fill(
  { role: 'textbox', name: '要告诉它的话', exact: true },
  `${first?.text ?? ''}${MESSAGE}`,
);
const typed = await poll(async () => {
  const v = await inspector();
  return v?.send && !v.send.disabled && v;
});
check('打了字以后 "发送" 可点', typed?.send && !typed.send.disabled, typed?.send);
await page.click({ role: 'button', name: '发送', exact: true });
const sentShown = await poll(async () => (await inspector())?.send?.name === '已发送');
check('发出后按钮变成 "已发送"', sentShown, (await inspector())?.send);
const transcript = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === worker.id);
  return s?.last_turn?.id !== before?.last_turn?.id && s;
}, 20_000);
result.sent = transcript && { last_turn: transcript.last_turn };
check('后端对照：worker 收到一个新回合', transcript, result.sent);

// A direct session has no recipient choice.
await page.evaluate(
  `document.getElementById(${JSON.stringify(`chg-session:${direct.id}`)}).click()`,
);
const directView = await poll(async () => {
  const v = await inspector();
  return v?.title === directRow?.title && v?.text !== null && v;
});
result.directView = directView;
const directGate = await gatesOf(direct.id);
result.directGate = directGate?.last ?? null;
check(
  '对照组：直接会话没有失败的门禁运行时不显示 "只重跑失败的"',
  directView &&
    directView.rerun === null &&
    !(directGate?.last?.results ?? []).some((r) => r.exit_code !== 0),
  { rerun: directView?.rerun, last: result.directGate },
);
check(
  '没有 spawned_by 的会话不显示 "发给" 选择',
  directView && directView.recipient === null,
  directView,
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
