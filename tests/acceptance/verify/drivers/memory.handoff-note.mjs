import { open } from '../page.mjs';
const { page, query, call, errors, poll, newProject } = await open(process.argv[2]);
const result = { id: 'memory.handoff-note', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const stamp = Date.now();
const { project_id } = await newProject(`verify-handoff-${stamp}`);
const board = () => query('board', { project_id });
const projectRow = async () => (await board()).projects.find((p) => p.id === project_id);
await call(
  'project.sessionDefaults.set',
  { project_id, runtime: 'fixture', permission_mode: 'auto_edit' },
  (await projectRow()).revision,
);
const old = (await call('resident.open', { project_id, kind: 'assistant' })).id;
const oldRow = (await query('session.list', { project_id })).find((s) => s.id === old);
const agentId = oldRow?.resident?.agent_id;
const KEY = `handoff/${agentId}`;
// The title the handoff turn tells the agent to use (resident.ts handoffText).
const TITLE = `Handoff from ${oldRow?.title}`;
const NOTE_TEXT = `The user wants a weekly export summary ${stamp}.`;
const ended = (turn) => !['queued', 'running'].includes(turn.state);

// The agent writes the handoff note in the turn that crosses 80%; a model reads memory_context
// for based_on first, which a script cannot, so it is read here.
const { signature } = await call('memory.context', { project_id });
const steps = [
  {
    tool: {
      name: 'memory_propose',
      arguments: {
        project_id,
        key: KEY,
        kind: 'note',
        title: TITLE,
        tags: ['handoff'],
        text: NOTE_TEXT,
        based_on: signature,
      },
    },
  },
  { say: `Noted ${stamp}` },
  { usage: { context_tokens: 90_000, context_window: 100_000 } },
];
await call(
  'session.send',
  { session_id: old, input: `fixture-script\n${JSON.stringify(steps)}` },
  (await board()).sessions.find((s) => s.id === old).revision,
);
const settled = await poll(async () => {
  const b = await board();
  const next = b.sessions.find(
    (s) => s.resident?.agent_id === agentId && s.id !== old && s.state !== 'closed',
  );
  const nextTurns = next ? b.session_turns.filter((t) => t.session_id === next.id) : [];
  return b.sessions.find((s) => s.id === old)?.state === 'closed' &&
    nextTurns.length > 0 &&
    nextTurns.every(ended)
    ? { next, first: nextTurns[0] }
    : false;
}, 60_000);
check('旧会话关闭，新会话的第一轮结束', settled, settled && settled.next.id);

// Backend: the note is a current project note keyed handoff/<agent id>, written by the old session.
const read = await query('memory.read', { project_id, state: 'active', tag: 'handoff' });
const note = read.records.find((i) => i.key === KEY);
result.note = note && {
  id: note.id,
  key: note.key,
  kind: note.kind,
  state: note.state,
  title: note.title,
  author_session_id: note.author_session_id,
  tags: note.tags,
};
check(
  'memory.read 有 key=handoff/<agent id> 的当前 note，标题 Handoff from …，标签 handoff，作者是旧会话',
  note?.kind === 'note' &&
    note.state === 'active' &&
    note.title === TITLE &&
    note.tags?.includes('handoff') &&
    note.author_session_id === old,
  result.note,
);
const absent = await query('memory.read', { project_id, state: 'all', q: `absent-${stamp}` });
check(
  '对照组：memory.read 搜不存在的词没有结果',
  absent.records.length === 0,
  absent.records.length,
);

if (settled && note) {
  const { next, first } = settled;
  const packet = await query('memory.turn', { session_id: next.id, turn_id: first.id });
  result.packet = packet.items;
  check(
    'memory.turn：新会话第一轮的记忆 packet 有这条交接笔记',
    packet.items.some((i) => i.id === note.id),
    packet.items,
  );

  // The memory screen's entry list.
  await page.click({ role: 'button', name: '记忆', exact: true });
  await page.click({ role: 'tab', name: '条目', exact: true });
  const option = await poll(() =>
    page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[role=option]')].map((o) => o.innerText.replace(/\\s+/g, ' ').trim());
      return rows.find((r) => r.includes(${JSON.stringify(TITLE)})) ? rows : null;
    })()`),
  );
  result.entries = option;
  check('条目列表有 Handoff from … 一行', option, option);
  check(
    '对照组：条目列表没有不存在的标题',
    option && !option.some((r) => r.includes(`Handoff from absent-${stamp}`)),
  );
  if (option) {
    await page.click({ role: 'option', name: TITLE, exact: false });
    const detail = await poll(() =>
      page.evaluate(`(() => {
        const d = document.querySelector('aside[aria-label="记忆详情"]');
        return d && d.innerText.includes(${JSON.stringify(KEY)}) ? d.innerText.replace(/\\s+/g, ' ').slice(0, 800) : null;
      })()`),
    );
    result.detail = detail;
    check('详情显示 key handoff/<agent id>', detail, detail);
  }

  // The thread's memory row for the new session's first turn.
  await page.click({
    role: 'button',
    name: '助理，',
    exact: false,
    within: { role: 'group', name: '常驻智能体', exact: true },
  });
  await page.click({ role: 'button', name: '用了 1 条记忆', exact: false });
  const used = await poll(() =>
    page.evaluate(`(() => {
      const main = document.querySelector('main')?.innerText ?? '';
      return main.includes(${JSON.stringify(TITLE)}) ? main.slice(0, 1500) : null;
    })()`),
  );
  result.used = used;
  check('新会话第一轮的 用了 1 条记忆 展开后列出交接笔记', used, used);

  // The memory screen's project-wide preview of what agents get.
  await page.click({ role: 'button', name: '记忆', exact: true });
  await page.click({ role: 'tab', name: '总览', exact: true });
  await page.click({ role: 'button', name: '看完整内容', exact: true });
  const preview = await poll(() =>
    page.evaluate(`(() => {
      const d = document.querySelector('.acx-dlg');
      if (!d) return null;
      const notes = d.querySelector('section[aria-label="笔记"]');
      return {
        title: d.querySelector('.acx-dt')?.textContent ?? null,
        notes: notes ? [...notes.querySelectorAll('.acx-it')].map((i) => i.innerText.replace(/\\s+/g, ' ')) : [],
      };
    })()`),
  );
  result.preview = preview;
  check(
    '项目整体正文预览的 笔记 组有交接笔记的标题和正文',
    preview?.notes.some((n) => n.includes(TITLE) && n.includes(NOTE_TEXT)),
    preview,
  );
  check(
    '对照组：预览里没有不存在的标题',
    preview && !preview.notes.some((n) => n.includes(`Handoff from absent-${stamp}`)),
  );
  const context = await call('memory.context', { project_id });
  check(
    '后端对照：memory.context 的 items 有这条笔记',
    context.items.some((i) => i.id === note.id),
    context.items.map((i) => i.key),
  );
  result.shot = await page.screenshot(result.id);
  await page.press('Escape');
}

result.shot ??= await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
