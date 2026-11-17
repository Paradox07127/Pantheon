import { setTimeout as delay } from 'node:timers/promises';
import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, query, call, errors } = await open(process.argv[2]);
const result = { id: 'sessions.sidebar-session-row', checks: [] };
const stamp = Date.now();
const OK = `verify-ok-${stamp}`,
  BAD = `verify-fail-${stamp}`;
await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  input: `${OK}\nfixture-script\n[{"say":"\\u5b8c\\u6210"}]`,
});
await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  input: `${BAD}\nfixture-script\n[{"fail":"verify boom"}]`,
});
let list = [];
for (const until = Date.now() + 30_000; Date.now() < until; await delay(200)) {
  list = (await query('session.list', { project_id: run.project_id })).filter(
    (s) => s.title === OK || s.title === BAD,
  );
  // Decided on the same read the checks use, so a turn ending between two reads cannot slip in.
  if (
    list.length === 2 &&
    list.every((s) => s.last_turn && !['queued', 'running'].includes(s.last_turn.state))
  )
    break;
}
const ok = list.find((s) => s.title === OK),
  bad = list.find((s) => s.title === BAD);
result.daemon = list.map((s) => ({
  title: s.title,
  state: s.state,
  last_turn: s.last_turn?.state,
}));
const rowName = (id) =>
  page.evaluate(
    `document.querySelector('[data-session="${id}"]')?.getAttribute('aria-label') ?? null`,
  );
let okName, badName;
for (const until = Date.now() + 10_000; Date.now() < until; await delay(200)) {
  okName = await rowName(ok?.id);
  badName = await rowName(bad?.id);
  if (okName && badName && badName.includes('上回合失败') === (bad.last_turn?.state === 'failed'))
    break;
}
result.rows = { okName, badName };
result.checks.push({
  what: '两条会话都在侧栏，名字以 session.list 的 title 开头',
  ok: !!okName?.startsWith(OK) && !!badName?.startsWith(BAD),
});
result.checks.push({
  what: '失败会话的 last_turn.state=failed 在行上显示 上回合失败',
  ok: bad?.last_turn?.state === 'failed' && !!badName?.includes('上回合失败'),
  got: bad?.last_turn?.state,
});
result.checks.push({
  what: '成功会话的行不带 上回合失败',
  ok: !!okName && !okName.includes('上回合失败'),
});
await page.click({ role: 'button', name: OK, exact: false });
await page.waitFor(
  `document.querySelector('[data-session="${ok.id}"]')?.getAttribute('aria-current') === 'true'`,
  'the clicked row to be current',
);
const header = await page.evaluate(
  `document.querySelector('main')?.innerText.includes(${JSON.stringify(OK)}) ?? document.body.innerText.split(${JSON.stringify(OK)}).length > 2`,
);
result.checks.push({ what: '点击后行高亮(aria-current)且主区显示该会话标题', ok: header === true });
result.shot = await page.screenshot(result.id);
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
