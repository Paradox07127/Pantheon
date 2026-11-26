import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.unplanned', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-unplanned-${stamp}`, {
  'README.md': '# project unplanned\n',
  'src/index.ts': 'export const answer = 42;\nexport const gone = 1;\n',
  'package.json': '{ "name": "project-unplanned-fixture", "private": true }\n',
});
const create = (title, steps) =>
  call('session.create', {
    project_id,
    runtime: 'fixture',
    workspace: 'worktree',
    input: `${title}\nfixture-script\n${JSON.stringify(steps)}`,
  });
// One session adds and removes lines and commits; one keeps running with no changes.
const CHANGED = `verify-unplanned-changed-${stamp}`;
const QUIET = `verify-unplanned-quiet-${stamp}`;
const changed = await create(CHANGED, [
  { write: { path: 'src/index.ts', text: 'export const answer = 43;\n' } },
  { write: { path: 'src/extra.ts', text: 'export const a = 1;\nexport const b = 2;\n' } },
  { commit: `change ${stamp}` },
  { say: 'done' },
]);
await create(QUIET, [{ hang: true }]);
const plan = await poll(async () => {
  const p = await query('project.plan', { project_id });
  const row = p.unplanned.find((u) => u.id === `session:${changed.id}`);
  return p.unplanned.length >= 2 && row?.changes?.files > 0 && row.status !== 'running' && p;
}, 60_000);
result.unplanned = plan?.unplanned?.map((u) => ({
  id: u.id,
  title: u.title,
  status: u.status,
  runtime: u.runtime,
  changes: u.changes,
  gate: u.gate,
}));
check('前置：project.plan 的 unplanned 有两个会话，改动行有改动', plan, result.unplanned);

await page.click({ role: 'button', name: '项目', exact: true });
const readList = () =>
  page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section[aria-label="计划外"]')].find((e) => e.getClientRects().length);
    if (!r) return null;
    return {
      count: r.querySelector('.pj-lh')?.textContent.replace(/\\s+/g, ' ').replace(/^计划外\\s*/, '').trim(),
      rows: [...r.querySelectorAll('li > button')].map((b) => ({
        // The row's labelled images: the status icon, the runtime glyph, then the gate icon.
        images: [...b.querySelectorAll('[role=img]')].map((i) => i.getAttribute('aria-label')),
        title: b.querySelector('.clip-1')?.textContent.trim(),
        diff: b.querySelector('.pj-diff')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
        gate: b.querySelector('.pj-gate')?.textContent.trim() ?? null,
      })),
    };
  })()`);
const shown =
  (await poll(async () => {
    const v = await readList();
    return v?.rows.length === plan?.unplanned.length && v;
  }, 15_000)) || (await readList());
result.shown = shown;
check('后端对照：标题旁条数等于 unplanned 条数', shown?.count === String(plan?.unplanned.length), {
  shown: shown?.count,
  daemon: plan?.unplanned.length,
});
check(
  '后端对照：各行标题等于 unplanned 的标题',
  JSON.stringify(shown?.rows.map((r) => r.title).sort()) ===
    JSON.stringify(plan?.unplanned.map((u) => u.title).sort()),
  shown?.rows.map((r) => r.title),
);
check('对照组：不存在的标题不在列表里', !shown?.rows.some((r) => r.title === `${CHANGED}-absent`));
const byTitle = Object.fromEntries((plan?.unplanned ?? []).map((u) => [u.title, u]));
const rowsOk = shown?.rows.map((r) => {
  const u = byTitle[r.title];
  return {
    title: r.title,
    icon: r.images.length >= 2 && r.images[0] !== u?.runtime,
    runtime: r.images[1] === u?.runtime,
    diff: r.diff === `+${u?.changes?.additions ?? 0} −${u?.changes?.deletions ?? 0}`,
    gate: Boolean(r.gate),
  };
});
result.rowsOk = rowsOk;
check(
  '每行有状态图标、标题、运行时、+N −N(等于 changes)、门禁一句话',
  rowsOk?.length && rowsOk.every((r) => r.icon && r.runtime && r.diff && r.gate),
  { rowsOk, rows: shown?.rows },
);
const changedRow = shown?.rows.find((r) => r.title === CHANGED);
check(
  '对照组：改动行的 +N −N 不是 +0 −0',
  changedRow && changedRow.diff !== '+0 −0',
  changedRow?.diff,
);
result.shot = await page.screenshot(result.id);

// A session's row opens that session.
await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="计划外"] li > button')].find((b) => b.textContent.includes(${JSON.stringify(CHANGED)}))?.click()`,
);
const opened = await poll(
  () =>
    page.evaluate(`(() => {
      const m = [...document.querySelectorAll('main[aria-label="对话"]')].find((e) => e.getClientRects().length);
      const list = [...document.querySelectorAll('section[aria-label="计划外"]')].some((e) => e.getClientRects().length);
      return m && !list ? { text: m.innerText.slice(0, 300), current: [...document.querySelectorAll('[aria-current]')].filter((e) => e.getClientRects().length).map((e) => (e.getAttribute('aria-label') ?? e.textContent).slice(0, 120)) } : null;
    })()`),
  10_000,
);
result.opened = opened;
// The sidebar marks the open session's row with aria-current.
const currentRow = (title) => opened?.current.some((c) => c.startsWith(`${title}，fixture`));
check('点会话行打开那个会话(侧栏它的行 aria-current)', currentRow(CHANGED), opened);
check('对照组：打开的不是另一个会话', opened && !currentRow(QUIET), opened?.current);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
