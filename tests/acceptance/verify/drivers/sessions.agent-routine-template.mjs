import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';
import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-routine-template', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id } = await newProject(`verify-routine-${stamp}`);
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await query('board', { project_id })).projects.find((p) => p.id === project_id).revision,
  );
  const NAME = `Routine ${stamp}`;
  const agentId = (
    await call('agent.create', {
      project_id,
      template: 'custom',
      name: NAME,
      role: 'Checker',
      instructions: `You check things for ${NAME}.`,
    })
  ).id;
  const agentOf = async () =>
    (await query('agent.list', { project_id })).find((a) => a.id === agentId);
  const BUG = ROUTINE_TEMPLATES.find((r) => r.id === 'bug-hunt');
  const SCAN = ROUTINE_TEMPLATES.find((r) => r.id === 'security-scan');
  check(
    '前置：新 agent 没有例行任务',
    !(await agentOf())?.routines?.length,
    (await agentOf())?.routines,
  );

  // 1. The agent's profile, from its row's context menu.
  const ZONE = { role: 'group', name: '本项目', exact: true };
  const rowSel = `nav.ss-list [role=group][aria-label="本项目"] .ss-rr[data-stop="resident:${agentId}"]`;
  await poll(() => page.evaluate(`!!document.querySelector(${JSON.stringify(rowSel)})`));
  await page.click({ role: 'button', name: `${NAME}，`, exact: false, within: ZONE });
  await poll(() =>
    page.evaluate(
      `document.querySelector(${JSON.stringify(rowSel)})?.getAttribute('aria-current') === 'true'`,
    ),
  );
  const { x, y } = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(rowSel)});
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  const mouse = { x, y, button: 'right', buttons: 2, clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse, buttons: 0 });
  await page.click({ role: 'menuitem', name: '资料', exact: true });
  const PANEL = { name: `${NAME}的资料`, exact: true };
  const panelSel = `aside.ag-insp[aria-label=${JSON.stringify(`${NAME}的资料`)}]`;
  const opened = await poll(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(panelSel)})`),
  );
  check('打开了 agent 的资料栏', opened);

  // The routine rows as the form shows them.
  const rows = () =>
    page.evaluate(`(() => {
      const aside = document.querySelector(${JSON.stringify(panelSel)});
      if (!aside) return null;
      return [...aside.querySelectorAll('[role="group"].ag-rtn')].map((g) => {
        const check = [...g.querySelectorAll('[role="group"]')].find((c) => {
          const id = c.getAttribute('aria-labelledby');
          return id && document.getElementById(id)?.textContent.trim() === '仅当这条命令成功时运行';
        });
        return {
          label: g.getAttribute('aria-label'),
          prompt: g.querySelector('input[aria-label="例行任务提示词"]')?.value ?? null,
          schedule: g.querySelector('[role="radiogroup"] [role="radio"][aria-checked="true"]')?.textContent.trim() ?? null,
          at: g.querySelector('input[aria-label="时间"]')?.value ?? null,
          check: check ? check.querySelector('.ag-pk')?.textContent.trim() ?? check.textContent.trim() : null,
        };
      });
    })()`);

  // 2. The add menu lists a blank routine and the four templates.
  await page.click({ role: 'button', name: '添加例行任务', exact: true, within: PANEL });
  const items = await poll(() =>
    page
      .evaluate(
        `[...document.querySelectorAll('[role=menu] [role=menuitem]')].filter((m) => m.getClientRects().length).map((m) => m.textContent.trim())`,
      )
      // The row's context menu may still be leaving.
      .then((list) => (list[0] === '空白例行任务' ? list : null)),
  );
  check(
    '菜单有 空白例行任务、找 bug、安全扫描、测试覆盖、每周自查',
    same(items, ['空白例行任务', '找 bug', '安全扫描', '测试覆盖', '每周自查']),
    items,
  );
  await page.click({ role: 'menuitem', name: '找 bug', exact: true });

  // 3. The new row holds the template's prompt, daily at 09:00, and its check.
  const argvText = BUG.precheck.argv.join(' ');
  const bugRow = await poll(async () => {
    const r = await rows();
    return r?.length === 1 && r[0].prompt === BUG.prompt && r[0];
  });
  result.bug_row = bugRow || (await rows());
  check('新行的提示词是模板的指令', bugRow, result.bug_row);
  check('新行是 "每天"，时间 09:00', bugRow?.schedule === '每天' && bugRow.at === BUG.at, bugRow);
  check('组 "仅当这条命令成功时运行" 里是模板的 sh -c 命令', bugRow?.check === argvText, {
    shown: bugRow?.check,
    argv: argvText,
  });
  check('对照组：同一读法对另一模板的指令判 false', bugRow?.prompt !== SCAN.prompt);

  // 4. Save: the agent's last routine has the template's precheck argv.
  await page.click({ role: 'button', name: '保存', exact: true, within: PANEL });
  const saved = await poll(async () => {
    const a = await agentOf();
    return a?.routines?.length === 1 && a.routines.at(-1);
  });
  result.saved = saved;
  check(
    '保存后 agent.list 最后一条例行任务的 precheck.argv 等于模板的 argv',
    saved && same(saved.precheck?.argv, BUG.precheck.argv),
    saved,
  );
  check('保存后它的指令和时间对上模板', saved?.prompt === BUG.prompt && saved.at === BUG.at, saved);

  // 5. Remove the check and save: the routine has no precheck.
  await page.click({
    role: 'button',
    name: '去掉检查',
    exact: true,
    within: { role: 'group', name: '例行任务 1', exact: true },
  });
  const noCheckRow = await poll(async () => {
    const r = await rows();
    return r?.[0] && r[0].check === null && r;
  }, 5000);
  check('去掉检查后这一行没有 "仅当这条命令成功时运行"', noCheckRow, await rows());
  await page.click({ role: 'button', name: '保存', exact: true, within: PANEL });
  const unchecked = await poll(async () => {
    const a = await agentOf();
    const r = a?.routines?.[0];
    return r && !('precheck' in r) && r;
  });
  result.unchecked = unchecked || (await agentOf())?.routines;
  check('保存后这一条没有 precheck', unchecked, result.unchecked);

  // 6. Add a security scan, rewrite only its prompt, save: the first routine stays as it was.
  const first = unchecked || (await agentOf())?.routines?.[0];
  await page.click({ role: 'button', name: '添加例行任务', exact: true, within: PANEL });
  await page.click({ role: 'menuitem', name: '安全扫描', exact: true });
  const twoRows = await poll(async () => {
    const r = await rows();
    return r?.length === 2 && r;
  });
  check(
    '安全扫描一行没有前置检查',
    twoRows && twoRows[1].prompt === SCAN.prompt && twoRows[1].check === null,
    twoRows,
  );
  const SCAN_PROMPT = `Scan the lockfile for ${stamp}.`;
  await page.fill(
    {
      role: 'textbox',
      name: '例行任务提示词',
      exact: true,
      within: { role: 'group', name: '例行任务 2', exact: true },
    },
    SCAN_PROMPT,
  );
  await page.click({ role: 'button', name: '保存', exact: true, within: PANEL });
  const both = await poll(async () => {
    const a = await agentOf();
    return a?.routines?.length === 2 && a.routines;
  });
  result.both = both;
  check(
    '保存后第二条是改过指令的安全扫描',
    both && both[1].prompt === SCAN_PROMPT && !('precheck' in both[1]),
    both?.[1],
  );
  check('对照：第一条的字段不变', both && same(both[0], first), {
    before: first,
    after: both?.[0],
  });
  result.shot = await page.screenshot('agent-routine-template');
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
