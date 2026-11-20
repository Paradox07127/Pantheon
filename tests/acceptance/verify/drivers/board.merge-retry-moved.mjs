import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'board.merge-retry-moved', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

// A merge a failed gate blocked is not retried by a passing gate run once the worktree has a newer commit.
try {
  const stamp = Date.now();
  const { project_id, repo } = await newProject(`verify-merge-retry-moved-${stamp}`, {
    'README.md': '# retry\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "merge-retry-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
  const root = (await board()).projects.find((p) => p.id === project_id).roots?.[0] ?? repo;
  const gate = async (code) =>
    call(
      'project.gate.set',
      {
        project_id,
        root,
        commands: [{ name: 'Unit tests', argv: [process.execPath, '-e', `process.exit(${code})`] }],
      },
      await revision(),
    );
  await gate(1);
  await call('project.autoMerge.set', { project_id, enabled: true }, await revision());
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    await revision(),
  );
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const sessions = () => query('session.list', { project_id });
  const busy = (s) => s?.last_turn && ['queued', 'running'].includes(s.last_turn.state);
  const idle = (id) =>
    poll(async () => {
      const s = (await sessions()).find((x) => x.id === id);
      return s?.last_turn && !busy(s) && s;
    }, 30_000);
  const send = async (steps) => {
    await idle(assistant);
    await call(
      'session.send',
      { session_id: assistant, input: script(...steps) },
      (await board()).sessions.find((s) => s.id === assistant).revision,
    );
    return idle(assistant);
  };
  const TITLE = `Retry moved ${stamp}`;
  const plan = {
    base_version: 0,
    headline: `Retry ${stamp}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks: [
      {
        id: 'task-one',
        title: TITLE,
        goal: `${TITLE}.\n${script({ say: 'ok' })}`,
        lane: 'lane-a',
        milestone: 'milestone-a',
        estimate: 2,
        depends_on: [],
        source: ['The user asked for it.'],
        scope: ['src/index.ts'],
        acceptance: ['true'],
        kind: { domain: 'backend-logic', tier: 't1' },
        priority: 'normal',
      },
    ],
    milestones: [
      { id: 'milestone-a', title: 'Milestone A', criteria: ['It merges.'], tasks: ['task-one'] },
    ],
    risks: [],
    assumptions: [],
  };
  await send([{ tool: { name: 'update_board', arguments: plan } }]);
  await call('task.start', { project_id, lead_session_id: assistant, task_ids: ['task-one'] });
  const worker = await poll(
    async () => (await sessions()).find((s) => s.task?.id === 'task-one'),
    30_000,
  );
  check('前置：task-one 开出了任务会话', worker, worker?.id);
  await idle(worker.id);
  await send([
    {
      tool: {
        name: 'message_task',
        arguments: {
          task_id: 'task-one',
          text: `Write it ${stamp}\n${script(
            { write: { path: 'src/index.ts', text: 'export const answer = 43;\n' } },
            { commit: 'Answer' },
            { tool: { name: 'report', arguments: { kind: 'done', text: `Done ${stamp}` } } },
          )}`,
        },
      },
    },
  ]);
  const thread = () =>
    query('task.thread', { project_id, lead_session_id: assistant, task_id: 'task-one' });
  // Settled: the worker's merge is blocked by the gate, no turn runs and the thread stopped growing.
  let lastLength = -1;
  const settled = await poll(async () => {
    const [list, now] = await Promise.all([sessions(), thread()]);
    const w = list.find((s) => s.id === worker.id);
    const quiet =
      w?.merge?.state === 'blocked' &&
      w.merge.reason === 'gate_failed' &&
      !list.some(busy) &&
      now.length === lastLength;
    lastLength = now.length;
    return quiet && w;
  }, 60_000);
  result.blocked = settled?.merge;
  check(
    '前置：合并被失败的门禁挡住(merge.state blocked, reason gate_failed)',
    settled,
    settled?.merge,
  );

  // The candidate commit moves: one more commit in the session's worktree.
  const workspace = (await board()).workspaces.find((w) => w.id === settled.workspace_id);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) =>
    execFileSync('git', args, { cwd: workspace.path, env }).toString().trim();
  const before = git('rev-parse', 'HEAD');
  writeFileSync(path.join(workspace.path, 'src/extra.ts'), 'export const extra = 1;\n');
  git('add', '-A');
  git(
    '-c',
    'user.name=Verify App',
    '-c',
    'user.email=verify-app@example.invalid',
    'commit',
    '-q',
    '-m',
    'Extra',
  );
  const after = git('rev-parse', 'HEAD');
  check('前置：工作树多了一个提交', after !== before, { before, after });

  await gate(0);
  await call(
    'session.gates.run',
    { session_id: worker.id },
    (await board()).sessions.find((s) => s.id === worker.id).revision,
  );
  const passed = await poll(
    async () => (await thread()).find((e) => e.kind === 'gate' && e.passed),
    40_000,
  );
  check('前置：用户跑的门禁通过了', passed, passed?.event_id);
  // A retry would follow the passed gate within seconds; this waits for one and expects none.
  const merged = await poll(
    async () =>
      (await thread()).find(
        (e) => e.kind === 'merged' || (e.kind === 'merge_blocked' && e.at > passed.at),
      ),
    15_000,
  );
  const [list, entries] = await Promise.all([sessions(), thread()]);
  const w = list.find((s) => s.id === worker.id);
  result.daemon_kinds = entries.map((e) => e.kind + (e.kind === 'gate' ? `:${e.passed}` : ''));
  result.merge_after = w?.merge;
  check('后端对照：门禁通过后没有重试合并(task.thread 没有新的合并或合并受阻)', !merged, merged);
  check('后端对照：session.list 的合并仍是 blocked', w?.merge?.state === 'blocked', w?.merge);

  // The drawer's thread: the passed gate is the last line, with no merge after it.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '流程图', exact: true });
  await page.click({ role: 'radio', name: '全部', exact: true });
  await page.click({ role: 'group', name: `${TITLE}，`, exact: false });
  const listJs = `[...(document.querySelector(${JSON.stringify(`ol[aria-label="${TITLE} 的往来记录"]`)})?.children ?? [])].map((li) => li.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160))`;
  const listed = await poll(async () => {
    const rows = await page.evaluate(listJs);
    return rows.length === entries.length && rows;
  }, 15_000);
  result.listed = listed;
  check('往来记录行数等于 task.thread 的条数', listed?.length === entries.length, {
    ui: listed?.length,
    daemon: entries.length,
  });
  check(
    '往来记录里没有 "已合并"',
    Array.isArray(listed) && !listed.some((x) => /^\S+ 已合并 /.test(x)),
    listed,
  );
  check(
    '对照组：往来记录里有 "门禁通过"',
    Array.isArray(listed) && listed.some((x) => /^\S+ 门禁通过 /.test(x)),
    listed?.map((x) => x.split(' ')[1]),
  );
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
