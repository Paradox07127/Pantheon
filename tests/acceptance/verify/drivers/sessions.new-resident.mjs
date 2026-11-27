import { open } from '../page.mjs';
const { page, query, errors, poll, newProject } = await open(process.argv[2], { ms: 300_000 });
const result = { id: 'sessions.new-resident', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-new-resident-${stamp}`, {
  'README.md': '# new resident\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "new-resident-fixture", "private": true }\n',
});
const before = await query('project.resident', { project_id });
check('对照组：开始前没有常驻', before.session_id === null, before.session_id);

const SINCE = 'involves:@me updated:>={since}';
const INSTRUCTIONS = `Keep main green ${stamp}.\nAsk before pushing.`;
const PART = { role: 'group', name: '常驻', exact: true };
const FORM = { role: 'dialog', name: '新例程', exact: true };
const readPart = () =>
  page.evaluate(`(() => {
    const part = [...document.querySelectorAll('[role=group][aria-label="常驻"]')].find((s) => s.getClientRects().length);
    if (!part) return null;
    const box = part.querySelector('input[type=checkbox]');
    return {
      on: box?.checked ?? null,
      disabled: box?.disabled ?? null,
      text: part.innerText,
      rows: [...part.querySelectorAll('li')].map((li) => li.getAttribute('aria-label')),
    };
  })()`);
const sessionsNow = async () => await query('session.list', { project_id });
const message = (title) => `${title}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`;

// A main agent that becomes the resident, with instructions and the GitHub issues routine.
const FIRST = `verify-resident-new-${stamp}`;
const known = await sessionsNow();
await page.click({ role: 'button', name: '新会话', exact: true });
await page.fill({ role: 'textbox', name: '新会话的第一条消息', exact: true }, message(FIRST));
await page.click({ role: 'button', name: '主 agent', exact: true });
const opened = await poll(async () => {
  const part = await readPart();
  return part && part.disabled === false && part;
}, 15_000);
check('按下主 agent 后出现常驻部分，"设为常驻"默认开', opened?.on === true, opened);
await page.fill({ role: 'textbox', name: '常驻说明', exact: true, within: PART }, INSTRUCTIONS);
await page.click({ role: 'button', name: '添加例程', exact: true, within: PART });
await page.click({ role: 'button', name: '用模板：我的 GitHub issue', exact: true, within: FORM });
await page.click({ role: 'button', name: '保存', exact: true, within: FORM });
const listed = await poll(async () => {
  const part = await readPart();
  return part?.rows.length === 1 && part;
}, 10_000);
check('常驻部分列出模板例程', listed?.rows[0] === '我的 GitHub issue', listed);
check('例程行写"每 30 分钟"', listed?.text.includes('每 30 分钟'), listed?.text);
result.shot = await page.screenshot(result.id);
await page.click({ role: 'button', name: '开始⌘↵', exact: true });

const first = await poll(async () => {
  const session = (await sessionsNow()).find(
    (s) => !known.some((k) => k.id === s.id) && s.title === FIRST,
  );
  const resident = await query('project.resident', { project_id });
  return session && resident.session_id === session.id && { session, resident };
}, 30_000);
check('project.resident 的 session_id 是新会话', first, first?.resident?.session_id);
check(
  'project.resident 的 instructions 等于填的原文',
  first?.resident?.instructions === INSTRUCTIONS,
  first?.resident?.instructions,
);
check(
  '对照组：instructions 不等于去掉首尾空白再加一个字的文本',
  first && first.resident.instructions !== `${INSTRUCTIONS.trim()}x`,
);
const { routines } = await query('project.routines', { project_id });
check('project.routines 有一条', routines.length === 1, routines);
check(
  '它的 precheck.argv 含原样的 {since} 搜索',
  routines[0]?.precheck?.argv.includes(SINCE),
  routines[0]?.precheck?.argv,
);
check(
  '对照组：argv 不含换好的时间',
  !routines[0]?.precheck?.argv.some((a) => /\d{4}-\d\d-\d\dT/.test(a)),
);

// A second main agent with the switch off leaves the resident as it was.
const SECOND = `verify-resident-other-${stamp}`;
const known2 = await sessionsNow();
await page.click({ role: 'button', name: '新会话', exact: true });
await page.fill({ role: 'textbox', name: '新会话的第一条消息', exact: true }, message(SECOND));
await page.click({ role: 'button', name: '主 agent', exact: true });
const second = await poll(async () => {
  const part = await readPart();
  return part && part.disabled === false && part;
}, 15_000);
check('已有常驻时"设为常驻"默认关', second?.on === false, second);
check('关着时不写要替换的会话', second && !second.text.includes('会替换当前常驻'), second?.text);
await page.click({ role: 'button', name: '开始⌘↵', exact: true });
const other = await poll(async () =>
  (await sessionsNow()).find((s) => !known2.some((k) => k.id === s.id) && s.title === SECOND),
);
check('第二个主 agent 起来了', other, other?.id);
const after = await query('project.resident', { project_id });
check(
  'project.resident 不变',
  first && after.session_id === first.session.id && after.instructions === INSTRUCTIONS,
  after,
);
check('对照组：常驻不是第二个会话', other && after.session_id !== other.id);
check(
  'project.routines 仍只有那一条',
  (await query('project.routines', { project_id })).routines.length === 1,
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
