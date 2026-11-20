import { open } from '../page.mjs';
import { projectShown } from '../../lib/desktop-app.mjs';
const { run, page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'board.drawer-keep', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

// The open drawer is the complementary region named by its heading, which carries the task title.
const drawerJs = `(() => {
  const d = [...document.querySelectorAll('aside[aria-labelledby]')].find((el) => el.getClientRects().length);
  return d ? document.getElementById(d.getAttribute('aria-labelledby'))?.getAttribute('aria-label') ?? '' : null;
})()`;
const drawer = () => page.evaluate(drawerJs);

try {
  const stamp = Date.now();
  const name = `verify-drawer-keep-${stamp}`;
  const { project_id } = await newProject(name, {
    'README.md': '# drawer\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "drawer-keep-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    await revision(),
  );
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const sessions = () => query('session.list', { project_id });
  const idle = (id) =>
    poll(async () => {
      const s = (await sessions()).find((x) => x.id === id);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const TITLE = `Keep drawer ${stamp}`;
  const OTHER = `Other task ${stamp}`;
  const task = (id, title) => ({
    id,
    title,
    goal: `${title}.\n${script({ say: 'ok' })}`,
    lane: 'lane-a',
    milestone: 'milestone-a',
    estimate: 2,
    depends_on: [],
    source: ['The user asked for it.'],
    scope: ['src/index.ts'],
    acceptance: ['true'],
    kind: { domain: 'backend-logic', tier: 't1' },
    priority: 'normal',
  });
  const plan = {
    base_version: 0,
    headline: `Drawer ${stamp}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks: [task('task-one', TITLE), task('task-two', OTHER)],
    milestones: [
      {
        id: 'milestone-a',
        title: 'Milestone A',
        criteria: ['It merges.'],
        tasks: ['task-one', 'task-two'],
      },
    ],
    risks: [],
    assumptions: [],
  };
  await idle(assistant);
  await call(
    'session.send',
    { session_id: assistant, input: script({ tool: { name: 'update_board', arguments: plan } }) },
    (await board()).sessions.find((s) => s.id === assistant).revision,
  );
  await idle(assistant);
  await call('task.start', { project_id, lead_session_id: assistant, task_ids: ['task-one'] });
  const worker = await poll(
    async () => (await sessions()).find((s) => s.task?.id === 'task-one'),
    30_000,
  );
  check('前置：task-one 开出了任务会话', worker, worker?.id);
  await idle(worker.id);

  // Board > Tasks > Flow > the task's node opens its drawer.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '流程图', exact: true });
  await page.click({ role: 'radio', name: '全部', exact: true });
  await page.click({ role: 'group', name: `${TITLE}，`, exact: false });
  const opened = await poll(async () => (await drawer()) === TITLE && TITLE);
  check('点任务节点后抽屉开着，标题是该任务', opened === TITLE, await drawer());

  // The drawer's session link moves to the sessions screen.
  const sessionTitle = (await sessions()).find((s) => s.id === worker.id)?.title;
  result.worker_title = sessionTitle;
  await page.click({ role: 'button', name: `打开会话 ${sessionTitle}`, exact: true });
  const left = await poll(async () => (await drawer()) === null, 5000);
  check('点会话链接后看板(连同抽屉)不再显示', left, await drawer());
  const headings = await page.evaluate(
    `[...document.querySelectorAll('h1, h2')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim()).slice(0, 8)`,
  );
  check(
    '会话屏的标题是任务会话',
    headings.some((h) => h.includes(sessionTitle)),
    headings,
  );

  await page.click({ role: 'button', name: '项目看板', exact: true });
  const back = await poll(async () => (await drawer()) === TITLE && TITLE, 5000);
  check('回看板后抽屉仍开着且是同一个任务', back === TITLE, await drawer());
  check('对照组：抽屉标题不是另一个任务', (await drawer()) !== OTHER, await drawer());

  // Another project, then back: the drawer is closed.
  const switchTo = async (project) => {
    await page.click({ role: 'button', name: '切换项目', exact: true });
    await page.click({ role: 'menuitemradio', name: project, exact: false });
    await page.waitFor(projectShown(project), `the sidebar to show project ${project}`);
  };
  await switchTo(run.project_name);
  await switchTo(name);
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('[role="radio"]')].some((el) => el.getAttribute('aria-label') === '任务' || el.textContent.trim() === '任务')`,
    ),
  );
  // Waits long enough that a drawer that reopens would have done so.
  const reopened = await poll(async () => (await drawer()) !== null, 3000);
  check('换到另一个项目再换回来，抽屉是关的', !reopened, await drawer());
  const view = await query('board.view', { project_id, days: 'all' });
  result.daemon_task = view.tasks?.find((t) => t.title === TITLE)?.id;
  check(
    '后端对照：board.view 里抽屉的任务是 task-one',
    result.daemon_task === `${assistant}:task-one`,
    result.daemon_task,
  );
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
