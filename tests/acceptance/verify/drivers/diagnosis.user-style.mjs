import { openClient } from '../../lib/cdp.mjs';
import { open } from '../page.mjs';
const t0 = Date.now();
const { run, page, query, call, errors, poll, reset } = await open(process.argv[2]);

/**
 * Emits `action` on the preload's ipcRenderer channel pantheon:menu, as the main process does when a
 * menu item is clicked; reaches the preload's `electron` through the closure of its appInfo function.
 */
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
const result = { id: 'diagnosis.user-style', checks: [] };
const check = (what, ok, got) => result.checks.push({ what, ok: Boolean(ok), got });
const CSS = '[data-debug-region="app.sidebar"]{outline:2px solid red}';
const shown = () =>
  page.evaluate(`(() => {
    const all = document.querySelectorAll('#pt-user-style');
    const style = all[0];
    return { count: all.length, last: !!style && document.head.lastElementChild === style,
      inHead: !!style && style.parentElement === document.head, text: style?.textContent ?? null };
  })()`);

// Control group: no stylesheet, no style element.
await call('style.clear', {});
await call('style.enable', { enabled: true });
const none = await poll(async () => {
  const s = await shown();
  return s.count === 0 ? s : null;
});
check('对照组：style.clear 后页面没有 #pt-user-style', none?.count === 0, none);

await call('style.set', { css: CSS });
const set = await poll(async () => {
  const s = await shown();
  return s.count === 1 && s.text === CSS ? s : null;
});
check('style.set 后正好一个 <style id="pt-user-style">', set?.count === 1, set);
check('它是 <head> 的最后一个元素', set?.inHead && set?.last, set);
check('它的文本等于 css', set?.text === CSS, set?.text);
const read1 = await query('style.read');
check('style.read 为 enabled、1 条规则', read1.enabled === true && read1.rules === 1, read1);

await reset();
await page.click({ role: 'button', name: '设置', exact: true });
await page.click({ role: 'button', name: '外观', exact: true });
const row = await poll(() =>
  page.evaluate(`(() => {
    const box = document.querySelector('input[type=checkbox][aria-label="用户样式"]');
    if (!box || !box.getClientRects().length) return null;
    const row = box.closest('.ps-row') ?? box.parentElement;
    return { checked: box.checked, text: row.textContent };
  })()`),
);
check('外观页有 用户样式 行，开关开着', row?.checked === true, row);
check('该行显示 1 条规则', row?.text?.includes('1 条规则'), row?.text);
check('对照组：该行不显示 2 条规则', !row?.text?.includes('2 条规则'));

await page.click({ role: 'checkbox', name: '用户样式', exact: true });
const off = await poll(async () => {
  const s = await shown();
  return s.count === 0 ? s : null;
});
check('关掉开关后 #pt-user-style 被移除', off?.count === 0, off);
const read2 = await poll(async () => {
  const r = await query('style.read');
  return r.enabled === false ? r : null;
});
check('style.read 返回 enabled: false', read2?.enabled === false, read2);
check('关掉后 css 仍保留', read2?.css === CSS, read2?.css);
result.shot = await page.screenshot(result.id);

// The Help menu's "Turn Off User Styles" sends this action to the page.
await call('style.enable', { enabled: true });
const back = await poll(async () => {
  const s = await shown();
  return s.count === 1 ? s : null;
});
check('style.enable true 后样式回到页面', back?.count === 1, back);
const sent = await sendMenuAction('disable-user-style');
check('菜单动作 disable-user-style 经 preload 送到页面', sent.ok, sent);
const read3 = await poll(async () => {
  const r = await query('style.read');
  return r.enabled === false ? r : null;
});
check('菜单动作后 style.read 返回 enabled: false', read3?.enabled === false, read3);
const gone = await poll(async () => {
  const s = await shown();
  return s.count === 0 ? s : null;
});
check('菜单动作后 #pt-user-style 被移除', gone?.count === 0, gone);

await call('style.clear', {});
await call('style.enable', { enabled: true });
await reset();
result.errors = await errors();
result.ms = Date.now() - t0;
console.log(JSON.stringify(result, null, 2));
page.close();
