import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 150_000,
});
const result = { id: 'settings.playbook-question-defaults', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the page commits from now on, at every DOM change; `state` is a page
// expression. A window on a background display gets no animation frames, so this does not use them.
const watch = (state) =>
  page.evaluate(`(() => {
    window.__verifyWatch?.disconnect();
    const seen = (window.__verifyStates = []);
    const take = () => {
      const now = (() => ${state})();
      if (seen.at(-1) !== now) seen.push(now);
    };
    take();
    const observer = (window.__verifyWatch = new MutationObserver(take));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => observer.disconnect(), 6000);
    return true;
  })()`);
const states = () => page.evaluate('window.__verifyStates ?? []');

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const NAME = `verify-playbook-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# playbook\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "playbook-fixture", "private": true }\n',
  });
  const before = await call('playbook.get', { project_id });
  const policy0 = await query('workflow.policy', { project_id });
  check('前置：新项目的打法是内置(v0)', before.version === 0 && before.source === 'code', {
    version: before.version,
    source: before.source,
  });
  check('前置：提问期限默认关', !policy0.question_defaults, policy0.question_defaults ?? null);

  // 1. Settings > Projects > the project.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '项目', exact: true });
  if ((await names('所有项目')).some((n) => n.role === 'button'))
    await page.click({ role: 'button', name: '所有项目', exact: true });
  const PB = (section) => `默认打法：${section}`;
  const pageState = `(() => {
    const secs = [...document.querySelectorAll('section.ps-sec')].filter((s) => s.getClientRects().length).map((s) => s.getAttribute('aria-label')).filter(Boolean);
    const box = document.querySelector('textarea[aria-label=${JSON.stringify(PB('计划之前'))}]');
    return secs.join('|') + (box ? '#' + (box.value ? 'text' : 'empty') : '');
  })()`;
  await watch(pageState);
  await page.click({ role: 'button', name: NAME, exact: false });
  const QD = '可撤回的提问在 N 小时后采用 lead 推荐的答案';
  const layout = () =>
    page.evaluate(`(() => {
      const all = [...document.querySelectorAll('section.ps-sec, input[type=checkbox]')].filter((e) => e.getClientRects().length);
      const at = (pred) => all.findIndex(pred);
      return {
        toggle: at((e) => e.getAttribute('aria-label') === ${JSON.stringify(QD)}),
        playbook: at((e) => e.getAttribute('aria-label') === '打法'),
        checked: all.find((e) => e.getAttribute('aria-label') === ${JSON.stringify(QD)})?.checked ?? null,
      };
    })()`);
  const order = await poll(async () => {
    const l = await layout();
    return l.toggle >= 0 && l.playbook >= 0 && l;
  });
  result.order = order;
  check(
    '项目页里提问期限开关之后是 "打法" 一节',
    order && order.toggle < order.playbook,
    order || (await layout()),
  );
  check('提问期限开关显示关(与 workflow.policy 一致)', order?.checked === false, order?.checked);

  // 2. The question deadline.
  await page.click({ role: 'checkbox', name: QD, exact: true });
  const qd = await poll(
    async () => (await query('workflow.policy', { project_id })).question_defaults,
  );
  check(
    '打开开关后 workflow.policy 的 question_defaults.after_hours 是 24',
    qd?.after_hours === 24,
    qd,
  );
  const hours = await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('input')].find((i) => i.getAttribute('aria-label') === '小时数' && i.getClientRects().length)?.value ?? null`,
    ),
  );
  check('开关后出现 "小时数"，值为 24', hours === '24', hours);

  // 3. The playbook: edit, save as a new version.
  const box = (label) =>
    page.evaluate(
      `(() => { const t = document.querySelector('textarea[aria-label=${JSON.stringify(label).replace(/"/g, '\\"')}]'); return t ? { value: t.value, readOnly: t.readOnly } : null; })()`,
    );
  const shown0 = await poll(async () => (await box(PB('计划之前')))?.value);
  check(
    '"默认打法：计划之前" 显示 playbook.get 的正文',
    shown0 === before.sections.before_you_plan,
    {
      ui: shown0?.slice(0, 80),
      daemon: before.sections.before_you_plan.slice(0, 80),
    },
  );
  const firstStates = await states();
  result.first_open_states = firstStates;
  const drawn = firstStates.map((s) => s.split('#')[0].split('|').filter(Boolean));
  const gone = (names) =>
    drawn.flatMap((list, i) =>
      i > 0 ? drawn[i - 1].filter((name) => names(name) && !list.includes(name)) : [],
    );
  // The extensions sections further down belong to another page; what they do is kept apart.
  result.page_flash = gone(() => true);
  check(
    '首次打开不闪：打法 画出后没有再消失',
    gone((name) => name === '打法').length === 0,
    firstStates,
  );

  const ADDED = `Check the open questions first ${stamp}.`;
  const edited = `${before.sections.before_you_plan}\n${ADDED}`;
  await page.fill({ role: 'textbox', name: PB('计划之前'), exact: true }, edited);
  await page.click({ role: 'button', name: '存为新版本', exact: true });
  const v1 = await poll(async () => {
    const r = await call('playbook.get', { project_id });
    return r.version === before.version + 1 && r;
  });
  check('存为新版本后 playbook.get 的 version 加一', v1, v1?.version);
  check(
    '存下的 计划之前 是改过的正文',
    v1?.sections.before_you_plan.includes(ADDED),
    v1?.sections.before_you_plan.slice(-80),
  );
  const trigger = await poll(async () =>
    (await names('打法版本，当前 v')).find((n) => n.role === 'button'),
  );
  check(
    '版本按钮写 "打法版本，当前 v1"',
    trigger?.name === `打法版本，当前 v${v1?.version}`,
    trigger,
  );

  const EDIT2 = `Name the lane owner ${stamp}.`;
  await page.fill(
    { role: 'textbox', name: PB('回复'), exact: true },
    `${v1.sections.replies}\n${EDIT2}`,
  );
  await page.click({ role: 'button', name: '存为新版本', exact: true });
  const v2 = await poll(async () => {
    const r = await call('playbook.get', { project_id });
    return r.version === v1.version + 1 && r;
  });
  check('再存一次 version 再加一', v2, v2?.version);

  // 4. An older version is read only.
  await page.click({ role: 'button', name: `打法版本，当前 v${v2?.version}`, exact: true });
  await page.click({ role: 'menuitemradio', name: `v${v1.version}`, exact: true });
  const OLD = (section) => `默认打法，第 ${v1.version} 版：${section}`;
  const old = await poll(async () => {
    const r = await box(OLD('回复'));
    return r?.value ? r : null;
  });
  const oldDaemon = await call('playbook.get', { project_id, version: v1.version });
  check('切到旧版本后框名是 "默认打法，第 N 版：…" 且只读', old?.readOnly === true, old);
  check(
    '旧版本的 回复 等于 playbook.get(version) 的正文',
    old?.value === oldDaemon.sections.replies,
    {
      ui: old?.value.slice(-60),
      daemon: oldDaemon.sections.replies.slice(-60),
    },
  );
  check('对照组：旧版本的 回复 里没有第二次加的那行', old && !old.value.includes(EDIT2));
  check(
    '旧版本时出现 "回到 v{当前}"',
    (await names(`回到 v${v2?.version}`)).length === 1,
    await names('回到'),
  );
  await page.click({ role: 'button', name: `回到 v${v2?.version}`, exact: true });

  // 5. Reset to built-in fills the boxes as an unsaved draft.
  await poll(async () => box(PB('回复')));
  await page.click({ role: 'button', name: '恢复内置', exact: true });
  const reset = await poll(async () => {
    const r = await box(PB('回复'));
    return r?.value === v2.built_in.replies && r;
  });
  check(
    '点 "恢复内置" 后三个框是 built_in 的正文',
    reset && (await box(PB('计划之前')))?.value === v2.built_in.before_you_plan,
    (await box(PB('回复')))?.value.slice(-60),
  );
  const still = await call('playbook.get', { project_id });
  check(
    '恢复内置只是草稿：playbook.get 的 version 没变',
    still.version === v2.version,
    still.version,
  );
  const saveOn = await page.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '存为新版本')?.disabled === false`,
  );
  check(
    '草稿未存时 "存为新版本" 可点，有 "放弃改动"',
    saveOn && (await names('放弃改动')).length === 1,
  );
  result.shot = await page.screenshot(result.id);
  await page.click({ role: 'button', name: '放弃改动', exact: true });
  const back = await poll(async () => (await box(PB('回复')))?.value === v2.sections.replies);
  check('放弃改动 后框回到当前版本', back);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
