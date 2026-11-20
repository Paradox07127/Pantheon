import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'sessions.learned-change-candidate', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id, repo } = await newProject(`verify-learned-gate-${stamp}`, {
    'README.md': '# learned gate\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "learned-gate-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  await call('workflow.policy.set', { project_id, improvement_mode: 'confirm' });
  const projectRoot = (await query('project.read', { project_id })).project?.roots?.[0] ?? repo;
  const GATE = [{ name: 'test', argv: ['true'] }];
  await call(
    'project.gate.set',
    { project_id, root: projectRoot, commands: GATE },
    (await board()).projects.find((p) => p.id === project_id).revision,
  );
  const gatesOf = async () => {
    const read = await query('project.read', { project_id });
    return read.gates ?? read.project?.gates ?? {};
  };
  const gatesSet = await gatesOf();
  const ROOT = Object.keys(gatesSet)[0] ?? projectRoot;
  result.root = ROOT;
  check('前置：project.read 的 gates[root] 是设好的一条命令', same(gatesSet[ROOT], GATE), gatesSet);

  // A lead whose first plan has three tasks and whose second keeps one; the two it drops are
  // retired, and each gets a retrospective the proposal can rest on.
  const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
  const planTask = (id) => ({
    id,
    title: `Task ${id} ${stamp}`,
    goal: `Do ${id}.`,
    lane: 'main',
    milestone: 'M',
    depends_on: [],
    source: ['The user asked for it.'],
    scope: [`src/${id}.ts`],
    acceptance: ['true'],
    kind: { domain: 'backend-logic', tier: 't1' },
    path: 'dispatch',
    flow_reason: 'The task runs in a session of its own',
  });
  const plan = (base_version, ids) => ({
    base_version,
    headline: `Learned gate ${stamp}`,
    lanes: [{ id: 'main', title: `Main ${stamp}` }],
    tasks: ids.map(planTask),
    milestones: [{ id: 'M', title: 'Milestone M', criteria: ['The tasks merge'], tasks: ids }],
    risks: [],
    assumptions: [],
  });
  const LEAD = `Lead learned ${stamp}`;
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    purpose: 'lead',
    input: `${LEAD}\n${script({
      tool: { name: 'update_board', arguments: plan(0, ['keep', 'drop_one', 'drop_two']) },
    })}`,
  });
  const leadOf = async () =>
    (await query('session.list', { project_id })).find((s) => s.title === LEAD);
  const idle = () =>
    poll(async () => {
      const s = await leadOf();
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const send = async (...steps) => {
    const ready = await idle();
    await call(
      'session.send',
      { session_id: ready.id, input: script(...steps) },
      (await board()).sessions.find((s) => s.id === ready.id)?.revision ?? ready.revision,
    );
    return idle();
  };
  const lead = await idle();
  check('前置：lead 会话的第一个回合结束', lead?.last_turn?.state === 'completed', lead?.last_turn);
  const version =
    (await query('board.view', { project_id, days: '7' })).leads?.find(
      (l) => l.session_id === lead?.id,
    )?.plan_version ?? 1;
  await send({ tool: { name: 'update_board', arguments: plan(version, ['keep']) } });
  const retros = await poll(async () => {
    const list = await query('retrospective.list', { project_id });
    const rows = Array.isArray(list) ? list : (list.retrospectives ?? list.items ?? []);
    return rows.length >= 2 && rows;
  }, 20_000);
  const retrospective_ids = (retros || []).slice(0, 2).map((r) => r.id);
  result.retrospective_ids = retrospective_ids;
  check('前置：retrospective.list 有两条复盘', retrospective_ids.length === 2, retros);

  // 1. The lead proposes the same command, with a failure counting as skipped.
  const PROPOSED = [{ name: 'test', argv: ['true'], skippable: true }];
  const improvements = async () => query('improvement.list', { project_id });
  const gateItems = async () =>
    (await improvements()).filter((i) => i.change?.type === 'gate_command');
  const proposeTurn = await send({
    tool: {
      name: 'propose_improvement',
      arguments: {
        retrospective_ids,
        change: { type: 'gate_command', root: ROOT, to: PROPOSED },
      },
    },
  });
  const candidate = await poll(async () =>
    (await gateItems()).find((i) => i.status === 'candidate'),
  );
  result.candidate = candidate && {
    id: candidate.id,
    status: candidate.status,
    change: candidate.change,
  };
  check(
    '前置：improvement.list 有一条 gate_command 候选，change.to 是提议值',
    candidate && same(candidate.change.to, PROPOSED),
    result.candidate ?? { turn: proposeTurn?.last_turn, list: await improvements() },
  );
  if (!candidate) throw new Error('No lead proposal to verify; see the checks above');

  // 2. The compact row in the board's needs-you list.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  const strip = () =>
    page.evaluate(`(() => {
      const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length);
      if (!s) return null;
      return [...s.querySelectorAll('li.bf-need')].map((li) => {
        const acts = [...li.querySelectorAll('.rq-hd .rq-acts button')];
        return {
          who: li.querySelector('article')?.getAttribute('aria-label') ?? null,
          kind: li.querySelector('.rq-kind')?.textContent ?? null,
          what: li.querySelector('.rq-hd .rq-what')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
          primary: acts.filter((b) => !b.classList.contains('ib')).map((b) => b.getAttribute('aria-label')),
          more: acts.filter((b) => b.classList.contains('ib')).map((b) => b.getAttribute('aria-label')),
          buttons: [...li.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()),
        };
      });
    })()`);
  const gateRow = (rows, n, m) =>
    rows?.find?.((r) => r.what?.includes(`${ROOT} 的门禁：${n} 条命令改为 ${m} 条`));
  const rows = await poll(async () => {
    const r = await strip();
    return gateRow(r, 1, 1) && r;
  });
  const row = gateRow(rows, 1, 1);
  result.row = row ?? rows;
  check('"需要你" 有紧凑行 "{root} 的门禁：1 条命令改为 1 条"', row, rows);
  check('对照组：同一读法找不到 "1 条命令改为 0 条"', !gateRow(rows, 1, 0), rows);

  // The diff groups as drawn inside a scope of the page.
  const diff = (scope = 'document') =>
    page.evaluate(`(() => {
      const root = ${scope};
      if (!root) return null;
      const g = [...root.querySelectorAll('[role="group"]')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(`${ROOT} 的门禁`)} && el.getClientRects().length);
      if (!g) return null;
      const side = (label) => {
        const ul = g.querySelector('ul[aria-label="' + label + '"]');
        return ul ? [...ul.querySelectorAll('li')].map((li) => ({
          sign: li.firstElementChild?.textContent ?? '',
          none: li.classList.contains('lcd-none'),
          text: li.textContent.replace(/\\s+/g, ' ').trim(),
        })) : null;
      };
      return { now: side('现在'), proposed: side('提议') };
    })()`);
  const lineOk = (lines, sign, gate) =>
    lines?.length === gate.length &&
    lines.every(
      (l, i) =>
        l.sign === sign &&
        l.text.includes(gate[i].name) &&
        l.text.includes(gate[i].argv.join(' ')) &&
        l.text.includes('失败算跳过') === !!gate[i].skippable,
    );
  // The row draws the commands now and as proposed under its count.
  const inRow = await poll(
    () =>
      diff(
        `[...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length)`,
      ),
    3000,
  );
  result.row_diff = inRow;
  result.row_shot = await page.screenshot('learned-change-candidate-row');
  check('"需要你" 的行里有组 "{root} 的门禁"', inRow, {
    row_buttons: row?.buttons,
    page_groups: await names('的门禁'),
  });
  check('行里 "现在" 一组是项目当前的门禁', lineOk(inRow?.now, '−', gatesSet[ROOT]), inRow?.now);
  check(
    '行里 "提议" 一组是 change.to',
    lineOk(inRow?.proposed, '+', candidate.change.to),
    inRow?.proposed,
  );
  check(
    '对照组：行里 "现在" 一组不等于提议值',
    !lineOk(inRow?.now, '−', candidate.change.to),
    inRow?.now,
  );

  // 3. Confirm from the needs-you row.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await poll(async () => gateRow(await strip(), 1, 1));
  const confirmLabel = row && `确认 ${row.who}`;
  try {
    await page.click({ role: 'button', name: confirmLabel, exact: true });
  } catch (error) {
    check('点得到 "确认 <行名>"', false, error.message.slice(0, 300));
  }
  const confirmed = await poll(async () => {
    const [list, gates] = await Promise.all([improvements(), gatesOf()]);
    const it = list.find((i) => i.id === candidate.id);
    return it?.status === 'active' && { it, gates };
  });
  const after = confirmed || {
    it: (await improvements()).find((i) => i.id === candidate.id),
    gates: await gatesOf(),
  };
  check('确认后 improvement.list 里它是 active', confirmed, after.it?.status);
  check(
    '确认后项目的 gates[root] 是提议的值',
    same(after.gates[ROOT], PROPOSED),
    after.gates[ROOT],
  );
  check('确认后 change.from 是确认前的门禁', same(after.it?.change?.from, GATE), after.it?.change);

  // 4. Revert it; the page has no revert control for an improvement.
  await call('improvement.decide', {
    project_id,
    improvement_id: candidate.id,
    decision: 'revert',
  });
  const reverted = await poll(async () => {
    const [list, gates] = await Promise.all([improvements(), gatesOf()]);
    const it = list.find((i) => i.id === candidate.id);
    return it?.status === 'reverted' && same(gates[ROOT], GATE) && { it, gates };
  });
  const revertedNow = reverted || {
    it: (await improvements()).find((i) => i.id === candidate.id),
    gates: await gatesOf(),
  };
  check(
    '撤回后 gates[root] 回到原值',
    same(revertedNow.gates[ROOT], GATE),
    revertedNow.gates[ROOT],
  );
  check(
    '撤回后 improvement.list 里它是 reverted',
    revertedNow.it?.status === 'reverted',
    revertedNow.it?.status,
  );

  // 5. A proposal that clears the gate: rejecting it from the needs-you row keeps the gate.
  await send({
    tool: {
      name: 'propose_improvement',
      arguments: { retrospective_ids, change: { type: 'gate_command', root: ROOT, to: [] } },
    },
  });
  const clearing = await poll(async () =>
    (await gateItems()).find((i) => i.status === 'candidate' && i.change.to.length === 0),
  );
  check(
    '前置：第二条候选把门禁清空',
    clearing,
    (await gateItems()).map((i) => [i.status, i.change.to]),
  );
  if (clearing) {
    await page.click({ role: 'button', name: '项目看板', exact: true });
    const clearRows = await poll(async () => {
      const r = await strip();
      return gateRow(r, 1, 0) && r;
    });
    const clearRow = gateRow(clearRows, 1, 0);
    check('"需要你" 有紧凑行 "{root} 的门禁：1 条命令改为 0 条"', clearRow, clearRows);
    if (clearRow) {
      await page.click({ role: 'button', name: `更多操作：${clearRow.who}`, exact: true });
      await page.click({ role: 'menuitem', name: '拒绝', exact: true });
    }
    const rejected = await poll(async () => {
      const it = (await improvements()).find((i) => i.id === clearing.id);
      return it?.status === 'rejected' && it;
    });
    const gatesAfter = await gatesOf();
    check('拒绝后 improvement.list 里它是 rejected', rejected, rejected?.status);
    check('对照组：拒绝后门禁不变', same(gatesAfter[ROOT], GATE), gatesAfter[ROOT]);
  }
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
