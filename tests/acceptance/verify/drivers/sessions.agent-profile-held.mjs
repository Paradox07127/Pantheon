import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'sessions.agent-profile-held', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

/**
 * Fixture turns report no input tokens, so a turn's spend (and, for last week, when it ended) is
 * written into the boot daemon's own store. The store reads rows again when the database changes.
 */
const spend = (turnId, tokens, endedAt) => {
  const db = new DatabaseSync(path.join(run.workspace, 'state', 'control.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  db.prepare(
    `UPDATE session_turns SET data=json_set(data,'$.usage',json(json_patch(coalesce(json_extract(data,'$.usage'),'{}'),json_object('input_tokens',?,'tokens_unreported',json('null'))))) WHERE id=?`,
  ).run(tokens, turnId);
  if (endedAt !== undefined)
    db.prepare(
      `UPDATE events SET created_at=? WHERE aggregate_id=? AND kind IN ('turn.completed','turn.failed','turn.cancelled')`,
    ).run(endedAt, turnId);
  db.close();
};

try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-agent-held-${stamp}`, {
    'README.md': '# agent held\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "agent-held-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const triageOf = async () =>
    (await query('agent.list', { project_id })).find((a) => a.template === 'triage');
  let triage = await triageOf();
  // The wake note quotes the prompt; the closing quote lands on the line after the script.
  const prompt = `Sweep ${stamp}\nfixture-script\n${JSON.stringify([{ say: 'Sweep ran.' }])}\nend`;
  await call('agent.update', {
    agent_id: triage.id,
    revision: triage.revision,
    routines: [{ id: 'sweep', prompt, every_minutes: 60, enabled: true }],
  });
  const wakesOf = () => query('agent.wakes', { agent_id: triage.id, limit: '10' });
  const settled = (count) =>
    poll(async () => {
      const list = await wakesOf();
      return (
        list.length >= count && list.every((w) => !['queued', 'running'].includes(w.state)) && list
      );
    }, 30_000);
  await call('agent.routine.run', { agent_id: triage.id, routine_id: 'sweep' });
  await settled(1);
  await call('agent.routine.run', { agent_id: triage.id, routine_id: 'sweep' });
  const wakes = (await settled(2)) || [];
  const turns = wakes.map((w) => w.turn_id).filter(Boolean);
  check(
    '前置：两次唤醒都结束，各有一个回合',
    turns.length >= 2,
    wakes.map((w) => [w.state, w.turn_id]),
  );

  // Rolling seven days high, the week since Monday 00:00 empty: the older turn ended last Saturday.
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const lastSaturday = monday.getTime() - 36 * 3600_000;
  const rollingSince = Date.now() - 7 * 24 * 3600_000;
  check('前置：上周六在滚动 7 天之内', lastSaturday > rollingSince, {
    lastSaturday: new Date(lastSaturday).toString(),
  });
  spend(turns[1], 900, lastSaturday);
  spend(turns[0], 0);
  triage = await triageOf();
  await call('agent.update', {
    agent_id: triage.id,
    revision: triage.revision,
    contract: { weekly_input_tokens: 500 },
  });

  // Sidebar agents zone > Triage > context menu > Profile.
  const NAME = '问题处理';
  const LABEL = `${NAME}的资料`;
  const openProfile = async () => {
    await page.press('Escape');
    const box = await poll(() =>
      page.evaluate(`(() => {
        const zone = [...document.querySelectorAll('[role=group]')].find((g) => g.getAttribute('aria-label') === '本项目');
        const row = zone && [...zone.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(`${NAME}，`)}) && el.getClientRects().length);
        if (!row) return null;
        row.scrollIntoView({ block: 'center' });
        const b = row.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`),
    );
    const mouse = { x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
    await page.click({ role: 'menuitem', name: '资料', exact: true });
  };
  const contract = () =>
    page.evaluate(`(() => {
      const a = [...document.querySelectorAll('aside')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(LABEL)} && el.getClientRects().length);
      if (!a) return null;
      const sec = [...a.querySelectorAll('section')].find((s) => document.getElementById(s.getAttribute('aria-labelledby'))?.textContent === '约定');
      if (!sec) return null;
      const label = [...sec.querySelectorAll('span')].find((s) => s.textContent === '本周已花');
      const value = label?.nextElementSibling;
      if (!value || value.querySelector('[aria-busy=true]')) return null;
      return { spent: value.innerText.replace(/\\s+/g, ' ').trim(), held: sec.parentElement.innerText.includes('唤醒已暂停') || a.innerText.includes('唤醒已暂停') };
    })()`);
  await openProfile();
  const a = await poll(contract);
  const ledgerA = (await query('agent.ledger', { agent_id: triage.id, weeks: '1' }))[0];
  result.a = { ui: a, ledger: ledgerA };
  check(
    '前置：滚动 7 天用量 900 > 预算 500，本周(周一起)为 0',
    ledgerA?.input_tokens === 900 && ledgerA?.contract_spent === 0,
    ledgerA,
  );
  check(
    '"本周已花" 读数等于 agent.ledger 最新一周的 contract_spent(0，共 500)',
    a?.spent?.startsWith(`${ledgerA?.contract_spent} `) ||
      a?.spent === String(ledgerA?.contract_spent),
    a,
  );
  check('对照组："本周已花" 不是滚动 7 天的 900', !a?.spent?.startsWith('900'), a?.spent);
  check('滚动 7 天高、本周为 0 时不显示 "唤醒已暂停"', a && !a.held, a);

  // This week's spend goes over the cap.
  spend(turns[0], 600);
  // The written spend carries no event; the next wake asked for is the event the open profile reads again on.
  await call('agent.routine.run', { agent_id: triage.id, routine_id: 'sweep' });
  result.third_wake = (await settled(3))?.[0];
  const b = await poll(async () => {
    const c = await contract();
    return c?.spent?.startsWith('600') && c;
  }, 8000);
  const ledgerB = (await query('agent.ledger', { agent_id: triage.id, weeks: '1' }))[0];
  result.b = { ui: b || (await contract()), ledger: ledgerB };
  check('前置：本周 contract_spent 600 ≥ 预算 500', ledgerB?.contract_spent === 600, ledgerB);
  check('"本周已花" 读数跟着变成 contract_spent 600', b, result.b.ui);
  check('本周用量超过约定预算时显示 "唤醒已暂停"', b?.held === true, result.b.ui);
  result.names = await names('唤醒已暂停');
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
