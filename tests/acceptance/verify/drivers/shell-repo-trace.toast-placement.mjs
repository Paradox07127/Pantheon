import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 120_000,
});
const result = { id: 'shell-repo-trace.toast-placement', checks: [], rects: {} };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

const WAITING = `verify-toast-${Date.now()}`;

// A request shows as a toast only while another project is in view.
const view = await newProject(`${WAITING}-view`, { 'README.md': '# toast\n' });
// Leaves the new session page for an existing session of the project in view.
const AWAY = `${WAITING}-away`;
await call('session.create', {
  project_id: view.project_id,
  runtime: 'fixture',
  input: `${AWAY}\nfixture-script\n${JSON.stringify([{ say: 'ok' }])}`,
});
await poll(async () =>
  (await query('session.list', { project_id: view.project_id })).some((s) => s.title === AWAY),
);
await page.click({ role: 'button', name: `${AWAY}，fixture`, exact: false });

// A permission request in boot's project shows as a toast and counts in the title bar.
await call('session.create', {
  project_id: run.project_id,
  runtime: 'fixture',
  permission_mode: 'ask',
  input: `${WAITING}\nfixture-script\n${JSON.stringify([{ ask: { tool: 'Bash', input: { command: 'echo toast' } } }])}`,
});
const waiting = await poll(async () =>
  (await query('session.list', { project_id: run.project_id })).find(
    (s) => s.title === WAITING && s.waiting > 0,
  ),
);
check('前置：boot 项目里的会话在等权限', waiting, waiting?.id);

// Rectangles as drawn: the toast region holding the card and the needs-you popover.
const rects = () =>
  page.evaluate(`(() => {
    const box = (el) => {
      if (!el || !el.getClientRects().length) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    const stack = [...document.querySelectorAll('[aria-label="通知"]')].find((el) =>
      el.textContent.includes(${JSON.stringify(WAITING)}),
    );
    const pop = [...document.querySelectorAll('[aria-label^="等你的"]')].find((el) => el.getClientRects().length);
    return { width: innerWidth, height: innerHeight, stack: box(stack), pop: box(pop) };
  })()`);
const meets = (a, b) =>
  !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
// The stack's right and bottom edges 16px (--sp-4) in from the window's.
const atCorner = (r) =>
  !!r?.stack &&
  Math.abs(r.width - r.stack.right - 16) <= 1 &&
  Math.abs(r.height - r.stack.bottom - 16) <= 1;
// Waits until `ready` holds on two reads in a row with the stack in the same place, past its slide.
const settled = (ready, ms) => {
  let last = null;
  return poll(async () => {
    const r = await rects();
    const same = last && JSON.stringify(last) === JSON.stringify(r.stack);
    last = r.stack;
    return ready(r) && same && r;
  }, ms);
};

const rest = await settled((r) => atCorner(r) && !r.pop, 20_000);
const restNow = rest || (await rects());
result.rects.rest = restNow;
check('通知卡栈里有这张权限卡', restNow.stack, restNow);
check('弹层没打开时通知卡栈在右下角（右、下边距 16px）', atCorner(restNow), restNow);

// The title bar's needs-you popover: the stack moves to its left.
const trigger = (await names('件事等你')).find(
  (c) => c.role === 'button' && /^\d+ 件事等你$/.test(c.name),
);
check('前置：标题栏有 "N 件事等你" 按钮', trigger, trigger);
if (trigger) await page.click({ role: 'button', name: trigger.name, exact: true });
const popped = await settled((r) => r.pop && r.stack && r.stack.right <= r.pop.left);
const poppedNow = popped || (await rects());
result.rects.popover = poppedNow;
check(
  '标题栏弹层打开时通知卡栈和弹层不相交',
  poppedNow.pop && poppedNow.stack && !meets(poppedNow.stack, poppedNow.pop),
  poppedNow,
);
check(
  '通知卡栈在弹层左边',
  poppedNow.pop && poppedNow.stack && poppedNow.stack.right <= poppedNow.pop.left,
  poppedNow,
);
check('对照组：弹层打开时在右下角的读法判 false', !atCorner(poppedNow), poppedNow.stack);
check(
  '弹层打开时栈的下边距不变',
  poppedNow.stack && Math.abs(poppedNow.height - poppedNow.stack.bottom - 16) <= 1,
  poppedNow.stack,
);
result.shot = await page.screenshot(result.id);

await page.press('Escape');
const back = await settled((r) => !r.pop && atCorner(r));
result.rects.closed = back || (await rects());
check('关掉弹层后通知卡栈回到右下角', back, result.rects.closed.stack);

// Settle the request, so the toast does not stay for the drivers that run after this one.
// Requests other drivers left waiting have cards of their own; answer this one's card.
await page.click({
  role: 'button',
  name: '允许一次',
  exact: true,
  within: { role: 'alertdialog', name: WAITING, exact: false },
});
const answered = await poll(async () => {
  const s = (await query('session.list', { project_id: run.project_id })).find(
    (x) => x.title === WAITING,
  );
  return s && s.waiting === 0;
});
check('收尾：权限请求已处理', answered);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
