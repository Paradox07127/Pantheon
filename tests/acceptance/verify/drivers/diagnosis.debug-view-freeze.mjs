import { openClient } from '../../lib/cdp.mjs';
import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, errors, poll, reset } = await open(process.argv[2]);
const result = { id: 'diagnosis.debug-view-freeze', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });

/** Emits `action` on the preload's pantheon:menu channel, as a click on a native menu item does (see diagnosis.user-style). */
async function sendMenuAction(action) {
  const list = await (await fetch(`http://127.0.0.1:${run.port}/json/list`)).json();
  const target = list.find(
    (e) => e.type === 'page' && e.url.startsWith('file:') && !e.url.includes('kind='),
  );
  const until = () => Date.now() + 10_000;
  const client = await openClient(target.webSocketDebuggerUrl, until());
  const contexts = [];
  client.onEvent(({ method, params }) => {
    if (method === 'Runtime.executionContextCreated') contexts.push(params.context);
  });
  const send = (method, params) => client.send(method, params, until());
  try {
    await send('Runtime.enable', {});
    const isolated = await poll(() => contexts.find((c) => c.auxData?.type === 'isolated'), 3000);
    if (!isolated) return { ok: false, why: 'no isolated world' };
    const proto = await send('Runtime.evaluate', {
      expression: 'Function.prototype',
      contextId: isolated.id,
    });
    const all = await send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
    const fn = await send('Runtime.callFunctionOn', {
      objectId: all.objects.objectId,
      functionDeclaration: `function () {
        return this.find((f) => {
          try { return Function.prototype.toString.call(f).includes('"pantheon:appInfo"'); }
          catch { return false; }
        });
      }`,
    });
    if (!fn.result.objectId) return { ok: false, why: 'preload appInfo not found' };
    const props = await send('Runtime.getProperties', {
      objectId: fn.result.objectId,
      ownProperties: true,
    });
    const scopes = props.internalProperties?.find((p) => p.name === '[[Scopes]]');
    const list2 = await send('Runtime.getProperties', {
      objectId: scopes.value.objectId,
      ownProperties: true,
    });
    for (const scope of list2.result) {
      if (!scope.value?.objectId) continue;
      const vars = await send('Runtime.getProperties', {
        objectId: scope.value.objectId,
        ownProperties: true,
      });
      const electron = vars.result.find((v) => v.name === 'electron');
      if (!electron?.value?.objectId) continue;
      const { result } = await send('Runtime.callFunctionOn', {
        objectId: electron.value.objectId,
        functionDeclaration: `function (action) { return this.ipcRenderer.emit('pantheon:menu', {}, action); }`,
        arguments: [{ value: action }],
        returnByValue: true,
      });
      return { ok: result.value === true, emitted: result.value ?? result.description };
    }
    return { ok: false, why: 'no electron in the preload closure' };
  } finally {
    client.close();
  }
}

// Raw mouse events at a point: page.click checks that the click lands on its target, and here it must not.
const move = (x, y) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const clickAt = async ({ x, y }) => {
  await move(x - 10, y - 10);
  await move(x, y);
  const mouse = { x, y, button: 'left', clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse });
};
const center = (selector) =>
  page.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
const viewOpen = () => page.evaluate(`!!document.querySelector('.dbv [role=application]')`);
const paletteOpen = () =>
  page.evaluate(`!!document.querySelector('[role=combobox][aria-label="搜索"]')`);
const shortcutsOpen = () =>
  page.evaluate(`[...document.querySelectorAll('[role=dialog]')].some((d) =>
    document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent === '快捷键')`);
const pickedCount = () =>
  page.evaluate(
    `Number(document.querySelector('.dbv-count')?.textContent.match(/\\d+/)?.[0] ?? -1)`,
  );
const playState = () =>
  page.evaluate(
    `getComputedStyle(document.querySelector('[data-debug-region="app.sidebar"]')).animationPlayState`,
  );
const tagText = () =>
  page.evaluate(`document.querySelector('.dbv-tag[role=status]')?.textContent || null`);
const pressedLevel = () =>
  page.evaluate(`document.querySelector('.dbv-lv button[aria-pressed=true]')?.textContent ?? null`);
// Stays false for the whole wait when nothing happens; returns early when it does.
const staysFalse = async (fn) => !(await poll(fn, 1500));

async function openView() {
  await page.click({ role: 'button', name: '搜索', exact: true });
  await page.fill({ role: 'combobox', name: '搜索', exact: true }, '调试视图');
  await page.click({ role: 'option', name: '调试视图', exact: false });
  await page.waitFor(
    `!!document.querySelector('.dbv [role=application]')`,
    'the debug view overlay to open',
  );
}

await reset();
const search = await center('button[aria-label="搜索"]');
// A point in the sidebar below the title bar, outside its nested regions.
const side = await page.evaluate(`(() => {
  const r = document.querySelector('[data-debug-region="app.sidebar"]').getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  for (let y = Math.round(r.top) + 120; y < r.bottom; y += 8) {
    const under = document.elementFromPoint(x, y);
    if (under?.closest('[data-debug-region]')?.getAttribute('data-debug-region') === 'app.sidebar')
      return { x, y };
  }
  return null;
})()`);
result.points = { search, side };

await openView();
check('调试视图打开后 app 动画暂停', (await playState()) === 'paused', await playState());

// Title-bar Search button: opens the palette normally.
await clickAt(search);
check('打开时点标题栏 搜索 不打开命令面板', await staysFalse(paletteOpen));
check(
  '打开时点标题栏 搜索 变成一次选中',
  await poll(async () => (await pickedCount()) === 1),
  await pickedCount(),
);

// ? opens the shortcuts dialog normally.
result.focusBeforeKey = await page.evaluate(
  `document.activeElement?.className || document.activeElement?.tagName`,
);
await page.press('?', ['Shift']);
check('打开时按 ? 不打开快捷键对话框', await staysFalse(shortcutsOpen));
check('按 ? 之后调试视图仍开着', await viewOpen());

// Alt drills in from the region; Enter picks what is under the pointer.
await move(side.x - 20, side.y - 20);
await move(side.x, side.y);
const tagBefore = await poll(async () => ((await tagText())?.includes('侧栏') ? tagText() : null));
const levelBefore = await pressedLevel();
// page.press has no Alt; these are the events a bare Option press sends.
const alt = { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 };
await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...alt });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...alt, modifiers: 0 });
const levelAfter = await poll(async () => {
  const now = await pressedLevel();
  return now !== levelBefore ? now : null;
}, 3000);
check('悬停侧栏后按 ⌥ 往里一层', levelBefore === '区域' && levelAfter && levelAfter !== '区域', {
  tagBefore,
  levelBefore,
  levelAfter,
  tagAfter: await tagText(),
});
await page.press('Enter');
check(
  '按 Enter 选中悬停项',
  await poll(async () => (await pickedCount()) === 2),
  await pickedCount(),
);

// Real key presses into the inspector's request box.
const inspector = { name: '检查面板', exact: true };
const request = { role: 'textbox', name: '你想改什么或修什么？', exact: true, within: inspector };
if (!(await page.evaluate(`!!document.querySelector('.dbv-ins')`)))
  await page.click({ role: 'button', name: '发送', exact: true });
await page.click(request);
for (const key of ['x', 'y', '?']) await page.press(key, key === '?' ? ['Shift'] : []);
const typed = await page.evaluate(
  `document.querySelector('.dbv textarea[aria-label="你想改什么或修什么？"]')?.value ?? null`,
);
check('检查面板的输入框能逐键输入', typed === 'xy?', typed);
check('在输入框里打 ? 也不打开快捷键对话框', !(await shortcutsOpen()));

// Escape closes the inspector, then the view.
await page.press('Escape');
const afterOne = {
  view: await viewOpen(),
  inspector: await page.evaluate(`!!document.querySelector('.dbv-ins')`),
};
if (afterOne.view) await page.press('Escape');
const closed = await poll(async () => !(await viewOpen()), 3000);
check('Esc 关掉检查面板，再按 Esc 退出调试视图', closed && afterOne.inspector === false, afterOne);

// Control: once the view is closed the same click and key reach the app again.
check('对照组：关闭后动画恢复', (await playState()) === 'running', await playState());
await clickAt(search);
check('对照组：关闭后点同一个 搜索 打开命令面板', await poll(paletteOpen, 3000));
await reset();
await page.evaluate('document.activeElement?.blur()');
await page.press('?', ['Shift']);
check('对照组：关闭后按 ? 打开快捷键对话框', await poll(shortcutsOpen, 3000));
await reset();

// An open menu: the view opens over it (Help menu action) and still picks inside it.
// Off the Search button: it keeps focus after Escape closed the palette, and its tooltip covers the project switcher.
// Focus returns to the button after the sheet's exit animation, so blur only once the scrims are gone.
await page.waitFor(
  `!document.querySelector('.pj-scrim, .cmdk-scrim')`,
  'the sheet to finish closing',
);
await page.evaluate('document.activeElement?.blur()');
await move(side.x, side.y);
await page.waitFor(
  `(() => {
    const b = document.querySelector('button[aria-label="切换项目"]').getBoundingClientRect();
    return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('button[aria-label="切换项目"]');
  })()`,
  'the Search tooltip to leave the project switcher',
);
await page.click({ role: 'button', name: '切换项目', exact: true });
await page.waitFor(`!!document.querySelector('[role=menu]')`, 'the project menu to open');
const item = await page.evaluate(`(() => {
  const el = [...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.textContent.includes('项目设置'));
  if (!el) return null;
  // The item is below the fold when the menu lists many projects.
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
result.menuAction = await sendMenuAction('debug-view');
const overMenu = await poll(viewOpen, 3000);
check('菜单开着时经帮助菜单动作打开调试视图', overMenu && result.menuAction.ok, result.menuAction);
check('调试视图打开后菜单仍开着', await page.evaluate(`!!document.querySelector('[role=menu]')`));
result.bodyPointerEvents = await page.evaluate(`getComputedStyle(document.body).pointerEvents`);
check(
  '调试视图打开时 body 的 pointer-events 为 auto',
  result.bodyPointerEvents === 'auto',
  result.bodyPointerEvents,
);
if (item) await clickAt(item);
const inMenu = await poll(() =>
  page.evaluate(
    // The inspector names the picked component; the menu has no region, so the pick is MenuItemPlain.
    `(document.querySelector('.dbv-ins .dbv-it')?.textContent ?? '').includes('MenuItem') || null`,
  ),
);
check('在菜单里点 项目设置 选中了它', item && inMenu, {
  item,
  ins: await page.evaluate(`document.querySelector('.dbv-ins')?.textContent.slice(0, 200) ?? null`),
  // What the pointer hits at the item, top first; the view's hit layer must come before the menu.
  under: item
    ? await page.evaluate(`document.elementsFromPoint(${item.x}, ${item.y}).slice(0, 5)
        .map((e) => [e.tagName, e.className, e.getAttribute('role')].filter(Boolean).join(' '))`)
    : null,
});
// The settings page stays in the DOM once opened; only a visible close button means it is open.
const settingsShown = () =>
  page.evaluate(
    `(() => { const b = document.querySelector('button[aria-label="关闭设置"]'); return !!b && b.getClientRects().length > 0; })()`,
  );
check('点菜单项没有打开项目设置', await staysFalse(settingsShown));

result.shot = await page.screenshot(result.id);
await reset();
// Control: with the view closed, the same menu item opens the settings page.
// Closing the view leaves the menu as it was, open; a click on its button would close it.
check(
  '关闭调试视图后菜单仍开着',
  await page.evaluate(
    `document.querySelector('button[aria-label="切换项目"]')?.getAttribute('aria-expanded') === 'true'`,
  ),
);
if (!(await page.evaluate(`!!document.querySelector('[role=menu]')`)))
  await page.click({ role: 'button', name: '切换项目', exact: true });
await page.waitFor(`!!document.querySelector('[role=menu]')`, 'the project menu to open');
await page.evaluate(
  `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((e) => e.textContent.includes('项目设置'))?.scrollIntoView({ block: 'center' })`,
);
await page.click({ role: 'menuitem', name: '项目设置', exact: true });
check('对照组：关闭后点同一个 项目设置 打开设置页', await poll(settingsShown, 3000));
await reset();
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
