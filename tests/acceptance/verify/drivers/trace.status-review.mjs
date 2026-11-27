import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, newProject } = await open(runDir, { ms: 300_000 });
const result = { id: 'trace.status-review', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Today as screens/trace/StatusReview.tsx reads it: local midnight to the coming midnight.
const day = new Date();
const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();

const stamp = Date.now();
const { project_id } = await newProject(`verify-recap-${stamp}`, {
  'README.md': '# recap\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "recap-fixture", "private": true }\n',
});
const status = () =>
  query('project.status.read', { project_id, from: String(from), to: String(to) });
const BLOCKS = ['落地', '等你', '时间去向', '各角色 token'];
const EMPTY = {
  落地: '这段时间没有落地。',
  等你: '这段时间没有等你的事。',
  时间去向: '这段时间没有跑回合或门禁。',
  '各角色 token': '这段时间没有报告 token 用量。',
};
// Each block of the open recap: its empty sentence and its number cells by label.
const panel = () =>
  page.evaluate(`(() => {
    const aside = [...document.querySelectorAll('aside')].find((el) => el.getAttribute('aria-label') === '复盘' && el.getClientRects().length);
    if (!aside) return null;
    const blocks = {};
    for (const s of aside.querySelectorAll('section')) {
      const nums = {};
      for (const n of s.querySelectorAll('.trc-num')) nums[n.querySelector('span').textContent.trim()] = n.querySelector('b').textContent.trim();
      blocks[s.getAttribute('aria-label')] = {
        empty: s.querySelector('.es-in')?.textContent.trim() ?? null,
        nums,
        rows: [...s.querySelectorAll('li')].map((li) => ({ text: li.textContent.trim(), open: !!li.querySelector('[aria-label="还在等"]') })),
      };
    }
    return { busy: aside.getAttribute('aria-busy') === 'true', failed: !!aside.querySelector('[role=alert]'), blocks };
  })()`);
const daemonEmpty = (s) => ({
  落地: s.landings.records.length === 0,
  等你: s.waiting.count === 0,
  时间去向: s.time.gate_ms === 0 && s.time.roles.every((r) => r.turn_ms === 0),
  '各角色 token': s.usage.every((r) => r.input_tokens + r.output_tokens === 0),
});

// The trace page, its timeline tab, and the recap from the bar.
await page.click({ role: 'button', name: '搜索', exact: true });
await page.waitFor(`!!document.querySelector('.cmdk input')`, 'the command palette to open');
const box = await page.evaluate(`document.querySelector('.cmdk input').getAttribute('aria-label')`);
await page.fill({ role: 'combobox', name: box, exact: true }, '最近动态');
await page.click({ role: 'option', name: '最近动态', exact: true });
await page.click({ role: 'tab', name: '时间轴', exact: true });
await page.click({ role: 'button', name: '复盘', exact: true });
const radios = () =>
  page.evaluate(
    `[...document.querySelectorAll('aside[aria-label="复盘"] [role=radio]')].map((el) => ({ name: el.textContent.trim(), checked: el.getAttribute('aria-checked') === 'true' }))`,
  );
check(
  '面板顶部的时间窗是 今天 / 最近 7 天 / 最近 30 天，默认今天',
  JSON.stringify(await poll(radios)) ===
    JSON.stringify([
      { name: '今天', checked: true },
      { name: '最近 7 天', checked: false },
      { name: '最近 30 天', checked: false },
    ]),
  await radios(),
);

// Control: today before this project's session holds none of its events.
const before = await status();
result.before = before;
const shownBefore = await poll(async () => {
  const p = await panel();
  return p && !p.busy && Object.keys(p.blocks).length === 4 && p;
});
check(
  '对照组：project.status.read 今天在会话开始前四块都为空',
  Object.values(daemonEmpty(before)).every(Boolean),
  daemonEmpty(before),
);
check(
  '对照组：空窗口时四块各写一句 "这段时间没有…"',
  shownBefore && BLOCKS.every((b) => shownBefore.blocks[b]?.empty === EMPTY[b]),
  shownBefore,
);

// A session asks once, the driver allows it, and the session commits and lands.
const TITLE = `verify-recap-${stamp}`;
const session = await call('session.create', {
  project_id,
  runtime: 'fixture',
  workspace: 'worktree',
  permission_mode: 'ask',
  input: `${TITLE}\nfixture-script\n${JSON.stringify([
    { ask: { tool: 'Bash', input: { command: `pnpm test --filter recap-${stamp}` } } },
    { write: { path: 'src/recap.ts', text: `export const recap = ${stamp};\n` } },
    { commit: `recap ${stamp}` },
    { say: 'done' },
  ])}`,
});
const asked = await poll(async () =>
  (await query('needs_you.list')).items.find(
    (i) => i.kind === 'permission' && i.session_id === session.id,
  ),
);
check('前置：会话发出一个权限请求', asked, asked?.source?.id);
if (asked)
  await call(
    'approval.respond',
    { approval_id: asked.source.id, decision: 'approve' },
    asked.source.revision,
  );
const ready = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === session.id);
  return s?.state === 'ready' && s.ahead > 0 && s;
}, 60_000);
check('前置：批准后会话跑完、有提交', ready, ready && { state: ready.state, ahead: ready.ahead });
const revision = (await query('board', { project_id })).sessions.find(
  (s) => s.id === session.id,
)?.revision;
try {
  await call('session.merge', { session_id: session.id }, revision);
} catch (error) {
  result.mergeError = String(error.message).slice(0, 500);
}
const after = await poll(async () => {
  const s = await status();
  return s.landings.landed > 0 && s.waiting.count > 0 && s;
}, 60_000);
result.after = after;
check(
  '前置：project.status.read 今天有落地和等你',
  after,
  after && {
    landed: after.landings.landed,
    waits: after.waiting.count,
  },
);

// The open recap reads again after the landing; "today" is picked once more by hand.
await page.click({ role: 'radio', name: '最近 7 天', exact: true });
await page.click({ role: 'radio', name: '今天', exact: true });
const daemon = await status();
const shown = await poll(async () => {
  const p = await panel();
  return (
    p &&
    !p.busy &&
    p.blocks['落地']?.nums['已落地'] === String(daemon.landings.landed) &&
    p.blocks['等你']?.nums['次数'] === String(daemon.waiting.count) &&
    p
  );
});
result.shown = shown || (await panel());
check(
  '落地块的 "已落地" 等于 project.status.read 的 landings.landed',
  shown && shown.blocks['落地'].nums['已落地'] === String(daemon.landings.landed),
  { ui: result.shown?.blocks?.['落地']?.nums, daemon: daemon.landings.landed },
);
check(
  '等你块的 "次数" 等于 project.status.read 的 waiting.count',
  shown && shown.blocks['等你'].nums['次数'] === String(daemon.waiting.count),
  { ui: result.shown?.blocks?.['等你']?.nums, daemon: daemon.waiting.count },
);
check(
  '落地记录一行一条，行上是会话标题',
  shown &&
    shown.blocks['落地'].rows.length === daemon.landings.records.length &&
    shown.blocks['落地'].rows.some((r) => r.text.startsWith(ready?.title ?? TITLE)),
  { ui: result.shown?.blocks?.['落地']?.rows, daemon: daemon.landings.records.length },
);
check(
  '对照组：已落地多一时判 false',
  !(shown && shown.blocks['落地'].nums['已落地'] === String(daemon.landings.landed + 1)),
);
check(
  '对照组：有落地和等你后这两块不再写 "这段时间没有…"',
  shown && shown.blocks['落地'].empty === null && shown.blocks['等你'].empty === null,
  shown && { 落地: shown.blocks['落地'].empty, 等你: shown.blocks['等你'].empty },
);
result.shot = await page.screenshot('trace-status-review');
copyFileSync(
  path.join(runDir, result.shot.file),
  path.join(runDir, 'screens', 'trace-status-review.png'),
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
