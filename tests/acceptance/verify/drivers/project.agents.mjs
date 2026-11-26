import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.agents', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-project-agents-${stamp}`, {
  'README.md': '# project agents\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-agents-fixture", "private": true }\n',
});
const MAIN = `verify-agents-main-${stamp}`;
const BUSY = `verify-agents-busy-${stamp}`;
const DONE = `verify-agents-done-${stamp}`;
const DIRECT = `verify-agents-direct-${stamp}`;
const spawn = (title, steps) => ({
  tool: {
    name: 'spawn_session',
    arguments: { runtime: 'fixture', input: `${title}\nfixture-script\n${JSON.stringify(steps)}` },
  },
});
// The main agent starts one session that keeps running and one that finishes.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([
    spawn(BUSY, [{ hang: true }]),
    spawn(DONE, [{ say: 'done' }]),
    { say: 'ok' },
  ])}`,
});
await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${DIRECT}\nfixture-script\n${JSON.stringify([{ say: 'done' }])}`,
});
const active = (s) =>
  ['starting', 'running', 'waiting'].includes(s.state) ||
  ['queued', 'running'].includes(s.last_turn?.state);
const list = await poll(async () => {
  const all = await query('session.list', { project_id });
  const spawned = all.filter((s) => s.spawned_by?.session_id === conductor.id);
  const done = spawned.find((s) => s.title === DONE);
  const busy = spawned.find((s) => s.title === BUSY);
  const direct = all.find((s) => s.title === DIRECT);
  return (
    done?.last_turn?.state === 'completed' &&
    busy?.state === 'running' &&
    direct?.last_turn?.state === 'completed' && { all, spawned }
  );
}, 60_000);
check(
  '前置：主 agent 起了两个会话，一个在跑一个跑完',
  list,
  list?.spawned?.map((s) => [s.title, s.state]),
);
const main = list?.all.find((s) => s.id === conductor.id);
const spawned = list?.spawned ?? [];
const running = spawned.filter(active).length;
result.backend = { main: main?.title, spawned: spawned.map((s) => s.title), running };

await page.click({ role: 'button', name: '项目', exact: true });
const readAgents = () =>
  page.evaluate(`(() => {
    const r = [...document.querySelectorAll('section[aria-label="Agent"]')].find((e) => e.getClientRects().length);
    if (!r) return null;
    return {
      count: r.querySelector('[role=img]')?.textContent.trim() ?? null,
      countLabel: r.querySelector('[role=img]')?.getAttribute('aria-label') ?? null,
      rows: [...r.querySelectorAll('li button')].map((b) => ({
        title: b.querySelector('.clip-1')?.textContent.trim(),
        crown: !!b.querySelector('.lucide-crown'),
        text: b.textContent.replace(/\\s+/g, ' ').trim(),
        // Past the status icon and the title block, anything else in the row is the context ring.
        ring: [...b.children].filter((c) => !c.classList.contains('pj-at')).length > 1,
      })),
    };
  })()`);
const shown =
  (await poll(async () => {
    const v = await readAgents();
    return v?.rows.length === 1 + spawned.length && v;
  }, 15_000)) || (await readAgents());
result.shown = shown;
check(
  '第一行是主 agent,带皇冠图标',
  shown?.rows[0]?.title === MAIN && shown.rows[0].crown,
  shown?.rows[0],
);
check(
  '后端对照：其后是 spawned_by 为主 agent 的会话',
  JSON.stringify(
    shown?.rows
      .slice(1)
      .map((r) => r.title)
      .sort(),
  ) === JSON.stringify(spawned.map((s) => s.title).sort()),
  { shown: shown?.rows.map((r) => r.title), backend: result.backend },
);
check(
  '别的会话不出现',
  !shown?.rows.some((r) => r.title === DIRECT),
  shown?.rows.map((r) => r.title),
);
check('只有主 agent 一行带皇冠', shown?.rows.filter((r) => r.crown).length === 1, shown?.rows);
check(
  `标题旁 "N / 4" 的 N 等于在跑的起的会话数 ${running}`,
  shown?.count === `${running} / 4`,
  shown?.count,
);
check('对照组：N 读法对错的值判 false', shown?.count !== `${running + 1} / 4`, shown?.count);
const byTitle = Object.fromEntries((list?.all ?? []).map((s) => [s.title, s]));
const extras = shown?.rows.map((r) => {
  const s = byTitle[r.title];
  return {
    title: r.title,
    headline: s?.recap?.headline ?? null,
    context: !!s?.context,
    text: r.text,
    ring: r.ring,
  };
});
result.extras = extras;
check(
  '有 recap.headline 才显示、有 context 才显示上下文环',
  extras?.every((e) => (e.headline ? e.text.includes(e.headline) : true) && e.ring === e.context),
  extras,
);
result.shot = await page.screenshot(result.id);

// Clicking the busy row opens that session.
const busy = spawned.find((s) => s.title === BUSY);
await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="Agent"] li button')].find((b) => b.textContent.includes(${JSON.stringify(BUSY)}))?.click()`,
);
const opened = await poll(
  () =>
    page.evaluate(`(() => {
      const m = [...document.querySelectorAll('main[aria-label="对话"]')].find((e) => e.getClientRects().length);
      const agents = [...document.querySelectorAll('section[aria-label="Agent"]')].some((e) => e.getClientRects().length);
      return m && !agents ? { text: m.innerText.slice(0, 400), current: [...document.querySelectorAll("[aria-current]")].filter((e) => e.getClientRects().length).map((e) => (e.getAttribute("aria-label") ?? e.textContent).slice(0, 120)) } : null;
    })()`),
  10_000,
);
result.opened = opened;
// The sidebar marks the open session's row with aria-current.
const currentRow = (title) => opened?.current.some((c) => c.startsWith(`${title}，fixture`));
check(
  '点行打开那个会话：会话屏显示它，侧栏它的行 aria-current',
  currentRow(BUSY) && opened.text.includes(BUSY),
  opened,
);
check('对照组：打开的不是主 agent', opened && !currentRow(MAIN), opened?.current);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
