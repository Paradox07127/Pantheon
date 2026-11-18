import { open } from '../page.mjs';
import { projectShown } from '../../lib/desktop-app.mjs';
const runDir = process.argv[2];
const { run, page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.goals-map', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const NAME = `verify-goals-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# goals\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "goals-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const view = () => query('board.view', { project_id, days: '1' });
  const goalsOf = async () => [...(await view()).goals].sort((a, b) => a.order - b.order || 0);
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'ask' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  // No plan review, so a started task opens its session at once.
  await call('workflow.definition.set', {
    project_id,
    definition: {
      slots: { before_dispatch: [], before_merge: [], after_merge: [] },
      plan_review: { tiers: [] },
      review: { max_rounds: 1 },
    },
    base_version: 0,
  });
  // The lead would allow the task session's prompt itself; this one has to wait on the user.
  await call('workflow.policy.set', { project_id, charter: { approve_worker_prompts: 'off' } });
  await page.click({ role: 'button', name: '项目看板', exact: true });

  /** The checked tab of the board's view switch; '' while none is, null without the switch. */
  const tab = () =>
    page.evaluate(`(() => {
    const g = document.querySelector('[role="radiogroup"][aria-label="看板视图"]');
    if (!g) return null;
    return g.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label') ?? '';
  })()`);
  const tabIs = (want, ms = 10_000) => poll(async () => ((await tab()) === want ? want : null), ms);
  /** Shows project `name` through the sidebar's project switcher. */
  const switchTo = async (name) => {
    await page.press('Escape');
    await page.click({ role: 'button', name: '切换项目', exact: true });
    await page.click({ role: 'menuitemradio', name, exact: false });
    await page.waitFor(projectShown(name), `the sidebar to show project ${name}`);
  };
  const away = async () => {
    await switchTo(run.project_name);
    await switchTo(NAME);
  };

  // 1. A project without goals opens on the now view.
  const first = await poll(async () => ((await tab()) ? await tab() : null));
  check('没有目标的项目进入后 "看板视图" 选中的是 "现在"', first === '现在', first);
  check('对照组：同一读法对 "目标" 判 false', first !== '目标', first);

  // 2. Two goals, the first with two milestones of the assistant's plan.
  const G1 = `Ship the importer ${stamp}`;
  const G2 = `Keep the docs current ${stamp}`;
  const g1 = (await call('goal.set', { project_id, text: G1 })).id;
  const g2 = (await call('goal.set', { project_id, text: G2 })).id;
  const M1 = `Importer reads files ${stamp}`;
  const M2 = `Importer writes rows ${stamp}`;
  const task = (id, title, depends_on = []) => ({
    id,
    title,
    // Task one's session asks for a permission: a decision on a task of the first goal's milestone.
    goal:
      id === 'task-one'
        ? `Do ${title}.\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command: `echo goals-${stamp}` } } }])}`
        : `Do ${title}.`,
    lane: 'lane-a',
    milestone: id === 'task-one' ? 'ms-one' : 'ms-two',
    estimate: 3,
    depends_on,
    source: ['The user asked for it.'],
    scope: ['src/index.ts'],
    acceptance: ['pnpm test'],
    kind: { domain: 'backend-logic', tier: 't1' },
    priority: 'normal',
  });
  const plan = {
    base_version: 0,
    headline: `Goals ${stamp}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks: [task('task-one', 'Task one'), task('task-two', 'Task two', ['task-one'])],
    milestones: [
      { id: 'ms-one', title: M1, criteria: ['It reads.'], tasks: ['task-one'], goal: g1 },
      { id: 'ms-two', title: M2, criteria: ['It writes.'], tasks: ['task-two'], goal: g1 },
    ],
    risks: [],
    assumptions: [],
  };
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const idle = () =>
    poll(async () => {
      const s = (await query('session.list', { project_id })).find((x) => x.id === assistant);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const send = async (steps) => {
    await idle();
    await call(
      'session.send',
      { session_id: assistant, input: `fixture-script\n${JSON.stringify(steps)}` },
      (await board()).sessions.find((s) => s.id === assistant).revision,
    );
    return idle();
  };
  await send([
    { tool: { name: 'update_board', arguments: plan } },
    { tool: { name: 'start_task', arguments: { task_ids: ['task-one'] } } },
  ]);
  const seeded = await poll(async () => {
    const goals = await goalsOf();
    return goals.length === 2 && goals[0].milestones.total === 2 && goals[0].needs > 0 && goals;
  }, 30_000);
  result.seeded = seeded || (await goalsOf());
  check(
    '前置：goals[] 两项，第一个目标挂两个里程碑并有等你的事',
    seeded,
    result.seeded.map((g) => [g.text, g.milestones, g.needs]),
  );

  // Back on the project with no stored choice: the goals view.
  await away();
  const landed = await tabIs('目标');
  check('有目标、没存过选择：换回项目后选中 "目标"', landed, await tab());
  // A stored choice holds.
  await page.click({ role: 'radio', name: '现在', exact: true });
  await tabIs('现在');
  await away();
  const kept = await tabIs('现在', 5000);
  check('点过 "现在" 后换走再回来，仍是 "现在"', kept, await tab());
  const stored = await page.evaluate(
    `localStorage.getItem(${JSON.stringify(`pantheon.board-page.${project_id}`)})`,
  );
  check('存下的选择是 now', stored === 'now', stored);
  await page.click({ role: 'radio', name: '目标', exact: true });
  await tabIs('目标');

  // 3. The goals list against goals[].
  const list = () =>
    page.evaluate(`(() => {
    const l = document.querySelector('[role="list"][aria-label="目标"]');
    if (!l) return null;
    return [...l.querySelectorAll(':scope > [role="listitem"]')].map((s) => {
      const ids = s.getAttribute('aria-labelledby');
      return {
        name: ids ? document.getElementById(ids)?.textContent.trim() : s.getAttribute('aria-label'),
        count: s.querySelector('.gm-gp .gm-n')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
        none: !!s.querySelector('.gm-none'),
        need: s.querySelector('.gm-need')?.textContent.trim() ?? null,
        needLabel: s.querySelector('.gm-need')?.getAttribute('aria-label') ?? null,
        milestones: [...s.querySelectorAll('.gm-ms .gm-ms-t')].map((m) => m.textContent.trim()),
      };
    });
  })()`);
  const listMatches = (rows, goals) =>
    rows?.length === goals.length && rows.every((r, i) => r.name === goals[i].text);
  const goals = await goalsOf();
  const rows = await poll(async () => {
    const r = await list();
    return listMatches(r, goals) && r;
  });
  result.rows = rows || (await list());
  check('列表 "目标" 每项名称是 goals[i].text，次序同 order', listMatches(result.rows, goals), {
    rows: result.rows,
    goals: goals.map((g) => g.text),
  });
  check('对照组：同一读法对打乱的次序判 false', !listMatches(result.rows, [...goals].reverse()));
  const countOk = (r, g) =>
    g.milestones.total ? r.count === `${g.milestones.done} / ${g.milestones.total}` : r.none;
  check(
    '进度数字 done / total 对上 goals[i].milestones',
    result.rows?.every?.((r, i) => goals[i] && countOk(r, goals[i])),
    result.rows?.map?.((r, i) => [r.count, goals[i]?.milestones]),
  );
  const withNeeds = goals.findIndex((g) => g.needs > 0);
  const noNeeds = goals.findIndex((g) => g.needs === 0);
  check(
    'needs > 0 的目标有 "待你决定 N 项"',
    withNeeds >= 0 && result.rows?.[withNeeds]?.need === `待你决定 ${goals[withNeeds].needs} 项`,
    { row: result.rows?.[withNeeds], needs: goals[withNeeds]?.needs },
  );
  check(
    '对照组：needs 为 0 的目标没有 "待你决定"',
    noNeeds >= 0 && result.rows?.[noNeeds] && result.rows[noNeeds].need === null,
    result.rows?.[noNeeds],
  );
  check(
    '第一个目标下列出它的两个里程碑',
    JSON.stringify(result.rows?.[0]?.milestones) === JSON.stringify([M1, M2]),
    result.rows?.[0]?.milestones,
  );
  result.shot = await page.screenshot('board-goals-map');

  // 4. The needs chip opens the now view with the focus on the first row's primary button.
  const focus = () =>
    page.evaluate(`(() => {
    const a = document.activeElement;
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length);
    const first = s?.querySelector('li.bf-need');
    const primary = first && [...first.querySelectorAll('.rq-hd .rq-acts button')].find((b) => !b.classList.contains('ib'));
    return {
      active: a ? (a.getAttribute('aria-label') ?? a.textContent.trim()).slice(0, 80) : null,
      inFirst: !!first && first.contains(a),
      isPrimary: !!primary && primary === a,
      primary: primary ? (primary.getAttribute('aria-label') ?? primary.textContent.trim()) : null,
    };
  })()`);
  const needLabel = withNeeds >= 0 && `这个目标有 ${goals[withNeeds].needs} 项等你决定`;
  if (needLabel && (await names(needLabel)).length) {
    await page.click({ role: 'button', name: needLabel, exact: true });
    const nowTab = await tabIs('现在');
    check('点 "这个目标有 N 项等你决定" 切到 "现在"', nowTab, await tab());
    const focused = await poll(async () => {
      const f = await focus();
      return f.isPrimary && f;
    }, 5000);
    result.focus = focused || (await focus());
    check('焦点在 "需要你" 第一行的主按钮上', result.focus.isPrimary, result.focus);
  } else check('有按钮 "这个目标有 N 项等你决定"', false, await names('等你决定'));

  // 5. A milestone row opens the now view on that milestone.
  const card = () =>
    page.evaluate(
      `[...document.querySelectorAll('section.bms h2.bms-h')].filter((h) => h.getClientRects().length).map((h) => h.textContent.trim())`,
    );
  for (const title of [M2, M1]) {
    await page.click({ role: 'radio', name: '目标', exact: true });
    await tabIs('目标');
    await page.click({ role: 'button', name: title, exact: false });
    await tabIs('现在');
    const shown = await poll(async () => {
      const c = await card();
      return c.includes(title) && c;
    }, 5000);
    check(`点里程碑 "${title}" 后 "现在" 页的里程碑卡显示它`, shown, await card());
  }
  check('对照组：里程碑卡不显示另一个里程碑', !(await card()).includes(M2), await card());
  await page.click({ role: 'radio', name: '目标', exact: true });
  await tabIs('目标');

  // 11. Switching tabs reads no new board view. Reads go through the desktop bridge, not fetch;
  // the bridge is counted when it can be wrapped, and a project switch shows the count sees reads.
  const counting = await page.evaluate(`(() => {
    if (window.__verifyReads) return window.pantheon?.__counted === true;
    window.__verifyReads = [];
    const bridge = window.pantheon;
    if (!bridge) return false;
    const counted = { ...bridge, __counted: true, query: (method, params) => (window.__verifyReads.push(method), bridge.query(method, params)) };
    try { Object.defineProperty(window, 'pantheon', { value: counted, configurable: true, writable: true }); } catch { return false; }
    return window.pantheon === counted;
  })()`);
  if (counting) {
    const reads = () =>
      page.evaluate(`window.__verifyReads.filter((m) => m === 'board.view').length`);
    const readsBefore = await reads();
    for (const name of ['现在', '目标', '现在', '目标']) {
      await page.click({ role: 'radio', name, exact: true });
      await tabIs(name);
    }
    const readsAfter = await reads();
    await away();
    await tabIs('目标');
    const readsAway = await poll(async () => {
      const n = await reads();
      return n > readsAfter && n;
    }, 5000);
    result.board_reads = {
      before: readsBefore,
      after: readsAfter,
      after_project_switch: readsAway,
    };
    check(
      '目标 ↔ 现在 切换四次不重新请求 board.view',
      readsAfter === readsBefore,
      result.board_reads,
    );
    check(
      '对照组：换项目再回来，同一计数看得到 board.view 请求',
      readsAway > readsAfter,
      result.board_reads,
    );
  } else
    result.board_reads = {
      measured: false,
      reason:
        'board.view goes through window.pantheon.query (contextBridge); the page cannot wrap it and fetch/resource entries do not see it',
    };

  // After a goal command: the list as shown, and if it lags, the list after a project switch.
  const order = async () => (await goalsOf()).map((g) => g.id);
  const shownAfter = async (what, ok) => {
    const live = await poll(async () => {
      const r = await list();
      return ok(r) && r;
    });
    check(
      what,
      live,
      (await list())?.map((r) => r.name),
    );
    if (live) return;
    await away();
    await tabIs('目标');
    const reread = await poll(async () => {
      const r = await list();
      return ok(r) && r;
    });
    check(
      `${what}(换走再回来后)`,
      reread,
      (await list())?.map((r) => r.name),
    );
  };

  // 6. Add a goal from the bar.
  const G3 = `Cut the release ${stamp}`;
  await page.click({ role: 'button', name: '添加目标', exact: true });
  await page.fill({ role: 'textbox', name: '新目标', exact: true }, G3);
  await page.press('Enter');
  const added = await poll(async () => {
    const g = await goalsOf();
    return g.length === 3 && g;
  });
  result.added = (added || (await goalsOf())).map((g) => g.text);
  check('添加后 goals[] 多一项，最后一项是新目标', added && added[2].text === G3, result.added);
  await shownAfter('新目标出现在列表最后', (r) => r?.length === 3 && r[2].name === G3);

  // 7. Rewrite the second goal by clicking its text.
  const before2 = (await goalsOf()).find((g) => g.id === g2);
  const G2B = `Keep the docs and examples current ${stamp}`;
  await page.click({ role: 'button', name: G2, exact: true });
  await page.fill({ role: 'textbox', name: '目标内容', exact: true }, G2B);
  await page.press('Enter');
  const rewritten = await poll(async () => {
    const g = (await goalsOf()).find((x) => x.id === g2);
    return g?.text === G2B && g;
  });
  check(
    '改写后 goals[i].text 变了、revision 加一',
    rewritten && rewritten.revision === before2.revision + 1,
    {
      before: before2 && [before2.text, before2.revision],
      after: rewritten && [rewritten.text, rewritten.revision],
    },
  );
  await shownAfter('列表里显示改写后的文字', (r) => r?.some((x) => x.name === G2B));

  // 8. Move the second goal up.
  const orderBefore = await order();
  await page.click({ role: 'button', name: `目标操作：${G2B}`, exact: true });
  await page.click({ role: 'menuitem', name: '上移', exact: true });
  const moved = await poll(async () => {
    const o = await order();
    return o[0] === g2 && o[1] === g1 && o;
  });
  check('上移后 goals[].order 先后变了', moved, { before: orderBefore, after: await order() });
  await shownAfter('列表顺序跟着变', (r) => r?.[0]?.name === G2B && r[1]?.name === G1);

  // 9. Archive the middle goal, then undo from the toast.
  const ARCH = (await goalsOf())[1];
  const atBefore = (await order()).indexOf(ARCH.id);
  await page.click({ role: 'button', name: `目标操作：${ARCH.text}`, exact: true });
  await page.click({ role: 'menuitem', name: '归档', exact: true });
  const archived = await poll(async () => {
    const g = await goalsOf();
    return g.length === 2 && !g.some((x) => x.id === ARCH.id) && g;
  });
  check(
    '归档后 goals[] 少一项',
    archived,
    (await goalsOf()).map((g) => g.text),
  );
  const toastShown = await poll(
    async () => (await names('撤销')).filter((c) => c.name === '撤销'),
    5000,
  );
  check('通知条有 "撤销"', toastShown.length > 0, await names('已归档'));
  // The toast leaves after five seconds, so the list gets a short wait before Undo.
  const gone = await poll(async () => {
    const r = await list();
    return r && r.length === 2 && !r.some((x) => x.name === ARCH.text) && r;
  }, 1500);
  check(
    '归档后目标从列表消失',
    gone,
    (await list())?.map((r) => r.name),
  );
  try {
    await page.click({ role: 'button', name: '撤销', exact: true });
  } catch (error) {
    check('点得到通知条的 "撤销"', false, error.message.slice(0, 300));
  }
  const restored = await poll(async () => {
    const o = await order();
    return o.length === 3 && o.indexOf(ARCH.id) === atBefore && o;
  });
  check('撤销后目标回到原来的位置', restored, { at: atBefore, order: await order() });
  await shownAfter(
    '撤销后列表里它在原来的位置',
    (r) => r?.length === 3 && r[atBefore]?.name === ARCH.text,
  );

  // 10. Seven goals: the Add goal button is off and says why.
  for (let n = (await goalsOf()).length; n < 7; n++)
    await call('goal.set', { project_id, text: `Goal ${n + 1} ${stamp}` });
  const addButton = () =>
    page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '添加目标' && x.getClientRects().length);
    if (!b) return null;
    const why = (b.getAttribute('aria-describedby') ?? '').split(/\\s+/).map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' ');
    return { disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', why };
  })()`);
  check('前置：goals[] 有 7 项', (await goalsOf()).length === 7, (await goalsOf()).length);
  await shownAfter('列表有 7 个目标', (r) => r?.length === 7);
  result.full_button = await poll(async () => {
    const b = await addButton();
    return b?.disabled && b;
  }, 5000);
  check('7 个目标时 "添加目标" 不可用', result.full_button?.disabled, result.full_button);
  check(
    '能读到不可用的原因',
    result.full_button?.why === '一个项目最多 7 个目标。归档一个才能再加。',
    result.full_button?.why,
  );
  // The click helper refuses an aria-disabled button; the refusal is the expected outcome.
  result.full_click = await page.click({ role: 'button', name: '添加目标', exact: true }).then(
    () => 'clicked',
    (error) => error.message.slice(0, 200),
  );
  const editors = (await names('新目标')).filter((c) => c.role === 'textarea');
  check('点不可用的 "添加目标" 不出输入框', editors.length === 0, editors);
  result.shot_full = await page.screenshot('board-goals-map-full');
  // Leaves nothing waiting: the notice of a request that waits shows on the page of the drivers run after this one.
  for (const item of (await query('needs_you.list', { project_id })).items)
    if (item.kind === 'permission')
      await call(
        'approval.respond',
        { approval_id: item.source.id, decision: 'reject' },
        item.source.revision,
      );
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
