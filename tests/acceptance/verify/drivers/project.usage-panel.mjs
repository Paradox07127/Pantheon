import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.usage-panel', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-usage-${stamp}`, {
  'README.md': '# usage\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "usage-fixture", "private": true }\n',
});
const WORKER = `verify-usage-worker-${stamp}`;
const DIRECT = `verify-usage-direct-${stamp}`;
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `verify-usage-main-${stamp}\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'spawn_session',
        arguments: {
          runtime: 'fixture',
          input: `${WORKER}\nfixture-script\n${JSON.stringify([{ say: 'done' }])}`,
        },
      },
    },
    { say: 'ok' },
  ])}`,
});
const direct = await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${DIRECT}\nfixture-script\n${JSON.stringify([{ say: 'done' }])}`,
});
const timezone = await page.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
// Settled once every turn ended and both reads count all three sessions' turns.
const settled = await poll(async () => {
  const [list, roles, daily] = await Promise.all([
    query('session.list', { project_id }),
    query('project.usage.read', { project_id }),
    query('project.usage.daily', { project_id, days: '14', timezone }),
  ]);
  const ended = (id) => list.find((s) => s.id === id)?.last_turn?.state === 'completed';
  const worker = list.find((s) => s.spawned_by?.session_id === conductor.id);
  const turns = (rows) => rows.reduce((n, r) => n + r.turns, 0);
  return (
    ended(conductor.id) &&
    ended(direct.id) &&
    worker &&
    ended(worker.id) &&
    turns(roles) >= 3 &&
    turns(daily.days.flatMap((d) => d.roles)) >= 3 && { roles, daily }
  );
}, 60_000);
check(
  '前置：主 agent、它起的会话和直接会话的回合都跑完，两条用量查询都数到',
  settled,
  settled?.roles,
);
const roles = settled?.roles ?? [];
const daily = settled?.daily ?? { days: [] };
result.backend = { roles, days: daily.days.length };

await page.click({ role: 'button', name: '项目', exact: true });
const SECTION = `[...document.querySelectorAll('section[aria-label="用量"]')].find((e) => e.getClientRects().length)`;
const readPanel = () =>
  page.evaluate(`(() => {
    const s = ${SECTION};
    if (!s) return null;
    const visible = (label) => [...s.querySelectorAll('section')].some((e) => e.getAttribute('aria-label') === label && e.getClientRects().length);
    return {
      expanded: s.querySelector('h2 button')?.getAttribute('aria-expanded'),
      byRole: visible('按角色，全部时间'),
      byDay: visible('最近 14 天'),
      bars: [...s.querySelectorAll('.pj-ur')].map((r) => ({
        label: r.querySelector('.pj-url')?.textContent.trim(),
        tokens: r.querySelector('.pj-un')?.textContent.trim(),
        aria: r.querySelector('[role=img]')?.getAttribute('aria-label'),
      })),
      days: [...s.querySelectorAll('svg g[data-day]')].map((g) => ({
        day: g.getAttribute('data-day'),
        roles: [...g.querySelectorAll('rect[data-role]')].map((r) => r.getAttribute('data-role')),
      })),
      text: s.innerText,
    };
  })()`);
const folded = await poll(async () => (await readPanel()) ?? false);
check(
  '用量区块默认折叠，两块都不在',
  folded?.expanded === 'false' && !folded.byRole && !folded.byDay,
  folded && { expanded: folded.expanded, byRole: folded.byRole, byDay: folded.byDay },
);
await page.evaluate(`${SECTION}.querySelector('h2 button').click()`);
const LABEL = {
  user: '你开的会话',
  conductor: '主 agent',
  spawned: '主 agent 起的会话',
  reviewer: '审查',
  baseline: '基线',
  story: '变更说明',
};
const opened = await poll(async () => {
  const v = await readPanel();
  return v?.byRole && v.byDay && v.bars.length === roles.length && v.days.length > 0 && v;
}, 15_000);
result.opened = opened && { ...opened, text: opened.text.slice(0, 400) };
check(
  '展开后按角色和最近 14 天两块都在',
  opened?.expanded === 'true' && opened.byRole && opened.byDay,
  opened && { expanded: opened.expanded, byRole: opened.byRole, byDay: opened.byDay },
);
const tokenText = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(Math.round(n));
const expected = roles.map((r) => ({
  label: LABEL[r.role],
  tokens: tokenText(r.input_tokens + r.output_tokens),
  turns: `${r.turns} 回合`,
}));
const matches = (bars, want) =>
  bars.length === want.length &&
  want.every((w) =>
    bars.some((b) => b.label === w.label && b.tokens === w.tokens && b.aria?.endsWith(w.turns)),
  );
check(
  '后端对照：角色横条的角色、token 和回合数等于 project.usage.read',
  matches(opened?.bars ?? [], expected),
  {
    ui: opened?.bars,
    daemon: expected,
  },
);
check(
  '对照组：回合数多一的预期判 false',
  !matches(
    opened?.bars ?? [],
    expected.map((w, i) => (i === 0 ? { ...w, turns: `${roles[0].turns + 1} 回合` } : w)),
  ),
);

await page.click({ role: 'radio', name: '回合', exact: true });
const wantDays = daily.days.map((d) => ({
  day: d.date,
  roles: ['user', 'conductor', 'spawned', 'reviewer', 'baseline', 'story'].filter((role) =>
    d.roles.some((r) => r.role === role && r.turns > 0),
  ),
}));
const byTurns = await poll(async () => {
  const v = await readPanel();
  return v && JSON.stringify(v.days) === JSON.stringify(wantDays) && v;
}, 10_000);
result.days = (byTurns || (await readPanel()))?.days;
check(
  '后端对照：切到回合后柱子数等于 days 长度，每天的段是那天有回合的角色',
  byTurns && byTurns.days.length === daily.days.length,
  { ui: result.days, daemon: wantDays },
);
const unreported = daily.days.reduce(
  (n, d) => n + d.roles.reduce((m, r) => m + r.turns_without_usage, 0),
  0,
);
const unreportedLine = `${unreported} 个回合没有报告用量`;
check(
  `有 turns_without_usage 时图下写 "${unreportedLine}"`,
  unreported > 0 ? byTurns?.text.includes(unreportedLine) : !byTurns?.text.includes('没有报告用量'),
  { unreported, text: byTurns?.text.slice(-200) },
);
const stored = await page.evaluate(
  `localStorage.getItem('pantheon.projectUsage.open.${project_id}')`,
);
check('展开状态按项目记在 localStorage', stored === '1', stored);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
