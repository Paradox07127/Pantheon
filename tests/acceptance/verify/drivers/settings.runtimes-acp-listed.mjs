import { open } from '../page.mjs';
const { page, query, call, errors, poll } = await open(process.argv[2], { ms: 120_000 });
const result = { id: 'settings.runtimes-acp-listed', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

// Display names as apps/web/src/components/RuntimeGlyph.tsx gives them; others show their id.
const NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'agy',
  grok: 'grok',
  dsh: 'DeepSeek',
  muse: 'Muse',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  kilo: 'Kilo Code',
  cline: 'Cline',
  qwen: 'Qwen Code',
  kimi: 'Kimi Code',
  goose: 'Goose',
  openhands: 'OpenHands',
  kiro: 'Kiro',
  junie: 'Junie',
  devin: 'Devin',
  vibe: 'Mistral Vibe',
  auggie: 'Augment',
  hermes: 'Hermes Agent',
  omp: 'omp',
  codebuddy: 'CodeBuddy',
  droid: 'Factory Droid',
  qoder: 'Qoder',
};
const nameOf = (runtime) => NAMES[runtime] ?? runtime;
const ACP = 'gemini';

// Starts with the ACP runtime off, on an executable that never answers the ACP initialize.
await call('runtime.config.set', { runtime: ACP, enabled: false, binary: '/usr/bin/false' });

// The runtime groups on the runtimes page, with the not-installed fold opened.
const groups = () =>
  page.evaluate(
    `[...document.querySelectorAll('.ps-grp[role=group]')].filter((el) => el.getClientRects().length).map((el) => el.getAttribute('aria-label'))`,
  );
const openPage = async () => {
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({
    role: 'button',
    name: '运行时',
    exact: true,
    within: { name: '设置分区', exact: true },
  });
  await poll(async () => (await groups()).length);
  const fold = await page.evaluate(
    `(() => { const b = [...document.querySelectorAll('button.hp-tg')].find((el) => el.getClientRects().length); return b ? b.getAttribute('aria-expanded') : null; })()`,
  );
  if (fold === 'false') await page.click({ role: 'button', name: '未安装', exact: false });
  return fold;
};
const closePage = () => page.click({ role: 'button', name: '关闭设置', exact: true });
const listed = (statuses) =>
  statuses
    .filter((s) => s.handshake !== false)
    .map((s) => nameOf(s.runtime))
    .sort();

// Before: the ACP runtime is off, carries no handshake, and is listed.
result.fold_before = await openPage();
const before = await query('runtime.status');
const offStatus = before.find((s) => s.runtime === ACP);
check(
  '前置：runtime.status 里关着的 ACP 运行时没有 handshake 字段',
  offStatus && !('handshake' in offStatus),
  offStatus,
);
const shownBefore = await poll(async () => {
  const g = await groups();
  return g.includes(nameOf(ACP)) && g;
});
check(`对照组：关着的 ${nameOf(ACP)} 在页面上能找到`, shownBefore, shownBefore || (await groups()));

// The user turns it on with its switch; the page reads runtime.status again after the change.
await page.click({ role: 'checkbox', name: `启用 ${nameOf(ACP)}`, exact: true });
let status = [];
let want = [];
const shown = await poll(async () => {
  status = await query('runtime.status');
  want = listed(status);
  const g = await groups();
  return (
    status.find((s) => s.runtime === ACP)?.enabled &&
    JSON.stringify([...g].sort()) === JSON.stringify(want) &&
    g
  );
}, 20_000);
const hidden = status.filter((s) => s.handshake === false).map((s) => s.runtime);
result.hidden = hidden;
result.acp = status.find((s) => s.runtime === ACP);
check(
  `前置：打开开关后 runtime.status 里 ${ACP} 已启用且 handshake === false`,
  result.acp?.enabled && result.acp.handshake === false,
  result.acp,
);
const now = shown || (await groups());
result.groups = now;
check(
  '每个 handshake === false 的运行时名都不在页面上（含 "未安装" 折叠区）',
  hidden.length > 0 && hidden.every((r) => !now.includes(nameOf(r))),
  { hidden: hidden.map(nameOf), shown: now },
);
check(
  '后端对照：页面列出的运行时正好是 runtime.status 里 handshake 不为 false 的那些',
  JSON.stringify([...now].sort()) === JSON.stringify(want),
  { ui: [...now].sort(), daemon: want },
);
// Claude is native and has no handshake; where it lands depends on whether this machine has it.
const claude = status.find((s) => s.runtime === 'claude');
const claudePlace = await page.evaluate(
  `(() => { const g = [...document.querySelectorAll('.ps-grp[role=group]')].find((el) => el.getAttribute('aria-label') === 'Claude' && el.getClientRects().length); return g ? (g.closest('.hp-fold') ? 'fold' : 'main') : null; })()`,
);
check(
  '对照组：Claude（原生，没有 handshake 字段）在页面上能找到，未安装时在 "未安装" 折叠区里',
  claude && !('handshake' in claude) && claudePlace === (claude.installed ? 'main' : 'fold'),
  { installed: claude?.installed, handshake: claude?.handshake, place: claudePlace },
);
result.shot = await page.screenshot(result.id);
await closePage();

// Leaves the ACP runtime off for the drivers after this one.
await call('runtime.config.set', { runtime: ACP, enabled: false });
const off = (await query('runtime.status')).find((s) => s.runtime === ACP);
check('收尾：ACP 运行时已关上', off && off.enabled === false, off?.enabled);

result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
