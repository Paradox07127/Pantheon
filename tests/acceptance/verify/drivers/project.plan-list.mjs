import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'project.plan-list', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-project-plan-list-${stamp}`, {
  'README.md': '# project plan list\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "project-plan-list-fixture", "private": true }\n',
});
const projectRevision = async () =>
  (await query('board', { project_id })).projects.find((p) => p.id === project_id).revision;
// A gate that passes, so a finished session has a gate run and can land.
const ROOT = (await query('project.read', { project_id })).project?.roots?.[0] ?? repo;
await call(
  'project.gate.set',
  { project_id, root: ROOT, commands: [{ name: 'pass-step', argv: ['sh', '-c', 'exit 0'] }] },
  await projectRevision(),
);
const MAIN = `verify-plan-main-${stamp}`;
const BUSY = `verify-plan-busy-${stamp}`;
const DONE = `verify-plan-done-${stamp}`;
const spawn = (title, steps) => ({
  tool: {
    name: 'spawn_session',
    arguments: { runtime: 'fixture', input: `${title}\nfixture-script\n${JSON.stringify(steps)}` },
  },
});
// The main agent starts one session that keeps running and one that changes a file and finishes.
const conductor = await call('session.create', {
  project_id,
  runtime: 'fixture',
  purpose: 'conductor',
  input: `${MAIN}\nfixture-script\n${JSON.stringify([
    spawn(BUSY, [{ hang: true }]),
    spawn(DONE, [
      { write: { path: 'src/extra.ts', text: 'export const a = 1;\nexport const b = 2;\n' } },
      { commit: `extra ${stamp}` },
      { say: 'done' },
    ]),
    { say: 'ok' },
  ])}`,
});
const started = await poll(async () => {
  const all = await query('session.list', { project_id });
  const spawned = all.filter((s) => s.spawned_by?.session_id === conductor.id);
  const main = all.find((s) => s.id === conductor.id);
  const busy = spawned.find((s) => s.title === BUSY);
  const done = spawned.find((s) => s.title === DONE);
  return (
    main?.last_turn?.state === 'completed' &&
    busy?.state === 'running' &&
    done?.last_turn?.state === 'completed' && { busy, done }
  );
}, 60_000);
check('前置：主 agent 起了两个会话', started, started && [started.busy.id, started.done.id]);

// Two milestones, an item with no milestone and a dropped item.
// The evidence mark's words for each level, as the zh-CN project catalog writes them.
const EVIDENCE = { report: '只是自报', gate: '门禁通过', accepted: '你已接受' };
const REVIEWED = { other_vendor: '另一家审过', other_runtime: '同家另一运行时审过' };
const evidenceText = (e) =>
  e?.level === 'reviewed' ? (REVIEWED[e.reviewer] ?? '审过') : EVIDENCE[e?.level];
const GATE = { passed: '通过', failed: '失败', skipped: '跳过' };
const gateText = (runs) => `门禁 ${runs.length} 次，${runs.map((r) => GATE[r]).join('，')}`;
const T = {
  busy: `plan-busy-${stamp}`,
  done: `plan-done-${stamp}`,
  self: `plan-self-${stamp}`,
  other: `plan-other-${stamp}`,
  dropped: `plan-dropped-${stamp}`,
};
const plan = {
  milestones: [
    { id: 'first', title: `第一里程碑-${stamp}` },
    { id: 'second', title: `第二里程碑-${stamp}` },
  ],
  items: [
    { id: 'busy', title: T.busy, milestone: 'first', session_ids: [started?.busy.id ?? ''] },
    { id: 'dropped', title: T.dropped, milestone: 'first', dropped: true },
    { id: 'done', title: T.done, milestone: 'second', session_ids: [started?.done.id ?? ''] },
    { id: 'self', title: T.self, milestone: 'second', session_ids: [conductor.id] },
    { id: 'other', title: T.other },
  ],
};
const revisionOf = async (id) =>
  (await query('board', { project_id })).sessions.find((x) => x.id === id).revision;
await call(
  'session.send',
  {
    session_id: conductor.id,
    input: `plan\nfixture-script\n${JSON.stringify([
      { tool: { name: 'write_plan', arguments: plan } },
      { say: 'planned' },
    ])}`,
  },
  await revisionOf(conductor.id),
);
const written = await poll(async () => {
  const p = await query('project.plan', { project_id });
  return p.plan?.items.length === plan.items.length && p.plan;
}, 30_000);
check('前置：project.plan 有写入的计划', written, written?.items.length);
// The finished session lands once its gate passed; the user accepts the running item.
await poll(async () => {
  const p = await query('project.plan', { project_id });
  const done = p.plan?.items.find((i) => i.id === 'done');
  return done?.gate_runs.length > 0 && done.status === 'ready';
}, 60_000);
await call('session.merge', { session_id: started?.done.id }, await revisionOf(started?.done.id));
await call(
  'project.plan.accept',
  { project_id, item_id: 'busy', accepted: true },
  written?.revision,
);
// The item no session works on is accepted too, so its evidence comes without a session.
await call(
  'project.plan.accept',
  { project_id, item_id: 'other', accepted: true },
  (await query('project.plan', { project_id })).plan?.revision,
);
// The main agent's plan turn ends first, so its item reads the same in the daemon and on screen.
const idle = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.id === conductor.id);
  return s?.state !== 'running' && s?.last_turn?.state === 'completed' && s;
}, 30_000);
check('前置：主 agent 的写计划回合结束', idle, idle?.last_turn);
let view = await poll(async () => {
  // The main agent's turn end starts its own gate run; the plan settles once that run ends.
  const gates = await query('session.gates', { session_id: conductor.id });
  const p = await query('project.plan', { project_id });
  const done = p.plan?.items.find((i) => i.id === 'done');
  const busy = p.plan?.items.find((i) => i.id === 'busy');
  const other = p.plan?.items.find((i) => i.id === 'other');
  // The main agent has a change row while its own gate runs; its item is read once that row is gone.
  const self = p.plan?.items.find((i) => i.id === 'self');
  return (
    self &&
    !self.change &&
    done?.stage === 'landed' &&
    done.evidence &&
    busy?.evidence &&
    other?.evidence &&
    !gates.running &&
    p.plan
  );
}, 60_000);
const backendOf = (view) =>
  view && {
    milestones: view.milestones,
    items: view.items.map((i) => ({
      id: i.id,
      title: i.title,
      milestone: i.milestone,
      stage: i.stage,
      status: i.status,
      diff: i.diff,
      gate_runs: i.gate_runs,
      evidence: i.evidence,
      session_ids: i.session_ids,
      change: !!i.change,
    })),
  };
result.backend = backendOf(view);
check('前置：落地的项和接受的项都有证据', view, result.backend?.items);

await page.click({ role: 'button', name: '项目', exact: true });
const readPlan = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="计划"]')].find((e) => e.getClientRects().length);
    if (!s) return null;
    const after = [...document.querySelectorAll('section[aria-label="计划外"]')].find((e) => e.getClientRects().length);
    return {
      head: s.querySelector('.pj-lh')?.textContent.trim(),
      beforeUnplanned: after ? !!(s.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
      groups: [...s.querySelectorAll('[role=group]')].map((g) => ({
        name: g.getAttribute('aria-label'),
        seg: g.querySelector('.pj-seg')?.getAttribute('aria-label'),
        count: g.querySelector('.pj-mh .pj-n')?.textContent.trim(),
        rows: [...g.querySelectorAll('li.pj-it')].map((li) => {
          const t = li.querySelector('.pj-t > button, .pj-t > span');
          return {
            title: t?.textContent.trim(),
            titleWidth: t?.getBoundingClientRect().width ?? 0,
            opens: li.hasAttribute('data-open'),
            glyph: !!li.firstElementChild?.matches('svg, [role=img], span, i'),
            stage: li.querySelector('.pj-pips')?.getAttribute('aria-label'),
            stageName: li.querySelector('.pj-stg')?.textContent.trim(),
            diff: li.querySelector('.pj-diff')?.textContent.replace(/\\s+/g, ' ').trim(),
            gate: li.querySelector('.pj-gc')?.getAttribute('aria-label') ?? (li.children[5]?.textContent.trim() || null),
            evidence: li.querySelector('.pj-ev')?.getAttribute('aria-label') ?? (li.children[6]?.textContent.trim() || null),
          };
        }),
      })),
    };
  })()`);
const STAGE = {
  plan: '未开始',
  write: '写',
  checks: '检查',
  review: '审查',
  merge: '合并',
  landed: '已落地',
  abandoned: '已放弃',
};
const rowsMatch = (view, shown) => {
  const byTitle = Object.fromEntries((view?.items ?? []).map((i) => [i.title, i]));
  return shown?.groups
    .flatMap((g) => g.rows)
    .map((r) => {
      const i = byTitle[r.title];
      const diff = i?.diff ? `+${i.diff.additions} −${i.diff.deletions}` : '—';
      return {
        title: r.title,
        stage: r.stage === `阶段：${STAGE[i?.stage]}` && r.stageName === STAGE[i?.stage],
        diff: r.diff === diff,
        gate: i?.gate_runs.length ? r.gate === gateText(i.gate_runs) : r.gate === '—',
        evidence: i?.evidence
          ? r.evidence === `证据：${evidenceText(i.evidence)}`
          : r.evidence === '—',
        opens: r.title === T.self || r.opens === Boolean(i?.session_ids?.length),
        width: r.titleWidth > 0,
      };
    });
};
// The screen refetches the plan on events; reads both until every row agrees.
let shown = null;
await poll(async () => {
  shown = await readPlan();
  view = (await query('project.plan', { project_id })).plan ?? view;
  const rows = rowsMatch(view, shown);
  return rows?.length === 4 && rows.every((r) => r.stage && r.diff && r.gate && r.evidence);
}, 30_000);
result.backend = backendOf(view);
result.shown = shown;
check('计划区在计划外上面', shown?.beforeUnplanned === true, shown?.beforeUnplanned);
check(
  '后端对照：组按 milestones 顺序，无里程碑项在最后一组 "其他"',
  JSON.stringify(shown?.groups.map((g) => g.name)) ===
    JSON.stringify([...(view?.milestones.map((m) => m.title) ?? []), '其他']),
  shown?.groups.map((g) => g.name),
);
check(
  'dropped 的项不显示',
  shown && !shown.groups.some((g) => g.rows.some((r) => r.title === T.dropped)),
  shown?.groups.map((g) => g.rows.map((r) => r.title)),
);
check(
  '对照组：同一读法能找到没 dropped 的项',
  shown?.groups.some((g) => g.rows.some((r) => r.title === T.busy)),
);
const groupOk = shown?.groups.map((g) => {
  const ms = view?.milestones.find((m) => m.title === g.name);
  const items = (view?.items ?? []).filter(
    (i) => !i.dropped && (ms ? i.milestone === ms.id : !i.milestone),
  );
  const landed = items.filter((i) => i.stage === 'landed').length;
  return {
    name: g.name,
    titles:
      JSON.stringify(g.rows.map((r) => r.title)) === JSON.stringify(items.map((i) => i.title)),
    count: g.count === `${landed} / ${items.length}`,
    seg: g.seg?.startsWith(`${items.length} 项：`),
  };
});
result.groupOk = groupOk;
check(
  '后端对照：每组的行等于该里程碑的项，组头 "已落地 / 项数" 和分段条名字对',
  groupOk?.length && groupOk.every((g) => g.titles && g.count && g.seg),
  groupOk,
);
const byTitle = Object.fromEntries((view?.items ?? []).map((i) => [i.title, i]));
const rowOk = rowsMatch(view, shown);
result.rowOk = rowOk;
check(
  '后端对照：每行阶段格名字和阶段名等于 stage,+N −N 等于 diff,门禁、证据格对得上 gate_runs、evidence',
  rowOk?.length === 4 &&
    rowOk.every((r) => r.stage && r.diff && r.gate && r.evidence && r.opens && r.width),
  rowOk,
);
const otherRow = shown?.groups.flatMap((g) => g.rows).find((r) => r.title === T.other);
const selfRow = shown?.groups.flatMap((g) => g.rows).find((r) => r.title === T.self);
check('session_ids 只有主 agent 自己的项也是有会话的行，可点开', selfRow?.opens, {
  row: selfRow,
  item: byTitle[T.self] && {
    stage: byTitle[T.self].stage,
    status: byTitle[T.self].status,
    change: !!byTitle[T.self].change,
  },
});
check('前置：主 agent 自己做的项没有改动行', byTitle[T.self] && !byTitle[T.self].change);
check('对照组：没有会话的项不可点开', otherRow && !otherRow.opens, otherRow?.opens);
check(
  '后端对照：接受的无会话项证据是 "证据：你已接受"',
  byTitle[T.other]?.evidence?.level === 'accepted' && otherRow?.evidence === '证据：你已接受',
  { row: otherRow?.evidence, item: byTitle[T.other]?.evidence },
);
check(
  '未开始的项写 "阶段：未开始"',
  otherRow?.stage === '阶段：未开始' && otherRow.stageName === '未开始',
  otherRow,
);
check(
  '对照组：未开始的项阶段名不是 "写"',
  otherRow && otherRow.stageName !== '写',
  otherRow?.stageName,
);
const doneRow = shown?.groups.flatMap((g) => g.rows).find((r) => r.title === T.done);
const doneItem = byTitle[T.done];
const busyItem = byTitle[T.busy];
const busyRow = shown?.groups.flatMap((g) => g.rows).find((r) => r.title === T.busy);
check(
  '后端对照：落地项的门禁格名字等于 gate_runs,证据标记等于 evidence',
  doneItem &&
    doneRow?.gate === gateText(doneItem.gate_runs) &&
    doneRow.evidence === `证据：${evidenceText(doneItem.evidence)}`,
  {
    row: doneRow,
    item: doneItem && { gate_runs: doneItem.gate_runs, evidence: doneItem.evidence },
  },
);
check(
  '后端对照：接受的项证据是 "证据：你已接受"',
  busyItem?.evidence?.level === 'accepted' && busyRow?.evidence === '证据：你已接受',
  { row: busyRow?.evidence, item: busyItem?.evidence },
);
check(
  '对照组：没证据的行证据格是 "—"',
  shown?.groups.flatMap((g) => g.rows).find((r) => r.title === T.self)?.evidence === '—',
);
check(
  '后端对照：组头 "已落地 / 项数" 计入落地项',
  shown?.groups.find((g) => g.name === view?.milestones[1].title)?.count === '1 / 2',
  shown?.groups.map((g) => g.count),
);
check('对照组：改了文件的项 +N −N 不是 "—"', doneRow && doneRow.diff !== '—', doneRow?.diff);
check(
  '1280 宽下计划行标题宽度大于 0',
  rowOk?.length && rowOk.every((r) => r.width),
  shown?.groups.flatMap((g) => g.rows.map((r) => r.titleWidth)),
);
check(
  '主 agent 开着时计划头不写 "主 agent 已关闭"',
  shown && !shown.head.includes('主 agent 已关闭'),
  shown?.head,
);
result.shot = await page.screenshot(result.id);

// A row with a session opens that session.
await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="计划"] li.pj-it')].find((li) => li.textContent.includes(${JSON.stringify(T.busy)}))?.querySelector('.pj-open')?.click()`,
);
const opened = await poll(
  () =>
    page.evaluate(`(() => {
      const m = [...document.querySelectorAll('main[aria-label="对话"]')].find((e) => e.getClientRects().length);
      const list = [...document.querySelectorAll('section[aria-label="计划"]')].some((e) => e.getClientRects().length);
      return m && !list ? { text: m.innerText.slice(0, 300), current: [...document.querySelectorAll('[aria-current]')].filter((e) => e.getClientRects().length).map((e) => (e.getAttribute('aria-label') ?? e.textContent).slice(0, 120)) } : null;
    })()`),
  10_000,
);
result.opened = opened;
const currentRow = (title) => opened?.current.some((c) => c.startsWith(`${title}，fixture`));
check('点有会话的行打开那个会话(侧栏它的行 aria-current)', currentRow(BUSY), opened);
check('对照组：打开的不是另一个会话', opened && !currentRow(DONE), opened?.current);

// The main agent's own item, with no change row, opens the main agent.
await page.click({ role: 'button', name: '项目', exact: true });
await poll(() =>
  page.evaluate(
    `[...document.querySelectorAll('section[aria-label="计划"]')].some((e) => e.getClientRects().length)`,
  ),
);
await page.evaluate(
  `[...document.querySelectorAll('section[aria-label="计划"] li.pj-it')].find((li) => li.textContent.includes(${JSON.stringify(T.self)}))?.querySelector('.pj-open')?.click()`,
);
const openedSelf = await poll(
  () =>
    page.evaluate(`(() => {
      const m = [...document.querySelectorAll('main[aria-label="对话"]')].find((e) => e.getClientRects().length);
      const list = [...document.querySelectorAll('section[aria-label="计划"]')].some((e) => e.getClientRects().length);
      return m && !list ? { current: [...document.querySelectorAll('[aria-current]')].filter((e) => e.getClientRects().length).map((e) => (e.getAttribute('aria-label') ?? e.textContent).slice(0, 120)) } : null;
    })()`),
  10_000,
);
result.openedSelf = openedSelf;
check(
  '点主 agent 自己做的项打开主 agent',
  // A main agent's sidebar row reads "title，主 agent，fixture，…".
  openedSelf?.current.some((c) => c.startsWith(`${MAIN}，`)),
  openedSelf,
);
check(
  '对照组：打开的不是另一个会话',
  openedSelf && !openedSelf.current.some((c) => c.startsWith(`${BUSY}，`)),
  openedSelf?.current,
);

// Once the main agent is gone, the plan head says so.
await call('session.discard', { session_id: conductor.id }, await revisionOf(conductor.id));
const closed = await poll(async () => {
  const p = await query('project.plan', { project_id });
  return p.plan && !p.plan.conductor_open && p.plan;
}, 30_000);
check('前置：project.plan 的 conductor_open 为 false', closed, closed?.conductor_open);
await page.click({ role: 'button', name: '项目', exact: true });
const head = await poll(
  () =>
    page.evaluate(
      `[...document.querySelectorAll('section[aria-label="计划"] .pj-lh')].find((e) => e.getClientRects().length && e.textContent.includes('主 agent 已关闭'))?.textContent.trim() ?? ''`,
    ),
  15_000,
);
check(
  '后端对照：conductor_open 为 false 时计划头写 "主 agent 已关闭"',
  head.includes('主 agent 已关闭'),
  head,
);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
