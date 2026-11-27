import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.overlap-hint', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-overlap-${stamp}`, {
  'README.md': '# overlap\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "overlap-fixture", "private": true }\n',
});
const revision = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id).revision;
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await revision(),
);

// The main agent starts two sessions that write the same file and one that writes another.
const SAME_A = `verify-overlap-a-${stamp}`;
const SAME_B = `verify-overlap-b-${stamp}`;
const OTHER = `verify-overlap-other-${stamp}`;
const spawn = (title, path) => ({
  tool: {
    name: 'spawn_session',
    arguments: {
      runtime: 'fixture',
      input: `${title}\nfixture-script\n${JSON.stringify([
        { write: { path, text: `export const by = '${title}';\n` } },
        { say: 'done' },
      ])}`,
    },
  },
});
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `verify-overlap-main-${stamp}\nfixture-script\n${JSON.stringify([
    spawn(SAME_A, 'src/shared.ts'),
    spawn(SAME_B, 'src/shared.ts'),
    spawn(OTHER, 'src/other.ts'),
    { say: 'ok' },
  ])}`,
});
const settled = await poll(async () => {
  const [list, overlap] = await Promise.all([
    query('session.list', { project_id }),
    query('project.overlap', { project_id }),
  ]);
  const spawned = list.filter((s) => s.spawned_by?.session_id === conductor.id);
  const byTitle = Object.fromEntries(spawned.map((s) => [s.title, s]));
  return (
    [SAME_A, SAME_B, OTHER].every((t) => byTitle[t]?.last_turn?.state === 'completed') &&
    overlap.pairs.length > 0 && { byTitle, overlap }
  );
}, 60_000);
const ids = settled
  ? {
      a: settled.byTitle[SAME_A].id,
      b: settled.byTitle[SAME_B].id,
      other: settled.byTitle[OTHER].id,
    }
  : {};
result.backend = settled?.overlap;
check(
  '前置：三个起的会话回合跑完，project.overlap 有结果',
  settled,
  settled && Object.values(settled.byTitle).map((s) => [s.title, s.last_turn?.state]),
);
const pairs = settled?.overlap.pairs ?? [];
check(
  '后端对照：project.overlap 只有 A、B 一对，共同文件是 src/shared.ts',
  pairs.length === 1 &&
    [...pairs[0].session_ids].sort().join() === [ids.a, ids.b].sort().join() &&
    JSON.stringify(pairs[0].paths) === JSON.stringify(['src/shared.ts']),
  pairs,
);

await page.click({ role: 'button', name: '项目', exact: true });
const readRows = () =>
  page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section[aria-label="Agent"]')].find((e) => e.getClientRects().length);
    if (!r) return null;
    return Object.fromEntries([...r.querySelectorAll('li button')].map((b) => [
      b.querySelector('.clip-1')?.textContent.trim(),
      [...b.querySelectorAll('.pj-sub')].map((s) => s.textContent.trim()),
    ]));
  })()`);
const line = (title) => `和「${title}」改了同一个文件`;
const rows =
  (await poll(async () => {
    const v = await readRows();
    return v?.[SAME_A]?.includes(line(SAME_B)) && v?.[SAME_B]?.includes(line(SAME_A)) && v;
  }, 20_000)) || (await readRows());
result.rows = rows;
check(`A 的行写 "${line(SAME_B)}"`, rows?.[SAME_A]?.includes(line(SAME_B)), rows?.[SAME_A]);
check(`B 的行写 "${line(SAME_A)}"`, rows?.[SAME_B]?.includes(line(SAME_A)), rows?.[SAME_B]);
check(
  '对照组：写别的文件的会话行上没有这句',
  rows?.[OTHER] && !rows[OTHER].some((s) => s.includes('改了同一个文件')),
  rows?.[OTHER],
);
check(
  '对照组：A 的行不写和 OTHER 改了同一个文件',
  rows?.[SAME_A] && !rows[SAME_A].includes(line(OTHER)),
  rows?.[SAME_A],
);
const unplanned = await poll(
  () =>
    page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section[aria-label="计划外"]')].find((e) => e.getClientRects().length);
    if (!r) return null;
    return Object.fromEntries([...r.querySelectorAll('li .pj-t')].map((t) => [
      t.querySelector('.clip-1')?.textContent.trim(),
      [...t.querySelectorAll('.pj-why')].map((s) => s.textContent.trim()),
    ]));
  })()`),
  10_000,
);
result.unplanned = unplanned;
check(
  `计划外列表里 A 的行写 "${line(SAME_B)}"`,
  unplanned?.[SAME_A]?.includes(line(SAME_B)),
  unplanned?.[SAME_A],
);
check(
  '对照组：计划外列表里写别的文件的会话行上没有这句',
  unplanned?.[OTHER] && unplanned[OTHER].length === 0,
  unplanned?.[OTHER],
);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
