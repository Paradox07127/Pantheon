import { open } from '../page.mjs';
const { run, page, query, call, errors, poll, names } = await open(process.argv[2]);
const result = { id: 'sessions.request-permission', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const list = () => query('session.list', { project_id: run.project_id });
const buttons = async (part) =>
  (await names(part)).filter((c) => c.role === 'button').map((c) => c.name);
const alerts = () =>
  page.evaluate(`[...document.querySelectorAll('[role=alert]')].map((a) => a.textContent)`);

/** A fixture session waiting on one permission request, selected in the sidebar. */
async function waitingOn(title, ask) {
  await call('session.create', {
    project_id: run.project_id,
    runtime: 'fixture',
    input: `${title}\nfixture-script\n${JSON.stringify([{ ask }])}`,
  });
  const session = await poll(async () =>
    (await list()).find((s) => s.title === title && s.waiting > 0),
  );
  await page.click({ role: 'button', name: `${title}，fixture`, exact: false });
  return session;
}
const settled = (id) =>
  poll(async () => {
    const s = (await list()).find((x) => x.id === id);
    return (
      s?.waiting === 0 && s.last_turn && !['queued', 'running'].includes(s.last_turn.state) && s
    );
  }, 20_000);

// An ordinary tool request is allowed once from its card.
const bash = await waitingOn(`verify-bash-${Date.now()}`, {
  tool: 'Bash',
  input: { command: 'echo hi' },
});
check('daemon 有等待审批的 Bash 请求', bash, bash?.waiting);
const bashButtons = await poll(async () => {
  const found = await buttons('Bash');
  return found.some((n) => n.startsWith('允许一次')) && found;
});
check('Bash 请求卡有 允许一次', bashButtons, bashButtons);
await page.click({
  role: 'button',
  name: bashButtons.find((n) => n.startsWith('允许一次')),
  exact: true,
});
const bashDone = await settled(bash.id);
check(
  '允许后 waiting=0、回合 completed',
  bashDone?.last_turn?.state === 'completed',
  bashDone?.last_turn?.state,
);

// A question request whose questions could not be read can only be denied.
const askTitle = `verify-ask-${Date.now()}`;
const ask = await waitingOn(askTitle, {
  tool: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which?',
        header: 'Pick',
        options: [{ label: 'A', description: 'a' }],
        multiSelect: false,
      },
    ],
  },
});
check('daemon 有等待审批的 AskUserQuestion 请求', ask, ask?.waiting);
const askButtons = await poll(async () => {
  const found = await buttons('AskUserQuestion');
  return found.length > 0 && found;
});
check(
  '问题读不出的提问卡没有 允许 按钮',
  askButtons && !askButtons.some((n) => n.startsWith('允许')),
  askButtons,
);
check(
  '对照组：同一读法在 Bash 卡上读到过 允许',
  bashButtons && bashButtons.some((n) => n.startsWith('允许')),
);
const deny = askButtons && askButtons.find((n) => n.startsWith('拒绝'));
check('提问卡有 拒绝', deny, deny);
await page.click({ role: 'button', name: deny, exact: true });
const confirm = await poll(async () => (await buttons('确认拒绝'))[0]);
await page.click({ role: 'button', name: confirm, exact: true });
const askDone = await settled(ask.id);
check(
  '拒绝后 daemon waiting=0、回合结束',
  askDone,
  askDone && { waiting: askDone.waiting, turn: askDone.last_turn.state },
);
check('拒绝后没有报错 alert', (await alerts()).length === 0, await alerts());
const row = await poll(async () => {
  const label = (await buttons(`${askTitle}，fixture`))[0];
  return label && !label.includes('待批准') && label;
});
check('侧栏行不再带 待批准', row, row);
result.shot = await page.screenshot(result.id);
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
