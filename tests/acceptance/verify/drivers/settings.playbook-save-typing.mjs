import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { open } from '../page.mjs';
const { page, call, errors, poll, names, newProject } = await open(process.argv[2], {
  ms: 300_000,
});
const result = { id: 'settings.playbook-save-typing', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

/**
 * Holds the bridge's answer to the next playbook.set for `ms`: a conditional breakpoint in the
 * renderer's runCommand swaps its local bridge for one that waits before it hands the result back.
 */
async function holdNextSave(ms) {
  const assets = fileURLToPath(
    new URL('../../../../apps/desktop/out/renderer/assets/', import.meta.url),
  );
  const file = readdirSync(assets)
    .filter((f) => f.endsWith('.js'))
    .find((f) => readFileSync(path.join(assets, f), 'utf8').includes('async function runCommand('));
  const text = readFileSync(path.join(assets, file), 'utf8');
  const head = /async function runCommand\((\w+),\w+,\w+\)\{let (\w+)=window\.pantheon;/.exec(text);
  const at = head.index + head[0].length;
  const lines = text.slice(0, at).split('\n');
  const [type, bridge] = [head[1], head[2]];
  const condition = `${type} === 'playbook.set' && !window.__verifyHeld && ((window.__verifyHeld = Date.now()), (${bridge} = { command: (c) => new Promise((resolve) => setTimeout(() => window.pantheon.command(c).then((v) => { window.__verifyReleased = Date.now(); resolve(v); }), ${ms})) }), false)`;
  await page.send('Debugger.enable');
  const { breakpointId, locations } = await page.send('Debugger.setBreakpointByUrl', {
    urlRegex: `${file.replace(/[.]/g, '\\.')}$`,
    lineNumber: lines.length - 1,
    columnNumber: lines.at(-1).length,
    condition,
  });
  return { file, breakpointId, locations: locations.length };
}

try {
  const stamp = Date.now();
  const NAME = `verify-playbook-typing-${stamp}`;
  const { project_id } = await newProject(NAME, {
    'README.md': '# playbook typing\n',
    'src/index.ts': 'export const answer = 42;\n',
    'package.json': '{ "name": "playbook-typing-fixture", "private": true }\n',
  });
  const before = await call('playbook.get', { project_id });
  await page.evaluate('delete window.__verifyHeld; delete window.__verifyReleased; true');
  const hold = await holdNextSave(3000);
  result.hold = hold;
  check('前置：断点落在 runCommand 里', hold.locations === 1, hold);

  // Settings > Projects > the project > its playbook.
  await page.click({ role: 'button', name: '设置', exact: true });
  await page.click({ role: 'button', name: '项目', exact: true });
  if ((await names('所有项目')).some((n) => n.role === 'button'))
    await page.click({ role: 'button', name: '所有项目', exact: true });
  await page.click({ role: 'button', name: NAME, exact: false });
  const BOX = '默认打法：计划之前';
  const boxJs = `(() => { const t = [...document.querySelectorAll('textarea')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(BOX)} && el.getClientRects().length); return t ? { value: t.value, disabled: t.disabled, readOnly: t.readOnly } : null; })()`;
  await poll(async () => (await page.evaluate(boxJs))?.value);
  const ADDED = `Check the open questions first ${stamp}.`;
  const LATER = ` Then list the risks ${stamp}.`;
  const edited = `${before.sections.before_you_plan}\n${ADDED}`;
  await page.fill({ role: 'textbox', name: BOX, exact: true }, edited);
  await page.click({ role: 'button', name: '存为新版本', exact: true });
  const held = await poll(() => page.evaluate('window.__verifyHeld ?? null'), 3000);
  check('前置：这次保存的响应被扣住', held, held);
  // Typing goes on at the end of the text while the save is out.
  const during = await page.evaluate(boxJs);
  result.during = { disabled: during?.disabled, readOnly: during?.readOnly };
  await page.evaluate(
    `(() => { const t = [...document.querySelectorAll('textarea')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(BOX)}); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return true; })()`,
  );
  await page.send('Input.insertText', { text: LATER });
  const typed = await page.evaluate(boxJs);
  const released = await page.evaluate('window.__verifyReleased ?? null');
  check('后输入的文字在保存返回前进了输入框', typed?.value === edited + LATER && !released, {
    tail: typed?.value.slice(-90),
    released,
  });
  const saved = await poll(async () => {
    const r = await call('playbook.get', { project_id });
    return r.version === before.version + 1 && r;
  }, 15_000);
  const back = await poll(() => page.evaluate('window.__verifyReleased ?? null'), 8000);
  check('前置：保存成功，playbook.get 的 version 加一', saved, saved?.version);
  check(
    '后端对照：存下的是点保存那一刻的正文(不含后输入的文字)',
    saved?.sections.before_you_plan === edited,
    saved?.sections.before_you_plan.slice(-90),
  );
  // After the answer lands, the box keeps what was typed after the save.
  const after = await poll(async () => {
    const b = await page.evaluate(boxJs);
    return back && b && Date.now() - back > 1000 && b;
  }, 8000);
  result.after_tail = after?.value.slice(-120);
  check('保存成功后后输入的文字仍在输入框里', after?.value === edited + LATER, result.after_tail);
  check('对照组：输入框不是只剩存下的正文', after?.value !== edited, result.after_tail);
  result.shot = await page.screenshot(result.id);
} catch (error) {
  check('驱动走完全部步骤', false, error.message.slice(0, 1200));
}
await page.send('Debugger.disable').catch(() => {});
result.errors = await errors();
console.log(JSON.stringify(result, null, 2));
page.close();
