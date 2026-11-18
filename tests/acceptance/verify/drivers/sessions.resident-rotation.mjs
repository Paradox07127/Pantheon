import { open } from '../page.mjs';
const { page, query, call, errors, poll, names, newProject } = await open(process.argv[2]);
const result = { id: 'sessions.resident-rotation', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-rotation-${stamp}`);
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const startCursor = (await query('events', { project_id, limit: 1 })).cursor;
const old = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const agentId = (await query('session.list', { project_id })).find((s) => s.id === old)?.resident
  ?.agent_id;
const KEY = `handoff/${agentId}`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);
const send = async (steps) =>
  call(
    'session.send',
    { session_id: old, input: `fixture-script\n${JSON.stringify(steps)}` },
    (await board()).sessions.find((s) => s.id === old).revision,
  );

// Control: a turn that ends at 79% of the context window queues no handoff turn.
await send([{ say: 'Below' }, { usage: { context_tokens: 79_000, context_window: 100_000 } }]);
const below = await poll(async () => {
  const b = await board();
  const turns = b.session_turns.filter((t) => t.session_id === old);
  return turns.length >= 1 && turns.every(ended) ? b : false;
}, 30_000);
// A handoff turn would be queued as the turn ends; give the daemon a moment to show one.
const quiet = await poll(async () => {
  const b = await board();
  return b.session_turns.some((t) => t.session_id === old && t.origin === 'tracker') ? b : false;
}, 3_000);
const belowSessions = (await query('session.list', { project_id })).filter(
  (s) => s.resident?.agent_id === agentId,
);
result.below = {
  usage: below && below.sessions.find((s) => s.id === old)?.usage,
  tracker: !!quiet,
  residents: belowSessions.map((s) => ({ id: s.id, state: s.state })),
};
check(
  '对照组：79% 的回合结束后没有交接回合，旧会话仍开着，只有一个常驻会话',
  below && !quiet && belowSessions.length === 1 && belowSessions[0].state !== 'closed',
  result.below,
);

// Over: the agent writes the handoff note with memory_propose in the turn that crosses 80%.
const NOTE_TEXT = `The user wants a weekly export summary ${stamp}.`;
const REPLY = `Noted ${stamp}`;
// A model reads memory_context first and passes its signature; the script cannot, so it is read here.
const { signature } = await call('memory.context', { project_id });
await send([
  {
    tool: {
      name: 'memory_propose',
      arguments: {
        project_id,
        key: KEY,
        kind: 'note',
        title: `Handoff from verify ${stamp}`,
        tags: ['handoff'],
        text: NOTE_TEXT,
        based_on: signature,
      },
    },
  },
  { say: REPLY },
  { usage: { context_tokens: 90_000, context_window: 100_000 } },
]);
const settled = await poll(async () => {
  const b = await board();
  const next = b.sessions.find(
    (s) => s.resident?.agent_id === agentId && s.id !== old && s.state !== 'closed',
  );
  const oldRow = b.sessions.find((s) => s.id === old);
  const nextTurns = next ? b.session_turns.filter((t) => t.session_id === next.id) : [];
  return oldRow?.state === 'closed' && next && nextTurns.length > 0 && nextTurns.every(ended)
    ? { b, next }
    : false;
}, 60_000);
const last = settled ? settled.b : await board();
const oldTurns = last.session_turns.filter((t) => t.session_id === old);
const flush = oldTurns.filter((t) => t.origin === 'tracker');
result.daemon = {
  old_turns: oldTurns.map((t) => ({ origin: t.origin ?? null, state: t.state })),
  old_state: last.sessions.find((s) => s.id === old)?.state,
  next: settled && { id: settled.next.id, state: settled.next.state },
};
check('旧会话关闭，同一 agent 开了新会话且回合结束', settled, result.daemon);
check(
  '旧会话只有一个 origin=tracker 的交接回合，要它用 memory_propose 写 handoff/<agent id>',
  flush.length === 1 && flush[0].input.includes('memory_propose') && flush[0].input.includes(KEY),
  flush.map((t) => t.input.slice(0, 300)),
);
const events = (await query('events', { project_id, after: startCursor, limit: 2000 })).events;
const closedEvent = events.find((e) => e.kind === 'session.closed' && e.aggregate_id === old);
result.closed = closedEvent?.payload;
check(
  'session.closed 的原因是 context_full',
  closedEvent?.payload?.reason === 'context_full',
  result.closed,
);
const messages = events.filter((e) => e.kind === 'agent_message.created');
const flushEnd = events.find((e) => e.kind === 'turn.completed' && e.aggregate_id === flush[0]?.id);
check(
  '交接回合没有发系统通知：没有 agent_message.created，它的 turn.completed 属于 tracker 回合（notifications.ts:346 不发）',
  messages.length === 0 && flushEnd && flush[0]?.origin === 'tracker',
  { agent_messages: messages.length, flush_completed: !!flushEnd },
);
const needs = (await query('needs_you.list', { project_id })).items;
check(
  'needs_you.list 没有新条目',
  needs.length === 0,
  needs.map((i) => i.kind),
);

if (settled) {
  const next = settled.next.id;
  const list = await query('session.list', { project_id });
  const oldListed = list.find((s) => s.id === old);
  const nextListed = list.find((s) => s.id === next);
  result.list = {
    old: oldListed && { state: oldListed.state, agent_id: oldListed.resident?.agent_id },
    next: nextListed && { state: nextListed.state, agent_id: nextListed.resident?.agent_id },
  };
  // session.list names a closed resident done and an open idle one idle (workbench-session.ts:887).
  check(
    'session.list：旧会话 done（已关闭），新会话 idle（开着），resident.agent_id 相同',
    oldListed?.state === 'done' &&
      nextListed?.state === 'idle' &&
      nextListed.resident?.agent_id === agentId &&
      oldListed.resident?.agent_id === agentId,
    result.list,
  );
  const [first] = last.session_turns.filter((t) => t.session_id === next);
  result.takeover = first?.input;
  check(
    '新会话第一轮的输入写出旧会话 id 和 handoff/<agent id>',
    first?.input.includes(old) && first.input.includes(KEY),
    first?.input,
  );
  check(
    '对照组：第一轮输入里没有别的 key',
    first && !first.input.includes(`handoff/absent-${stamp}`),
  );

  // The sidebar's Assistant row opens the new session.
  const RESIDENTS = { role: 'group', name: '本项目', exact: true };
  await page.click({ role: 'button', name: '助理，', exact: false, within: RESIDENTS });
  const shown = await poll(() =>
    page.evaluate(`(() => {
      const row = document.querySelector('.ss-rr[aria-current="true"]');
      const evs = [...document.querySelectorAll('button.ss-ev')].map((b) => ({
        name: b.textContent.trim(), expanded: b.getAttribute('aria-expanded') }));
      const main = document.querySelector('main')?.innerText ?? '';
      return row && evs.length ? { row: row.getAttribute('aria-label'), evs, main: main.slice(0, 1200),
        hasOld: main.includes('fixture-script'), noted: main.includes('Noted') } : null;
    })()`),
  );
  result.sidebar = shown;
  check(
    '侧栏 助理 行打开的是新会话：一个折叠的事件行，没有旧会话的 fixture 消息',
    shown?.row?.startsWith('助理') && shown.evs.length === 1 && !shown.hasOld && !shown.noted,
    shown,
  );

  // The old session is not in the sidebar (Sidebar.tsx:632 keeps each agent's newest); a user finds it
  // by searching its messages in the command palette.
  await page.click({ role: 'button', name: '搜索', exact: true });
  await page.fill({ role: 'combobox', name: '搜索', exact: false }, REPLY);
  const hit = await poll(async () => (await names(REPLY)).find((n) => n.role === 'option') ?? null);
  result.paletteHit = hit;
  check('命令面板按旧会话的回复搜得到旧会话', hit, await names(REPLY));
  if (hit) {
    await page.click({ role: 'option', name: hit.name, exact: true });
    const thread = await poll(() =>
      page.evaluate(`(() => {
        const main = document.querySelector('main')?.innerText ?? '';
        if (!main.includes(${JSON.stringify(REPLY)})) return null;
        const composer = document.querySelector('main textarea, main [contenteditable="true"]');
        return {
          current: document.querySelector('.ss-rr[aria-current="true"]')?.getAttribute('aria-label') ?? null,
          evs: [...document.querySelectorAll('button.ss-ev')].map((b) => ({
            name: b.textContent.trim(), expanded: b.getAttribute('aria-expanded') })),
          composer: composer && { placeholder: composer.getAttribute('placeholder'),
            disabled: composer.disabled ?? composer.getAttribute('aria-disabled') },
          main: main.slice(0, 2500),
        };
      })()`),
    );
    result.oldThread = thread;
    const handoffRows = thread?.evs.filter((e) => e.name.startsWith('Worker 报告')) ?? [];
    check(
      '旧会话线程里交接回合折叠成一行，aria-expanded=false',
      handoffRows.length === 1 && handoffRows[0].expanded === 'false',
      thread?.evs,
    );
    check(
      '对照组：旧会话线程里没有新会话的 计划已同步 行',
      thread && !thread.evs.some((e) => e.name.startsWith('计划已同步')),
      thread?.evs,
    );
    result.oldShot = await page.screenshot(`${result.id}-old`);
  }
}

result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
