import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'sessions.personal-needs-list', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const stamp = Date.now();

const homeOf = (board) => board.projects.find((p) => p.kind === 'personal') ?? null;
const visibleIds = (board) =>
  board.projects
    .filter((p) => p.removed_at === undefined && p.kind !== 'personal')
    .map((p) => p.id);
// What waits in the projects the user sees, from one read of the board and the needs list.
const waits = async () => {
  const [board, needs] = await Promise.all([query('board'), query('needs_you.list')]);
  const ids = visibleIds(board);
  return needs.items.filter((i) => ids.includes(i.project_id));
};
const escaped = (text) =>
  [...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
const askIn = async (project_id, title) => {
  await call('session.create', {
    project_id,
    runtime: 'fixture',
    input: `${title}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command: `echo ${title}` } } }])}`,
  });
  return poll(async () =>
    (await query('session.list', { project_id })).find((s) => s.title === title && s.waiting > 0),
  );
};

// 1. A second project, and one waiting fixture session in each project.
const second = await newProject(`verify-personal-needs-${stamp}`, {
  'README.md': '# personal needs\n',
  'src/index.ts': 'export const answer = 42;\n',
  'package.json': '{ "name": "personal-needs-fixture", "private": true }\n',
});
const WAIT_A = `verify-needs-a-${stamp}`;
const WAIT_B = `verify-needs-b-${stamp}`;
const WAIT_C = `verify-needs-c-${stamp}`;
const waitA = await askIn(run.project_id, WAIT_A);
const waitB = await askIn(second.project_id, WAIT_B);
check('前置：两个项目里各有一个 fixture 会话在待批准', waitA && waitB, [waitA?.id, waitB?.id]);
const mine = [waitA?.id, waitB?.id];

// 2. The sidebar's personal row opens the personal agent's session.
const rowLabel = () =>
  page.evaluate(`(() => {
    const group = [...document.querySelectorAll('[role="group"][aria-label="个人级"]')].find((g) => g.getClientRects().length);
    return [...(group?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label')).find((n) => n?.startsWith('个人级智能体')) ?? null;
  })()`);
const shownTitle = () =>
  page.evaluate(
    `[...document.querySelectorAll('.app-main h1')].filter((h) => h.getClientRects().length).map((h) => h.textContent.trim())`,
  );
const onPersonal = async () => (await shownTitle()).includes('个人级智能体');
const openPersonal = async () => {
  await poll(rowLabel);
  // The row's name carries the live count, which can change between a read and the click.
  await page.click({
    role: 'button',
    name: '个人级智能体，',
    exact: false,
    within: { role: 'group', name: '个人级', exact: true },
  });
  return poll(onPersonal);
};
check('点侧栏 "个人级智能体" 打开个人级会话', await openPersonal(), await shownTitle());
const home = await poll(async () => homeOf(await query('board')));
const personal = await poll(async () =>
  home
    ? (await query('session.list', { project_id: home.id })).find(
        (s) => s.resident?.kind === 'personal' && !s.archived_at,
      )
    : null,
);
result.personal = personal && { id: personal.id, runtime: personal.runtime };
check('前置：个人级会话落在 fixture 运行时上', personal?.runtime === 'fixture', result.personal);

const turnsOf = async (sessionId) =>
  (await query('board')).session_turns.filter((t) => t.session_id === sessionId);
const send = async (title, steps) => {
  const before = (await turnsOf(personal?.id)).length;
  // The approval notices of the waits made above sit over the composer's send button.
  await poll(() =>
    page.evaluate(`(() => {
      const open = [...document.querySelectorAll('.toast-x')].filter((b) => b.getClientRects().length);
      open.forEach((b) => b.click());
      return open.length === 0;
    })()`),
  );
  await page.fill(
    { role: 'textbox', name: '发给 个人级智能体', exact: true },
    `${title}\nfixture-script\n${steps}`,
  );
  await page.click({ role: 'button', name: '发送', exact: true });
  return poll(async () => {
    const turns = await turnsOf(personal?.id);
    const last = turns.at(-1);
    return turns.length > before && ['completed', 'failed'].includes(last?.state) && last;
  }, 30_000);
};
// The needs lists in the personal thread, in thread order.
const lists = () =>
  page.evaluate(`(() => {
    const main = [...document.querySelectorAll('main[aria-label="对话"]')].find((m) => m.getClientRects().length);
    return [...(main?.querySelectorAll('.pn[role="group"]') ?? [])].map((g) => ({
      label: g.getAttribute('aria-label'),
      at: g.querySelector('.pn-h time')?.textContent ?? null,
      projects: [...g.querySelectorAll(':scope > [role="group"]')].map((p) => ({
        name: p.getAttribute('aria-label'),
        count: p.querySelector('.pn-g .pn-n')?.textContent ?? null,
        rows: [...p.querySelectorAll('button.pn-r')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
      })),
    }));
  })()`);

// 3–4. The personal agent reads needs_you; the reply holds the list as it read it.
const listsBefore = (await lists()).length;
const needsBefore = await waits();
const READ = `verify-needs-read-${stamp}`;
const readTurn = await send(
  READ,
  `[{"tool":{"name":"needs_you","arguments":{}}},{"say":"${escaped('两件事在等你。')}"}]`,
);
const needsAfter = await waits();
check(
  '个人级回合完成',
  readTurn?.state === 'completed',
  readTurn && { state: readTurn.state, error: readTurn.error },
);
const shownLists = await poll(async () => {
  const l = await lists();
  return l.length > listsBefore && l;
});
const list = shownLists?.[listsBefore];
result.list = list ?? (await lists());
// The read happened between the two reads of needs_you.list; take it only when they agree.
const steady =
  needsBefore.length === needsAfter.length &&
  needsBefore.every((i) => needsAfter.some((j) => j.source.id === i.source.id));
const read = needsAfter;
const byProject = new Map();
for (const item of read) byProject.set(item.project_id, (byProject.get(item.project_id) ?? 0) + 1);
result.read = { count: read.length, projects: [...byProject], steady };
check('前置：读清单前后 needs_you.list 没变', steady, {
  before: needsBefore.length,
  after: needsAfter.length,
});
check(
  '前置：needs_you.list 里有这次造的两条，分在两个项目',
  mine.every((id) => read.some((i) => i.session_id === id)) &&
    new Set(read.filter((i) => mine.includes(i.session_id)).map((i) => i.project_id)).size === 2,
  read.map((i) => [i.project_id, i.session_id, i.kind]),
);
const labelFor = (n, p) => `等你处理：${n} 项，在 ${p} 个项目`;
check(
  `回复里有组 "${labelFor(read.length, byProject.size)}"，数目等于那一刻 needs_you.list 的可见条目`,
  list?.label === labelFor(read.length, byProject.size),
  { ui: list?.label, daemon: result.read },
);
check(
  '对照组：同一读法对多一项判 false',
  list?.label !== labelFor(read.length + 1, byProject.size),
);
const clock = (at) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const turnEnd = readTurn?.completed_at ?? readTurn?.ended_at ?? Date.now();
check(
  '头部写 "截至 HH:MM"，是这次读的时间',
  list?.at &&
    /^截至 \d{2}:\d{2}$/.test(list.at) &&
    [clock(turnEnd), clock(turnEnd - 60_000)].includes(list.at.slice(3)),
  { ui: list?.at, turn_end: clock(turnEnd) },
);
const board = await query('board');
const nameOf = (id) => board.projects.find((p) => p.id === id)?.name;
check(
  '每个项目一个子组，名字和条数对上 needs_you.list',
  list?.projects.length === byProject.size &&
    list.projects.every(
      (p) =>
        [...byProject].some(([id, n]) => nameOf(id) === p.name && String(n) === p.count) &&
        p.rows.length === Math.min(5, Number(p.count)),
    ),
  {
    ui: list?.projects.map((p) => [p.name, p.count, p.rows.length]),
    daemon: [...byProject].map(([id, n]) => [nameOf(id), n]),
  },
);
result.shot = await page.screenshot('personal-needs-list');

// A row opens its project's session.
const rowB = list?.projects.find((p) => p.name === second.name);
const rowText = rowB?.rows.find((r) => r.includes(WAIT_B));
if (rowText) {
  await page.click({
    role: 'button',
    name: rowText,
    exact: true,
    within: {
      role: 'group',
      name: second.name,
      exact: true,
      within: { role: 'group', name: list.label, exact: true },
    },
  });
  const jumped = await poll(async () => {
    const [title, switcher] = await Promise.all([
      shownTitle(),
      page.evaluate(`document.querySelector('button[aria-label="切换项目"]')?.textContent ?? ''`),
    ]);
    return (
      title.some((t) => t.includes(WAIT_B)) && switcher.includes(second.name) && { title, switcher }
    );
  });
  check('点一行跳到对应项目的这个会话', jumped, jumped || (await shownTitle()));
} else check('第二个项目的子组里有这个会话的一行', false, rowB);

// 5. Frozen: one more wait, and the list in the earlier reply stays as it was read.
const waitC = await askIn(run.project_id, WAIT_C);
const grown = await poll(async () => {
  const w = await waits();
  return w.some((i) => i.session_id === waitC?.id) && w;
});
check(
  '前置：再起一个 ask 会话后 needs_you.list 多一条',
  grown && grown.length === read.length + 1,
  { before: read.length, after: grown?.length },
);
check('回到个人级会话', await openPersonal(), await shownTitle());
const frozen = await poll(async () => (await lists())[listsBefore]);
check(
  '回复里的清单仍是读时的条数，不随 needs_you.list 变',
  frozen?.label === list?.label && frozen?.at === list?.at,
  { then: list?.label, now: frozen?.label, live: grown?.length },
);
check('对照组：清单不是实时的数目', frozen?.label !== labelFor(grown?.length ?? 0, byProject.size));

// 6. The personal agent sends a request to the second project's assistant.
const assistantOf = async () =>
  (await query('session.list', { project_id: second.project_id })).find(
    (s) => s.resident?.kind === 'assistant' && !s.archived_at,
  );
const REQUEST = 'Keep EU VAT';
const assistantTurns = async () => {
  const a = await assistantOf();
  return a ? (await turnsOf(a.id)).filter((t) => t.input === REQUEST) : [];
};
check('对照组：发送前助理没有这句话的回合', (await assistantTurns()).length === 0);
const sentTurn = await send(
  `verify-needs-send-${stamp}`,
  JSON.stringify([
    {
      tool: { name: 'send_request', arguments: { project_id: second.project_id, input: REQUEST } },
    },
    { say: '__SAY__' },
  ]).replace('__SAY__', escaped('已转。')),
);
check(
  '转需求的个人级回合完成',
  sentTurn?.state === 'completed',
  sentTurn && { state: sentTurn.state, error: sentTurn.error },
);
const delivered = await poll(assistantTurns, 15_000);
result.delivered = delivered.map((t) => ({ id: t.id, input: t.input, via: t.via, state: t.state }));
check(
  '后端：第二个项目的助理会话多了一个回合，输入是这句话，由个人级密钥发来',
  delivered.length === 1 && delivered[0].via?.key_id,
  result.delivered,
);
const SENT = `已转给${second.name}的助理`;
const sentLine = () =>
  page.evaluate(`(() => {
    const main = [...document.querySelectorAll('main[aria-label="对话"]')].find((m) => m.getClientRects().length);
    const g = [...(main?.querySelectorAll('[role="group"]') ?? [])].filter((x) => x.getAttribute('aria-label') === ${JSON.stringify(SENT)});
    return g.map((x) => [...x.querySelectorAll('button')].map((b) => b.textContent.trim()));
  })()`);
const line = await poll(sentLine);
result.sent_line = line;
check(
  `回复里有组 "${SENT}"，两个名字都是按钮`,
  line.length === 1 && line[0].join('|') === `${second.name}|助理`,
  line,
);
check(
  '对照组：同一读法找不到转给 verify-app 的一行',
  (await page.evaluate(
    `[...document.querySelectorAll('[role="group"]')].filter((x) => x.getAttribute('aria-label') === ${JSON.stringify(`已转给${run.project_name}的助理`)}).length`,
  )) === 0,
);
const within = { role: 'group', name: SENT, exact: true };
await page.click({ role: 'button', name: second.name, exact: true, within });
const toProject = await poll(
  async () =>
    (
      await page.evaluate(
        `document.querySelector('button[aria-label="切换项目"]')?.textContent ?? ''`,
      )
    ).includes(second.name) && !(await onPersonal()),
);
check('点项目名切到那个项目', toProject, await shownTitle());
await openPersonal();

// 7. The assistant's session names the personal agent on that turn.
await page.click({ role: 'button', name: '助理', exact: true, within });
const fromPersonal = () =>
  page.evaluate(`(() => {
    const main = [...document.querySelectorAll('main[aria-label="对话"]')].find((m) => m.getClientRects().length);
    return [...(main?.querySelectorAll('[role="group"][aria-label="由个人级智能体发来"]') ?? [])].map((g) => ({
      buttons: [...g.querySelectorAll('button')].map((b) => b.textContent.trim()),
      input: g.parentElement?.querySelector('.ss-user')?.textContent ?? null,
    }));
  })()`);
const marks = await poll(async () => {
  const m = await fromPersonal();
  return m.some((x) => x.input === REQUEST) && m;
});
const shownMarks = marks || (await fromPersonal());
result.assistant = { title: await shownTitle(), marks: shownMarks };
check(
  '点 "助理" 打开助理会话，这一回合上有组 "由个人级智能体发来"，里面是按钮 "个人级智能体"',
  shownMarks.length === 1 &&
    shownMarks[0].input === REQUEST &&
    shownMarks[0].buttons.join('|') === '个人级智能体',
  result.assistant,
);
check('对照组：当前页不是个人级会话', !(await onPersonal()), await shownTitle());
result.shot_assistant = await page.screenshot('personal-needs-assistant');
await page.click({
  role: 'button',
  name: '个人级智能体',
  exact: true,
  within: { role: 'group', name: '由个人级智能体发来', exact: true },
});
check('点 "个人级智能体" 打开个人级会话', await poll(onPersonal), await shownTitle());

// Settle the waits made above, so later drivers count from where they were.
for (const id of [waitA?.id, waitB?.id, waitC?.id]) {
  const item = (await query('needs_you.list')).items.find(
    (i) => i.session_id === id && i.kind === 'permission',
  );
  if (item)
    await call(
      'approval.respond',
      { approval_id: item.source.id, decision: 'reject' },
      item.source.revision,
    );
}

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
