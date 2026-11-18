import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const remaining = (deadline) => deadline - Date.now();

const timedOut = (description) => new Error(`Timed out: ${description}`);

const isTimeout = (error) => String(error?.message).startsWith('Timed out');

export function describeLocator(locator) {
  const own = `${locator.role ?? 'element'} ${locator.exact ? 'named' : 'with name containing'} ${JSON.stringify(locator.name)}`;
  return locator.within ? `${own} within ${describeLocator(locator.within)}` : own;
}

/** A CDP client over an open WebSocket: replies are paired with requests by id. */
function createClient(socket) {
  let nextId = 1;
  let failure = null;
  const pending = new Map();
  const listeners = new Set();
  const fail = (reason) => {
    if (failure) return;
    failure = reason;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
  };
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data));
    if (frame.id === undefined) {
      for (const listener of listeners) listener(frame);
      return;
    }
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    clearTimeout(request.timer);
    if (frame.error) request.reject(new Error(`${request.method}: ${frame.error.message}`));
    else request.resolve(frame.result ?? {});
  });
  socket.addEventListener('close', (event) =>
    fail(`CDP connection closed (code ${event.code}${event.reason ? `, ${event.reason}` : ''})`),
  );
  return {
    get failure() {
      return failure;
    },
    fail,
    onEvent(listener) {
      listeners.add(listener);
    },
    send(method, params = {}, deadline) {
      if (failure) return Promise.reject(new Error(failure));
      const left = remaining(deadline);
      if (!(left > 0)) return Promise.reject(timedOut(method));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(timedOut(method));
        }, left);
        pending.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      fail('CDP connection closed by the caller');
      socket.close();
    },
  };
}

export async function openClient(url, deadline) {
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timedOut(`connecting to ${url}`)), remaining(deadline));
      socket.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true });
      socket.addEventListener(
        'error',
        () => (clearTimeout(timer), reject(new Error(`Cannot connect to ${url}`))),
        { once: true },
      );
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return createClient(socket);
}

/** GET a DevTools HTTP endpoint, polling until it answers or the deadline passes. */
async function devtoolsJson(port, endpoint, deadline, accept) {
  let last = 'no answer yet';
  for (;;) {
    const left = remaining(deadline);
    if (left <= 0) throw timedOut(`DevTools ${endpoint} on port ${port} (${last})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        signal: AbortSignal.timeout(Math.min(1000, left)),
      });
      const body = await response.json();
      const found = accept(body);
      if (found) return found;
      last = `answered ${JSON.stringify(body).slice(0, 300)}`;
    } catch (error) {
      last = String(error?.cause?.code ?? error?.message ?? error);
    }
    await delay(Math.min(100, Math.max(0, remaining(deadline))));
  }
}

/** Runs in the page: finds elements by role and accessible name. */
function installLocator() {
  const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
  const describe = (locator) => {
    const own = `${locator.role ?? 'element'} ${locator.exact ? 'named' : 'with name containing'} ${JSON.stringify(locator.name)}`;
    return locator.within ? `${own} within ${describe(locator.within)}` : own;
  };
  // A label's text without the controls it wraps.
  const labelText = (label) => {
    const copy = label.cloneNode(true);
    for (const control of copy.querySelectorAll('input, textarea, select')) control.remove();
    return clean(copy.textContent);
  };
  const nameOf = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = ids
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => clean(node.textContent))
        .join(' ');
      if (text) return text;
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.labels?.length) {
      const text = clean([...el.labels].map(labelText).join(' '));
      if (text) return text;
    }
    return clean(el.textContent);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    switch (el.localName) {
      case 'button':
        return 'button';
      case 'a':
        return el.hasAttribute('href') ? 'link' : null;
      case 'textarea':
        return 'textbox';
      case 'dialog':
        return 'dialog';
      case 'input':
        if (el.type === 'text') return 'textbox';
        if (el.type === 'checkbox' || el.type === 'radio') return el.type;
        if (['button', 'submit', 'reset'].includes(el.type)) return 'button';
        return null;
      default:
        return null;
    }
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const short = (name) => (name.length > 80 ? name.slice(0, 80) + '…' : name);
  const find = (locator) => {
    const scope = locator.within ? find(locator.within) : document;
    const shown = [...scope.querySelectorAll('*')].filter(visible);
    const candidates = locator.role ? shown.filter((el) => roleOf(el) === locator.role) : shown;
    const want = clean(locator.name);
    let hits = candidates.filter((el) =>
      locator.exact ? nameOf(el) === want : nameOf(el).includes(want),
    );
    // Without a role every ancestor shares the text; keep the innermost elements.
    if (!locator.role)
      hits = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
    if (hits.length === 1) return hits[0];
    const names = JSON.stringify(
      (hits.length ? hits : candidates).slice(0, 20).map((el) => short(nameOf(el))),
    );
    throw new Error(
      hits.length
        ? `${hits.length} elements match ${describe(locator)}: ${names}`
        : `No element matches ${describe(locator)}; ${candidates.length} visible candidates: ${names}`,
    );
  };
  const sketch = (el) =>
    el
      ? `<${el.localName}${el.className && typeof el.className === 'string' ? ` class="${el.className}"` : ''}> ${JSON.stringify(short(nameOf(el)))}`
      : 'nothing';
  // Scrolls the element into view and resolves its centre once it can take a click: its box held
  // still for two frames, no animation moves it or an ancestor, and nothing covers it. Until the
  // deadline every check is retried, finding it included, since a slide-in can start after a pause.
  const clickPoint = (locator, timeoutMs) =>
    new Promise((resolve, reject) => {
      const until = performance.now() + timeoutMs;
      let el;
      let last = null;
      let lastChain = null;
      let blocked = 'not checked yet';
      const retry = (reason) => {
        blocked = reason;
        last = null;
        lastChain = null;
        if (performance.now() > until) reject(new Error(blocked));
        else requestAnimationFrame(tick);
      };
      const boxKey = (node) => {
        const b = node.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].join();
      };
      // Names the outermost ancestor whose box changed since the last frame: where the movement starts.
      const moving = () => {
        const chain = [];
        for (let node = el; node; node = node.parentElement)
          chain.push({ node, key: boxKey(node), scroll: node.scrollTop });
        const before = lastChain;
        lastChain = chain;
        if (!before) return '';
        const changed = chain.filter(
          (now) => before.find((then) => then.node === now.node)?.key !== now.key,
        );
        const outer = changed.at(-1);
        if (!outer) return '';
        const then = before.find((entry) => entry.node === outer.node);
        const parent = chain[chain.indexOf(outer) + 1];
        return `; outermost moving box ${sketch(outer.node)} ${then?.key} -> ${outer.key}${parent ? `, parent scrollTop ${parent.scroll}` : ''}`;
      };
      // The nearest ancestor that clips overflow and leaves the point (x, y) outside its box.
      const clippedBy = (node, x, y) => {
        for (let n = node.parentElement; n; n = n.parentElement) {
          const style = getComputedStyle(n);
          if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
          const b = n.getBoundingClientRect();
          if (x < b.left || x >= b.right || y < b.top || y >= b.bottom) return n;
        }
        return null;
      };
      const tick = () => {
        try {
          if (!el?.isConnected) {
            try {
              el = find(locator);
            } catch (error) {
              // A screen change commits a frame later; keep looking until the deadline.
              return retry(error.message);
            }
            el.scrollIntoView({ block: 'center', inline: 'center' });
            return retry(`${describe(locator)} was just found`);
          }
          const box = el.getBoundingClientRect();
          const key = [box.x, box.y, box.width, box.height].join();
          if (key !== last) {
            const moved = last !== null;
            const from = last;
            last = key;
            const where = moving();
            if (moved) blocked = `${describe(locator)} kept moving (${from} -> ${key}${where})`;
            if (performance.now() > until) throw new Error(blocked);
            requestAnimationFrame(tick);
            return;
          }
          const animated = document
            .getAnimations()
            .some((a) => a.playState !== 'finished' && a.effect?.target?.contains?.(el));
          if (animated) return retry(`${describe(locator)} is still animating`);
          if (el.disabled === true || el.getAttribute('aria-disabled') === 'true')
            return retry(`${describe(locator)} is disabled`);
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            // Content that loads after the first scroll can push the element out again.
            el.scrollIntoView({ block: 'center', inline: 'center' });
            return retry(`${describe(locator)} centre (${x}, ${y}) is outside the viewport`);
          }
          const hit = document.elementFromPoint(x, y);
          if (hit !== el && !el.contains(hit)) {
            const clip = clippedBy(el, x, y);
            // Opening focus can scroll a list back to its top after the first scroll.
            if (clip) el.scrollIntoView({ block: 'center', inline: 'center' });
            return retry(
              clip
                ? `${describe(locator)} centre (${x}, ${y}) is outside the visible box of ${sketch(clip)}`
                : `${describe(locator)} is covered at (${x}, ${y}) by ${sketch(hit)}`,
            );
          }
          armed = el;
          resolve({ x, y });
        } catch (error) {
          reject(error);
        }
      };
      tick();
    });
  // The element the last clickPoint resolved, and the guard set on it for the click that follows.
  let armed = null;
  let guarded = null;
  const GUARDED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  // A box can move between clickPoint and the click arriving; the guard drops a press that lands
  // outside the armed element, so the miss does nothing and the click can be sent again.
  const guard = () => {
    const target = armed;
    const record = { hit: false, missed: null };
    // The press decides: once it lands on the target, the rest of the click passes, including the
    // click a control forwards to an input outside it.
    const handler = (event) => {
      if (record.hit) return;
      if (!record.missed && target.isConnected && target.contains(event.target)) {
        record.hit = true;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      record.missed ??= `${event.type} on ${sketch(event.target)}`;
    };
    for (const type of GUARDED) window.addEventListener(type, handler, true);
    guarded = {
      record,
      off: () => GUARDED.forEach((t) => window.removeEventListener(t, handler, true)),
    };
    return true;
  };
  const unguard = () => {
    guarded.off();
    const { hit, missed } = guarded.record;
    guarded = null;
    return missed ?? (hit || 'no event');
  };
  globalThis.__acceptanceLocator = {
    find: (locator) => sketch(find(locator)),
    clickPoint,
    guard,
    unguard,
    focused: (locator) =>
      find(locator) === document.activeElement || sketch(document.activeElement),
    selectedAll: (locator) => {
      const el = find(locator);
      return el.selectionStart === 0 && el.selectionEnd === el.value.length;
    },
    value: (locator) => find(locator).value,
  };
  return true;
}

const keys = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};
const modifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
// macOS Chromium runs no editing command for synthetic shortcuts unless told which one.
const editingCommands = { 'Meta+a': 'selectAll' };

function keyEvent(key, modifiers) {
  const known = keys[key];
  const letter = !known && key.length === 1 ? key : null;
  if (!known && !letter) throw new Error(`Unknown key ${JSON.stringify(key)}`);
  const upper = letter?.toUpperCase();
  const code = known?.code ?? (/[A-Z]/.test(upper) ? `Key${upper}` : '');
  const keyCode = known?.keyCode ?? upper.charCodeAt(0);
  const bits = modifiers.reduce((sum, name) => {
    if (!(name in modifierBits)) throw new Error(`Unknown modifier ${JSON.stringify(name)}`);
    return sum | modifierBits[name];
  }, 0);
  const typesText = !modifiers.some((name) => name !== 'Shift');
  const text = typesText ? (known?.text ?? letter ?? undefined) : undefined;
  const command = editingCommands[[...modifiers, key].join('+')];
  return {
    modifiers: bits,
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
    ...(command ? { commands: [command] } : {}),
  };
}

/**
 * Connects to the main window's file: page and waits until the renderer and its preload are up.
 * After that, a top-level navigation, a detach, a crash or a closed socket fails every request.
 */
export async function connect(port, deadline, { evidenceDir } = {}) {
  const target = await devtoolsJson(port, '/json/list', deadline, (list) =>
    // The tray popover, session windows and project windows carry their kind in the query.
    list.find(
      (entry) =>
        entry.type === 'page' && entry.url.startsWith('file:') && !entry.url.includes('kind='),
    ),
  );
  const client = await openClient(target.webSocketDebuggerUrl, deadline);
  let watchNavigation = false;
  client.onEvent(({ method, params }) => {
    if (method === 'Page.frameNavigated' && watchNavigation && !params.frame.parentId)
      client.fail(`Page navigated to ${params.frame.url}`);
    else if (method === 'Inspector.detached') client.fail(`Inspector detached: ${params.reason}`);
    else if (method === 'Inspector.targetCrashed' || method === 'Target.targetCrashed')
      client.fail('Page crashed');
  });
  const send = (method, params, until = deadline) => client.send(method, params, until);

  async function evaluate(expression, until = deadline) {
    const { result, exceptionDetails } = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      until,
    );
    if (exceptionDetails) {
      const thrown =
        exceptionDetails.exception?.description ??
        exceptionDetails.exception?.value ??
        exceptionDetails.text;
      throw new Error(`Page threw: ${String(thrown).split('\n    at ')[0]}`);
    }
    return result?.value;
  }

  async function pageTail() {
    if (client.failure) return '';
    try {
      // The deadline has already passed here, so the read gets its own short bound.
      const text = await evaluate(
        "document.body ? document.body.innerText.slice(-2000) : ''",
        Date.now() + 1000,
      );
      return `\n--- page text (tail) ---\n${text}`;
    } catch (error) {
      return `\n--- page text unavailable: ${error.message} ---`;
    }
  }

  async function waitFor(expression, description, until = deadline, { failWhen } = {}) {
    let outcome;
    try {
      for (;;) {
        if (failWhen) {
          const reason = await evaluate(failWhen, until);
          if (typeof reason === 'string' && reason !== '') {
            outcome = `${description} failed: ${reason}`;
            break;
          }
        }
        const value = await evaluate(expression, until);
        if (value) return value;
        const left = remaining(until);
        if (left <= 0) {
          outcome = `Timed out: ${description}`;
          break;
        }
        await delay(Math.min(100, left));
      }
    } catch (error) {
      if (client.failure || !isTimeout(error)) throw error;
      outcome = `Timed out: ${description}`;
    }
    throw new Error(outcome + (await pageTail()));
  }

  const locate = (method, ...args) =>
    `globalThis.__acceptanceLocator.${method}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;

  async function click(locator, until = deadline) {
    // An element that stays covered or disabled for this long will not become clickable.
    const settle = Math.min(10000, remaining(until));
    for (let attempt = 1; ; attempt++) {
      const { x, y } = await evaluate(locate('clickPoint', locator, settle), until);
      const mouse = { x, y, button: 'left', clickCount: 1 };
      await evaluate(locate('guard'), until);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, until);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse }, until);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse }, until);
      const landed = await evaluate(locate('unguard'), until);
      if (landed === true) return;
      const miss = `the click on ${describeLocator(locator)} at (${x}, ${y}) missed: ${landed}`;
      // Shows in the driver log; a miss followed by a hit leaves no other trace.
      console.error(miss);
      if (attempt === 3) throw new Error(miss);
    }
  }

  async function press(key, modifiers = [], until = deadline) {
    const event = keyEvent(key, modifiers);
    await send(
      'Input.dispatchKeyEvent',
      { type: event.text ? 'keyDown' : 'rawKeyDown', ...event },
      until,
    );
    const { text, unmodifiedText, commands, ...up } = event;
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...up }, until);
  }

  async function fill(locator, text, until = deadline) {
    const what = describeLocator(locator);
    await click(locator, until);
    const focused = await evaluate(locate('focused', locator), until);
    if (focused !== true) throw new Error(`${what} did not take focus; focus is on ${focused}`);
    await press('a', ['Meta'], until);
    if (!(await evaluate(locate('selectedAll', locator), until)))
      throw new Error(`Select all did not cover the text of ${what}`);
    await send('Input.insertText', { text }, until);
    const value = await evaluate(locate('value', locator), until);
    if (value !== text)
      throw new Error(
        `${what} holds ${JSON.stringify(String(value).slice(0, 200))} instead of the ${text.length} characters typed`,
      );
  }

  let shots = 0;
  async function screenshot(name, until = deadline) {
    if (!evidenceDir) throw new Error('connect() was given no evidenceDir for screenshots');
    // Let enter and exit transitions settle, so the shot shows the resting frame; loops never end.
    await evaluate(
      `Promise.race([
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.playState !== 'finished' && Number.isFinite(a.effect?.getComputedTiming().endTime))
            .map((a) => a.finished.catch(() => {})),
        ),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]).then(() => true)`,
      until,
    );
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, until);
    shots += 1;
    const file = `screens/${String(shots).padStart(2, '0')}-${name}.png`;
    const bytes = Buffer.from(data, 'base64');
    await mkdir(path.join(evidenceDir, 'screens'), { recursive: true });
    await writeFile(path.join(evidenceDir, file), bytes);
    return { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  try {
    await send('Inspector.enable');
    await send('Page.enable');
    await send('Runtime.enable');
    await waitFor(
      "document.readyState === 'complete' && typeof window.pantheon === 'object'",
      'the renderer and its preload to load',
    );
    await evaluate(`(${installLocator.toString()})()`);
    watchNavigation = true;
  } catch (error) {
    client.close();
    throw error;
  }

  return {
    url: target.url,
    get failure() {
      return client.failure;
    },
    send,
    evaluate,
    waitFor,
    find: (locator, until = deadline) => evaluate(locate('find', locator), until),
    click,
    fill,
    press,
    screenshot,
    close: () => client.close(),
  };
}
