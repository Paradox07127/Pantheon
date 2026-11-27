import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, newProject } = await open(runDir, { ms: 300_000 });
const result = { id: 'trace.setting-compare', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const BLOCK = '设置改动前后';
const files = (name) => ({
  'README.md': `# ${name}\n`,
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': `{ "name": "${name}", "private": true }\n`,
});

// A worktree session that commits one file and lands it.
const land = async (project_id, name) => {
  const session = await call('session.create', {
    project_id,
    runtime: 'fixture',
    workspace: 'worktree',
    input: `${name}\nfixture-script\n${JSON.stringify([
      { write: { path: `src/${name}.ts`, text: `export const at = ${Date.now()};\n` } },
      { commit: name },
      { say: 'done' },
    ])}`,
  });
  const ready = await poll(async () => {
    const s = (await query('session.list', { project_id })).find((x) => x.id === session.id);
    return s?.state === 'ready' && s.ahead > 0 && s;
  }, 60_000);
  const revision = (await query('board', { project_id })).sessions.find(
    (s) => s.id === session.id,
  )?.revision;
  await call('session.merge', { session_id: session.id }, revision);
  const landed = await poll(async () => {
    const read = await query('project.landings.read', { project_id });
    return read.landings.find((r) => r.session_id === session.id && r.state === 'landed');
  }, 60_000);
  return { ready, landed };
};

// The recap of the project now shown: each block's label, and the comparison's rows and sides.
const panel = () =>
  page.evaluate(`(() => {
    const aside = [...document.querySelectorAll('aside')].find((el) => el.getAttribute('aria-label') === '复盘' && el.getClientRects().length);
    if (!aside) return null;
    const blocks = [...aside.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'));
    const block = [...aside.querySelectorAll('section')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(BLOCK)});
    const sides = block ? [...block.querySelectorAll('[role=group]')].map((g) => {
      const nums = {};
      for (const n of g.querySelectorAll('.trc-num')) nums[n.querySelector('span').textContent.trim()] = n.querySelector('b').textContent.trim();
      return { heading: g.getAttribute('aria-label'), nums };
    }) : [];
    const rows = block ? [...block.querySelectorAll('[role=radio]')].map((r) => ({ text: r.textContent.trim(), checked: r.getAttribute('aria-checked') === 'true' })) : [];
    return { busy: aside.getAttribute('aria-busy') === 'true', blocks, rows, sides, failed: !!block?.querySelector('[role=alert]') };
  })()`);

const openRecap = async () => {
  await page.click({ role: 'button', name: '搜索', exact: true });
  await page.waitFor(`!!document.querySelector('.cmdk input')`, 'the command palette to open');
  const box = await page.evaluate(
    `document.querySelector('.cmdk input').getAttribute('aria-label')`,
  );
  await page.fill({ role: 'combobox', name: box, exact: true }, '最近动态');
  await page.click({ role: 'option', name: '最近动态', exact: true });
  await page.click({ role: 'tab', name: '时间轴', exact: true });
  const shown = await page.evaluate(
    `[...document.querySelectorAll('aside')].some((el) => el.getAttribute('aria-label') === '复盘' && el.getClientRects().length)`,
  );
  if (!shown) await page.click({ role: 'button', name: '复盘', exact: true });
};

const NAME = `verify-setting-compare-${stamp}`;
const { project_id } = await newProject(NAME, files(NAME));

// The main agent proposes a budget; one landing before the approval, one after.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${NAME}-main\nfixture-script\n${JSON.stringify([
    {
      tool: {
        name: 'propose_setting',
        arguments: {
          command: 'workflow.policy.set',
          input: { project_budget: { input_tokens: 5_000_000 } },
          reason: `Cap the project's tokens ${stamp}`,
        },
      },
    },
    { say: 'proposed' },
  ])}`,
});
const waiting = await poll(async () =>
  (await query('needs_you.list', { project_id })).items.find(
    (i) => i.kind === 'setting.proposed' && i.session_id === conductor.id,
  ),
);
check('前置：主 agent 的 propose_setting 列在等你里', waiting, waiting?.source?.id);
const first = await land(project_id, `before-${stamp}`);
check('前置：批准前一个会话合并落地', first.landed, first.landed?.ended_at);
if (waiting)
  await call(
    'setting.proposal.respond',
    { proposal_id: waiting.source.id, decision: 'approve' },
    waiting.source.revision,
  );
const approved = await poll(
  async () => (await query('project.setting_proposals', { project_id })).proposals,
);
check(
  '前置：project.setting_proposals 列出这条已批准的提议',
  approved.length === 1 && approved[0].id === waiting?.source?.id,
  approved.map((p) => ({ id: p.id, state: p.state, decided_at: p.decided_at })),
);
const second = await land(project_id, `after-${stamp}`);
check('前置：批准后一个会话合并落地', second.landed, second.landed?.ended_at);

const daemon = await query('project.landings.compare', {
  project_id,
  proposal_id: waiting?.source?.id,
  count: '10',
});
result.daemon = daemon;
await openRecap();
const heading = (side, count) => `${side} ${count} 次`;
const shown = await poll(async () => {
  const p = await panel();
  return (
    p &&
    !p.busy &&
    p.sides.length === 2 &&
    p.sides[0].heading === heading('之前', daemon.before.count) &&
    p.sides[1].heading === heading('之后', daemon.after.count) &&
    p
  );
});
result.shown = shown || (await panel());
check(
  '"设置改动前后" 一块排在 "落地" 之后',
  result.shown?.blocks?.[0] === '落地' && result.shown.blocks[1] === BLOCK,
  result.shown?.blocks,
);
check(
  '提议一行一条，默认选中，写着改了什么和提议的理由',
  result.shown?.rows?.length === 1 &&
    result.shown.rows[0].checked &&
    result.shown.rows[0].text.startsWith('预算') &&
    result.shown.rows[0].text.includes(`Cap the project's tokens ${stamp}`),
  result.shown?.rows,
);
check(
  '之前 / 之后两列的落地数等于 project.landings.compare',
  shown && daemon.before.count === 1 && daemon.after.count === 1,
  { ui: result.shown?.sides?.map((s) => s.heading), daemon },
);
check(
  '两列的平均审查轮数等于 project.landings.compare',
  shown &&
    shown.sides.every((s, i) => {
      const rounds = [daemon.before, daemon.after][i].mean_review_rounds;
      return (
        s.nums['平均审查轮数'] === (rounds === null ? '无' : String(Math.round(rounds * 10) / 10))
      );
    }),
  result.shown?.sides,
);
check(
  '对照组：之后多一次的标题判 false',
  !(shown && shown.sides[1].heading === heading('之后', daemon.after.count + 1)),
);
await page.evaluate(`(() => {
  const block = [...document.querySelectorAll('aside[aria-label="复盘"] section')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(BLOCK)});
  block?.scrollIntoView({ block: 'start' });
})()`);
result.shot = await page.screenshot('trace-setting-compare');
copyFileSync(
  path.join(runDir, result.shot.file),
  path.join(runDir, 'screens', 'trace-setting-compare.png'),
);

// Control: a project with no proposal leaves the block out.
const PLAIN = `verify-setting-none-${stamp}`;
const plain = await newProject(PLAIN, files(PLAIN));
await openRecap();
const none = await poll(async () => {
  const p = await panel();
  return p && !p.busy && p.blocks.length === 4 && p;
});
const plainRead = await query('project.setting_proposals', { project_id: plain.project_id });
check(
  '对照组：没有提议的项目 project.setting_proposals 为空，复盘里不出这一块',
  plainRead.proposals.length === 0 && none && !none.blocks.includes(BLOCK),
  { daemon: plainRead.proposals.length, ui: none?.blocks ?? (await panel())?.blocks },
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
