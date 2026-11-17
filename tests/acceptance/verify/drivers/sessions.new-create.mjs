import { setTimeout as delay } from 'node:timers/promises';
import { open } from '../page.mjs';
const { run, page, query, errors } = await open(process.argv[2]);
const result = { id: 'sessions.new-create', checks: [] };
// The fixture decodes the escapes; the user's message shows them raw, so only the reply holds this text.
const REPLY = '验证回复';
const escaped = [...REPLY]
  .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  .join('');
const TITLE = `verify-${Date.now()}`;
const input = `${TITLE}\nfixture-script\n[{"say":"${escaped}"}]`;

const before = await query('session.list', { project_id: run.project_id });
// The home screen's composer; a session already open shows its own, so go home first.
await page.click({ role: 'button', name: '新会话', exact: true });
await page.fill({ role: 'textbox', name: '新会话的第一条消息', exact: true }, input);
await page.click({ role: 'button', name: '开始⌘↵', exact: true });

let session, turns;
for (const until = Date.now() + 30_000; Date.now() < until; await delay(200)) {
  const sessions = await query('session.list', { project_id: run.project_id });
  session = sessions.find((s) => !before.some((b) => b.id === s.id));
  const board = await query('board', { project_id: run.project_id });
  turns = board.session_turns.filter((t) => t.session_id === session?.id);
  if (turns.length && turns.every((t) => !['queued', 'running'].includes(t.state))) break;
}
result.checks.push({ what: 'session.list 多了一个会话', ok: Boolean(session) });
result.checks.push({
  what: '这个会话的回合已完成',
  ok: turns.length > 0 && turns.every((t) => t.state === 'completed'),
  states: turns.map((t) => t.state),
});
await page.waitFor(
  `document.body.innerText.includes(${JSON.stringify(REPLY)})`,
  'the reply to show in the thread',
  Date.now() + 10_000,
);
result.checks.push({ what: '对话里显示回复文字', ok: true });
const sidebar = await page.evaluate(
  `[...document.querySelectorAll('nav a, nav button, [role="treeitem"], [role="listitem"]')].map((el) => el.textContent.trim())`,
);
result.checks.push({
  what: '对照组：侧栏没有不存在的标题',
  ok: !sidebar.some((text) => text.includes(TITLE + '-absent')),
});
result.checks.push({
  what: 'session.list 的 title 是首行',
  ok: session?.title === TITLE,
  title: session?.title,
});
result.checks.push({
  what: '侧栏有条目包含 session.list 的 title',
  ok: Boolean(session?.title) && sidebar.some((text) => text.includes(session.title)),
  title: session?.title,
});
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
