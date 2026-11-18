import { scanOverflow } from '../overflow.mjs';
import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, newProject } = await open(runDir, { ms: 170_000 });
const result = { id: 'board.milestone-assumptions', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const NAME = `verify-assumptions-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# assumptions\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "assumptions-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const view = () => query('board.view', { project_id, days: '1' });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );

  // Plan: milestone A rests on two assumptions with ids and one without; milestone B on none.
  const goal = (await call('goal.set', { project_id, text: `Ship the importer ${stamp}` })).id;
  const MA = `Importer reads files ${stamp}`;
  const MB = `Importer writes rows ${stamp}`;
  const TASK = {
    parse: `Parse the header ${stamp}`,
    load: `Load the rows ${stamp}`,
    check: `Check the encoding ${stamp}`,
    write: `Write the rows ${stamp}`,
  };
  const A1 = `Files are UTF-8 ${stamp}`;
  const A2 = `Every file has a header row ${stamp}`;
  const A3 = `Nobody imports more than once a day ${stamp}`;
  const task = (id) => ({
    id,
    title: TASK[id],
    goal: `Do ${TASK[id]}.`,
    lane: 'lane-a',
    milestone: id === 'write' ? 'ms-b' : 'ms-a',
    depends_on: [],
    source: ['The user asked for it.'],
    scope: [`src/${id}.ts`],
    acceptance: ['true'],
    kind: { domain: 'backend-logic', tier: 't1' },
  });
  const plan = {
    base_version: 0,
    headline: `Assumptions ${stamp}`,
    lanes: [{ id: 'lane-a', title: `Lane A ${stamp}` }],
    tasks: Object.keys(TASK).map(task),
    milestones: [
      { id: 'ms-a', title: MA, criteria: ['It reads.'], tasks: ['parse', 'load', 'check'], goal },
      { id: 'ms-b', title: MB, criteria: ['It writes.'], tasks: ['write'], goal },
    ],
    risks: [],
    assumptions: [
      { id: 'utf8', text: A1, affects: ['parse', 'check'], milestone: 'ms-a' },
      { id: 'header', text: A2, affects: ['parse', 'load'], milestone: 'ms-a' },
      { text: A3, affects: ['load'], milestone: 'ms-a' },
    ],
  };
  const script = (steps) => `fixture-script\n${JSON.stringify(steps)}`;
  const LEAD = `Lead ${stamp}`;
  const leadId = (
    await call('session.create', {
      project_id,
      runtime: 'fixture',
      input: `${LEAD}\n${script([{ tool: { name: 'update_board', arguments: plan } }])}`,
    })
  ).id;
  const idle = () =>
    poll(async () => {
      const s = (await query('session.list', { project_id })).find((x) => x.id === leadId);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const msOf = (v, title) => v.milestones.find((m) => m.title === title);
  const leadOf = (v) => v.leads?.find((l) => l.session_id === leadId);
  const titleOf = (v, id) => v.tasks.find((t) => t.id === id)?.title;
  const editsOf = (v) => leadOf(v)?.pending_edits ?? [];
  /** The lead resolves `editId` in one more fixture turn, on the plan version it reads once idle. */
  const resolve = async (editId, decision, reason) => {
    await idle();
    const version = leadOf(await view())?.plan_version;
    await call(
      'session.send',
      {
        session_id: leadId,
        input: script([
          {
            tool: {
              name: 'edit_board',
              arguments: {
                base_version: version,
                ops: [
                  {
                    type: 'resolve_edit',
                    edit_id: editId,
                    decision,
                    ...(reason ? { reason } : {}),
                  },
                ],
              },
            },
          },
        ]),
      },
      (await board()).sessions.find((s) => s.id === leadId).revision,
    );
    const done = await idle();
    return { version, turn: done?.last_turn };
  };

  // 1. board.view carries only the assumptions with an id.
  const seeded = await poll(async () => {
    const v = await view();
    return msOf(v, MA)?.assumptions?.length && v;
  }, 30_000);
  const v1 = seeded || (await view());
  const msA = msOf(v1, MA);
  result.assumptions = msA?.assumptions;
  check(
    '后端：里程碑 A 的 assumptions 只有带 id 的两条，顺序同计划',
    msA?.assumptions?.length === 2 &&
      msA.assumptions[0].id === 'utf8' &&
      msA.assumptions[0].text === A1 &&
      msA.assumptions[1].id === 'header' &&
      msA.assumptions[1].text === A2 &&
      !msA.assumptions.some((a) => a.text === A3),
    msA?.assumptions,
  );
  check(
    '对照组：不带 id 的那条在 leads[].assumptions 里(计划写进去了)，只是不进里程碑',
    leadOf(v1)?.assumptions?.some((a) => a.text === A3 && a.id === undefined),
    leadOf(v1)?.assumptions,
  );
  check(
    '后端：affects 是受影响任务的看板 id',
    msA?.assumptions?.[0]?.affects.map((id) => titleOf(v1, id)).join('|') ===
      `${TASK.parse}|${TASK.check}`,
    msA?.assumptions?.map((a) => a.affects.map((id) => titleOf(v1, id))),
  );
  check(
    '对照组：里程碑 B 没有 assumptions',
    msOf(v1, MB) && !msOf(v1, MB).assumptions,
    msOf(v1, MB)?.assumptions,
  );

  await page.click({ role: 'button', name: '项目看板', exact: true });
  /** Picks a milestone on the goals view, which shows it on the now view. */
  const pick = async (title) => {
    await page.click({ role: 'radio', name: '目标', exact: true });
    await page.click({ role: 'button', name: title, exact: false });
    const state = () =>
      page.evaluate(`({
        hash: location.hash,
        tab: document.querySelector('[role="radiogroup"][aria-label="看板视图"] [aria-checked="true"]')?.getAttribute('aria-label') ?? null,
        cards: [...document.querySelectorAll('section.bms h2')].filter((h) => h.getClientRects().length).map((h) => h.textContent),
      })`);
    const at = await poll(async () => {
      const s = await state();
      return s.cards.includes(title) && s;
    });
    if (!at)
      throw new Error(
        `the now view does not show milestone ${title}: ${JSON.stringify(await state())}`,
      );
  };
  /** The milestone card's assumptions list and each row's parts. */
  const readList = () =>
    page.evaluate(`(() => {
      const card = [...document.querySelectorAll('section.bms')].find((s) => s.getClientRects().length);
      if (!card) return null;
      const list = card.querySelector('ul[aria-label="假设"]');
      return {
        milestone: card.querySelector('.bms-h')?.textContent ?? null,
        list: !!list,
        rows: list ? [...list.querySelectorAll(':scope > li')].map((li) => ({
          text: li.querySelector('.bma-t')?.textContent.trim() ?? null,
          tasks: [...li.querySelectorAll('.bma-k .bma-tk')].map((b) => b.textContent.trim()),
          outcome: li.querySelector('.bma-rf')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
          quote: li.querySelector('.bma-rf q, .bma-rf del')?.textContent ?? null,
          why: li.querySelector('.bma-why')?.textContent ?? null,
          buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()),
          input: !!li.querySelector('input'),
        })) : [],
      };
    })()`);
  const rowOf = async (text) => (await readList())?.rows.find((r) => r.text === text) ?? null;
  /** Clicks the button with text `label` in the row of assumption `text`, by a CDP click on its centre. */
  const clickRow = async (text, label) => {
    const box = await page.evaluate(`(() => {
      const li = [...document.querySelectorAll('li.bma-it')].find((l) => l.querySelector('.bma-t')?.textContent.trim() === ${JSON.stringify(text)} && l.getClientRects().length);
      const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, top: b === hit || b.contains(hit) };
    })()`);
    if (!box?.top) throw new Error(`no clickable ${label} in row ${text}: ${JSON.stringify(box)}`);
    const mouse = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse });
  };

  // 2. The now view of milestone A lists the two assumptions, each with its tasks.
  await pick(MA);
  const shown = await poll(async () => {
    const l = await readList();
    return l?.rows.length && l;
  });
  result.list = shown;
  check(
    '"现在" 页里程碑 A 的 "假设" 列表是这两条的文字',
    shown?.milestone === MA && shown.rows.map((r) => r.text).join('|') === `${A1}|${A2}`,
    shown,
  );
  check(
    '每条下面是受影响任务的标题(和 affects 一致)',
    shown?.rows.length === 2 &&
      shown.rows.every(
        (r, i) =>
          r.tasks.join('|') === msA.assumptions[i].affects.map((id) => titleOf(v1, id)).join('|'),
      ),
    shown?.rows.map((r) => r.tasks),
  );
  check(
    '不带 id 的那条不在列表里',
    shown && !shown.rows.some((r) => r.text === A3),
    shown?.rows.map((r) => r.text),
  );
  check(
    '每条都有 "不对，改成别的"',
    shown?.rows.length === 2 && shown.rows.every((r) => r.buttons.includes('不对，改成别的')),
    shown?.rows.map((r) => r.buttons),
  );
  await pick(MB);
  const other = await readList();
  check(
    '对照组：没有假设的里程碑 B 没有 "假设" 列表',
    other?.milestone === MB && !other.list,
    other,
  );
  await pick(MA);
  await poll(async () => (await readList())?.rows.length);

  // 3. Refute the first assumption; the row shows the words and never the refute button again.
  const before = editsOf(await view()).length;
  const INSTEAD1 = `Files come in Latin-1 too ${stamp}`;
  await clickRow(A1, '不对，改成别的');
  await page.fill({ role: 'textbox', name: '应该是什么', exact: true }, INSTEAD1);
  // Samples the row every 50 ms from Enter until it carries the board's refute (its Withdraw button).
  await page.evaluate(`(() => {
    window.__rowSamples = [];
    const read = () => {
      const li = [...document.querySelectorAll('li.bma-it')].find((l) => l.querySelector('.bma-t')?.textContent.trim() === ${JSON.stringify(A1)});
      return li ? { at: Date.now(), form: !!li.querySelector('form'), text: li.innerText.replace(/\\s+/g, ' '), buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()) } : { at: Date.now(), form: false, text: null, buttons: [] };
    };
    const start = (e) => {
      if (e.key !== 'Enter') return;
      removeEventListener('keydown', start, true);
      window.__enterAt = Date.now();
      window.__rowTimer = setInterval(() => {
        const s = read();
        window.__rowSamples.push(s);
        if (s.buttons.includes('撤回') || window.__rowSamples.length > 400) clearInterval(window.__rowTimer);
      }, 50);
    };
    addEventListener('keydown', start, true);
  })()`);
  await page.press('Enter');
  const landed = await poll(async () => {
    const v = await view();
    const a = msOf(v, MA)?.assumptions?.find((x) => x.id === 'utf8');
    return a?.refuted?.state === 'pending' && { v, a };
  });
  const samples = await poll(async () => {
    const s = await page.evaluate('window.__rowSamples');
    return s.some((x) => x.buttons.includes('撤回')) && s;
  }, 5000);
  const allSamples = samples || (await page.evaluate('window.__rowSamples'));
  await page.evaluate('clearInterval(window.__rowTimer)');
  const enterAt = await page.evaluate('window.__enterAt');
  const firstOut = allSamples.find((s) => !s.form);
  result.samples = {
    count: allSamples.length,
    form_samples: allSamples.filter((s) => s.form).length,
    first_without_form: firstOut && { ...firstOut, after_ms: firstOut.at - enterAt },
    last: allSamples.at(-1) && { ...allSamples.at(-1), after_ms: allSamples.at(-1).at - enterAt },
  };
  check(
    '输入框收起后的第一次采样就显示这句话和 "等 lead 处理"',
    firstOut?.text?.includes(INSTEAD1) && firstOut.text.includes('等 lead 处理'),
    result.samples.first_without_form,
  );
  check(
    '从回车到这一行带上看板的 refuted(出现 "撤回")，每次采样里都没有 "不对，改成别的"',
    allSamples.length > 0 &&
      allSamples.some((s) => s.buttons.includes('撤回')) &&
      allSamples.every((s) => !s.buttons.includes('不对，改成别的')),
    {
      count: allSamples.length,
      flashed: allSamples.filter((s) => s.buttons.includes('不对，改成别的')).slice(0, 3),
    },
  );
  const p1 = landed?.a?.refuted;
  check(
    '后端：refuted.state=pending、instead 等于输入',
    p1?.state === 'pending' && p1.instead === INSTEAD1,
    p1,
  );
  const edits1 = landed ? editsOf(landed.v) : [];
  const edit1 = edits1.find((e) => e.id === p1?.edit_id);
  check(
    '后端：leads[].pending_edits 多一项，带 refutes 指向这条假设',
    edits1.length === before + 1 &&
      edit1?.refutes?.some((r) => r.assumption_id === 'utf8' && r.instead === INSTEAD1),
    edits1,
  );
  const pendingRow = await rowOf(A1);
  result.pending_row = pendingRow;
  check(
    '那一行显示用户的话、"等 lead 处理" 和 "撤回"',
    pendingRow?.quote === INSTEAD1 &&
      pendingRow.outcome.includes('等 lead 处理') &&
      pendingRow.buttons.includes('撤回') &&
      !pendingRow.buttons.includes('不对，改成别的'),
    pendingRow,
  );
  check(
    '对照组：第二条没有结果行，仍是 "不对，改成别的"',
    await (async () => {
      const r = await rowOf(A2);
      return r?.outcome === null && r.buttons.includes('不对，改成别的');
    })(),
  );
  result.shot_pending = await page.screenshot('board-assumptions-pending');

  // 4. Withdraw, then the notice's Undo sends the same words again.
  await page.click({ role: 'button', name: `撤回你对“${A1}”的改动`, exact: true });
  const withdrawn = await poll(async () => {
    const v = await view();
    const a = msOf(v, MA)?.assumptions?.find((x) => x.id === 'utf8');
    const row = await rowOf(A1);
    return a?.refuted?.state === 'withdrawn' && row?.outcome?.includes('已撤回') && { a, row, v };
  });
  result.withdrawn = withdrawn && { refuted: withdrawn.a.refuted, row: withdrawn.row };
  check(
    '撤回后那一行显示 "已撤回"(划掉的原话)',
    withdrawn?.row.quote === INSTEAD1 && withdrawn.row.outcome.includes('已撤回'),
    withdrawn?.row ?? (await rowOf(A1)),
  );
  check(
    '后端：撤回后 refuted.state=withdrawn，pending_edits 没有这一项',
    withdrawn?.a.refuted.state === 'withdrawn' &&
      withdrawn.a.refuted.edit_id === p1?.edit_id &&
      !editsOf(withdrawn.v).some((e) => e.id === p1?.edit_id),
    withdrawn?.a.refuted,
  );
  const notice = await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('*')].filter((el) => el.getClientRects().length && el.children.length === 0 && el.textContent.includes(${JSON.stringify(`已撤回你对“${A1}”的改动`)})).map((el) => el.textContent)`,
    ),
  );
  check('出现通知条 "已撤回你对“…”的改动"', notice?.length > 0, notice);
  await page.click({ role: 'button', name: '撤销', exact: true });
  const again = await poll(async () => {
    const v = await view();
    const a = msOf(v, MA)?.assumptions?.find((x) => x.id === 'utf8');
    const row = await rowOf(A1);
    return (
      a?.refuted?.state === 'pending' &&
      a.refuted.edit_id !== p1?.edit_id &&
      row?.buttons.includes('撤回') && { a, row, v }
    );
  });
  result.undone = again && { refuted: again.a.refuted, row: again.row };
  check(
    '撤销后那一行又是 "等 lead 处理"',
    again?.row.outcome.includes('等 lead 处理') && again.row.quote === INSTEAD1,
    again?.row ?? (await rowOf(A1)),
  );
  const edit2 = again && editsOf(again.v).find((e) => e.id === again.a.refuted.edit_id);
  check(
    '后端：新的 pending 编辑，instead 相同',
    again?.a.refuted.instead === INSTEAD1 &&
      edit2?.refutes?.some((r) => r.assumption_id === 'utf8' && r.instead === INSTEAD1),
    { refuted: again?.a.refuted, edit: edit2 },
  );

  // 5. The lead rejects it with a reason.
  const REASON = `The importer reads only UTF-8 by design ${stamp}`;
  result.reject_turn = again && (await resolve(again.a.refuted.edit_id, 'reject', REASON));
  const rejected = await poll(async () => {
    const v = await view();
    const a = msOf(v, MA)?.assumptions?.find((x) => x.id === 'utf8');
    const row = await rowOf(A1);
    return (
      a?.refuted?.state === 'rejected' && row?.outcome?.includes('lead 保留原样') && { a, row }
    );
  }, 15_000);
  result.rejected = rejected || {
    a: msOf(await view(), MA)?.assumptions?.find((x) => x.id === 'utf8'),
    row: await rowOf(A1),
  };
  check(
    '后端：refuted.state=rejected、reason 是 lead 的理由',
    rejected?.a.refuted.state === 'rejected' && rejected.a.refuted.reason === REASON,
    result.rejected.a?.refuted,
  );
  check(
    '那一行显示 "lead 保留原样"、理由原文和 "打开 lead"',
    rejected?.row.why === REASON &&
      rejected.row.quote === INSTEAD1 &&
      rejected.row.buttons.includes('打开 lead'),
    result.rejected.row,
  );
  check('对照组：同一读法对另一条理由判 false', !(rejected?.row.why === `${REASON}-absent`));
  result.shot_rejected = await page.screenshot('board-assumptions-rejected');

  // 6. Refute the second assumption; the lead applies it.
  const INSTEAD2 = `Some files start with data ${stamp}`;
  await clickRow(A2, '不对，改成别的');
  await page.fill({ role: 'textbox', name: '应该是什么', exact: true }, INSTEAD2);
  await page.press('Enter');
  const second = await poll(async () => {
    const a = msOf(await view(), MA)?.assumptions?.find((x) => x.id === 'header');
    return a?.refuted?.state === 'pending' && a;
  });
  check('后端：第二条 refuted.state=pending', second?.refuted.instead === INSTEAD2, second);
  result.apply_turn = second && (await resolve(second.refuted.edit_id, 'apply'));
  const applied = await poll(async () => {
    const a = msOf(await view(), MA)?.assumptions?.find((x) => x.id === 'header');
    const row = await rowOf(INSTEAD2);
    return a?.refuted?.state === 'applied' && row?.outcome?.includes('lead 改了计划') && { a, row };
  }, 15_000);
  result.applied = applied || {
    a: msOf(await view(), MA)?.assumptions?.find((x) => x.id === 'header'),
    rows: (await readList())?.rows,
  };
  check(
    '后端：refuted.state=applied，假设文字变成用户写的话',
    applied?.a.refuted.state === 'applied' && applied.a.text === INSTEAD2,
    result.applied.a,
  );
  check(
    '那一行显示 "lead 改了计划"，文字是用户写的话',
    applied?.row.text === INSTEAD2 && applied.row.outcome.includes('lead 改了计划'),
    result.applied.row ?? result.applied.rows,
  );
  check('对照组：原来的文字不再出现在列表里', (await rowOf(A2)) === null, await rowOf(A2));

  // 7. Esc closes the field, gives the focus back and sends nothing.
  const count = editsOf(await view()).length;
  await clickRow(A1, '不对，改成别的');
  const opened = await poll(async () => (await rowOf(A1))?.input);
  check('点 "不对，改成别的" 打开输入框', opened, await rowOf(A1));
  await page.press('Escape');
  const closed = await poll(async () => {
    const row = await rowOf(A1);
    return row && !row.input && row;
  }, 5000);
  const focus = await page.evaluate(`(() => {
    const el = document.activeElement;
    const li = el?.closest('li.bma-it');
    return { tag: el?.tagName, text: el?.textContent.trim(), row: li?.querySelector('.bma-t')?.textContent.trim() ?? null };
  })()`);
  check('Esc 后输入框消失', closed, closed || (await rowOf(A1)));
  check(
    '焦点回到那条的 "不对，改成别的"',
    focus.tag === 'BUTTON' && focus.text === '不对，改成别的' && focus.row === A1,
    focus,
  );
  const changed = await poll(async () => editsOf(await view()).length !== count, 1500);
  check('后端：Esc 没有发出编辑(pending_edits 条数不变)', !changed, {
    before: count,
    after: editsOf(await view()).length,
  });

  // 8. No horizontal overflow. The card is the nearest box that draws (background, border or clip),
  // as overflow.mjs counts it; the rows' hover fill bleeds past the undrawn milestone column on purpose.
  result.geometry = await page.evaluate(`(() => {
    const ms = [...document.querySelectorAll('section.bms')].find((s) => s.getClientRects().length);
    const list = ms?.querySelector('ul[aria-label="假设"]');
    if (!list) return null;
    const clear = (c) => /^transparent$|,\\s*0\\)$|\\/\\s*0\\)$/.test(c);
    const draws = (cs) => !clear(cs.backgroundColor) || cs.overflowX !== 'visible' || ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && !clear(cs['border' + s + 'Color']));
    let card = ms;
    while (card && !draws(getComputedStyle(card))) card = card.parentElement;
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right) }; };
    const c = card.getBoundingClientRect();
    const lead = ms.parentElement.querySelector(':scope > .bld');
    const boxes = [list, ...list.querySelectorAll('li.bma-it, li.bma-it *')].filter((el) => el.getClientRects().length).map((el) => ({ cls: String(el.className?.baseVal ?? el.className).slice(0, 40), ...r(el) }));
    const m = r(ms);
    return {
      card: { cls: String(card.className).slice(0, 40), left: Math.round(c.left), right: Math.round(c.right), scroll: card.scrollWidth, client: card.clientWidth },
      milestone_column: m,
      lead_column: lead ? r(lead) : null,
      past_column: boxes.filter((b) => b.right > m.right + 0.5 || b.left < m.left - 0.5).map((b) => b.cls + ' ' + b.left + '..' + b.right),
      out: boxes.filter((b) => b.right > c.right + 0.5 || b.left < c.left - 0.5),
      into_lead: lead ? boxes.filter((b) => b.right > r(lead).left + 0.5) : [],
      text_past_column: [...list.querySelectorAll('.bma-b, .bma-a')].filter((el) => el.getClientRects().length).map(r).filter((b) => b.right > m.right + 0.5 || b.left < m.left - 0.5),
      count: boxes.length,
    };
  })()`);
  check(
    '列表和每一行在里程碑卡(画出来的框)里，不压到 lead 栏，文字不出里程碑栏，卡没有横向滚动',
    result.geometry &&
      result.geometry.out.length === 0 &&
      result.geometry.into_lead.length === 0 &&
      result.geometry.text_past_column.length === 0 &&
      result.geometry.card.scroll <= result.geometry.card.client,
    result.geometry,
  );
  result.overflow = await scanOverflow(page, { within: '.bov' });
  check(
    'overflow.mjs 在里程碑和 lead 条里没有发现越界或被截断的文字',
    result.overflow.length === 0,
    result.overflow,
  );

  // 5b. The rejected row's Open lead opens the lead's session.
  await clickRow(A1, '打开 lead');
  const opening = () =>
    page.evaluate(`({
      hash: location.hash,
      current: [...document.querySelectorAll('[aria-current="true"], [aria-current="page"]')].filter((el) => el.getClientRects().length).map((el) => (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 120)),
      card: [...document.querySelectorAll('section.bms')].some((s) => s.getClientRects().length),
    })`);
  const openedLead = await poll(async () => {
    const s = await opening();
    return s.current.some((t) => t.startsWith(LEAD)) && s;
  });
  result.open_lead = openedLead || (await opening());
  check(
    '"打开 lead" 打开的是 lead 会话(侧栏选中 lead 行，看板卡不再显示)',
    openedLead && !openedLead.card,
    result.open_lead,
  );
  check(
    '对照组：选中的行不是别的会话',
    !result.open_lead.current.some((t) => t.startsWith(`${LEAD}-absent`)),
  );

  // Leaves nothing waiting for the user.
  const end = await view();
  check('收尾：lead 没有等处理的编辑', editsOf(end).length === 0, editsOf(end));
} catch (error) {
  check('驱动跑完', false, String(error?.stack ?? error).slice(0, 600));
}

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
