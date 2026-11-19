import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'board.task-thread', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Records each distinct state the page commits from now on, at every DOM change; `state` is a page
// expression. A window on a background display gets no animation frames, so this does not use them.
const watch = (state) =>
  page.evaluate(`(() => {
    window.__verifyWatch?.disconnect();
    const seen = (window.__verifyStates = []);
    const t0 = Date.now();
    let last;
    const take = () => {
      const now = (() => ${state})();
      if (last !== now) seen.push(now + ' @' + (Date.now() - t0) + 'ms');
      last = now;
    };
    take();
    const observer = (window.__verifyWatch = new MutationObserver(take));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => observer.disconnect(), 4000);
    return true;
  })()`);
const states = () => page.evaluate('window.__verifyStates ?? []');
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;

// A step that throws still leaves the checks before it in the printed result.
try {
  const stamp = Date.now();
  const { project_id, repo } = await newProject(`verify-task-thread-${stamp}`, {
    'README.md': '# thread\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "task-thread-fixture", "private": true }\n',
  });
  const board = () => query('board', { project_id });
  const revision = async () => (await board()).projects.find((p) => p.id === project_id).revision;
  const root = (await board()).projects.find((p) => p.id === project_id).roots?.[0] ?? repo;
  const gate = async (code) =>
    call(
      'project.gate.set',
      {
        project_id,
        root,
        commands: [{ name: 'Unit tests', argv: [process.execPath, '-e', `process.exit(${code})`] }],
      },
      await revision(),
    );
  await gate(1);
  await call('project.autoMerge.set', { project_id, enabled: true }, await revision());
  await call(
    'project.sessionDefaults.set',
    { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
    await revision(),
  );
  const assistant = (await call('resident.open', { project_id, kind: 'assistant' })).id;
  const sessions = () => query('session.list', { project_id });
  const idle = (id = assistant) =>
    poll(async () => {
      const s = (await sessions()).find((x) => x.id === id);
      return s?.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s;
    }, 30_000);
  const send = async (steps) => {
    await idle();
    await call(
      'session.send',
      { session_id: assistant, input: script(...steps) },
      (await board()).sessions.find((s) => s.id === assistant).revision,
    );
    return idle();
  };

  // The review prompt carries the task's first message, so the goal holds the reviewer's script;
  // the task session's own first turn fails on it, and the lead's message does the work.
  // A goal holds at most 400 characters, so the finding fields are short.
  const short = stamp % 100000;
  const QUOTE = `Average ${short}`;
  const finding = (blocking, impact) => ({
    tool: {
      name: 'review_finding',
      arguments: {
        location: 'src/index.ts',
        quote: QUOTE,
        evidence: 'goal',
        impact,
        blocking,
        ...(blocking ? { reproduction: 'x' } : {}),
      },
    },
  });
  const MINOR = `Naming ${short}`;
  const MAJOR = `Zero ${short}`;
  const TITLE = `Average ${stamp}`;
  const Q = `Round the average ${stamp}?`;
  const plan = {
    base_version: 0,
    headline: `Thread ${stamp}`,
    lanes: [{ id: 'lane-a', title: 'Lane A' }],
    tasks: [
      {
        id: 'task-one',
        title: TITLE,
        goal: `${QUOTE}.\n${script(finding(false, MINOR), finding(true, MAJOR))}`,
        lane: 'lane-a',
        milestone: 'milestone-a',
        estimate: 3,
        depends_on: [],
        source: ['The user asked for it.'],
        scope: ['src/index.ts'],
        acceptance: ['true'],
        kind: { domain: 'backend-logic', tier: 't1' },
        priority: 'normal',
      },
    ],
    milestones: [
      { id: 'milestone-a', title: 'Milestone A', criteria: ['It merges.'], tasks: ['task-one'] },
    ],
    risks: [],
    assumptions: [],
  };
  await send([
    { tool: { name: 'update_board', arguments: plan } },
    {
      tool: {
        name: 'ask_user',
        arguments: {
          question: Q,
          options: ['Round down', 'Keep decimals'],
          recommended: 'Keep decimals',
          assumption: 'Keep decimals.',
          blocks: ['task-one'],
        },
      },
    },
  ]);
  const question = await poll(
    async () =>
      (await query('needs_you.list', { project_id })).items.find(
        (i) => i.kind === 'lead.question' && i.question?.question === Q,
      )?.question,
  );
  check('前置：lead 的提问在 needs_you.list 里', question, question?.id);
  await call('lead.question.answer', {
    project_id,
    lead_session_id: assistant,
    question_id: question.id,
    answer: 'Keep decimals',
  });
  await idle();
  await call('task.start', { project_id, lead_session_id: assistant, task_ids: ['task-one'] });
  const worker = await poll(
    async () => (await sessions()).find((s) => s.task?.id === 'task-one'),
    30_000,
  );
  check('前置：task-one 开出了任务会话', worker, worker?.id);
  await idle(worker.id);
  const LEAD_SAYS = `Write it now ${stamp}`;
  await send([
    {
      tool: {
        name: 'message_task',
        arguments: {
          task_id: 'task-one',
          text: `${LEAD_SAYS}\n${script(
            { write: { path: 'src/index.ts', text: 'export const answer = 43;\n' } },
            { commit: 'Average' },
            { tool: { name: 'report', arguments: { kind: 'done', text: `Done ${stamp}` } } },
          )}`,
        },
      },
    },
  ]);
  const failedGate = await poll(async () => {
    const s = (await sessions()).find((x) => x.id === worker.id);
    return s?.gates?.state === 'failed' || s?.merge?.reason === 'gates_failed' ? s : null;
  }, 40_000);
  result.after_gate = failedGate && { gates: failedGate.gates, merge: failedGate.merge };
  const thread = () =>
    query('task.thread', { project_id, lead_session_id: assistant, task_id: 'task-one' });
  const gated = await poll(
    async () => (await thread()).find((e) => e.kind === 'gate' && !e.passed),
    40_000,
  );
  check(
    '前置：task.thread 有一次失败的门禁',
    gated,
    (await thread()).map((e) => e.kind),
  );

  // A review of the worker by the user; the reviewer runs the goal's script.
  const review = await call('review.request', { session_id: worker.id, runtimes: ['fixture'] });
  const reviewed = await poll(async () => {
    const list = await query('session.reviews', { session_id: worker.id });
    const r = list.find((x) => x.id === review.review_id);
    return r && r.state !== 'running' && r;
  }, 40_000);
  result.review = reviewed && {
    state: reviewed.state,
    findings: reviewed.findings?.map((f) => [f.blocking, f.status]),
  };
  const blocker = reviewed?.findings?.find((f) => f.blocking);
  check(
    '前置：审查记了一条阻塞、一条不阻塞的发现',
    blocker && reviewed.findings.length === 2,
    result.review,
  );
  if (blocker)
    await call(
      'review.finding.resolve',
      { review_id: reviewed.id, finding_id: blocker.id, outcome: 'dismissed' },
      reviewed.revision,
    );
  await gate(0);
  await call(
    'session.gates.run',
    { session_id: worker.id },
    (await board()).sessions.find((s) => s.id === worker.id).revision,
  );
  // The daemon retries the merge the failed gate stopped once the user's gate run passes.
  await poll(async () => (await thread()).some((e) => e.kind === 'gate' && e.passed), 40_000);
  const merged = await poll(async () => (await thread()).find((e) => e.kind === 'merged'), 60_000);
  check(
    '前置：task.thread 有合并',
    merged,
    (await thread()).map((e) => e.kind),
  );
  // The merge wakes the lead, whose turns can add entries; the thread is read once the lead and its
  // task sessions have no turn left, in the same pass that judges them quiet.
  let entries =
    (await poll(async () => {
      const [list, now] = await Promise.all([sessions(), thread()]);
      const lead = list.find((s) => s.id === assistant);
      const busy = (s) => s.last_turn && ['queued', 'running'].includes(s.last_turn.state);
      const quiet =
        lead?.last_turn &&
        !busy(lead) &&
        !list.some(
          (s) =>
            s.lead === assistant &&
            (busy(s) || ['starting', 'running', 'merging'].includes(s.state)),
        );
      return quiet && now.some((e) => e.kind === 'merged') && now;
    }, 60_000)) || (await thread());
  result.daemon_kinds = entries.map((e) => e.kind + (e.kind === 'gate' ? `:${e.passed}` : ''));
  const want = [
    'dispatched',
    'lead_message',
    'report',
    'finding',
    'gate',
    'question',
    'answer',
    'merged',
  ];
  check(
    '后端对照：task.thread 含派发、lead 消息、report、发现、门禁、提问、回答、合并',
    want.every((k) => entries.some((e) => e.kind === k)),
    result.daemon_kinds,
  );

  // 1. Tasks > Flow > the task's node > the drawer's Thread section.
  await page.click({ role: 'button', name: '项目看板', exact: true });
  await page.click({ role: 'radio', name: '任务', exact: true });
  await page.click({ role: 'radio', name: '流程图', exact: true });
  await page.click({ role: 'radio', name: '全部', exact: true });
  await poll(() =>
    page.evaluate(
      `[...document.querySelectorAll('[role="group"]')].some((el) => el.getAttribute('aria-label')?.startsWith(${JSON.stringify(`${TITLE}，`)}) && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0)`,
    ),
  );
  const threadJs = `(() => {
    const d = document.querySelector('aside.bd-drw');
    const sec = d?.querySelector('section[aria-labelledby="bd-th-h"]');
    if (!sec) return null;
    const list = sec.querySelector('ol.bd-tl');
    return {
      heading: sec.querySelector('h3')?.textContent ?? null,
      busy: !!sec.querySelector('[aria-busy=true]'),
      list: list?.getAttribute('aria-label') ?? null,
      jump: (() => { const b = sec.querySelector('button.bd-tl-blk'); return b ? { text: b.textContent.trim(), label: b.getAttribute('aria-label') } : null; })(),
      rows: [...(list?.querySelectorAll('li.bd-tl-i') ?? [])].map((li) => ({ id: li.id, kind: li.dataset.kind, label: li.querySelector('.bd-tl-n')?.textContent ?? null, text: li.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160), tab: li.getAttribute('tabindex') })),
    };
  })()`;
  await watch(
    `(() => { const t = ${threadJs}; return t ? (t.busy ? 'busy' : t.rows.length + '|' + (t.jump?.text ?? '')) : 'none'; })()`,
  );
  await page.click({ role: 'group', name: `${TITLE}，`, exact: false });
  // A note can still arrive after the merge: the list is compared with the thread read at the same moment.
  const shown = await poll(async () => {
    const now = await thread();
    const t = await page.evaluate(threadJs);
    if (!t || t.busy || t.rows.map((r) => r.kind).join() !== now.map((e) => e.kind).join())
      return null;
    entries = now;
    return t;
  }, 15_000);
  const t0 = shown || (await page.evaluate(threadJs));
  result.thread = t0;
  check('抽屉里有 "往来记录" 区', t0?.heading === '往来记录', t0);
  check(`列表名 "${TITLE} 的往来记录"`, t0?.list === `${TITLE} 的往来记录`, t0?.list);
  check(
    '行数等于 task.thread 的条数，顺序和种类一致',
    t0 && t0.rows.map((r) => r.kind).join() === entries.map((e) => e.kind).join(),
    {
      ui: t0?.rows.map((r) => r.kind),
      daemon: entries.map((e) => e.kind),
    },
  );
  const row = (kind) => t0?.rows.find((r) => r.kind === kind);
  check(
    'lead 消息行显示消息文字',
    row('lead_message')?.text.includes(LEAD_SAYS),
    row('lead_message'),
  );
  check(
    '提问行写 "提问" 和问题',
    row('question')?.label === '提问' && row('question').text.includes(Q),
    row('question'),
  );
  check('回答行写 "回答"', row('answer')?.label === '回答', row('answer'));
  check(
    '失败的门禁行列出失败命令 Unit tests',
    t0?.rows.some((r) => r.kind === 'gate' && r.text.includes('Unit tests')),
    t0?.rows.filter((r) => r.kind === 'gate'),
  );
  const findings = t0?.rows.filter((r) => r.kind === 'finding') ?? [];
  check(
    '两条 "审查发现"，阻塞那条带 "阻塞合并"，另一条不带',
    findings.length === 2 &&
      findings.filter((f) => f.text.includes('阻塞合并')).length === 1 &&
      findings.find((f) => f.text.includes(MAJOR))?.text.includes('阻塞合并'),
    findings,
  );
  check(
    '标题旁按钮 "1 个阻塞"，名字 "1 个阻塞合并的发现，跳到第一个"',
    t0?.jump?.text === '1 个阻塞' && t0.jump.label === '1 个阻塞合并的发现，跳到第一个',
    t0?.jump,
  );
  result.first_open_states = await states();
  result.shot = await page.screenshot(result.id);

  // 2. The blocking count moves focus to the first blocking finding.
  const target = entries.find((e) => e.kind === 'finding' && e.blocking);
  await page.click({ role: 'button', name: '1 个阻塞合并的发现，跳到第一个', exact: true });
  const focused = await poll(() => page.evaluate('document.activeElement?.id ?? null'));
  check(
    '点后焦点落在阻塞发现那一行(id 按 task.thread 的 event_id)',
    focused === `bd-th-${target?.event_id}`,
    { focused, want: `bd-th-${target?.event_id}` },
  );
  const minor = entries.find((e) => e.kind === 'finding' && !e.blocking);
  check('对照组：焦点不在不阻塞那条上', focused !== `bd-th-${minor?.event_id}`, focused);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
