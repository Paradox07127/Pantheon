import { open } from '../page.mjs';
const { page, query, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.agent-new', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-agent-new-${stamp}`);
const NAME = `Goals ${stamp}`;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DIALOG = { role: 'dialog', name: '新建智能体', exact: true };

await page.click({ role: 'button', name: '新建智能体', exact: true });
await page.click({ role: 'radio', name: '目标', exact: true, within: DIALOG });
const form = await poll(() =>
  page.evaluate(`(() => {
    const dlg = document.querySelector('[role=dialog][aria-label="新建智能体"]');
    const name = dlg?.querySelector('#ag-new-name');
    const routine = dlg?.querySelector('[role=group][aria-label="例行任务 1"]');
    if (!name?.value || !routine) return null;
    return {
      template: [...dlg.querySelectorAll('[role=radiogroup][aria-labelledby=ag-new-template] [role=radio]')]
        .find((b) => b.getAttribute('aria-checked') === 'true')?.textContent,
      name: name.value,
      every: routine.querySelector('[role=radio][aria-checked=true]')?.textContent,
      amount: routine.querySelector('input[aria-label="间隔"]')?.value,
      unit: (routine.querySelector('[aria-label="单位"]')?.textContent ?? '').trim(),
      routines: dlg.querySelectorAll('.ag-rtn').length,
    };
  })()`),
);
result.form = form;
check('选 目标 模板后名称预填 Goals', form?.template === '目标' && form.name === 'Goals', form);
check(
  '预填一条每隔 7 天的例行任务',
  form?.routines === 1 && form.every === '每隔' && form.amount === '7' && form.unit === '天',
  form,
);
check('对照组：间隔不是 1', form && form.amount !== '1');

// Replaces the prefilled name with one this run can find.
await page.fill({ role: 'textbox', name: '名称', exact: true, within: DIALOG }, NAME);
const typed = await page.evaluate(
  `document.querySelector('[role=dialog][aria-label="新建智能体"] #ag-new-name')?.value`,
);
check('名称框里是新名字', typed === NAME, typed);
await page.click({ role: 'button', name: '创建', exact: true, within: DIALOG });

const made = await poll(async () =>
  (await query('agent.list', { project_id })).find((a) => a.name === NAME),
);
result.daemon = made && {
  id: made.id,
  template: made.template,
  role: made.role,
  routines: made.routines,
};
check('agent.list 有新建的智能体，模板 goals', made?.template === 'goals', result.daemon);
check(
  'agent.list 里它的例行任务 every_ms 是 7 天',
  made?.routines?.length === 1 && made.routines[0].every_ms === WEEK_MS,
  made?.routines,
);
check('对照组：every_ms 不是 1 天', made && made.routines?.[0]?.every_ms !== WEEK_MS / 7);
const closed = await poll(() =>
  page.evaluate(`!document.querySelector('[role=dialog][aria-label="新建智能体"]')`),
);
check('创建后对话框关闭', closed);
const row = await poll(() =>
  page.evaluate(`(() => {
    const b = document.querySelector('nav.ss-list [role=group][aria-label="常驻智能体"] .ss-rr[data-stop="resident:${made?.id}"]');
    return b ? b.getAttribute('aria-label') : null;
  })()`),
);
check('侧栏智能体区出现它的行', row?.startsWith(`${NAME}，`), row);

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
