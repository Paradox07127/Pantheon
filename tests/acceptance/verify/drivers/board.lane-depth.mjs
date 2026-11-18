import { open } from '../page.mjs';
const runDir = process.argv[2];
const { page, query, call, errors, poll, names, newProject } = await open(runDir, {
  ms: 300_000,
});
const result = { id: 'board.lane-depth', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id, repo } = await newProject(`verify-lane-depth-${stamp}`, {
  'README.md': '# lane depth\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "lane-depth-fixture", "private": true }\n',
});
const board = () => query('board', { project_id });
const view = () => query('board.view', { project_id, days: '7' });
const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
// A passing gate and auto-merge, so the quick lane's task merges with a gate level.
await call(
  'project.gate.set',
  {
    project_id,
    root: (await board()).projects.find((p) => p.id === project_id).roots?.[0] ?? repo,
    commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
  },
  await revision(),
);
await call('project.autoMerge.set', { project_id, enabled: true }, await revision());
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await revision(),
);
await call('workflow.policy.set', { project_id, max_parallel_limit: 4, max_parallel: 4 });
await call('workflow.definition.set', {
  project_id,
  definition: {
    slots: { before_dispatch: [], before_merge: [], after_merge: [] },
    plan_review: { tiers: [] },
    review: { max_rounds: 1 },
  },
  base_version: 0,
});

const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const RISKY = `Risky lane ${stamp}`;
const QUICK = `Quick lane ${stamp}`;
const QUICK_REASON = `One file the gate can check ${stamp}`;
const TASK = {
  risky_top: `Top tier ${stamp}`,
  risky_low: `Low tier ${stamp}`,
  quick_one: `Quick one ${stamp}`,
};
const file = `quick-${stamp}.txt`;
const goalOf = (id) =>
  id === 'quick_one'
    ? script(
        { write: { path: file, text: 'hello\n' } },
        { commit: `Add ${file}` },
        { tool: { name: 'report', arguments: { kind: 'done', text: 'Done' } } },
      )
    : script({ say: 'Done.' });
const planTask = (id) => ({
  id,
  title: TASK[id],
  goal: `Do ${TASK[id]}\n${goalOf(id)}`,
  lane: id.split('_')[0],
  milestone: id === 'quick_one' ? 'Q' : 'M',
  depends_on: [],
  source: ['The user asked for it.'],
  scope: [id === 'quick_one' ? file : `src/${id}.ts`],
  acceptance: ['true'],
  kind: { domain: 'backend-logic', tier: id === 'risky_top' ? 't3' : 't1' },
  path: 'dispatch',
  flow_reason: 'The task runs in a session of its own',
});
const IDS = Object.keys(TASK);
const plan = {
  base_version: 0,
  headline: `Lane depth ${stamp}`,
  lanes: [
    { id: 'risky', title: RISKY },
    { id: 'quick', title: QUICK, depth: 'just_do', depth_reason: QUICK_REASON },
  ],
  tasks: IDS.map(planTask),
  // The canvas draws the first milestone not completed; Q first, so its node shows once it is ready.
  milestones: [
    { id: 'Q', title: `Milestone Q ${stamp}`, criteria: ['The task merges'], tasks: ['quick_one'] },
    {
      id: 'M',
      title: `Milestone M ${stamp}`,
      criteria: ['The tasks merge'],
      tasks: ['risky_top', 'risky_low'],
    },
  ],
  risks: [],
  assumptions: [],
};
const LEAD = `Lead ${stamp}`;
await call('session.create', {
  project_id,
  runtime: 'fixture',
  input: `${LEAD}\n${script(
    { tool: { name: 'update_board', arguments: plan } },
    { tool: { name: 'start_task', arguments: { task_ids: IDS } } },
  )}`,
});
const lead = await poll(async () => {
  const s = (await query('session.list', { project_id })).find((x) => x.title === LEAD);
  return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
}, 30_000);
check('前置：lead 会话的回合结束', lead, lead?.last_turn);
const laneOf = (v, key) => v.lanes.find((l) => l.id === `${lead?.id}:${key}`);
const taskOf = (v, key) => v.tasks.find((t) => t.title === TASK[key]);

await page.click({ role: 'button', name: '项目看板', exact: true });
await page.click({ role: 'radio', name: '进行中', exact: true });

// The lane head on the canvas: its depth control, who chose it, the reason and the plan state.
const headOf = (title) =>
  page.evaluate(`(() => {
    const lane = [...document.querySelectorAll('.bd-lane')].find((l) => l.querySelector('.bd-lane-ht')?.textContent === ${JSON.stringify(title)} && l.getClientRects().length);
    if (!lane) return null;
    const h = lane.querySelector('.bd-lane-h');
    const group = h.querySelector('[role="radiogroup"]');
    return {
      group: group?.getAttribute('aria-label') ?? null,
      radios: [...(group?.querySelectorAll('[role="radio"]') ?? [])].map((r) => r.textContent.trim()),
      checked: [...(group?.querySelectorAll('[role="radio"][aria-checked="true"]') ?? [])].map((r) => r.textContent.trim()),
      by: h.querySelector('.bd-lane-by')?.textContent.trim() ?? null,
      reason: h.querySelector('.bd-lane-why')?.textContent.trim() ?? null,
      stop: h.querySelector('.bd-lane-stop')?.textContent.trim() ?? null,
    };
  })()`);
const DEPTH_TEXT = { just_do: '直接做', plan_first: '先计划', spec_first: '先写规格' };
const BY_TEXT = { lead: 'Lead', user: '你', pantheon: 'Pantheon' };
// What the head should show for a board.view lane.
const expectedHead = (lane) => ({
  checked: lane?.depth ? [DEPTH_TEXT[lane.depth]] : [],
  by: lane?.depth_by ? BY_TEXT[lane.depth_by] : null,
  reason:
    lane?.depth_by === 'lead'
      ? (lane.depth_reason ?? null)
      : lane?.depth_by === 'pantheon'
        ? '含最高档任务'
        : null,
  stop: lane?.stop?.state === 'waiting' ? '等你批准计划' : null,
});
const headMatches = (head, lane) => {
  const want = expectedHead(lane);
  return (
    !!head &&
    head.checked.join('|') === want.checked.join('|') &&
    head.by === want.by &&
    head.reason === want.reason &&
    (want.stop === null
      ? lane?.stop?.state === 'approved'
        ? head.stop?.startsWith('计划已批准')
        : head.stop === null
      : head.stop === want.stop)
  );
};
const laneSnap = async (key) => {
  const v = await view();
  const lane = laneOf(v, key);
  return {
    lane: lane && {
      depth: lane.depth,
      depth_by: lane.depth_by,
      depth_reason: lane.depth_reason,
      stop: lane.stop,
      estimate: lane.estimate,
    },
  };
};

// 1. The held lane's head before any change.
const held = await poll(async () => {
  const { lane } = await laneSnap('risky');
  const head = await headOf(RISKY);
  return lane?.stop?.state === 'waiting' && head && { lane, head };
}, 30_000);
result.risky_before = held;
const riskyLane = held?.lane;
check(
  '后端：等批准的线 depth=plan_first、depth_by=pantheon、stop.state=waiting、没有 depth_reason',
  riskyLane?.depth === 'plan_first' &&
    riskyLane.depth_by === 'pantheon' &&
    riskyLane.stop?.state === 'waiting' &&
    riskyLane.depth_reason === undefined,
  riskyLane,
);
check(
  `线头有单选组 "${RISKY} 的深度"，三段是 直接做 / 先计划 / 先写规格`,
  held?.head.group === `${RISKY} 的深度` && held.head.radios.join('|') === '直接做|先计划|先写规格',
  held?.head,
);
check(
  '线头选中段、谁定的、理由、等批准和 board.view 一致(先计划 / Pantheon / 含最高档任务 / 等你批准计划)',
  headMatches(held?.head, riskyLane),
  { ui: held?.head, want: expectedHead(riskyLane) },
);
check(
  '对照组：同一读法对 depth_by=lead 判 false',
  !headMatches(held?.head, riskyLane && { ...riskyLane, depth_by: 'lead' }),
);
check('对照组：不存在的线标题读不到线头', (await headOf(`${RISKY}-absent`)) === null);

// The lane head's geometry against its band and the canvas's visible box, for every child.
const geometry = (title) =>
  page.evaluate(`(() => {
    const lane = [...document.querySelectorAll('.bd-lane')].find((l) => l.querySelector('.bd-lane-ht')?.textContent === ${JSON.stringify(title)} && l.getClientRects().length);
    if (!lane) return null;
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width) }; };
    let clip = lane.parentElement;
    while (clip && getComputedStyle(clip).overflowX === 'visible' && getComputedStyle(clip).overflowY === 'visible') clip = clip.parentElement;
    const h = lane.querySelector('.bd-lane-h');
    const box = r(lane), view = clip ? r(clip) : null, head = r(h);
    const children = [...h.children].map((c) => ({ cls: c.className || c.getAttribute('role'), ...r(c), scroll: c.scrollWidth, client: c.clientWidth }));
    const right = Math.min(box.right, view ? view.right : Infinity);
    const left = Math.max(box.left, view ? view.left : -Infinity);
    const out = children.filter((c) => c.right > right + 0.5 || c.left < left - 0.5 || c.width < 1);
    return { lane: box, view, head, children, out: out.map((c) => c.cls) };
  })()`);

// 1b. The quick lane is chosen by the lead, with its reason; checked once its task merged, under 近 7 天.
// 2. A real click on another segment sets the user's depth.
const target = { role: 'radiogroup', name: `${RISKY} 的深度`, exact: true };
result.hit_before_click = await page.evaluate(`(() => {
  const g = [...document.querySelectorAll('[role="radiogroup"]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`${RISKY} 的深度`)});
  const r = [...(g?.querySelectorAll('[role="radio"]') ?? [])].find((x) => x.textContent.trim() === '先写规格');
  if (!r) return null;
  const b = r.getBoundingClientRect();
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return { inside: r === hit || r.contains(hit), hit: hit?.className ?? null, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
check(
  '"先写规格" 的中心点在画布上最上层是它自己(没有被任务卡盖住)',
  result.hit_before_click?.inside,
  result.hit_before_click,
);
try {
  await page.click({ role: 'radio', name: '先写规格', exact: true, within: target });
} catch (error) {
  check('CDP 点得到 "先写规格"', false, error.message.slice(0, 300));
}
const set = await poll(async () => {
  const { lane } = await laneSnap('risky');
  const head = await headOf(RISKY);
  return lane?.depth === 'spec_first' && headMatches(head, lane) && { lane, head };
}, 10_000);
const after = set || { ...(await laneSnap('risky')), head: await headOf(RISKY) };
result.risky_after_depth = after;
check(
  '后端：CDP 点击后 depth=spec_first、depth_by=user，仍在等批准',
  after.lane?.depth === 'spec_first' &&
    after.lane.depth_by === 'user' &&
    after.lane.stop?.state === 'waiting',
  after.lane,
);
check(
  '线头选中 "先写规格"、显示 "你"、不显示理由',
  after.head?.checked.join('|') === '先写规格' &&
    after.head.by === '你' &&
    after.head.reason === null,
  after.head,
);
check('线头和 board.view 一致', headMatches(after.head, after.lane), {
  ui: after.head,
  want: expectedHead(after.lane),
});

// Every task of this plan sits in one column; the milestone node adds a second.
result.narrow = await geometry(RISKY);
check(
  '一列任务的线(图里还有里程碑列)：线头子元素都在线框和画布可见区域里',
  result.narrow && result.narrow.out.length === 0,
  result.narrow,
);
result.shot = await page.screenshot('board-lane-depth');

// 3. The estimate under the plan approval in the needs-you strip.
const estimate = () =>
  page.evaluate(`(() => {
    const s = [...document.querySelectorAll('section[aria-label="需要你"]')].find((el) => el.getClientRects().length && el.getBoundingClientRect().height > 0);
    const g = s && [...s.querySelectorAll('[role="group"]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`${RISKY} 的估算`)});
    if (!g) return null;
    return [...g.querySelectorAll(':scope > [role="group"]')].map((x) => ({
      label: x.getAttribute('aria-label'),
      text: x.textContent.replace(/\\s+/g, ' ').trim(),
      values: [...x.querySelectorAll('.bf-el-v')].map((v) => ({ text: v.textContent.trim(), unknown: v.dataset.unknown === 'true' })),
      tasks: [...x.querySelectorAll(':scope > .bf-el > .bf-el-n')].map((v) => v.textContent.trim()),
    }));
  })()`);
const est = await poll(estimate, 10_000);
const want = after.lane?.estimate;
result.estimate = { ui: est, daemon: want };
// Each amount's box against every ancestor that clips it, and whether any of them scrolls.
result.estimate_clip = await page.evaluate(`(() => {
  const g = [...document.querySelectorAll('[role="group"]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`${RISKY} 的估算`)} && x.getClientRects().length);
  if (!g) return null;
  const clips = [];
  for (let n = g.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflowY === 'visible') continue;
    const b = n.getBoundingClientRect();
    clips.push({ cls: String(n.className).slice(0, 60), overflowY: s.overflowY, top: Math.round(b.top), bottom: Math.round(b.bottom), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight });
  }
  const bottom = Math.min(innerHeight, ...clips.map((c) => c.bottom));
  return {
    bottom,
    clips,
    scrolls: clips.some((c) => /auto|scroll/.test(c.overflowY) && c.scrollHeight > c.clientHeight),
    values: [...g.querySelectorAll('.bf-el-v')].map((v) => ({ text: v.textContent.trim(), bottom: Math.round(v.getBoundingClientRect().bottom) })),
    hidden: [...g.querySelectorAll('.bf-el-v')].filter((v) => v.getBoundingClientRect().bottom > bottom + 0.5).map((v) => v.textContent.trim()),
  };
})()`);
check(
  '估算里每个量(含 "未知")都在可见区域内，或所在区域能滚动到',
  result.estimate_clip &&
    (result.estimate_clip.hidden.length === 0 || result.estimate_clip.scrolls),
  result.estimate_clip,
);
// Every text element of the estimate against the visible box of its scroll container, unscrolled.
result.estimate_unscrolled = await page.evaluate(`(() => {
  const g = [...document.querySelectorAll('[role="group"]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(`${RISKY} 的估算`)} && x.getClientRects().length);
  if (!g) return null;
  let top = 0, bottom = innerHeight, scroller = null;
  for (let n = g.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflowY === 'visible') continue;
    const b = n.getBoundingClientRect();
    top = Math.max(top, b.top);
    bottom = Math.min(bottom, b.bottom);
    if (!scroller && /auto|scroll/.test(s.overflowY)) scroller = { cls: String(n.className).slice(0, 60), top: Math.round(b.top), bottom: Math.round(b.bottom), scrollTop: n.scrollTop, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight };
  }
  const texts = [...g.querySelectorAll('*')].filter((el) => el.getClientRects().length && [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
  const boxes = texts.map((el) => { const b = el.getBoundingClientRect(); return { text: el.textContent.trim(), top: Math.round(b.top), bottom: Math.round(b.bottom) }; });
  return {
    needs: document.querySelectorAll('section[aria-label="需要你"] li.bf-need').length,
    window: innerWidth + 'x' + innerHeight,
    visible: { top: Math.round(top), bottom: Math.round(bottom) },
    scroller,
    outside: boxes.filter((b) => b.top < top - 0.5 || b.bottom > bottom + 0.5),
    boxes,
  };
})()`);
check(
  '批准行的估算不滚动就完整可见',
  result.estimate_unscrolled && result.estimate_unscrolled.outside.length === 0,
  result.estimate_unscrolled,
);
check('"需要你" 的批准行下有组 "<线> 的估算"', est, est);
const groups = est ? Object.fromEntries(est.map((g) => [g.label, g])) : {};
check(
  '估算分三组：会话：{sessions.total}、Token、时间',
  est?.length === 3 && groups[`会话：${want?.sessions.total}`] && groups.Token && groups['时间'],
  est?.map((g) => g.label),
);
const tokens = groups.Token;
const tokenValues = [
  ...(want?.tokens.history.tasks > 0 ? ['history'] : []),
  ...(want?.tokens.budget.tasks > 0 ? ['budget'] : []),
  ...(want?.tokens.unknown_tasks > 0 ? ['unknown'] : []),
];
check(
  'Token 组的量和 estimate.tokens 对上，未知的量显示 "未知" 不是 0',
  tokens &&
    tokens.values.length === tokenValues.length &&
    tokenValues.every((kind, n) =>
      kind === 'unknown'
        ? tokens.values[n].text === '未知' &&
          tokens.tasks[n] === `${want.tokens.unknown_tasks} 个任务`
        : tokens.values[n].text !== '未知' && tokens.values[n].text !== '0',
    ),
  { ui: tokens, daemon: want?.tokens },
);
const timed = want?.wall_ms?.tasks ?? 0;
const time = groups['时间'];
check(
  '时间组和 estimate.wall_ms 对上，没有预算的任务显示 "未知"',
  time &&
    (want.wall_ms ? time.values[0]?.text !== '未知' : true) &&
    (want.tasks > timed
      ? time.values.at(-1)?.text === '未知' && time.tasks.at(-1) === `${want.tasks - timed} 个任务`
      : true),
  { ui: time, daemon: { tasks: want?.tasks, wall_ms: want?.wall_ms } },
);
check(
  '对照组：同一读法对 sessions.total+1 判 false',
  !groups[`会话：${(want?.sessions.total ?? 0) + 1}`],
);

// 4. Approve from the needs-you row.
try {
  await page.click({ role: 'button', name: `批准计划 ${RISKY}`, exact: true });
} catch (error) {
  check('点得到 "批准计划 <线>"', false, error.message.slice(0, 300));
}
const approved = await poll(async () => {
  const { lane } = await laneSnap('risky');
  return lane?.stop?.state === 'approved' && lane;
}, 10_000);
const approvedLane = approved || (await laneSnap('risky')).lane;
check(
  '后端：批准后 stop.state=approved，没有 estimate',
  approvedLane?.stop?.state === 'approved' && approvedLane.estimate === undefined,
  approvedLane,
);
const gone = await poll(async () => (await estimate()) === null, 5000);
check('批准后估算消失', gone, await estimate());
const approvedHead = await poll(async () => {
  const head = await headOf(RISKY);
  return head?.stop?.startsWith('计划已批准') && head;
}, 5000);
check('批准后线头显示 "计划已批准"', approvedHead, approvedHead || (await headOf(RISKY)));

// 5. Evidence marks, read under 近 7 天 where merged tasks stay on the canvas.
const merged = await poll(async () => {
  const v = await view();
  const t = taskOf(v, 'quick_one');
  return t?.state === 'merged' && t.evidence_level && v;
}, 90_000);
const v5 = merged || (await view());
const quick = taskOf(v5, 'quick_one');
result.quick_task = quick && {
  state: quick.state,
  evidence_level: quick.evidence_level,
  evidence_reviewer: quick.evidence_reviewer,
};
check('前置：quick 线的任务已合并，有 evidence_level', merged, result.quick_task);
await page.click({ role: 'radio', name: '近 7 天', exact: true });
const LEVEL_LABEL = {
  report: '证据：仅有报告',
  gate: '证据：门禁通过',
  verified: '证据：验证通过',
  accepted: '证据：你已验收',
};
const labelOf = (level, reviewer) =>
  level === 'reviewed'
    ? reviewer === 'other_vendor'
      ? '证据：别家模型已审'
      : reviewer === 'other_runtime'
        ? '证据：同一厂商的别的运行时已审'
        : '证据：已审'
    : level
      ? LEVEL_LABEL[level]
      : null;
const nodeMarks = () =>
  page.evaluate(`(() => Object.fromEntries(${JSON.stringify(Object.values(TASK))}.map((title) => {
    const el = [...document.querySelectorAll('[role="group"]')].find((g) => g.getAttribute('aria-label')?.startsWith(title + '，') && g.getClientRects().length);
    return [title, el ? [...el.querySelectorAll('[aria-label^="证据："]')].map((m) => m.getAttribute('aria-label') + '|' + m.textContent.trim()) : null];
  })))()`);
const marks = await poll(async () => {
  const m = await nodeMarks();
  return m[TASK.quick_one]?.length && m;
}, 10_000);
const shownMarks = marks || (await nodeMarks());
result.node_marks = shownMarks;
const quickWant = labelOf(quick?.evidence_level, quick?.evidence_reviewer);
check(
  '已合并任务节点上有一个 "证据：…"，等于 evidence_level / evidence_reviewer',
  shownMarks[TASK.quick_one]?.length === 1 &&
    shownMarks[TASK.quick_one][0].split('|')[0] === quickWant,
  { ui: shownMarks[TASK.quick_one], want: quickWant },
);
check(
  '对照组：同一读法对另一档判 false',
  shownMarks[TASK.quick_one]?.[0]?.split('|')[0] !== labelOf('report'),
);
const v5b = await view();
const unmerged = ['risky_top', 'risky_low'].map((k) => ({
  key: k,
  state: taskOf(v5b, k)?.state,
  level: taskOf(v5b, k)?.evidence_level,
  ui: shownMarks[TASK[k]],
}));
result.unmerged = unmerged;
check(
  '对照组：没合并的任务节点上没有 "证据：" 开头的东西',
  unmerged.some((u) => u.state !== 'merged' && !u.level) &&
    unmerged.every((u) =>
      u.level ? u.ui?.length === 1 : Array.isArray(u.ui) && u.ui.length === 0,
    ),
  unmerged,
);

// The quick lane: depth chosen by the lead, with its reason.
const quickHead = await poll(() => headOf(QUICK), 5000);
const quickLane = laneOf(v5b, 'quick');
result.quick_lane = { ui: quickHead, daemon: quickLane };
check(
  '后端：lead 定的线 depth=just_do、depth_by=lead、depth_reason 是 lead 给的',
  quickLane?.depth === 'just_do' &&
    quickLane.depth_by === 'lead' &&
    quickLane.depth_reason === QUICK_REASON &&
    quickLane.stop === undefined,
  quickLane,
);
check('线头显示 直接做 / Lead / lead 的理由，右端没有批准状态', headMatches(quickHead, quickLane), {
  ui: quickHead,
  want: expectedHead(quickLane),
});
result.narrow_quick = await geometry(QUICK);
check(
  '只有一个任务的线，线头子元素都在线框和画布可见区域里',
  result.narrow_quick && result.narrow_quick.out.length === 0,
  result.narrow_quick,
);
result.shot_7d = await page.screenshot('board-lane-depth-7d');

// The drawer head carries the same mark.
const drawerMark = () =>
  page.evaluate(`(() => {
    const d = document.querySelector('aside.bd-drw');
    if (!d || !d.getClientRects().length || d.dataset.endingStyle) return null;
    return {
      title: document.getElementById('bd-drw-title')?.textContent ?? null,
      marks: [...d.querySelectorAll('.bd-dmeta [aria-label^="证据："]')].map((m) => m.getAttribute('aria-label')),
    };
  })()`);
try {
  await page.click({ role: 'group', name: `${TASK.quick_one}，`, exact: false });
} catch (error) {
  check(`打开 ${TASK.quick_one} 的抽屉`, false, error.message.slice(0, 300));
}
const drawer = await poll(async () => {
  const d = await drawerMark();
  return d?.title === TASK.quick_one && d;
});
result.drawer = drawer;
check(
  '抽屉头部是同一个证据标记',
  drawer?.marks.length === 1 && drawer.marks[0] === quickWant,
  drawer,
);
await page.press('Escape');

// The milestone node of the quick lane's milestone.
const milestone = v5b.milestones?.find((m) => m.title === `Milestone Q ${stamp}`);
const readMilestones = () =>
  page.evaluate(`[...document.querySelectorAll('.bd-ms')].filter((m) => m.getClientRects().length).map((m) => ({
  title: m.querySelector('.bd-nt')?.textContent ?? null,
  marks: [...m.querySelectorAll('[aria-label^="证据："]')].map((x) => x.getAttribute('aria-label')),
}))`);
const msNodes =
  (await poll(async () => {
    const nodes = await readMilestones();
    return nodes.some((m) => m.title === `Milestone Q ${stamp}` && m.marks.length) && nodes;
  }, 5000)) || (await readMilestones());
result.milestone = {
  daemon: milestone && { status: milestone.status, evidence_level: milestone.evidence_level },
  ui: msNodes,
};
const msNode = msNodes.find((m) => m.title === `Milestone Q ${stamp}`);
check(
  '前置：画布上有这个带等级的里程碑节点',
  milestone?.evidence_level && msNode,
  result.milestone,
);
check(
  '里程碑节点的证据标记等于 milestones[].evidence_level',
  msNode?.marks.length === 1 && msNode.marks[0] === labelOf(milestone?.evidence_level),
  result.milestone,
);
const otherMs = v5b.milestones?.find((m) => m.title === `Milestone M ${stamp}`);
check(
  '对照组：没有等级的里程碑没有证据标记(后端也没有)',
  !otherMs?.evidence_level &&
    !msNodes.some((m) => m.title === `Milestone M ${stamp}` && m.marks.length),
  { daemon: otherMs?.evidence_level ?? null, ui: msNodes },
);

// A narrow lane: a plan of one lane with one t3 task and no milestone, so the chart is one card wide.
const narrow = await newProject(`verify-lane-narrow-${stamp}`, {
  'README.md': '# lane narrow\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "lane-narrow-fixture", "private": true }\n',
});
const nrev = async () =>
  (await query('board', { project_id: narrow.project_id })).projects.find(
    (p) => p.id === narrow.project_id,
  ).revision;
await call(
  'project.sessionDefaults.set',
  { project_id: narrow.project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  await nrev(),
);
const NARROW = `Narrow lane ${stamp}`;
const NARROW_TASK = `Narrow one ${stamp}`;
const NARROW_LEAD = `Narrow lead ${stamp}`;
await call('session.create', {
  project_id: narrow.project_id,
  runtime: 'fixture',
  input: `${NARROW_LEAD}\n${script({
    tool: {
      name: 'update_board',
      arguments: {
        base_version: 0,
        headline: `Lane narrow ${stamp}`,
        lanes: [{ id: 'narrow', title: NARROW }],
        tasks: [
          {
            ...planTask('risky_top'),
            id: 'narrow_one',
            title: NARROW_TASK,
            lane: 'narrow',
            milestone: undefined,
          },
        ],
        milestones: [],
        risks: [],
        assumptions: [],
      },
    },
  })}`,
});
const narrowLane = await poll(async () => {
  const v = await query('board.view', { project_id: narrow.project_id, days: '7' });
  const l = v.lanes.find((x) => x.title === NARROW);
  return l?.stop?.state === 'waiting' && v.tasks.length === 1 && l;
}, 30_000);
check('前置：窄线项目的线等批准，只有一个任务', narrowLane, narrowLane);
await page.click({ role: 'button', name: '项目看板', exact: true });
await page.click({ role: 'radio', name: '进行中', exact: true });
const narrowHead = await poll(() => headOf(NARROW), 10_000);
check('窄线的线头和 board.view 一致', headMatches(narrowHead, narrowLane), {
  ui: narrowHead,
  want: expectedHead(narrowLane),
});
result.narrow_one_card = await geometry(NARROW);
check(
  '一张卡宽的窄线：线头子元素都在线框和画布可见区域里',
  result.narrow_one_card && result.narrow_one_card.out.length === 0,
  result.narrow_one_card,
);
result.shot_narrow = await page.screenshot('board-lane-depth-narrow');

// Leaves nothing waiting: the notice of a lane that waits shows on the page of the drivers run after this one.
if (narrowLane)
  await call('board.lane.approve', {
    project_id: narrow.project_id,
    lead_session_id: narrowLane.id.slice(0, narrowLane.id.indexOf(':')),
    lane_id: 'narrow',
  });

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
